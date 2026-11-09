/* global window, document, getComputedStyle, DataTransfer */
// Real branded desktops, independent native clients, bounded observation, localhost only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';
import { readSystemOutput } from '../soak-test/system-output.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url), runtimes = ['electron', 'tauri'];
const durationMs = Number(process.env.LINKLAB_UA_DUEL_MS ?? 1200000);
const idleMs = Number(process.env.LINKLAB_UA_IDLE_MS ?? 180000);
const pauseMs = Number(process.env.LINKLAB_UA_PAUSE_MS ?? 50);
const verifyLayout = process.env.LINKLAB_UA_VERIFY_LAYOUT === '1';
const out = process.env.LINKLAB_UA_OUT ?? path.join(tmpdir(), `linklab-ua-duel-${Date.now()}`);
assert(Number.isInteger(durationMs) && durationMs >= 1000 && durationMs <= 3600000);
assert(Number.isInteger(idleMs) && idleMs >= 0 && idleMs <= 600000);
assert(Number.isInteger(pauseMs) && pauseMs >= 20 && pauseMs <= 1000);
const identifier = `com.ineedfull.linklab.uaduel${Date.now()}`;
const channels = Object.fromEntries(runtimes.map(name => [name, { queue: [], pending: new Map() }]));
const fatal = [], samples = [], checks = [];
let seq = 0, app, page, tauri, keepAwake, report, stopping = false;
await mkdir(out, { recursive: true });
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!await fn()) { assert.deepEqual(fatal, [], label); assert(Date.now() < end, label); await delay(50); }
}
async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

async function browserAgent(runtime, origin) {
  const pageIdentity = window.crypto.randomUUID(), timeOrigin = window.performance.timeOrigin;
  const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const send = (url, body) => fetch(new URL(url, origin), { method: 'POST', body: JSON.stringify(body) });
  const progress = step => send(`/progress/${runtime}`, { step, at: Date.now() });
  const execute = async request => {
    const answer = runtime === 'electron' ? await window.ineedLinkLab.opcua.execute(request) : await window.__TAURI_INTERNALS__.invoke('opcua_execute', { request });
    if (!answer.ok) throw new Error(answer.error?.message ?? 'Native OPC UA failure'); return answer.value;
  };
  const errors = [], streams = new Map(), sessionStatuses = [], raw = [];
  let serverName, clientName, selectedName, uiConnection, remoteIds, loadPromise, running = false, paused = false, inFlight = false;
  const load = { rounds: 0, writes: 0, reads: 0, qualityCheckedReadValues: 0, exactReadbackValues: 0, maxRoundMs: 0, totalRoundMs: 0, startedAt: null, stoppedAt: null, errors: [], reconnects: 0 };
  let lastTick = Date.now(), maxTimerGapMs = 0;
  const heartbeat = window.setInterval(() => { const t = Date.now(); maxTimerGapMs = Math.max(maxTimerGapMs, t - lastTick); lastTick = t; }, 250);
  window.addEventListener('error', e => errors.push(e.message));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  const event = value => {
    if (value.type === 'status') { sessionStatuses.push({ at: Date.now(), ...value }); if (sessionStatuses.length > 50) sessionStatuses.shift(); }
    if (value.type !== 'data' || !Array.isArray(value.values)) return;
    const key = value.connectionId;
    if (!streams.has(key)) streams.set(key, { events: 0, values: 0, badQuality: 0, lastAt: 0, latest: new Map(), changed: new Map() });
    const stream = streams.get(key); stream.events++; stream.values += value.values.length; stream.lastAt = Date.now();
    for (const row of value.values) {
      if (!String(row.statusCode).startsWith('Good')) stream.badQuality++;
      if (stream.latest.has(row.nodeId) && stream.latest.get(row.nodeId) !== row.value) stream.changed.set(row.nodeId, Date.now());
      stream.latest.set(row.nodeId, row.value);
    }
  };
  if (runtime === 'electron') window.ineedLinkLab.opcua.onEvent(event);
  else await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'opcua:event', target: { kind: 'Any' }, handler: window.__TAURI_INTERNALS__.transformCallback(e => event(e.payload)) });
  const until = async (fn, label) => { const end = Date.now() + 30000; while (!fn()) { if (Date.now() > end) throw new Error(`${label}: ${document.body.innerText.slice(0, 5000)}`); await pause(50); } };
  const panel = () => [...document.querySelectorAll('.opcua-panel')].find(e => getComputedStyle(e).display !== 'none');
  async function click(text, scope = panel()) {
    let button; await until(() => (button = [...scope.querySelectorAll('button')].find(e => e.textContent.trim() === text && !e.disabled)), text);
    button.click(); await pause(30);
  }
  async function set(scope, selector, value) {
    const input = scope.querySelector(selector); if (!input) throw new Error(`Missing ${selector}`);
    input.value = value; input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await pause(10);
  }
  async function select(name) { const row = document.querySelector(`[aria-label="选择 ${name}"]`); if (!row) throw new Error(`Missing ${name}`); row.click(); selectedName = name; await pause(30); }
  async function add(kind, name, config) {
    document.querySelector('[aria-label="添加端点"]').click(); await until(() => document.querySelector('.endpoint-dialog'), 'Add dialog');
    const dialog = document.querySelector('.endpoint-dialog'); await set(dialog, '[name="endpoint-transport"]', kind); await set(dialog, '[name="endpoint-name"]', name);
    for (const [key, val] of Object.entries(config)) await set(dialog, `[name="${key}"]`, val);
    await click('保存端点', dialog); await until(() => !document.querySelector('.endpoint-dialog'), 'Saved'); await select(name);
  }
  const input = (label, value) => {
    const row = [...panel().querySelectorAll('label')].find(e => e.firstChild?.textContent.trim() === label); if (!row) throw new Error(`Missing label ${label}`);
    return set(row, 'input', value);
  };
  const status = () => panel()?.querySelector('.opcua-status')?.dataset.status;
  const summaries = () => [...streams].map(([connectionId, s]) => ({ connectionId, events: s.events, values: s.values, badQuality: s.badQuality, lastAt: s.lastAt, retainedNodes: s.latest.size,
    autoNodesChangingRecently: (remoteIds?.nodeIds ?? []).slice(4).filter(id => Date.now() - (s.changed.get(id) ?? 0) < 4000).length,
    minAutomaticValue: Math.min(...(remoteIds?.nodeIds ?? []).slice(4).map(id => s.latest.get(id) ?? -1)),
    manualValues: (remoteIds?.nodeIds ?? []).slice(0, 3).map(id => s.latest.get(id)),
  }));
  const metric = () => ({ runtime, selectedName, visibleName: panel()?.querySelector('header p')?.textContent.trim(), status: status(), visibility: document.visibilityState,
    pageIdentity, timeOrigin, observedTimeOrigin: window.performance.timeOrigin, errors: [...errors], alerts: [...(panel()?.querySelectorAll('[role="alert"]') ?? [])].map(e => e.textContent.trim()),
    domNodes: document.querySelectorAll('*').length, valueRows: panel()?.querySelectorAll('tbody tr').length,
    retainedHistory: Number(panel()?.textContent.match(/最近变化\s+(\d+)\s*\/\s*1000/)?.[1] ?? 0),
    maxTimerGapMs, streams: summaries(), load: { ...load }, sessionStatuses: [...sessionStatuses], uiConnection });
  async function rawConnect(id) {
    const result = await execute({ action: 'connect', connectionId: id, config: { endpointUrl: remoteIds.endpointUrl, securityPolicy: 'None', securityMode: 'None', authentication: 'anonymous' } });
    const client = { connectionId: id, sessionId: result.sessionId };
    await execute({ action: 'subscribe', ...client, nodeIds: remoteIds.nodeIds, intervalMs: 100 }); return client;
  }
  async function stopLoad() { running = false; if (loadPromise) await loadPromise; load.stoppedAt = Date.now(); }
  async function reconnect() {
    paused = true; await until(() => !inFlight, 'Load settled before reconnect');
    const old = raw[0]; await execute({ action: 'disconnect', ...old }); raw[0] = await rawConnect(old.connectionId); load.reconnects++; paused = false;
  }
  await until(() => document.querySelector('[aria-label="添加端点"]'), 'Desktop initialized'); await send(`/ready/${runtime}`, {});
  while (true) {
    const command = await (await fetch(new URL(`/next/${runtime}`, origin))).json(); let value, error;
    try {
      switch (command.action) {
        case 'server': {
          serverName = `UA ${runtime} server`; await add('opcua-server', serverName, { 'opcua-server-port': command.port });
          const profiles = (await execute({ action: 'serverProfiles' })).profiles, p = profiles.find(p => p.name === serverName);
          p.nodes = Array.from({ length: 100 }, (_, i) => ({ id: `N${i}`, name: `Node ${i}`, dataType: 'UInt32', arrayType: 'Scalar', writable: i !== 99, value: i,
            simulation: { mode: i < 4 ? 'manual' : 'increment', intervalMs: 100, min: 0, max: 1000000000, step: 1 } }));
          const transfer = new DataTransfer(); transfer.items.add(new File([JSON.stringify([p])], 'load-profile.json', { type: 'application/json' }));
          const file = panel().querySelector('input[type=file]'); file.files = transfer.files; file.dispatchEvent(new Event('change', { bubbles: true }));
          await until(() => panel().textContent.includes('100/100'), '100 nodes imported');
          await click('启动'); await until(() => status() === 'listening', 'Native simulator listening');
          // Derive actual SDK NodeIds from native snapshot rather than synthesizing prefixes.
          const ids = [...panel().querySelectorAll('tbody tr')].map(row => row.querySelector('code')?.textContent).filter(Boolean);
          await until(() => panel().querySelectorAll('tbody tr').length === 100, 'Server snapshot populated');
          const currentIds = [...panel().querySelectorAll('tbody tr')].map(row => row.querySelector('code')?.textContent).filter(Boolean);
          value = { endpointUrl: `opc.tcp://127.0.0.1:${command.port}/LinkLab`, nodeIds: currentIds, profile: p, initialRows: ids.length };
          break;
        }
        case 'client': {
          remoteIds = command.server; clientName = `UA ${runtime} client`;
          const before = new Set(sessionStatuses.map(e => e.connectionId));
          await add('opcua-client', clientName, { 'opcua-endpoint-url': remoteIds.endpointUrl }); await click('连接'); await until(() => status() === 'connected', 'Cross-runtime client connected'); await progress('UI connected');
          uiConnection = [...sessionStatuses].reverse().find(e => e.status === 'connected' && !before.has(e.connectionId))?.connectionId;
          if (!uiConnection) throw new Error('Missing native UI session identity');
          await click('节点与监视'); await input('NodeId', 'i=85'); await click('浏览');
          const folderRow = [...panel().querySelectorAll('tbody tr')].find(e => e.textContent.includes('LinkLab'));
          if (!folderRow) throw new Error('No LinkLab folder'); await click('展开', folderRow); await until(() => panel().querySelectorAll('input[type=checkbox][aria-label^="选择 "]').length === 100, 'Browse 100 nodes');
          await progress('100 nodes browsed');
          const interval = [...panel().querySelectorAll('label')].find(e => e.textContent.startsWith('采样间隔')); await set(interval, 'input', '100');
          for (const box of panel().querySelectorAll('input[type=checkbox][aria-label^="选择 "]')) { box.click(); await Promise.resolve(); }
          await progress('100 checkboxes selected');
          await click('监视所选（100/100）'); await until(() => panel().textContent.includes('当前监视 100 个节点') && streams.get(uiConnection)?.values >= 100, 'UI 100-node subscription');
          await progress('UI subscribed');
          const browsed = [...panel().querySelectorAll('tbody tr')].filter(e => e.querySelector('input[type=checkbox]')).map(row => ({ id: row.querySelector('code')?.textContent, name: row.querySelector('strong')?.textContent.trim() }));
          // The server snapshot and browse order are not a protocol contract.
          remoteIds.nodeIds = browsed.sort((a, b) => Number(a.name.replace('Node ', '')) - Number(b.name.replace('Node ', ''))).map(n => n.id);
          if (remoteIds.nodeIds.length !== 100 || remoteIds.nodeIds.some(id => !id)) throw new Error('Incomplete native browse IDs');
          for (let n = 0; n < 3; n++) { raw.push(await rawConnect(`load-${runtime}-${n}`)); await progress(`auxiliary ${n} subscribed`); }
          await until(() => raw.every(c => streams.get(c.connectionId)?.values >= 100), 'All auxiliary subscriptions initialized'); value = metric(); break;
        }
        case 'load': {
          running = true; load.startedAt = Date.now();
          loadPromise = (async () => {
            let sequence = 0;
            while (running) {
              if (paused) { await pause(20); continue; }
              const start = Date.now(); inFlight = true;
              try {
                const current = ++sequence;
                await Promise.all(raw.map(async (c, n) => {
                  const write = await execute({ action: 'write', ...c, nodeId: remoteIds.nodeIds[n], dataType: 'UInt32', arrayType: 'Scalar', value: current });
                  if (!String(write.statusCode).startsWith('Good')) throw new Error(`Write ${write.statusCode}`); load.writes++;
                  const read = await execute({ action: 'read', ...c, nodeIds: remoteIds.nodeIds }); load.reads++;
                  if (read.values.length !== 100 || read.values.some(v => !String(v.statusCode).startsWith('Good'))) throw new Error('Incomplete/bad-quality read');
                  const row = read.values.find(v => v.nodeId === remoteIds.nodeIds[n]); if (row?.value !== current) throw new Error(`Readback ${row?.value} != ${current}`);
                  load.qualityCheckedReadValues += read.values.length; load.exactReadbackValues++;
                }));
                const elapsed = Date.now() - start; load.rounds++; load.maxRoundMs = Math.max(load.maxRoundMs, elapsed); load.totalRoundMs += elapsed;
              } catch (e) { load.errors.push({ at: Date.now(), message: e.message }); running = false; }
              finally { inFlight = false; }
              await pause(command.pauseMs);
            }
          })(); value = metric(); break;
        }
        case 'reconnect': await reconnect(); value = metric(); break;
        case 'stop-load': await stopLoad(); value = metric(); break;
        case 'server-stop': await select(serverName); await click('停止'); await until(() => status() === 'disconnected', 'Server stopped'); value = metric(); break;
        case 'server-start': await select(serverName); await click('启动'); await until(() => status() === 'listening', 'Server restarted'); value = metric(); break;
        case 'show-client': await select(clientName); value = metric(); break;
        case 'recover': await until(() => status() === 'connected' && panel().textContent.includes('当前监视 100 个节点') && Date.now() - (streams.get(uiConnection)?.lastAt ?? 0) < 2000, 'Automatic reconnect/subscription recovery'); value = metric(); break;
        case 'disconnect':
          await stopLoad(); for (const c of raw) await execute({ action: 'disconnect', ...c }); await select(clientName); await click('断开'); await until(() => status() === 'disconnected', 'UI disconnected'); value = metric(); break;
        case 'delete': {
          const row = document.querySelector(`[aria-label="选择 ${command.name}"]`).closest('.endpoint-row'); row.querySelector('[aria-label="端点操作"]').click();
          await click('删除', row); await until(() => !row.isConnected, 'Endpoint deleted'); value = { deleted: command.name }; break;
        }
        case 'metrics': value = metric(); break;
        case 'geometry': {
          value = {};
          for (const [kind, name] of [['client', clientName], ['server', serverName]]) {
            await select(name);
            const table = panel().querySelector('.opcua-values');
            if (!table) throw new Error(`Missing ${kind} real-time table`);
            const columns = [];
            for (let i = 0; i < 100; i++) {
              columns.push([...table.querySelectorAll('th')].map(e => { const r = e.getBoundingClientRect(); return { x: r.x, width: r.width }; }));
              await pause(50);
            }
            value[kind] = { samples: columns.length, maxColumnMovement: Math.max(...columns[0].flatMap((_, i) => ['x', 'width'].map(field => Math.max(...columns.map(c => c[i][field])) - Math.min(...columns.map(c => c[i][field]))))) };
          }
          await select(clientName); break;
        }
        case 'finish': await stopLoad(); window.clearInterval(heartbeat); value = metric(); break;
        default: throw new Error(`Unknown ${command.action}`);
      }
    } catch (e) { error = e.stack ?? e.message; }
    await send(`/result/${runtime}`, { id: command.id, value, error }); if (command.action === 'finish') return;
  }
}

const web = http.createServer(async (request, response) => {
  try {
    response.setHeader('access-control-allow-origin', '*'); const url = new URL(request.url, 'http://localhost'), runtime = url.pathname.split('/')[2];
    if (url.pathname.startsWith('/progress/')) { let body = ''; for await (const chunk of request) body += chunk; console.log(JSON.stringify({ runtime, ...JSON.parse(body) })); response.end('ok'); return; }
    if (url.pathname.startsWith('/ready/')) { channels[runtime].ready = true; response.end('ok'); return; }
    if (url.pathname.startsWith('/next/')) { const c = channels[runtime]; if (c.queue.length) response.end(JSON.stringify(c.queue.shift())); else c.waiting = response; return; }
    if (url.pathname.startsWith('/result/') || url.pathname === '/fatal') {
      let body = ''; for await (const chunk of request) body += chunk;
      if (url.pathname === '/fatal') fatal.push(body);
      else { const result = JSON.parse(body), c = channels[runtime], pending = c.pending.get(result.id); if (pending) { clearTimeout(pending.timer); c.pending.delete(result.id); console.log(JSON.stringify({ runtime, command: pending.action, ok: !result.error })); result.error ? pending.reject(new Error(result.error)) : pending.resolve(result.value); } }
      response.end('ok'); return;
    }
    if (url.pathname === '/agent.js') { response.setHeader('content-type', 'application/javascript'); response.end(`(${browserAgent.toString()})('tauri',location.origin).catch(e=>fetch('/fatal',{method:'POST',body:e.stack}));`); return; }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); assert(!relative.includes('..'));
    let data = await readFile(path.join(root, 'apps/tauri/dist', relative)); if (relative === 'index.html') data = Buffer.from(data.toString().replace('</body>', '<script type="module" src="/agent.js"></script></body>'));
    response.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); response.end(data);
  } catch (e) { response.writeHead(500).end(e.message); }
});
function command(runtime, action, args = {}) {
  return new Promise((resolve, reject) => {
    const c = channels[runtime], id = ++seq, timer = setTimeout(() => { c.pending.delete(id); reject(new Error(`${runtime}/${action} timeout`)); }, 45000);
    c.pending.set(id, { resolve, reject, timer, action }); const value = { id, action, ...args };
    if (c.waiting) { c.waiting.end(JSON.stringify(value)); c.waiting = null; } else c.queue.push(value);
  });
}
async function sample(stage, requireConnected = true) {
  const resourceHelper = process.env.LINKLAB_DUEL_RESOURCE_HELPER, windowHelper = process.env.LINKLAB_DUEL_WINDOW_HELPER;
  assert(resourceHelper && windowHelper, 'Native resource and window helpers required');
  const resources = JSON.parse(await readSystemOutput(resourceHelper)), host = resources.find(row => row.name.includes(identifier));
  assert(host, 'Native Tauri host identity'); const hosts = [app.process().pid, host.pid];
  // macOS also reports off-screen menu-bar surfaces at layer zero. Only the
  // workbench-sized windows establish desktop visibility.
  const windows = JSON.parse(await readSystemOutput(windowHelper, stage === 'baseline' ? hosts.map(String) : [])).filter(row => hosts.includes(row.pid) && row.layer === 0 && row.bounds.Width >= 1000 && row.bounds.Height >= 700);
  await appendFile(path.join(out, 'window-observations.jsonl'), JSON.stringify({ at: Date.now(), stage, hosts, windows }) + '\n');
  assert.equal(new Set(windows.map(w => w.pid)).size, 2, 'Two real desktop windows');
  assert(windows.every(w => w.onScreen && !w.hidden && (w.axWindows ?? []).every(v => !v.minimized)), 'Both windows visible');
  assert(!(await readSystemOutput('ioreg', ['-n', 'Root', '-d1'])).includes('"CGSSessionScreenIsLocked"=Yes'), 'Desktop locked');
  const desktops = Object.fromEntries(await Promise.all(runtimes.map(async r => [r, await command(r, 'metrics')])));
  for (const d of Object.values(desktops)) {
    assert.deepEqual(d.errors, []); assert.deepEqual(d.alerts, []); assert.deepEqual(d.load.errors, []); assert.equal(d.visibility, 'visible'); assert.equal(d.visibleName, d.selectedName);
    assert(d.retainedHistory <= 1000 && d.valueRows <= 200, 'Rendered/latest/history bounds');
    if (requireConnected) { assert.equal(d.status, 'connected'); assert.equal(d.streams.length, 4); assert(d.streams.every(s => s.retainedNodes === 100 && s.badQuality === 0 && s.autoNodesChangingRecently === 96 && Date.now() - s.lastAt < 4000), 'All streams and all 96 automatic nodes live/bounded/Good'); }
    if (samples.length) assert.equal(d.pageIdentity, samples[0].desktops[d.runtime].pageIdentity, 'Desktop reloaded');
  }
  const owned = resources.filter(row => hosts.includes(row.pid) || hosts.includes(row.responsible));
  const result = { at: Date.now(), stage, desktops, windows, owned, electron: await app.evaluate(({ app }) => app.getAppMetrics()) }; samples.push(result);
  await appendFile(path.join(out, 'samples.jsonl'), JSON.stringify(result) + '\n');
  console.log(JSON.stringify({ stage, at: result.at, desktops: Object.fromEntries(Object.entries(desktops).map(([r, d]) => [r, { status: d.status, rounds: d.load.rounds, values: d.streams.reduce((n, s) => n + s.values, 0), maxTimerGapMs: d.maxTimerGapMs }])) })); return result;
}
const ports = [await freePort(), await freePort()];
try {
  keepAwake = spawn('caffeinate', ['-di']); web.listen(0, '127.0.0.1'); await once(web, 'listening'); const origin = `http://127.0.0.1:${web.address().port}`;
  const config = path.join(out, 'tauri-config.json');
  await writeFile(config, JSON.stringify({ identifier, build: { beforeDevCommand: '', devUrl: origin }, app: { windows: [{ label: 'main', title: 'Ineed LinkLab', width: 1120, height: 760, minWidth: 1120, minHeight: 720, x: 10, y: 40 }], security: { devCsp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${origin}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'` } } }));
  await writeFile(path.join(out, 'isolation.json'), JSON.stringify({ identifier, tauriData: path.join(process.env.HOME, 'Library/Application Support', identifier), ports, durationMs, idleMs, pauseMs }));
  tauri = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...tauriDevArguments(['--no-watch', '--config', config])], { cwd: path.join(root, 'apps/tauri'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [tauri.stdout, tauri.stderr]) stream.on('data', bytes => appendFile(path.join(out, 'tauri.log'), bytes));
  tauri.on('exit', code => { if (!stopping) fatal.push(`Tauri exited: ${code}`); });
  const profile = path.join(out, 'electron-profile'); await mkdir(profile); const bootstrap = path.join(out, 'electron-main.cjs');
  await writeFile(bootstrap, `const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root, 'apps/electron/electron/main.cjs'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  app = await require('@playwright/test')._electron.launch({ executablePath: await prepareElectronExecutable(), args: [bootstrap], env }); page = await app.firstWindow();
  page.evaluate(({ origin, source }) => (0, eval)(`(${source})('electron',${JSON.stringify(origin)})`), { origin, source: browserAgent.toString() }).catch(e => { if (!stopping) fatal.push(e.stack); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 340, y: 80, width: 1120, height: 760 }); w.show(); w.moveTop(); });
  await until(() => runtimes.every(r => channels[r].ready), 'Desktops ready', 120000);
  const servers = Object.fromEntries(await Promise.all(runtimes.map(async (r, n) => [r, await command(r, 'server', { port: ports[n] })])));
  await writeFile(path.join(out, 'servers.json'), JSON.stringify(servers, null, 2));
  await Promise.all(runtimes.map((r, n) => command(r, 'client', { server: servers[runtimes[1 - n]] })));
  await delay(1000); await sample('baseline'); checks.push('UI import/start/browse and 100-node cross-runtime subscriptions; four native clients per runtime; all 96 automatic nodes change on every stream');
  // Force server loss before the timed load; verify actual automatic client/subscription recovery.
  for (const server of runtimes) {
    const client = runtimes.find(r => r !== server); await command(server, 'server-stop'); await delay(1000); await command(server, 'server-start'); await command(server, 'show-client');
    await command(client, 'recover');
  }
  await delay(1000); await sample('recovered'); checks.push('Both server-stop/restart directions recover native client and UI subscription');
  await Promise.all(runtimes.map(r => command(r, 'load', { pauseMs })));
  const startedAt = Date.now(); let lastSample = startedAt, lastReconnect = startedAt;
  while (Date.now() - startedAt < durationMs) {
    await delay(500);
    if (Date.now() - lastSample >= 30000) { await sample('load'); lastSample = Date.now(); }
    if (Date.now() - lastReconnect >= Math.min(240000, durationMs / 3)) { await Promise.all(runtimes.map(r => command(r, 'reconnect'))); lastReconnect = Date.now(); checks.push(`Auxiliary native sessions reconnect at ${lastReconnect - startedAt}ms`); }
  }
  await Promise.all(runtimes.map(r => command(r, 'stop-load'))); const endedAt = Date.now(); await delay(500); const loaded = await sample('loaded');
  for (const d of Object.values(loaded.desktops)) assert(d.streams.every(s => s.manualValues.every(value => value === d.load.rounds)), 'All subscriptions receive final exact manual write values');
  assert(endedAt - startedAt >= durationMs); for (const d of Object.values(loaded.desktops)) assert(d.load.rounds >= Math.max(1, durationMs / 1000), 'Sustained minimum one verified round per second');
  const layout = verifyLayout ? Object.fromEntries(await Promise.all(runtimes.map(async r => [r, await command(r, 'geometry')]))) : null;
  if (layout) {
    for (const runtime of Object.values(layout)) for (const panel of Object.values(runtime)) assert(panel.maxColumnMovement < 0.5, 'Live client/server columns stay stable');
    checks.push('Both native client/server real-time tables stable across100 successive live measurements each');
  }
  await page.screenshot({ path: path.join(out, 'electron-loaded.png') });
  await Promise.all(runtimes.map(r => command(r, 'disconnect'))); await Promise.all(runtimes.map(r => command(r, 'server-stop'))); await Promise.all(runtimes.map(r => command(r, 'show-client')));
  const idleStartedAt = Date.now(); await sample('disconnected', false);
  while (Date.now() - idleStartedAt < idleMs) { await delay(Math.min(30000, Math.max(1, idleMs - (Date.now() - idleStartedAt)))); await sample('idle', false); }
  const idleEndedAt = Date.now(); const final = await sample('idle-final', false);
  for (const r of runtimes) for (const name of [`UA ${r} client`, `UA ${r} server`]) await command(r, 'delete', { name });
  for (const r of runtimes) await command(r, 'finish');
  report = { passed: true, kind: 'actual Electron/Tauri desktop simulator bidirectional soak', startedAt, endedAt, elapsedMs: endedAt - startedAt, idleStartedAt, idleEndedAt, idleElapsedMs: idleEndedAt - idleStartedAt, parameters: { nodesPerServer: 100, clientsPerRuntime: 4, intervalMs: 100, pauseMs, durationMs, idleMs }, layout, checks, loaded: loaded.desktops, final: final.desktops, sampleCount: samples.length, identifier, out };
} catch (e) {
  process.exitCode = 1; console.error(e.stack); report = { passed: false, error: e.stack, fatal, checks, identifier, out };
  await page?.screenshot({ path: path.join(out, 'electron-failed.png'), timeout: 5000 }).catch(() => {});
  const diagnostics = await Promise.allSettled(runtimes.filter(r => channels[r].ready).map(async r => [r, await command(r, 'metrics')])); await writeFile(path.join(out, 'failure-desktops.json'), JSON.stringify(diagnostics, (_, value) => value instanceof Error ? value.stack : value, 2));
} finally {
  stopping = true;
  if (app) try { await app.close(); } catch (e) { (report.cleanupErrors ??= []).push(e.message); }
  if (tauri) { try { process.kill(-tauri.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
  keepAwake?.kill(); for (const c of Object.values(channels)) { c.waiting?.end('{}'); for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Test cleanup')); } c.pending.clear(); }
  web.closeAllConnections(); await new Promise(resolve => web.close(resolve));
  await delay(500);
  const releasedPorts = [];
  for (const port of ports) try { const s = net.createServer(); s.listen(port, '127.0.0.1'); await once(s, 'listening'); await new Promise(resolve => s.close(resolve)); releasedPorts.push(port); } catch (e) { (report.cleanupErrors ??= []).push(e.message); }
  report.releasedPorts = releasedPorts; if (report.cleanupErrors?.length) { report.passed = false; process.exitCode = 1; }
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, elapsedMs: report.elapsedMs, idleElapsedMs: report.idleElapsedMs, error: report.error, out }));
}
