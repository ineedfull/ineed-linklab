/* global window, document, getComputedStyle, MouseEvent */
// Isolated native GUI acceptance: actual simulator bridge + independent Node SDK.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const ua = require('node-opcua');
const runtime = process.argv[2] ?? 'electron';
assert(['electron', 'tauri'].includes(runtime));
const out = await mkdtemp(path.join(tmpdir(), `linklab-opcua-server-${runtime}-`));
const ports = [];
for (let n = 0; n < 2; n++) {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  ports.push(listener.address().port); await new Promise(resolve => listener.close(resolve));
}
let child, app, server, finish;
const completed = new Promise(resolve => { finish = resolve; });
const checks = [];
async function sdkControl(request) {
  const client = ua.OPCUAClient.create({ securityMode: ua.MessageSecurityMode.None, securityPolicy: ua.SecurityPolicy.None, endpointMustExist: false, connectionStrategy: { maxRetry: 0 }, clientCertificateManager: new ua.OPCUACertificateManager({ rootFolder: path.join(out, 'sdk-pki'), automaticallyAcceptUnknownCertificate: true }) });
  let session;
  try {
    await client.connect(request.endpointUrl); session = await client.createSession();
    const row = await session.read({ nodeId: request.nodeId, attributeId: ua.AttributeIds.Value });
    assert.equal(row.statusCode.name, 'Good');
    if (request.action === 'read') { assert.equal(row.value.value, request.expected); return { passed: true }; }
    assert.equal(row.value.value, 23.5);
    const result = await session.browse('i=85');
    const folder = result.references.find(reference => reference.browseName.name === 'LinkLab'); assert(folder);
    const children = await session.browse(folder.nodeId);
    const nodeByName = name => { const node = children.references.find(reference => reference.displayName.text === name); assert(node, `Missing ${name}`); return node.nodeId; };
    const write = await session.write({ nodeId: request.nodeId, attributeId: ua.AttributeIds.Value, value: { value: { dataType: ua.DataType.Double, value: 44.5 } } });
    assert.equal(write.name, 'Good');
    const denied = await session.write({ nodeId: nodeByName('运行状态'), attributeId: ua.AttributeIds.Value, value: { value: { dataType: ua.DataType.Boolean, value: false } } });
    assert(denied.isNotGood());
    const subscription = await session.createSubscription2({ requestedPublishingInterval: 100, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10, publishingEnabled: true });
    try {
      const monitored = await subscription.monitor({ nodeId: nodeByName('计数器'), attributeId: ua.AttributeIds.Value }, { samplingInterval: 100, queueSize: 10, discardOldest: true }, ua.TimestampsToReturn.Both);
      await new Promise((resolve, reject) => {
        const seen = new Set(); const timer = setTimeout(() => reject(new Error('native counter subscription deadline')), 6000);
        monitored.on('changed', value => { seen.add(value.value.value); if (seen.size >= 2) { clearTimeout(timer); resolve(); } });
      });
    } finally { await subscription.terminate(); }
    checks.push('independent SDK browse/read/write/readonly/subscription'); return { passed: true };
  } finally { await session?.close(); await client.disconnect(); await client.clientCertificateManager.dispose(); }
}
async function workload(config) {
  const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const wait = async (fn, label) => { for (let n = 0; n < 300; n++) { const result = fn(); if (result) return result; await pause(100); } throw new Error(label + ': ' + document.body.innerText); };
  const visiblePanel = () => [...document.querySelectorAll('[aria-label="OPC UA 模拟服务端"]')].find(el => getComputedStyle(el).display !== 'none');
  const click = async (text, scope = document) => {
    const button = await wait(() => [...scope.querySelectorAll('button')].find(el => el.textContent.trim() === text && !el.matches(':disabled')), text);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true })); await pause(50);
  };
  const field = async (scope, name, value) => {
    const el = await wait(() => scope.querySelector(`[name="${name}"]`), name); el.value = value;
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await pause(50);
  };
  const control = request => globalThis.simControl ? globalThis.simControl(request) : fetch('/control', { method: 'POST', body: JSON.stringify(request) }).then(async response => { const result = await response.json(); if (!result.passed) throw new Error(result.error); return result; });
  async function add(name, port) {
    (await wait(() => document.querySelector('[aria-label="添加端点"]'), 'endpoint tree')).click();
    const dialog = await wait(() => document.querySelector('.endpoint-dialog'), 'dialog');
    await field(dialog, 'endpoint-transport', 'opcua-server'); await field(dialog, 'endpoint-name', name); await field(dialog, 'opcua-server-port', String(port));
    await click('保存端点', dialog); await wait(() => !document.querySelector('.endpoint-dialog'), 'saved');
    return wait(visiblePanel, 'simulator panel');
  }
  const first = await add('原生模拟 A', config.ports[0]);
  await click('启动', first); await wait(() => first.querySelector('.opcua-status')?.textContent === '正在监听', 'start');
  if (!first.querySelector('[name="node-id"]').matches(':disabled')) throw new Error('Running structure not locked');
  const actualId = [...first.querySelectorAll('label')].find(el => el.textContent.startsWith('实际 NodeId')).querySelector('code').textContent;
  const endpointUrl = `opc.tcp://127.0.0.1:${config.ports[0]}/LinkLab`;
  await control({ action: 'verify', endpointUrl, nodeId: actualId });
  await wait(() => [...first.querySelectorAll('td code')].some(el => el.textContent === '44.5'), 'remote write in actual UI');
  if (first.querySelector('[name="node-initial"]').value !== '23.5') throw new Error('Remote write overwrote initial value');
  await field(first, 'node-current', '52.5'); await click('更新当前值', first);
  await control({ action: 'read', endpointUrl, nodeId: actualId, expected: 52.5 });
  await wait(() => [...first.querySelectorAll('time')].some(el => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(el.textContent)), 'unified timestamps');
  const second = await add('原生模拟 B', config.ports[1]); await click('启动', second); await wait(() => second.querySelector('.opcua-status')?.textContent === '正在监听', 'second start');
  document.querySelector('[aria-label="选择 原生模拟 A"]').click(); await pause(100);
  if (first.querySelector('.opcua-status').textContent !== '正在监听') throw new Error('Navigation stopped first server');
  await click('停止', first); await wait(() => first.querySelector('.opcua-status')?.textContent === '已停止', 'stop first');
  document.querySelector('[aria-label="选择 原生模拟 B"]').click(); await pause(100);
  if (second.querySelector('.opcua-status').textContent !== '正在监听') throw new Error('Stopping first stopped second');
  await click('停止', second);
  document.querySelector('[aria-label="选择 原生模拟 A"]').click(); await pause(100);
  await click('保存初始配置', first); await wait(() => [...first.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('已保存')), 'save');
  await click('启动', first); await wait(() => first.querySelector('.opcua-status')?.textContent === '正在监听', 'restart');
  const restartId = [...first.querySelectorAll('label')].find(el => el.textContent.startsWith('实际 NodeId')).querySelector('code').textContent;
  await control({ action: 'read', endpointUrl, nodeId: restartId, expected: 23.5 });
  await click('停止', first);
  return { passed: true, runtime: config.runtime, checks: ['actual native visible UI', 'initial/current isolation', 'two independent instances', 'navigation retention', 'local update readback', 'timestamp display', 'save/restart initial value', 'stop'] };
}
try {
  if (runtime === 'electron') {
    const data = path.join(out, 'profile'); await mkdir(data);
    const bootstrap = path.join(out, 'main.cjs');
    await writeFile(bootstrap, `const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(data)});app.setPath('sessionData',${JSON.stringify(data)});require(${JSON.stringify(path.join(root, 'apps/electron/electron/main.cjs'))});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    app = await require('@playwright/test')._electron.launch({ executablePath: await prepareElectronExecutable(), args: [bootstrap], env, timeout: 30000 });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('simControl', sdkControl);
    const result = await page.evaluate(workload, { runtime, ports });
    await page.screenshot({ path: path.join(out, 'desktop.png') }); assert.deepEqual(errors, []);
    result.checks.push(...checks); await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, out }));
  } else {
    let reportUrl;
    server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'POST') {
          let body = ''; for await (const bytes of req) body += bytes;
          if (req.url === '/report') { finish(JSON.parse(body)); res.end('ok'); return; }
          if (req.url === '/control') { res.setHeader('content-type', 'application/json'); try { res.end(JSON.stringify(await sdkControl(JSON.parse(body)))); } catch (error) { res.end(JSON.stringify({ passed: false, error: error.message })); } return; }
        }
        if (req.url === '/simulator-test.js') {
          res.setHeader('content-type', 'application/javascript'); res.end(`(${workload.toString()})(${JSON.stringify({ runtime, ports })}).then(result=>fetch(${JSON.stringify(reportUrl)},{method:'POST',body:JSON.stringify(result)})).catch(error=>fetch(${JSON.stringify(reportUrl)},{method:'POST',body:JSON.stringify({passed:false,error:error.message+'; '+error.stack})}));`); return;
        }
        const relative = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1); if (relative.includes('..')) throw new Error('Invalid path');
        let bytes = await readFile(path.join(root, 'apps/tauri/dist', relative)); if (relative === 'index.html') bytes = Buffer.from(bytes.toString().replace('</body>', '<script type="module" src="/simulator-test.js"></script></body>'));
        res.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(bytes);
      } catch { res.statusCode = 404; res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}`; reportUrl = url + '/report';
    const identifier = 'com.ineedfull.linklab.simulatortest' + Date.now(), override = path.join(out, 'tauri-config.json');
    await writeFile(override, JSON.stringify({ identifier, build: { beforeDevCommand: '', devUrl: url }, app: { security: { devCsp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${url}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'` } } }));
    await writeFile(path.join(out, 'isolation.json'), JSON.stringify({ identifier, dataPath: path.join(process.env.HOME, 'Library/Application Support', identifier), url }));
    child = spawn(path.join(root, 'node_modules/.bin/tauri'), tauriDevArguments(['--no-watch', '--config', override]), { cwd: path.join(root, 'apps/tauri'), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => process.stdout.write(bytes));
    child.on('exit', code => finish({ passed: false, error: 'Tauri exited before acceptance: ' + code }));
    const timeout = setTimeout(() => finish({ passed: false, error: 'Tauri native GUI deadline' }), 240000);
    let result; try { result = await completed; } finally { clearTimeout(timeout); }
    result.checks?.push(...checks); await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, out })); assert.equal(result.passed, true, result.error);
  }
} finally {
  await app?.close();
  if (child) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
  if (server) await new Promise(resolve => server.close(resolve));
}
// Both native stop operations must release listening sockets, not just UI state.
for (const port of ports) {
  const listener = net.createServer(); listener.listen(port, '127.0.0.1'); await once(listener, 'listening'); await new Promise(resolve => listener.close(resolve));
}
console.log(JSON.stringify({ passed: true, releasedPorts: ports }));
