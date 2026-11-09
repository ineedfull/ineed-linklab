/* global window, document, MouseEvent */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@stomp/stompjs';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';
import { createOpcuaTestServer } from '../opcua-test/server.mjs';
import { runMemoryCycles } from './memory-cycles.mjs';
import { createHeapDiagnostic } from './memory-heap.mjs';
import { readSystemOutput } from '../soak-test/system-output.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const out = process.env.LINKLAB_STOMP_DESKTOP_OUT ?? path.join(tmpdir(), `linklab-stomp-desktop-${Date.now()}`);
const duration = Number(process.env.LINKLAB_STOMP_DESKTOP_MS ?? 120000);
const idleMs = Number(process.env.LINKLAB_STOMP_DESKTOP_IDLE_MS ?? 180000);
const batchSize = Number(process.env.LINKLAB_STOMP_DESKTOP_BATCH ?? 16);
const pauseMs = Number(process.env.LINKLAB_STOMP_DESKTOP_PAUSE_MS ?? 200);
assert(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 256);
assert(Number.isFinite(pauseMs) && pauseMs >= 0 && pauseMs <= 10000);
assert(!process.env.LINKLAB_DUEL_WINDOW_HELPER || process.env.LINKLAB_DUEL_RESOURCE_HELPER, 'Window checks require LINKLAB_DUEL_RESOURCE_HELPER to identify the native Tauri host');
const identifier = `com.ineedfull.linklab.stompduel${Date.now()}`;
const memoryOptions = process.env.LINKLAB_STOMP_MEMORY_CYCLES ? { cycles: Number(process.env.LINKLAB_STOMP_MEMORY_CYCLES), messages: Number(process.env.LINKLAB_STOMP_MEMORY_MESSAGES ?? 32768), idleMs: Number(process.env.LINKLAB_STOMP_MEMORY_IDLE_MS ?? 60000), observer: process.env.LINKLAB_STOMP_MEMORY_OBSERVER ?? 'bounded' } : null;
if (memoryOptions) {
  assert(Number.isInteger(memoryOptions.cycles) && memoryOptions.cycles >= 1 && memoryOptions.cycles <= 10);
  assert(Number.isInteger(memoryOptions.messages) && memoryOptions.messages >= 1 && memoryOptions.messages <= 1000000);
  assert(Number.isFinite(memoryOptions.idleMs) && memoryOptions.idleMs >= 0 && memoryOptions.idleMs <= 300000);
  assert(['full', 'bounded', 'off'].includes(memoryOptions.observer));
}
const observerMode = memoryOptions?.observer ?? 'full';
const observerSource = await readFile(new URL('./memory-observer.mjs', import.meta.url), 'utf8');
const formOnly = process.env.LINKLAB_NATIVE_FORM_ONLY === '1';
const firstServer = process.env.LINKLAB_STOMP_FIRST_SERVER ?? 'electron';
assert(['electron', 'tauri'].includes(firstServer), 'First server must be electron or tauri');
const runtimes = firstServer === 'tauri' ? ['tauri', 'electron'] : ['electron', 'tauri'];
const observerCodec = (await readFile(new URL('../../packages/workbench/src/model/stompCodec.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
const channels = Object.fromEntries(runtimes.map(name => [name, { ready: false, queue: [], pending: new Map() }]));
const fatal = [], stages = [], samples = [];
let sequence = 0, app, tauri, keepAwake, sdk, report;
const opcuaFixtures = [];
await mkdir(out, { recursive: true });
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { assert(Date.now() < deadline, label); assert.deepEqual(fatal, []); await delay(50); }
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function bounded(label, operation, timeout = 5000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), timeout); })]); }
  finally { clearTimeout(timer); }
}

async function browserAgent(runtime, origin, StompDecoder, createMemoryObserver, observerMode) {
  const memoryObserver = createMemoryObserver();
  const control = (url, options) => fetch(new URL(url, origin), options);
  const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const decoders = new Map();
  const nativePeers = [];
  let timerAt = Date.now(), maxTimerGapMs = 0;
  const timerGaps = [];
  const lagTimer = window.setInterval(() => { const now = Date.now(), gap = now - timerAt; timerAt = now; maxTimerGapMs = Math.max(maxTimerGapMs, gap); if (gap > 1500) { timerGaps.push({ at: now, gap }); if (timerGaps.length > 20) timerGaps.shift(); } }, 250);
  const errors = [], protocolErrors = [], wire = new Map(), commands = {}, nativeStatuses = [], observedConnections = new Set(), selectedConnections = new Map(); let status = '', sessionId;
  const until = async (check, label) => { for (let n = 0; n < 600; n++) { if (check()) return; await pause(50); } throw new Error(`${label}: ${document.body.innerText}`); };
  const execute = async request => {
    const answer = runtime === 'electron' ? await window.ineedLinkLab.stomp.execute(request) : await window.__TAURI_INTERNALS__.invoke('stomp_execute', { request });
    if (!answer.ok) throw new Error(answer.error?.message ?? 'Invalid native response'); return answer.value;
  };
  const observe = event => {
    if (event.type === 'peers') { nativePeers.push({ at: Date.now(), ...event.payload }); if (nativePeers.length > 20) nativePeers.shift(); }
    if (event.type === 'status') { observedConnections.add(event.payload.endpointId); status = event.payload.status; sessionId = event.payload.sessionId; nativeStatuses.push({ at: Date.now(), ...event.payload }); if (nativeStatuses.length > 100) nativeStatuses.shift(); }
    if (event.type === 'frames' && observerMode !== 'off') for (const frame of event.payload.frames) {
      const id = `${event.payload.endpointId}:${frame.peerId ?? ''}`;
      if (!decoders.has(id)) decoders.set(id, new StompDecoder());
      for (const decoded of decoders.get(id).push(new Uint8Array(frame.bytes))) {
        const command = decoded.command ?? '', body = decoded.body ?? '';
        commands[command] = (commands[command] ?? 0) + 1;
        if (command === 'ERROR') { protocolErrors.push({ at: Date.now(), endpointId: event.payload.endpointId, body }); if (protocolErrors.length > 20) protocolErrors.shift(); }
        if (body.startsWith('load-')) {
          const connection = event.payload.endpointId;
          if (observerMode === 'bounded') { memoryObserver.push(connection, body); continue; }
          if (!wire.has(connection)) wire.set(connection, new Map());
          const stream = wire.get(connection); stream.set(body, (stream.get(body) ?? 0) + 1);
        }
      }
    }
  };
  if (runtime === 'electron') window.ineedLinkLab.stomp.onEvent(observe);
  else await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'stomp:event', target: { kind: 'Any' }, handler: window.__TAURI_INTERNALS__.transformCallback(event => observe(event.payload)) });
  window.addEventListener('error', event => errors.push(event.message));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  await until(() => document.querySelector('[aria-label="添加端点"]'), 'Endpoint tree');
  const visible = element => element && element.style.display !== 'none';
  const panel = () => [...document.querySelectorAll('.stomp-panel,.opcua-panel')].find(visible);
  let selectedRole = '', selectedName = '';
  const roles = new Map();
  async function select(name) {
    const target = [...document.querySelectorAll('.endpoint-row__select')].find(button => button.getAttribute('aria-label') === `选择 ${name}`);
    if (!target) throw new Error(`Missing endpoint ${name}`);
    target.click(); selectedName = name; selectedRole = roles.get(name); await pause(50);
    await until(() => panel(), 'Selected panel');
  }
  async function add(transport, name, config = {}) {
    document.querySelector('[aria-label="添加端点"]').click();
    await until(() => document.querySelector('.endpoint-dialog'), 'Add dialog');
    const dialog = document.querySelector('.endpoint-dialog');
    const set = (name, value) => { const input = dialog.querySelector(`[name="${name}"]`); input.value = value; input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
    set('endpoint-transport', transport); await pause(30); set('endpoint-name', name);
    for (const [key, value] of Object.entries(config)) set(key, value);
    [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === '保存端点').click();
    await until(() => !document.querySelector('.endpoint-dialog'), 'Endpoint saved');
    roles.set(name, transport.endsWith('server') ? 'server' : 'client');
    await select(name);
  }
  async function remove(name) {
    const row = [...document.querySelectorAll('.endpoint-row')].find(row => row.querySelector('.endpoint-row__select').getAttribute('aria-label') === `选择 ${name}`);
    row.querySelector('[aria-label="端点操作"]').click(); await pause(30);
    [...row.querySelectorAll('[role="menuitem"]')].find(button => button.textContent.trim() === '删除').click();
    await until(() => !row.isConnected, 'Endpoint deleted');
    const connection = selectedConnections.get(name); observedConnections.delete(connection); selectedConnections.delete(name); roles.delete(name);
    if (selectedName === name && !panel()) { selectedName = ''; selectedRole = ''; }
  }
  const button = text => [...panel().querySelectorAll('button')].find(value => value.textContent.trim() === text);
  const click = async text => { await until(() => button(text) && !button(text).disabled, text); button(text).dispatchEvent(new MouseEvent('click', { bubbles: true })); await pause(30); };
  const fill = async (name, value) => {
    const element = panel().querySelector(`[name="${name}"]`); if (!element) throw new Error(`Missing ${name}`);
    if (element.type === 'checkbox') { if (element.checked !== value) element.click(); }
    else { element.value = value; element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
    await pause(20);
  };
  const metric = (fullWire = false) => ({ endpointName: selectedName, visibleEndpointName: panel()?.querySelector('.stomp-header strong')?.textContent.trim() ?? '', lastProcessStompEvent: { status, sessionId }, pageStatus: panel()?.querySelector('.stomp-status,.opcua-status')?.dataset.status, errors: [...errors], protocolErrors: [...protocolErrors], alerts: [...(panel()?.querySelectorAll('[role="alert"]') ?? [])].map(value => value.textContent.trim()), rows: panel()?.querySelectorAll('.stomp-message').length ?? 0, pendingOutside: panel()?.querySelectorAll('.stomp-pending-item').length ?? 0, commands: { ...commands }, visibility: document.visibilityState, timeOrigin: window.performance.timeOrigin, observerMode, nativeStatuses: [...nativeStatuses], nativePeers: [...nativePeers], connections: [...selectedConnections], maxTimerGapMs, timerGaps: [...timerGaps], selectedWireCount: wire.get(selectedConnections.get(selectedName))?.size ?? 0, retainedObserverBodies: [...wire.values()].reduce((total, stream) => total + stream.size, 0), observerConnections: observerMode === 'bounded' ? memoryObserver.size() : wire.size, decoderCount: decoders.size, domNodes: document.querySelectorAll('*').length, stream: memoryObserver.snapshot(selectedConnections.get(selectedName)), wireCount: observerMode === 'bounded' ? memoryObserver.count() : [...wire.values()].reduce((total, stream) => total + stream.size, 0), wire: fullWire ? [...(wire.get(selectedConnections.get(selectedName)) ?? [])] : [], bodies: [...(panel()?.querySelectorAll('.stomp-message-body') ?? [])].map(value => value.textContent) });
  const getSettings = async () => {
    const answer = runtime === 'electron' ? await window.ineedLinkLab.settings.getAll() : await window.__TAURI_INTERNALS__.invoke('settings_get_all', { args: [] });
    if (!answer.ok) throw new Error('Native settings read failed');
    return answer.value;
  };
  await control(`/ready/${runtime}`, { method: 'POST' });
  while (true) {
    const command = await (await control(`/next/${runtime}`)).json(); let value, error;
    try {
      switch (command.action) {
        case 'configure': {
          const beforeConnections = new Set(observedConnections);
          const name = command.name ?? `Desktop ${runtime} ${command.mode}`;
          await add(`stomp-${command.mode}`, name, command.mode === 'server' ? { 'stomp-listen-port': command.port } : { 'stomp-url': `ws://127.0.0.1:${command.port}/stomp` });
          await click('连接与认证');
          if (panel().querySelector('[name="stomp-passcode"]').value) throw new Error('New endpoint inherited credentials');
          await fill('stomp-host', 'localhost'); await fill('stomp-heartbeat-out', '1000'); await fill('stomp-heartbeat-in', '1000');
          if (command.mode === 'server') { await fill('stomp-path', '/stomp'); await fill('stomp-require-auth', true); }
          await fill('stomp-login', 'operator'); await fill('stomp-passcode', 'desktop-private-passcode');
          await click('保存配置'); await until(() => panel().innerText.includes('端点配置已保存'), 'Saved configuration');
          await click(command.mode === 'server' ? '启动服务' : '连接');
          await until(() => metric().pageStatus === (command.mode === 'server' ? 'listening' : 'connected'), 'Connected');
          const created = [...observedConnections].filter(id => !beforeConnections.has(id)); if (created.length !== 1) throw new Error('Ambiguous native connection identity');
          selectedConnections.set(name, created[0]); value = metric(); break;
        }
        case 'subscribe':
          await click('消息与订阅'); await fill('stomp-sub-destination', command.destination); await fill('stomp-sub-ack', command.ack ?? 'auto');
          await click('订阅'); await until(() => panel().querySelector('.stomp-subscription'), 'Subscribed'); value = metric(); break;
        case 'publish':
          await click('消息与订阅'); await fill('stomp-send-destination', command.destination); await fill('stomp-body', command.body);
          panel().querySelector('[data-testid="stomp-send"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          await until(() => metric().bodies.includes(command.body), 'Sent body'); value = metric(); break;
        case 'raw': {
          const connectionId = selectedConnections.get(selectedName); if (!connectionId) throw new Error('Selected native connection is unavailable');
          for (const body of command.bodies) {
            const bytes = [...new TextEncoder().encode(`SEND\ndestination:${command.destination}\ncontent-type:text/plain\ncontent-length:${new TextEncoder().encode(body).length}\n\n${body}\0`)];
            await execute({ action: 'send', connectionId, bytes, messageType: 'binary' });
          }
          value = { sent: command.bodies.length }; break;
        }
        case 'messages': await click('消息与订阅'); value = metric(); break;
        case 'form-geometry': {
          await click('消息与订阅');
          const root = document.documentElement;
          const theme = root.dataset.theme, large = root.classList.contains('large-font');
          value = [];
          try {
            for (const dark of [false, true]) for (const largeFont of [false, true]) {
              root.dataset.theme = dark ? 'dark' : 'light'; root.classList.toggle('large-font', largeFont);
              await pause(50);
              const bounds = name => {
                const element = panel().querySelector(`[name="${name}"]`), rect = element.getBoundingClientRect();
                return { top: rect.top, height: rect.height, fontSize: window.getComputedStyle(element).fontSize };
              };
              value.push({ dark, largeFont, input: bounds('stomp-sub-destination'), select: bounds('stomp-sub-ack') });
            }
          } finally {
            if (theme === undefined) delete root.dataset.theme; else root.dataset.theme = theme;
            root.classList.toggle('large-font', large);
          }
          break;
        }
        case 'clear': if (panel().querySelectorAll('.stomp-message').length) await click('清空消息'); value = metric(); break;
        case 'select': await select(command.name); value = metric(); break;
        case 'delete': await remove(command.name); value = { deleted: command.name }; break;
        case 'start': await click(selectedRole === 'server' ? '启动服务' : '连接'); await until(() => metric().pageStatus === (selectedRole === 'server' ? 'listening' : 'connected'), 'Restarted endpoint'); value = metric(); break;
        case 'acknowledge': {
          await click('消息与订阅');
          const row = panel().querySelector('.stomp-pending-item'); if (!row) throw new Error('Missing pending ACK control');
          const action = [...row.querySelectorAll('button')].find(button => button.textContent.trim() === command.command);
          action.click(); await until(() => !row.isConnected, 'Pending acknowledgment removed'); value = metric(); break;
        }
        case 'save-profile': await click('连接与认证'); await click('保存配置'); value = await getSettings(); break;
        case 'appearance': {
          const before = await getSettings();
          document.querySelector('[aria-label="打开设置"]').click();
          await until(() => document.querySelector('.settings-panel [name="theme"]'), 'Settings ready');
          const form = document.querySelector('.settings-panel'), theme = form.querySelector('[name="theme"]');
          theme.value = before.theme === 'dark' ? 'light' : 'dark'; theme.dispatchEvent(new Event('change', { bubbles: true }));
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          await until(() => !document.querySelector('.settings-panel'), 'Settings saved');
          const after = await getSettings();
          if (JSON.stringify(before.stompProfiles) !== JSON.stringify(after.stompProfiles)) throw new Error('Appearance save erased STOMP profiles');
          value = { profiles: after.stompProfiles.length, preserved: true }; break;
        }
        case 'disconnect': {
          const role = selectedRole;
          await click(role === 'server' ? '停止服务' : '断开'); await until(() => metric().pageStatus === 'disconnected', 'Disconnected'); value = metric(); break;
        }
        case 'opcua-geometry': {
          await add('opcua-client', `UA ${runtime} geometry`, { 'opcua-endpoint-url': command.endpointUrl });
          const root = document.documentElement, theme = root.dataset.theme, large = root.classList.contains('large-font');
          value = [];
          try {
            for (const dark of [false, true]) for (const largeFont of [false, true]) {
              root.dataset.theme = dark ? 'dark' : 'light'; root.classList.toggle('large-font', largeFont); await pause(50);
              const controls = [...panel().querySelectorAll('.opcua-grid input:not([type=checkbox]),.opcua-grid select')].map(element => ({ tag: element.tagName, height: element.getBoundingClientRect().height, minimum: parseFloat(window.getComputedStyle(element).getPropertyValue('--control-height')) || 32 }));
              value.push({ dark, largeFont, controls });
            }
          } finally { if (theme === undefined) delete root.dataset.theme; else root.dataset.theme = theme; root.classList.toggle('large-font', large); }
          break;
        }
        case 'opcua': {
          const input = async (label, value) => { const element = [...panel().querySelectorAll('label')].find(row => row.firstChild?.textContent.trim() === label)?.querySelector('input'); if (!element) throw new Error(`Missing OPC UA ${label}`); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); await pause(30); };
          for (const [index, fixture] of command.fixtures.entries()) {
            await add('opcua-client', `UA ${runtime} ${index}`, { 'opcua-endpoint-url': fixture.endpointUrl });
            await click('连接'); await until(() => metric().pageStatus === 'connected', 'OPC UA connected');
            if (command.verifyForm && index === 0) {
              const root = document.documentElement, theme = root.dataset.theme, large = root.classList.contains('large-font');
              try {
                for (const dark of [false, true]) for (const largeFont of [false, true]) {
                  root.dataset.theme = dark ? 'dark' : 'light'; root.classList.toggle('large-font', largeFont); await pause(50);
                  const controls = [...panel().querySelectorAll('.opcua-grid input:not([type=checkbox]),.opcua-grid select')].map(element => ({ tag: element.tagName, height: element.getBoundingClientRect().height, minimum: parseFloat(window.getComputedStyle(element).getPropertyValue('--control-height')) || 32 }));
                  if (controls.some(control => control.height < control.minimum - 1)) throw new Error(`OPC UA native control height mismatch: ${JSON.stringify({ dark, largeFont, controls })}`);
                }
              } finally { if (theme === undefined) delete root.dataset.theme; else root.dataset.theme = theme; root.classList.toggle('large-font', large); }
            }

            await click('节点与监视'); await input('NodeId', fixture.nodes.Folder); await click('浏览'); await until(() => panel().innerText.includes('Changing'), 'Browse real nodes');
            panel().querySelector('[aria-label="选择 Changing"]').click(); await click('监视所选（1/100）');
            await until(() => [...panel().querySelectorAll('.opcua-table code')].filter(node => node.textContent === fixture.nodes.Changing).length >= 2, 'Subscription data');
          }
          const livePanels = [0, 1].map(index => [...document.querySelectorAll('.opcua-panel')].find(element => element.querySelector('header p')?.textContent.trim() === `UA ${runtime} ${index}`));
          const changingValues = () => livePanels.map((element, index) => {
            const row = [...element.querySelectorAll('.opcua-table tr')].find(row => row.querySelectorAll('code').length >= 2 && row.querySelector('code')?.textContent === command.fixtures[index].nodes.Changing);
            return row?.querySelectorAll('code')[1].textContent;
          });
          const beforeValues = changingValues();
          await until(() => changingValues().every((value, index) => value !== undefined && value !== beforeValues[index]), 'Both simultaneous OPC UA subscriptions advance');
          if (livePanels.some(element => element.querySelector('.opcua-status').dataset.status !== 'connected')) throw new Error('OPC UA simultaneous connection lost');
          const afterValues = changingValues();
          await select(`UA ${runtime} 0`);
          if (metric().pageStatus !== 'connected' || !panel().innerText.includes('当前监视 1 个节点')) throw new Error('Switch lost first OPC UA session');
          await remove(`UA ${runtime} 0`); await select(`UA ${runtime} 1`);
          if (metric().pageStatus !== 'connected' || !panel().innerText.includes('当前监视 1 个节点')) throw new Error('Delete disconnected another OPC UA endpoint');
          await input('NodeId', command.fixtures[1].nodes.Temperature); await click('读取节点'); await until(() => panel().innerText.includes('23.5'), 'Surviving OPC UA read');
          await click('停止监视'); await click('断开'); await until(() => metric().pageStatus === 'disconnected', 'OPC UA disconnect');
          value = { twoLiveSessions: true, independentSubscriptions: true, subscriptionProgress: { before: beforeValues, after: afterValues }, deleteIsolation: true, survivingRead: true }; break;
        }
        case 'clear-observer': wire.clear(); memoryObserver.clear(); decoders.clear(); value = metric(); break;
        case 'memory-metrics': value = metric(); break;
        case 'metrics': value = metric(command.fullWire === true); break;
        case 'stop': window.clearInterval(lagTimer); value = metric(); break;
        default: throw new Error(`Unknown command ${command.action}`);
      }
    } catch (reason) { error = `${reason.stack}\nDiagnostic: ${JSON.stringify({ runtime, selectedName, selectedConnection: selectedConnections.get(selectedName), nativeStatuses, metric: metric() })}`; }
    await control(`/result/${runtime}`, { method: 'POST', body: JSON.stringify({ id: command.id, value, error }) });
    if (command.action === 'stop') return;
  }
}

const web = http.createServer(async (request, response) => {
  try {
    response.setHeader('access-control-allow-origin', '*');
    const url = new URL(request.url, 'http://localhost'); const runtime = url.pathname.split('/')[2];
    if (url.pathname.startsWith('/ready/')) { channels[runtime].ready = true; response.end('ok'); return; }
    if (url.pathname.startsWith('/next/')) { const channel = channels[runtime]; response.setHeader('content-type', 'application/json'); if (channel.queue.length) response.end(JSON.stringify(channel.queue.shift())); else channel.waiting = response; return; }
    if (url.pathname.startsWith('/result/')) {
      let body = ''; for await (const chunk of request) body += chunk; const result = JSON.parse(body), pending = channels[runtime].pending.get(result.id);
      if (pending) { clearTimeout(pending.timer); channels[runtime].pending.delete(result.id); result.error ? pending.reject(new Error(result.error)) : pending.resolve(result.value); }
      response.end('ok'); return;
    }
    if (url.pathname === '/agent.js') { response.setHeader('content-type', 'application/javascript'); response.end(`${observerCodec}\n${observerSource}\n(${browserAgent.toString()})('tauri',location.origin,StompDecoder,createMemoryObserver,${JSON.stringify(observerMode)}).catch(error=>fetch('/fatal',{method:'POST',body:error.stack}));`); return; }
    if (url.pathname === '/fatal') { let body = ''; for await (const chunk of request) body += chunk; fatal.push(body); response.end('ok'); return; }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); assert(!relative.includes('..'));
    let bytes = await readFile(path.join(root, 'apps/tauri/dist', relative));
    if (relative === 'index.html') bytes = Buffer.from(bytes.toString().replace('</body>', '<script type="module" src="/agent.js"></script></body>'));
    response.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); response.end(bytes);
  } catch (error) { response.writeHead(500).end(error.message); }
});
function command(runtime, action, args = {}) {
  return new Promise((resolve, reject) => {
    const channel = channels[runtime], id = ++sequence;
    const timer = setTimeout(() => { channel.pending.delete(id); reject(new Error(`${runtime}/${action} timeout`)); }, 45000);
    channel.pending.set(id, { resolve, reject, timer });
    const value = { id, action, ...args };
    if (channel.waiting) { channel.waiting.end(JSON.stringify(value)); channel.waiting = null; } else channel.queue.push(value);
  });
}
async function sample(stage) {
  const resources = process.env.LINKLAB_DUEL_RESOURCE_HELPER ? JSON.parse(await readSystemOutput(process.env.LINKLAB_DUEL_RESOURCE_HELPER)) : [];
  const tauriHost = resources.find(row => row.name.includes(identifier));
  const hosts = [app.process().pid, tauriHost?.pid].filter(Boolean);
  const owned = resources.filter(row => hosts.includes(row.pid) || hosts.includes(row.responsible));
  const windows = process.env.LINKLAB_DUEL_WINDOW_HELPER ? JSON.parse(await readSystemOutput(process.env.LINKLAB_DUEL_WINDOW_HELPER, stage === 'start' ? hosts.map(String) : [])).filter(row => hosts.includes(row.pid) && row.layer === 0 && row.bounds.Width >= 1000 && row.bounds.Height >= 700) : [];
  if (stage === 'start') await delay(300);
  const desktops = Object.fromEntries(await Promise.all(runtimes.map(async name => [name, await command(name, 'metrics')])));
  await writeFile(path.join(out, 'last-desktops.json'), JSON.stringify({stage, desktops, windows}, null, 2));
  for (const desktop of Object.values(desktops)) { assert.equal(desktop.visibleEndpointName, desktop.endpointName, 'Foreground endpoint changed during desktop load'); assert.deepEqual(desktop.errors, []); assert.deepEqual(desktop.alerts, []); assert.equal(desktop.visibility, 'visible'); assert(desktop.rows <= 500); }
  if (process.env.LINKLAB_DUEL_WINDOW_HELPER) assert(new Set(windows.map(row => row.pid)).size === 2 && windows.every(row => row.onScreen && !row.hidden && (row.axWindows ?? []).every(value => !value.minimized)));
  assert(!(await readSystemOutput('ioreg', ['-n', 'Root', '-d1'])).includes('"CGSSessionScreenIsLocked"=Yes'));
  const electron = await app.evaluate(({ app }) => app.getAppMetrics());
  const value = { stage, at: Date.now(), desktops, owned, windows, electron }; samples.push(value);
  await appendFile(path.join(out, 'samples.jsonl'), JSON.stringify(value) + '\n');
  console.log(JSON.stringify({ stage, at: value.at, desktops: Object.fromEntries(Object.entries(desktops).map(([name, value]) => [name, { rows: value.rows, status: value.pageStatus, wire: value.wireCount }])) }));
  return desktops;
}
try {
  keepAwake = spawn('caffeinate', ['-di']);
  if (!memoryOptions) { opcuaFixtures.push(await createOpcuaTestServer()); opcuaFixtures.push(await createOpcuaTestServer()); }
  web.listen(0, '127.0.0.1'); await once(web, 'listening'); const origin = `http://127.0.0.1:${web.address().port}`;
  const override = path.join(out, 'tauri-config.json');
  await writeFile(override, JSON.stringify({ identifier, build: { beforeDevCommand: '', devUrl: `${origin}/` }, app: { windows: [{ label: 'main', title: 'Ineed LinkLab', width: 1120, height: 760, minWidth: 1120, minHeight: 720, x: 10, y: 40 }], security: { devCsp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${origin}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'` } } }));
  // Avoid the /usr/bin/env shebang: macOS strips DYLD diagnostic variables there.
  let tauriArgs = tauriDevArguments(['--no-watch', '--config', override]);
  if (process.env.LINKLAB_MEMORY_PROBE_DIR) {
    assert(memoryOptions && process.env.LINKLAB_MEMORY_PROBE_LIBRARY, 'Heap diagnostics require memory mode and a probe library');
    const runner = JSON.stringify([process.execPath, path.join(root, 'tooling/stomp-test/memory-runner.mjs')]);
    tauriArgs = ['dev', '--no-watch', '--config', override, '--', ...['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(target => `--config=target.${target}.runner=${runner}`)];
  }
  tauri = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...tauriArgs], { cwd: path.join(root, 'apps/tauri'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [tauri.stdout, tauri.stderr]) stream.on('data', bytes => appendFile(path.join(out, 'tauri.log'), bytes));
  const bootstrap = path.join(out, 'electron-main.cjs'); const profile = path.join(out, 'electron-profile'); await mkdir(profile);
  await writeFile(bootstrap, `const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root, 'apps/electron/electron/main.cjs'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  // The optional WebKit probe belongs only to the isolated Tauri host.
  delete env.DYLD_INSERT_LIBRARIES; delete env.LINKLAB_MEMORY_PROBE_DIR; delete env.LINKLAB_MEMORY_PROBE_LIBRARY;
  app = await require('@playwright/test')._electron.launch({ executablePath: await prepareElectronExecutable(), args: [bootstrap], env });
  const page = await app.firstWindow();
  page.evaluate(({ origin, source, codec, observerSource, observerMode }) => (0, eval)(`${codec}\n${observerSource.replace(/^export /gm, '')}\n(${source})('electron',${JSON.stringify(origin)},StompDecoder,createMemoryObserver,${JSON.stringify(observerMode)})`), { origin, source: browserAgent.toString(), codec: observerCodec, observerSource, observerMode }).catch(error => fatal.push(error.stack));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 330, y: 80, width: 1120, height: 760 }); window.show(); window.moveTop(); });
  await until(() => runtimes.every(name => channels[name].ready), 'Desktop ready', 120000);
  verification: {
  if (memoryOptions) {
    const capture = process.env.LINKLAB_MEMORY_PROBE_DIR ? createHeapDiagnostic({ page, directory: process.env.LINKLAB_MEMORY_PROBE_DIR, out, sample }) : null;
    if (capture) await capture('baseline');
    report = { passed: true, ...(await runMemoryCycles({ command, sample, freePort, runtimes, until, batchSize, pauseMs, options: memoryOptions, capture, onSdk: value => { sdk = value; } })), identifier, out };
    if (capture) await capture('final-deleted');
    for (const runtime of runtimes) await command(runtime, 'stop');
    break verification;
  }
  if (formOnly) {
    const geometry = {};
    for (const runtime of runtimes) geometry[runtime] = await command(runtime, 'opcua-geometry', { endpointUrl: opcuaFixtures[0].endpointUrl });
    await writeFile(path.join(out, 'opcua-form-geometry.json'), JSON.stringify(geometry, null, 2));
    for (const [runtime, groups] of Object.entries(geometry)) for (const group of groups) for (const control of group.controls) assert(control.height >= control.minimum - 1, `${runtime}: native control below minimum: ${JSON.stringify(group)}`);
    report = { passed: true, kind: 'native control geometry only; no visible pressure acceptance', geometry, identifier, out };
    break verification;
  }
  for (const server of runtimes) {
    const client = runtimes.find(name => name !== server), port = await freePort(), destination = `/topic/desktop-${server}`;
    await command(server, 'configure', { mode: 'server', port }); await command(client, 'configure', { mode: 'client', port });
    await command(server, 'messages'); await command(client, 'subscribe', { destination });
    if (process.env.LINKLAB_STOMP_VERIFY_FORM === '1') {
      const geometry = await command(client, 'form-geometry');
      await writeFile(path.join(out, `${client}-form-geometry.json`), JSON.stringify(geometry, null, 2));
      for (const row of geometry) {
        assert(Math.abs(row.input.height - row.select.height) <= 1, `${client}: input/select heights differ: ${JSON.stringify(row)}`);
        assert(Math.abs(row.input.top - row.select.top) <= 1, `${client}: input/select tops differ: ${JSON.stringify(row)}`);
      }
    }
    const extraName = `Load ${client} extra`;
    await command(client, 'configure', { mode: 'client', port, name: extraName });
    await command(client, 'subscribe', { destination });
    await command(client, 'select', { name: `Desktop ${client} client` });
    const sdkBodies = [];
    sdk = new Client({ webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${port}/stomp`, ['v12.stomp']), connectHeaders: { host: 'localhost', login: 'operator', passcode: 'desktop-private-passcode' }, reconnectDelay: 0, heartbeatIncoming: 1000, heartbeatOutgoing: 1000, debug() {}, onStompError: frame => fatal.push(frame.headers.message) });
    sdk.onConnect = () => sdk.subscribe(destination, message => sdkBodies.push(message.body)); sdk.activate();
    await until(() => sdk.connected, 'SDK connected'); await delay(500);
    await sample(stages.length ? 'role-switched' : 'start');
    const body = `GUI Unicode 工控 ${server}`;
    await command(server, 'publish', { destination, body });
    await until(async () => (await command(client, 'metrics')).bodies.includes(body), 'GUI server publish delivery');
    await command(client, 'publish', { destination, body: `${body} client` });
    await until(async () => (await command(server, 'metrics')).bodies.includes(`${body} client`), 'GUI client publish reaches native server');
    await until(() => sdkBodies.includes(body) && sdkBodies.includes(`${body} client`), 'SDK receives both GUI publishes');
    const started = Date.now(); let count = 0, lastSample = started; const expected = [];
    do {
      const bodies = Array.from({ length: batchSize }, () => `load-${server}-${String(++count).padStart(8, '0')}`);
      expected.push(...bodies); await command(client, 'raw', { destination, bodies }); await delay(pauseMs);
      if (Date.now() - lastSample >= 30000) { await sample(`load-${server}`); lastSample = Date.now(); }
    } while (Date.now() - started < duration);
    await until(() => sdkBodies.filter(body => body.startsWith('load-')).length === expected.length, 'SDK received complete desktop load');
    assert.deepEqual(sdkBodies.filter(body => body.startsWith('load-')), expected);
    await delay(500); await sample(`loaded-${server}`);
    const nativeStreams = [];
    for (const [runtime, endpointName] of [[server, `Desktop ${server} server`], [client, `Desktop ${client} client`], [client, extraName]]) {
      await command(runtime, 'select', { name: endpointName });
      const actual = (await command(runtime, 'metrics', { fullWire: true })).wire;
      assert.deepEqual(actual.map(([body]) => body), expected, `${endpointName}: complete native order`);
      assert(actual.every(([, count]) => count === 1), `${endpointName}: duplicate native body`);
      nativeStreams.push({ runtime, endpointName, count: actual.length, sha256: createHash('sha256').update(JSON.stringify(actual)).digest('hex') });
    }
    await command(client, 'delete', { name: extraName });
    await command(client, 'select', { name: `Desktop ${client} client` });
    assert.equal((await command(client, 'metrics')).pageStatus, 'connected');
    const queue = `/queue/desktop-${server}`;
    await command(client, 'subscribe', { destination: queue, ack: 'client-individual' }); await delay(200);
    const acknowledgments = (await command(server, 'metrics')).commands;
    await command(server, 'publish', { destination: queue, body: `ack-${server}` });
    await until(async () => (await command(client, 'metrics')).bodies.includes(`ack-${server}`), 'Manual queue delivery');
    await command(client, 'clear');
    assert.equal((await command(client, 'metrics')).pendingOutside, 1);
    await command(client, 'acknowledge', { command: 'ACK' });
    await until(async () => ((await command(server, 'metrics')).commands.ACK ?? 0) > (acknowledgments.ACK ?? 0), 'Native server receives UI ACK after clear');
    await command(server, 'publish', { destination: queue, body: `nack-${server}` });
    await until(async () => (await command(client, 'metrics')).bodies.includes(`nack-${server}`), 'NACK queue delivery');
    await command(client, 'clear'); await command(client, 'acknowledge', { command: 'NACK' });
    await until(async () => ((await command(server, 'metrics')).commands.NACK ?? 0) > (acknowledgments.NACK ?? 0), 'Native server receives UI NACK after clear');
    await until(async () => (await command(client, 'metrics')).bodies.includes(`nack-${server}`), 'NACK redelivers queue message');
    await command(client, 'clear'); await command(client, 'acknowledge', { command: 'ACK' });
    stages.push({ server, client, loadMs: Date.now() - started, messages: expected.length, twoNativeClients: true, deletedExtraPreservesPrimary: true, nativeStreams, guiPublishObservedByServerAndSdk: true, uiAckNackAfterClear: true, sdkFullOrder: true, nativeNoMissingOrDuplicate: true });
    await bounded('SDK deactivate', () => sdk.deactivate({ force: true })); sdk = null;
    await command(client, 'disconnect'); await command(server, 'disconnect');
    for (const name of runtimes) {
      const settings = await command(name, 'save-profile');
      assert(!JSON.stringify(settings).includes('desktop-private-passcode')); assert(!JSON.stringify(settings).includes('operator'));
      assert((await command(name, 'appearance')).preserved);
    }
  }
  const multiple = [];
  for (const runtime of runtimes) {
    const serverName = `Desktop ${runtime} server`, auxiliary = `Desktop ${runtime} auxiliary`;
    const settings = await command(runtime, 'save-profile');
    const serverProfile = settings.stompProfiles.find(profile => profile.mode === 'server');
    await command(runtime, 'select', { name: serverName }); await command(runtime, 'start');
    // Each original client points to the opposite app. Reuse its peer's server,
    // then add a second client to that same broker in the same application.
    const other = runtimes.find(name => name !== runtime);
    await command(other, 'select', { name: `Desktop ${other} client` }); await command(other, 'start');
    const destination = `/topic/multiple-${runtime}`;
    await command(other, 'subscribe', { destination });
    await command(other, 'configure', { mode: 'client', port: serverProfile.config.listenPort, name: auxiliary });
    await command(other, 'subscribe', { destination });
    const beforeDelete = `multi-before-${runtime}`;
    await command(runtime, 'publish', { destination, body: beforeDelete });
    await until(async () => (await command(other, 'metrics')).bodies.includes(beforeDelete), 'Second simultaneous client delivery');
    await command(other, 'select', { name: `Desktop ${other} client` });
    assert((await command(other, 'metrics')).bodies.includes(beforeDelete));
    await command(other, 'delete', { name: auxiliary });
    await command(other, 'select', { name: `Desktop ${other} client` });
    const afterDelete = `multi-after-${runtime}`; await command(runtime, 'publish', { destination, body: afterDelete });
    await until(async () => (await command(other, 'metrics')).bodies.includes(afterDelete), 'Surviving client after sibling delete');
    await command(other, 'disconnect'); await command(runtime, 'disconnect');
    multiple.push({ server: runtime, clients: other, independentDelivery: true, deleteIsolation: true });
  }
  const opcua = {};
  for (const runtime of runtimes) {
    opcua[runtime] = await command(runtime, 'opcua', { verifyForm: process.env.LINKLAB_STOMP_VERIFY_FORM === '1', fixtures: opcuaFixtures.map(fixture => ({ endpointUrl: fixture.endpointUrl, nodes: fixture.nodes })) });
    await command(runtime, 'select', { name: `Desktop ${runtime} client` });
  }
  await sample('disconnected'); await delay(idleMs / 3); await sample('idle-with-views');
  for (const runtime of runtimes) {
    for (const mode of ['server', 'client']) { await command(runtime, 'select', { name: `Desktop ${runtime} ${mode}` }); await command(runtime, 'clear'); }
    await command(runtime, 'clear-observer');
  }
  await sample('cleared'); await delay(idleMs * 2 / 3); await sample('idle-final');
  await page.screenshot({ path: path.join(out, 'electron-final.png') });
  for (const runtime of runtimes) await command(runtime, 'stop');
  const databases = [path.join(out, 'electron-profile', 'ineed-dev-tool.db'), path.join(process.env.HOME, 'Library/Application Support', identifier, 'ineed-dev-tool.db')];
  const persistence = databases.map(filename => {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const settings = db.prepare('SELECT key,value FROM settings').all(); const serialized = JSON.stringify(settings);
      assert(!serialized.includes('desktop-private-passcode')); assert(!serialized.includes('operator'));
      const profiles = JSON.parse(settings.find(row => row.key === 'stompProfiles').value); assert.equal(profiles.length, 2);
      assert.equal(db.prepare('SELECT count(*) AS count FROM transfer_frames').get().count, 0);
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      return { filename, profiles: profiles.length, noFrameHistory: true, noCredentialsInSettings: true, quickCheck: 'ok' };
    } finally { db.close(); }
  });
  report = { passed: true, stages, multiple, opcua, persistence, idleMs, batchSize, pauseMs, samples: samples.length, identifier, out };
  }
} catch (error) {
  console.error(error.stack); report = { passed: false, error: error.stack, stages, identifier, out, sdkDiagnostic: sdk ? { connected: sdk.connected, active: sdk.active, localPort: sdk.webSocket?._socket?.localPort } : null }; process.exitCode = 1;
  const diagnostics = await Promise.allSettled(runtimes.map(runtime => command(runtime, 'metrics')));
  await writeFile(path.join(out, 'failure-desktops.json'), JSON.stringify(diagnostics, null, 2));
}
finally {
  if (sdk) {
    let timer;
    try { await Promise.race([sdk.deactivate({ force: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SDK cleanup timeout')), 5000); })]); }
    catch (error) { report.passed = false; (report.cleanupErrors ??= []).push(error.message); process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
  async function cleanup(label, operation) {
    try { await bounded(label, operation); }
    catch (error) { report.passed = false; (report.cleanupErrors ??= []).push(error.message); process.exitCode = 1; }
  }
  if (app) {
    // Playwright releases the process dispatcher when close resolves.
    // Keep the Node child handle while it is still available.
    const electronProcess = app.process();
    await cleanup('Electron close', () => app.close());
    if (electronProcess.exitCode === null && electronProcess.signalCode === null) electronProcess.kill('SIGKILL');
  }
  if (tauri) {
    const exited = tauri.exitCode !== null || tauri.signalCode !== null ? Promise.resolve() : once(tauri, 'exit');
    try { process.kill(-tauri.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    await cleanup('Tauri exit', async () => {
      try { await bounded('Tauri SIGTERM', () => exited, 3000); }
      catch { try { process.kill(-tauri.pid, 'SIGKILL'); } catch { /* Already exited. */ } await bounded('Tauri SIGKILL', () => exited, 1500); }
    });
  }
  for (const fixture of opcuaFixtures) await cleanup('OPC UA fixture close', () => fixture.close());
  keepAwake?.kill();
  for (const channel of Object.values(channels)) { channel.waiting?.end(JSON.stringify({ action: 'stop' })); for (const call of channel.pending.values()) clearTimeout(call.timer); }
  await cleanup('Control server close', () => { web.closeAllConnections(); return new Promise((resolve, reject) => web.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())); });
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (report.cleanupErrors?.length) process.exit(1);
}
