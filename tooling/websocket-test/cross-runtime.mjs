import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocketService } = require('../../apps/electron/electron/websocketService.cjs');
const native = spawn(fileURLToPath(new URL('../../apps/tauri/src-tauri/target/debug/websocket-harness', import.meta.url)), [], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map(), rustEvents = [], nodeEvents = [];
let sequence = 0;
createInterface({ input: native.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.event) rustEvents.push(message.event);
  else {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(Object.assign(new Error(message.error.message), message.error));
    else task.resolve(message.result);
  }
});
function call(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native ${method} deadline`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    native.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`);
  });
}
async function until(check) {
  for (let n = 0; n < 500; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('cross-runtime event deadline');
}
const electron = new WebSocketService({ emitEvent: (channel, payload) => nodeEvents.push({ channel, ...payload }) });
const rustFrames = () => rustEvents.filter(e => e.type === 'frames').flatMap(e => e.payload.frames.map(f => ({ endpointId: e.payload.endpointId, ...f })));
const nodeFrames = () => nodeEvents.filter(e => e.channel === 'transport:frames').flatMap(e => e.frames.map(f => ({ endpointId: e.endpointId, ...f })));
const checks = [];
try {
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const availablePort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  await call('open', { endpoint: { id: 'rs', transport: 'websocket-server', config: { listenHost: '127.0.0.1', listenPort: availablePort, path: '/cross', subprotocols: ['linklab'] } }, operationId: 'rs-open' });
  const rustPort = availablePort;
  for (const id of ['nc1', 'nc2']) await electron.open({ id, transport: 'websocket-client', config: { url: `ws://127.0.0.1:${rustPort}/cross`, subprotocols: ['linklab'] } }, { operationId: `${id}-open` });
  await electron.send({ endpointId: 'nc1', bytes: [65, 66], messageType: 'text' });
  await electron.send({ endpointId: 'nc2', bytes: [0, 255, 1], messageType: 'binary' });
  await until(() => rustFrames().filter(f => f.direction === 'in').length === 2);
  assert.deepEqual(rustFrames().filter(f => f.direction === 'in').map(f => [f.messageType, f.bytes]).sort(), [['binary', [0, 255, 1]], ['text', [65, 66]]]);
  const sent = await call('send', { endpointId: 'rs', bytes: [72, 73], messageType: 'text', target: { type: 'broadcast' } });
  assert.equal(sent.successCount, 2);
  await until(() => nodeFrames().filter(f => f.direction === 'in').length === 2);
  checks.push('Electron clients → Tauri server text/binary; Tauri broadcast → two Electron clients');
  const peers = rustEvents.filter(e => e.type === 'peers').at(-1).payload.peers;
  await call('disconnectPeer', { endpointId: 'rs', peerId: peers[0].id });
  await until(() => rustEvents.filter(e => e.type === 'peers').at(-1).payload.peers.length === 1);
  assert.equal((await call('send', { endpointId: 'rs', bytes: [1], messageType: 'binary', target: { type: 'peer', peerIds: peers.map(p => p.id) } })).failureCount, 1);
  checks.push('Tauri peer disconnect and partial selected-send failure preserve healthy peer');
  await electron.open({ id: 'ns', transport: 'websocket-server', config: { listenHost: '127.0.0.1', listenPort: 0, path: '/reverse' } }, { operationId: 'ns-open' });
  const nodePort = nodeEvents.find(e => e.endpointId === 'ns' && e.status === 'listening').log.details.port;
  await call('open', { endpoint: { id: 'rc', transport: 'websocket-client', config: { url: `ws://127.0.0.1:${nodePort}/reverse` } }, operationId: 'rc-open' });
  await call('send', { endpointId: 'rc', bytes: [82], messageType: 'text' });
  await until(() => nodeFrames().some(f => f.endpointId === 'ns' && f.direction === 'in' && f.messageType === 'text'));
  await electron.send({ endpointId: 'ns', bytes: [0, 254, 128], messageType: 'binary', target: { type: 'broadcast' } });
  await until(() => rustFrames().some(f => f.endpointId === 'rc' && f.direction === 'in'));
  assert.deepEqual(rustFrames().find(f => f.endpointId === 'rc' && f.direction === 'in').bytes, [0, 254, 128]);
  await call('close', { endpointId: 'rc' });
  await until(() => nodeEvents.filter(e => e.endpointId === 'ns' && e.peers).at(-1).peers.length === 0);
  assert.equal(electron.sessions.get('ns').phase, 'listening');
  checks.push('Tauri client ↔ Electron server text/binary; close preserves listener');
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await electron.shutdown();
  try { await call('shutdown'); } finally { native.stdin.end(); native.kill(); }
}
