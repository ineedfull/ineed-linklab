import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createUnavailableRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import { createWorkbenchModel } from '../../../packages/workbench/src/model/createWorkbenchModel.js';
import { createElectronRuntimeAdapter } from '../renderer/runtimeAdapter.js';
import {
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
  normalizeTransportFrameBatch,
  normalizeTransportPeerEvent,
  normalizeTransportStatusEvent,
} from '../renderer/serialWireNormalizer.js';

const require = (await import('node:module')).createRequire(import.meta.url);
const { SerialService, mapSerialError } = require('../electron/serialService.cjs');
const { TransportCoordinator } = require('../electron/transportCoordinator.cjs');

class FakeSerialPort extends EventEmitter {
  static instances = [];

  static listedPorts = [];

  static listError = null;

  static async list() {
    if (this.listError) throw this.listError;
    return this.listedPorts;
  }

  static reset() {
    this.instances = [];
    this.listedPorts = [];
    this.listError = null;
  }

  constructor(options) {
    super();
    this.options = options;
    this.isOpen = false;
    this.openCalls = 0;
    this.closeCalls = 0;
    this.writes = [];
    this.autoFinishClose = true;
    this.openCallback = null;
    this.closeCallbacks = [];
    FakeSerialPort.instances.push(this);
  }

  open(callback) {
    this.openCalls += 1;
    this.openCallback = callback;
  }

  succeedOpen() {
    this.isOpen = true;
    const callback = this.openCallback;
    this.openCallback = null;
    callback?.(null);
  }

  failOpen(error) {
    const callback = this.openCallback;
    this.openCallback = null;
    callback?.(error);
  }

  close(callback) {
    this.closeCalls += 1;
    this.closeCallbacks.push(callback);
    if (this.autoFinishClose) this.finishClose();
  }

  finishClose(error = null) {
    if (error === null) this.isOpen = false;
    const callbacks = this.closeCallbacks.splice(0);
    for (const callback of callbacks) callback?.(error);
  }

  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    callback?.(this.writeError ?? null);
  }

  drain(callback) {
    callback?.(null);
  }
}

function createTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    runAll() {
      for (const [id, task] of [...tasks]) {
        tasks.delete(id);
        task.callback();
      }
    },
    get size() {
      return tasks.size;
    },
    delays() {
      return [...tasks.values()].map(({ delay }) => delay);
    },
  };
}

function rawFramerFactory({ emitFrame }) {
  return {
    push(bytes) { emitFrame(bytes); },
    flush() {},
    reset() {},
  };
}

function serialEndpoint(id, config = {}) {
  return {
    id,
    name: id,
    transport: 'serial',
    config: {
      path: `/dev/${id}`,
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'none',
      ...config,
    },
  };
}

function createHarness(overrides = {}) {
  FakeSerialPort.reset();
  const events = [];
  const timers = createTimers();
  let timestamp = 1_700_000_000_000;
  const service = new SerialService({
    SerialPort: FakeSerialPort,
    clock: () => {
      const value = timestamp;
      timestamp += 1;
      return value;
    },
    timers,
    emitEvent: (channel, payload) => events.push({ channel, payload }),
    framerFactory: rawFramerFactory,
    ...overrides,
  });
  return { service, events, timers };
}

async function waitForPort(index = 0) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (FakeSerialPort.instances[index]) return FakeSerialPort.instances[index];
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Fake serial port ${index} was not constructed`);
}

function payloads(events, channel) {
  return events.filter((event) => event.channel === channel).map((event) => event.payload);
}

const ASYNC_TEST_OPTIONS = { timeout: 2_000 };

test('scan returns strict serial port records with nullable metadata', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  FakeSerialPort.listedPorts = [
    { path: '/dev/ttyA', manufacturer: 'Maker', serialNumber: 'SN', vendorId: '1209', productId: '0001', friendlyName: 'ignored' },
    { path: '/dev/ttyB' },
  ];

  assert.deepEqual(await service.scan(), [
    { path: '/dev/ttyA', manufacturer: 'Maker', serialNumber: 'SN', vendorId: '1209', productId: '0001' },
    { path: '/dev/ttyB', manufacturer: null, serialNumber: null, vendorId: null, productId: null },
  ]);
});

test('scan maps native list failures to fixed serial error codes', ASYNC_TEST_OPTIONS, async () => {
  for (const [reason, expectedCode] of [
    [Object.assign(new Error('access denied'), { code: 'EACCES' }), 'PERMISSION_DENIED'],
    [new Error('native enumeration failed'), 'IO_ERROR'],
  ]) {
    const { service } = createHarness();
    FakeSerialPort.listError = reason;
    await assert.rejects(service.scan(), (error) => (
      error.name === 'SerialError' && error.code === expectedCode
    ));
  }
});

test('open uses autoOpen false and maps every serial option including flow control', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  const cases = [
    [{ dataBits: 5, parity: 'none', stopBits: 1, flowControl: 'none' }, { rtscts: false, xon: false, xoff: false }],
    [{ dataBits: 6, parity: 'even', stopBits: 1.5, flowControl: 'hardware' }, { rtscts: true, xon: false, xoff: false }],
    [{ dataBits: 7, parity: 'odd', stopBits: 2, flowControl: 'software' }, { rtscts: false, xon: true, xoff: true }],
    [{ dataBits: 8, parity: 'mark', stopBits: 1, flowControl: 'none' }, { rtscts: false, xon: false, xoff: false }],
    [{ dataBits: 8, parity: 'space', stopBits: 2, flowControl: 'none' }, { rtscts: false, xon: false, xoff: false }],
  ];

  for (const [index, [config, flow]] of cases.entries()) {
    const endpoint = serialEndpoint(`options-${index}`, { baudRate: 57600, ...config });
    const opening = service.open(endpoint, { operationId: `operation-${index}` });
    const port = await waitForPort(index);
    assert.deepEqual(port.options, {
      path: endpoint.config.path,
      baudRate: 57600,
      dataBits: config.dataBits,
      parity: config.parity,
      stopBits: config.stopBits,
      autoOpen: false,
      ...flow,
    });
    port.succeedOpen();
    const result = await opening;
    assert.equal(typeof result.sessionId, 'string');
    assert.notEqual(result.sessionId.trim(), '');
    await service.close(endpoint.id);
  }
});

test('serial status producer emits timestamp-aligned lifecycle logs accepted by the renderer adapter', ASYNC_TEST_OPTIONS, async () => {
  let wireStatusListener;
  const reports = [];
  const delivered = [];
  const produced = [];
  const adapter = createElectronRuntimeAdapter({
    runtimeName: 'electron',
    transport: {
      onStatus(listener) {
        wireStatusListener = listener;
        return () => { wireStatusListener = null; };
      },
    },
  }, (error) => reports.push(error));
  const unsubscribe = adapter.transport.onStatus((event) => delivered.push(event));
  let timestamp = 1_720_000_000_125;
  const { service } = createHarness({
    clock: () => {
      const value = timestamp;
      timestamp += 1;
      return value;
    },
    emitEvent(channel, payload) {
      if (channel !== 'transport:status') return;
      produced.push(payload);
      wireStatusListener(payload);
    },
  });

  const opening = service.open(serialEndpoint('contract'), { operationId: 'open-contract' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  await service.close('contract');

  assert.deepEqual(delivered.map(({ status }) => status), ['opening', 'open', 'closing', 'closed']);
  assert.deepEqual(reports, []);
  for (const event of produced) assert.equal(event.log.createdAt, event.createdAt, event.status);
  assert.deepEqual(produced.map(({ status, createdAt, log }) => ({ status, createdAt, log })), [
    {
      status: 'opening', createdAt: 1_720_000_000_125,
      log: {
        level: 'debug', source: 'serial', code: null,
        message: '正在打开串口: /dev/contract', details: { path: '/dev/contract' },
        createdAt: 1_720_000_000_125,
      },
    },
    {
      status: 'open', createdAt: 1_720_000_000_126,
      log: {
        level: 'info', source: 'serial', code: null,
        message: '串口已打开: /dev/contract', details: { path: '/dev/contract' },
        createdAt: 1_720_000_000_126,
      },
    },
    {
      status: 'closing', createdAt: 1_720_000_000_127,
      log: {
        level: 'debug', source: 'serial', code: null,
        message: '正在关闭串口: /dev/contract', details: { path: '/dev/contract' },
        createdAt: 1_720_000_000_127,
      },
    },
    {
      status: 'closed', createdAt: 1_720_000_000_128,
      log: {
        level: 'info', source: 'serial', code: null,
        message: '串口已关闭: /dev/contract', details: { path: '/dev/contract' },
        createdAt: 1_720_000_000_128,
      },
    },
  ]);
  unsubscribe();
  assert.equal(wireStatusListener, null);
});

test('serial failures emit operation-specific logs and suppress normal close after failure', ASYNC_TEST_OPTIONS, async () => {
  const cases = [
    {
      id: 'open-log-failure',
      trigger: async ({ service }) => {
        const opening = service.open(serialEndpoint('open-log-failure'), { operationId: 'open-log-failure' });
        const port = await waitForPort();
        port.failOpen(Object.assign(new Error('native open failed'), { code: 'EFAULT' }));
        await assert.rejects(opening, (error) => error.code === 'IO_ERROR');
      },
      intent: '打开串口失败',
    },
    {
      id: 'read-log-failure',
      trigger: async ({ service }) => {
        const opening = service.open(serialEndpoint('read-log-failure'), { operationId: 'read-log-failure' });
        const port = await waitForPort();
        port.succeedOpen();
        await opening;
        port.emit('error', Object.assign(new Error('native read failed'), { code: 'EFAULT' }));
        await new Promise((resolve) => setImmediate(resolve));
      },
      intent: '读取串口失败',
    },
    {
      id: 'write-log-failure',
      trigger: async ({ service }) => {
        const opening = service.open(serialEndpoint('write-log-failure'), { operationId: 'write-log-failure' });
        const port = await waitForPort();
        port.succeedOpen();
        await opening;
        port.writeError = Object.assign(new Error('native write failed'), { code: 'EFAULT' });
        await assert.rejects(
          service.send({ endpointId: 'write-log-failure', bytes: Uint8Array.of(1) }),
          (error) => error.code === 'IO_ERROR',
        );
        await new Promise((resolve) => setImmediate(resolve));
      },
      intent: '写入串口失败',
    },
  ];

  for (const { id, trigger, intent } of cases) {
    const harness = createHarness();
    await trigger(harness);
    const statuses = payloads(harness.events, 'transport:status');
    const failure = statuses.find(({ status }) => status === 'error');
    assert.equal(failure.log.level, 'error', id);
    assert.equal(failure.log.source, 'serial', id);
    assert.equal(failure.log.code, 'IO_ERROR', id);
    assert.match(failure.log.message, new RegExp(intent), id);
    assert.deepEqual(failure.log.details, { path: `/dev/${id}` }, id);
    assert.equal(failure.log.createdAt, failure.createdAt, id);
    assert.equal(statuses.at(-1).status, 'closed', id);
    assert.equal(statuses.at(-1).log, null, id);
  }
});

test('unexpected device removal emits a WARN disconnect log and no normal-close INFO', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const opening = service.open(serialEndpoint('removed-log'), { operationId: 'removed-log' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;

  port.isOpen = false;
  port.emit('close');

  const statuses = payloads(events, 'transport:status');
  const failure = statuses.find(({ status }) => status === 'error');
  assert.deepEqual(failure.log, {
    level: 'warn', source: 'serial', code: 'DEVICE_REMOVED',
    message: '串口意外断开: /dev/removed-log', details: { path: '/dev/removed-log' },
    createdAt: failure.createdAt,
  });
  assert.equal(statuses.at(-1).status, 'closed');
  assert.equal(statuses.at(-1).log, null);
});

test('cancelOpen rejects immediately and emits a logless terminal close when a port opens late', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const opening = service.open(serialEndpoint('cancel'), { operationId: 'operation-cancel' });
  const openingRejected = assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  const port = await waitForPort();

  const cancellation = service.cancelOpen('cancel', { operationId: 'operation-cancel' });
  await openingRejected;
  assert.deepEqual(payloads(events, 'transport:status').map(({ status }) => status), [
    'opening',
  ]);
  port.succeedOpen();
  assert.deepEqual(await cancellation, {
    endpointId: 'cancel', operationId: 'operation-cancel', cancelled: true,
  });

  assert.equal(port.closeCalls, 1);
  assert.equal(port.listenerCount('data'), 0);
  assert.equal(port.listenerCount('error'), 0);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status }) => status), [
    'opening', 'closed',
  ]);
  assert.deepEqual(payloads(events, 'transport:status').at(-1), {
    endpointId: 'cancel', operationId: 'operation-cancel', sessionId: null,
    status: 'closed', error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' },
    createdAt: 1_700_000_000_001, log: null,
  });
});

test('cancelled late-open close failure stays managed until a later close succeeds', ASYNC_TEST_OPTIONS, async () => {
  const { service, events, timers } = createHarness();
  const opening = service.open(serialEndpoint('cancel-retry'), { operationId: 'operation-cancel-retry' });
  const openingRejected = assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  const port = await waitForPort();
  port.autoFinishClose = false;

  const cancellation = service.cancelOpen('cancel-retry', { operationId: 'operation-cancel-retry' });
  port.succeedOpen();
  assert.equal(port.closeCalls, 1);
  port.finishClose(Object.assign(new Error('late close failed'), { code: 'EFAULT' }));
  await assert.rejects(cancellation, (error) => error.code === 'IO_ERROR');
  await openingRejected;

  assert.equal(port.isOpen, true);
  assert.equal(timers.size, 0);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status, error }) => [
    status, error?.code ?? null,
  ]), [
    ['opening', null], ['error', 'IO_ERROR'],
  ]);

  const retry = service.close('cancel-retry');
  assert.equal(port.closeCalls, 2);
  port.finishClose();
  assert.deepEqual(await retry, { endpointId: 'cancel-retry', closed: true });

  assert.equal(port.isOpen, false);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status, error }) => [
    status, error?.code ?? null,
  ]), [
    ['opening', null], ['error', 'IO_ERROR'], ['closed', null],
  ]);
  assert.deepEqual(await service.close('cancel-retry'), {
    endpointId: 'cancel-retry', closed: false,
  });
});

test('cancel and shutdown wait for pending native open and its failed late close', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const opening = service.open(serialEndpoint('opening-barrier'), { operationId: 'open-barrier' });
  const openingRejected = assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  const port = await waitForPort();
  port.autoFinishClose = false;
  let cancelSettled = false;
  let shutdownSettled = false;

  const cancellation = service.cancelOpen('opening-barrier', { operationId: 'open-barrier' });
  cancellation.then(
    () => { cancelSettled = true; },
    () => { cancelSettled = true; },
  );
  const shutdown = service.shutdown();
  shutdown.then(
    () => { shutdownSettled = true; },
    () => { shutdownSettled = true; },
  );
  await Promise.resolve();

  assert.equal(cancelSettled, false);
  assert.equal(shutdownSettled, false);
  assert.equal(port.closeCalls, 0);
  port.succeedOpen();
  assert.equal(port.closeCalls, 1);
  await Promise.resolve();
  assert.equal(cancelSettled, false);
  assert.equal(shutdownSettled, false);

  port.finishClose(Object.assign(new Error('late close failed'), { code: 'EFAULT' }));
  await assert.rejects(cancellation, (error) => error.code === 'IO_ERROR');
  await assert.rejects(shutdown, (error) => error.code === 'IO_ERROR');
  await openingRejected;
  assert.equal(port.isOpen, true);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status, error }) => [
    status, error?.code ?? null,
  ]), [
    ['opening', null], ['error', 'IO_ERROR'],
  ]);

  const retry = service.close('opening-barrier');
  assert.equal(port.closeCalls, 2);
  port.finishClose();
  assert.deepEqual(await retry, { endpointId: 'opening-barrier', closed: true });
  assert.deepEqual(await service.close('opening-barrier'), {
    endpointId: 'opening-barrier', closed: false,
  });
});

test('cancel joins an opening barrier already started by shutdown', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  const opening = service.open(serialEndpoint('shutdown-first'), { operationId: 'open-shutdown-first' });
  const openingRejected = assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  const port = await waitForPort();
  const shutdown = service.shutdown();
  const cancellation = service.cancelOpen('shutdown-first', { operationId: 'open-shutdown-first' });
  let cancelSettled = false;
  cancellation.then(
    () => { cancelSettled = true; },
    () => { cancelSettled = true; },
  );
  await Promise.resolve();
  assert.equal(cancelSettled, false);

  port.succeedOpen();
  assert.deepEqual(await cancellation, {
    endpointId: 'shutdown-first', operationId: 'open-shutdown-first', cancelled: true,
  });
  await shutdown;
  await openingRejected;
  assert.equal(port.closeCalls, 1);
  assert.equal(port.isOpen, false);
});

test('event observer failures cannot interrupt open, close, or shutdown state transitions', ASYNC_TEST_OPTIONS, async () => {
  const observerError = new Error('renderer event observer failed');
  const reports = [];
  const { service, timers } = createHarness({
    emitEvent() { throw observerError; },
    reportEventError(error, context) { reports.push({ error, context }); },
  });

  let firstOpening;
  assert.doesNotThrow(() => {
    firstOpening = service.open(serialEndpoint('observer-close'), { operationId: 'observer-close-open' });
  });
  const firstPort = await waitForPort(0);
  firstPort.succeedOpen();
  await firstOpening;
  assert.deepEqual(await service.close('observer-close'), {
    endpointId: 'observer-close', closed: true,
  });

  const secondOpening = service.open(
    serialEndpoint('observer-shutdown'),
    { operationId: 'observer-shutdown-open' },
  );
  const secondPort = await waitForPort(1);
  secondPort.succeedOpen();
  await secondOpening;
  await service.shutdown();

  assert.equal(timers.size, 0);
  for (const port of [firstPort, secondPort]) {
    assert.equal(port.isOpen, false);
    for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  }
  assert.deepEqual(await service.close('observer-close'), {
    endpointId: 'observer-close', closed: false,
  });
  assert.ok(reports.length >= 8);
  assert.equal(reports.every(({ error }) => error === observerError), true);
  assert.equal(reports.every(({ context }) => context.channel === 'transport:status'), true);
});

test('multiple endpoints remain independent and receive fresh input byte arrays', ASYNC_TEST_OPTIONS, async () => {
  const received = [];
  const { service, timers } = createHarness({
    framerFactory: ({ endpoint, emitFrame }) => ({
      push(bytes) {
        received.push({ endpointId: endpoint.id, bytes });
        emitFrame(bytes);
      },
      flush() {},
      reset() {},
    }),
  });
  const firstOpening = service.open(serialEndpoint('first'), { operationId: 'open-first' });
  const firstPort = await waitForPort(0);
  const secondOpening = service.open(serialEndpoint('second'), { operationId: 'open-second' });
  const secondPort = await waitForPort(1);
  firstPort.succeedOpen();
  secondPort.succeedOpen();
  const [first, second] = await Promise.all([firstOpening, secondOpening]);

  const firstBytes = Buffer.from([1, 2]);
  const secondBytes = Buffer.from([3, 4]);
  firstPort.emit('data', firstBytes);
  secondPort.emit('data', secondBytes);
  firstBytes[0] = 99;
  secondBytes[0] = 99;
  timers.runAll();

  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(received.map(({ endpointId, bytes }) => [
    endpointId,
    Buffer.isBuffer(bytes),
    Object.getPrototypeOf(bytes) === Uint8Array.prototype,
    [...bytes],
  ]), [
    ['first', false, true, [1, 2]],
    ['second', false, true, [3, 4]],
  ]);
  await service.closeAll();
});

test('framed receive emits strict plain wire batches after 200ms or 200 frames', ASYNC_TEST_OPTIONS, async () => {
  let pending = new Uint8Array();
  const { service, events, timers } = createHarness({
    framerFactory: ({ emitFrame }) => ({
      push(bytes) {
        const next = new Uint8Array(pending.length + bytes.length);
        next.set(pending);
        next.set(bytes, pending.length);
        pending = next;
        while (pending.length >= 2) {
          emitFrame(pending.slice(0, 2));
          pending = pending.slice(2);
        }
      },
      flush() {},
      reset() { pending = new Uint8Array(); },
    }),
  });
  const opening = service.open(serialEndpoint('framed'), { operationId: 'open-framed' });
  const port = await waitForPort();
  port.succeedOpen();
  const opened = await opening;

  port.emit('data', Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(timers.delays(), [200]);
  assert.equal(payloads(events, 'transport:frames').length, 0);
  timers.runAll();
  assert.deepEqual(payloads(events, 'transport:frames'), [{
    endpointId: 'framed',
    operationId: 'open-framed',
    sessionId: opened.sessionId,
    frames: [
      { direction: 'in', bytes: [1, 2], createdAt: 1_700_000_000_002 },
      { direction: 'in', bytes: [3, 4], createdAt: 1_700_000_000_003 },
    ],
  }]);

  for (let index = 0; index < 200; index += 1) port.emit('data', Buffer.from([index & 0xff, 0]));
  assert.equal(payloads(events, 'transport:frames').at(-1).frames.length, 200);
  assert.equal(timers.size, 0);
  await service.close('framed');
});

test('production default framer maps raw, delimiter, fixed, and idle modes', ASYNC_TEST_OPTIONS, async () => {
  const cases = [
    [{ mode: 'raw' }, [1, 2, 3, 4], [[1, 2, 3, 4]]],
    [{ mode: 'delimiter', delimiterBytes: [10] }, [1, 10, 2, 10], [[1], [2]]],
    [{ mode: 'fixed', length: 2 }, [1, 2, 3, 4], [[1, 2], [3, 4]]],
    [{ mode: 'idle', idleMs: 25 }, [1, 2, 3, 4], [[1, 2, 3, 4]]],
  ];

  for (const [index, [receiveFraming, input, expectedFrames]] of cases.entries()) {
    const { service, events, timers } = createHarness({ framerFactory: undefined });
    const endpoint = serialEndpoint(`default-framer-${index}`, { receiveFraming });
    const opening = service.open(endpoint, { operationId: `open-default-framer-${index}` });
    const port = await waitForPort();
    port.succeedOpen();
    await opening;
    port.emit('data', Buffer.from(input));

    if (receiveFraming.mode === 'idle') assert.deepEqual(timers.delays(), [25]);
    timers.runAll();
    timers.runAll();
    const frames = payloads(events, 'transport:frames').flatMap((batch) => batch.frames);
    assert.deepEqual(frames.map(({ bytes }) => bytes), expectedFrames, receiveFraming.mode);
    await service.close(endpoint.id);
  }
});

test('production default framer rejects malformed mode configuration before native open', ASYNC_TEST_OPTIONS, async () => {
  const sparseDelimiter = new Array(1);
  const invalidConfigurations = [
    { mode: 'unknown' },
    { mode: 'delimiter', delimiterBytes: [] },
    { mode: 'delimiter', delimiterBytes: [256] },
    { mode: 'delimiter', delimiterBytes: sparseDelimiter },
    { mode: 'fixed', length: 0 },
    { mode: 'fixed', length: 1.5 },
    { mode: 'idle', idleMs: 0 },
  ];

  for (const [index, receiveFraming] of invalidConfigurations.entries()) {
    const { service } = createHarness({ framerFactory: undefined });
    const opening = service.open(
      serialEndpoint(`invalid-framer-${index}`, { receiveFraming }),
      { operationId: `open-invalid-framer-${index}` },
    );
    const outcome = await Promise.race([
      opening.then(
        () => ({ resolved: true }),
        (error) => ({ error }),
      ),
      waitForPort().then((port) => ({ port })),
    ]);
    if (outcome.port) {
      outcome.port.failOpen(new Error('native open should not be reached'));
      await opening.catch(() => {});
      assert.fail(`native port constructed for ${JSON.stringify(receiveFraming)}`);
    }
    assert.equal(outcome.error?.code, 'IO_ERROR');
    assert.equal(FakeSerialPort.instances.length, 0);
  }
});

test('simulator responses from an old session cannot write to the current serial port', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  const opening = service.open(serialEndpoint('simulator'), { operationId: 'open-new' });
  const port = await waitForPort(); port.succeedOpen();
  const opened = await opening;
  await assert.rejects(service.send({ endpointId: 'simulator', bytes: Uint8Array.of(0x68),
    target: { expectedSessionId: 'serial-old' } }), { code: 'OPEN_CANCELLED' });
  assert.equal(port.writes.length, 0);
  await service.send({ endpointId: 'simulator', bytes: Uint8Array.of(0x68), target: { expectedSessionId: opened.sessionId } });
  assert.equal(port.writes.length, 1);
  await service.close('simulator');
});

test('send writes copied binary bytes and publishes an outgoing wire frame', ASYNC_TEST_OPTIONS, async () => {
  const { service, events, timers } = createHarness();
  const opening = service.open(serialEndpoint('send'), { operationId: 'open-send' });
  const port = await waitForPort();
  port.succeedOpen();
  const opened = await opening;
  const bytes = Uint8Array.of(0, 128, 255);

  assert.deepEqual(await service.send({ endpointId: 'send', bytes }), {
    endpointId: 'send', sessionId: opened.sessionId, byteCount: 3,
  });
  bytes[0] = 42;
  timers.runAll();

  assert.deepEqual([...port.writes[0]], [0, 128, 255]);
  assert.deepEqual(payloads(events, 'transport:frames').at(-1).frames, [
    { direction: 'out', bytes: [0, 128, 255], createdAt: 1_700_000_000_002 },
  ]);
  await service.close('send');
});

test('concurrent serial sends publish frames in actual write order despite delayed drains', ASYNC_TEST_OPTIONS, async () => {
  const { service, events, timers } = createHarness();
  const opening = service.open(serialEndpoint('send-order'), { operationId: 'open-order' });
  const port = await waitForPort();
  port.succeedOpen(); await opening;
  let drains = 0;
  port.drain = (callback) => { drains++; setTimeout(callback, drains === 1 ? 20 : 0); };
  await Promise.all([1, 2, 3].map(value => service.send({ endpointId: 'send-order', bytes: [value] })));
  timers.runAll();
  const outgoing = payloads(events, 'transport:frames').flatMap(batch => batch.frames).filter(frame => frame.direction === 'out').map(frame => frame.bytes);
  assert.deepEqual(outgoing, port.writes.map(bytes => [...bytes]));
  assert.deepEqual(outgoing, [[1], [2], [3]]);
  await service.close('send-order');
});

test('closing a serial session rejects its queued sends before another write', ASYNC_TEST_OPTIONS, async () => {
  const { service } = createHarness();
  const opening = service.open(serialEndpoint('queued-close'), { operationId: 'open-queued' });
  const port = await waitForPort(); port.succeedOpen(); await opening;
  const drains = [];
  port.drain = callback => drains.push(callback);
  const outcomes = Promise.allSettled([1, 2].map(value => service.send({ endpointId: 'queued-close', bytes: [value] })));
  await new Promise(resolve => setImmediate(resolve));
  await service.close('queued-close');
  for (const callback of drains) callback(null);
  const results = await outcomes;
  assert.equal(port.writes.length, 1);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'IO_ERROR');
});

test('close flushes batches and removes listeners, timers, and session resources', ASYNC_TEST_OPTIONS, async () => {
  let resets = 0;
  const { service, events, timers } = createHarness({
    framerFactory: ({ emitFrame }) => ({
      push: emitFrame,
      flush() {},
      reset() { resets += 1; },
    }),
  });
  const opening = service.open(serialEndpoint('close'), { operationId: 'open-close' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  port.emit('data', Buffer.from([9]));
  assert.equal(timers.size, 1);

  assert.deepEqual(await service.close('close'), { endpointId: 'close', closed: true });

  assert.equal(resets, 1);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  assert.deepEqual(payloads(events, 'transport:status').map(({ status }) => status), [
    'opening', 'open', 'closing', 'closed',
  ]);
  assert.deepEqual(await service.close('close'), { endpointId: 'close', closed: false });
});

test('failed close retains an open port for a successful retry without duplicate failure events', ASYNC_TEST_OPTIONS, async () => {
  const { service, events, timers } = createHarness();
  const opening = service.open(serialEndpoint('retry-close'), { operationId: 'open-retry-close' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  port.emit('data', Buffer.from([7]));
  port.autoFinishClose = false;

  const firstClose = service.close('retry-close');
  assert.equal(port.closeCalls, 1);
  port.finishClose(Object.assign(new Error('native close failed'), { code: 'EFAULT' }));
  await assert.rejects(firstClose, (error) => error.code === 'IO_ERROR');

  assert.equal(port.isOpen, true);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 1);
  assert.deepEqual(payloads(events, 'transport:status').slice(2)
    .map(({ status, error }) => [status, error?.code ?? null]), [
    ['closing', null], ['error', 'IO_ERROR'],
  ]);

  const secondClose = service.close('retry-close');
  assert.equal(port.closeCalls, 2);
  port.finishClose();
  assert.deepEqual(await secondClose, { endpointId: 'retry-close', closed: true });

  assert.equal(port.isOpen, false);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  assert.deepEqual(payloads(events, 'transport:status').slice(2)
    .map(({ status, error }) => [status, error?.code ?? null]), [
    ['closing', null], ['error', 'IO_ERROR'], ['closed', null],
  ]);
  assert.deepEqual(await service.close('retry-close'), {
    endpointId: 'retry-close', closed: false,
  });
});

test('unexpected device removal emits one error/closed cycle and cleans listeners', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const opening = service.open(serialEndpoint('removed'), { operationId: 'open-removed' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;

  port.isOpen = false;
  port.emit('close');
  port.emit('close');

  const terminal = payloads(events, 'transport:status').slice(2);
  assert.deepEqual(terminal.map(({ status, error }) => [status, error?.code ?? null]), [
    ['error', 'DEVICE_REMOVED'], ['closed', null],
  ]);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
});

test('repeated I/O signals produce only one failure status group', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const opening = service.open(serialEndpoint('io'), { operationId: 'open-io' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;

  const error = Object.assign(new Error('write failed'), { code: 'EIO' });
  port.emit('error', error);
  port.emit('error', error);
  port.emit('close');

  const terminal = payloads(events, 'transport:status').slice(2);
  assert.equal(terminal.filter(({ status }) => status === 'error').length, 1);
  assert.equal(terminal.filter(({ status }) => status === 'closed').length, 1);
  assert.equal(terminal[0].error.code, 'DEVICE_REMOVED');
});

test('automatic I/O close, explicit close, and shutdown share one native close operation', ASYNC_TEST_OPTIONS, async () => {
  const { service, events, timers } = createHarness();
  const opening = service.open(serialEndpoint('single-close'), { operationId: 'open-single-close' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  port.autoFinishClose = false;

  port.emit('error', Object.assign(new Error('read failed'), { code: 'EIO' }));
  const explicitClose = service.close('single-close');
  const shutdown = service.shutdown();

  assert.equal(port.closeCalls, 1);
  port.finishClose();
  assert.deepEqual(await explicitClose, { endpointId: 'single-close', closed: true });
  await shutdown;

  assert.equal(port.closeCalls, 1);
  assert.equal(port.isOpen, false);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  assert.deepEqual(payloads(events, 'transport:status').slice(2)
    .map(({ status, error }) => [status, error?.code ?? null]), [
    ['error', 'DEVICE_REMOVED'], ['closed', null],
  ]);
  assert.deepEqual(await service.close('single-close'), {
    endpointId: 'single-close', closed: false,
  });
});

test('write callback failures close the session through one I/O failure cycle', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const opening = service.open(serialEndpoint('write-error'), { operationId: 'open-write-error' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  port.writeError = Object.assign(new Error('native write failed'), { code: 'EIO' });

  await assert.rejects(
    service.send({ endpointId: 'write-error', bytes: Uint8Array.of(1) }),
    (error) => error.code === 'DEVICE_REMOVED',
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(port.closeCalls, 1);
  assert.deepEqual(payloads(events, 'transport:status').slice(2)
    .map(({ status, error }) => [status, error?.code ?? null]), [
    ['error', 'DEVICE_REMOVED'], ['closed', null],
  ]);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
});

test('shutdown retries an automatic failure close that left the port open', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const opening = service.open(serialEndpoint('shutdown-retry'), { operationId: 'open-shutdown-retry' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  port.autoFinishClose = false;
  port.writeError = Object.assign(new Error('native write failed'), { code: 'EIO' });

  await assert.rejects(
    service.send({ endpointId: 'shutdown-retry', bytes: Uint8Array.of(1) }),
    (error) => error.code === 'DEVICE_REMOVED',
  );
  assert.equal(port.closeCalls, 1);
  port.finishClose(Object.assign(new Error('native close failed'), { code: 'EFAULT' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(port.isOpen, true);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 1);
  const shutdown = service.shutdown();
  assert.equal(port.closeCalls, 2);
  port.finishClose();
  await shutdown;

  assert.equal(port.isOpen, false);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  assert.deepEqual(payloads(events, 'transport:status').slice(2)
    .map(({ status, error }) => [status, error?.code ?? null]), [
    ['error', 'DEVICE_REMOVED'], ['closed', null],
  ]);
});

test('a failed shutdown remains stopped but a later shutdown retries tracked ports', ASYNC_TEST_OPTIONS, async () => {
  const { service, events, timers } = createHarness();
  const opening = service.open(serialEndpoint('shutdown-twice'), { operationId: 'open-shutdown-twice' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  port.autoFinishClose = false;

  const firstShutdown = service.shutdown();
  assert.equal(port.closeCalls, 1);
  port.finishClose(Object.assign(new Error('first shutdown failed'), { code: 'EFAULT' }));
  await assert.rejects(firstShutdown, (error) => error.code === 'IO_ERROR');

  assert.equal(port.isOpen, true);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 1);
  await assert.rejects(
    service.open(serialEndpoint('blocked-after-shutdown'), { operationId: 'blocked-open' }),
    (error) => error.code === 'IO_ERROR',
  );

  const secondShutdown = service.shutdown();
  assert.equal(port.closeCalls, 2);
  port.finishClose();
  await secondShutdown;

  assert.equal(port.isOpen, false);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  assert.deepEqual(payloads(events, 'transport:status').slice(2)
    .map(({ status, error }) => [status, error?.code ?? null]), [
    ['closing', null], ['error', 'IO_ERROR'], ['closed', null],
  ]);
  assert.deepEqual(await service.close('shutdown-twice'), {
    endpointId: 'shutdown-twice', closed: false,
  });
});

test('forceShutdown settles a pending native open and destroys its untracked port', ASYNC_TEST_OPTIONS, async () => {
  let resets = 0;
  const { service, timers } = createHarness({
    framerFactory: () => ({
      push() {},
      flush() {},
      reset() { resets += 1; },
    }),
  });
  const opening = service.open(serialEndpoint('force-opening'), { operationId: 'force-opening-op' });
  const openingRejected = assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  const port = await waitForPort();
  let destroyCalls = 0;
  port.destroy = () => {
    destroyCalls += 1;
    port.isOpen = false;
  };
  const shutdown = service.shutdown();
  let shutdownSettled = false;
  shutdown.then(
    () => { shutdownSettled = true; },
    () => { shutdownSettled = true; },
  );
  await Promise.resolve();
  assert.equal(shutdownSettled, false);

  assert.deepEqual(service.forceShutdown(), { forced: 1 });
  await shutdown;
  await openingRejected;

  assert.equal(shutdownSettled, true);
  assert.equal(destroyCalls, 1);
  assert.equal(resets, 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(await service.close('force-opening'), {
    endpointId: 'force-opening', closed: false,
  });

  port.succeedOpen();
  await Promise.resolve();
  assert.equal(destroyCalls, 2);
  assert.equal(port.isOpen, false);
});

test('forceShutdown settles a pending native close and clears listeners and timers', ASYNC_TEST_OPTIONS, async () => {
  let resets = 0;
  const { service, timers } = createHarness({
    framerFactory: ({ emitFrame }) => ({
      push: emitFrame,
      flush() {},
      reset() { resets += 1; },
    }),
  });
  const opening = service.open(serialEndpoint('force-closing'), { operationId: 'force-closing-op' });
  const port = await waitForPort();
  port.succeedOpen();
  await opening;
  port.emit('data', Buffer.from([1]));
  port.autoFinishClose = false;
  let destroyCalls = 0;
  port.destroy = () => {
    destroyCalls += 1;
    port.isOpen = false;
  };
  const shutdown = service.shutdown();
  assert.equal(port.closeCalls, 1);
  assert.equal(timers.size, 0);

  assert.deepEqual(service.forceShutdown(), { forced: 1 });
  await shutdown;

  assert.equal(destroyCalls, 1);
  assert.equal(resets, 1);
  assert.equal(port.isOpen, false);
  assert.equal(timers.size, 0);
  for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  assert.deepEqual(await service.close('force-closing'), {
    endpointId: 'force-closing', closed: false,
  });

  port.finishClose();
  await Promise.resolve();
  assert.equal(destroyCalls, 1);
});

test('open failures map native errors to the fixed serial error codes', ASYNC_TEST_OPTIONS, async () => {
  const { service, events } = createHarness();
  const cases = [
    ['ENOENT', 'PORT_NOT_FOUND'],
    ['EBUSY', 'PORT_BUSY'],
    ['EACCES', 'PERMISSION_DENIED'],
  ];

  for (const [index, [nativeCode, expectedCode]] of cases.entries()) {
    const opening = service.open(serialEndpoint(`failure-${index}`), { operationId: `open-failure-${index}` });
    const port = await waitForPort(index);
    port.failOpen(Object.assign(new Error(nativeCode), { code: nativeCode }));
    await assert.rejects(opening, (error) => error.code === expectedCode);
  }

  assert.deepEqual(payloads(events, 'transport:status')
    .filter(({ status }) => status === 'error')
    .map(({ error }) => error.code), cases.map(([, code]) => code));
});

test('post-open EIO maps to device removal only on POSIX runtimes', () => {
  const reason = Object.assign(new Error('native EIO'), { code: 'EIO' });
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.equal(mapSerialError(reason, { open: false, platform }).code, 'DEVICE_REMOVED');
  }
  assert.equal(mapSerialError(reason, { open: false, platform: 'win32' }).code, 'IO_ERROR');
  assert.equal(mapSerialError(reason, { open: true, platform: 'darwin' }).code, 'IO_ERROR');
});

test('shutdown closes every endpoint and leaves no live listeners or timers', ASYNC_TEST_OPTIONS, async () => {
  const { service, timers } = createHarness();
  const first = service.open(serialEndpoint('shutdown-a'), { operationId: 'open-a' });
  const firstPort = await waitForPort(0);
  const second = service.open(serialEndpoint('shutdown-b'), { operationId: 'open-b' });
  const secondPort = await waitForPort(1);
  firstPort.succeedOpen();
  secondPort.succeedOpen();
  await Promise.all([first, second]);
  firstPort.emit('data', Buffer.from([1]));

  await service.shutdown();

  assert.equal(firstPort.closeCalls, 1);
  assert.equal(secondPort.closeCalls, 1);
  assert.equal(timers.size, 0);
  for (const port of [firstPort, secondPort]) {
    for (const event of ['data', 'error', 'close']) assert.equal(port.listenerCount(event), 0);
  }
});

test('coordinator resolves persisted serial profiles and delegates lifecycle shutdown', ASYNC_TEST_OPTIONS, async () => {
  const calls = [];
  const serialService = {
    scan: async () => ['ports'],
    open: async (...args) => { calls.push(['open', ...args]); return { sessionId: 'session-1' }; },
    cancelOpen: async (...args) => { calls.push(['cancel', ...args]); return { cancelled: true }; },
    close: async (...args) => { calls.push(['close', ...args]); return { closed: true }; },
    send: async (...args) => { calls.push(['send', ...args]); return { byteCount: 1 }; },
    closeAll: async () => { calls.push(['closeAll']); },
    shutdown: async () => { calls.push(['shutdown']); },
    forceShutdown: () => { calls.push(['forceShutdown']); return { forced: 0 }; },
  };
  const endpoint = serialEndpoint('persisted');
  const database = { listEndpoints: () => [endpoint, { ...serialEndpoint('tcp'), transport: 'tcp-client' }] };
  const persistence = {
    flush: async () => { calls.push(['flushPersistence']); },
  };
  const coordinator = new TransportCoordinator({ serialService, database, persistence });

  assert.deepEqual(await coordinator.scanSerialPorts(), ['ports']);
  assert.deepEqual(await coordinator.open('persisted', { operationId: 'open-1' }), { sessionId: 'session-1' });
  assert.deepEqual(calls[0], ['open', endpoint, { operationId: 'open-1' }]);
  await assert.rejects(coordinator.open('missing', { operationId: 'open-2' }), (error) => error.code === 'PORT_NOT_FOUND');
  await assert.rejects(coordinator.open('tcp', { operationId: 'open-3' }), (error) => error.code === 'IO_ERROR');
  await coordinator.cancelOpen('persisted', { operationId: 'open-1' });
  await coordinator.closeEndpoint('persisted');
  await coordinator.send({ endpointId: 'persisted', bytes: [1] });
  await coordinator.closeAll();
  await coordinator.flushPersistence();
  await coordinator.shutdown();
  assert.deepEqual(await coordinator.forceShutdown(), { forced: 0 });
  assert.deepEqual(calls.slice(1).map(([name]) => name), [
    'cancel', 'close', 'flushPersistence', 'send', 'closeAll', 'flushPersistence',
    'shutdown', 'flushPersistence', 'forceShutdown', 'flushPersistence',
  ]);
  assert.deepEqual(calls.slice(-4).map(([name]) => name), [
    'shutdown', 'flushPersistence', 'forceShutdown', 'flushPersistence',
  ]);
});

test('transport coordinator routes DL/T 645 master and simulator lifecycle through serial service', async () => {
  const calls = [];
  const master = {
    id: 'meter-bus-1',
    transport: 'dlt645-master',
    config: { path: '/dev/ttyUSB0', baudRate: 2400, dataBits: 8, parity: 'even', stopBits: 1 },
  };
  const simulator = { ...master, id: 'meter-simulator-1', transport: 'dlt645-slave' };
  const serialService = {
    open: async (...args) => { calls.push(['open', ...args]); return { sessionId: 'meter-session' }; },
    cancelOpen: async (...args) => { calls.push(['cancel', ...args]); return { cancelled: true }; },
    send: async (...args) => { calls.push(['send', ...args]); return { byteCount: 16 }; },
    close: async (...args) => { calls.push(['close', ...args]); return { closed: true }; },
  };
  const coordinator = new TransportCoordinator({
    serialService,
    database: { listEndpoints: () => [master, simulator] },
  });
  const expectedCalls = [];
  for (const endpoint of [master, simulator]) {
    const options = { operationId: `open-${endpoint.id}` };
    const request = { endpointId: endpoint.id, bytes: [0x68, 0x12, 0x90, 0x68, 0x11] };
    assert.deepEqual(await coordinator.open(endpoint.id, options), { sessionId: 'meter-session' });
    assert.deepEqual(await coordinator.cancelOpen(endpoint.id, options), { cancelled: true });
    assert.deepEqual(await coordinator.send(request), { byteCount: 16 });
    assert.deepEqual(await coordinator.close(endpoint.id), { closed: true });
    expectedCalls.push(
      ['open', { ...endpoint, transport: 'serial' }, options],
      ['cancel', endpoint.id, options],
      ['send', request],
      ['close', endpoint.id],
    );
  }
  assert.deepEqual(calls, [
    ...expectedCalls,
  ]);
});

test('coordinator closeAll uses reusable transport cleanup instead of permanent shutdown', async () => {
  const calls = [];
  const service = (name) => ({
    closeAll: async () => { calls.push(`${name}:closeAll`); },
    shutdown: async () => { calls.push(`${name}:shutdown`); },
  });
  const coordinator = new TransportCoordinator({
    serialService: service('serial'),
    tcpService: service('tcp'),
    udpService: service('udp'),
    database: { listEndpoints: () => [] },
  });

  await coordinator.closeAll();

  assert.deepEqual(calls, ['serial:closeAll', 'tcp:closeAll', 'udp:closeAll']);
});

test('transport coordinator routes TCP endpoints and keeps UDP unavailable', ASYNC_TEST_OPTIONS, async () => {
  const tcpService = {
    open: async (endpoint, options) => ({ sessionId: `${endpoint.id}-session`, operationId: options.operationId }),
    close: async (endpointId) => ({ closed: true, endpointId }),
    send: async (request) => ({ sent: request.bytes.length }),
    disconnectPeer: async (endpointId, peerId) => ({ disconnected: true, endpointId, peerId }),
    shutdown: async () => {},
    forceShutdown: async () => [],
  };
  const coordinator = new TransportCoordinator({
    serialService: {
      scan: async () => [],
      open: async () => { throw new Error('serial open should not be used'); },
      cancelOpen: async () => {},
      close: async () => ({ closed: true }),
      send: async () => ({ byteCount: 0 }),
      closeAll: async () => {},
      shutdown: async () => {},
      forceShutdown: () => ({ forced: 0 }),
    },
    tcpService,
    database: {
      listEndpoints: () => [
        { id: 'tcp-client-1', transport: 'tcp-client', config: {} },
        { id: 'udp-client-1', transport: 'udp-client', config: {} },
      ],
    },
  });

  assert.equal((await coordinator.open('tcp-client-1', { operationId: 'open-tcp' })).sessionId, 'tcp-client-1-session');
  assert.deepEqual(await coordinator.send({ endpointId: 'tcp-client-1', bytes: [1, 2] }), { sent: 2 });
  assert.deepEqual(await coordinator.close('tcp-client-1'), { closed: true, endpointId: 'tcp-client-1' });
  assert.deepEqual(await coordinator.disconnectPeer({ endpointId: 'tcp-client-1', peerId: 'peer-1' }), {
    disconnected: true, endpointId: 'tcp-client-1', peerId: 'peer-1',
  });
  await assert.rejects(coordinator.open('udp-client-1', { operationId: 'open-udp' }), (error) => error.code === 'IO_ERROR');
});

test('coordinator shuts down serial, flushes, disposes persistence, and isolates cleanup errors', async () => {
  const calls = [];
  const serialError = new Error('serial close failed');
  const persistenceError = new Error('persistence flush failed');
  const serialService = {
    shutdown: async () => { calls.push('serial'); throw serialError; },
  };
  const persistence = {
    flush: async () => { calls.push('flush'); throw persistenceError; },
    dispose: async () => { calls.push('dispose'); throw new Error('dispose failed'); },
  };
  const coordinator = new TransportCoordinator({
    serialService,
    database: { listEndpoints: () => [] },
    persistence,
  });

  await assert.rejects(coordinator.shutdown(), (error) => error === serialError);
  assert.deepEqual(calls, ['serial', 'flush', 'dispose']);
  await assert.rejects(coordinator.shutdown(), (error) => error === serialError);
  assert.deepEqual(calls, ['serial', 'flush', 'dispose', 'serial', 'flush']);
});

test('coordinator retries a rejected shutdown without repeating a completed dispose', async () => {
  const calls = [];
  let shutdownCalls = 0;
  const serialService = {
    shutdown: async () => {
      shutdownCalls += 1;
      calls.push(`serial-${shutdownCalls}`);
      if (shutdownCalls === 1) throw new Error('first shutdown failed');
    },
  };
  const persistence = {
    flush: async () => { calls.push('flush'); },
    dispose: async () => { calls.push('dispose'); },
  };
  const coordinator = new TransportCoordinator({
    serialService,
    database: { listEndpoints: () => [] },
    persistence,
  });

  await assert.rejects(coordinator.shutdown(), /first shutdown failed/);
  await assert.doesNotReject(coordinator.shutdown());
  await assert.doesNotReject(coordinator.shutdown());

  assert.equal(shutdownCalls, 2);
  assert.deepEqual(calls, ['serial-1', 'flush', 'dispose', 'serial-2', 'flush']);
});

test('coordinator force cleanup flushes before dispose and isolates persistence errors', async () => {
  const calls = [];
  const persistence = {
    flush: async () => { calls.push('flush'); throw new Error('flush failed'); },
    dispose: async () => { calls.push('dispose'); throw new Error('dispose failed'); },
  };
  const coordinator = new TransportCoordinator({
    serialService: {
      forceShutdown: async () => { calls.push('force-serial'); throw new Error('force failed'); },
    },
    database: { listEndpoints: () => [] },
    persistence,
  });

  await assert.doesNotReject(coordinator.forceShutdown());
  assert.deepEqual(calls, ['force-serial', 'flush', 'dispose']);
  await assert.doesNotReject(coordinator.forceShutdown());
  assert.deepEqual(calls, ['force-serial', 'flush', 'dispose']);
});

test('coordinator force cleanup flushes before dispose when superseding a pending shutdown', async () => {
  const calls = [];
  let resolveSerial;
  const serialService = {
    shutdown: () => new Promise((resolve) => { resolveSerial = resolve; }),
    forceShutdown: async () => { calls.push('force-serial'); },
  };
  const persistence = {
    flush: async () => { calls.push('flush'); },
    dispose: async () => { calls.push('dispose'); },
  };
  const coordinator = new TransportCoordinator({
    serialService,
    database: { listEndpoints: () => [] },
    persistence,
  });

  const graceful = coordinator.shutdown();
  const forced = coordinator.forceShutdown();
  await forced;
  resolveSerial();
  await graceful;

  assert.deepEqual(calls, ['force-serial', 'flush', 'dispose']);
});

test('renderer adapter expands strict wire batches and isolates frame bytes', () => {
  let frameListener;
  let statusListener;
  const adapter = createElectronRuntimeAdapter({
    runtimeName: 'electron',
    transport: {
      onFrames(listener) { frameListener = listener; return () => { frameListener = null; }; },
      onStatus(listener) { statusListener = listener; return () => { statusListener = null; }; },
    },
  });
  const frames = [];
  const statuses = [];
  const unsubscribeFrames = adapter.transport.onFrames((event) => frames.push(event));
  const unsubscribeStatus = adapter.transport.onStatus((event) => statuses.push(event));
  const wireBytes = [0, 128, 255];
  const wireLogDetails = { path: '/dev/ttyUSB0', settings: [115200, true] };
  frameListener({
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: wireBytes, createdAt: 1 }],
  });
  statusListener({
    endpointId: 'serial-1', operationId: 'open-1', sessionId: null,
    status: 'opening', error: null, createdAt: 2,
    log: {
      level: 'debug', source: 'serial', code: null,
      message: '正在打开串口: /dev/ttyUSB0', details: wireLogDetails, createdAt: 2,
    },
  });
  wireBytes[0] = 42;
  wireLogDetails.path = 'mutated';

  assert.deepEqual(frames[0], {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    frames: [{
      endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
      direction: 'in', bytes: Uint8Array.of(0, 128, 255), createdAt: 1,
    }],
  });
  assert.equal(frames[0].frames[0].bytes instanceof Uint8Array, true);
  assert.equal(Buffer.isBuffer(frames[0].frames[0].bytes), false);
  assert.deepEqual(statuses[0], {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: null,
    status: 'opening', error: null, createdAt: 2,
    log: {
      level: 'debug', source: 'serial', code: null,
      message: '正在打开串口: /dev/ttyUSB0',
      details: { path: '/dev/ttyUSB0', settings: [115200, true] }, createdAt: 2,
    },
  });
  assert.equal(Object.isFrozen(statuses[0].log.details.settings), true);
  unsubscribeFrames();
  unsubscribeStatus();
  assert.equal(frameListener, null);
  assert.equal(statusListener, null);
});

test('renderer adapter rejects malformed frame wire payloads without truncating bytes', () => {
  let wireListener;
  const frames = [];
  const adapter = createElectronRuntimeAdapter({
    runtimeName: 'electron',
    transport: {
      onFrames(listener) { wireListener = listener; return () => {}; },
    },
  });
  adapter.transport.onFrames((event) => frames.push(event));
  const validBatch = {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [1], createdAt: 1 }],
  };
  const sparseBytes = new Array(1);
  const invalidBatches = [
    { ...validBatch, extra: true },
    { ...validBatch, sessionId: null },
    { ...validBatch, frames: [{ ...validBatch.frames[0], extra: true }] },
    { ...validBatch, frames: [{ direction: 'in', bytes: [-1], createdAt: 1 }] },
    { ...validBatch, frames: [{ direction: 'in', bytes: [256], createdAt: 1 }] },
    { ...validBatch, frames: [{ direction: 'in', bytes: [1.5], createdAt: 1 }] },
    { ...validBatch, frames: [{ direction: 'in', bytes: sparseBytes, createdAt: 1 }] },
  ];

  for (const batch of invalidBatches) assert.doesNotThrow(() => wireListener(batch));
  assert.equal(frames.length, 0);
  wireListener(validBatch);
  assert.deepEqual([...frames[0].frames[0].bytes], [1]);
});

test('renderer adapter rejects malformed status wire lifecycle and unknown fields', () => {
  let wireListener;
  const statuses = [];
  const adapter = createElectronRuntimeAdapter({
    runtimeName: 'electron',
    transport: {
      onStatus(listener) { wireListener = listener; return () => {}; },
    },
  });
  adapter.transport.onStatus((event) => statuses.push(event));
  const base = {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: null,
    status: 'opening', error: null, createdAt: 1, log: null,
  };
  const validLog = {
    level: 'info', source: 'serial', code: null, message: '串口已打开', details: null, createdAt: 1,
  };
  const invalidStatuses = [
    { ...base, extra: true },
    { ...base, sessionId: 'session-1' },
    { ...base, status: 'open' },
    { ...base, status: 'closing' },
    { ...base, status: 'closed', sessionId: 'session-1' },
    { ...base, status: 'error', error: null },
    { ...base, status: 'error', error: { code: 'UNKNOWN', message: 'bad' } },
    { ...base, createdAt: -1 },
    { ...base, log: { ...validLog, level: 'notice' } },
    { ...base, log: { ...validLog, details: { count: Number.POSITIVE_INFINITY } } },
    { ...base, log: { ...validLog, extra: true } },
  ];

  for (const status of invalidStatuses) assert.doesNotThrow(() => wireListener(status));
  assert.equal(statuses.length, 0);
  wireListener(base);
  assert.deepEqual(statuses, [{ ...base, log: null }]);
});

test('wire normalizers clone once before validation and reject proxies without traps', () => {
  let proxyTraps = 0;
  const proxy = new Proxy({}, {
    get() { proxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });

  for (const normalize of [normalizeFrameWireBatch, normalizeStatusWireEvent]) {
    assert.throws(() => normalize(proxy), (error) => error?.name === 'DataCloneError');
  }
  assert.equal(proxyTraps, 0);

  let endpointReads = 0;
  const changingBatch = {
    get endpointId() {
      endpointReads += 1;
      return endpointReads === 1 ? 'serial-1' : '';
    },
    operationId: 'open-1',
    sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [1], createdAt: 1 }],
  };
  const normalized = normalizeFrameWireBatch(changingBatch);
  assert.equal(endpointReads, 1);
  assert.equal(normalized.endpointId, 'serial-1');
  assert.equal(normalized.frames[0].endpointId, 'serial-1');
});

test('renderer serial normalizer shim exposes transport aliases and peer events', () => {
  assert.equal(normalizeFrameWireBatch, normalizeTransportFrameBatch);
  assert.equal(normalizeStatusWireEvent, normalizeTransportStatusEvent);
  assert.deepEqual(normalizeTransportPeerEvent({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    peers: [{
      id: 'peer-1',
      remoteAddress: '127.0.0.1:51000',
      connectedAt: 1_720_000_000_001,
    }],
  }), {
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    peers: [{
      id: 'peer-1',
      remoteAddress: '127.0.0.1:51000',
      connectedAt: 1_720_000_000_001,
    }],
  });
});

test('status wire normalization rejects a self-replacing log accessor without reading it', () => {
  let reads = 0;
  const log = {
    level: 'info', source: 'serial', code: null, message: '串口已打开', details: null, createdAt: 1,
  };
  const event = {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    status: 'open', error: null, createdAt: 1,
  };
  Object.defineProperty(event, 'log', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      Object.defineProperty(event, 'log', {
        configurable: true, enumerable: true, writable: true, value: log,
      });
      return log;
    },
  });

  assert.throws(() => normalizeStatusWireEvent(event), TypeError);
  assert.equal(reads, 0);
});

test('renderer adapter status events with null sessions remain visible to the workbench', () => {
  let wireStatusListener;
  const fallback = createUnavailableRuntimeAdapter('electron');
  const adapter = createElectronRuntimeAdapter({
    ...fallback,
    transport: {
      ...fallback.transport,
      onStatus(listener) {
        wireStatusListener = listener;
        return () => { wireStatusListener = null; };
      },
    },
  });
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', operationId: 'open-1', sessionId: null });

  wireStatusListener({
    endpointId: 'serial-1', operationId: 'open-1', sessionId: null,
    status: 'opening', error: null, createdAt: 1, log: null,
  });
  assert.equal(model.state.statuses.get('serial-1')?.status, 'opening');

  wireStatusListener({
    endpointId: 'serial-1', operationId: 'open-1', sessionId: null,
    status: 'open', error: null, createdAt: 2, log: null,
  });
  assert.equal(model.state.statuses.get('serial-1')?.status, 'opening');

  model.activateOperation({ endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1' });
  wireStatusListener({
    endpointId: 'serial-1', operationId: 'open-1', sessionId: null,
    status: 'closed', error: null, createdAt: 3, log: null,
  });
  assert.equal(model.state.statuses.get('serial-1')?.status, 'closed');
  model.dispose();
  assert.equal(wireStatusListener, null);
});

for (const receiveFraming of [{ mode: 'delimiter', delimiterBytes: [0] }, { mode: 'idle', idleMs: 50 }]) {
  test(`serial ${receiveFraming.mode} overflow reports a read error and closes without a truncated frame`, async () => {
    const { service, events, timers } = createHarness({ framerFactory: undefined });
    const opening = service.open(serialEndpoint('overflow', { receiveFraming }), { operationId: 'overflow-open' });
    const port = await waitForPort();
    port.succeedOpen();
    await opening;
    port.emit('data', Buffer.alloc(1024 * 1024, 1));
    port.emit('data', Buffer.from([1]));
    await new Promise((resolve) => setImmediate(resolve));
    const statuses = payloads(events, 'transport:status');
    const failure = statuses.find((event) => event.status === 'error');
    assert.equal(failure?.error?.code, 'IO_ERROR');
    assert.match(failure.error.message, /pending.*1048576.*bytes/i);
    assert.equal(statuses.at(-1).status, 'closed');
    assert.equal(port.isOpen, false);
    assert.equal(payloads(events, 'transport:frames').length, 0);
    assert.equal(timers.size, 0);
    await service.shutdown();
  });
}
