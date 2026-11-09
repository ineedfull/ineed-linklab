import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ModbusRTU = require('modbus-serial');
const {
  ModbusService,
  captureRtuSlaveFrames,
  createDataStore,
  createSerialServer,
  normalizeOperation,
  serialOptions,
} = require('../electron/modbusService.cjs');

test('captures complete RTU request and response bytes with wire-order CRC16', () => {
  const input = new EventEmitter();
  let writes = 0;
  const output = {
    write: (frame) => { writes += 1; return frame.length; },
  };
  const transactions = [];
  captureRtuSlaveFrames({
    endpointId: 'slave', sessionId: 'session', transport: 'modbus-rtu-slave',
  }, { _server: input, _serverPath: output }, (transaction) => transactions.push(transaction));

  input.emit('data', Buffer.from([1, 6, 0, 2, 0, 22, 0xa9, 0xc4]));
  output.write(Buffer.from([1, 6, 0, 2, 0, 22, 0xa9, 0xc4]));

  assert.equal(transactions.length, 1);
  assert.equal(writes, 1);
  assert.deepEqual(transactions[0].requestFrame, [1, 6, 0, 2, 0, 22, 0xa9, 0xc4]);
  assert.deepEqual(transactions[0].responseFrame, [1, 6, 0, 2, 0, 22, 0xa9, 0xc4]);

  input.emit('data', Buffer.from([1, 43, 0, 0]));
  assert.doesNotThrow(() => output.write(Buffer.from([1, 0xab, 1, 0, 0])));
  assert.equal(writes, 2);
  assert.equal(transactions.length, 1);
});

test('Modbus serial options keep macOS PTY compatibility with a bounded idle reader', () => {
  const options = serialOptions({
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
  });

  if (process.platform === 'darwin') {
    assert.equal(options.vmin, 0);
    assert.equal(options.vtime, 1);
    assert.equal(typeof options.binding.open, 'function');
  } else {
    assert.equal(Object.hasOwn(options, 'vmin'), false);
    assert.equal(Object.hasOwn(options, 'vtime'), false);
  }
});

test('real idle RTU ports wait without a zero-byte read loop and still exchange after reopen', {
  timeout: 10000, skip: process.platform !== 'darwin',
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linklab-rtu-idle-'));
  const slave = path.join(directory, 'slave.pty');
  const master = path.join(directory, 'master.pty');
  const pair = spawn('socat', [`pty,raw,echo=0,link=${slave}`, `pty,raw,echo=0,link=${master}`], { stdio: 'ignore' });
  let spawnError;
  pair.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (pair.exitCode === null && !spawnError) {
      const exited = new Promise(resolve => pair.once('exit', resolve));
      pair.kill('SIGTERM'); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 2000;
  while (true) {
    if (spawnError) throw spawnError;
    try { await access(slave); await access(master); break; } catch {
      assert.ok(Date.now() < deadline, 'socat PTY pair did not become ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const fixture = new URL('./fixtures/modbus-idle-reader.cjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [fixture.pathname, slave, master], {
    timeout: 7000, killSignal: 'SIGKILL',
  });
  const report = JSON.parse(stdout.trim());
  assert.ok(report.idleReads <= 256);
  assert.deepEqual(report.values, [12, 34]);
});

test('Modbus RTU slave forwards native serial options to ServerSerial', async () => {
  let received;
  class FakeServerSerial extends EventEmitter {
    constructor(vector, serverOptions, nativeOptions) {
      super();
      received = { vector, serverOptions, nativeOptions };
      process.nextTick(() => this.emit('initialized'));
    }
  }
  function FakeModbus() {}
  FakeModbus.ServerSerial = FakeServerSerial;

  const vector = {};
  const server = await createSerialServer(FakeModbus, vector, {
    path: '/dev/test',
    baudRate: 19200,
    dataBits: 7,
    parity: 'even',
    stopBits: 2,
    flowControl: 'hardware',
    unitId: 7,
  });

  assert.ok(server instanceof FakeServerSerial);
  assert.equal(received.vector, vector);
  assert.deepEqual(received.serverOptions, {
    path: '/dev/test',
    baudRate: 19200,
    parity: 'even',
    unitID: 7,
    openCallback: received.serverOptions.openCallback,
  });
  assert.equal(typeof received.serverOptions.openCallback, 'function');
  assert.equal(received.nativeOptions.dataBits, 7);
  assert.equal(received.nativeOptions.stopBits, 2);
  assert.equal(received.nativeOptions.rtscts, true);
});

test('Modbus data maps initialize all four areas and reject address overflow', () => {
  const data = createDataStore({
    coils: { start: 10, count: 3 },
    holdingRegisters: { start: 20, count: 2, values: [123] },
  });

  assert.deepEqual(data.coils, { start: 10, values: [false, false, false] });
  assert.deepEqual(data.discreteInputs, {
    start: 0,
    values: Array.from({ length: 100 }, () => false),
  });
  assert.deepEqual(data.holdingRegisters, { start: 20, values: [123, 0] });
  assert.equal(data.inputRegisters.values.length, 100);
  assert.throws(
    () => createDataStore({ coils: { start: 65_535, count: 2 } }),
    /range exceeds address 65535/i,
  );
});

test('Modbus operations enforce supported function codes and protocol limits', () => {
  assert.deepEqual(normalizeOperation({
    functionCode: 16,
    unitId: 1,
    address: 40,
    values: [123, 456],
  }), {
    functionCode: 16,
    unitId: 1,
    address: 40,
    quantity: 2,
    values: [123, 456],
  });
  assert.throws(() => normalizeOperation({ functionCode: 7 }), /functionCode/);
  assert.throws(() => normalizeOperation({
    functionCode: 3, unitId: 1, address: 0, quantity: 126,
  }), /quantity/);
  assert.throws(() => normalizeOperation({
    functionCode: 15, unitId: 1, address: 0, values: Array(1969).fill(true),
  }), /quantity/);
  assert.throws(() => normalizeOperation({
    functionCode: 6, unitId: 1, address: 65_535, values: [1, 2],
  }), /quantity/);
  assert.throws(() => normalizeOperation({
    functionCode: 6, unitId: 1, address: 1, values: ['2'],
  }), /integers/);
  assert.throws(() => normalizeOperation({
    functionCode: 3, unitId: 1, address: 0, quantity: 1, timeoutMs: 49,
  }), /timeoutMs/);
  assert.throws(() => normalizeOperation({
    functionCode: 3, unitId: 1, address: 0, quantity: 1, requestGroupId: '  ',
  }), /requestGroupId/);
  assert.throws(() => normalizeOperation({
    functionCode: 3, unitId: 1, address: 0, quantity: 1, requestId: '  ',
  }), /requestId/);
});

test('a write captured for an old session cannot reach a replacement master', async (t) => {
  const writes = [];
  class Client {
    setID() {}
    setTimeout() {}
    async connectTCP() {}
    async writeRegister(address, value) { writes.push([address, value]); return {}; }
    close(callback) { callback(); }
  }
  const service = new ModbusService({ ModbusRTU: Client });
  t.after(() => service.forceShutdown());
  const endpoint = { id: 'master', transport: 'modbus-tcp-master', config: { host: '127.0.0.1', port: 502 } };
  const first = await service.open(endpoint, { operationId: 'first' });
  await service.close('master');
  const next = await service.open(endpoint, { operationId: 'next' });
  const write = { endpointId: 'master', expectedSessionId: first.sessionId,
    functionCode: 6, unitId: 1, address: 0, quantity: 1, values: [42] };
  await assert.rejects(async () => service.execute(write), (error) => error.code === 'OPEN_CANCELLED');
  assert.deepEqual(writes, []);
  await service.execute({ ...write, expectedSessionId: next.sessionId });
  assert.deepEqual(writes, [[0, 42]]);
});

test('closing owns the endpoint until native cleanup finishes and shutdown joins it', async () => {
  let release; let closes = 0;
  class Client {
    setID() {} setTimeout() {} async connectTCP() {}
    close(callback) { closes++; release = callback; }
  }
  const service = new ModbusService({ ModbusRTU: Client });
  const endpoint = { id: 'master', transport: 'modbus-tcp-master', config: {} };
  await service.open(endpoint, { operationId: 'first' });
  const first = service.close('master');
  await new Promise(resolve => setImmediate(resolve));
  let repeatedDone = false; let shutdownDone = false;
  const repeated = service.close('master').then(() => { repeatedDone = true; });
  await assert.rejects(service.open(endpoint, { operationId: 'replacement' }), error => error.code === 'PORT_BUSY');
  const shutdown = service.shutdown().then(() => { shutdownDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(repeatedDone, false); assert.equal(shutdownDone, false); assert.equal(closes, 1);
  release(); await Promise.all([first, repeated, shutdown]);
  assert.equal(repeatedDone, true); assert.equal(shutdownDone, true);
});

test('failed native close remains reserved, reports error and can be retried before reopening', async () => {
  const statuses = []; let closes = 0; let oldCallback;
  class Client {
    setID() {} setTimeout() {} async connectTCP() {}
    close(callback) { closes++; if (closes === 1) { oldCallback = callback; callback(new Error('native close failed')); } else callback(); }
  }
  const service = new ModbusService({ ModbusRTU: Client, emitTransportEvent: (_, event) => statuses.push(event) });
  const endpoint = { id: 'master', transport: 'modbus-tcp-master', config: {} };
  await service.open(endpoint, { operationId: 'first' });
  await assert.rejects(service.close('master'), /native close failed/);
  assert.equal(statuses.at(-1).status, 'error');
  await assert.rejects(service.open(endpoint, { operationId: 'too-soon' }), error => error.code === 'PORT_BUSY');
  await service.close('master');
  const replacement = await service.open(endpoint, { operationId: 'replacement' });
  const statusCount = statuses.length;
  oldCallback();
  assert.equal(service.sessions.get('master').sessionId, replacement.sessionId);
  assert.equal(statuses.length, statusCount);
  await service.shutdown();
});

test('forced shutdown bypasses a stalled request drain and joins one native close', { timeout: 2000 }, async () => {
  let failRequest; let closes = 0;
  class Client {
    setID() {} setTimeout() {} async connectTCP() {}
    readHoldingRegisters() { return new Promise((_, reject) => { failRequest = reject; }); }
    close(callback) { closes++; callback(); }
  }
  const service = new ModbusService({ ModbusRTU: Client });
  await service.open({ id: 'master', transport: 'modbus-tcp-master', config: {} }, { operationId: 'first' });
  const request = service.execute({ endpointId: 'master', functionCode: 3, unitId: 1, address: 0, quantity: 1 });
  const rejected = assert.rejects(request, /interrupted/);
  await new Promise(resolve => setImmediate(resolve));
  const closing = service.close('master');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 0);
  await service.forceShutdown();
  await closing;
  assert.equal(closes, 1);
  failRequest(new Error('interrupted')); await rejected;
  assert.equal(closes, 1);
});

test('failed I/O retirement retains native ownership for retry without masking the request failure', async () => {
  let closes = 0;
  class Client {
    setID() {} setTimeout() {} async connectTCP() {}
    async readHoldingRegisters() { throw new Error('wire disconnected'); }
    close(callback) { closes++; callback(closes === 1 ? new Error('native close failed') : null); }
  }
  const service = new ModbusService({ ModbusRTU: Client });
  const endpoint = { id: 'master', transport: 'modbus-tcp-master', config: {} };
  await service.open(endpoint, { operationId: 'first' });
  await assert.rejects(service.execute({ endpointId: 'master', functionCode: 3, unitId: 1, address: 0, quantity: 1 }), /wire disconnected/);
  await assert.rejects(service.open(endpoint, { operationId: 'replacement' }), error => error.code === 'PORT_BUSY');
  await service.forceShutdown(); assert.equal(closes, 2);
});

test('I/O retirement during an explicit close cannot wait on its own request queue', { timeout: 2000 }, async () => {
  let failRequest; let closes = 0;
  class Client {
    setID() {} setTimeout() {} async connectTCP() {}
    readHoldingRegisters() { return new Promise((_, reject) => { failRequest = reject; }); }
    close(callback) { closes++; callback(); }
  }
  const service = new ModbusService({ ModbusRTU: Client });
  await service.open({ id: 'master', transport: 'modbus-tcp-master', config: {} }, { operationId: 'first' });
  const request = service.execute({ endpointId: 'master', functionCode: 3, unitId: 1, address: 0, quantity: 1 });
  const rejected = assert.rejects(request, /wire failed/);
  await new Promise(resolve => setImmediate(resolve));
  const closing = service.close('master');
  failRequest(new Error('wire failed'));
  await Promise.all([rejected, closing]);
  assert.equal(closes, 1);
  await service.shutdown();
});

test('master timeout is restored and group/request correlation survives success and failure', async (t) => {
  const timeoutCalls = [];
  const transactions = [];
  class TimeoutClient {
    setID() {}
    setTimeout(value) { timeoutCalls.push(value); }
    async connectTCP() {}
    async readHoldingRegisters() { return { data: [321] }; }
    async readInputRegisters() { throw new Error('group request failed'); }
    close(callback) { callback(); }
  }
  const service = new ModbusService({
    ModbusRTU: TimeoutClient,
    emitModbusEvent: (transaction) => transactions.push(transaction),
  });
  t.after(() => service.forceShutdown());
  await service.open({
    id: 'master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502, timeoutMs: 1_000 },
  }, { operationId: 'open-master' });

  const success = await service.execute({
    endpointId: 'master', requestGroupId: 'boiler', requestId: 'holding-fast', timeoutMs: 250,
    functionCode: 3, unitId: 1, address: 0, quantity: 1, values: [],
  });
  assert.equal(success.requestGroupId, 'boiler');
  assert.equal(success.requestId, 'holding-fast');
  await assert.rejects(service.execute({
    endpointId: 'master', requestGroupId: 'boiler', requestId: 'inputs-slow', timeoutMs: 500,
    functionCode: 4, unitId: 1, address: 0, quantity: 1, values: [],
  }), (error) => error.transaction.requestGroupId === 'boiler'
    && error.transaction.requestId === 'inputs-slow');

  assert.deepEqual(timeoutCalls, [1_000, 250, 1_000, 500, 1_000]);
  assert.deepEqual(transactions.map(({ requestGroupId, requestId }) => [requestGroupId, requestId]), [
    ['boiler', 'holding-fast'], ['boiler', 'inputs-slow'],
  ]);
});

test('master I/O failure retires the session while a Modbus exception keeps it open', async (t) => {
  const statuses = [];
  let closed = 0;
  class FailingClient {
    setID() {}
    setTimeout() {}
    async connectTCP() {}
    async readHoldingRegisters() { throw new Error('socket disconnected'); }
    async readInputRegisters() { throw { modbusCode: 2, message: 'illegal address' }; }
    close(callback) { closed += 1; callback(); }
  }
  const service = new ModbusService({
    ModbusRTU: FailingClient,
    emitTransportEvent: (channel, event) => statuses.push([channel, event]),
  });
  t.after(() => service.forceShutdown());
  const endpoint = {
    id: 'master', transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502 },
  };

  await service.open(endpoint, { operationId: 'open-1' });
  await assert.rejects(service.execute({
    endpointId: 'master', functionCode: 4, unitId: 1, address: 0, quantity: 1,
  }), (error) => error.code === 'MODBUS_EXCEPTION' && /illegal address/.test(error.message));
  assert.equal(service.sessions.has('master'), true);

  await assert.rejects(service.execute({
    endpointId: 'master', functionCode: 3, unitId: 1, address: 0, quantity: 1,
  }), /socket disconnected/);

  assert.equal(service.sessions.has('master'), false);
  assert.equal(closed, 1);
  assert.deepEqual(statuses.slice(-2).map(([, event]) => event.status), ['error', 'closed']);
  assert.equal(statuses.at(-2)[1].sessionId, 'modbus-1');
  assert.equal(statuses.at(-1)[1].sessionId, null);
});

test('TCP slave retires a failed listener but keeps listening after a peer socket error', async (t) => {
  let server;
  let closed = 0;
  const statuses = [];
  class FakeServerTCP extends EventEmitter {
    constructor() {
      super();
      this._server = new EventEmitter();
      this._server.listening = true;
      this.socks = new Map();
      server = this;
    }
    close(callback) { closed += 1; callback(); }
  }
  function FakeModbus() {}
  FakeModbus.ServerTCP = FakeServerTCP;
  const service = new ModbusService({
    ModbusRTU: FakeModbus,
    emitTransportEvent: (_channel, event) => statuses.push(event),
  });
  t.after(() => service.forceShutdown());

  await service.open({
    id: 'tcp-slave', transport: 'modbus-tcp-slave',
    config: { listenHost: '127.0.0.1', listenPort: 1502 },
  }, { operationId: 'open-tcp-slave' });
  server.emit('socketError', new Error('peer reset'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.sessions.has('tcp-slave'), true);

  server.emit('serverError', new Error('listener stopped'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.sessions.has('tcp-slave'), false);
  assert.equal(closed, 1);
  assert.deepEqual(statuses.slice(-2).map(({ status }) => status), ['error', 'closed']);
});

test('TCP slave rejects a listener failure that happens before listening', async (t) => {
  let closed = 0;
  const statuses = [];
  class FailingServerTCP extends EventEmitter {
    constructor() {
      super();
      this._server = new EventEmitter();
      this._server.listening = false;
      this.socks = new Map();
      process.nextTick(() => this.emit('serverError', new Error('bind failed')));
    }
    close(callback) { closed += 1; callback(); }
  }
  function FakeModbus() {}
  FakeModbus.ServerTCP = FailingServerTCP;
  const service = new ModbusService({
    ModbusRTU: FakeModbus,
    emitTransportEvent: (_channel, event) => statuses.push(event),
  });
  t.after(() => service.forceShutdown());

  const opening = service.open({
    id: 'tcp-slave', transport: 'modbus-tcp-slave',
    config: { listenHost: '127.0.0.1', listenPort: 1502 },
  }, { operationId: 'open-tcp-slave' });
  const result = await Promise.race([
    opening.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 25)),
  ]);

  assert.equal(result, 'rejected');
  assert.equal(service.opening.size, 0);
  assert.equal(closed, 1);
  assert.deepEqual(statuses.map(({ status }) => status), ['opening', 'error', 'closed']);
});

test('RTU slave retires its session after a serial runtime failure', async (t) => {
  let server;
  let closed = 0;
  const statuses = [];
  class FakeServerSerial extends EventEmitter {
    constructor() {
      super();
      this._server = new EventEmitter();
      this._serverPath = { write() {} };
      server = this;
      process.nextTick(() => this.emit('initialized'));
    }
    close(callback) { closed += 1; callback(); }
  }
  function FakeModbus() {}
  FakeModbus.ServerSerial = FakeServerSerial;
  const service = new ModbusService({
    ModbusRTU: FakeModbus,
    emitTransportEvent: (_channel, event) => statuses.push(event),
  });
  t.after(() => service.forceShutdown());

  await service.open({
    id: 'rtu-slave', transport: 'modbus-rtu-slave',
    config: { path: '/dev/test', baudRate: 9600 },
  }, { operationId: 'open-rtu-slave' });
  server.emit('socketError', new Error('device removed'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.sessions.has('rtu-slave'), false);
  assert.equal(closed, 1);
  assert.deepEqual(statuses.slice(-2).map(({ status }) => status), ['error', 'closed']);
});

test('opening reservations reject duplicates and shutdown cleans a late connection', async () => {
  let resolveConnect;
  class DeferredClient {
    setID() {}
    setTimeout() {}
    connectTCP() { return new Promise((resolve) => { resolveConnect = resolve; }); }
    close(callback) { callback(); }
  }
  const service = new ModbusService({ ModbusRTU: DeferredClient });
  const endpoint = {
    id: 'pending-master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 1502, unitId: 1 },
  };

  const opening = service.open(endpoint, { operationId: 'open-1' });
  await assert.rejects(
    service.open(endpoint, { operationId: 'open-2' }),
    (error) => error.code === 'PORT_BUSY',
  );
  const shutdown = service.shutdown();
  resolveConnect();
  await assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  await shutdown;
  assert.equal(service.sessions.size, 0);
  assert.equal(service.opening.size, 0);
});

test('native Modbus config rejects invalid explicit values instead of replacing them with defaults', async () => {
  const service = new ModbusService({ ModbusRTU });
  await assert.rejects(service.open({
    id: 'invalid-master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502, unitId: '1' },
  }, { operationId: 'invalid-open' }), /unitId/);
  await assert.rejects(service.open({
    id: 'invalid-rtu-parity',
    transport: 'modbus-rtu-master',
    config: { path: '/dev/null', parity: 'mark' },
  }, { operationId: 'invalid-parity-open' }), /parity/);
  await assert.rejects(service.open({
    id: 'invalid-rtu-stop-bits',
    transport: 'modbus-rtu-master',
    config: { path: '/dev/null', stopBits: 1.5 },
  }, { operationId: 'invalid-stop-bits-open' }), /stopBits/);
  assert.throws(() => createDataStore({ holdingRegisters: [] }), /must be an object/);
});

test('master transactions preserve messages from non-Error library failures', async (t) => {
  class ObjectFailureClient {
    setID() {}
    setTimeout() {}
    async connectTCP() {}
    async writeRegisters() { throw { message: 'request timed out' }; }
    close(callback) { callback(); }
  }
  const service = new ModbusService({ ModbusRTU: ObjectFailureClient });
  t.after(() => service.forceShutdown());
  await service.open({
    id: 'master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502 },
  }, { operationId: 'open-master' });

  await assert.rejects(service.execute({
    endpointId: 'master', functionCode: 16, unitId: 1, address: 0, values: [1],
  }), (error) => error.message === 'request timed out'
    && error.transaction.message === 'request timed out'
    && assert.deepEqual(error.transaction.requestValues, [1]) === undefined);
});

test('real Modbus TCP master and slave execute saved FC05 and FC16 request shapes', { timeout: 5_000 }, async (t) => {
  const port = await reservePort();
  const statuses = [];
  const transactions = [];
  const service = new ModbusService({
    ModbusRTU,
    emitTransportEvent: (channel, payload) => statuses.push([channel, payload]),
    emitModbusEvent: (payload) => transactions.push(payload),
  });
  t.after(() => service.forceShutdown());

  await service.open({
    id: 'slave',
    transport: 'modbus-tcp-slave',
    config: {
      listenHost: '127.0.0.1',
      listenPort: port,
      unitId: 1,
      dataAreas: {
        coils: { start: 0, count: 10 },
        holdingRegisters: { start: 0, count: 10 },
      },
    },
  }, { operationId: 'open-slave' });
  await service.open({
    id: 'master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port, unitId: 1, timeoutMs: 1_000 },
  }, { operationId: 'open-master' });

  const coilWritten = await service.execute({
    endpointId: 'master', functionCode: 5, unitId: 1,
    address: 5, quantity: 1, values: [true],
  });
  const registersWritten = await service.execute({
    endpointId: 'master', functionCode: 16, unitId: 1, address: 2, values: [123, 456],
  });
  const coilRead = await service.execute({
    endpointId: 'master', functionCode: 1, unitId: 1, address: 5, quantity: 1,
  });
  const read = await service.execute({
    endpointId: 'master', functionCode: 3, unitId: 1, address: 2, quantity: 2,
  });
  const map = service.readMap('slave');

  assert.deepEqual(writeTransactionContract(coilWritten), {
    requestGroupId: null, requestId: null, origin: 'master', unitId: 1,
    functionCode: 5, address: 5, quantity: 1,
    requestValues: [true], values: [true], success: true,
    exceptionCode: null, message: null,
  });
  assert.deepEqual(writeTransactionContract(registersWritten), {
    requestGroupId: null, requestId: null, origin: 'master', unitId: 1,
    functionCode: 16, address: 2, quantity: 2,
    requestValues: [123, 456], values: [123, 456], success: true,
    exceptionCode: null, message: null,
  });
  assert.deepEqual(coilRead.values.slice(0, coilRead.quantity), [true]);
  assert.deepEqual(read.values, [123, 456]);
  assert.deepEqual(map.areas.coils.values.slice(5, 6), [true]);
  assert.deepEqual(map.areas.holdingRegisters.values.slice(2, 4), [123, 456]);
  assert.ok(transactions.some(({ origin, functionCode }) => origin === 'master' && functionCode === 16));
  assert.ok(transactions.some(({ origin, functionCode }) => origin === 'slave' && functionCode === 3));
  const capturedWrite = transactions.find(({ origin, functionCode }) => (
    origin === 'slave' && functionCode === 16
  ));
  assert.equal(capturedWrite.transport, 'modbus-tcp-slave');
  assert.deepEqual(capturedWrite.requestFrame.slice(2), [
    0, 0, 0, 11, 1, 16, 0, 2, 0, 2, 4, 0, 123, 1, 200,
  ]);
  assert.deepEqual(capturedWrite.responseFrame.slice(0, 2), capturedWrite.requestFrame.slice(0, 2));
  assert.deepEqual(capturedWrite.responseFrame.slice(2), [0, 0, 0, 6, 1, 16, 0, 2, 0, 2]);
  assert.ok(statuses.some(([channel, value]) => (
    channel === 'transport:status' && value.endpointId === 'slave' && value.status === 'listening'
  )));

  await service.shutdown();
  assert.ok(statuses.some(([, value]) => value.endpointId === 'master' && value.status === 'closed'));
});

for (const transport of ['modbus-rtu-master', 'modbus-rtu-slave']) {
  test(`failed native ${transport} opening releases its reservation`, async () => {
    const service = new ModbusService({ ModbusRTU });
    const endpoint = { id: 'missing-rtu', transport,
      config: { path: '/tmp/linklab-review-no-such-serial-device', unitId: 1 } };
    await assert.rejects(service.open(endpoint, { operationId: 'open-missing' }), /no such file|cannot open/i);
    assert.equal(service.opening.size, 0);
    assert.equal(service.sessions.size, 0);
    await service.shutdown();
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function writeTransactionContract(transaction) {
  return {
    requestGroupId: transaction.requestGroupId,
    requestId: transaction.requestId,
    origin: transaction.origin,
    unitId: transaction.unitId,
    functionCode: transaction.functionCode,
    address: transaction.address,
    quantity: transaction.quantity,
    requestValues: transaction.requestValues,
    values: transaction.values,
    success: transaction.success,
    exceptionCode: transaction.exceptionCode,
    message: transaction.message,
  };
}


test('FC15 validates the entire coil range before responding or mutating', { timeout: 5000 }, async (t) => {
  const port = await reservePort();
  const service = new ModbusService({ ModbusRTU });
  t.after(() => service.forceShutdown());
  await service.open({ id: 'slave', transport: 'modbus-tcp-slave', config: {
    listenHost: '127.0.0.1', listenPort: port, unitId: 1,
    dataAreas: { coils: { start: 0, count: 2, values: [false, false] } },
  } }, { operationId: 'slave-open' });
  await service.open({ id: 'master', transport: 'modbus-tcp-master', config: {
    host: '127.0.0.1', port, unitId: 1, timeoutMs: 1000,
  } }, { operationId: 'master-open' });
  await assert.rejects(service.execute({ endpointId: 'master', functionCode: 15,
    unitId: 1, address: 0, values: [true, true, true] }),
  (error) => error.transaction.exceptionCode === 2);
  assert.deepEqual(service.readMap('slave').areas.coils.values, [false, false]);
  const result = await service.execute({ endpointId: 'master', functionCode: 15,
    unitId: 1, address: 0, values: [true, true] });
  assert.equal(result.success, true);
  assert.deepEqual(service.readMap('slave').areas.coils.values, [true, true]);
});


test('real RTU PTY FC15 rejects out-of-map writes before success', { timeout: 10000, skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linklab-fc15-'));
  const slavePath = path.join(directory, 'slave.pty');
  const masterPath = path.join(directory, 'master.pty');
  const pair = spawn('socat', ['-d', '-d', `pty,raw,echo=0,link=${slavePath}`, `pty,raw,echo=0,link=${masterPath}`], { stdio: 'ignore' });
  let spawnError;
  pair.on('error', (error) => { spawnError = error; });
  const service = new ModbusService({ ModbusRTU });
  t.after(async () => {
    await service.forceShutdown();
    if (pair.exitCode === null && !spawnError) {
      const exited = new Promise((resolve) => pair.once('exit', resolve));
      pair.kill('SIGTERM'); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 2000;
  while (true) {
    if (spawnError) throw spawnError;
    try { await access(slavePath); await access(masterPath); break; } catch {
      assert.ok(Date.now() < deadline, 'socat PTY pair did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const serial = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
    flowControl: 'none', unitId: 1, timeoutMs: 2000 };
  await service.open({ id: 'slave', transport: 'modbus-rtu-slave', config: {
    ...serial, path: slavePath, dataAreas: { coils: { start: 0, count: 2 } },
  } }, { operationId: 'slave-open' });
  await service.open({ id: 'master', transport: 'modbus-rtu-master', config: {
    ...serial, path: masterPath,
  } }, { operationId: 'master-open' });
  await assert.rejects(service.execute({ endpointId: 'master', functionCode: 15,
    unitId: 1, address: 0, values: [true, true, true] }),
  (error) => error.transaction.exceptionCode === 2);
  assert.deepEqual(service.readMap('slave').areas.coils.values, [false, false]);
  await service.execute({ endpointId: 'master', functionCode: 15, unitId: 1,
    address: 0, values: [true, true] });
  assert.deepEqual(service.readMap('slave').areas.coils.values, [true, true]);
});

test('slave map rejects writes from an old session after reopen without changing new values', async (t) => {
  const service = new ModbusService({ ModbusRTU });
  t.after(() => service.forceShutdown());
  const endpoint = { id: 'guarded-slave', transport: 'modbus-tcp-slave', config: {
    listenHost: '127.0.0.1', listenPort: await reservePort(), unitId: 1,
    dataAreas: { holdingRegisters: { start: 0, count: 2, values: [12, 34] } },
  } };
  const old = await service.open(endpoint, { operationId: 'first' });
  await service.close(endpoint.id);
  const current = await service.open(endpoint, { operationId: 'second' });
  assert.notEqual(old.sessionId, current.sessionId);
  assert.throws(() => service.writeMap({ endpointId: endpoint.id,
    expectedSessionId: old.sessionId, area: 'holdingRegisters', address: 0, values: [99] }),
  /session has changed/);
  assert.deepEqual(service.readMap(endpoint.id).areas.holdingRegisters.values, [12, 34]);
  service.writeMap({ endpointId: endpoint.id, expectedSessionId: current.sessionId,
    area: 'holdingRegisters', address: 0, values: [56] });
  assert.deepEqual(service.readMap(endpoint.id).areas.holdingRegisters.values, [56, 34]);
});
