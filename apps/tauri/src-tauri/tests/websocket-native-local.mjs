// Run after cargo build --bin websocket-harness. All sockets bind loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  normalizeTransportFrameBatch,
  normalizeTransportPeerEvent,
  normalizeTransportStatusEvent,
} from '../../../../packages/runtime-contract/src/index.js';

const binary = fileURLToPath(new URL('../target/debug/websocket-harness', import.meta.url));
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
const events = [];
const normalizers = { status: normalizeTransportStatusEvent, frames: normalizeTransportFrameBatch, peers: normalizeTransportPeerEvent };
let nextId = 1;
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.event) {
    const { type, payload } = message.event;
    normalizers[type](payload);
    events.push(message.event);
    return;
  }
  const callback = pending.get(message.id);
  if (!callback) return;
  clearTimeout(callback.timer);
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(message.error.message));
  else callback.resolve(message.result);
});
function request(input) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native WebSocket harness timeout')); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...input })}\n`);
  });
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Expected native event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const server = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: () => 'chat' });
await once(server, 'listening');
let nativeClient;
let incomingHeaders;
server.on('connection', (socket, incoming) => {
  nativeClient = socket;
  incomingHeaders = incoming.headers;
  socket.on('message', (bytes, binary) => socket.send(bytes, { binary }));
});
const clients = [];
let secure;
try {
  const port = server.address().port;
  await request({ method: 'open', endpoint: { id: 'native-client', transport: 'websocket-client', config: { url: `ws://127.0.0.1:${port}/?key-only-secret`, subprotocols: ['chat'] } }, operationId: 'client-open', websocketHeaders: [{ name: 'Authorization', value: 'Bearer local-secret' }] });
  assert.equal(incomingHeaders.authorization, 'Bearer local-secret');
  await request({ method: 'send', endpointId: 'native-client', bytes: [104, 105], messageType: 'text' });
  await request({ method: 'send', endpointId: 'native-client', bytes: [0, 255, 1], messageType: 'binary' });
  await until(() => events.filter((event) => event.type === 'frames' && event.payload.endpointId === 'native-client' && event.payload.frames[0].direction === 'in').length === 2);
  const frames = events.filter((event) => event.type === 'frames' && event.payload.frames[0].direction === 'in').map((event) => event.payload.frames[0]);
  assert.deepEqual(frames.map((frame) => [frame.bytes, frame.messageType, frame.framing]), [[[104, 105], 'text', 'websocket'], [[0, 255, 1], 'binary', 'websocket']]);
  nativeClient.close(1008, 'local-secret key-only-secret');
  await until(() => events.some((event) => event.type === 'status' && event.payload.endpointId === 'native-client' && event.payload.status === 'closed'));
  assert(!JSON.stringify(events).includes('local-secret'));
  assert(!JSON.stringify(events).includes('key-only-secret'));

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const listenPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await request({ method: 'open', endpoint: { id: 'native-server', transport: 'websocket-server', config: { listenHost: '127.0.0.1', listenPort, path: '/native', subprotocols: ['chat'] } }, operationId: 'server-open' });
  for (let index = 0; index < 2; index++) {
    const client = new WebSocket(`ws://127.0.0.1:${listenPort}/native`, ['chat']);
    clients.push(client);
    await once(client, 'open');
  }
  await until(() => events.some((event) => event.type === 'peers' && event.payload.peers.length === 2));
  const received = clients.map((client) => once(client, 'message'));
  const acknowledgement = await request({ method: 'send', endpointId: 'native-server', bytes: [0, 255], messageType: 'binary', target: { type: 'broadcast' } });
  assert.equal(acknowledgement.successCount, 2);
  for (const [bytes, binary] of await Promise.all(received)) { assert.deepEqual([...bytes], [0, 255]); assert.equal(binary, true); }
  const peers = events.filter((event) => event.type === 'peers' && event.payload.endpointId === 'native-server').at(-1).payload.peers;
  await request({ method: 'disconnectPeer', endpointId: 'native-server', peerId: peers[0].id });
  await until(() => events.filter((event) => event.type === 'peers' && event.payload.endpointId === 'native-server').at(-1).payload.peers.length === 1);

  const fixture = new URL('../../../../tooling/websocket-test/fixtures/', import.meta.url);
  secure = createHttpsServer({ cert: await readFile(new URL('localhost-cert.pem', fixture)), key: await readFile(new URL('localhost-key.pem', fixture)) });
  secure.listen(0, '127.0.0.1');
  await once(secure, 'listening');
  await assert.rejects(request({ method: 'open', endpoint: { id: 'wss', transport: 'websocket-client', config: { url: `wss://127.0.0.1:${secure.address().port}/?credential` } }, operationId: 'wss' }), /TLS handshake failed/);
  await request({ method: 'shutdown' });
  console.log(`Native WebSocket acceptance passed: strict wire envelopes (${events.length} events), headers, protocols, text/binary, 2 peers, broadcast/disconnect, close redaction, untrusted WSS.`);
} finally {
  for (const client of clients) client.terminate();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  if (secure) await new Promise((resolve) => secure.close(resolve));
  child.stdin.end();
  await once(child, 'exit');
}
