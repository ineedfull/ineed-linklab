import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const require = (await import('node:module')).createRequire(import.meta.url);
const { UdpService } = require('../electron/udpService.cjs');

const ASYNC_TEST_OPTIONS = { concurrency: 1, timeout: 5000 };

function createHarness() {
  const events = [];
  let timestamp = 1_720_000_000_000;
  const service = new UdpService({
    clock: () => timestamp++,
    emitEvent: (channel, payload) => events.push({ channel, payload }),
  });
  return { service, events, timestamp: () => timestamp };
}

function payloads(events, channel) {
  return events.filter((event) => event.channel === channel).map((event) => event.payload);
}

async function eventually(predicate, message = 'condition not met') {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), message);
}

test('UDP client sends and receives datagrams through a real localhost echo server', ASYNC_TEST_OPTIONS, async (t) => {
  const echoServer = dgram.createSocket('udp4');
  echoServer.on('message', (bytes, rinfo) => {
    echoServer.send(Buffer.from([0x41, ...bytes]), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => echoServer.bind(0, '127.0.0.1', resolve));
  t.after(() => echoServer.close());
  const { port } = echoServer.address();

  const { service, events } = createHarness();
  t.after(async () => { await service.shutdown(); });

  await service.open({
    id: 'udp-client-1',
    name: 'UDP Client',
    transport: 'udp-client',
    config: { bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: port, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-client' });

  await service.send({ endpointId: 'udp-client-1', bytes: Uint8Array.of(0x31, 0x32) });
  await eventually(() => payloads(events, 'transport:frames').some((batch) => (
    batch.frames.some((frame) => frame.direction === 'in')
  )));

  assert.equal(payloads(events, 'transport:status').at(-1).status, 'open');
  const frames = payloads(events, 'transport:frames').flatMap((batch) => batch.frames);
  assert.deepEqual(frames.map((frame) => frame.direction), ['out', 'in']);
});

test('UDP server discovers peers from incoming datagrams and sends back', ASYNC_TEST_OPTIONS, async (t) => {
  const { service, events } = createHarness();
  t.after(async () => { await service.shutdown(); });

  await service.open({
    id: 'udp-server-1',
    name: 'UDP Server',
    transport: 'udp-server',
    config: { bindHost: '127.0.0.1', bindPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-server' });

  const serverPort = service.sessions.get('udp-server-1').socket.address().port;
  const client = dgram.createSocket('udp4');
  t.after(() => client.close());

  await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve));
  client.send(Buffer.from([0x21]), serverPort, '127.0.0.1');

  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 1);
  const peerId = payloads(events, 'transport:peers').at(-1).peers[0].id;

  const received = new Promise((resolve) => {
    client.on('message', (bytes) => resolve(bytes));
  });
  await service.send({ endpointId: 'udp-server-1', bytes: Uint8Array.of(0x42), target: { peerId } });
  assert.deepEqual(await received, Buffer.from([0x42]));

  await eventually(() => payloads(events, 'transport:frames').some((batch) => (
    batch.frames.some((frame) => frame.direction === 'in' && frame.peerId === peerId)
  )));
  const frames = payloads(events, 'transport:frames').flatMap((batch) => batch.frames);
  assert.ok(frames.some((frame) => frame.direction === 'in' && frame.peerId === peerId));
  assert.ok(frames.some((frame) => frame.direction === 'out' && frame.peerId === peerId));
});

test('UDP server broadcast sends to all known peers', ASYNC_TEST_OPTIONS, async (t) => {
  const { service, events } = createHarness();
  t.after(async () => { await service.shutdown(); });

  await service.open({
    id: 'udp-server-bcast',
    name: 'UDP Server Broadcast',
    transport: 'udp-server',
    config: { bindHost: '127.0.0.1', bindPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-server-bcast' });

  const serverPort = service.sessions.get('udp-server-bcast').socket.address().port;
  const clientA = dgram.createSocket('udp4');
  const clientB = dgram.createSocket('udp4');
  t.after(() => { clientA.close(); clientB.close(); });

  await new Promise((resolve) => clientA.bind(0, '127.0.0.1', resolve));
  await new Promise((resolve) => clientB.bind(0, '127.0.0.1', resolve));
  clientA.send(Buffer.from([0x01]), serverPort, '127.0.0.1');
  clientB.send(Buffer.from([0x02]), serverPort, '127.0.0.1');
  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 2);

  const recvA = new Promise((resolve) => clientA.on('message', (bytes) => resolve(bytes)));
  const recvB = new Promise((resolve) => clientB.on('message', (bytes) => resolve(bytes)));
  await service.send({ endpointId: 'udp-server-bcast', bytes: Uint8Array.of(0x42), target: { broadcast: true } });
  assert.deepEqual(await recvA, Buffer.from([0x42]));
  assert.deepEqual(await recvB, Buffer.from([0x42]));
});

test('UDP server preserves one frame per datagram even with legacy stream framing config', ASYNC_TEST_OPTIONS, async (t) => {
  const { service, events } = createHarness();
  t.after(async () => { await service.shutdown(); });
  await service.open({
    id: 'udp-server-delimiter',
    name: 'UDP Server Delimiter',
    transport: 'udp-server',
    config: {
      bindHost: '127.0.0.1',
      bindPort: 0,
      receiveFraming: { mode: 'delimiter', delimiterBytes: [10] },
    },
  }, { operationId: 'open-server-delimiter' });

  const port = service.sessions.get('udp-server-delimiter').socket.address().port;
  const client = dgram.createSocket('udp4');
  t.after(() => client.close());
  await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve));
  client.send(Buffer.from('partial'), port, '127.0.0.1');
  client.send(Buffer.from('done\n'), port, '127.0.0.1');

  await eventually(() => {
    const values = payloads(events, 'transport:frames')
      .flatMap((batch) => batch.frames)
      .map((frame) => Buffer.from(frame.bytes).toString());
    return values.includes('partial') && values.includes('done\n');
  });
  const values = payloads(events, 'transport:frames')
    .flatMap((batch) => batch.frames)
    .map((frame) => Buffer.from(frame.bytes).toString());
  assert.equal(values.includes('partialdone'), false);
});

test('UDP client emits a datagram immediately and close does not synthesize another frame', ASYNC_TEST_OPTIONS, async (t) => {
  const remote = dgram.createSocket('udp4');
  await new Promise((resolve) => remote.bind(0, '127.0.0.1', resolve));
  t.after(() => remote.close());
  const { service, events } = createHarness();
  await service.open({
    id: 'udp-client-flush',
    name: 'UDP Client Flush',
    transport: 'udp-client',
    config: {
      bindHost: '127.0.0.1',
      bindPort: 0,
      targetHost: '127.0.0.1',
      targetPort: remote.address().port,
      receiveFraming: { mode: 'delimiter', delimiterBytes: [10] },
    },
  }, { operationId: 'open-client-flush' });

  const port = service.sessions.get('udp-client-flush').socket.address().port;
  remote.send(Buffer.from('tail'), port, '127.0.0.1');
  await eventually(() => payloads(events, 'transport:frames')
    .flatMap((batch) => batch.frames)
    .some((frame) => Buffer.from(frame.bytes).toString() === 'tail'));
  await service.close('udp-client-flush');

  const frames = payloads(events, 'transport:frames').flatMap((batch) => batch.frames);
  assert.equal(frames.filter((frame) => Buffer.from(frame.bytes).toString() === 'tail').length, 1);
  const statuses = payloads(events, 'transport:status').map(({ status }) => status);
  assert.deepEqual(statuses.slice(-2), ['closing', 'closed']);
});

test('forceShutdown cancels a pending UDP bind without late success or socket leak', ASYNC_TEST_OPTIONS, async () => {
  const events = [];
  const socket = new DeferredUdpSocket();
  const service = new UdpService({
    emitEvent: (channel, payload) => events.push({ channel, payload }),
    dgramModule: { createSocket: () => socket },
  });
  const opening = service.open({
    id: 'udp-opening-force',
    name: 'UDP Opening Force',
    transport: 'udp-server',
    config: { bindHost: '127.0.0.1', bindPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-force' });
  await eventually(() => socket.bindCalled);

  service.forceShutdown();
  socket.emit('listening');

  await assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  assert.equal(service.sessions.size, 0);
  assert.equal(socket.closed, true);
  assert.equal(payloads(events, 'transport:status').some(({ status }) => status === 'listening'), false);
});

test('UDP send failures emit error lifecycle and release the session', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  await service.open({
    id: 'udp-send-failure',
    name: 'UDP Send Failure',
    transport: 'udp-client',
    config: {
      bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: 9,
      receiveFraming: { mode: 'raw' },
    },
  }, { operationId: 'open-send-failure' });
  service.sessions.get('udp-send-failure').socket.send = (...args) => {
    const callback = args.at(-1);
    callback(Object.assign(new Error('injected send failure'), { code: 'EIO' }));
  };

  await assert.rejects(
    service.send({ endpointId: 'udp-send-failure', bytes: Uint8Array.of(1) }),
    (error) => error.code === 'IO_ERROR',
  );
  await eventually(() => !service.sessions.has('udp-send-failure'));
  assert.ok(payloads(events, 'transport:status').some(({ status }) => status === 'error'));
});

test('UDP disconnectPeer is unavailable', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  await assert.rejects(
    service.disconnectPeer('any', 'any'),
    (error) => error.code === 'IO_ERROR',
  );
});

test('UDP close and shutdown release sockets and clear peer events', ASYNC_TEST_OPTIONS, async (t) => {
  const { service, events } = createHarness();
  await service.open({
    id: 'udp-server-close',
    name: 'UDP Server Close',
    transport: 'udp-server',
    config: { bindHost: '127.0.0.1', bindPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-server-close' });
  const port = service.sessions.get('udp-server-close').socket.address().port;
  const client = dgram.createSocket('udp4');
  t.after(() => client.close());
  await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve));
  client.send(Buffer.from([0x01]), port, '127.0.0.1');
  await eventually(() => payloads(events, 'transport:peers').at(-1)?.peers.length === 1);

  await service.close('udp-server-close');
  await service.shutdown();

  assert.equal(service.sessions.size, 0);
  assert.equal(payloads(events, 'transport:peers').at(-1).peers.length, 0);
});

test('closeAll releases UDP sessions without permanently stopping the service', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  const endpoint = {
    id: 'udp-reusable-server',
    name: 'UDP Reusable Server',
    transport: 'udp-server',
    config: { bindHost: '127.0.0.1', bindPort: 0, receiveFraming: { mode: 'raw' } },
  };

  await service.open(endpoint, { operationId: 'open-before-close-all' });
  await service.closeAll();
  assert.equal(service.sessions.size, 0);

  await service.open(endpoint, { operationId: 'open-after-close-all' });
  assert.equal(service.sessions.has(endpoint.id), true);

  await service.shutdown();
});

test('forceShutdown synchronously releases open UDP server resources', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  await service.open({
    id: 'udp-force-server',
    name: 'UDP Force Server',
    transport: 'udp-server',
    config: { bindHost: '127.0.0.1', bindPort: 0, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-force-server' });

  assert.deepEqual(service.forceShutdown(), []);
  assert.equal(service.sessions.size, 0);
});

class DeferredUdpSocket extends EventEmitter {
  bindCalled = false;
  closed = false;

  bind() {
    this.bindCalled = true;
  }

  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: 41000 };
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}
