import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_RUNTIME_METHODS,
  RuntimeUnavailableError,
  assertRuntimeAdapter,
  createUnavailableRuntimeAdapter,
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
  normalizeTransportFrameBatch,
  normalizeTransportPeerEvent,
  normalizeTransportStatusEvent,
} from '../src/index.js';

const EXPECTED_METHODS = [
  'endpoint.list', 'endpoint.save', 'endpoint.clone', 'endpoint.delete',
  'transport.scanSerialPorts', 'transport.open', 'transport.cancelOpen',
  'transport.close', 'transport.send', 'transport.disconnectPeer',
  'transport.onFrames', 'transport.onStatus', 'transport.onPeers',
  'modbus.execute', 'modbus.readMap', 'modbus.writeMap', 'modbus.onTransactions',
  'modbusHistory.recordBatch', 'modbusHistory.querySeries', 'modbusHistory.queryRows',
  'modbusHistory.exportCsv', 'modbusHistory.clear', 'modbusHistory.cleanup',
  'modbusHistory.flush',
  'history.queryFrames', 'history.queryLogs', 'history.delete', 'history.clear',
  'template.list', 'template.save', 'template.delete',
  'sendHistory.record', 'sendHistory.query', 'sendHistory.delete', 'sendHistory.clear',
  'settings.getAll', 'settings.save', 'settings.saveAll',
  'workspace.export', 'workspace.import',
  'storage.stats', 'storage.clearHistory', 'window.openHistory',
  'lifecycle.onBeforeShutdown', 'lifecycle.readyForShutdown',
];

test('REQUIRED_RUNTIME_METHODS exactly describes the runtime surface', () => {
  assert.deepEqual(REQUIRED_RUNTIME_METHODS, EXPECTED_METHODS);
});

test('assertRuntimeAdapter returns a complete adapter unchanged', () => {
  const adapter = createCompleteAdapter();
  assert.equal(assertRuntimeAdapter(adapter), adapter);
});

test('assertRuntimeAdapter names every missing or non-function dotted method', () => {
  const adapter = createCompleteAdapter();
  delete adapter.endpoint.list;
  adapter.transport.send = true;
  delete adapter.window;

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    (error) => {
      assert.equal(error instanceof TypeError, true);
      assert.match(error.message, /endpoint\.list/);
      assert.match(error.message, /transport\.send/);
      assert.match(error.message, /window\.openHistory/);
      return true;
    },
  );
});

test('createUnavailableRuntimeAdapter returns the full nested shape and runtime name', () => {
  const adapter = createUnavailableRuntimeAdapter('browser-preview');

  assert.equal(adapter.runtimeName, 'browser-preview');
  assert.equal(assertRuntimeAdapter(adapter), adapter);
});

test('createUnavailableRuntimeAdapter requires a nonblank string runtime name', () => {
  for (const runtimeName of [undefined, '', '   ', 42]) {
    assert.throws(
      () => createUnavailableRuntimeAdapter(runtimeName),
      /runtimeName must be a nonblank string/,
    );
  }
});

test('unavailable read methods resolve safe empty values', async () => {
  const adapter = createUnavailableRuntimeAdapter('test');

  assert.deepEqual(await adapter.endpoint.list(), []);
  assert.deepEqual(await adapter.history.queryFrames(), { rows: [], total: 0, page: 1, pageSize: 100 });
  assert.deepEqual(await adapter.history.queryLogs(), { rows: [], total: 0, page: 1, pageSize: 100 });
  assert.deepEqual(await adapter.template.list(), []);
  assert.deepEqual(await adapter.sendHistory.query(), {
    rows: [], total: 0, page: 1, pageSize: 20,
  });
  assert.deepEqual(await adapter.modbusHistory.querySeries(), {
    series: [], from: null, to: null,
  });
  assert.deepEqual(await adapter.modbusHistory.queryRows(), {
    rows: [], total: 0, page: 1, pageSize: 50,
  });
  assert.deepEqual(await adapter.modbusHistory.flush(), { flushed: true });
  assert.deepEqual(await adapter.settings.getAll(), {});
  assert.deepEqual(await adapter.storage.stats(), {
    frameCount: 0,
    logCount: 0,
    sendHistoryCount: 0,
    totalCount: 0,
    diskBytes: 0,
  });
});

test('unavailable read defaults are newly allocated for every call', async () => {
  const adapter = createUnavailableRuntimeAdapter('test');

  const endpoints = await adapter.endpoint.list();
  endpoints.push({ id: 'ep-1' });
  assert.deepEqual(await adapter.endpoint.list(), []);

  for (const query of [adapter.history.queryFrames, adapter.history.queryLogs]) {
    const page = await query();
    page.rows.push({ id: 'frame-1' });
    page.total = 1;
    assert.deepEqual(await query(), { rows: [], total: 0, page: 1, pageSize: 100 });
  }

  const templates = await adapter.template.list();
  templates.push({ id: 'template-1' });
  assert.deepEqual(await adapter.template.list(), []);

  const sendHistory = await adapter.sendHistory.query();
  sendHistory.rows.push({ id: 1 });
  sendHistory.total = 1;
  assert.deepEqual(await adapter.sendHistory.query(), {
    rows: [], total: 0, page: 1, pageSize: 20,
  });

  const settings = await adapter.settings.getAll();
  settings.theme = 'dark';
  assert.deepEqual(await adapter.settings.getAll(), {});

  const stats = await adapter.storage.stats();
  stats.frameCount = 1;
  assert.deepEqual(await adapter.storage.stats(), {
    frameCount: 0,
    logCount: 0,
    sendHistoryCount: 0,
    totalCount: 0,
    diskBytes: 0,
  });
});

test('unavailable event methods return no-op unsubscribe functions', () => {
  const adapter = createUnavailableRuntimeAdapter('test');

  for (const subscribe of [
    adapter.transport.onFrames,
    adapter.transport.onStatus,
    adapter.transport.onPeers,
    adapter.lifecycle.onBeforeShutdown,
  ]) {
    const unsubscribe = subscribe(() => {});
    assert.equal(typeof unsubscribe, 'function');
    assert.equal(unsubscribe(), undefined);
  }
});

test('status wire logs enforce serial lifecycle semantics while remaining nullable', () => {
  const event = {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    status: 'open', error: null, createdAt: 10,
    log: {
      level: 'info', source: 'serial', code: null, message: 'opened', details: null, createdAt: 10,
    },
  };
  const invalidLogs = [
    { ...event.log, source: 'transport' },
    { ...event.log, createdAt: 11 },
    { ...event.log, level: 'debug' },
    { ...event.log, code: 'IO_ERROR' },
  ];
  for (const log of invalidLogs) {
    assert.throws(() => normalizeStatusWireEvent({ ...event, log }), TypeError);
  }

  assert.equal(normalizeStatusWireEvent({ ...event, log: null }).log, null);
  assert.equal(normalizeStatusWireEvent({
    ...event,
    status: 'error',
    error: { code: 'DEVICE_REMOVED', message: 'removed' },
    log: { ...event.log, level: 'warn', code: 'DEVICE_REMOVED' },
  }).log.level, 'warn');
  assert.equal(normalizeStatusWireEvent({
    ...event,
    status: 'error',
    error: { code: 'IO_ERROR', message: 'failed' },
    log: { ...event.log, level: 'error', code: 'IO_ERROR' },
  }).log.level, 'error');
  assert.throws(() => normalizeStatusWireEvent({
    ...event,
    sessionId: null,
    status: 'closed',
    error: { code: 'IO_ERROR', message: 'failed' },
  }), TypeError);
});

test('transport status accepts TCP source and listening status while serial aliases remain', () => {
  const event = normalizeTransportStatusEvent({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_000,
    log: {
      level: 'info',
      source: 'tcp',
      code: null,
      message: 'TCP 服务已监听: 127.0.0.1:41000',
      details: { listenHost: '127.0.0.1', listenPort: 41000 },
      createdAt: 1_720_000_000_000,
    },
  });
  assert.equal(event.status, 'listening');
  assert.equal(event.log.source, 'tcp');
  assert.equal(normalizeStatusWireEvent, normalizeTransportStatusEvent);
  assert.equal(normalizeFrameWireBatch, normalizeTransportFrameBatch);
});

test('transport listening status requires a structured info log', () => {
  assert.throws(() => normalizeTransportStatusEvent({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_000,
    log: null,
  }), /listening status requires a log/);
});

test('transport peers validate exact TCP server peer records', () => {
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

test('transport frames preserve optional TCP server peer identity', () => {
  const event = normalizeTransportFrameBatch({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-session',
    frames: [{
      direction: 'in',
      peerId: 'tcp-peer-1',
      bytes: [0x41],
      createdAt: 1_720_000_000_002,
    }],
  });

  assert.equal(event.frames[0].peerId, 'tcp-peer-1');
});

test('transport status logs preserve optional TCP peer identity', () => {
  const event = normalizeTransportStatusEvent({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-session',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_003,
    log: {
      level: 'info',
      source: 'tcp',
      peerId: 'tcp-peer-1',
      code: null,
      message: 'TCP peer connected',
      details: { remoteAddress: '127.0.0.1:51000' },
      createdAt: 1_720_000_000_003,
    },
  });

  assert.equal(event.log.peerId, 'tcp-peer-1');
});

test('transport accepts UDP server frames and structured peer logs', () => {
  const frames = normalizeTransportFrameBatch({
    endpointId: 'udp-server-1',
    operationId: 'open-udp-server-1',
    sessionId: 'udp-server-session',
    frames: [{
      direction: 'in',
      peerId: 'udp-peer-1',
      bytes: [0x55],
      createdAt: 1_720_000_000_005,
    }],
  });
  const status = normalizeTransportStatusEvent({
    endpointId: 'udp-server-1',
    operationId: 'open-udp-server-1',
    sessionId: 'udp-server-session',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_005,
    log: {
      level: 'info',
      source: 'udp',
      peerId: 'udp-peer-1',
      code: null,
      message: 'UDP peer discovered',
      details: { remoteAddress: '127.0.0.1:52000' },
      createdAt: 1_720_000_000_005,
    },
  });

  assert.equal(frames.frames[0].peerId, 'udp-peer-1');
  assert.equal(status.log.source, 'udp');
  assert.equal(status.log.peerId, 'udp-peer-1');
});

test('transport closed status accepts TCP remote-close warning logs', () => {
  const event = normalizeTransportStatusEvent({
    endpointId: 'tcp-client-1',
    operationId: 'open-tcp-client-1',
    sessionId: null,
    status: 'closed',
    error: null,
    createdAt: 1_720_000_000_004,
    log: {
      level: 'warn',
      source: 'tcp',
      code: null,
      message: 'TCP remote closed',
      details: { endpointId: 'tcp-client-1' },
      createdAt: 1_720_000_000_004,
    },
  });

  assert.equal(event.log.level, 'warn');
});

test('transport peers reject non-exact TCP server peer records', () => {
  const event = {
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    peers: [{
      id: 'peer-1',
      remoteAddress: '127.0.0.1:51000',
      connectedAt: 1_720_000_000_001,
    }],
  };

  assert.throws(() => normalizeTransportPeerEvent({
    ...event,
    peers: [{ ...event.peers[0], label: 'client' }],
  }), /peer has unknown or missing fields/);
  assert.throws(() => normalizeTransportPeerEvent({
    ...event,
    peers: [{
      id: 'peer-1',
      remoteAddress: '127.0.0.1:51000',
    }],
  }), /peer has unknown or missing fields/);
  assert.throws(() => normalizeTransportPeerEvent({
    ...event,
    transport: 'tcp',
  }), /peer event has unknown or missing fields/);
});

test('unavailable commands reject with method-specific RuntimeUnavailableError', async () => {
  const adapter = createUnavailableRuntimeAdapter('browser-preview');
  const readMethods = new Set([
    'endpoint.list',
    'history.queryFrames',
    'history.queryLogs',
    'template.list',
    'sendHistory.query',
    'settings.getAll',
    'storage.stats',
    'transport.onFrames',
    'transport.onStatus',
    'transport.onPeers',
    'modbus.onTransactions',
    'modbusHistory.querySeries',
    'modbusHistory.queryRows',
    'modbusHistory.flush',
    'lifecycle.onBeforeShutdown',
  ]);

  for (const method of REQUIRED_RUNTIME_METHODS.filter((name) => !readMethods.has(name))) {
    await assert.rejects(
      callDottedMethod(adapter, method),
      (error) => {
        assert.equal(error instanceof RuntimeUnavailableError, true);
        assert.equal(error.name, 'RuntimeUnavailableError');
        assert.equal(error.message, `Runtime method "${method}" is unavailable in browser-preview`);
        assert.equal(error.method, method);
        assert.equal(error.runtimeName, 'browser-preview');
        assert.equal(typeof error.stack, 'string');
        assert.match(error.stack, /^RuntimeUnavailableError: Runtime method/);
        assert.match(error.stack, new RegExp(method.replace('.', '\\.')));
        return true;
      },
    );
  }
});

function createCompleteAdapter() {
  const adapter = {};
  for (const dottedMethod of EXPECTED_METHODS) {
    const [namespace, method] = dottedMethod.split('.');
    adapter[namespace] ??= {};
    adapter[namespace][method] = () => {};
  }
  return adapter;
}

function callDottedMethod(adapter, dottedMethod) {
  const [namespace, method] = dottedMethod.split('.');
  return adapter[namespace][method]();
}
