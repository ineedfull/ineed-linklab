#!/usr/bin/env node
/* global window, document */
import assert from 'node:assert/strict';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const runtime = process.argv[2] ?? 'electron';
assert.ok(['electron', 'tauri'].includes(runtime));
const durationMs = Number(process.env.LINKLAB_SOAK_MS ?? 1_200_000);
const idleMs = Number(process.env.LINKLAB_SOAK_IDLE_MS ?? 0);
const burst = Number(process.env.LINKLAB_SOAK_BURST ?? 1);
const sendMode = process.env.LINKLAB_SOAK_SEND_MODE ?? 'concurrent';
assert.ok(['concurrent', 'sequential'].includes(sendMode));
assert.ok(Number.isFinite(durationMs) && durationMs > 0);
assert.ok(Number.isFinite(idleMs) && idleMs >= 0);
assert.ok(Number.isInteger(burst) && burst > 0 && burst <= 10);
const out = process.env.LINKLAB_SOAK_OUT ?? `/tmp/linklab-soak-20261012/${runtime}`;
await mkdir(out, { recursive: true });
const data = path.join(out, `profile-${Date.now()}`);
await mkdir(data, { recursive: true });
let app;
let tauri;
let peer;
let pty;
let web;
let report;
let peerBytes = 0;
let echoBytes = 0;
const errors = [];
const sockets = new Set();
const tcp = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.on('data', (bytes) => {
    // Deliberately split replies across stream writes.
    socket.write(bytes.subarray(0, 3));
    socket.write(bytes.subarray(3));
  });
});
tcp.listen(0, '127.0.0.1');
await once(tcp, 'listening');
const udp = dgram.createSocket('udp4');
udp.on('message', (bytes, remote) => udp.send(bytes, remote.port, remote.address));
udp.bind(0, '127.0.0.1');
await once(udp, 'listening');
const reserve = net.createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const modbusPort = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));

function profilesFor(config) {
  return [
    { id: 'soak-tcp', name: 'Soak TCP', transport: 'tcp-client', config: { host: '127.0.0.1', port: config.tcpPort, receiveFraming: { mode: 'fixed', length: 16 } } },
    { id: 'soak-udp', name: 'Soak UDP', transport: 'udp-client', config: { bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: config.udpPort } },
    { id: 'soak-pty', name: 'Soak PTY', transport: 'serial', config: { path: config.ptyPath, baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', receiveFraming: { mode: 'fixed', length: 16 } } },
    { id: 'soak-slave', name: 'Soak Modbus Slave', transport: 'modbus-tcp-slave', config: { listenHost: '127.0.0.1', listenPort: config.modbusPort, unitId: 1, dataAreas: { holdingRegisters: { start: 0, count: 100 } } } },
    { id: 'soak-master', name: 'Soak Modbus Master', transport: 'modbus-tcp-master', config: { host: '127.0.0.1', port: config.modbusPort, unitId: 1, timeoutMs: 2000 } },
  ];
}

// This function is serialized into the real desktop renderer for both runtimes.
async function workload(config) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const names = {
    'endpoint.save': 'endpoint_save', 'endpoint.list': 'endpoint_list',
    'transport.open': 'transport_open', 'transport.close': 'transport_close',
    'transport.send': 'transport_send', 'transport.cancelOpen': 'transport_cancel_open',
    'modbus.execute': 'modbus_execute', 'history.queryFrames': 'history_query_frames',
    'storage.stats': 'storage_stats', 'storage.clearHistory': 'storage_clear_history',
    'settings.save': 'settings_save',
  };
  const call = async (method, args = []) => {
    let response;
    if (config.runtime === 'electron') {
      const [group, name] = method.split('.');
      response = await window.ineedLinkLab[group][name](...args);
    } else response = await window.__TAURI_INTERNALS__.invoke(names[method], { args });
    check(response?.ok, `${method}: ${JSON.stringify(response)}`);
    return response.value;
  };
  const rendererErrors = [];
  window.addEventListener('error', event => rendererErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => rendererErrors.push(String(event.reason)));
  const profiles = config.profiles;
  for (const profile of profiles) await call('endpoint.save', [profile]);
  let opens = 0;
  const uiAction = async (id, opening) => {
    const name = profiles.find(profile => profile.id === id).name;
    const deadline = Date.now() + 15_000;
    let row;
    do { row = [...document.querySelectorAll('.endpoint-row')].find(row => row.querySelector(`[aria-label="选择 ${name}"]`)); if (row) break; await wait(40); } while (Date.now() < deadline);
    check(row, 'Endpoint UI row missing: ' + name);
    const before = opening ? '打开端点' : '关闭端点';
    const after = opening ? '关闭端点' : '打开端点';
    row.querySelector(`[aria-label="${before}"]`).click();
    while (!row.querySelector(`[aria-label="${after}"]`)) { check(Date.now() < deadline, 'Endpoint UI transition timed out: ' + name); await wait(40); }
  };
  const open = async (id) => { opens++; if (config.ui) await uiAction(id, true); else await call('transport.open', [id, { operationId: `soak-open-${opens}` }]); };
  const close = async (id) => { if (config.ui) await uiAction(id, false); else await call('transport.close', [id]); };
  for (const profile of profiles) await open(profile.id);
  if (config.ui) document.querySelector('[aria-label="选择 Soak TCP"]').click();
  const sent = { 'soak-tcp': 0, 'soak-udp': 0, 'soak-pty': 0 };
  const started = Date.now();
  const pageIdentity = { started: window.performance.timeOrigin, url: window.location.href };
  const publish = async (snapshot) => {
    snapshot.pageIdentity = pageIdentity;
    snapshot.visibility = document.visibilityState;
    snapshots.push(snapshot);
    if (config.reportUrl) await fetch(config.reportUrl, { method: 'POST', body: JSON.stringify(snapshot) });
    else window.__linklabSoakProgress = snapshot;
  };
  const assetDiagnostics = await Promise.all([...document.images].map(async img => {
    await Promise.race([img.decode().catch(() => {}), wait(1000)]);
    return { src: img.src, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  }));
  check(assetDiagnostics.every(img => img.naturalWidth > 0), 'Desktop image failed: ' + JSON.stringify(assetDiagnostics));
  let cycle = 0;
  let invalidRejected = 0;
  let lastReport = 0;
  let modbusTransactions = 0;
  const snapshots = [];
  do {
    cycle++;
    const sends = [];
    for (const [id, count] of [['soak-tcp', 100], ['soak-udp', 20], ['soak-pty', 20]]) {
      for (let n = 0; n < count * config.burst; n++) {
        const seq = ++sent[id];
        const bytes = [...String(seq).padStart(16, '0')].map(char => char.charCodeAt(0));
        if (config.sendMode === 'sequential') await call('transport.send', [{ endpointId: id, bytes }]);
        else sends.push(call('transport.send', [{ endpointId: id, bytes }]));
      }
    }
    await Promise.all(sends);
    const values = [cycle % 65536, (cycle + 321) % 65536];
    const write = await call('modbus.execute', [{ endpointId: 'soak-master', functionCode: 16, unitId: 1, address: 2, quantity: 2, values }]);
    const read = await call('modbus.execute', [{ endpointId: 'soak-master', functionCode: 3, unitId: 1, address: 2, quantity: 2, values: [] }]);
    check(write.success && read.success && JSON.stringify(read.values) === JSON.stringify(values), 'Modbus write/read mismatch');
    modbusTransactions += 2;
    await wait(220);
    const counts = {};
    for (const id of Object.keys(sent)) {
      const query = { endpointId: id, direction: 'in', page: 1, pageSize: 200 };
      let result;
      const deadline = Date.now() + 15_000;
      do { result = await call('history.queryFrames', [query]); if (result.total >= sent[id]) break; await wait(40); } while (Date.now() < deadline);
      check(result.total === sent[id], `${id}: incoming ${result.total} != sent ${sent[id]}`);
      check(result.rows.every((row) => row.byteCount === 16), `${id}: invalid frame length`);
      counts[id] = result.total;
    }
    if (cycle % (config.ui ? 5 : 20) === 0) {
      for (const id of Object.keys(sent)) { await close(id); await open(id); }
      await close('soak-master'); await open('soak-master');
      await call('settings.save', ['theme', cycle % 40 === 0 ? 'light' : 'dark']);
      // Invalid byte arrays must reject before writing to the native stream.
      let rejected = false;
      try { await call('transport.send', [{ endpointId: 'soak-tcp', bytes: [256, -1, 'bad'] }]); } catch { rejected = true; }
      check(rejected, 'Invalid wire bytes accepted');
      invalidRejected++;
    }
    if (config.ui) check(document.querySelectorAll('.frame-list__item').length > 0, 'Native workbench did not render incoming/outgoing frames');
    if (Date.now() - lastReport >= 60_000) {
      const snapshot = { type: 'heartbeat', assetDiagnostics, ui: config.ui, renderedRows: document.querySelectorAll('.frame-list__item').length, runtime: config.runtime, elapsedMs: Date.now() - started, cycle, sent: { ...sent }, counts, opens, invalidRejected, modbusTransactions, stats: await call('storage.stats') };
      lastReport = Date.now();
      await publish(snapshot);
    }
  } while (Date.now() - started < config.durationMs);
  const loadElapsedMs = Date.now() - started;
  const stage = async (name) => publish({ type: 'recovery', stage: name, visibility: document.visibilityState, at: Date.now(), elapsedMs: Date.now() - started, sent: { ...sent }, renderedRows: document.querySelectorAll('.frame-list__item').length, stats: await call('storage.stats') });
  if (config.idleMs > 0) {
    await stage('loaded');
    await wait(config.idleMs / 3);
    await stage('connected-idle');
    if (config.ui) {
      const clear = document.querySelector('[aria-label="清空实时视图"]');
      check(clear, 'Clear live view button missing');
      clear.click(); await wait(100);
      check(document.querySelectorAll('.frame-list__item').length === 0, 'Live view did not clear');
    }
    await stage('view-cleared');
    await wait(config.idleMs / 3);
    await stage('clear-idle');
  }
  for (const profile of [...profiles].reverse()) await close(profile.id);
  if (config.idleMs > 0) {
    await stage('disconnected');
    await wait(config.idleMs / 3);
    await stage('disconnected-idle');
  }
  const stats = await call('storage.stats');
  check(rendererErrors.length === 0, 'Renderer errors: ' + JSON.stringify(rendererErrors));
  const result = { success: true, rendererErrors, payloadFormat: 'ascii-sequence-v1', loadElapsedMs, idleMs: config.idleMs, burst: config.burst, sendMode: config.sendMode, pageIdentity, assetDiagnostics, ui: config.ui, renderedRows: document.querySelectorAll('.frame-list__item').length, runtime: config.runtime, elapsedMs: Date.now() - started, cycle, sent, opens, invalidRejected, modbusTransactions, stats, snapshots };
  if (config.reportUrl) { await fetch(config.reportUrl, { method: 'POST', body: JSON.stringify({ type: 'complete', ...result }) }); await window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }); }
  return result;
}

try {
  pty = spawn('socat', ['-d', '-d', `pty,raw,echo=0,link=${out}/service`, `pty,raw,echo=0,link=${out}/peer`]);
  pty.stderr.resume();
  for (let n = 0; n < 100; n++) { try { await realpath(`${out}/service`); break; } catch { await delay(20); } }
  const { SerialPort } = require('serialport');
  peer = new SerialPort({ path: await realpath(`${out}/peer`), baudRate: 115200 });
  await once(peer, 'open');
  peer.on('data', (bytes) => { peerBytes += bytes.length; peer.write(bytes, () => { echoBytes += bytes.length; }); });
  const diagnostic = setInterval(() => console.log(JSON.stringify({ type: 'peer-diagnostics', peerBytes, echoBytes })), 5000);
  diagnostic.unref();
  const config = { runtime, durationMs, idleMs, burst, sendMode, ui: process.env.LINKLAB_SOAK_UI === '1', tcpPort: tcp.address().port, udpPort: udp.address().port, ptyPath: await realpath(`${out}/service`), modbusPort };
  config.profiles = profilesFor(config);
  const seed = (directory) => { const db = require(root + '/apps/electron/electron/database.cjs').openConfigurationDatabase(path.join(directory, 'ineed-dev-tool.db')); for (const profile of config.profiles) db.saveEndpoint(profile); db.close(); };
  if (runtime === 'electron') {
    if (config.ui) seed(data);
    const bootstrap = path.join(out, 'main.cjs');
    await writeFile(bootstrap, `const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(data)});app.setPath('sessionData',${JSON.stringify(data)});require(${JSON.stringify(root + '/apps/electron/electron/main.cjs')});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    app = await require('@playwright/test')._electron.launch({ executablePath: await prepareElectronExecutable(), args: [bootstrap], env, timeout: 30000 });
    app.process().stderr.on('data', chunk => process.stdout.write(chunk));
    await writeFile(path.join(out, 'host.json'), JSON.stringify({ runtime, pid: app.process().pid, data }, null, 2));
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    const heartbeat = setInterval(async () => {
      try { const value = { time: new Date().toISOString(), progress: await page.evaluate(() => window.__linklabSoakProgress), processes: await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, memory: m.memory }))) };
        await writeFile(path.join(out, 'progress.json'), JSON.stringify(value.progress));
        console.log(JSON.stringify(value)); } catch { /* teardown */ }
    }, 60_000);
    try { report = await page.evaluate(workload, config); await page.screenshot({ path: path.join(out, 'final.png') }); } finally { clearInterval(heartbeat); }
  } else {
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    web = http.createServer(async (req, res) => {
      try {
        if (req.method === 'POST') {
          let body = ''; for await (const chunk of req) body += chunk;
          const value = JSON.parse(body);
          console.log(body);
          await writeFile(path.join(out, 'progress.json'), body);
          if (value.type === 'complete' || value.type === 'error') finish(value);
          res.end('ok'); return;
        }
        if (req.url === '/soak.js') {
          res.setHeader('content-type', 'application/javascript');
          res.end(`(${workload.toString()})(${JSON.stringify(config)}).catch(async error => fetch(${JSON.stringify(config.reportUrl)}, {method:'POST',body:JSON.stringify({type:'error',error:error.message + '; ' + error.stack})}));`); return;
        }
        const relative = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
        assert.ok(!relative.includes('..'));
        let content = await readFile(path.join(root, 'apps/tauri/dist', relative));
        if (relative === 'index.html') content = Buffer.from(content.toString().replace('</body>', '<script type="module" src="/soak.js"></script></body>'));
        res.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : relative.endsWith('.png') ? 'image/png' : 'text/html');
        res.end(content);
      } catch { res.statusCode = 404; res.end('not found'); }
    });
    web.listen(0, '127.0.0.1'); await once(web, 'listening');
    const webUrl = `http://127.0.0.1:${web.address().port}`;
    config.reportUrl = `${webUrl}/report`;
    const identifier = `com.ineedfull.linklab.soak${Date.now()}`;
    const tauriData = path.join(process.env.HOME, 'Library/Application Support', identifier);
    if (config.ui) { await mkdir(tauriData, { recursive: true }); seed(tauriData); }
    const override = path.join(out, 'tauri-config.json');
    const productionConfig = JSON.parse(await readFile(path.join(root, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8'));
    const windows = productionConfig.app.windows.map(window => ({ ...window,
      ...(window.label === 'main' && process.env.LINKLAB_SOAK_HIDDEN === '1' ? { visible: false } : {}),
    }));
    await writeFile(override, JSON.stringify({ identifier, build: { beforeDevCommand: '', devUrl: webUrl }, app: { windows, security: { capabilities: ['default', 'history', { identifier: 'soak-window-close', windows: ['main'], permissions: ['core:window:allow-close'] }], devCsp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${webUrl}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'` } } }));
    await writeFile(path.join(out, 'isolation.json'), JSON.stringify({ identifier, dataPath: path.join(process.env.HOME, 'Library/Application Support', identifier), webUrl }, null, 2));
    tauri = spawn(path.join(root, 'node_modules/.bin/tauri'), tauriDevArguments(['--no-watch', '--config', override]), { cwd: path.join(root, 'apps/tauri'), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    for (const stream of [tauri.stdout, tauri.stderr]) stream.on('data', (chunk) => process.stdout.write(chunk));
    const metrics = setInterval(() => {
      try { console.log(`TAURI_PROCESS_METRICS=${execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,etime=,comm='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes('ineed-linklab-tauri')).join(' | ')}`); } catch { /* teardown */ }
    }, 60_000);
    const timeout = setTimeout(() => finish({ success: false, error: 'No completion report before deadline' }), durationMs + idleMs + 300_000);
    try { report = await completed; } finally { clearTimeout(timeout); clearInterval(metrics); }
    assert.equal(report.success, true, JSON.stringify(report));
  }
  assert.deepEqual(errors, []);
} catch (error) {
  report = { success: false, runtime, error: error.stack };
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  if (tauri) { await Promise.race([once(tauri, 'exit'), delay(3000)]); try { process.kill(-tauri.pid, 'SIGTERM'); } catch { /* already exited */ } }
  if (peer?.isOpen) await new Promise((resolve) => peer.close(resolve));
  if (pty) { pty.kill('SIGTERM'); await Promise.race([once(pty, 'exit'), delay(3000)]); }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => tcp.close(resolve));
  await new Promise((resolve) => udp.close(resolve));
  if (web) await new Promise((resolve) => web.close(resolve));
  await writeFile(path.join(out, 'summary.json'), JSON.stringify({ ...report, peerBytes, echoBytes, errors, data, recordedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(report));
}
