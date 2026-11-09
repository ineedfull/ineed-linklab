// Bounded localhost acceptance against the real native bridges; no desktop GUI or builds.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Client, Parser, Versions } from '@stomp/stompjs';
import { WebSocket } from 'ws';
import { createStompWorkbench } from '../../packages/workbench/src/model/stompWorkbench.js';
import { nativeBridge } from './native-bridge.mjs';

const out = process.env.LINKLAB_STOMP_ATTACK_OUT ?? path.join(tmpdir(), `linklab-stomp-attacks-${Date.now()}`);
await mkdir(out, { recursive: true });
const deadline = Date.now() + 110000;
const login = 'attack-test-user', passcode = 'transient-attack-passcode', wrongPasscode = 'rejected-transient-passcode';
const report = { startedAt: new Date().toISOString(), kind: 'real Electron Node and Tauri Rust native listeners with shared STOMP broker; independent @stomp/stompjs Client/Parser and ws inputs; localhost only; no GUI/build', settingsTested: false, checks: [], runtimes: [], cleanup: [], passed: true };
let sequence = 0;
async function until(check, label, timeout = 7000) {
  const stop = Math.min(deadline, Date.now() + timeout);
  while (!check()) { assert(Date.now() < stop, label); await delay(10); }
}
async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
const connectText = (extra = '') => `CONNECT\naccept-version:1.2\nhost:localhost\nlogin:${login}\npasscode:${passcode}\nheart-beat:0,0\n${extra}\n\0`;
function safeError(error) {
  let message = error.stack ?? String(error);
  for (const secret of [login, passcode, wrongPasscode]) message = message.replaceAll(secret, '[redacted]');
  return message;
}
function independentPeer(url, sockets) {
  const socket = new WebSocket(url, ['v12.stomp']); sockets.add(socket);
  const frames = []; const peer = { socket, frames, closed: false, closeCode: null, parseError: null };
  const parser = new Parser(frame => { if (frames.length < 30) frames.push(frame); }, () => {});
  socket.on('message', bytes => { try { parser.parseChunk(bytes); } catch (error) { peer.parseError = error.message; } });
  socket.on('error', () => {});
  socket.once('close', code => { peer.closed = true; peer.closeCode = code; sockets.delete(socket); });
  peer.open = once(socket, 'open');
  return peer;
}
function header(frame, name) { return frame.headers.find(([key]) => key === name)?.[1]; }
async function nativePortClosed(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}
async function runRuntime(runtimeName) {
  const bridge = nativeBridge(runtimeName); const server = createStompWorkbench(bridge); const sockets = new Set(); const rawSockets = new Set();
  let healthy; let listenPort;
  const evidence = { runtime: runtimeName, settingsBoundary: bridge.settingsEvidence, settingsTested: false, completed: false };
  report.runtimes.push(evidence);
  try {
    listenPort = await freePort(); server.state.mode = 'server';
    Object.assign(server.state.config, { listenHost: '127.0.0.1', listenPort, path: '/stomp', host: 'localhost', heartbeatIncoming: 1000, heartbeatOutgoing: 1000 });
    Object.assign(server.state.credentials, { login, passcode, requireAuthentication: true });
    assert.equal(await server.connect(), true); await until(() => server.state.status === 'listening', 'Native listener must start');
    evidence.listenAddress = `127.0.0.1:${listenPort}`;
    const url = `ws://127.0.0.1:${listenPort}/stomp`, topic = `/topic/adversarial-${globalThis.crypto.randomUUID()}`;
    const received = [], sdkErrors = [];
    healthy = new Client({ webSocketFactory: () => { const socket = new WebSocket(url, ['v12.stomp']); sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; },
      connectHeaders: { host: 'localhost', login, passcode }, stompVersions: new Versions([Versions.V1_2]), reconnectDelay: 0, connectionTimeout: 5000,
      heartbeatIncoming: 1000, heartbeatOutgoing: 1000, debug() {}, onStompError: frame => sdkErrors.push(frame.headers.message ?? 'ERROR') });
    healthy.activate(); await until(() => healthy.connected, 'Healthy independent SDK must connect');
    const subReceipt = globalThis.crypto.randomUUID(); let subscribed = false;
    healthy.watchForReceipt(subReceipt, () => { subscribed = true; }); healthy.subscribe(topic, message => received.push(message.body), { receipt: subReceipt, ack: 'auto' });
    await until(() => subscribed, 'Healthy independent SDK subscription receipt');
    async function healthyProof(label) {
      assert(healthy.connected, 'Hostile peer must not disconnect healthy SDK'); assert.equal(server.state.status, 'listening');
      const body = `${runtimeName}/${++sequence}/${label}/健康\0🙂`;
      healthy.publish({ destination: topic, body });
      await until(() => received.includes(body), `Healthy SDK receives fresh exact body after ${label}`);
      assert.equal(received.filter(value => value === body).length, 1); assert.deepEqual(sdkErrors, []);
      return { exactBody: body, healthyConnected: true, listenerListening: true };
    }
    async function scenario(name, callback) {
      const started = Date.now(); const row = { runtime: runtimeName, name, startedAt: new Date().toISOString() }; report.checks.push(row);
      try { Object.assign(row, await callback(), await healthyProof(name), { passed: true, elapsedMs: Date.now() - started }); }
      catch (error) { Object.assign(row, { passed: false, error: safeError(error), elapsedMs: Date.now() - started }); report.passed = false; }
      console.log(JSON.stringify({ runtime: runtimeName, name, passed: row.passed, elapsedMs: row.elapsedMs }));
    }
    async function rejected(name, attack, { authenticated = false, nativeOnly = false, timeout = 7000 } = {}) {
      return scenario(name, async () => {
        const peer = independentPeer(url, sockets); await peer.open;
        if (authenticated) { peer.socket.send(connectText()); await until(() => peer.frames.some(frame => frame.command === 'CONNECTED'), 'Attacker setup CONNECTED'); }
        const input = typeof attack === 'function' ? attack(topic) : attack;
        const inputBytes = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;
        if (name === 'nearly-max-send-message-expansion') assert(inputBytes <= 1048576, 'Expansion fixture must fit native input limit');
        peer.socket.send(input);
        await until(() => peer.closed, `${name} peer close deadline`, timeout);
        const errors = peer.frames.filter(frame => frame.command === 'ERROR');
        if (!nativeOnly) assert.equal(errors.length, 1, `${name} must receive ERROR before close`);
        assert.equal(peer.parseError, null, 'Independent SDK parser accepts server ERROR');
        const errorText = errors.map(frame => new TextDecoder().decode(frame.binaryBody) + JSON.stringify(frame.headers)).join('');
        for (const secret of [login, passcode, wrongPasscode]) assert.equal(errorText.includes(secret), false, 'Controlled ERROR must not echo credentials');
        return { boundary: nativeOnly ? 'native WebSocket payload limit' : 'shared STOMP broker over native WebSocket', inputBytes, errorFrames: errors.length, closeCode: peer.closeCode };
      });
    }
    await rejected('missing-authentication', 'CONNECT\naccept-version:1.2\nhost:localhost\nheart-beat:0,0\n\n\0');
    await rejected('wrong-authentication', `CONNECT\naccept-version:1.2\nhost:localhost\nlogin:${login}\npasscode:${wrongPasscode}\n\n\0`);
    await rejected('wrong-version', `CONNECT\naccept-version:1.1\nhost:localhost\nlogin:${login}\npasscode:${passcode}\n\n\0`);
    await rejected('wrong-virtual-host', `CONNECT\naccept-version:1.2\nhost:other\nlogin:${login}\npasscode:${passcode}\n\n\0`);
    await rejected('duplicate-authentication-first-invalid', `CONNECT\naccept-version:1.2\nhost:localhost\nlogin:invalid-first\nlogin:${login}\npasscode:${passcode}\n\n\0`);
    await rejected('unsupported-transaction', 'BEGIN\ntransaction:unsupported\n\n\0', { authenticated: true });
    await rejected('unsupported-wildcard', 'SUBSCRIBE\nid:wild\ndestination:/topic/*\n\n\0', { authenticated: true });
    await rejected('unknown-command', 'INVENTED\n\n\0', { authenticated: true });
    await rejected('unknown-acknowledgement', 'ACK\nid:missing\n\n\0', { authenticated: true });
    await rejected('invalid-header-escape', 'SEND\ndestination:/topic/input\nx-invalid:bad\\tvalue\n\n\0', { authenticated: true });
    await rejected('content-length-terminator-mismatch', 'SEND\ndestination:/topic/input\ncontent-length:1\n\nab\0', { authenticated: true });
    await rejected('negative-content-length', 'SEND\ndestination:/topic/input\ncontent-length:-1\n\nx\0', { authenticated: true });
    await rejected('invalid-utf8-body', Buffer.concat([Buffer.from('SEND\ndestination:/topic/input\n\n'), Buffer.from([255, 0])]), { authenticated: true });
    await rejected('oversized-stomp-declared-body', 'SEND\ndestination:/topic/input\ncontent-length:1048577\n\n', { authenticated: true });
    await rejected('oversized-websocket-message', Buffer.alloc(1048577, 65), { authenticated: true, nativeOnly: true });
    await rejected('nearly-max-send-message-expansion', 'SEND\ndestination:' + topic + '\ncontent-length:1048441\nreceipt:too-large\n\n' + 'x'.repeat(1048441) + '\0', { authenticated: true });
    await scenario('duplicate-destination-first-wins-and-receipt', async () => {
      const peer = independentPeer(url, sockets); await peer.open; peer.socket.send(connectText()); await until(() => peer.frames.some(frame => frame.command === 'CONNECTED'), 'Duplicate-header setup');
      const body = `${runtimeName}/duplicate-first/精确体`, size = Buffer.byteLength(body);
      peer.socket.send(`SEND\ndestination:${topic}\ndestination:/topic/ignored\nreceipt:duplicate-receipt\ncontent-length:${size}\n\n${body}\0`);
      await until(() => peer.frames.some(frame => frame.command === 'RECEIPT' && header(frame, 'receipt-id') === 'duplicate-receipt') && received.includes(body), 'First duplicate header is authoritative');
      assert.equal(peer.frames.some(frame => frame.command === 'ERROR'), false); peer.socket.send('DISCONNECT\nreceipt:done\n\n\0'); await until(() => peer.closed, 'Duplicate-header peer disconnect');
      return { firstHeaderAuthoritative: true, receipt: true, duplicateBody: body, closeCode: peer.closeCode };
    });
    await scenario('split-and-concatenated-frames-unicode-null', async () => {
      const peer = independentPeer(url, sockets); await peer.open; const bytes = Buffer.from(connectText());
      for (const slice of [bytes.subarray(0, 4), bytes.subarray(4, 20), bytes.subarray(20)]) peer.socket.send(slice);
      await until(() => peer.frames.some(frame => frame.command === 'CONNECTED'), 'Split CONNECT');
      const body = `${runtimeName}/split/汉\0🙂`, frame = Buffer.from(`SEND\ndestination:${topic}\nreceipt:split\ncontent-length:${Buffer.byteLength(body)}\n\n${body}\0`);
      const split = frame.indexOf(Buffer.from('汉')) + 1;
      peer.socket.send(frame.subarray(0, split)); peer.socket.send(Buffer.concat([frame.subarray(split), Buffer.from('DISCONNECT\nreceipt:finished\n\n\0')]));
      await until(() => peer.closed && received.includes(body), 'Split body and concatenated DISCONNECT');
      assert(peer.frames.some(value => value.command === 'RECEIPT' && header(value, 'receipt-id') === 'split'));
      assert(peer.frames.some(value => value.command === 'RECEIPT' && header(value, 'receipt-id') === 'finished'));
      return { unicodeNullBody: body, splitWithinUtf8Codepoint: true, concatenatedFrames: true, closeCode: peer.closeCode };
    });
    // Both independent native deadlines run in parallel, bounded to 18 seconds total.
    await Promise.all([
      rejected('partial-stomp-handshake-deadline', 'CONNECT\naccept-version:1.2\nhost:localhost\n', { timeout: 13000 }),
      scenario('partial-native-websocket-handshake-deadline', async () => {
        const socket = net.connect({ host: '127.0.0.1', port: listenPort }); rawSockets.add(socket); socket.on('error', () => {}); let closed = false;
        socket.once('close', () => { closed = true; rawSockets.delete(socket); }); await once(socket, 'connect'); socket.write('GET /stomp HTTP/1.1\r\nHost: localhost\r\n');
        await until(() => closed, 'Native partial HTTP handshake closes at 15s deadline', 18000); return { boundary: 'native WebSocket HTTP handshake', closed: true };
      }),
    ]);
    assert.equal(JSON.stringify(server.state.messages).includes(passcode), false); assert.equal(JSON.stringify(server.state.messages).includes(wrongPasscode), false);
    assert.equal(server.state.messages.length <= 500, true); assert.equal(server.state.peers.length <= 64, true);
    evidence.messageDisplayBounded = true; evidence.authenticationExcludedFromMessageHistory = true;
    if (runtimeName === 'electron') {
      const database = new DatabaseSync(bridge.settingsEvidence.databasePath, { readOnly: true });
      try { evidence.ephemeralDatabaseCounts = Object.fromEntries(['transfer_frames', 'runtime_logs', 'send_history'].map(table => [table, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)])); assert.deepEqual(Object.values(evidence.ephemeralDatabaseCounts), [0, 0, 0]); }
      finally { database.close(); }
    }
    evidence.completed = true;
  } catch (error) { evidence.error = safeError(error); report.passed = false; console.error(evidence.error); }
  finally {
    const cleanup = { runtime: runtimeName, startedAt: new Date().toISOString() }; report.cleanup.push(cleanup);
    try {
      await healthy?.deactivate({ force: true });
      for (const socket of sockets) socket.terminate(); for (const socket of rawSockets) socket.destroy();
      await until(() => sockets.size === 0 && rawSockets.size === 0, 'Owned attack and SDK sockets close', 3000);
      await server.dispose(); await bridge.shutdown();
      cleanup.socketCount = sockets.size; cleanup.partialTcpSocketCount = rawSockets.size; cleanup.modelDisconnected = server.state.status === 'disconnected'; cleanup.nativeShutdownCompleted = true;
      if (listenPort) { cleanup.listenerPortRefused = await nativePortClosed(listenPort); assert.equal(cleanup.listenerPortRefused, true, 'Native listener port must be closed'); }
      cleanup.passed = true;
    } catch (error) { cleanup.passed = false; cleanup.error = safeError(error); report.passed = false; }
  }
}
try { for (const runtimeName of ['electron', 'tauri']) await runRuntime(runtimeName); }
catch (error) { report.passed = false; report.error = safeError(error); }
report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
report.passed = report.passed && report.checks.length === 40 && report.checks.every(row => row.passed) && report.cleanup.every(row => row.passed);
await writeFile(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(out, 'checks.jsonl'), report.checks.map(row => JSON.stringify(row)).join('\n') + '\n');
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, elapsedMs: report.elapsedMs, out }));
if (!report.passed) process.exitCode = 1;
