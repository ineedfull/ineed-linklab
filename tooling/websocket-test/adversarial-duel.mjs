#!/usr/bin/env node
// Native service attack/soak. GUI long-run coverage is a separate entry/evidence set.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { normalizeTransportFrameBatch, normalizeTransportPeerEvent, normalizeTransportStatusEvent } from '../../packages/runtime-contract/src/index.js';

const require = createRequire(import.meta.url);
const { WebSocketService } = require('../../apps/electron/electron/websocketService.cjs');
const outputDirectory = process.env.LINKLAB_DUEL_OUT ?? path.join(tmpdir(), 'ineed-linklab-websocket-duel');
const pressureMs = Number(process.env.LINKLAB_NATIVE_PRESSURE_MS ?? 300_000);
assert(Number.isInteger(pressureMs) && pressureMs >= 0 && pressureMs <= 3_600_000);
await mkdir(outputDirectory, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const logPath = path.join(outputDirectory, `native-adversarial-${stamp}.jsonl`);
const reportPath = path.join(outputDirectory, `native-adversarial-${stamp}.json`);
const stderrPath = path.join(outputDirectory, `native-adversarial-${stamp}-rust-stderr.log`);
await writeFile(stderrPath, '');
const started = Date.now();
const result = { kind: 'real Electron WebSocketService and Rust websocket-harness; native protocol, no GUI', startedAt: new Date(started).toISOString(), pressureRequestedMs: pressureMs, stages: [], samples: [], failures: [] };
const log = async (type, details) => {
  const row = { elapsedMs: Date.now() - started, type, ...details };
  console.log(JSON.stringify(row));
  await appendFile(logPath, `${JSON.stringify(row)}\n`);
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { assert(Date.now() < deadline, `${label}: deadline`); await delay(10); }
}
async function availablePort() {
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); return port;
}
const normalizers = { status: normalizeTransportStatusEvent, frames: normalizeTransportFrameBatch, peers: normalizeTransportPeerEvent };
const pressureExpected = new Map();
const pressureIds = new Set();
let pressureActive = false;
let pressureReceived = 0;
let pressureSendOperations = 0;
const protocolFailures = [];
function observe(runtime, type, payload) {
  try { normalizers[type](payload); } catch (error) { protocolFailures.push(`${runtime.name} ${type}: ${error.message}`); }
  runtime.counts[type]++;
  if (type === 'peers') runtime.peerSnapshots.set(payload.endpointId, payload.peers);
  if (type === 'status') {
    runtime.statuses.set(payload.endpointId, payload);
    const serialized = JSON.stringify(payload);
    if (/duel-secret|opaque-duel-token/.test(serialized)) protocolFailures.push(`${runtime.name}: credential leaked into status`);
  }
  if (type === 'frames') {
    for (const frame of payload.frames) {
      const bytes = Buffer.from(frame.bytes);
      runtime.frameCount++;
      runtime.bytes += bytes.length;
      if (frame.direction === 'in' && pressureActive && pressureIds.has(payload.endpointId)) {
        const key = hash(bytes), pending = pressureExpected.get(key);
        if (!pending) protocolFailures.push(`${runtime.name}: unexpected/duplicate pressure receipt ${key}`);
        else { pending.count--; pressureReceived++; if (!pending.count) pressureExpected.delete(key); }
      }
      runtime.history.push({ number: runtime.frameCount, endpointId: payload.endpointId, operationId: payload.operationId, peerId: frame.peerId, direction: frame.direction, messageType: frame.messageType, byteCount: bytes.length, hash: hash(bytes), ...(bytes.length <= 128 ? { text: bytes.toString('utf8') } : {}) });
      if (runtime.history.length > 2000) runtime.history.shift();
    }
  }
}
const base = name => ({ name, counts: { status: 0, frames: 0, peers: 0 }, frameCount: 0, bytes: 0, history: [], statuses: new Map(), peerSnapshots: new Map() });
const electron = base('electron');
const service = new WebSocketService({ emitEvent: (channel, payload) => observe(electron, channel.slice('transport:'.length), payload), reportEventError: error => protocolFailures.push(`Electron event observer: ${error.message}`) });
Object.assign(electron, {
  open: (endpoint, operationId, websocketHeaders = []) => service.open(endpoint, { operationId, websocketHeaders }),
  send: request => service.send(request), close: endpointId => service.close(endpointId),
  cancel: (endpointId, operationId) => service.cancelOpen(endpointId, { operationId }),
  disconnect: (endpointId, peerId) => service.disconnectPeer(endpointId, peerId), shutdown: () => service.shutdown(),
});
const rust = base('tauri-native');
const child = spawn(fileURLToPath(new URL('../../apps/tauri/src-tauri/target/debug/websocket-harness', import.meta.url)), [], { stdio: ['pipe', 'pipe', 'pipe'] });
const childExit = once(child, 'exit');
child.stderr.on('data', data => { void appendFile(stderrPath, data); if (/panicked|fatal/i.test(String(data))) protocolFailures.push('Rust native process panic/fatal'); });
const pending = new Map(); let nextId = 0;
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { protocolFailures.push('Rust malformed NDJSON'); return; }
  if (message.event) { observe(rust, message.event.type, message.event.payload); return; }
  const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
  if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error)); else entry.resolve(message.result);
});
function call(method, extra = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native ${method} request deadline`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id, method, ...extra })}\n`);
  });
}
Object.assign(rust, {
  open: (endpoint, operationId, websocketHeaders = []) => call('open', { endpoint, operationId, websocketHeaders }),
  send: request => call('send', { ...request, bytes: [...request.bytes] }), close: endpointId => call('close', { endpointId }),
  cancel: (endpointId, operationId) => call('cancelOpen', { endpointId, operationId }),
  disconnect: (endpointId, peerId) => call('disconnectPeer', { endpointId, peerId }), shutdown: () => call('shutdown'),
});
function serverEndpoint(id, port) { return { id, transport: 'websocket-server', config: { listenHost: '127.0.0.1', listenPort: port, path: '/duel', subprotocols: ['duel'] } }; }
function clientEndpoint(id, port, query = '') { return { id, transport: 'websocket-client', config: { url: `ws://127.0.0.1:${port}/duel${query}`, subprotocols: ['duel'] } }; }
function framesSince(runtime, number, endpointId, direction = 'in') { return runtime.history.filter(frame => frame.number > number && frame.endpointId === endpointId && frame.direction === direction); }
async function peerCount(runtime, id, count) { await until(() => runtime.peerSnapshots.get(id)?.length === count, `${runtime.name} ${id} peers=${count}`); }
async function wsClient(port) { const client = new WebSocket(`ws://127.0.0.1:${port}/duel`, ['duel']); client.on('error', () => {}); await once(client, 'open'); return client; }
const rawSockets = new Set();
async function rawConnect(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port }); rawSockets.add(socket); socket.on('error', () => {});
  socket.once('close', () => rawSockets.delete(socket)); await once(socket, 'connect'); return socket;
}
function requestHeaders(port, overrides = {}) {
  return `GET ${overrides.path ?? '/duel'} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: ${overrides.version ?? 13}\r\nSec-WebSocket-Key: ${overrides.key ?? randomBytes(16).toString('base64')}\r\n${overrides.protocol === null ? '' : `Sec-WebSocket-Protocol: ${overrides.protocol ?? 'duel'}\r\n`}\r\n`;
}
async function upgrade(port, overrides = {}) {
  const socket = await rawConnect(port); let response = Buffer.alloc(0);
  const data = chunk => { if (response.length < 65536) response = Buffer.concat([response, chunk]).subarray(0, 65536); };
  socket.on('data', data); socket.write(requestHeaders(port, overrides));
  await until(() => response.includes('\r\n\r\n') || socket.destroyed, 'raw upgrade');
  socket.off('data', data);
  return { socket, response: response.toString('latin1') };
}
function rawFrame(opcode, payload, { fin = true, masked = true, declaredLength = payload.length, rsv = 0 } = {}) {
  let header;
  if (declaredLength < 126) header = Buffer.from([(fin ? 128 : 0) | rsv | opcode, (masked ? 128 : 0) | declaredLength]);
  else if (declaredLength <= 65535) { header = Buffer.alloc(4); header[0] = (fin ? 128 : 0) | rsv | opcode; header[1] = (masked ? 128 : 0) | 126; header.writeUInt16BE(declaredLength, 2); }
  else { header = Buffer.alloc(10); header[0] = (fin ? 128 : 0) | rsv | opcode; header[1] = (masked ? 128 : 0) | 127; header.writeBigUInt64BE(BigInt(declaredLength), 2); }
  if (!masked) return Buffer.concat([header, payload]);
  const mask = Buffer.from([0x71, 0x16, 0xa8, 0x33]), bytes = Buffer.from(payload);
  for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, bytes]);
}
async function closed(socket, label, maxMs = 2500) {
  const start = Date.now(); await until(() => socket.destroyed, label, maxMs); return Date.now() - start;
}
async function stage(name, run) {
  const start = Date.now(); await log('stage-start', { name });
  try {
    const details = await run();
    const item = { name, passed: true, durationMs: Date.now() - start, ...details }; result.stages.push(item); await log('stage-pass', item);
  } catch (error) {
    const item = { name, passed: false, durationMs: Date.now() - start, message: error.message, stack: error.stack };
    result.stages.push(item); result.failures.push(item); await log('stage-fail', item);
  }
}

async function malformedMatrix(runtime) {
  const endpointId = `attack-${runtime.name}`, port = await availablePort();
  await runtime.open(serverEndpoint(endpointId, port), `${endpointId}-open`);
  const healthy = await wsClient(port); await peerCount(runtime, endpointId, 1);
  const cases = [
    ['unmasked-text', () => rawFrame(1, Buffer.from('unmasked'), { masked: false })],
    ['invalid-utf8', () => rawFrame(1, Buffer.from([0xc3, 0x28]))],
    ['oversized-declared-message', () => rawFrame(2, Buffer.alloc(0), { declaredLength: 1048577 })],
    ['fragmented-control', () => rawFrame(9, Buffer.from('ping'), { fin: false })],
    ['oversized-control', () => rawFrame(9, Buffer.alloc(126))],
    ['reserved-opcode', () => rawFrame(3, Buffer.from('invalid'))],
    ['orphan-continuation', () => rawFrame(0, Buffer.from('orphan'))],
    ['invalid-close-payload', () => rawFrame(8, Buffer.from([0]))],
    ['unexpected-rsv1', () => rawFrame(1, Buffer.from('compressed?'), { rsv: 64 })],
    ['fragmented-cumulative-oversize', () => Buffer.concat([rawFrame(2, Buffer.alloc(600000), { fin: false }), rawFrame(0, Buffer.alloc(600000))])],
  ];
  const checks = [];
  try {
    for (const [name, bytes] of cases) {
      const { socket, response } = await upgrade(port); assert.match(response, /101 Switching Protocols/);
      await peerCount(runtime, endpointId, 2); const before = runtime.frameCount;
      socket.write(bytes()); const rejectionMs = await closed(socket, name); await peerCount(runtime, endpointId, 1);
      await delay(220); assert.equal(framesSince(runtime, before, endpointId).length, 0, `${runtime.name} ${name} entered history`);
      const incoming = once(healthy, 'message');
      const acknowledgement = await runtime.send({ endpointId, bytes: [65], messageType: 'text', target: { type: 'broadcast' } });
      assert.equal(acknowledgement.successCount, 1); assert.equal((await incoming)[0].toString(), 'A'); checks.push({ name, rejectionMs, healthySurvived: true });
    }
    const { socket, response } = await upgrade(port); assert.match(response, /101 Switching Protocols/); await peerCount(runtime, endpointId, 2);
    const before = runtime.frameCount;
    socket.write(Buffer.concat([rawFrame(1, Buffer.from([0xe4, 0xb8]), { fin: false }), rawFrame(9, Buffer.from('control')), rawFrame(0, Buffer.from([0xad]))]));
    await until(() => framesSince(runtime, before, endpointId).some(frame => frame.text === '中'), 'UTF8 spanning valid fragments');
    await delay(230); const accepted = framesSince(runtime, before, endpointId); assert.equal(accepted.length, 1); assert.equal(accepted[0].messageType, 'text');
    socket.destroy(); await peerCount(runtime, endpointId, 1); checks.push({ name: 'valid-UTF8-fragments-with-interleaved-Ping', oneBusinessMessage: true });
    const rejectedHandshakes = [
      { path: '/wrong' }, { protocol: 'other' }, { protocol: null }, { version: 12 },
      ...['invalid', '', 'YQ==', 'AAAAAAAAAAAAAAAAAAAAAAA=', 'dGhlIHNhbXBsZSBub25jZR==',
        'dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'dGhlIHNhbXBsZSBub25jZQ==, dGhlIHNhbXBsZSBub25jZQ=='].map(key => ({ key })),
    ];
    for (const overrides of rejectedHandshakes) {
      const { socket, response } = await upgrade(port, overrides); assert.doesNotMatch(response, /101 Switching Protocols/, `${runtime.name} must reject handshake ${JSON.stringify(overrides)}`); await closed(socket, 'invalid handshake');
    }
    checks.push({ name: 'path-protocol-missingProtocol-version-invalid-or-duplicate-key-handshake-rejections', count: rejectedHandshakes.length });
    return { runtime: runtime.name, checks };
  } finally { healthy.terminate(); await runtime.close(endpointId); }
}
async function capacityAndTrickle(runtime) {
  const id = `cap-${runtime.name}`, port = await availablePort(); await runtime.open(serverEndpoint(id, port), `${id}-open`);
  const healthy = await wsClient(port); await peerCount(runtime, id, 1);
  const sockets = await Promise.all(Array.from({ length: 66 }, () => rawConnect(port)));
  await delay(250); const active = sockets.filter(socket => !socket.destroyed); assert(active.length > 0 && active.length <= 63, `${runtime.name} pending cap ${active.length}`);
  const trickle = active[0]; trickle.write('GET /duel HTTP/1.1\r\nHost: localhost\r\nX-Trickle: ');
  const begin = Date.now(), timer = setInterval(() => { if (!trickle.destroyed) trickle.write('a'); }, 250);
  try {
    await closed(trickle, 'absolute trickle handshake deadline', 16000);
    assert(Date.now() - begin < 15750); await until(() => sockets.every(socket => socket.destroyed), 'all handshake slots reclaimed', 16000);
    const next = await wsClient(port); next.terminate(); await peerCount(runtime, id, 1);
    const incoming = once(healthy, 'message'); await runtime.send({ endpointId: id, bytes: [66], messageType: 'text', target: { type: 'broadcast' } }); await incoming;
    return { runtime: runtime.name, acceptedPendingWithOneHealthy: active.length, attemptedPending: sockets.length, trickleDeadlineMs: Date.now() - begin, healthySurvived: true };
  } finally { clearInterval(timer); sockets.forEach(socket => socket.destroy()); healthy.terminate(); await runtime.close(id); }
}
async function cancelCycles(runtime) {
  const sockets = new Set(), blackhole = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    // Drain the request without replying so FIN/close is observable after cancellation.
    socket.resume();
  });
  blackhole.listen(0, '127.0.0.1'); await once(blackhole, 'listening');
  const echo = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: () => 'duel' }); await once(echo, 'listening');
  echo.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
  const id = `cancel-${runtime.name}`, cancelTimes = [];
  try {
    for (let cycle = 0; cycle < 20; cycle++) {
      const operationId = `${id}-${cycle}`;
      const opening = runtime.open(clientEndpoint(id, blackhole.address().port, '?opaque-duel-token'), operationId, [{ name: 'Authorization', value: 'Bearer duel-secret' }]);
      const rejection = assert.rejects(opening, error => error.code === 'OPEN_CANCELLED');
      await until(() => runtime.statuses.get(id)?.operationId === operationId && runtime.statuses.get(id)?.status === 'opening', 'opening event');
      assert.equal((await runtime.cancel(id, 'stale-operation')).cancelled, false);
      const start = Date.now(); assert.equal((await runtime.cancel(id, operationId)).cancelled, true); await rejection; cancelTimes.push(Date.now() - start);
      await runtime.open(clientEndpoint(id, echo.address().port), `${operationId}-replacement`);
      assert.equal((await runtime.cancel(id, operationId)).cancelled, false);
      const before = runtime.frameCount; await runtime.send({ endpointId: id, bytes: [99, cycle], messageType: 'binary' });
      await until(() => framesSince(runtime, before, id).some(frame => frame.hash === hash(Buffer.from([99, cycle]))), 'replacement echo');
      assert(!framesSince(runtime, before, id).some(frame => frame.operationId !== `${operationId}-replacement`));
      await runtime.close(id);
    }
    await until(() => sockets.size === 0, 'pending sockets reclaimed');
    return { runtime: runtime.name, cycles: cancelTimes.length, maximumCancelMs: Math.max(...cancelTimes), pendingSocketsAfter: sockets.size };
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => blackhole.close(resolve)); for (const socket of echo.clients) socket.terminate(); await new Promise(resolve => echo.close(resolve)); await runtime.close(id); }
}
async function authenticationReasons(runtime) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: () => 'duel' }); await once(server, 'listening');
  server.on('connection', socket => setTimeout(() => socket.close(1008, 'Invalid token duel-secret opaque-duel-token'), 30));
  try {
    for (const [suffix, headers] of [['?opaque-duel-token', []], ['', [{ name: 'Authorization', value: 'Bearer duel-secret' }]]]) {
      const id = `auth-${runtime.name}-${headers.length}`; await runtime.open(clientEndpoint(id, server.address().port, suffix), id, headers);
      await until(() => runtime.statuses.get(id)?.status === 'closed', 'remote authenticated close');
      const event = runtime.statuses.get(id); assert.equal(event.log.details.closeCode, 1008); assert.match(event.log.details.closeReason, /redacted/); await runtime.close(id);
    }
    return { runtime: runtime.name, headerFragmentAndOpaqueQueryRedaction: true };
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
}
async function slowPeer(runtime) {
  const id = `slow-${runtime.name}`, port = await availablePort(); await runtime.open(serverEndpoint(id, port), `${id}-open`);
  const healthy = await wsClient(port), { socket: slow } = await upgrade(port); slow.pause(); await peerCount(runtime, id, 2);
  const peers = runtime.peerSnapshots.get(id), slowId = peers.find(peer => peer.remoteAddress.endsWith(`:${slow.localPort}`)).id;
  const payload = new Uint8Array(1048576).fill(7), begin = Date.now();
  const bursts = Promise.allSettled(Array.from({ length: 16 }, () => runtime.send({ endpointId: id, bytes: payload, messageType: 'binary', target: { type: 'peer', peerIds: [slowId] } })));
  try {
    const incoming = once(healthy, 'message'), healthyBegin = Date.now();
    const ack = await runtime.send({ endpointId: id, bytes: [72], messageType: 'text', target: { type: 'peer', peerIds: [peers.find(peer => peer.id !== slowId).id] } });
    assert.equal(ack.successCount, 1); await incoming; const healthyLatencyMs = Date.now() - healthyBegin; assert(healthyLatencyMs < 2000);
    const outcomes = await bursts;
    const failures = outcomes.filter(outcome => outcome.status === 'rejected' || outcome.value.failureCount > 0).length;
    assert(failures > 0, 'slow peer must reject bounded queue pressure');
    assert(Date.now() - begin < 12000); return { runtime: runtime.name, concurrent1MiBSends: outcomes.length, rejectedOrFailed: failures, totalMs: Date.now() - begin, healthyLatencyMs };
  } finally { slow.destroy(); healthy.terminate(); await runtime.close(id); }
}
async function rss(pid) {
  try { const { stdout } = await promisify(execFile)('ps', ['-o', 'rss=', '-p', String(pid)]); return Number(stdout.trim()) * 1024; } catch { return null; }
}
async function pressure() {
  const ePort = await availablePort(), rPort = await availablePort();
  const es = 'pressure-es', rs = 'pressure-rs'; pressureIds.add(es); pressureIds.add(rs);
  await electron.open(serverEndpoint(es, ePort), es); await rust.open(serverEndpoint(rs, rPort), rs);
  for (const id of ['pressure-rc1', 'pressure-rc2']) { pressureIds.add(id); await rust.open(clientEndpoint(id, ePort), `${id}-open`); }
  for (const id of ['pressure-ec1', 'pressure-ec2']) { pressureIds.add(id); await electron.open(clientEndpoint(id, rPort), `${id}-open`); }
  await peerCount(electron, es, 2); await peerCount(rust, rs, 2);
  const start = Date.now(); let sequence = 0, nextNative = 0, nextSample = 0, nextAttack = 0, nextChurn = 20000, churns = 0, attacks = 0;
  function payload(label, binary) { const data = Buffer.alloc(512, binary ? 0xa5 : 0x78); data.write(`${label}:${sequence}|`); return data; }
  function expect(data, count) { pressureExpected.set(hash(data), { count }); }
  async function send(runtime, endpointId, data, messageType, count, target) { expect(data, count); pressureSendOperations++; await runtime.send({ endpointId, bytes: [...data], messageType, ...(target ? { target } : {}) }); }
  pressureActive = true;
  try {
    while (Date.now() - start < pressureMs) {
      const elapsed = Date.now() - start, binary = sequence % 2 === 0, messageType = binary ? 'binary' : 'text';
      await Promise.all([
        send(electron, 'pressure-ec1', payload('ec1', binary), messageType, 1),
        send(electron, es, payload('es-broadcast', binary), messageType, 2, { type: 'broadcast' }),
      ]);
      if (elapsed >= nextNative) {
        await Promise.all([send(rust, 'pressure-rc1', payload('rc1', binary), messageType, 1), send(rust, rs, payload('rs-broadcast', binary), messageType, 2, { type: 'broadcast' })]);
        nextNative += 1000;
      }
      if (elapsed >= nextAttack) {
        for (const port of [ePort, rPort]) { const { socket, response } = await upgrade(port); assert.match(response, /101/); socket.write(rawFrame(1, Buffer.from('attack'), { masked: false })); await closed(socket, 'pressure malformed rejection'); attacks++; }
        nextAttack += 10000;
      }
      if (elapsed >= nextChurn) {
        await until(() => pressureExpected.size === 0, 'pressure drain before reopen');
        await electron.close('pressure-ec2'); await electron.open(clientEndpoint('pressure-ec2', rPort), `pressure-ec2-reopen-${churns}`);
        await rust.close('pressure-rc2'); await rust.open(clientEndpoint('pressure-rc2', ePort), `pressure-rc2-reopen-${churns}`);
        await peerCount(electron, es, 2); await peerCount(rust, rs, 2); churns += 2; nextChurn += 20000;
      }
      if (elapsed >= nextSample) {
        const sample = { elapsedPressureMs: elapsed, receivedMessages: pressureReceived, sendOperations: pressureSendOperations, pendingReceipts: [...pressureExpected.values()].reduce((n, value) => n + value.count, 0), electronServiceAndDriverRss: process.memoryUsage().rss, rustHarnessRss: await rss(child.pid), counters: { electron: { ...electron.counts }, rust: { ...rust.counts } } };
        result.samples.push(sample); await log('pressure-sample', sample); nextSample += 30000;
      }
      assert.equal(protocolFailures.length, 0, protocolFailures[0]);
      sequence++; await delay(25);
    }
    await until(() => pressureExpected.size === 0, 'all pressure receipts');
    return { durationMs: Date.now() - start, ticks: sequence, sendOperations: pressureSendOperations, receivedMessages: pressureReceived, malformedPeersRejected: attacks, clientReopens: churns, pendingReceipts: pressureExpected.size, malformedOrDuplicateEvents: protocolFailures.length, driverNote: 'Rust harness retains finished request JoinHandles; native send API calls limited to two per second to bound test-driver accumulation; high-rate inbound sockets remain in the same process.' };
  } finally {
    pressureActive = false;
    for (const id of ['pressure-ec1', 'pressure-ec2', es]) await electron.close(id);
    for (const id of ['pressure-rc1', 'pressure-rc2', rs]) await rust.close(id);
  }
}

try {
  await log('start', { rustPid: child.pid, nodePid: process.pid, pressureRequestedMs: pressureMs, nativeBinary: 'existing websocket-harness binary; this driver does not build or edit production code' });
  for (const runtime of [electron, rust]) {
    await stage(`${runtime.name}: malformed-frame/fragment/control/handshake matrix`, () => malformedMatrix(runtime));
    await stage(`${runtime.name}: 64-connection cap and absolute slow-handshake deadline`, () => capacityAndTrickle(runtime));
    await stage(`${runtime.name}: repeated pending cancel/reopen and stale operation`, () => cancelCycles(runtime));
    await stage(`${runtime.name}: authenticated and opaque-query close redaction`, () => authenticationReasons(runtime));
    await stage(`${runtime.name}: slow peer queue bounds and healthy isolation`, () => slowPeer(runtime));
  }
  await stage('same-process bidirectional native service pressure', pressure);
  assert.equal(protocolFailures.length, 0, protocolFailures.join('; '));
  await electron.shutdown(); await rust.shutdown(); await until(() => service.sessions.size === 0, 'Electron sessions cleaned');
  for (const [runtime, ids] of [[electron, ['attack-electron', 'cap-electron', 'slow-electron']], [rust, ['attack-tauri-native', 'cap-tauri-native', 'slow-tauri-native']]]) {
    for (const id of ids) await assert.rejects(runtime.send({ endpointId: id, bytes: [1], messageType: 'binary' }));
  }
  result.passed = result.failures.length === 0;
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  result.passed = false; result.failures.push({ message: error.message, stack: error.stack }); await log('failure', { message: error.message, stack: error.stack }); process.exitCode = 1;
} finally {
  for (const socket of rawSockets) socket.destroy();
  await electron.shutdown().catch(() => {}); await rust.shutdown().catch(() => {});
  child.stdin.end(); const shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 3000); await childExit; clearTimeout(shutdownTimer);
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Native harness stopped')); }
  result.finishedAt = new Date().toISOString(); result.durationMs = Date.now() - started; result.protocolFailures = protocolFailures;
  result.finalCounters = { electron: { ...electron.counts, frames: electron.frameCount, bytes: electron.bytes }, rust: { ...rust.counts, frames: rust.frameCount, bytes: rust.bytes } };
  result.paths = { log: logPath, report: reportPath, rustStderr: stderrPath };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`); await log('finished', { passed: result.passed, reportPath, durationMs: result.durationMs });
}
