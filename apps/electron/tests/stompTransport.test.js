import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
let StompTransport;
try { ({ StompTransport } = require('../electron/stompTransport.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 300; n++) { if (check()) return; await pause(10); } assert.fail('STOMP transport deadline'); }
function fixture(t) { assert.equal(typeof StompTransport, 'function', 'ephemeral STOMP transport must exist'); const events = []; const service = new StompTransport({ emitEvent: e => events.push(e) }); t.after(() => service.shutdown()); return { service, events }; }
const id = () => randomUUID();
test('ephemeral STOMP transport exposes only inbound bytes and identities on real client/server loopback', async t => {
  const { service, events } = fixture(t); const serverId = id(); const clientId = id();
  const server = await service.execute({ action: 'open', connectionId: serverId, mode: 'server', config: { listenHost: '127.0.0.1', listenPort: 0, path: '/stomp' } });
  const port = events.find(e => e.type === 'status' && e.payload.status === 'listening').payload.log.details.port;
  const client = await service.execute({ action: 'open', connectionId: clientId, mode: 'client', config: { url: `ws://127.0.0.1:${port}/stomp` } });
  const bytes = [...Buffer.from('SEND\ndestination:/topic/test\n\nhello\0')];
  await service.execute({ action: 'send', connectionId: clientId, bytes, messageType: 'text' });
  await until(() => events.some(e => e.type === 'frames'));
  const frame = events.find(e => e.type === 'frames').payload;
  assert.equal(frame.endpointId, serverId); assert.equal(frame.sessionId, server.sessionId); assert(frame.operationId); assert.deepEqual(frame.frames[0].bytes, bytes);
  assert(events.filter(e => e.type === 'frames').every(e => e.payload.frames.every(f => f.direction === 'in')));
  const peerId = frame.frames[0].peerId;
  await service.execute({ action: 'send', connectionId: serverId, peerId, bytes: [65], messageType: 'text' });
  await until(() => events.some(e => e.type === 'frames' && e.payload.sessionId === client.sessionId));
  await service.execute({ action: 'disconnectPeer', connectionId: serverId, peerId });
  await until(() => events.some(e => e.type === 'peers' && e.payload.peers.length === 0));
  await service.execute({ action: 'close', connectionId: serverId });
});
test('temporary handshake auth is delivered but outgoing CONNECT and remote close reasons never become events', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(() => { for (const s of server.clients) s.terminate(); server.close(); });
  let auth; let received;
  server.on('connection', (socket, request) => { auth = request.headers.authorization; socket.on('message', bytes => { received = bytes.toString(); socket.close(1000, 'password private-stomp-secret'); }); });
  const { service, events } = fixture(t); const connectionId = id();
  await service.execute({ action: 'open', connectionId, mode: 'client', config: { url: `ws://127.0.0.1:${server.address().port}` }, headers: [{ name: 'Authorization', value: 'Bearer private-header-secret' }] });
  await service.execute({ action: 'send', connectionId, bytes: [...Buffer.from('CONNECT\npasscode:private-stomp-secret\n\n\0')], messageType: 'text' });
  await until(() => events.some(e => e.payload.status === 'closed'));
  assert.equal(auth, 'Bearer private-header-secret'); assert.match(received, /private-stomp-secret/);
  assert(!JSON.stringify(events).includes('private-')); assert(!events.some(e => e.type === 'frames'));
});
test('close cancels opening and allows same connection identity to reopen without late resurrection', async t => {
  const sockets = new Set(); const blackhole = net.createServer(s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  blackhole.listen(0, '127.0.0.1'); await once(blackhole, 'listening'); t.after(() => { for (const s of sockets) s.destroy(); blackhole.close(); });
  const { service, events } = fixture(t); const connectionId = id();
  const opening = service.execute({ action: 'open', connectionId, mode: 'client', config: { url: `ws://127.0.0.1:${blackhole.address().port}` } });
  const rejected = assert.rejects(opening, e => e.code === 'OPEN_CANCELLED');
  await until(() => sockets.size === 1); await service.execute({ action: 'close', connectionId });
  const fresh = await service.execute({ action: 'open', connectionId, mode: 'server', config: { listenHost: '127.0.0.1', listenPort: 0 } });
  await rejected; await pause(30);
  assert.equal(events.filter(e => e.payload.status === 'listening').at(-1).payload.sessionId, fresh.sessionId);
  assert(!events.some(e => e.payload.status === 'open'));
});
test('STOMP bridge enforces four sessions, request shape, safe URL and single peer sends', async t => {
  const { service } = fixture(t);
  for (const request of [{}, { action: 'invalid', connectionId: id() }, { action: 'open', connectionId: 'x', mode: 'server', config: {} }, { action: 'open', connectionId: id(), mode: 'other', config: {} }, ...['?secret=value', '#fragment', ''].map(suffix => ({ action: 'open', connectionId: id(), mode: 'client', config: { url: suffix ? `ws://localhost/${suffix}` : 'ws://user:password@localhost/' } })), { action: 'open', connectionId: id(), mode: 'server', config: { listenPort: 0, login: 'secret' } }]) await assert.rejects(service.execute(request));
  const ids = Array.from({ length: 4 }, id);
  for (const connectionId of ids) await service.execute({ action: 'open', connectionId, mode: 'server', config: { listenPort: 0 } });
  await assert.rejects(service.execute({ action: 'open', connectionId: id(), mode: 'server', config: { listenPort: 0 } }), /limit|four|4/i);
  await assert.rejects(service.execute({ action: 'send', connectionId: ids[0], bytes: [65], messageType: 'text' }), /peer/i);
  await service.execute({ action: 'close', connectionId: ids[0] });
  await service.execute({ action: 'open', connectionId: id(), mode: 'server', config: { listenPort: 0 } });
  await service.shutdown(); await assert.rejects(service.execute({ action: 'open', connectionId: id(), mode: 'server', config: { listenPort: 0 } }));
});

test('both adapters expose the STOMP namespace, safe fallback, wire invoke and event unsubscribe', async () => {
  const { createElectronRuntimeAdapter } = await import('../renderer/runtimeAdapter.js');
  const { createTauriRuntimeAdapter } = await import('../../tauri/renderer/runtimeAdapter.js');
  const fallback = createElectronRuntimeAdapter({ runtimeName: 'preview' });
  assert.equal(typeof fallback.stomp?.execute, 'function');
  await assert.rejects(fallback.stomp.execute({}), e => e.method === 'stomp.execute');
  let removed = false; let received; let electronListener;
  const electron = createElectronRuntimeAdapter({ runtimeName: 'electron', stomp: { execute: async request => ({ ok: true, value: request }), onEvent: fn => { electronListener = fn; return () => { removed = true; }; } } });
  assert.deepEqual(await electron.stomp.execute({ action: 'close' }), { action: 'close' });
  const stop = electron.stomp.onEvent(event => { received = event; });
  electronListener({ type: 'peers', payload: { peers: [] } }); assert.deepEqual(received, { type: 'peers', payload: { peers: [] } }); stop(); assert(removed);
  let invoke; let tauriListener; removed = false;
  const tauri = createTauriRuntimeAdapter({ invoke: async (name, args) => { invoke = { name, args }; return { ok: true, value: {} }; }, listen: async (name, listener) => { assert.equal(name, 'stomp:event'); tauriListener = listener; return () => { removed = true; }; } });
  await tauri.stomp.execute({ action: 'send', bytes: Uint8Array.from([0, 1]) });
  assert.deepEqual(invoke, { name: 'stomp_execute', args: { request: { action: 'send', bytes: [0, 1] } } });
  const unlisten = tauri.stomp.onEvent(event => { received = event; }); await pause(0);
  tauriListener({ payload: { type: 'peers', payload: { peers: [] } } }); assert.deepEqual(received, { type: 'peers', payload: { peers: [] } }); await unlisten(); assert(removed);
});

test('native bridge rejects malformed server headers and HTTP framing headers before network activity', async t => {
  const { service } = fixture(t);
  await assert.rejects(service.execute({ action: 'open', connectionId: id(), mode: 'server', config: { listenPort: 0 }, headers: {} }));
  for (const name of ['Content-Length', 'Transfer-Encoding']) {
    await assert.rejects(service.execute({ action: 'open', connectionId: id(), mode: 'client', config: { url: 'ws://127.0.0.1:1' }, headers: [{ name, value: '1' }] }), /header/i);
  }
});

test('ACK immediately followed by socket close is processed before peer removal and never redelivered', async t => {
  const { createStompBroker } = await import('../../../packages/workbench/src/model/stompBroker.js');
  const { StompDecoder, encodeStompFrame } = await import('../../../packages/workbench/src/model/stompCodec.js');
  const { WebSocket } = require('ws');
  const connectionId = id(); const events = []; const known = new Set(); let broker;
  const service = new StompTransport({ emitEvent: event => {
    events.push(event);
    if (event.type === 'peers') {
      const current = new Set(event.payload.peers.map(peer => peer.id));
      for (const peer of known) if (!current.has(peer)) { broker.removePeer(peer); known.delete(peer); }
      for (const peer of current) { broker.addPeer(peer); known.add(peer); }
    }
    if (event.type === 'frames') for (const frame of event.payload.frames) broker.receive(frame.peerId, Uint8Array.from(frame.bytes));
  } });
  broker = createStompBroker({ config: { host: 'localhost', heartbeatIncoming: 0, heartbeatOutgoing: 0 },
    send: (peerId, bytes) => { void service.execute({ action: 'send', connectionId, peerId, bytes, messageType: 'binary' }).catch(() => {}); },
    close: peerId => { void service.execute({ action: 'disconnectPeer', connectionId, peerId }).catch(() => {}); },
  });
  t.after(async () => { broker.dispose(); await service.shutdown(); });
  await service.execute({ action: 'open', connectionId, mode: 'server', config: { listenPort: 0 } });
  const port = events.find(event => event.payload.status === 'listening').payload.log.details.port;
  async function consumer(subscription) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`); const frames = []; const decoder = new StompDecoder();
    socket.on('message', bytes => frames.push(...decoder.push(bytes))); t.after(() => socket.terminate()); await once(socket, 'open');
    socket.send(encodeStompFrame('CONNECT', { 'accept-version': '1.2', host: 'localhost', 'heart-beat': '0,0' }));
    await until(() => frames.some(frame => frame.command === 'CONNECTED'));
    socket.send(encodeStompFrame('SUBSCRIBE', { id: subscription, destination: '/queue/ack-race', ack: 'client-individual', receipt: subscription }));
    await until(() => frames.some(frame => frame.command === 'RECEIPT'));
    return { socket, frames };
  }
  const first = await consumer('first');
  broker.send({ destination: '/queue/ack-race', body: 'acknowledged-once' });
  await until(() => first.frames.some(frame => frame.command === 'MESSAGE'));
  const message = first.frames.find(frame => frame.command === 'MESSAGE');
  first.socket.send(encodeStompFrame('ACK', { id: message.headers.ack })); first.socket.close();
  await until(() => known.size === 0);
  const second = await consumer('second'); await pause(300);
  assert.equal(second.frames.filter(frame => frame.command === 'MESSAGE').length, 0, 'ACKed queue message must not return after close');
});
