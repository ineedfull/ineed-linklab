/* global window, document, MouseEvent */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';
import { createWebSocketFixture } from './server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const out = await mkdtemp(path.join(tmpdir(), 'linklab-websocket-tauri-desktop-'));
const fixture = await createWebSocketFixture();
const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const listenPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const clients = [];
const deliveries = [[], []];
let child;
let reportUrl;
let finish;
const completed = new Promise(resolve => { finish = resolve; });

// This script runs inside the actual WKWebView and uses only rendered DOM controls.
async function workload(config) {
  const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const wait = async (check, label) => {
    for (let n = 0; n < 250; n++) {
      if (await check()) return;
      await pause(100);
    }
    throw new Error(`${label} timed out: ${document.body.innerText}`);
  };
  const button = (scope, text) => [...scope.querySelectorAll('button')].find(el => el.textContent.trim() === text);
  const click = async (scope, text) => {
    await wait(() => button(scope, text) && !button(scope, text).disabled, text);
    button(scope, text).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await pause(100);
  };
  const input = async (name, value) => {
    const el = document.querySelector(`[name="${name}"]`);
    if (!el) throw new Error(`Missing input ${name}`);
    el.value = value;
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    await pause(100);
  };
  const rowFor = name => [...document.querySelectorAll('.endpoint-row')].find(el => el.querySelector('strong')?.textContent === name);
  const dialog = () => document.querySelector('[role="dialog"]');
  const observations = async () => (await fetch('/observations')).json();
  async function create(transport, name) {
    await wait(() => document.querySelector('[aria-label="添加端点"]'), 'endpoint entry');
    document.querySelector('[aria-label="添加端点"]').click();
    await wait(dialog, 'endpoint dialog');
    await input('endpoint-transport', transport);
    await input('endpoint-name', name);
    await input('websocket-subprotocols', 'linklab');
    if (transport === 'websocket-client') {
      await input('websocket-url', config.url);
      await input('websocket-header-name-0', 'Authorization');
      await input('websocket-header-value-0', 'Bearer desktop-only');
    } else {
      await input('websocket-listen-port', String(config.listenPort));
    }
    await click(dialog(), '保存端点');
    await wait(() => !dialog() && rowFor(name), 'saved endpoint');
    const row = rowFor(name);
    row.querySelector(`[aria-label="选择 ${name}"]`).click();
    await pause(100);
    row.querySelector('[aria-label="打开端点"]').click();
    const expected = transport === 'websocket-client' ? '已打开' : '监听中';
    await wait(() => document.querySelector('.session-state')?.textContent === expected, `${transport} open`);
    return row;
  }
  async function send(mode, text) {
    const radio = [...document.querySelectorAll('[role="radio"]')].find(el => el.textContent.trim() === mode);
    if (!radio) throw new Error(`Missing payload mode ${mode}`);
    radio.click();
    await pause(150);
    await wait(() => document.querySelector('[role="textbox"][aria-label="发送内容"]'), 'CodeMirror editor');
    const editor = document.querySelector('[role="textbox"][aria-label="发送内容"]');
    editor.focus();
    window.getSelection().selectAllChildren(editor);
    if (!document.execCommand('insertText', false, text)) throw new Error('WebView insertText failed');
    // Let CodeMirror observe the DOM edit before Vue derives wire bytes.
    await pause(200);
    await wait(() => button(document.querySelector('.send-panel__footer'), '发送') && !button(document.querySelector('.send-panel__footer'), '发送').disabled, 'send eligible');
    await click(document.querySelector('.send-panel__footer'), '发送');
  }
  const clientRow = await create('websocket-client', 'WS Tauri native client');
  await send('Text', 'native Tauri text');
  await wait(async () => (await observations()).received.length === 1, 'authenticated text echo');
  await wait(() => [...document.querySelectorAll('.frame-direction small')].filter(el => el.textContent === 'TXT').length >= 2, 'text TX/RX frames');
  await send('HEX', '00 FF 01');
  await wait(async () => (await observations()).received.length === 2, 'binary echo');
  await wait(() => [...document.querySelectorAll('.frame-direction small')].filter(el => el.textContent === 'BIN').length >= 2, 'binary TX/RX frames');
  clientRow.querySelector('[aria-label="端点操作"]').click();
  await pause(100);
  await click(clientRow, '编辑');
  await wait(() => document.querySelector('[name="websocket-header-value-0"]'), 'edit headers');
  if (document.querySelector('[name="websocket-header-value-0"]').value !== 'Bearer desktop-only') throw new Error('Session headers not retained');
  await click(dialog(), '取消');
  const serverRow = await create('websocket-server', 'WS Tauri native server');
  const peers = await fetch('/clients', { method: 'POST' });
  if (!peers.ok) throw new Error(`Fixture peer connection failed: ${await peers.text()}`);
  await wait(() => document.querySelectorAll('.endpoint-tree__peers[aria-label="WebSocket 服务端连接"] button').length === 2, 'two native peers');
  await send('Text', 'native Tauri broadcast');
  await wait(async () => (await observations()).deliveries.every(messages => messages.length === 1), 'two broadcast deliveries');
  serverRow.querySelector('[aria-label="关闭端点"]').click();
  await wait(() => serverRow.querySelector('[aria-label="打开端点"]'), 'server stopped');
  clientRow.querySelector('[aria-label="关闭端点"]').click();
  await wait(() => clientRow.querySelector('[aria-label="打开端点"]'), 'client closed');
  return { passed: true, checks: ['actual branded Tauri WKWebView', 'UI endpoint create', 'transient authorization + subprotocol handshake', 'text echo + TXT frames', 'binary echo + BIN frames', 'edit retains session headers', 'two native server peers', 'broadcast to both peers', 'UI closes listener and client'] };
}

const web = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      for await (const part of req) body += part;
      finish(JSON.parse(body)); res.end('ok'); return;
    }
    if (req.method === 'POST' && req.url === '/clients') {
      assert.equal(clients.length, 0, 'Peers must be created once');
      for (let index = 0; index < 2; index++) {
        const client = new WebSocket(`ws://127.0.0.1:${listenPort}/`, ['linklab']);
        clients.push(client);
        client.on('message', (bytes, binary) => deliveries[index].push({ bytes: [...bytes], messageType: binary ? 'binary' : 'text' }));
      }
      await Promise.all(clients.map(client => once(client, 'open')));
      res.end('ok'); return;
    }
    if (req.url === '/observations') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ received: fixture.received, deliveries })); return;
    }
    if (req.url === '/websocket-test.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(`(${workload.toString()})(${JSON.stringify({ url: fixture.url, listenPort })}).then(result=>fetch(${JSON.stringify(reportUrl)},{method:'POST',body:JSON.stringify(result)})).catch(error=>fetch(${JSON.stringify(reportUrl)},{method:'POST',body:JSON.stringify({passed:false,error:error.message+'; '+error.stack})}));`);
      return;
    }
    const relative = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
    if (relative.includes('..')) throw new Error('Invalid path');
    let bytes = await readFile(path.join(root, 'apps/tauri/dist', relative));
    if (relative === 'index.html') bytes = Buffer.from(bytes.toString().replace('</body>', '<script type="module" src="/websocket-test.js"></script></body>'));
    res.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(bytes);
  } catch (error) { res.statusCode = 500; res.end(error.message); }
});

try {
  web.listen(0, '127.0.0.1'); await once(web, 'listening');
  const url = `http://127.0.0.1:${web.address().port}`;
  reportUrl = `${url}/report`;
  const identifier = `com.ineedfull.linklab.websockettest${Date.now()}`;
  const dataPath = path.join(process.env.HOME, 'Library/Application Support', identifier);
  const override = path.join(out, 'tauri-config.json');
  await writeFile(override, JSON.stringify({ identifier, build: { beforeDevCommand: '', devUrl: url }, app: { security: { devCsp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${url}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'` } } }));
  await writeFile(path.join(out, 'isolation.json'), JSON.stringify({ identifier, dataPath, url, listenPort }));
  child = spawn(path.join(root, 'node_modules/.bin/tauri'), tauriDevArguments(['--no-watch', '--config', override]), { cwd: path.join(root, 'apps/tauri'), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', part => process.stdout.write(part));
  child.once('error', error => finish({ passed: false, error: error.message }));
  child.once('exit', code => finish({ passed: false, error: `Tauri exited before acceptance: ${code}` }));
  const timeout = setTimeout(() => finish({ passed: false, error: 'Tauri desktop acceptance deadline' }), 180000);
  let result;
  try { result = await completed; } finally { clearTimeout(timeout); }
  if (result.passed) {
    assert.deepEqual(fixture.received, [{ bytes: [...Buffer.from('native Tauri text')], messageType: 'text' }, { bytes: [0, 255, 1], messageType: 'binary' }]);
    assert.deepEqual(deliveries, Array.from({ length: 2 }, () => [{ bytes: [...Buffer.from('native Tauri broadcast')], messageType: 'text' }]));
    const db = new DatabaseSync(path.join(dataPath, 'ineed-dev-tool.db'), { readOnly: true });
    try {
      const endpoints = db.prepare('SELECT name, transport, config_json FROM endpoint_profiles ORDER BY name').all();
      assert.equal(endpoints.length, 2);
      const saved = JSON.stringify(endpoints);
      for (const forbidden of ['desktop-only', 'Authorization', 'websocketHeaders', 'headers']) assert.equal(saved.includes(forbidden), false, `Saved endpoints leaked ${forbidden}`);
      const frames = db.prepare('SELECT direction, format, framing, hex(payload) AS hex FROM transfer_frames').all();
      assert.ok(frames.filter(frame => frame.framing === 'websocket' && frame.format === 'text').length >= 4);
      assert.ok(frames.some(frame => frame.direction === 'in' && frame.format === 'hex' && frame.hex === '00FF01'));
      const sends = db.prepare('SELECT format, framing, hex(payload) AS hex FROM send_history').all();
      assert.equal(sends.length, 3);
      assert.ok(sends.some(send => send.framing === 'websocket' && send.format === 'hex' && send.hex === '00FF01'));
      const logs = JSON.stringify(db.prepare('SELECT message, details_json FROM runtime_logs').all());
      assert.equal(logs.includes('desktop-only'), false);
      result.persistence = { endpoints: endpoints.length, frames: frames.length, sendHistory: sends.length, headersExcluded: true, logsExcludeAuthorizationValue: true };
    } finally { db.close(); }
  }
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, out }));
  assert.equal(result.passed, true, result.error);
} finally {
  if (child) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
  for (const client of clients) client.terminate();
  await fixture.close();
  await new Promise(resolve => web.close(resolve));
}
