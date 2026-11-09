import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { normalizeTransportStatusEvent } from '../renderer/serialWireNormalizer.js';

const require = (await import('node:module')).createRequire(import.meta.url);
const { TcpService } = require('../electron/tcpService.cjs');

const ASYNC_TEST_OPTIONS = { timeout: 4_000 };

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.ended = false;
    this.destroyCalls = 0;
    this.endCalls = 0;
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 51000;
    this.writes = [];
    this.writeError = null;
  }

  setNoDelay(enabled) {
    this.noDelayCalls ??= [];
    this.noDelayCalls.push(enabled);
  }

  setKeepAlive(enabled, initialDelay) {
    if (this.keepAliveError) throw this.keepAliveError;
    this.keepAliveCalls ??= [];
    this.keepAliveCalls.push({ enabled, initialDelay });
  }

  pause() {}

  resume() {}

  setTimeout(delay, callback) {
    this.timeout = { delay, callback };
  }

  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    callback?.(this.writeError);
    return true;
  }

  end() {
    this.endCalls += 1;
    this.ended = true;
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }
}

class FakeServer extends EventEmitter {
  constructor(onConnection) {
    super();
    this.onConnection = onConnection;
    this.listening = false;
    this.closeCalls = 0;
    this.listenCalls = [];
  }

  listen(port, host) {
    this.listenCalls.push({ port, host });
  }

  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: 54321 };
  }

  close(callback) {
    this.closeCalls += 1;
    this.listening = false;
    callback?.(null);
  }

  succeedListen() {
    this.listening = true;
    this.emit('listening');
  }

  accept(socket) {
    this.onConnection(socket);
  }
}

function createFakeNet() {
  const sockets = [];
  const servers = [];
  return {
    sockets,
    servers,
    createConnection() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    createServer(onConnection) {
      const server = new FakeServer(onConnection);
      servers.push(server);
      return server;
    },
  };
}

function createHarness() {
  const events = [];
  let timestamp = 1_720_000_000_000;
  const service = new TcpService({
    clock: () => {
      const value = timestamp;
      timestamp += 1;
      return value;
    },
    emitEvent: (channel, payload) => events.push({ channel, payload }),
  });
  return { service, events };
}

function createHarnessWithOptions(options = {}) {
  const events = [];
  const reports = [];
  let timestamp = 1_720_000_000_000;
  const service = new TcpService({
    clock: () => {
      const value = timestamp;
      timestamp += 1;
      return value;
    },
    emitEvent: (channel, payload) => events.push({ channel, payload }),
    reportEventError: (error, context) => reports.push({ error, context }),
    ...options,
  });
  return { service, events, reports };
}

function payloads(events, channel) {
  return events.filter((event) => event.channel === channel).map((event) => event.payload);
}

async function eventually(predicate, message = 'condition was not met') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), message);
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function connectClient(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', (bytes) => resolve(Buffer.from(bytes)));
    socket.once('error', reject);
  });
}

test('TCP client connects to a real localhost server and persists frame-shaped events', ASYNC_TEST_OPTIONS, async (t) => {
  const server = net.createServer((socket) => {
    socket.on('data', (bytes) => socket.write(Buffer.from([0x41, ...bytes])));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { service, events } = createHarness();
  t.after(async () => {
    await service.shutdown();
    await closeServer(server);
  });

  await service.open({
    id: 'tcp-client-1',
    name: 'TCP Client',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-client' });
  await service.send({ endpointId: 'tcp-client-1', bytes: Uint8Array.of(0x31, 0x32) });
  await eventually(() => payloads(events, 'transport:frames').some((batch) => (
    batch.frames.some((frame) => frame.direction === 'in')
  )));
  assert.equal(payloads(events, 'transport:status').at(-1).status, 'open');
  assert.deepEqual(
    payloads(events, 'transport:frames').flatMap((batch) => batch.frames).map((frame) => frame.direction),
    ['out', 'in'],
  );
});

test('TCP server listens, accepts a peer, sends and receives frames', ASYNC_TEST_OPTIONS, async (t) => {
  const { service, events } = createHarness();
  let client = null;
  t.after(async () => {
    client?.destroy();
    await service.shutdown();
  });
  const opened = await service.open({
    id: 'tcp-server-1',
    name: 'TCP Server',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-server' });
  const session = service.sessions.get('tcp-server-1');
  const { port } = session.server.address();
  client = await connectClient(port);

  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 1);
  const peer = payloads(events, 'transport:peers').at(-1).peers[0];
  assert.match(peer.remoteAddress, /^127\.0\.0\.1:/);
  assert.equal(typeof peer.connectedAt, 'number');

  client.write(Buffer.from([0x21]));
  await eventually(() => payloads(events, 'transport:frames').some((batch) => (
    batch.frames.some((frame) => frame.direction === 'in')
  )));
  await service.send({ endpointId: 'tcp-server-1', peerId: peer.id, bytes: Uint8Array.of(0x42) });
  assert.deepEqual([...await waitForData(client)], [0x42]);
  await eventually(() => payloads(events, 'transport:frames').flatMap((batch) => batch.frames).length === 2);

  assert.equal(opened.sessionId, session.sessionId);
  assert.equal(payloads(events, 'transport:status').at(-1).status, 'listening');
  assert.deepEqual(
    payloads(events, 'transport:frames')
      .flatMap((batch) => batch.frames)
      .map(({ direction, bytes, peerId }) => [direction, bytes, peerId]),
    [['in', [0x21], peer.id], ['out', [0x42], peer.id]],
  );
});

test('TCP server accepts the UI listenHost and listenPort config shape', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'ui-shaped-server',
    name: 'UI Shaped TCP Server',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-ui-shaped-server' });
  await eventually(() => fakeNet.servers.length === 1);
  assert.deepEqual(fakeNet.servers[0].listenCalls, [{ host: '127.0.0.1', port: 0 }]);
  fakeNet.servers[0].succeedListen();

  await opening;
  await service.shutdown();
});

test('TCP client configures legacy keepalive defaults after connecting', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'legacy-keepalive-client',
    name: 'Legacy Keepalive Client',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port: 7001, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-legacy-keepalive-client' });
  await eventually(() => fakeNet.sockets.length === 1);

  const [clientSocket] = fakeNet.sockets;
  clientSocket.emit('connect');
  await opening;

  assert.deepEqual(clientSocket.keepAliveCalls, [{ enabled: true, initialDelay: 30_000 }]);
  assert.deepEqual(clientSocket.noDelayCalls, [true]);
  await service.shutdown();
});

test('TCP server configures an accepted peer with its explicit keepalive policy', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'disabled-keepalive-server',
    name: 'Disabled Keepalive Server',
    transport: 'tcp-server',
    config: {
      listenHost: '127.0.0.1',
      listenPort: 7002,
      receiveFraming: { mode: 'raw' },
      keepAlive: { enabled: false, initialDelaySeconds: 45 },
    },
  }, { operationId: 'open-disabled-keepalive-server' });
  await eventually(() => fakeNet.servers.length === 1);
  const [server] = fakeNet.servers;
  server.succeedListen();
  await opening;

  const disabledSocket = new FakeSocket();
  server.accept(disabledSocket);
  await eventually(() => service.sessions.get('disabled-keepalive-server')?.peers.size === 1);

  assert.deepEqual(disabledSocket.keepAliveCalls, [{ enabled: false, initialDelay: 45_000 }]);
  assert.deepEqual(disabledSocket.noDelayCalls, [true]);
  await service.shutdown();
});

test('TCP keepalive configuration rejects invalid native-boundary values before opening', async () => {
  const invalidKeepAlive = [
    { enabled: true, initialDelaySeconds: 0 },
    { enabled: true, initialDelaySeconds: 3601 },
    { enabled: true, initialDelaySeconds: 1.5 },
    { enabled: true, initialDelaySeconds: '30' },
    { enabled: 1, initialDelaySeconds: 30 },
    { enabled: true, initialDelaySeconds: 30, interval: 10 },
    Object.create(Object.prototype, {
      enabled: { enumerable: true, get() { throw new Error('enabled getter ran'); } },
      initialDelaySeconds: { enumerable: true, value: 30 },
    }),
  ];

  for (const keepAlive of invalidKeepAlive) {
    const fakeNet = createFakeNet();
    const { service } = createHarnessWithOptions({ netModule: fakeNet });
    await assert.rejects(service.open({
      id: 'invalid-keepalive-client',
      name: 'Invalid Keepalive Client',
      transport: 'tcp-client',
      config: {
        host: '127.0.0.1', port: 7003, receiveFraming: { mode: 'raw' }, keepAlive,
      },
    }, { operationId: 'open-invalid-keepalive-client' }), TypeError);
    assert.equal(fakeNet.sockets.length, 0);
  }
});

test('TCP keepalive configuration rejects proxy records before opening', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  const keepAlive = new Proxy({ enabled: true, initialDelaySeconds: 30 }, {});
  const opening = service.open({
    id: 'proxy-keepalive-client',
    name: 'Proxy Keepalive Client',
    transport: 'tcp-client',
    config: {
      host: '127.0.0.1', port: 7004, receiveFraming: { mode: 'raw' }, keepAlive,
    },
  }, { operationId: 'open-proxy-keepalive-client' });
  const rejection = assert.rejects(opening, TypeError);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fakeNet.sockets[0]?.emit('connect');

  await rejection;
  assert.equal(fakeNet.sockets.length, 0);
});

test('TCP client socket setup failure follows the existing open-failure lifecycle', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'keepalive-client-failure',
    name: 'Keepalive Client Failure',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port: 7005, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-keepalive-client-failure' });
  await eventually(() => fakeNet.sockets.length === 1);

  const [clientSocket] = fakeNet.sockets;
  clientSocket.keepAliveError = new Error('keepalive setup failed');
  clientSocket.emit('connect');

  await assert.rejects(opening, (error) => error.code === 'IO_ERROR');
  assert.equal(clientSocket.destroyed, true);
  assert.equal(service.sessions.has('keepalive-client-failure'), false);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status }) => status), ['opening', 'error']);
});

test('TCP server keepalive setup failure destroys only the accepted peer', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'keepalive-peer-failure',
    name: 'Keepalive Peer Failure',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 7006, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-keepalive-peer-failure' });
  await eventually(() => fakeNet.servers.length === 1);
  const [server] = fakeNet.servers;
  server.succeedListen();
  await opening;

  const peerSocket = new FakeSocket();
  peerSocket.keepAliveError = new Error('keepalive setup failed');
  server.accept(peerSocket);

  await eventually(() => peerSocket.destroyed, 'accepted peer was not destroyed after setup failure');
  assert.equal(service.sessions.get('keepalive-peer-failure').peers.size, 0);
  assert.equal(server.listening, true);
  const statusLogs = payloads(events, 'transport:status').map(({ log }) => log).filter(Boolean);
  assert.equal(statusLogs.some((log) => (
    log.level === 'warn'
    && log.peerId === 'tcp-peer-1'
    && /keepalive/i.test(log.message)
    && log.details.remoteAddress === '127.0.0.1:51000'
  )), true);
  assert.equal(payloads(events, 'transport:status').some(({ status }) => status === 'error'), false);

  await service.shutdown();
});

test('TCP server can disconnect a peer and emits the updated peer list', ASYNC_TEST_OPTIONS, async (t) => {
  const { service, events } = createHarness();
  let client = null;
  t.after(async () => {
    client?.destroy();
    await service.shutdown();
  });
  await service.open({
    id: 'tcp-server-disconnect',
    name: 'TCP Server Disconnect',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-server-disconnect' });
  const { port } = service.sessions.get('tcp-server-disconnect').server.address();
  client = await connectClient(port);
  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 1);
  const [{ id: peerId }] = payloads(events, 'transport:peers').at(-1).peers;
  await eventually(() => payloads(events, 'transport:status')
    .some(({ log }) => log?.peerId === peerId && /connected/.test(log.message)));

  const closed = new Promise((resolve) => client.once('close', resolve));
  assert.deepEqual(
    await service.disconnectPeer('tcp-server-disconnect', peerId),
    { disconnected: true, endpointId: 'tcp-server-disconnect', peerId },
  );
  await closed;
  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 0);
  assert.equal(
    payloads(events, 'transport:status')
      .some(({ log }) => log?.peerId === peerId && /disconnected/.test(log.message)),
    true,
  );
});

test('TCP server multi-peer send reports partial failures without blocking successful peers', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'multi-peer-server',
    name: 'Multi-peer TCP Server',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 4445, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-multi-peer-server' });
  await eventually(() => fakeNet.servers.length === 1);
  fakeNet.servers[0].succeedListen();
  await opening;

  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  sockets.forEach((socket, index) => {
    socket.remotePort += index;
    fakeNet.servers[0].accept(socket);
  });
  await eventually(() => service.sessions.get('multi-peer-server')?.peers.size === 3);
  const peerIds = [...service.sessions.get('multi-peer-server').peers.keys()];
  sockets[1].writeError = Object.assign(new Error('peer write failed'), { code: 'EPIPE' });

  const acknowledgement = await service.send({
    endpointId: 'multi-peer-server',
    bytes: Uint8Array.of(0x41, 0x42),
    target: { type: 'peer', peerIds },
  });

  assert.deepEqual(sockets.map(({ writes }) => writes.map((bytes) => [...bytes])), [
    [[0x41, 0x42]], [[0x41, 0x42]], [[0x41, 0x42]],
  ]);
  assert.deepEqual(acknowledgement.peerResults, [
    { peerId: peerIds[0], ok: true, byteCount: 2 },
    {
      peerId: peerIds[1], ok: false,
      error: { code: 'IO_ERROR', message: 'peer write failed' },
    },
    { peerId: peerIds[2], ok: true, byteCount: 2 },
  ]);
  assert.equal(acknowledgement.successCount, 2);
  assert.equal(acknowledgement.failureCount, 1);

  await service.shutdown();
});

test('TCP client bounds a stalled write and releases the failed connection', ASYNC_TEST_OPTIONS, async t => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  t.after(() => service.shutdown());
  const opening = service.open({ id: 'slow-client', transport: 'tcp-client',
    config: { host: '127.0.0.1', port: 4445 } }, { operationId: 'open-slow-client' });
  await eventually(() => fakeNet.sockets.length === 1);
  const socket = fakeNet.sockets[0];
  socket.emit('connect');
  await opening;
  let completeLateWrite;
  socket.write = (_bytes, callback) => { completeLateWrite = callback; return false; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failure;
  let settled = false;
  const sending = service.send({ endpointId: 'slow-client', bytes: Uint8Array.of(1) })
    .then(() => { settled = true; }, error => { settled = true; failure = error; });
  t.mock.timers.tick(2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'A connected peer that stops reading must not hold send forever');
  await sending;
  assert.match(failure?.message ?? '', /timed out/i);
  assert.equal(socket.destroyed, true);
  assert.equal(service.sessions.has('slow-client'), false);
  completeLateWrite();
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('TCP server times out only the stalled broadcast peer and completes healthy sends', ASYNC_TEST_OPTIONS, async t => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  t.after(() => service.shutdown());
  const opening = service.open({ id: 'slow-server', transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 4445 } }, { operationId: 'open-slow-server' });
  await eventually(() => fakeNet.servers.length === 1);
  fakeNet.servers[0].succeedListen();
  await opening;
  const slow = new FakeSocket();
  const healthy = new FakeSocket();
  healthy.remotePort++;
  fakeNet.servers[0].accept(slow);
  fakeNet.servers[0].accept(healthy);
  await eventually(() => service.sessions.get('slow-server').peers.size === 2);
  slow.write = () => false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let acknowledgement;
  const sending = service.send({ endpointId: 'slow-server', bytes: Uint8Array.of(0x41), target: { type: 'broadcast' } })
    .then(result => { acknowledgement = result; });
  t.mock.timers.tick(2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(acknowledgement, 'Broadcast must finish even when one selected peer stops reading');
  await sending;
  assert.equal(acknowledgement.successCount, 1);
  assert.equal(acknowledgement.failureCount, 1);
  assert.match(acknowledgement.peerResults[0].error.message, /timed out/i);
  assert.equal(slow.destroyed, true);
  assert.equal(healthy.destroyed, false);
  assert.equal(service.sessions.get('slow-server').peers.size, 1);
  const next = await service.send({ endpointId: 'slow-server', bytes: Uint8Array.of(0x42), target: { type: 'broadcast' } });
  assert.equal(next.successCount, 1);
  assert.deepEqual(healthy.writes.map(bytes => [...bytes]), [[0x41], [0x42]]);
});

test('TCP native write deadline rejects a real localhost peer that stops reading', ASYNC_TEST_OPTIONS, async t => {
  let peer;
  const server = net.createServer(socket => { peer = socket; socket.pause(); });
  const { service } = createHarness();
  t.after(async () => {
    peer?.destroy();
    await service.shutdown();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await service.open({ id: 'native-stalled', transport: 'tcp-client',
    config: { host: '127.0.0.1', port: server.address().port } }, { operationId: 'open-native-stalled' });
  await assert.rejects(service.send({ endpointId: 'native-stalled', bytes: new Uint8Array(8 * 1024 * 1024) }), /timed out/i);
  await eventually(() => !service.sessions.has('native-stalled'), 'The native socket close must retire its session');
});

test('TCP close and shutdown close sockets and clear peer events', ASYNC_TEST_OPTIONS, async (t) => {
  const { service, events } = createHarness();
  const clientServer = net.createServer();
  await new Promise((resolve) => clientServer.listen(0, '127.0.0.1', resolve));
  let peerClient = null;
  t.after(async () => {
    peerClient?.destroy();
    await service.shutdown();
    await closeServer(clientServer);
  });

  await service.open({
    id: 'tcp-client-close',
    name: 'TCP Client Close',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port: clientServer.address().port, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-client-close' });
  await service.open({
    id: 'tcp-server-shutdown',
    name: 'TCP Server Shutdown',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-server-shutdown' });
  peerClient = await connectClient(service.sessions.get('tcp-server-shutdown').server.address().port);
  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 1);

  assert.deepEqual(await service.close('tcp-client-close'), {
    closed: true, endpointId: 'tcp-client-close',
  });
  await service.shutdown();

  assert.equal(service.sessions.size, 0);
 assert.deepEqual(payloads(events, 'transport:status').map(({ status }) => status), [
    'opening', 'open', 'opening', 'listening', 'listening', 'closed', 'listening', 'closed',
 ]);
 assert.equal(payloads(events, 'transport:peers').at(-1).peers.length, 0);
});

test('closeAll releases TCP sessions without permanently stopping the service', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  const firstOpen = service.open({
    id: 'reusable-tcp',
    name: 'Reusable TCP',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 2224, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-before-close-all' });
  await eventually(() => fakeNet.servers.length === 1);
  fakeNet.servers[0].succeedListen();
  await firstOpen;

  await service.closeAll();
  assert.equal(service.sessions.size, 0);

  const secondOpen = service.open({
    id: 'reusable-tcp',
    name: 'Reusable TCP',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 2224, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-after-close-all' });
  await eventually(() => fakeNet.servers.length === 2);
  fakeNet.servers[1].succeedListen();
  await secondOpen;

  await service.shutdown();
});

test('shutdown cancels a pending TCP client open and prevents late session success', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'pending-client',
    name: 'Pending Client',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port: 1111, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-pending-client' });
  await eventually(() => fakeNet.sockets.length === 1);

  await service.shutdown();
  fakeNet.sockets[0].emit('connect');

  await assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  assert.equal(fakeNet.sockets[0].destroyed, true);
  assert.equal(service.sessions.has('pending-client'), false);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status }) => status), [
    'opening', 'closed',
  ]);
});

test('forceShutdown cancels a pending TCP server listen and prevents late session success', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'pending-server',
    name: 'Pending Server',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 2222, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-pending-server' });
  await eventually(() => fakeNet.servers.length === 1);

  assert.deepEqual(service.forceShutdown(), []);
  fakeNet.servers[0].succeedListen();

  await assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  assert.equal(fakeNet.servers[0].closeCalls, 1);
  assert.equal(service.sessions.has('pending-server'), false);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status }) => status), [
    'opening', 'closed',
  ]);
});

test('forceShutdown synchronously releases open TCP server resources', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'force-open-server',
    name: 'Force Open Server',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 2223, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-force-open-server' });
  await eventually(() => fakeNet.servers.length === 1);
  fakeNet.servers[0].succeedListen();
  await opening;
  const peer = new FakeSocket();
  fakeNet.servers[0].accept(peer);
  await eventually(() => service.sessions.get('force-open-server')?.peers.size === 1);

  assert.deepEqual(service.forceShutdown(), []);

  assert.equal(service.sessions.size, 0);
  assert.equal(fakeNet.servers[0].closeCalls, 1);
  assert.equal(peer.destroyed, true);
});

test('failed TCP client connect emits one error status', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'refused-client',
    name: 'Refused Client',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port: 3333, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-refused-client' });
  await eventually(() => fakeNet.sockets.length === 1);

  fakeNet.sockets[0].emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));

  await assert.rejects(opening, (error) => error.code === 'PORT_NOT_FOUND');
  assert.equal(payloads(events, 'transport:status').filter(({ status }) => status === 'error').length, 1);
});

test('TCP server peer socket error disconnects only that peer', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
  const opening = service.open({
    id: 'peer-error-server',
    name: 'Peer Error Server',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 4444, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-peer-error-server' });
  await eventually(() => fakeNet.servers.length === 1);
  fakeNet.servers[0].succeedListen();
  await opening;

  const first = new FakeSocket();
  const second = new FakeSocket();
  second.remotePort = 51001;
  fakeNet.servers[0].accept(first);
  fakeNet.servers[0].accept(second);
  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 2);
  const [firstPeer, secondPeer] = payloads(events, 'transport:peers').at(-1).peers;

  first.emit('error', Object.assign(new Error('peer failed'), { code: 'EPIPE' }));

  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 1);
  assert.equal(service.sessions.has('peer-error-server'), true);
  assert.deepEqual(payloads(events, 'transport:peers').at(-1).peers.map(({ id }) => id), [secondPeer.id]);
  assert.equal(service.sessions.get('peer-error-server').server.listening, true);
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, false);
  assert.equal(payloads(events, 'transport:status').filter(({ status }) => status === 'error').length, 0);
  assert.notEqual(firstPeer.id, secondPeer.id);
  await service.shutdown();
});

test('TCP event observer failures are reported and do not interrupt lifecycle cleanup', ASYNC_TEST_OPTIONS, async () => {
  const fakeNet = createFakeNet();
  const observerError = new Error('observer failed');
  const reports = [];
  const service = new TcpService({
    clock: Date.now,
    netModule: fakeNet,
    emitEvent() { throw observerError; },
    reportEventError(error, context) { reports.push({ error, context }); },
  });
  const opening = service.open({
    id: 'observer-server',
    name: 'Observer Server',
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 5555, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-observer-server' });
  await eventually(() => fakeNet.servers.length === 1);
  fakeNet.servers[0].succeedListen();
  await opening;
  const peer = new FakeSocket();
  fakeNet.servers[0].accept(peer);
  await eventually(() => reports.some(({ context }) => context.channel === 'transport:peers'));

  await service.shutdown();

  assert.equal(service.sessions.size, 0);
  assert.equal(fakeNet.servers[0].closeCalls, 1);
  assert.equal(peer.destroyed, true);
  assert.ok(reports.length >= 4);
  assert.equal(reports.every(({ error }) => error === observerError), true);
  assert.equal(reports.every(({ context }) => (
    ['transport:status', 'transport:peers'].includes(context.channel)
  )), true);
});

for (const transport of ['tcp-client', 'tcp-server']) {
  for (const receiveFraming of [{ mode: 'delimiter', delimiterBytes: [0] }, { mode: 'idle', idleMs: 50 }]) {
  test(`${transport} ${receiveFraming.mode} overflow diagnoses the affected connection and disconnects it`, ASYNC_TEST_OPTIONS, async () => {
    const fakeNet = createFakeNet();
    const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
    try {
      const opening = service.open({
        id: 'overflow', name: 'Overflow', transport,
        config: { host: '127.0.0.1', port: 7000, listenHost: '127.0.0.1', listenPort: 0,
          receiveFraming },
      }, { operationId: 'overflow-open' });
      let socket;
      if (transport === 'tcp-client') {
        await eventually(() => fakeNet.sockets.length === 1);
        [socket] = fakeNet.sockets;
        socket.emit('connect');
        await opening;
      } else {
        await eventually(() => fakeNet.servers.length === 1);
        fakeNet.servers[0].succeedListen();
        await opening;
        socket = new FakeSocket();
        fakeNet.servers[0].accept(socket);
        await eventually(() => socket.listenerCount('data') === 1);
      }
      socket.emit('data', Buffer.alloc(1024 * 1024, 1));
      socket.emit('data', Buffer.from([1]));
      await eventually(() => socket.destroyed);
      const statuses = payloads(events, 'transport:status').map(normalizeTransportStatusEvent);
      const status = statuses.find((event) => event.error?.code === 'IO_ERROR' || event.log?.details?.error?.code === 'IO_ERROR');
      assert.ok(status, 'overflow must be visible as a transport diagnostic');
      assert.match(status.log.message, /pending.*1048576.*bytes/i);
      if (transport === 'tcp-server') {
        assert.equal(status.status, 'listening');
        assert.ok(status.log.peerId);
        assert.equal(fakeNet.servers[0].listening, true);
      } else {
        await eventually(() => payloads(events, 'transport:status').at(-1).status === 'closed');
      }
      assert.equal(payloads(events, 'transport:frames').length, 0);
    } finally { await service.shutdown(); }
  });
}
}


for (const transport of ['tcp-client', 'tcp-server']) {
  for (const framing of [{ mode: 'delimiter', delimiterBytes: [10] }, { mode: 'fixed', length: 4 }, { mode: 'idle', idleMs: 1000 }]) {
    for (const closure of ['eof', 'user']) {
      test(`${transport} ${framing.mode} ${closure} flushes its tail exactly once`, ASYNC_TEST_OPTIONS, async (t) => {
        const fakeNet = createFakeNet();
        const { service, events } = createHarnessWithOptions({ netModule: fakeNet });
        t.after(() => service.shutdown());
        const opening = service.open({ id: 'tail', transport, config: {
          host: '127.0.0.1', port: 7000, listenHost: '127.0.0.1', listenPort: 0,
          receiveFraming: framing,
        } }, { operationId: 'tail-open' });
        let socket;
        if (transport === 'tcp-client') {
          await eventually(() => fakeNet.sockets.length === 1);
          [socket] = fakeNet.sockets; socket.emit('connect'); await opening;
        } else {
          await eventually(() => fakeNet.servers.length === 1);
          fakeNet.servers[0].succeedListen(); await opening;
          socket = new FakeSocket(); fakeNet.servers[0].accept(socket);
          await eventually(() => socket.listenerCount('data') === 1);
        }
        socket.emit('data', Buffer.from('xy'));
        if (closure === 'eof') socket.destroy();
        else await service.close('tail');
        await service.shutdown();
        const frames = payloads(events, 'transport:frames').flatMap((event) => event.frames);
        assert.deepEqual(frames.map((frame) => Buffer.from(frame.bytes).toString()), ['xy']);
      });
    }
  }
}
