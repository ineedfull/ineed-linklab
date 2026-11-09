/* global window, document */
// Real Electron/WKWebView peers. No mock adapters, browser WS or production data.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const durationMs = Number(process.env.LINKLAB_DUEL_MS ?? 1_200_000);
const idleMs = Number(process.env.LINKLAB_DUEL_IDLE_MS ?? 180_000);
const burst = Number(process.env.LINKLAB_DUEL_BURST ?? 16);
const reconnectMs = Number(process.env.LINKLAB_DUEL_RECONNECT_MS ?? 60000);
// A second desktop pair may use another physical display during cross-tool load.
// Explicit coordinates avoid one product occluding another native WebView.
const displayOrigin = process.env.LINKLAB_DUEL_DISPLAY_ORIGIN
  ? JSON.parse(process.env.LINKLAB_DUEL_DISPLAY_ORIGIN) : null;
if (displayOrigin) assert(['x', 'y'].every(key => Number.isInteger(displayOrigin[key]) && Math.abs(displayOrigin[key]) <= 20000), 'Invalid display origin');
const tauriBounds = { x: displayOrigin?.x ?? 10, y: displayOrigin?.y ?? 30, width: 1120, height: 760 };
const electronBounds = { x: displayOrigin ? displayOrigin.x + 1140 : 330, y: displayOrigin?.y ?? 80, width: 1120, height: 760 };
assert(Number.isFinite(durationMs) && durationMs > 0 && idleMs >= 0);
assert(Number.isInteger(burst) && burst >= 1 && burst <= 64);
const out = process.env.LINKLAB_DUEL_OUT ?? await mkdtemp(path.join(tmpdir(), 'linklab-desktop-duel-'));
await mkdir(out, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const runtimes = ['electron', 'tauri'];
const channels = Object.fromEntries(runtimes.map(runtime => [runtime, { queue: [], waiting: null, pending: new Map(), ready: false }]));
const counts = Object.fromEntries(runtimes.map(runtime => [runtime, { c1: 0, c2: 0, server: 0 }]));
let commandSequence = 0, app, tauri, page, keepAwake;
let cycle = 0, reconnects = 0, invalidRejected = 0, loadElapsedMs = 0;
const snapshots = [];
const errors = [];
const paths = {};
const ports = {};
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
for (const runtime of runtimes) ports[runtime] = await freePort();
const profiles = runtime => [
  { id: 'duel-server', name: `${runtime} WS Server`, transport: 'websocket-server', config: { listenHost: '127.0.0.1', listenPort: ports[runtime], path: '/duel', subprotocols: ['linklab-duel'], heartbeat: { enabled: true, intervalMs: 5000, timeoutMs: 3000 } } },
  ...['c1', 'c2'].map(role => ({ id: `duel-${role}`, name: `${runtime} WS ${role}`, transport: 'websocket-client', config: { url: `ws://127.0.0.1:${ports[runtime === 'electron' ? 'tauri' : 'electron']}/duel`, subprotocols: ['linklab-duel'], autoReconnect: true, heartbeat: { enabled: true, intervalMs: 5000, timeoutMs: 3000 } } })),
];

// Runs in the actual desktop renderer. Native events also verify UI-owned reconnect.
async function browserAgent(runtime, controlOrigin = window.location.origin) {
  const control = (url, options) => fetch(new URL(url, controlOrigin), options);
  const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const errors = [], warnings = [], states = {}, peerCounts = {};
  const identity = { timeOrigin: window.performance.timeOrigin, url: window.location.href };
  let statusEvents = 0;
  window.addEventListener('error', e => errors.push(e.message));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  const names = { 'transport.send': 'transport_send', 'transport.open': 'transport_open', 'settings.save': 'settings_save' };
  const call = async (method, args) => {
    let result;
    if (runtime === 'electron') { const [group, name] = method.split('.'); result = await window.ineedLinkLab[group][name](...args); }
    else result = await window.__TAURI_INTERNALS__.invoke(names[method], { args });
    if (!result?.ok) throw new Error(`${method}: ${JSON.stringify(result)}`);
    return result.value;
  };
  const subscribe = async (channel, callback) => {
    if (runtime === 'electron') {
      const method = { 'transport:status': 'onStatus', 'transport:peers': 'onPeers', 'persistence:warning': 'onPersistenceWarning' }[channel];
      window.ineedLinkLab.transport[method](callback);
    } else await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: channel, target: { kind: 'Any' }, handler: window.__TAURI_INTERNALS__.transformCallback(event => callback(event.payload)),
    });
  };
  await subscribe('transport:status', value => { states[value.endpointId] = value.status; statusEvents++; });
  await subscribe('transport:peers', value => { peerCounts[value.endpointId] = value.peers.length; });
  await subscribe('persistence:warning', value => { if (warnings.length < 20) warnings.push(value); });
  const until = async (check, label) => { for (let n = 0; n < 400; n++) { if (check()) return; await pause(50); } throw new Error(`Desktop ${runtime} ${label} deadline`); };
  const row = role => [...document.querySelectorAll('.endpoint-row')].find(el => el.querySelector('strong')?.textContent === `${runtime} WS ${role === 'server' ? 'Server' : role}`);
  const ui = async (role, opening) => {
    await until(() => row(role), `row ${role}`);
    const button = row(role).querySelector(`[aria-label="${opening ? '打开端点' : '关闭端点'}"]`);
    if (!button) throw new Error(`Missing ${opening ? 'open' : 'close'} action ${runtime}/${role}`);
    button.click();
    await until(() => states[`duel-${role}`] === (opening ? role === 'server' ? 'listening' : 'open' : 'closed'), `UI ${role} ${opening}`);
  };
  const metrics = () => ({ identity, visibility: document.visibilityState, states: { ...states }, peers: { ...peerCounts }, statusEvents,
    renderedRows: document.querySelectorAll('.frame-list__item').length, errors: [...errors], warnings: [...warnings],
    jsHeap: window.performance.memory ? { used: window.performance.memory.usedJSHeapSize, total: window.performance.memory.totalJSHeapSize } : null });
  await until(() => row('server'), 'workbench mounted');
  window.__duel = { metrics };
  await control(`/ready/${runtime}`, { method: 'POST' });
  while (true) {
    const command = await (await control(`/next/${runtime}`)).json();
    let value, error;
    try {
      switch (command.action) {
        case 'ui': await ui(command.role, command.open); value = metrics(); break;
        case 'select': row(command.role).querySelector('.endpoint-row__select').click(); value = metrics(); break;
        case 'batch': value = await Promise.all(command.requests.map(request => call('transport.send', [request]))); break;
        case 'invalid': {
          let rejected = 0;
          for (const request of [{ endpointId: 'duel-c1', bytes: [255], messageType: 'text' }, { endpointId: 'duel-c1', bytes: [256, -1], messageType: 'binary' }]) {
            try { await call('transport.send', [request]); } catch { rejected++; }
          }
          if (rejected !== 2) throw new Error('Invalid message was accepted');
          value = rejected; break;
        }
        case 'waitPeers': await until(() => peerCounts['duel-server'] === 2 && states['duel-c1'] === 'open' && states['duel-c2'] === 'open', 'reconnected peers'); value = metrics(); break;
        case 'theme': await call('settings.save', ['theme', command.theme]); value = metrics(); break;
        case 'clear': document.querySelector('[aria-label="清空实时视图"]').click(); await pause(100); value = metrics(); break;
        case 'metrics': value = metrics(); break;
        case 'stop': value = metrics(); break;
        default: throw new Error('Unknown desktop command');
      }
    } catch (reason) { error = reason.message + '; ' + reason.stack; }
    await control(`/result/${runtime}`, { method: 'POST', body: JSON.stringify({ id: command.id, value, error }) });
    if (command.action === 'stop') return;
  }
}

const web = http.createServer(async (req, res) => {
  try {
    res.setHeader('access-control-allow-origin', '*');
    const url = new URL(req.url, 'http://localhost');
    const runtime = url.pathname.split('/')[2];
    if (url.pathname.startsWith('/ready/')) { channels[runtime].ready = true; res.end('ok'); return; }
    if (url.pathname.startsWith('/next/')) {
      const channel = channels[runtime];
      res.setHeader('content-type', 'application/json');
      if (channel.queue.length) res.end(JSON.stringify(channel.queue.shift()));
      else channel.waiting = res;
      return;
    }
    if (url.pathname.startsWith('/result/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const result = JSON.parse(body), pending = channels[runtime].pending.get(result.id);
      if (pending) { clearTimeout(pending.timer); channels[runtime].pending.delete(result.id); result.error ? pending.reject(new Error(result.error)) : pending.resolve(result.value); }
      res.end('ok'); return;
    }
    if (url.pathname === '/duel.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(`(${browserAgent.toString()})(${JSON.stringify(url.searchParams.get('runtime'))}).catch(error=>fetch('/fatal',{method:'POST',body:JSON.stringify({error:error.message,stack:error.stack})}));`); return;
    }
    if (url.pathname === '/fatal') { let body = ''; for await (const chunk of req) body += chunk; errors.push(JSON.parse(body)); res.end('ok'); return; }
    let relative = url.pathname.replace(/^\/(electron|tauri)\//, '/').slice(1);
    const isIndex = ['/electron/', '/tauri/'].includes(url.pathname);
    let bytes;
    if (isIndex) {
      const entry = url.pathname.includes('electron') ? 'electron' : 'tauri';
      bytes = await readFile(path.join(root, `apps/${entry}/dist/index.html`));
      bytes = Buffer.from(bytes.toString().replace('</body>', `<script type="module" src="/duel.js?runtime=${entry}"></script></body>`)); relative = 'index.html';
    } else {
      assert(!relative.includes('..'));
      try { bytes = await readFile(path.join(root, 'apps/electron/dist', relative)); }
      catch { bytes = await readFile(path.join(root, 'apps/tauri/dist', relative)); }
    }
    res.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : relative.endsWith('.png') ? 'image/png' : 'text/html'); res.end(bytes);
  } catch (error) { res.statusCode = 500; res.end(error.message); }
});
function command(runtime, action, args = {}) {
  return new Promise((resolve, reject) => {
    const channel = channels[runtime], id = ++commandSequence;
    const timer = setTimeout(() => { channel.pending.delete(id); reject(new Error(`${runtime}/${action} control deadline`)); }, 45000);
    channel.pending.set(id, { resolve, reject, timer });
    const value = { id, action, ...args };
    if (channel.waiting) { channel.waiting.end(JSON.stringify(value)); channel.waiting = null; }
    else channel.queue.push(value);
  });
}
function packet(runtime, role, sequence) {
  const payload = Buffer.from(`D1:${runtime}:${role}:${String(sequence).padStart(10, '0')}|`.padEnd(126, 'x'));
  return sequence % 2 ? [255, 0, ...payload] : [...payload, 32, 32];
}
function databaseCounts(runtime) {
  const db = new DatabaseSync(path.join(paths[runtime], 'ineed-dev-tool.db'), { readOnly: true });
  try { return db.prepare('SELECT endpoint_id, direction, count(*) AS count FROM transfer_frames GROUP BY endpoint_id,direction').all(); }
  finally { db.close(); }
}
async function snapshot(stage, started) {
  const desktops = Object.fromEntries(await Promise.all(runtimes.map(async runtime => [runtime, await command(runtime, 'metrics')])));
  for (const value of Object.values(desktops)) { assert.deepEqual(value.errors, []); assert.deepEqual(value.warnings, []); assert.equal(value.visibility, 'visible'); }
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,etime=,comm='], { encoding: 'utf8' }).split('\n').filter(line => /LinkLab|WebKit\.(WebContent|GPU|Networking)/.test(line));
  const metrics = await app.evaluate(({ app, BrowserWindow }) => ({ processes: app.getAppMetrics(), windows: BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds() })) }));
  assert(metrics.windows.every(w => w.visible && !w.minimized));
  let nativeResources = [], nativeWindows = [];
  if (process.env.LINKLAB_DUEL_RESOURCE_HELPER) {
    const all = JSON.parse(execFileSync(process.env.LINKLAB_DUEL_RESOURCE_HELPER, [], { encoding: 'utf8' }));
    const tauriHost = all.find(row => row.name.includes(paths.tauri.split('/').at(-1)));
    nativeResources = all.filter(row => row.pid === app.process().pid || row.responsible === app.process().pid || row.pid === tauriHost?.pid || row.responsible === tauriHost?.pid);
  }
  if (process.env.LINKLAB_DUEL_WINDOW_HELPER) {
    const restore = stage === 'load-start' ? nativeResources.filter(row => row.pid === app.process().pid || row.name.includes(paths.tauri.split('/').at(-1))).map(row => String(row.pid)) : [];
    nativeWindows = JSON.parse(execFileSync(process.env.LINKLAB_DUEL_WINDOW_HELPER, restore, { encoding: 'utf8' }));
    const ownedPids = new Set(nativeResources.map(row => row.pid));
    nativeWindows = nativeWindows.filter(row => ownedPids.has(row.pid));
    // AppKit also owns zero-size helpers, menus and offscreen utility windows.
    const mainWindows = nativeWindows.filter(row => row.layer === 0 && row.bounds.Width >= 1000 && row.bounds.Height >= 700);
    await writeFile(path.join(out, 'window-diagnostics.json'), JSON.stringify({ stage, nativeResources, nativeWindows, restore }, null, 2));
    assert(new Set(mainWindows.map(row => row.pid)).size === 2 && mainWindows.every(row => row.onScreen && !row.hidden && (row.axWindows ?? []).every(window => !window.minimized)), 'Both native windows must remain visible');
  }
  const locked = execFileSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' }).includes('"CGSSessionScreenIsLocked"=Yes');
  assert.equal(locked, false, 'Visible desktop acceptance requires unlocked screen');
  const value = { stage, at: Date.now(), elapsedMs: Date.now() - started, cycle, reconnects, invalidRejected, counts: structuredClone(counts), desktops, processes, nativeResources, nativeWindows, locked, electron: metrics, history: Object.fromEntries(runtimes.map(runtime => [runtime, databaseCounts(runtime)])) };
  snapshots.push(value); await appendFile(path.join(out, 'samples.jsonl'), JSON.stringify(value) + '\n');
  await writeFile(path.join(out, 'progress.json'), JSON.stringify(value)); console.log(JSON.stringify({ stage, elapsedMs: value.elapsedMs, cycle, reconnects, counts }));
}
function verifyHistory(runtime) {
  const other = runtime === 'electron' ? 'tauri' : 'electron';
  const db = new DatabaseSync(path.join(paths[runtime], 'ineed-dev-tool.db'), { readOnly: true });
  const groups = new Map(); let total = 0;
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const row of db.prepare('SELECT endpoint_id,direction,format,framing,payload,byte_count,peer_id,session_id FROM transfer_frames ORDER BY id').iterate()) {
      total++; const bytes = Buffer.from(row.payload); assert.equal(bytes.length, 128); assert.equal(row.byte_count, 128); assert.equal(row.framing, 'websocket');
      const binary = bytes[0] === 255;
      assert.equal(row.format, binary ? 'hex' : 'text');
      const match = bytes.subarray(binary ? 2 : 0).toString('ascii').match(/^D1:(electron|tauri):(c1|c2|server):(\d{10})\|/);
      assert(match, `Invalid history payload ${runtime}`);
      const [, origin, role, textSequence] = match, sequence = Number(textSequence);
      assert.equal(binary, sequence % 2 === 1);
      assert.deepEqual([...bytes], packet(origin, role, sequence));
      assert(sequence >= 1 && sequence <= counts[origin][role]);
      assert.equal(origin, row.direction === 'out' ? runtime : other);
      if (row.direction === 'out') assert.equal(row.endpoint_id, `duel-${role}`);
      else assert.equal(row.endpoint_id === 'duel-server', role !== 'server');
      const key = [row.endpoint_id, row.direction, origin, role].join('/');
      if (!groups.has(key)) groups.set(key, { seen: new Uint8Array(counts[origin][role] + 1), expected: counts[origin][role], multiplicity: row.direction === 'out' && role === 'server' ? 2 : 1, last: new Map(), rows: 0 });
      const group = groups.get(key); group.seen[sequence]++; group.rows++;
      const wire = `${row.session_id}/${row.peer_id ?? ''}`;
      if (!group.last.has(wire)) group.last.set(wire, { hash: createHash('sha256'), rows: 0 });
      const stream = group.last.get(wire); stream.hash.update(bytes); stream.rows++;
    }
    assert.equal(groups.size, 7, 'Every send/receive stream must be present');
    for (const [key, group] of groups) for (let sequence = 1; sequence <= group.expected; sequence++) assert.equal(group.seen[sequence], group.multiplicity, `${runtime}/${key} missing or duplicated ${sequence}`);
    const warnings = db.prepare("SELECT code,message FROM runtime_logs WHERE message LIKE '%overflow%' OR message LIKE '%dropped%'").all(); assert.deepEqual(warnings, []);
    return { passed: true, runtime, totalFrames: total, streams: [...groups].map(([key, value]) => ({ key, rows: value.rows, sequenceComplete: true, wireOrder: [...value.last.values()].map(stream => ({ rows: stream.rows, hash: stream.hash.digest('hex') })) })), integrity: 'ok', warnings };
  } finally { db.close(); }
}

let result;
try {
  keepAwake = spawn('caffeinate', ['-di']);
  web.listen(0, '127.0.0.1'); await once(web, 'listening');
  const origin = `http://127.0.0.1:${web.address().port}`;
  const identifier = `com.ineedfull.linklab.duel${Date.now()}`;
  paths.electron = path.join(out, 'electron-profile'); paths.tauri = path.join(process.env.HOME, 'Library/Application Support', identifier);
  for (const runtime of runtimes) {
    await mkdir(paths[runtime], { recursive: true });
    const db = require('../../apps/electron/electron/database.cjs').openConfigurationDatabase(path.join(paths[runtime], 'ineed-dev-tool.db'));
    for (const profile of profiles(runtime)) db.saveEndpoint(profile);
    db.saveSetting('realtimeFrameLimit', 2000); db.close();
  }
  await writeFile(path.join(out, 'isolation.json'), JSON.stringify({ identifier, paths, ports, origin, durationMs, idleMs, burst, tauriBounds, electronBounds }));
  const override = path.join(out, 'tauri-config.json');
  const productionConfig = JSON.parse(await readFile(path.join(root, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8'));
  const mainWindow = productionConfig.app.windows.find(window => window.label === 'main');
  await writeFile(override, JSON.stringify({ identifier, build: { beforeDevCommand: '', devUrl: `${origin}/tauri/` }, app: { windows: [{ ...mainWindow, label: 'main', title: 'Ineed LinkLab', ...tauriBounds, minWidth: 1120, minHeight: 720 }], security: { devCsp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${origin}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'` } } }));
  tauri = spawn(path.join(root, 'node_modules/.bin/tauri'), tauriDevArguments(['--no-watch', '--config', override]), { cwd: path.join(root, 'apps/tauri'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [tauri.stdout, tauri.stderr]) stream.on('data', bytes => appendFile(path.join(out, 'tauri.log'), bytes));
  const bootstrap = path.join(out, 'electron-main.cjs');
  await writeFile(bootstrap, `const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(paths.electron)});app.setPath('sessionData',${JSON.stringify(paths.electron)});require(${JSON.stringify(path.join(root, 'apps/electron/electron/main.cjs'))});`);
  const env = { ...process.env, VITE_DEV_SERVER_URL: `${origin}/electron/` }; delete env.ELECTRON_RUN_AS_NODE;
  app = await require('@playwright/test')._electron.launch({ executablePath: await prepareElectronExecutable(), args: [bootstrap], env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.ineedLinkLab && document.querySelectorAll('.endpoint-row').length === 3);
  const electronAgent = page.evaluate(({ origin, source }) => (0, eval)(`(${source})`)('electron', origin), { origin, source: browserAgent.toString() });
  electronAgent.catch(error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }, bounds) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds(bounds); w.show(); w.moveTop(); }, electronBounds);
  await writeFile(path.join(out, 'hosts.json'), JSON.stringify({ electron: app.process().pid, tauriLauncher: tauri.pid }));
  const readyDeadline = Date.now() + 120000;
  while (!runtimes.every(runtime => channels[runtime].ready)) { assert(Date.now() < readyDeadline, `Desktop startup deadline: ${JSON.stringify(errors)}`); assert.deepEqual(errors, []); await delay(100); }
  await Promise.all(runtimes.map(runtime => command(runtime, 'ui', { role: 'server', open: true })));
  for (const role of ['c1', 'c2']) await Promise.all(runtimes.map(runtime => command(runtime, 'ui', { role, open: true })));
  await Promise.all(runtimes.map(runtime => command(runtime, 'waitPeers')));
  await Promise.all(runtimes.map(runtime => command(runtime, 'select', { role: 'c1' })));
  const started = Date.now(); let lastSample = 0, lastReconnect = started;
  await snapshot('load-start', started);
  do {
    cycle++;
    await Promise.all(runtimes.map(async runtime => {
      const requests = [];
      for (const role of ['c1', 'c2', 'server']) for (let n = 0; n < burst; n++) {
        const sequence = ++counts[runtime][role]; requests.push({ endpointId: `duel-${role}`, bytes: packet(runtime, role, sequence), messageType: sequence % 2 ? 'binary' : 'text', framing: 'websocket', ...(role === 'server' ? { target: { type: 'broadcast' } } : {}) });
      }
      const answers = await command(runtime, 'batch', { requests });
      for (let n = 0; n < answers.length; n++) {
        assert.equal(runtime === 'tauri' ? answers[n].sent : answers[n].byteCount, runtime === 'tauri' && requests[n].target ? 256 : 128);
        if (requests[n].target) { assert.equal(answers[n].failureCount, 0); assert.equal(answers[n].successCount, 2); }
      }
    }));
    await delay(300);
    if (Date.now() - lastReconnect >= reconnectMs) {
      await delay(600); const runtime = runtimes[reconnects % 2];
      await command(runtime, 'ui', { role: 'server', open: false }); await delay(800);
      await command(runtime, 'ui', { role: 'server', open: true });
      await Promise.all(runtimes.map(name => command(name, 'waitPeers'))); reconnects++; lastReconnect = Date.now();
      for (const runtime of runtimes) invalidRejected += await command(runtime, 'invalid');
      await Promise.all(runtimes.map(runtime => command(runtime, 'theme', { theme: reconnects % 2 ? 'dark' : 'light' })));
    }
    if (Date.now() - lastSample >= 30000) { await snapshot('load', started); lastSample = Date.now(); }
  } while (Date.now() - started < durationMs);
  loadElapsedMs = Date.now() - started;
  await delay(1000); await snapshot('loaded', started);
  if (idleMs) { await delay(idleMs / 3); await snapshot('connected-idle', started); }
  await Promise.all(runtimes.map(runtime => command(runtime, 'clear')));
  await snapshot('view-cleared', started);
  if (idleMs) { await delay(idleMs / 3); await snapshot('clear-idle', started); }
  for (const role of ['c1', 'c2']) await Promise.all(runtimes.map(runtime => command(runtime, 'ui', { role, open: false })));
  await Promise.all(runtimes.map(runtime => command(runtime, 'ui', { role: 'server', open: false })));
  await snapshot('disconnected', started);
  if (idleMs) { await delay(idleMs / 3); await snapshot('disconnected-idle', started); }
  await page.screenshot({ path: path.join(out, 'electron-final.png') });
  const history = runtimes.map(verifyHistory);
  const order = streams => streams.flatMap(stream => stream.wireOrder).map(wire => JSON.stringify(wire)).sort();
  for (const runtime of runtimes) {
    const local = history.find(item => item.runtime === runtime), remote = history.find(item => item.runtime !== runtime);
    for (const role of ['c1', 'c2', 'server']) {
      const sent = local.streams.filter(stream => stream.key === `duel-${role}/out/${runtime}/${role}`);
      const received = remote.streams.filter(stream => stream.key.includes(`/in/${runtime}/${role}`));
      assert.deepEqual(order(sent), order(received), `${runtime}/${role}: persisted wire order differs from receiver`);
    }
  }
  assert.deepEqual(errors, []);
  for (const runtime of runtimes) await command(runtime, 'stop');
  result = { passed: true, loadElapsedMs, elapsedMs: Date.now() - started, idleMs, cycle, reconnects, invalidRejected, counts, history, snapshots: snapshots.length, paths, out };
} catch (error) {
  console.error(error.stack);
  const diagnostics = { errors, channels: Object.fromEntries(Object.entries(channels).map(([name, channel]) => [name, { ready: channel.ready, waiting: Boolean(channel.waiting), queued: channel.queue, pendingIds: [...channel.pending.keys()] }])) };
  for (const [name, helper] of [['windows', process.env.LINKLAB_DUEL_WINDOW_HELPER], ['resources', process.env.LINKLAB_DUEL_RESOURCE_HELPER]]) {
    if (helper) { try { diagnostics[name] = JSON.parse(execFileSync(helper, [], { encoding: 'utf8', timeout: 5000 })); } catch (reason) { diagnostics[name] = reason.message; } }
  }
  await writeFile(path.join(out, 'failure-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  result = { passed: false, error: error.stack, loadElapsedMs, cycle, reconnects, invalidRejected, counts, paths, out }; process.exitCode = 1;
}
finally {
  if (app) await app.close();
  if (tauri) { try { process.kill(-tauri.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
  keepAwake?.kill();
  for (const channel of Object.values(channels)) { channel.waiting?.end(JSON.stringify({ action: 'stop' })); for (const pending of channel.pending.values()) clearTimeout(pending.timer); }
  web.closeAllConnections(); await new Promise(resolve => web.close(resolve));
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
