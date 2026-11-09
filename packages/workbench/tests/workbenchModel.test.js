import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFrameWireBatch, normalizeTransportPeerEvent } from '@ineed-linklab/runtime-contract';

import { createWorkbenchModel } from '../src/model/createWorkbenchModel.js';
import { normalizeModbusConfig } from '../src/model/endpointDraft.js';
import { createFakeTimers } from './helpers/fakeTimers.js';
import { createFramePresenter } from '../src/model/framePresentation.js';

const endpoints = [
  endpoint('serial-1', 'serial'),
  endpoint('tcp-client-1', 'tcp-client'),
  endpoint('tcp-server-1', 'tcp-server'),
  endpoint('udp-client-1', 'udp-client'),
  endpoint('udp-server-1', 'udp-server'),
];

test('model observers synchronously cover public mutations and runtime events', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  const snapshots = [];
  assert.equal(typeof model.subscribe, 'function');
  model.subscribe((state) => snapshots.push({
    endpointFilter: state.endpointFilter,
    activeEndpointId: state.activeEndpointId,
    frames: state.frames.length,
  }));

  model.setEndpointFilter('tcp');
  assert.equal(snapshots.length, 1);
  model.selectEndpoint('tcp-server-1');
  assert.equal(snapshots.length, 2);
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  assert.equal(snapshots.length, 3);
  emit.frames({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('observed')],
  });
  assert.equal(snapshots.length, 4);
  emit.status(statusEvent('op1', 's1', 'open'));
  assert.equal(snapshots.length, 5);
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('a')],
  });
  assert.equal(snapshots.length, 6);
  model.clearRealtime();
  assert.equal(snapshots.length, 7);
});

test('observer listener failures are isolated and reentrant notifications drain iteratively', () => {
  const { adapter } = createAdapter();
  const model = createWorkbenchModel(adapter);
  const trace = [];
  assert.equal(typeof model.subscribe, 'function');
  model.subscribe(() => {
    trace.push('first');
    if (model.state.activeEndpointId === null) model.selectEndpoint('serial-1');
    throw new Error('listener failure');
  });
  model.subscribe(() => trace.push('second'));

  model.setEndpointFilter('serial');

  assert.deepEqual(trace, ['first', 'second', 'first', 'second']);
  assert.equal(model.state.activeEndpointId, 'serial-1');
});

test('observer unsubscribe is idempotent and dispose emits once then clears listeners', () => {
  const { adapter, emit, unsubscribeCounts } = createAdapter();
  const model = createWorkbenchModel(adapter);
  let notifications = 0;
  assert.equal(typeof model.subscribe, 'function');
  const unsubscribe = model.subscribe(() => { notifications += 1; });

  unsubscribe();
  unsubscribe();
  model.selectEndpoint('serial-1');
  assert.equal(notifications, 0);

  model.subscribe(() => { notifications += 1; });
  model.dispose();
  model.dispose();
  emit.status(statusEvent('op1', 's1', 'open'));
  assert.equal(notifications, 1);
  assert.deepEqual(unsubscribeCounts, { frames: 1, status: 1, peers: 1 });
  const lateUnsubscribe = model.subscribe(() => { notifications += 1; });
  lateUnsubscribe();
  model.selectEndpoint('late');
  assert.equal(notifications, 1);
});

test('dispose seals notifications and makes every public mutator inert before final delivery', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  const expected = snapshotModelState(model.state);
  let notifications = 0;

  model.subscribe(() => {
    notifications += 1;
    if (notifications > 8) return;
    model.setEndpointFilter('serial');
    model.selectEndpoint('tcp-server-1');
    model.selectPeer('peer-a');
    model.setFrameFilters({ direction: 'out', keyword: 'changed' });
    model.activateOperation({ endpointId: 'serial-1', sessionId: 's2', operationId: 'op2' });
    model.clearRealtime();
    emit.status(statusEvent('op1', 's1', 'open'));
    void model.commands.send({ endpointId: 'tcp-server-1', bytes: Uint8Array.of(1) });
  });

  model.dispose();

  assert.equal(notifications, 1);
  assert.deepEqual(snapshotModelState(model.state), { ...expected, disposed: true });
});

test('scoped command errors stay with their endpoint and resource', async () => {
  const { adapter } = createAdapter({
    endpoints: [endpoint('a', 'serial'), endpoint('b', 'serial')],
  });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const failingEndpoints = new Set(['a', 'b']);
  adapter.transport.send = async ({ endpointId }) => {
    if (failingEndpoints.has(endpointId)) throw new Error(`${endpointId.toUpperCase()} send failed`);
    return null;
  };

  await model.commands.send({ endpointId: 'a', bytes: Uint8Array.of(1) });

  assert.equal(typeof model.commandErrorForEndpoint, 'function');
  assert.equal(model.commandErrorForEndpoint('a')?.message, 'A send failed');
  assert.equal(model.commandErrorForEndpoint('b'), null);
  assert.equal(model.state.commandErrorMeta.endpointId, 'a');
  assert.equal(model.state.commandErrorMeta.resource, 'transport:send:a');

  await model.commands.send({ endpointId: 'b', bytes: Uint8Array.of(1) });
  assert.equal(model.commandErrorForEndpoint('b')?.message, 'B send failed');

  adapter.endpoint.list = async () => { throw new Error('Collection failed'); };
  await model.commands.loadEndpoints();
  assert.equal(model.commandErrorForEndpoint('a')?.message, 'A send failed');

  adapter.transport.scanSerialPorts = async () => { throw new Error('Scan failed'); };
  await model.commands.scanSerialPorts();
  assert.equal(model.commandErrorForEndpoint('a')?.message, 'A send failed');

  failingEndpoints.delete('a');
  await model.commands.send({ endpointId: 'a', bytes: Uint8Array.of(2) });
  assert.equal(model.commandErrorForEndpoint('a'), null);
  assert.equal(model.commandErrorForEndpoint('b')?.message, 'B send failed');
  assert.equal(model.state.commandError?.message, 'Scan failed');
});

test('command collection applies and command errors notify observers', async () => {
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  const model = createWorkbenchModel(adapter);
  let notifications = 0;
  model.subscribe(() => { notifications += 1; });

  await model.commands.loadEndpoints();
  const afterLoad = notifications;
  adapter.transport.send = async () => { throw new Error('send failed'); };
  await model.commands.send({ endpointId: 'serial-1', bytes: Uint8Array.of(1) });

  assert.ok(afterLoad > 0);
  assert.ok(notifications > afterLoad);
});

test('endpoint filters group all, serial, TCP client/server, and UDP client/server', async () => {
  const { adapter } = createAdapter({ endpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  for (const [filter, ids] of [
    ['all', endpoints.map(({ id }) => id)],
    ['serial', ['serial-1']],
    ['tcp', ['tcp-client-1', 'tcp-server-1']],
    ['udp', ['udp-client-1', 'udp-server-1']],
  ]) {
    model.setEndpointFilter(filter);
    assert.deepEqual(model.filteredEndpoints.map(({ id }) => id), ids);
  }
});

test('active endpoint selection is explicit and clears incompatible Peer selection', async () => {
  const { adapter, emit } = createAdapter({ endpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.selectEndpoint('tcp-server-1');
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  emit.peers({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('a')] });
  model.selectPeer('a');

  model.selectEndpoint('serial-1');

  assert.equal(model.activeEndpoint.id, 'serial-1');
  assert.equal(model.state.activePeerId, null);
});

test('visible frames are scoped to the active endpoint before view filters apply', async () => {
  const { adapter, emit } = createAdapter({ endpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  for (const endpointId of ['serial-1', 'tcp-client-1']) {
    model.activateOperation({ endpointId, sessionId: `${endpointId}-session`, operationId: `${endpointId}-operation` });
    emit.frames({
      endpointId,
      sessionId: `${endpointId}-session`,
      operationId: `${endpointId}-operation`,
      frames: [frame(`${endpointId}-frame`, 'in', null, endpointId, endpointId, `${endpointId}-session`)],
    });
  }

  model.selectEndpoint('tcp-client-1');

  assert.deepEqual(model.visibleFrames.map(({ id }) => id), ['tcp-client-1-frame']);
});

test('TCP Server Peer child selection is cleaned up when peers disappear', async () => {
  const { adapter, emit } = createAdapter({ endpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.selectEndpoint('tcp-server-1');
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    peers: [peer('a'), peer('b')],
  });
  model.selectPeer('b');
  assert.equal(model.activePeer.id, 'b');

  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('a')],
  });

  assert.equal(model.state.activePeerId, null);
  assert.equal(model.activePeer, null);
});

test('replacing an operation clears stale status and TCP Server Peer children', async () => {
  const { adapter, emit } = createAdapter({ endpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.selectEndpoint('tcp-server-1');
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  emit.status(statusEvent('op1', 's1', 'open'));
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('a')],
  });
  model.selectPeer('a');

  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's2', operationId: 'op2' });

  assert.equal(model.state.statuses.has('tcp-server-1'), false);
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), []);
  assert.equal(model.state.activePeerId, null);
});

test('frame views filter by direction, Peer, and keyword', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.selectEndpoint('tcp-server-1');
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  emit.frames({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    frames: [
      frame('in-a', 'in', 'peer-a', 'hello'),
      frame('out-a', 'out', 'peer-a', 'hello'),
      frame('in-b', 'in', 'peer-b', 'other'),
    ],
  });
  model.setFrameFilters({ direction: 'in', peerId: 'peer-a', keyword: 'HELLO' });

  assert.deepEqual(model.visibleFrames.map(({ id }) => id), ['in-a']);
});

test('status, logs, frames, and peers apply only to the current operation and session', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 'new-session', operationId: 'new-op' });

  emit.status(statusEvent('old-op', 'new-session', 'stale', 'stale log'));
  emit.status(statusEvent('new-op', 'old-session', 'stale-session', 'stale session log'));
  emit.frames({ ...statusEvent('old-op', 'new-session'), frames: [frame('stale')] });
  emit.peers({ ...statusEvent('old-op', 'new-session'), peers: [peer('stale')] });
  assert.equal(model.state.statuses.size, 0);
  assert.deepEqual(model.state.logs, []);
  assert.deepEqual(model.state.frames, []);
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), []);

  emit.status(statusEvent('new-op', 'new-session', 'open', 'listening'));
  assert.equal(model.state.statuses.get('tcp-server-1').status, 'open');
  assert.deepEqual(model.state.logs.map(({ message }) => message), ['listening']);
});

test('workbench accepts TCP listening status and tcp structured logs', () => {
  const { adapter, emit } = createAdapter({
    endpoints: [endpoint('tcp-server-1', 'tcp-server')],
  });
  const model = createWorkbenchModel(adapter);
  model.activateOperation({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
  });
  model.selectEndpoint('tcp-server-1');

  emit.status({
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

  assert.equal(model.state.statuses.get('tcp-server-1').status, 'listening');
  assert.equal(model.visibleLogs[0].source, 'tcp');
});

test('workbench rejects logless listening status before mutation', () => {
  const { adapter, emit } = createAdapter({
    endpoints: [endpoint('tcp-server-1', 'tcp-server')],
  });
  const model = createWorkbenchModel(adapter);
  model.activateOperation({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
  });
  const before = snapshotState(model.state);

  emit.status({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_000,
    log: null,
  });

  assert.deepEqual(snapshotState(model.state), before);
});

test('workbench rejects known endpoint status logs from the wrong transport source', async () => {
  const { adapter, emit } = createAdapter({
    endpoints: [
      endpoint('serial-1', 'serial'),
      endpoint('tcp-server-1', 'tcp-server'),
    ],
  });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  model.activateOperation({ endpointId: 'serial-1', operationId: 'serial-op', sessionId: 'serial-session' });
  const serialEvent = statusEvent('serial-op', 'serial-session', 'open', 'opened', 'serial-1');
  serialEvent.log.source = 'tcp';
  let before = snapshotState(model.state);

  emit.status(serialEvent);

  assert.deepEqual(snapshotState(model.state), before);

  model.activateOperation({ endpointId: 'tcp-server-1', operationId: 'tcp-op', sessionId: 'tcp-session' });
  const tcpEvent = {
    endpointId: 'tcp-server-1',
    operationId: 'tcp-op',
    sessionId: 'tcp-session',
    status: 'open',
    error: null,
    createdAt: 10,
    log: {
      level: 'info',
      source: 'serial',
      code: null,
      message: 'opened',
      details: null,
      createdAt: 10,
    },
  };
  before = snapshotState(model.state);

  emit.status(tcpEvent);

  assert.deepEqual(snapshotState(model.state), before);
});

test('status logs are validated and deeply snapshotted before workbench state mutation', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  const details = { path: '/dev/ttyUSB0', settings: [115200, { parity: 'none' }] };
  const event = statusEvent('op1', 's1', 'open', '串口已打开: /dev/ttyUSB0', 'serial-1');
  event.log.details = details;

  emit.status(event);

  const storedStatus = model.state.statuses.get('serial-1');
  const storedLog = model.state.logs[0];
  assert.deepEqual(storedStatus.log, event.log);
  assert.notEqual(storedStatus.log, event.log);
  assert.notEqual(storedStatus.log.details, details);
  assert.notEqual(storedStatus.log.details.settings, details.settings);
  assert.equal(Object.isFrozen(storedStatus.log), true);
  assert.equal(Object.isFrozen(storedStatus.log.details), true);
  assert.equal(Object.isFrozen(storedStatus.log.details.settings), true);
  assert.equal(Object.isFrozen(storedLog), true);
  details.path = 'mutated';
  details.settings[1].parity = 'odd';
  assert.equal(storedLog.details.path, '/dev/ttyUSB0');
  assert.equal(storedLog.details.settings[1].parity, 'none');

  const before = snapshotState(model.state);
  const validLog = statusEvent('op1', 's1', 'open', 'valid', 'serial-1').log;
  const sparse = new Array(1);
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  let proxyTraps = 0;
  const proxy = new Proxy({ value: 1 }, {
    get() { proxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });
  const invalidLogs = [
    undefined,
    { ...validLog, level: 'notice' },
    { ...validLog, source: ' ' },
    { ...validLog, code: ' ' },
    { ...validLog, message: ' ' },
    { ...validLog, createdAt: -0 },
    { ...validLog, details: sparse },
    { ...validLog, details: accessor },
    { ...validLog, details: proxy },
    { ...validLog, details: { count: Number.MAX_SAFE_INTEGER + 1 } },
    { ...validLog, extra: true },
  ];
  for (const log of invalidLogs) {
    const invalid = statusEvent('op1', 's1', 'closed', null, 'serial-1');
    if (log === undefined) delete invalid.log;
    else invalid.log = log;
    emit.status(invalid);
  }
  assert.equal(proxyTraps, 0);
  assert.deepEqual(snapshotState(model.state), before);
});

test('workbench rejects serial lifecycle log semantic violations before mutation', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  const valid = {
    endpointId: 'serial-1', operationId: 'op1', sessionId: 's1',
    status: 'open', error: null, createdAt: 10,
    log: {
      level: 'info', source: 'serial', code: null, message: 'opened', details: null, createdAt: 10,
    },
  };
  const before = snapshotState(model.state);
  const invalidEvents = [
    { ...valid, log: { ...valid.log, source: 'transport' } },
    { ...valid, log: { ...valid.log, createdAt: 11 } },
    { ...valid, log: { ...valid.log, level: 'debug' } },
    {
      ...valid,
      status: 'error',
      error: { code: 'DEVICE_REMOVED', message: 'removed' },
      log: { ...valid.log, level: 'error', code: 'IO_ERROR' },
    },
    {
      ...valid,
      status: 'error',
      error: { code: 'UNKNOWN', message: 'failed' },
      log: { ...valid.log, level: 'error', code: 'UNKNOWN' },
    },
  ];

  for (const event of invalidEvents) emit.status(event);

  assert.deepEqual(snapshotState(model.state), before);
});

test('workbench applies a logless OPEN_CANCELLED terminal status', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });

  emit.status({
    endpointId: 'serial-1', operationId: 'op1', sessionId: null,
    status: 'closed', error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' },
    createdAt: 10, log: null,
  });

  assert.deepEqual(model.state.statuses.get('serial-1'), {
    endpointId: 'serial-1', operationId: 'op1', sessionId: null,
    status: 'closed', error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' },
    createdAt: 10, log: null,
  });
  assert.deepEqual(model.state.logs, []);
  assert.equal(model.state.counters.logs, 0);
});

test('self-replacing status log details accessors are rejected before workbench mutation', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  const event = statusEvent('op1', 's1', 'open', '串口已打开', 'serial-1');
  const details = { path: '/dev/ttyUSB0' };
  let reads = 0;
  Object.defineProperty(event.log, 'details', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      Object.defineProperty(event.log, 'details', {
        configurable: true, enumerable: true, writable: true, value: details,
      });
      return details;
    },
  });

  emit.status(event);

  assert.equal(reads, 0);
  assert.equal(model.state.statuses.size, 0);
  assert.deepEqual(model.state.logs, []);
  assert.deepEqual(model.state.counters, { received: 0, sent: 0, frames: 0, logs: 0 });
});

test('the first matching frame batch binds an operation to its active session', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: null, operationId: 'op1' });

  emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('accepted', 'in', null, 'accepted', 'serial-1', 's1')],
  });
  emit.frames({
    endpointId: 'serial-1', sessionId: 's2', operationId: 'op1',
    frames: [frame('wrong-session', 'in', null, 'wrong', 'serial-1', 's2')],
  });

  assert.equal(model.state.operations.get('serial-1').sessionId, 's1');
  assert.deepEqual(model.state.frames.map(({ id }) => id), ['accepted']);
});

test('receive, send, frame, and log counters advance independently', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
    frames: [
      frame('in-1', 'in', null, 'in-1', 'serial-1', 's1'),
      frame('in-2', 'in', null, 'in-2', 'serial-1', 's1'),
      frame('out-1', 'out', null, 'out-1', 'serial-1', 's1'),
    ],
  });
  emit.status(statusEvent('op1', 's1', 'open', 'first log', 'serial-1'));
  emit.status(statusEvent('op1', 's1', 'open', null, 'serial-1'));

  assert.deepEqual(model.state.counters, { received: 2, sent: 1, frames: 3, logs: 1 });
});

test('bounded realtime retention is applied independently per endpoint', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter, { frameLimit: 2, logLimit: 1 });
  for (const endpointId of ['a', 'b']) {
    model.activateOperation({ endpointId, sessionId: `${endpointId}-s`, operationId: `${endpointId}-op` });
    emit.frames({
      endpointId, sessionId: `${endpointId}-s`, operationId: `${endpointId}-op`,
      frames: [
        frame(`${endpointId}-1`, 'in', null, endpointId, endpointId, `${endpointId}-s`),
        frame(`${endpointId}-2`, 'in', null, endpointId, endpointId, `${endpointId}-s`),
        frame(`${endpointId}-3`, 'in', null, endpointId, endpointId, `${endpointId}-s`),
      ],
    });
    emit.status(statusEvent(`${endpointId}-op`, `${endpointId}-s`, 'open', `${endpointId}-log-1`, endpointId));
    emit.status(statusEvent(`${endpointId}-op`, `${endpointId}-s`, 'open', `${endpointId}-log-2`, endpointId));
  }

  assert.deepEqual(model.state.frames.map(({ id }) => id), ['a-2', 'a-3', 'b-2', 'b-3']);
  assert.deepEqual(model.state.logs.map(({ message }) => message), ['a-log-2', 'b-log-2']);
  assert.deepEqual(model.state.counters, { received: 6, sent: 0, frames: 6, logs: 4 });
});

test('preference updates trim realtime data and filter visible logs by threshold', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  model.selectEndpoint('serial-1');
  emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
    frames: [
      frame('one', 'in', null, 'one', 'serial-1', 's1'),
      frame('two', 'in', null, 'two', 'serial-1', 's1'),
      frame('three', 'in', null, 'three', 'serial-1', 's1'),
    ],
  });
  emit.status(statusEvent('op1', 's1', 'closing', 'debug', 'serial-1'));
  emit.status(statusEvent('op1', 's1', 'open', 'info', 'serial-1'));
  emit.status(statusEvent('op1', 's1', 'error', 'error', 'serial-1'));

  model.updatePreferences({ realtimeFrameLimit: 2, realtimeLogLimit: 2, logLevel: 'error' });

  assert.deepEqual(model.state.frames.map(({ id }) => id), ['two', 'three']);
  assert.deepEqual(model.state.logs.map(({ message }) => message), ['info', 'error']);
  assert.deepEqual(model.visibleLogs.map(({ message }) => message), ['error']);
  assert.equal(model.state.preferences.previewByteLimit, 4096);
});

test('realtime clear removes views and counters without touching persisted history', () => {
  const historyCalls = [];
  const { adapter, emit } = createAdapter({ historyCalls });
  const persisted = [{ id: 'persisted-frame' }];
  adapter.history.queryFrames = async () => ({ rows: persisted, total: 1, page: 1, pageSize: 100 });
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('live', 'in', null, 'live', 'serial-1', 's1')],
  });
  emit.status(statusEvent('op1', 's1', 'open', 'live log', 'serial-1'));

  model.clearRealtime();

  assert.deepEqual(model.state.frames, []);
  assert.deepEqual(model.state.logs, []);
  assert.deepEqual(model.state.counters, { received: 0, sent: 0, frames: 0, logs: 0 });
  assert.deepEqual(historyCalls, []);
  assert.deepEqual(persisted, [{ id: 'persisted-frame' }]);
});

test('workspace reset clears endpoints, selection, operations, peers, and realtime state', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.state.endpoints = [endpoint('serial-1', 'serial')];
  model.selectEndpoint('serial-1');
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('live', 'in', null, 'live', 'serial-1', 's1')],
  });
  emit.status(statusEvent('op1', 's1', 'open', 'log', 'serial-1'));

  model.resetWorkspaceState();

  assert.deepEqual(model.state.endpoints, []);
  assert.equal(model.state.activeEndpointId, null);
  assert.equal(model.state.operations.size, 0);
  assert.equal(model.state.statuses.size, 0);
  assert.equal(model.state.peers.size, 0);
  assert.deepEqual(model.state.frames, []);
  assert.deepEqual(model.state.logs, []);
});

test('model exposes the scheduled sender and reconciles session, status, and reset lifecycle', async () => {
  const { adapter, emit } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  model.scheduledSender.start({
    endpointId: 'serial-1', sessionId: 's1', intervalMs: 100, count: null,
    request: { endpointId: 'serial-1', bytes: Uint8Array.of(1) },
  });
  assert.equal(model.scheduledSender.getStatus('serial-1').active, true);

  model.activateOperation({ endpointId: 'serial-1', sessionId: 's2', operationId: 'op2' });
  assert.equal(model.scheduledSender.getStatus('serial-1').active, false);

  model.scheduledSender.start({
    endpointId: 'serial-1', sessionId: 's2', intervalMs: 100, count: null,
    request: { endpointId: 'serial-1', bytes: Uint8Array.of(2) },
  });
  emit.status(statusEvent('op2', 's2', 'error', null, 'serial-1'));
  assert.equal(model.scheduledSender.getStatus('serial-1').active, false);

  model.scheduledSender.start({
    endpointId: 'serial-1', sessionId: 's2', intervalMs: 100, count: null,
    request: { endpointId: 'serial-1', bytes: Uint8Array.of(3) },
  });
  model.resetWorkspaceState();
  assert.equal(model.scheduledSender.getStatus('serial-1').active, false);
  model.dispose();
});

test('scheduled jobs remain active across endpoint selection and restore by endpoint identity', async () => {
  const { adapter } = createAdapter({
    endpoints: [endpoint('serial-1', 'serial'), endpoint('tcp-client-1', 'tcp-client')],
  });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });
  model.scheduledSender.start({
    endpointId: 'serial-1', sessionId: 's1', intervalMs: 100, count: null,
    request: { endpointId: 'serial-1', bytes: Uint8Array.of(1) },
  });

  model.selectEndpoint('tcp-client-1');
  assert.equal(model.scheduledSender.getStatus('serial-1').active, true);
  model.selectEndpoint('serial-1');
  assert.equal(model.scheduledSender.getStatus(model.state.activeEndpointId).active, true);

  assert.equal(model.scheduledSender.stop('serial-1', 's1'), true);
  model.dispose();
});

test('subscribes exactly once and dispose invokes every unsubscribe once and makes events inert', () => {
  const { adapter, emit, subscriptionCounts, unsubscribeCounts } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });

  assert.deepEqual(subscriptionCounts, { frames: 1, status: 1, peers: 1 });
  model.dispose();
  model.dispose();
  emit.frames({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1', frames: [frame('late')] });
  emit.status(statusEvent('op1', 's1', 'open', 'late', 'serial-1'));

  assert.deepEqual(unsubscribeCounts, { frames: 1, status: 1, peers: 1 });
  assert.deepEqual(model.state.frames, []);
  assert.deepEqual(model.state.logs, []);
  assert.equal(model.state.disposed, true);
});

test('commands surface runtime failures consistently without rejected promises', async () => {
  const failure = Object.assign(new Error('open failed'), { code: 'OPEN_FAILED' });
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async () => { throw failure; };
  adapter.transport.send = async () => { throw failure; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const openResult = await model.commands.open('serial-1', 'op1');
  const sendResult = await model.commands.send({ endpointId: 'serial-1', bytes: Uint8Array.of(1) });

  assert.deepEqual(openResult, { ok: false, error: failure });
  assert.deepEqual(sendResult, { ok: false, error: failure });
  assert.equal(model.state.commandError, failure);
});

test('successful sends persist one immutable send-history snapshot', async () => {
  const { adapter } = createAdapter({ endpoints: [endpoint('tcp-server-1', 'tcp-server')] });
  const records = [];
  adapter.transport.send = async () => ({
    endpointId: 'tcp-server-1', sessionId: 'session-1', byteCount: 3,
  });
  adapter.sendHistory.record = async (record) => {
    records.push(structuredClone(record));
    return { id: 1, ...record, byteCount: 3 };
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const bytes = Uint8Array.of(0, 128, 255);

  const result = await model.commands.send({
    endpointId: 'tcp-server-1', bytes, target: { peerId: 'peer-1' },
    format: 'hex', framing: 'none',
  });
  bytes.fill(7);

  assert.equal(result.ok, true);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    endpointId: 'tcp-server-1', sessionId: 'session-1', peerId: 'peer-1',
    target: { peerId: 'peer-1' }, format: 'hex', framing: 'none',
    payloadBase64: 'AID/', createdAt: records[0].createdAt,
  });
  assert.equal(Number.isSafeInteger(records[0].createdAt), true);
  assert.equal(records[0].createdAt >= 1_000_000_000_000, true);
});

test('send-history persistence failure does not turn a successful send into a failed send', async () => {
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.send = async () => ({
    endpointId: 'serial-1', sessionId: 'session-1', byteCount: 1,
  });
  adapter.sendHistory.record = async () => { throw new Error('history unavailable'); };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const result = await model.commands.send({
    endpointId: 'serial-1', bytes: Uint8Array.of(1), format: 'hex', framing: 'none',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    endpointId: 'serial-1', sessionId: 'session-1', byteCount: 1,
    historyPersisted: false, historyError: 'history unavailable',
  });
  assert.equal(model.commandErrorForEndpoint('serial-1'), null);
});

test('reverse-order endpoint loads only allow the newest result to apply', async () => {
  const first = deferred();
  const second = deferred();
  const { adapter } = createAdapter();
  let call = 0;
  adapter.endpoint.list = () => (++call === 1 ? first.promise : second.promise);
  const model = createWorkbenchModel(adapter);

  const oldLoad = model.commands.loadEndpoints();
  const newLoad = model.commands.loadEndpoints();
  second.resolve([endpoint('new', 'serial')]);
  assert.equal((await newLoad).ok, true);
  first.resolve([endpoint('old', 'serial')]);
  assert.equal((await oldLoad).ok, true);

  assert.deepEqual(model.state.endpoints.map(({ id }) => id), ['new']);
});

test('endpoint list resolution or rejection after dispose cannot mutate model state', async () => {
  const pendingSuccess = deferred();
  const pendingFailure = deferred();
  const { adapter } = createAdapter();
  let call = 0;
  adapter.endpoint.list = () => (++call === 1 ? pendingSuccess.promise : pendingFailure.promise);
  const model = createWorkbenchModel(adapter);
  const succeeding = model.commands.loadEndpoints();
  const failing = model.commands.loadEndpoints();
  model.dispose();

  pendingSuccess.resolve([endpoint('late', 'serial')]);
  pendingFailure.reject(new Error('late failure'));
  assert.equal((await succeeding).ok, true);
  assert.equal((await failing).ok, false);
  assert.deepEqual(model.state.endpoints, []);
  assert.equal(model.state.commandError, null);
});

test('an older command failure cannot overwrite a newer success', async () => {
  const first = deferred();
  const second = deferred();
  const { adapter } = createAdapter();
  let call = 0;
  adapter.endpoint.list = () => (++call === 1 ? first.promise : second.promise);
  const model = createWorkbenchModel(adapter);

  const oldLoad = model.commands.loadEndpoints();
  const newLoad = model.commands.loadEndpoints();
  second.resolve([endpoint('new', 'serial')]);
  assert.equal((await newLoad).ok, true);
  first.reject(new Error('old failure'));
  assert.equal((await oldLoad).ok, false);

  assert.equal(model.state.commandError, null);
  assert.deepEqual(model.state.endpoints.map(({ id }) => id), ['new']);
});

test('malformed endpoint list results are returned inside the command error envelope', async () => {
  for (const malformed of [
    null,
    Array(1),
    [endpoint('duplicate', 'serial'), endpoint('duplicate', 'serial')],
    [{ id: '', name: 'bad', transport: 'serial', config: {} }],
  ]) {
    const { adapter } = createAdapter();
    adapter.endpoint.list = async () => malformed;
    const model = createWorkbenchModel(adapter);
    const result = await model.commands.loadEndpoints();

    assert.equal(result.ok, false);
    assert.equal(result.error instanceof TypeError, true);
    assert.equal(model.state.commandError, result.error);
    assert.deepEqual(model.state.endpoints, []);
  }
});

test('cancel invalidates a pending open before runtime completion or events', async () => {
  const pendingOpen = deferred();
  const { adapter, emit } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = () => pendingOpen.promise;
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('serial-1', 'open-op');
  await tick();

  const cancelling = model.commands.cancelOpen('serial-1', 'open-op');
  emit.status(statusEvent('open-op', 'late-session', 'open', 'late', 'serial-1'));
  pendingOpen.resolve({ sessionId: 'late-session' });

  assert.equal((await cancelling).ok, true);
  const openResult = await opening;
  assert.equal(openResult.ok, false);
  assert.equal(openResult.error.code, 'OPEN_CANCELLED');
  assert.equal(model.state.operations.has('serial-1'), false);
  assert.equal(model.state.statuses.has('serial-1'), false);
  assert.deepEqual(model.state.logs, []);
});

test('failed close still invalidates a pending open and surfaces its error', async () => {
  const pendingOpen = deferred();
  const closeFailure = new Error('close failed');
  const { adapter, emit } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = () => pendingOpen.promise;
  adapter.transport.close = async () => { throw closeFailure; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('serial-1', 'open-op');

  const closing = model.commands.close('serial-1');
  emit.frames({
    endpointId: 'serial-1', sessionId: 'late-session', operationId: 'open-op',
    frames: [frame('late', 'in', null, 'late', 'serial-1', 'late-session')],
  });
  pendingOpen.resolve({ sessionId: 'late-session' });

  assert.deepEqual(await closing, { ok: false, error: closeFailure });
  assert.equal((await opening).error.code, 'OPEN_CANCELLED');
  assert.equal(model.state.operations.has('serial-1'), false);
  assert.deepEqual(model.state.frames, []);
  assert.equal(model.state.commandError, closeFailure);
});

test('subscription failure cleans every previously acquired subscription exactly once', async () => {
  for (const failingName of ['status', 'peers']) {
    const { adapter, unsubscribeCounts } = createAdapter();
    for (const name of ['frames', 'status', 'peers']) {
      adapter.transport[`on${capitalize(name)}`] = () => {
        if (name === failingName) throw new Error(`${name} subscribe failed`);
        let stopped = false;
        return async () => {
          if (stopped) return;
          stopped = true;
          unsubscribeCounts[name] += 1;
          if (name === 'frames') throw new Error('async unsubscribe failed');
        };
      };
    }

    assert.throws(() => createWorkbenchModel(adapter), new RegExp(`${failingName} subscribe failed`));
    await tick();
    assert.equal(unsubscribeCounts.frames, 1);
    assert.equal(unsubscribeCounts.status, failingName === 'peers' ? 1 : 0);
    assert.equal(unsubscribeCounts.peers, 0);
  }
});

test('a malformed frame batch causes zero mutation and does not throw through emitter', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: null, operationId: 'op1' });

  assert.doesNotThrow(() => emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('valid', 'in', null, 'valid', 'serial-1', 's1'), null],
  }));
  assert.doesNotThrow(() => emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1', frames: Array(1),
  }));

  assert.equal(model.state.operations.get('serial-1').sessionId, null);
  assert.deepEqual(model.state.frames, []);
  assert.deepEqual(model.state.counters, { received: 0, sent: 0, frames: 0, logs: 0 });
});

test('missing event session cannot poison operation binding', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'serial-1', sessionId: null, operationId: 'op1' });

  assert.doesNotThrow(() => emit.status({
    endpointId: 'serial-1', operationId: 'op1', status: 'open', log: null,
  }));

  assert.equal(model.state.operations.get('serial-1').sessionId, null);
  assert.equal(model.state.statuses.size, 0);
});

test('native peer contract reaches the workbench without nested session identity', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  const nativeEvent = normalizeTransportPeerEvent({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    peers: [{ id: 'native-peer', remoteAddress: '127.0.0.1:19000', connectedAt: 1 }],
  });
  emit.peers(nativeEvent);
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), nativeEvent.peers);

  emit.peers({ ...nativeEvent, sessionId: 'stale-session', peers: [] });
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), nativeEvent.peers);
  emit.peers({ ...nativeEvent, peers: [{ id: 'missing-address' }] });
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), nativeEvent.peers);
  emit.peers({ ...nativeEvent, peers: [] });
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), []);
  model.dispose();
});

test('nested frame and Peer identity mismatches are ignored with zero mutation', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: null, operationId: 'op1' });

  emit.frames({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('spoof', 'in', null, 'spoof', 'other-endpoint', 's1')],
  });
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    peers: [{ id: 'peer-1', endpointId: 'tcp-server-1', sessionId: 'other-session' }],
  });

  assert.equal(model.state.operations.get('tcp-server-1').sessionId, null);
  assert.deepEqual(model.state.frames, []);
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), []);
});

test('stored endpoints and runtime events do not alias source objects or bytes', async () => {
  const sourceEndpoint = endpoint('tcp-server-1', 'tcp-server');
  sourceEndpoint.config.host = 'before';
  const sourceEndpoints = [sourceEndpoint];
  const { adapter, emit } = createAdapter({ endpoints: sourceEndpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.selectEndpoint('tcp-server-1');
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  const sourceFrame = frame('frame-1', 'in', 'peer-1', 'before', 'tcp-server-1', 's1');
  sourceFrame.bytes = Uint8Array.of(0x41);
  const sourceStatus = statusEvent('op1', 's1', 'open', 'before');
  sourceStatus.log.source = 'tcp';
  const sourcePeer = peer('peer-1');
  emit.frames({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', frames: [sourceFrame],
  });
  emit.status(sourceStatus);
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [sourcePeer],
  });

  sourceEndpoint.name = 'mutated';
  sourceEndpoint.config.host = 'mutated';
  sourceEndpoints.push(endpoint('injected', 'serial'));
  sourceFrame.text = 'mutated';
  sourceFrame.bytes[0] = 0xff;
  sourceStatus.status = 'closed';
  sourceStatus.log.message = 'mutated';
  sourcePeer.id = 'mutated';

  assert.equal(model.state.endpoints[0].name, 'tcp-server-1');
  assert.equal(model.state.endpoints[0].config.host, 'before');
  assert.equal(model.state.endpoints.length, 1);
  assert.equal(model.state.frames[0].text, 'before');
  assert.deepEqual(model.state.frames[0].bytes, Uint8Array.of(0x41));
  assert.equal(model.state.statuses.get('tcp-server-1').status, 'open');
  assert.equal(model.state.logs[0].message, 'before');
  assert.equal(model.peersForEndpoint('tcp-server-1')[0].id, 'peer-1');
});

test('endpoint refresh prunes every removed endpoint state bucket and selection', async () => {
  const { adapter, emit } = createAdapter({ endpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.selectEndpoint('tcp-server-1');
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  emit.frames({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('removed-frame')],
  });
  emit.status(statusEvent('op1', 's1', 'open', 'removed-log'));
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('peer-1')],
  });
  model.selectPeer('peer-1');
  adapter.endpoint.list = async () => [endpoint('serial-1', 'serial')];

  assert.equal((await model.commands.loadEndpoints()).ok, true);
  emit.status(statusEvent('op1', 's1', 'open', 'late-removed'));

  assert.equal(model.state.activeEndpointId, null);
  assert.equal(model.state.activePeerId, null);
  assert.equal(model.state.operations.has('tcp-server-1'), false);
  assert.equal(model.state.statuses.has('tcp-server-1'), false);
  assert.equal(model.state.peers.has('tcp-server-1'), false);
  assert.deepEqual(model.state.frames, []);
  assert.deepEqual(model.state.logs, []);
  assert.deepEqual(model.state.counters, { received: 0, sent: 0, frames: 0, logs: 0 });
});

test('an endpoint load started before delete cannot restore the deleted endpoint', async () => {
  const removed = endpoint('removed', 'serial');
  const pendingList = deferred();
  const { adapter } = createAdapter({ endpoints: [removed] });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  adapter.endpoint.list = () => pendingList.promise;

  const staleLoad = model.commands.loadEndpoints();
  assert.equal((await model.commands.delete('removed')).ok, true);
  pendingList.resolve([removed]);
  assert.equal((await staleLoad).ok, true);

  assert.deepEqual(model.state.endpoints, []);
});

test('a successful save prevents an older endpoint list from overwriting collection state', async () => {
  const current = endpoint('current', 'serial');
  const pendingList = deferred();
  const { adapter } = createAdapter({ endpoints: [current] });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  adapter.endpoint.list = () => pendingList.promise;

  const staleLoad = model.commands.loadEndpoints();
  assert.equal((await model.commands.save(endpoint('saved', 'serial'))).ok, true);
  pendingList.resolve([endpoint('stale', 'serial')]);
  assert.equal((await staleLoad).ok, true);

  assert.deepEqual(model.state.endpoints.map(({ id }) => id), ['current', 'saved']);
});

test('delete intent and success invalidate a pending open before its late resolution', async () => {
  const pendingOpen = deferred();
  const pendingDelete = deferred();
  const removed = endpoint('removed', 'serial');
  const { adapter, emit } = createAdapter({ endpoints: [removed] });
  adapter.transport.open = () => pendingOpen.promise;
  adapter.endpoint.delete = () => pendingDelete.promise;
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('removed', 'open-op');

  const deleting = model.commands.delete('removed');
  assert.equal(model.state.operations.has('removed'), false);
  assert.equal(model.state.statuses.has('removed'), false);
  pendingDelete.resolve(null);
  assert.equal((await deleting).ok, true);

  pendingOpen.resolve({ sessionId: 'late-session' });
  assert.equal((await opening).error.code, 'OPEN_CANCELLED');
  emit.status(statusEvent('open-op', 'late-session', 'open', 'late', 'removed'));
  assert.equal(model.state.operations.has('removed'), false);
  assert.equal(model.state.statuses.has('removed'), false);
});

test('refresh removal invalidates a pending open and prevents late recreation', async () => {
  const pendingOpen = deferred();
  const removed = endpoint('removed', 'serial');
  const { adapter, emit } = createAdapter({ endpoints: [removed] });
  adapter.transport.open = () => pendingOpen.promise;
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('removed', 'open-op');
  adapter.endpoint.list = async () => [];

  assert.equal((await model.commands.loadEndpoints()).ok, true);
  pendingOpen.resolve({ sessionId: 'late-session' });
  assert.equal((await opening).error.code, 'OPEN_CANCELLED');
  emit.status(statusEvent('open-op', 'late-session', 'open', 'late', 'removed'));

  assert.equal(model.state.operations.has('removed'), false);
  assert.equal(model.state.statuses.has('removed'), false);
  assert.deepEqual(model.state.logs, []);
});

test('every command after dispose is inert and does not invoke runtime', async () => {
  const runtimeCalls = [];
  const { adapter } = createAdapter();
  for (const [namespace, methods] of Object.entries({
    endpoint: ['list', 'save', 'clone', 'delete'],
    transport: ['scanSerialPorts', 'open', 'cancelOpen', 'close', 'send', 'disconnectPeer'],
  })) {
    for (const method of methods) {
      adapter[namespace][method] = async () => {
        runtimeCalls.push(`${namespace}.${method}`);
        return null;
      };
    }
  }
  const model = createWorkbenchModel(adapter);
  model.activateOperation({ endpointId: 'endpoint-1', sessionId: 's1', operationId: 'op1' });
  model.dispose();
  const before = snapshotModelState(model.state);

  const results = await Promise.all([
    model.commands.loadEndpoints(),
    model.commands.save(endpoint('endpoint-1', 'serial')),
    model.commands.clone('endpoint-1'),
    model.commands.delete('endpoint-1'),
    model.commands.scanSerialPorts(),
    model.commands.open('endpoint-1', 'op2'),
    model.commands.cancelOpen('endpoint-1', 'op1'),
    model.commands.cancelReconnect('endpoint-1'),
    model.commands.close('endpoint-1'),
    model.commands.send({ endpointId: 'endpoint-1', bytes: Uint8Array.of(1) }),
    model.commands.disconnectPeer({ endpointId: 'endpoint-1', peerId: 'peer-1' }),
  ]);

  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(result.error.name, 'WorkbenchDisposedError');
    assert.equal(result.error.code, 'WORKBENCH_DISPOSED');
  }
  assert.deepEqual(runtimeCalls, []);
  assert.deepEqual(snapshotModelState(model.state), before);
});

test('validated event application errors remain observable', () => {
  const { adapter, emit } = createAdapter();
  const model = createWorkbenchModel(adapter, { frameLimit: Symbol('invalid limit') });
  model.activateOperation({ endpointId: 'serial-1', sessionId: 's1', operationId: 'op1' });

  assert.throws(() => emit.frames({
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('frame-1', 'in', null, 'frame', 'serial-1', 's1')],
  }), /Symbol/);
});

test('non-Error command rejection is normalized once and reused', async () => {
  const { adapter } = createAdapter();
  adapter.transport.send = async () => { throw 'string failure'; };
  const model = createWorkbenchModel(adapter);

  const result = await model.commands.send({ endpointId: 'serial-1' });

  assert.equal(result.ok, false);
  assert.equal(result.error instanceof Error, true);
  assert.equal(result.error.message, 'string failure');
  assert.equal(result.error, model.state.commandError);
});

test('close then open executes in issue order and leaves runtime and model connected', async () => {
  const closeGate = deferred();
  const calls = [];
  const runtimeState = { connected: true };
  const profile = endpoint('serial-1', 'serial');
  const { adapter } = createAdapter({ endpoints: [profile] });
  adapter.transport.close = async (endpointId) => {
    calls.push(['close:start', endpointId]);
    await closeGate.promise;
    runtimeState.connected = false;
    calls.push(['close:end', endpointId]);
  };
  adapter.transport.open = async (endpointId, options) => {
    calls.push(['open', endpointId, options]);
    runtimeState.connected = true;
    return { sessionId: 'session-2' };
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.activateOperation({ endpointId: 'serial-1', sessionId: 'session-1', operationId: 'old' });

  const closing = model.commands.close('serial-1');
  const opening = model.commands.open('serial-1', 'new-open');
  await tick();
  assert.deepEqual(calls, [['close:start', 'serial-1']]);
  closeGate.resolve();
  assert.equal((await closing).ok, true);
  assert.equal((await opening).ok, true);

  assert.deepEqual(calls, [
    ['close:start', 'serial-1'],
    ['close:end', 'serial-1'],
    ['open', 'serial-1', { operationId: 'new-open' }],
  ]);
  assert.equal(runtimeState.connected, true);
  assert.equal(model.state.operations.get('serial-1').sessionId, 'session-2');
});

test('completed open then close executes in issue order and leaves runtime and model closed', async () => {
  const openGate = deferred();
  const calls = [];
  const runtimeState = { connected: false };
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async () => {
    calls.push('open:start');
    await openGate.promise;
    runtimeState.connected = true;
    calls.push('open:end');
    return { sessionId: 'session-1' };
  };
  adapter.transport.close = async () => {
    calls.push('close');
    runtimeState.connected = false;
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const opening = model.commands.open('serial-1', 'open-op');
  await tick();
  assert.deepEqual(calls, ['open:start']);
  openGate.resolve();
  assert.equal((await opening).ok, true);
  const closing = model.commands.close('serial-1');
  assert.equal((await closing).ok, true);

  assert.deepEqual(calls, ['open:start', 'open:end', 'close']);
  assert.equal(runtimeState.connected, false);
  assert.equal(model.state.operations.has('serial-1'), false);
});

test('failed queued close does not poison a later open', async () => {
  const calls = [];
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.close = async () => {
    calls.push('close');
    throw new Error('close failed');
  };
  adapter.transport.open = async () => {
    calls.push('open');
    return { sessionId: 'session-1' };
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const closing = model.commands.close('serial-1');
  const opening = model.commands.open('serial-1', 'open-op');

  assert.equal((await closing).ok, false);
  assert.equal((await opening).ok, true);
  assert.deepEqual(calls, ['close', 'open']);
  assert.equal(model.state.operations.get('serial-1').sessionId, 'session-1');
});

test('different endpoint runtime queues execute concurrently', async () => {
  const firstGate = deferred();
  const started = [];
  const { adapter } = createAdapter({
    endpoints: [endpoint('a', 'serial'), endpoint('b', 'serial')],
  });
  adapter.transport.open = async (endpointId) => {
    started.push(endpointId);
    if (endpointId === 'a') await firstGate.promise;
    return { sessionId: `${endpointId}-session` };
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const first = model.commands.open('a', 'a-open');
  const second = model.commands.open('b', 'b-open');
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  assert.equal((await second).ok, true);
  firstGate.resolve();
  assert.equal((await first).ok, true);
});

test('cancel bypasses the queue, reaches an in-flight open, and blocks late binding', async () => {
  const pendingOpen = deferred();
  const calls = [];
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async (...args) => {
    calls.push(['open', ...args]);
    return pendingOpen.promise;
  };
  adapter.transport.cancelOpen = async (...args) => {
    calls.push(['cancel', ...args]);
    return null;
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const opening = model.commands.open('serial-1', 'open-op');
  await tick();
  const cancelling = model.commands.cancelOpen('serial-1', 'open-op');
  assert.equal((await cancelling).ok, true);
  assert.deepEqual(calls, [
    ['open', 'serial-1', { operationId: 'open-op' }],
    ['cancel', 'serial-1', { operationId: 'open-op' }],
  ]);
  pendingOpen.resolve({ sessionId: 'late-session' });
  assert.equal((await opening).error.code, 'OPEN_CANCELLED');
  assert.equal(model.state.operations.has('serial-1'), false);
});

test('dispose prevents a queued open from invoking runtime', async () => {
  const closeGate = deferred();
  let openCalls = 0;
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.close = () => closeGate.promise;
  adapter.transport.open = async () => {
    openCalls += 1;
    return { sessionId: 'session-1' };
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const closing = model.commands.close('serial-1');
  const opening = model.commands.open('serial-1', 'open-op');
  await tick();
  model.dispose();
  closeGate.resolve();
  const closeResult = await closing;
  assert.equal(closeResult.ok, false);
  assert.equal(closeResult.error.code, 'WORKBENCH_DISPOSED');
  const result = await opening;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WORKBENCH_DISPOSED');
  assert.equal(openCalls, 0);
});

test('clone validates and forwards exact integration arguments then upserts its profile', async () => {
  const calls = [];
  const cloneProfile = endpoint('clone-1', 'serial');
  cloneProfile.name = 'Clone';
  const { adapter } = createAdapter({ endpoints: [endpoint('source-1', 'serial')] });
  adapter.endpoint.clone = async (...args) => {
    calls.push(args);
    return cloneProfile;
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const result = await model.commands.clone('source-1', { id: 'clone-1', name: 'Clone' });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['source-1', { id: 'clone-1', name: 'Clone' }]]);
  assert.deepEqual(model.state.endpoints.map(({ id }) => id), ['source-1', 'clone-1']);
});

test('clone rejects missing source or new identity without invoking runtime', async () => {
  let cloneCalls = 0;
  const { adapter } = createAdapter();
  adapter.endpoint.clone = async () => { cloneCalls += 1; };
  const model = createWorkbenchModel(adapter);

  for (const args of [
    [null, { id: 'clone-1' }],
    ['source-1'],
    ['source-1', {}],
    ['source-1', { id: '', name: 'Clone' }],
    ['source-1', { id: 'clone-1', name: '' }],
  ]) {
    assert.equal((await model.commands.clone(...args)).ok, false);
  }
  assert.equal(cloneCalls, 0);
});

test('save and clone upserts survive an older endpoint load', async () => {
  const pendingList = deferred();
  const { adapter } = createAdapter({ endpoints: [endpoint('source-1', 'serial')] });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  adapter.endpoint.list = () => pendingList.promise;
  adapter.endpoint.save = async () => endpoint('saved-1', 'serial');
  adapter.endpoint.clone = async () => endpoint('clone-1', 'serial');

  const staleLoad = model.commands.loadEndpoints();
  assert.equal((await model.commands.save(endpoint('saved-1', 'serial'))).ok, true);
  assert.equal((await model.commands.clone('source-1', { id: 'clone-1' })).ok, true);
  pendingList.resolve([endpoint('source-1', 'serial')]);
  assert.equal((await staleLoad).ok, true);

  assert.deepEqual(
    model.state.endpoints.map(({ id }) => id),
    ['source-1', 'saved-1', 'clone-1'],
  );
});

test('saved endpoint is tracked immediately and can be opened', async () => {
  const openCalls = [];
  const saved = endpoint('saved-1', 'serial');
  const { adapter } = createAdapter();
  adapter.endpoint.save = async () => saved;
  adapter.transport.open = async (...args) => {
    openCalls.push(args);
    return { sessionId: 'saved-session' };
  };
  const model = createWorkbenchModel(adapter);

  assert.equal((await model.commands.save(saved)).ok, true);
  assert.deepEqual(model.state.endpoints.map(({ id }) => id), ['saved-1']);
  assert.equal((await model.commands.open('saved-1', 'saved-open')).ok, true);
  assert.deepEqual(openCalls, [['saved-1', { operationId: 'saved-open' }]]);
  assert.equal(model.state.operations.get('saved-1').sessionId, 'saved-session');
});

test('Modbus master scheduler auto-starts with an open session and stops on close', async () => {
  const timers = createFakeTimers();
  const master = {
    ...endpoint('modbus-master-1', 'modbus-tcp-master'),
    config: {
      host: '127.0.0.1', port: 502, enabled: true, timeoutMs: 1000,
      retryCount: 0, retryIntervalMs: 0,
      scheduler: { minGapMs: 0, autoStart: true },
      requestGroups: [{
        id: 'read-1', name: '读取', enabled: true, order: 0, unitId: 1,
        requests: [{
          id: 'holding-1', name: '保持寄存器', enabled: true, order: 0,
          functionCode: 3, startAddress: 0, quantity: 1, intervalMs: 1000,
          timeoutMs: null, retryCount: null, retryIntervalMs: null,
          dataPoints: [],
        }],
      }],
    },
  };
  const { adapter } = createAdapter({ endpoints: [master] });
  adapter.transport.open = async () => ({ sessionId: 'modbus-session-1' });
  adapter.modbus.execute = async (request) => ({
    ...request, sessionId: 'modbus-session-1', origin: 'master', requestValues: [],
    values: [9], success: true, exceptionCode: null, message: null,
    createdAt: timers.now, durationMs: 2,
  });
  const model = createWorkbenchModel(adapter, { timers, clock: () => timers.now });
  await model.commands.loadEndpoints();

  assert.equal((await model.commands.open(master.id, 'open-modbus')).ok, true);
  assert.equal(model.modbusMasterScheduler.getStatus(master.id).active, true);
  await timers.runNext();
  assert.equal(
    model.modbusMasterScheduler.getStatus(master.id)
      .groups['read-1'].requests['holding-1'].successCount,
    1,
  );

  assert.equal((await model.commands.close(master.id)).ok, true);
  assert.equal(model.modbusMasterScheduler.getStatus(master.id).active, false);
  model.dispose();
});

test('Modbus master polling stops on connection failure and resumes after automatic reconnect', async () => {
  const timers = createFakeTimers();
  const master = {
    ...endpoint('modbus-master-1', 'modbus-tcp-master'),
    config: {
      host: '127.0.0.1', port: 502, enabled: true, autoReconnect: true,
      timeoutMs: 1000, retryCount: 0, retryIntervalMs: 0,
      scheduler: { minGapMs: 0, autoStart: true },
      requestGroups: [{
        id: 'read-1', name: '读取', enabled: true, order: 0, unitId: 1,
        requests: [{
          id: 'holding-1', name: '保持寄存器', enabled: true, order: 0,
          functionCode: 3, startAddress: 0, quantity: 1, intervalMs: 1000,
          timeoutMs: null, retryCount: null, retryIntervalMs: null,
          dataPoints: [],
        }],
      }],
    },
  };
  const { adapter, emit } = createAdapter({ endpoints: [master] });
  let opens = 0;
  let executions = 0;
  adapter.transport.open = async () => {
    opens += 1;
    return { sessionId: `modbus-session-${opens}` };
  };
  adapter.modbus.execute = async (request) => {
    executions += 1;
    return {
      ...request, sessionId: `modbus-session-${opens}`, origin: 'master', requestValues: [],
      values: [executions], success: true, exceptionCode: null, message: null,
      createdAt: timers.now, durationMs: 2,
    };
  };
  const model = createWorkbenchModel(adapter, {
    timers,
    clock: () => timers.now,
    createReconnectOperationId: ({ attempt }) => `modbus-retry-${attempt}`,
  });
  await model.commands.loadEndpoints();
  await model.commands.open(master.id, 'open-modbus');
  await timers.runNext();
  assert.equal(executions, 1);

  emit.status(tcpStatus(master.id, 'open-modbus', 'modbus-session-1', 'error'));
  assert.equal(model.modbusMasterScheduler.getStatus(master.id).active, false);

  await timers.runNext();
  assert.equal(opens, 2);
  assert.equal(model.modbusMasterScheduler.getStatus(master.id).active, true);
  await timers.runNext();
  assert.equal(executions, 2);
  assert.equal(
    model.modbusMasterScheduler.getStatus(master.id)
      .groups['read-1'].requests['holding-1'].successCount,
    1,
  );
  model.dispose();
});

test('loading a version 2 Modbus master defaults write commands without persisting until save', async () => {
  const legacy = {
    ...endpoint('legacy-master', 'modbus-tcp-master'),
    config: {
      configVersion: 2, marker: 'preserved', host: '192.168.1.20', port: 502,
      requestGroups: [{
        id: 'environment', name: 'Environment', unitId: 7, enabled: true, order: 0,
        functionCode: 3, startAddress: 100, quantity: 10, intervalMs: 1000,
        dataPoints: [{ id: 'temperature', key: 'temperature', name: 'Temperature', offset: 0 }],
      }],
    },
  };
  const saveCalls = [];
  const { adapter } = createAdapter({ endpoints: [legacy] });
  adapter.endpoint.save = async (value) => {
    saveCalls.push(value);
    return value;
  };
  const model = createWorkbenchModel(adapter);

  assert.equal((await model.commands.loadEndpoints()).ok, true);
  assert.deepEqual(saveCalls, []);
  assert.equal(model.state.endpoints[0].config.configVersion, 2);

  const loaded = model.state.endpoints[0];
  const upgraded = {
    ...loaded,
    config: { ...loaded.config, ...normalizeModbusConfig(loaded.config, loaded.transport) },
  };
  assert.deepEqual(upgraded.config.writeCommands, []);
  assert.deepEqual(saveCalls, []);
  assert.equal((await model.commands.save(upgraded)).ok, true);
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].config.configVersion, 3);
  assert.equal(saveCalls[0].config.marker, 'preserved');
  assert.deepEqual(saveCalls[0].config.requestGroups[0].requests.map(({ id }) => id), [
    'environment-request',
  ]);
  assert.equal(saveCalls[0].config.requestGroups[0].requests[0].dataPoints[0].id, 'temperature');
  model.dispose();
});

test('malformed save and clone results stay enveloped without collection mutation', async () => {
  const source = endpoint('source-1', 'serial');
  const { adapter } = createAdapter({ endpoints: [source] });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  adapter.endpoint.save = async () => null;
  adapter.endpoint.clone = async () => ({ id: 'bad' });

  const saveResult = await model.commands.save(endpoint('saved-1', 'serial'));
  const cloneResult = await model.commands.clone('source-1', { id: 'clone-1' });

  assert.equal(saveResult.ok, false);
  assert.equal(cloneResult.ok, false);
  assert.deepEqual(model.state.endpoints.map(({ id }) => id), ['source-1']);
});

test('open rejects unknown and queued-then-removed endpoints without runtime calls', async () => {
  const closeGate = deferred();
  let openCalls = 0;
  const removable = endpoint('removable', 'serial');
  const { adapter } = createAdapter({ endpoints: [removable] });
  adapter.transport.close = () => closeGate.promise;
  adapter.transport.open = async () => {
    openCalls += 1;
    return { sessionId: 'session-1' };
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const unknown = await model.commands.open('unknown', 'unknown-open');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'ENDPOINT_NOT_FOUND');
  const closing = model.commands.close('removable');
  const queuedOpen = model.commands.open('removable', 'queued-open');
  await tick();
  assert.equal((await model.commands.delete('removable')).ok, true);
  closeGate.resolve();
  assert.equal((await closing).ok, true);
  const removed = await queuedOpen;

  assert.equal(removed.ok, false);
  assert.equal(removed.error.code, 'ENDPOINT_NOT_FOUND');
  assert.equal(openCalls, 0);
});

test('replacement open intent immediately rejects every old-operation event', async () => {
  const firstOpen = deferred();
  const calls = [];
  const { adapter, emit } = createAdapter({
    endpoints: [endpoint('tcp-server-1', 'tcp-server')],
  });
  adapter.transport.open = async (endpointId, { operationId }) => {
    calls.push(['open', operationId]);
    if (operationId === 'op1') return firstOpen.promise;
    return { sessionId: 's2' };
  };
  adapter.transport.cancelOpen = async (endpointId, { operationId }) => {
    calls.push(['cancel', operationId]);
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const oldOpening = model.commands.open('tcp-server-1', 'op1');
  await tick();
  emit.status(statusEvent('op1', 's1', 'open', 'old-before-intent'));
  const before = {
    frames: model.state.frames.length,
    logs: model.state.logs.length,
    counters: { ...model.state.counters },
  };

  const replacement = model.commands.open('tcp-server-1', 'op2');
  assert.deepEqual(model.state.operations.get('tcp-server-1'), {
    endpointId: 'tcp-server-1', sessionId: null, operationId: 'op2',
  });
  emit.status(statusEvent('op1', 's1', 'open', 'stale-log'));
  emit.frames({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
    frames: [frame('stale-frame')],
  });
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('stale')],
  });

  assert.equal(model.state.frames.length, before.frames);
  assert.equal(model.state.logs.length, before.logs);
  assert.deepEqual(model.state.counters, before.counters);
  assert.deepEqual(model.peersForEndpoint('tcp-server-1'), []);
  assert.equal((await settlesWithin(replacement)).ok, true);
  assert.equal((await settlesWithin(oldOpening)).ok, false);
  assert.deepEqual(calls, [['open', 'op1'], ['cancel', 'op1'], ['open', 'op2']]);
});

test('unresolved open is locally aborted so close cancels then settles', async () => {
  const neverOpen = deferred();
  const calls = [];
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async () => {
    calls.push('open');
    return neverOpen.promise;
  };
  adapter.transport.cancelOpen = async (...args) => { calls.push(['cancel', ...args]); };
  adapter.transport.close = async (...args) => { calls.push(['close', ...args]); };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('serial-1', 'op1');
  await tick();

  const closeResult = await settlesWithin(model.commands.close('serial-1'));
  const openResult = await settlesWithin(opening);

  assert.equal(closeResult.ok, true);
  assert.equal(openResult.ok, false);
  assert.equal(openResult.error.code, 'OPEN_CANCELLED');
  assert.deepEqual(calls, [
    'open',
    ['cancel', 'serial-1', { operationId: 'op1' }],
    ['close', 'serial-1'],
  ]);
  assert.equal(model.state.operations.has('serial-1'), false);
});

test('unresolved open is aborted by replacement so the newer open can settle', async () => {
  const neverOpen = deferred();
  const calls = [];
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async (endpointId, { operationId }) => {
    calls.push(['open', operationId]);
    return operationId === 'op1' ? neverOpen.promise : { sessionId: 's2' };
  };
  adapter.transport.cancelOpen = async (endpointId, { operationId }) => {
    calls.push(['cancel', operationId]);
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const first = model.commands.open('serial-1', 'op1');
  await tick();

  const second = await settlesWithin(model.commands.open('serial-1', 'op2'));
  const firstResult = await settlesWithin(first);

  assert.equal(second.ok, true);
  assert.equal(firstResult.ok, false);
  assert.deepEqual(calls, [['open', 'op1'], ['cancel', 'op1'], ['open', 'op2']]);
  assert.equal(model.state.operations.get('serial-1').sessionId, 's2');
});

test('dispose aborts unresolved and queued opens and late runtime settlement is inert', async () => {
  const unresolved = deferred();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const calls = [];
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async (endpointId, { operationId }) => {
    calls.push(['open', operationId]);
    return unresolved.promise;
  };
  adapter.transport.cancelOpen = async (endpointId, { operationId }) => {
    calls.push(['cancel', operationId]);
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const first = model.commands.open('serial-1', 'op1');
  await tick();
  const second = model.commands.open('serial-1', 'op2');

  try {
    model.dispose();
    const [firstResult, secondResult] = await Promise.all([
      settlesWithin(first),
      settlesWithin(second),
    ]);
    assert.equal(firstResult.ok, false);
    assert.equal(secondResult.ok, false);
    assert.equal(model.state.operations.has('serial-1'), false);

    unresolved.reject(new Error('late rejected open'));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
    assert.equal(model.state.operations.has('serial-1'), false);
    assert.deepEqual(calls, [['open', 'op1'], ['cancel', 'op1']]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('explicit cancel rejection keeps the original open tracked until it settles', async () => {
  const neverOpen = deferred();
  const failure = new Error('cancel failed');
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = () => neverOpen.promise;
  adapter.transport.cancelOpen = async () => { throw failure; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('serial-1', 'op1');
  await tick();

  const cancelResult = await model.commands.cancelOpen('serial-1', 'op1');
  assert.deepEqual(cancelResult, { ok: false, error: failure });
  assert.deepEqual(model.state.operations.get('serial-1'), {
    endpointId: 'serial-1', sessionId: null, operationId: 'op1',
  });

  neverOpen.resolve({ sessionId: 'original-session' });
  assert.equal((await opening).ok, true);
  assert.equal(model.state.operations.get('serial-1').sessionId, 'original-session');
});

test('cancelled open bookkeeping retires across repeated operation identities', async () => {
  const pending = [];
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = () => {
    const next = deferred();
    pending.push(next);
    return next.promise;
  };
  adapter.transport.cancelOpen = async () => null;
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  for (let index = 0; index < 25; index += 1) {
    const opening = model.commands.open('serial-1', 'reused-op');
    await tick();
    assert.equal((await model.commands.cancelOpen('serial-1', 'reused-op')).ok, true);
    assert.equal((await settlesWithin(opening)).ok, false);
    pending[index].resolve({ sessionId: `late-${index}` });
  }
  adapter.transport.open = async () => ({ sessionId: 'final-session' });
  const final = await model.commands.open('serial-1', 'reused-op');

  assert.equal(final.ok, true);
  assert.equal(model.state.operations.get('serial-1').sessionId, 'final-session');
});

test('save and clone reject structurally valid wrong result identities', async () => {
  const source = endpoint('source-1', 'serial');
  const { adapter } = createAdapter({ endpoints: [source] });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  adapter.endpoint.save = async () => endpoint('wrong-save', 'serial');
  adapter.endpoint.clone = async () => endpoint('wrong-clone', 'serial');

  const saveResult = await model.commands.save(endpoint('requested-save', 'serial'));
  assert.equal(saveResult.ok, false);
  assert.equal(saveResult.error.code, 'ENDPOINT_ID_MISMATCH');
  assert.equal(model.state.commandError, saveResult.error);
  const cloneResult = await model.commands.clone('source-1', { id: 'requested-clone' });
  assert.equal(cloneResult.ok, false);
  assert.equal(cloneResult.error.code, 'ENDPOINT_ID_MISMATCH');
  assert.equal(model.state.commandError, cloneResult.error);
  assert.deepEqual(model.state.endpoints.map(({ id }) => id), ['source-1']);
});

test('clone rejects a requested identity equal to its source before runtime', async () => {
  let calls = 0;
  const { adapter } = createAdapter();
  adapter.endpoint.clone = async () => { calls += 1; };
  const model = createWorkbenchModel(adapter);

  const result = await model.commands.clone('source-1', { id: 'source-1' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ENDPOINT_ID_MISMATCH');
  assert.equal(calls, 0);
});

test('failed cancellation prevents close and lets the original open become coherent', async () => {
  const openGate = deferred();
  const cancelFailure = new Error('cancel failed');
  let closeCalls = 0;
  const runtimeState = { connected: false };
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async () => {
    await openGate.promise;
    runtimeState.connected = true;
    return { sessionId: 's1' };
  };
  adapter.transport.cancelOpen = async () => { throw cancelFailure; };
  adapter.transport.close = async () => { closeCalls += 1; runtimeState.connected = false; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('serial-1', 'op1');
  await tick();

  const closeResult = await model.commands.close('serial-1');
  assert.deepEqual(closeResult, { ok: false, error: cancelFailure });
  assert.equal(closeCalls, 0);
  openGate.resolve();
  assert.equal((await opening).ok, true);

  assert.equal(runtimeState.connected, true);
  assert.deepEqual(model.state.operations.get('serial-1'), {
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
  });
});

test('failed cancellation prevents replacement open and restores prior operation gate', async () => {
  const openGate = deferred();
  const cancelFailure = new Error('cancel failed');
  const openCalls = [];
  const { adapter, emit } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async (endpointId, { operationId }) => {
    openCalls.push(operationId);
    if (operationId === 'op1') return openGate.promise;
    return { sessionId: 's2' };
  };
  adapter.transport.cancelOpen = async () => { throw cancelFailure; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const first = model.commands.open('serial-1', 'op1');
  await tick();
  emit.status(statusEvent('op1', 's1', 'open', 'prior-log', 'serial-1'));
  const priorStatus = model.state.statuses.get('serial-1');

  const replacement = model.commands.open('serial-1', 'op2');
  assert.equal(model.state.operations.get('serial-1').operationId, 'op2');
  const replacementResult = await replacement;

  assert.deepEqual(replacementResult, { ok: false, error: cancelFailure });
  assert.deepEqual(openCalls, ['op1']);
  assert.deepEqual(model.state.operations.get('serial-1'), {
    endpointId: 'serial-1', sessionId: 's1', operationId: 'op1',
  });
  assert.equal(model.state.statuses.get('serial-1'), priorStatus);
  openGate.resolve({ sessionId: 's1' });
  assert.equal((await first).ok, true);
});

test('failed replacement cancellation preserves prior reconnect ownership without scheduling', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const firstOpen = deferred();
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = () => firstOpen.promise;
  adapter.transport.cancelOpen = async () => { throw new Error('cancel failed'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  const opening = model.commands.open(client.id, 'manual-1');
  await tick();

  const replacement = await model.commands.open(client.id, 'manual-2');

  assert.equal(replacement.ok, false);
  assert.equal(replacement.error.message, 'cancel failed');
  assert.equal(model.state.operations.get(client.id).operationId, 'manual-1');
  assert.equal(model.reconnectStateFor(client.id), null);
  assert.equal(timers.pendingCount(), 0);
  firstOpen.resolve({ sessionId: 'session-1' });
  assert.equal((await opening).ok, true);
});

test('replacement open rechecks reconnect eligibility after a concurrent save disables it', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const firstOpen = deferred();
  const cancelStarted = deferred();
  const cancelGate = deferred();
  const openCalls = [];
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async (_endpointId, { operationId }) => {
    openCalls.push(operationId);
    if (operationId === 'manual-1') return firstOpen.promise;
    throw new Error('refused');
  };
  adapter.transport.cancelOpen = () => {
    cancelStarted.resolve();
    return cancelGate.promise;
  };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  const opening = model.commands.open(client.id, 'manual-1');
  await tick();
  const replacement = model.commands.open(client.id, 'manual-2');
  await cancelStarted.promise;

  const disabled = { ...client, config: { autoReconnect: false } };
  assert.equal((await model.commands.save(disabled)).ok, true);
  cancelGate.resolve();
  const [openingResult, replacementResult] = await Promise.all([opening, replacement]);

  assert.equal(openingResult.error.code, 'OPEN_CANCELLED');
  assert.equal(replacementResult.error.message, 'refused');
  assert.deepEqual(openCalls, ['manual-1', 'manual-2']);
  assert.equal(model.state.endpoints[0].config.autoReconnect, false);
  assert.equal(model.reconnectStateFor(client.id), null);
  assert.equal(timers.pendingCount(), 0);
});

test('failed cancellation prevents delete and restores the endpoint operation gate', async () => {
  const openGate = deferred();
  const cancelFailure = new Error('cancel failed');
  let deleteCalls = 0;
  const profile = endpoint('serial-1', 'serial');
  const { adapter, emit } = createAdapter({ endpoints: [profile] });
  adapter.transport.open = () => openGate.promise;
  adapter.transport.cancelOpen = async () => { throw cancelFailure; };
  adapter.endpoint.delete = async () => { deleteCalls += 1; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('serial-1', 'op1');
  await tick();
  emit.status(statusEvent('op1', 's1', 'open', null, 'serial-1'));

  const result = await model.commands.delete('serial-1');

  assert.deepEqual(result, { ok: false, error: cancelFailure });
  assert.equal(deleteCalls, 0);
  assert.deepEqual(model.state.endpoints, [profile]);
  assert.equal(model.state.operations.get('serial-1').sessionId, 's1');
  assert.equal(model.state.statuses.get('serial-1').status, 'open');

  openGate.resolve({ sessionId: 's1' });
  assert.equal((await opening).ok, true);
});

test('failed cancellation prevents refresh removal and restores the endpoint operation gate', async () => {
  const openGate = deferred();
  const cancelFailure = new Error('cancel failed');
  const profile = endpoint('serial-1', 'serial');
  const { adapter, emit } = createAdapter({ endpoints: [profile] });
  adapter.transport.open = () => openGate.promise;
  adapter.transport.cancelOpen = async () => { throw cancelFailure; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('serial-1', 'op1');
  await tick();
  emit.status(statusEvent('op1', 's1', 'open', null, 'serial-1'));
  adapter.endpoint.list = async () => [];

  const result = await model.commands.loadEndpoints();

  assert.deepEqual(result, { ok: false, error: cancelFailure });
  assert.deepEqual(model.state.endpoints, [profile]);
  assert.equal(model.state.operations.get('serial-1').sessionId, 's1');
  assert.equal(model.state.statuses.get('serial-1').status, 'open');

  openGate.resolve({ sessionId: 's1' });
  assert.equal((await opening).ok, true);
});

test('open rejection after early session events removes active operation and status gate', async () => {
  const openGate = deferred();
  const { adapter, emit } = createAdapter({ endpoints: [endpoint('tcp-server-1', 'tcp-server')] });
  adapter.transport.open = () => openGate.promise;
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const opening = model.commands.open('tcp-server-1', 'op1');
  await tick();
  const diagnosticStatus = statusEvent('op1', 's1', 'open', 'diagnostic');
  diagnosticStatus.log.source = 'tcp';
  emit.status(diagnosticStatus);
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('peer-1')],
  });
  const counters = { ...model.state.counters };
  openGate.reject(new Error('open failed'));

  assert.equal((await opening).ok, false);
  assert.equal(model.state.operations.has('tcp-server-1'), false);
  assert.equal(model.state.statuses.has('tcp-server-1'), false);
  assert.equal(model.state.peers.has('tcp-server-1'), false);
  assert.deepEqual(model.state.logs.map(({ message }) => message), ['diagnostic']);
  emit.status(statusEvent('op1', 's1', 'late', 'late-log'));
  assert.deepEqual(model.state.counters, counters);
  assert.deepEqual(model.state.logs.map(({ message }) => message), ['diagnostic']);
});

test('dispose settles unresolved close and queued open without invoking queued runtime', async () => {
  const closeGate = deferred();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let openCalls = 0;
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.close = () => closeGate.promise;
  adapter.transport.open = async () => { openCalls += 1; return { sessionId: 's1' }; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const closing = model.commands.close('serial-1');
  const opening = model.commands.open('serial-1', 'op1');
  await tick();

  try {
    model.dispose();
    const [closeResult, openResult] = await Promise.all([
      settlesWithin(closing),
      settlesWithin(opening),
    ]);
    assert.equal(closeResult.ok, false);
    assert.equal(closeResult.error.code, 'WORKBENCH_DISPOSED');
    assert.equal(openResult.ok, false);
    assert.equal(openResult.error.code, 'WORKBENCH_DISPOSED');
    assert.equal(openCalls, 0);

    closeGate.reject(new Error('late close failure'));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('active operation identity reuse is rejected without state or runtime mutation', async () => {
  const calls = [];
  const { adapter, emit } = createAdapter({ endpoints: [endpoint('tcp-server-1', 'tcp-server')] });
  adapter.transport.open = async (...args) => { calls.push(['open', ...args]); };
  adapter.transport.cancelOpen = async (...args) => { calls.push(['cancel', ...args]); };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  emit.status(statusEvent('op1', 's1', 'open', 'existing'));
  emit.peers({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [peer('peer-1')],
  });
  emit.frames({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', frames: [frame('f1')],
  });
  const before = snapshotState(model.state);

  const result = await model.commands.open('tcp-server-1', 'op1');

  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'DuplicateOperationIdError');
  assert.equal(result.error.code, 'DUPLICATE_OPERATION_ID');
  assert.deepEqual(snapshotState(model.state, { commandError: false }), {
    ...before,
    commandError: undefined,
  });
  assert.equal(model.state.commandError, result.error);
  assert.deepEqual(calls, []);
});

test('pending operation identity reuse is rejected and becomes reusable after cleanup', async () => {
  const openGate = deferred();
  const calls = [];
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async (endpointId, options) => {
    calls.push(['open', endpointId, options]);
    return openGate.promise;
  };
  adapter.transport.cancelOpen = async (endpointId, options) => {
    calls.push(['cancel', endpointId, options]);
  };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const first = model.commands.open('serial-1', 'op1');
  await tick();
  const before = snapshotState(model.state);

  const duplicate = await settlesWithin(model.commands.open('serial-1', 'op1'));

  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'DUPLICATE_OPERATION_ID');
  assert.deepEqual(snapshotState(model.state, { commandError: false }), {
    ...before,
    commandError: undefined,
  });
  assert.deepEqual(calls, [['open', 'serial-1', { operationId: 'op1' }]]);

  assert.equal((await model.commands.cancelOpen('serial-1', 'op1')).ok, true);
  assert.equal((await first).error.code, 'OPEN_CANCELLED');
  openGate.resolve({ sessionId: 'late' });
  adapter.transport.open = async (...args) => {
    calls.push(['open', ...args]);
    return { sessionId: 'reused-session' };
  };
  const reused = await model.commands.open('serial-1', 'op1');
  assert.equal(reused.ok, true);
  assert.equal(model.state.operations.get('serial-1').sessionId, 'reused-session');
});

test('malformed open success identities fail in the command envelope and clear opening state', async (t) => {
  for (const [name, value] of [
    ['empty object', {}],
    ['blank sessionId', { sessionId: '  ' }],
    ['wrong identity type', { sessionId: 42 }],
  ]) {
    await t.test(name, async () => {
      const openGate = deferred();
      const { adapter, emit } = createAdapter({
        endpoints: [endpoint('tcp-server-1', 'tcp-server')],
      });
      adapter.transport.open = () => openGate.promise;
      const model = createWorkbenchModel(adapter);
      await model.commands.loadEndpoints();
      const opening = model.commands.open('tcp-server-1', 'op1');
      await tick();
      emit.status(statusEvent('op1', 's1', 'open', null));
      emit.peers({
        endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1',
        peers: [peer('peer-1')],
      });
      openGate.resolve(value);

      const result = await opening;

      assert.equal(result.ok, false);
      assert.equal(result.error instanceof TypeError, true);
      assert.equal(model.state.commandError, result.error);
      assert.equal(model.state.operations.has('tcp-server-1'), false);
      assert.equal(model.state.statuses.has('tcp-server-1'), false);
      assert.equal(model.state.peers.has('tcp-server-1'), false);
    });
  }
});

test('open accepts a nonblank id alias as its session identity', async () => {
  const { adapter } = createAdapter({ endpoints: [endpoint('serial-1', 'serial')] });
  adapter.transport.open = async () => ({ id: 'alias-session' });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();

  const result = await model.commands.open('serial-1', 'op1');

  assert.equal(result.ok, true);
  assert.equal(model.state.operations.get('serial-1').sessionId, 'alias-session');
});

test('TCP client retries failed open through the lifecycle coordinator', async () => {
  const timers = createFakeTimers();
  const calls = [];
  const client = {
    ...endpoint('tcp-client-1', 'tcp-client'),
    config: { autoReconnect: true },
  };
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async (endpointId, options) => {
    calls.push([endpointId, options.operationId]);
    if (calls.length < 3) throw Object.assign(new Error('refused'), { code: 'IO_ERROR' });
    return { sessionId: 'reconnected-session' };
  };
  const model = createWorkbenchModel(adapter, {
    timers,
    clock: () => timers.now,
    createReconnectOperationId: ({ attempt }) => `retry-${attempt}`,
  });
  await model.commands.loadEndpoints();

  assert.equal((await model.commands.open('tcp-client-1', 'manual-1')).ok, false);
  assert.equal(model.reconnectStateFor('tcp-client-1').phase, 'waiting');
  await timers.runNext();
  await timers.runNext();

  assert.deepEqual(calls, [
    ['tcp-client-1', 'manual-1'],
    ['tcp-client-1', 'retry-1'],
    ['tcp-client-1', 'retry-2'],
  ]);
  assert.equal(model.state.operations.get('tcp-client-1').sessionId, 'reconnected-session');
  assert.equal(model.reconnectStateFor('tcp-client-1'), null);
});

test('Modbus TCP master arms automatic reconnect after a failed manual open', async () => {
  const timers = createFakeTimers();
  const master = {
    ...endpoint('modbus-master-1', 'modbus-tcp-master'),
    config: { autoReconnect: true },
  };
  const { adapter } = createAdapter({ endpoints: [master] });
  adapter.transport.open = async () => { throw new Error('refused'); };
  const model = createWorkbenchModel(adapter, {
    timers,
    clock: () => timers.now,
    createReconnectOperationId: ({ attempt }) => `modbus-retry-${attempt}`,
  });
  await model.commands.loadEndpoints();

  assert.equal((await model.commands.open(master.id, 'manual-modbus')).ok, false);

  assert.deepEqual(model.reconnectStateFor(master.id), {
    endpointId: master.id,
    operationId: null,
    attempt: 1,
    phase: 'waiting',
    nextRetryAt: timers.now + 500,
    lastError: { code: 'UNKNOWN', message: 'refused' },
  });
  assert.equal(timers.pendingCount(), 1);
  model.dispose();
});

test('remote error then closed schedules only one reconnect attempt', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const { adapter, emit } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => ({ sessionId: 'session-1' });
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');

  emit.status(tcpStatus(client.id, 'manual-1', 'session-1', 'error'));
  emit.status(tcpStatus(client.id, 'manual-1', null, 'closed'));

  assert.equal(timers.pendingCount(), 1);
  assert.equal(model.reconnectStateFor(client.id).attempt, 1);
});

test('close disarms reconnect before native closed status is emitted', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const { adapter, emit } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => ({ sessionId: 'session-1' });
  adapter.transport.close = async () => {
    emit.status(tcpStatus(client.id, 'manual-1', null, 'closed'));
  };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');

  assert.equal((await model.commands.close(client.id)).ok, true);

  assert.equal(model.reconnectStateFor(client.id), null);
  assert.equal(timers.pendingCount(), 0);
});

test('cancelReconnect clears a waiting retry', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => { throw new Error('refused'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');

  assert.equal((await model.commands.cancelReconnect(client.id)).ok, true);

  assert.equal(model.reconnectStateFor(client.id), null);
  assert.equal(timers.pendingCount(), 0);
});

test('cancelReconnect cancels an automatic open through the lifecycle coordinator', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const retry = deferred();
  const cancelCalls = [];
  let calls = 0;
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => {
    calls += 1;
    if (calls === 1) throw new Error('refused');
    return retry.promise;
  };
  adapter.transport.cancelOpen = async (...args) => cancelCalls.push(args);
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');
  const running = timers.runNext();
  await Promise.resolve();
  assert.deepEqual(model.reconnectStateFor(client.id), {
    endpointId: client.id,
    phase: 'connecting',
    attempt: 1,
    nextRetryAt: null,
    operationId: 'retry-1',
    lastError: { code: 'UNKNOWN', message: 'refused' },
  });

  const cancelled = await model.commands.cancelReconnect(client.id);
  await running;

  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelCalls, [[client.id, { operationId: 'retry-1' }]]);
  assert.equal(model.state.operations.has(client.id), false);
  assert.equal(model.reconnectStateFor(client.id), null);
});

test('save and delete cancel reconnect ownership for the edited endpoint', async () => {
  for (const action of ['save', 'delete']) {
    const timers = createFakeTimers();
    const client = autoReconnectClient();
    const { adapter } = createAdapter({ endpoints: [client] });
    adapter.transport.open = async () => { throw new Error('refused'); };
    const model = createReconnectModel(adapter, timers);
    await model.commands.loadEndpoints();
    await model.commands.open(client.id, 'manual-1');

    const result = action === 'save'
      ? await model.commands.save({ ...client, config: { autoReconnect: false } })
      : await model.commands.delete(client.id);

    assert.equal(result.ok, true, action);
    assert.equal(model.reconnectStateFor(client.id), null, action);
    assert.equal(timers.pendingCount(), 0, action);
  }
});

test('new manual open replaces a waiting reconnect generation', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  let calls = 0;
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => {
    calls += 1;
    if (calls === 1) throw new Error('refused');
    return { sessionId: 'manual-session-2' };
  };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');
  const staleRetry = timers.nextCallback();

  assert.equal((await model.commands.open(client.id, 'manual-2')).ok, true);
  await staleRetry();

  assert.equal(calls, 2);
  assert.equal(model.state.operations.get(client.id).operationId, 'manual-2');
  assert.equal(model.reconnectStateFor(client.id), null);
});

test('workspace reset disarms reconnect and makes its timer inert', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  let calls = 0;
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => { calls += 1; throw new Error('refused'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');
  const staleRetry = timers.nextCallback();

  model.resetWorkspaceState();
  await staleRetry();

  assert.equal(calls, 1);
  assert.equal(model.state.reconnects.size, 0);
  assert.equal(model.reconnectStateFor(client.id), null);
});

test('endpoint load reconciles a waiting retry when auto reconnect is disabled', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const listed = [client];
  const { adapter } = createAdapter({ endpoints: listed });
  adapter.endpoint.list = async () => listed;
  adapter.transport.open = async () => { throw new Error('refused'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');
  listed[0] = { ...client, config: { autoReconnect: false } };

  await model.commands.loadEndpoints();

  assert.equal(model.reconnectStateFor(client.id), null);
  assert.equal(timers.pendingCount(), 0);
});

test('malformed persisted auto reconnect values never arm after a failed open', async () => {
  for (const autoReconnect of ['false', 1]) {
    const timers = createFakeTimers();
    const client = {
      ...endpoint('tcp-client-1', 'tcp-client'),
      config: { autoReconnect },
    };
    const { adapter } = createAdapter({ endpoints: [client] });
    adapter.transport.open = async () => { throw new Error('refused'); };
    const model = createReconnectModel(adapter, timers);
    await model.commands.loadEndpoints();

    await model.commands.open(client.id, `manual-${String(autoReconnect)}`);

    assert.equal(model.reconnectStateFor(client.id), null, String(autoReconnect));
    assert.equal(timers.pendingCount(), 0, String(autoReconnect));
  }
});

test('endpoint load reconciles waiting retries whose persisted policy becomes malformed', async () => {
  for (const autoReconnect of ['false', 1]) {
    const timers = createFakeTimers();
    const client = autoReconnectClient();
    const listed = [client];
    const { adapter } = createAdapter({ endpoints: listed });
    adapter.endpoint.list = async () => listed;
    adapter.transport.open = async () => { throw new Error('refused'); };
    const model = createReconnectModel(adapter, timers);
    await model.commands.loadEndpoints();
    await model.commands.open(client.id, `manual-${String(autoReconnect)}`);
    listed[0] = { ...client, config: { autoReconnect } };

    await model.commands.loadEndpoints();

    assert.equal(model.reconnectStateFor(client.id), null, String(autoReconnect));
    assert.equal(timers.pendingCount(), 0, String(autoReconnect));
  }
});

test('endpoint load cancels an active retry whose persisted policy becomes malformed', async () => {
  for (const autoReconnect of ['false', 1]) {
    const timers = createFakeTimers();
    const client = autoReconnectClient();
    const listed = [client];
    const retry = deferred();
    const retryStarted = deferred();
    const cancelCalls = [];
    let openCalls = 0;
    const { adapter } = createAdapter({ endpoints: listed });
    adapter.endpoint.list = async () => listed;
    adapter.transport.open = async () => {
      openCalls += 1;
      if (openCalls === 1) throw new Error('refused');
      retryStarted.resolve();
      return retry.promise;
    };
    adapter.transport.cancelOpen = async (...args) => cancelCalls.push(args);
    const model = createReconnectModel(adapter, timers);
    await model.commands.loadEndpoints();
    await model.commands.open(client.id, `manual-${String(autoReconnect)}`);
    const runningRetry = timers.runNext();
    await retryStarted.promise;
    listed[0] = { ...client, config: { autoReconnect } };

    await model.commands.loadEndpoints();
    retry.resolve({ sessionId: 'late-retry-session' });
    await runningRetry;

    assert.deepEqual(cancelCalls, [[client.id, { operationId: 'retry-1' }]], String(autoReconnect));
    assert.equal(model.state.operations.has(client.id), false, String(autoReconnect));
    assert.equal(model.reconnectStateFor(client.id), null, String(autoReconnect));
  }
});

test('dispose clears reconnect timers and ignores stale callbacks', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  let calls = 0;
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => { calls += 1; throw new Error('refused'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');
  const staleRetry = timers.nextCallback();

  model.dispose();
  await staleRetry();

  assert.equal(calls, 1);
  assert.equal(model.state.reconnects.size, 0);
  assert.equal(timers.pendingCount(), 0);
});

test('workspace reset consumes rejected cancellation for a connecting automatic attempt', async () => {
  const harness = await createRejectingReconnectCleanupHarness();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    harness.model.resetWorkspaceState();
    await harness.runningRetry;
    await tick();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(harness.model.state.reconnects.size, 0);
});

test('dispose consumes rejected cancellation for a connecting automatic attempt', async () => {
  const harness = await createRejectingReconnectCleanupHarness();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    harness.model.dispose();
    await harness.runningRetry;
    await tick();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(harness.model.state.reconnects.size, 0);
});

test('disabled TCP client never arms automatic reconnect', async () => {
  const timers = createFakeTimers();
  const client = endpoint('tcp-client-1', 'tcp-client');
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => { throw new Error('refused'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();

  await model.commands.open(client.id, 'manual-1');

  assert.equal(model.reconnectStateFor(client.id), null);
  assert.equal(timers.pendingCount(), 0);
});

test('TCP server never arms automatic reconnect', async () => {
  const timers = createFakeTimers();
  const server = { ...endpoint('tcp-server-1', 'tcp-server'), config: { autoReconnect: true } };
  const { adapter } = createAdapter({ endpoints: [server] });
  adapter.transport.open = async () => { throw new Error('refused'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();

  await model.commands.open(server.id, 'manual-1');

  assert.equal(model.reconnectStateFor(server.id), null);
  assert.equal(timers.pendingCount(), 0);
});

test('late automatic acknowledgement cannot replace a newer manual operation', async () => {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const retry = deferred();
  const retryStarted = deferred();
  const calls = [];
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async (_endpointId, { operationId }) => {
    calls.push(operationId);
    if (operationId === 'manual-1') throw new Error('refused');
    if (operationId === 'retry-1') {
      retryStarted.resolve();
      return retry.promise;
    }
    return { sessionId: 'manual-session-2' };
  };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');
  const runningRetry = timers.runNext();
  await retryStarted.promise;

  const manual = await model.commands.open(client.id, 'manual-2');
  retry.resolve({ sessionId: 'late-retry-session' });
  await runningRetry;

  assert.equal(manual.ok, true);
  assert.deepEqual(calls, ['manual-1', 'retry-1', 'manual-2']);
  assert.deepEqual(model.state.operations.get(client.id), {
    endpointId: client.id,
    operationId: 'manual-2',
    sessionId: 'manual-session-2',
  });
  assert.equal(model.reconnectStateFor(client.id), null);
});

test('Modbus scheduler persists point outcomes without waiting for a slow history write', async () => {
  const writeStarted = deferred();
  const writeGate = deferred();
  const savedBatches = [];
  let executions = 0;
  const { adapter } = createAdapter();
  adapter.modbus.execute = async (request) => ({
    ...request,
    sessionId: 'session-1',
    origin: 'master',
    requestValues: [],
    values: [++executions],
    success: true,
    exceptionCode: null,
    message: null,
    createdAt: executions,
    durationMs: 1,
  });
  adapter.modbusHistory.recordBatch = async (rows) => {
    savedBatches.push(rows);
    writeStarted.resolve();
    await writeGate.promise;
  };
  const model = createWorkbenchModel(adapter);
  const config = historyMasterConfig();

  await model.modbusMasterScheduler.runRequest({
    endpointId: 'master-1', sessionId: 'session-1', config,
    groupId: 'environment', requestId: 'holding-registers',
  });
  const flushing = model.flushModbusPointHistory();
  await writeStarted.promise;

  const second = await model.modbusMasterScheduler.runRequest({
    endpointId: 'master-1', sessionId: 'session-1', config,
    groupId: 'environment', requestId: 'holding-registers',
  });
  assert.equal(second.values[0], 2);
  assert.equal(
    model.modbusMasterScheduler.getStatus('master-1')
      .groups.environment.requests['holding-registers'].successCount,
    2,
  );

  writeGate.resolve();
  await flushing;
  assert.deepEqual(savedBatches.map((rows) => rows[0].value), [1, 2]);
  model.dispose();
});

test('history capture starts a fresh baseline after session and workspace reset', async () => {
  const saved = [];
  const { adapter } = createAdapter();
  adapter.modbus.execute = async (request) => ({
    ...request,
    sessionId: request.sessionId,
    origin: 'master',
    requestValues: [],
    values: [42],
    success: true,
    exceptionCode: null,
    message: null,
    createdAt: 10,
    durationMs: 1,
  });
  adapter.modbusHistory.recordBatch = async (rows) => saved.push(...rows);
  const model = createWorkbenchModel(adapter);
  const config = historyMasterConfig();
  const run = (sessionId) => model.modbusMasterScheduler.runRequest({
    endpointId: 'master-1', sessionId, config,
    groupId: 'environment', requestId: 'holding-registers',
  });

  await run('session-1');
  await run('session-1');
  await model.flushModbusPointHistory();
  await run('session-2');
  await model.flushModbusPointHistory();
  model.resetWorkspaceState();
  await run('session-2');
  await model.flushModbusPointHistory();

  assert.equal(saved.length, 3);
  model.dispose();
});

test('workspace import and scoped point-history clear flush renderer and native queues first', async () => {
  const trace = [];
  const { adapter } = createAdapter();
  adapter.modbusHistory.recordBatch = async () => trace.push('collector.flush');
  adapter.modbusHistory.flush = async () => trace.push('history.flush');
  adapter.workspace.import = async () => {
    trace.push('workspace.import');
    return { canceled: false, path: '/tmp/workspace.json' };
  };
  adapter.modbusHistory.clear = async () => {
    trace.push('history.clear');
    return 1;
  };
  const model = createWorkbenchModel(adapter);

  model.modbusPointHistoryCollector.capture(historyPointOutcome());
  await model.importWorkspace();
  assert.deepEqual(trace, ['collector.flush', 'history.flush', 'workspace.import']);

  trace.length = 0;
  model.modbusPointHistoryCollector.capture(historyPointOutcome({ value: 43, raw: [43] }));
  await model.clearModbusPointHistory({
    endpointId: 'master-1', points: [], from: 0, to: 100, page: 1, pageSize: 50,
  });
  assert.deepEqual(trace, ['collector.flush', 'history.flush', 'history.clear']);
  model.dispose();
});

test('point-history CSV export flushes renderer and native queues before reading rows', async () => {
  const trace = [];
  const { adapter } = createAdapter();
  adapter.modbusHistory.recordBatch = async () => trace.push('collector.flush');
  adapter.modbusHistory.flush = async () => trace.push('history.flush');
  adapter.modbusHistory.exportCsv = async () => {
    trace.push('history.exportCsv');
    return { canceled: false, path: '/tmp/modbus-history.csv' };
  };
  const model = createWorkbenchModel(adapter);
  const query = {
    endpointId: 'master-1',
    points: [{
      requestGroupId: 'environment', requestId: 'holding-registers', pointId: 'temperature',
    }],
    from: 0,
    to: 100,
  };

  model.modbusPointHistoryCollector.capture(historyPointOutcome());
  const result = await model.exportModbusPointHistory(query);

  assert.deepEqual(trace, ['collector.flush', 'history.flush', 'history.exportCsv']);
  assert.deepEqual(result, { canceled: false, path: '/tmp/modbus-history.csv' });
  model.dispose();
});

test('retention cleanup runs after settings load, every 24 hours, and on policy change', async () => {
  const timers = createFakeTimers(1_780_000_000_000);
  const calls = [];
  const { adapter } = createAdapter();
  adapter.modbusHistory.cleanup = async (retention) => {
    calls.push(retention);
    return { deletedCount: 0, completedAt: timers.now };
  };
  const model = createWorkbenchModel(adapter, { timers, clock: () => timers.now });

  model.updatePreferences({ modbusPointHistoryRetention: '30-days' });
  await flushMicrotasks();
  assert.deepEqual(calls, ['30-days']);
  assert.equal(timers.nextDelay(), 86_400_000);
  assert.equal(model.modbusPointHistoryStatus.lastCleanupAt, 1_780_000_000_000);

  await timers.runNext();
  await flushMicrotasks();
  assert.deepEqual(calls, ['30-days', '30-days']);
  assert.equal(timers.nextDelay(), 86_400_000);

  model.updatePreferences({ modbusPointHistoryRetention: '7-days' });
  await flushMicrotasks();
  assert.deepEqual(calls, ['30-days', '30-days', '7-days']);
  assert.equal(timers.nextDelay(), 86_400_000);
  model.dispose();
  assert.equal(timers.pendingCount(), 0);
});

test('forever retention is a native no-op until a finite policy is selected', async () => {
  const timers = createFakeTimers();
  const calls = [];
  const { adapter } = createAdapter();
  adapter.modbusHistory.cleanup = async (retention) => {
    calls.push(retention);
    return { deletedCount: 0, completedAt: timers.now };
  };
  const model = createWorkbenchModel(adapter, { timers, clock: () => timers.now });

  model.updatePreferences({ modbusPointHistoryRetention: 'forever' });
  await flushMicrotasks();
  assert.deepEqual(calls, []);
  assert.equal(timers.pendingCount(), 0);

  model.updatePreferences({ modbusPointHistoryRetention: '90-days' });
  await flushMicrotasks();
  assert.deepEqual(calls, ['90-days']);
  assert.equal(timers.nextDelay(), 86_400_000);
  model.dispose();
});

function historyMasterConfig() {
  return {
    enabled: true,
    timeoutMs: 1_000,
    retryCount: 0,
    retryIntervalMs: 0,
    scheduler: { minGapMs: 0, autoStart: false },
    requestGroups: [{
      id: 'environment', name: 'Environment', description: '', enabled: true, order: 0, unitId: 1,
      requests: [{
        id: 'holding-registers', name: 'Holding registers', enabled: true, order: 0,
        functionCode: 3, startAddress: 0, quantity: 1, intervalMs: 1_000,
        timeoutMs: null, retryCount: null, retryIntervalMs: null,
        dataPoints: [{
          id: 'temperature', key: 'temperature', name: 'Temperature', enabled: true,
          offset: 0, dataType: 'uint16', length: 1, byteOrder: 'big-endian',
          wordOrder: 'high-first', bitIndex: null, scale: 1, valueOffset: 0,
          unit: 'C', decimals: null, minimum: null, maximum: null,
          invalidPolicy: 'mark-bad', saveHistory: true, historyMode: 'on-change',
        }],
      }],
    }],
  };
}

function historyPointOutcome(overrides = {}) {
  return {
    endpointId: 'master-1',
    sessionId: 'session-1',
    requestGroupId: 'environment',
    requestId: 'holding-registers',
    createdAt: 10,
    points: [{
      ...historyMasterConfig().requestGroups[0].requests[0].dataPoints[0],
      raw: [42], value: 42, display: '42', quality: 'good', reason: null,
      ...overrides,
    }],
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function endpoint(id, transport) {
  return { id, name: id, transport, config: {} };
}

function autoReconnectClient() {
  return {
    ...endpoint('tcp-client-1', 'tcp-client'),
    config: { autoReconnect: true },
  };
}

function createReconnectModel(adapter, timers) {
  return createWorkbenchModel(adapter, {
    timers,
    clock: () => timers.now,
    createReconnectOperationId: ({ attempt }) => `retry-${attempt}`,
  });
}

async function createRejectingReconnectCleanupHarness() {
  const timers = createFakeTimers();
  const client = autoReconnectClient();
  const retryStarted = deferred();
  let openCalls = 0;
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async () => {
    openCalls += 1;
    if (openCalls === 1) throw new Error('refused');
    retryStarted.resolve();
    return new Promise(() => {});
  };
  adapter.transport.cancelOpen = async () => { throw new Error('cancel failed'); };
  const model = createReconnectModel(adapter, timers);
  await model.commands.loadEndpoints();
  await model.commands.open(client.id, 'manual-1');
  const runningRetry = timers.runNext();
  await retryStarted.promise;
  return { model, runningRetry };
}

function tcpStatus(endpointId, operationId, sessionId, status) {
  return {
    endpointId,
    operationId,
    sessionId,
    status,
    error: status === 'error' ? { code: 'IO_ERROR', message: 'remote closed' } : null,
    createdAt: 1,
    log: null,
  };
}

function peer(id) {
  return { id, endpointId: 'tcp-server-1', sessionId: 's1', remoteAddress: '127.0.0.1:19000', connectedAt: 1 };
}

function frame(
  id,
  direction = 'in',
  peerId = null,
  text = id,
  endpointId = 'tcp-server-1',
  sessionId = 's1',
) {
  return {
    id, endpointId, sessionId, direction, peerId, text,
    bytes: Uint8Array.of(1), createdAt: 1,
  };
}

function statusEvent(operationId, sessionId, status = 'open', message = null, endpointId = 'tcp-server-1') {
  const error = status === 'error'
    ? { code: 'IO_ERROR', message: message ?? 'serial operation failed' }
    : null;
  return {
    endpointId,
    sessionId: status === 'opening' || status === 'closed' ? null : sessionId,
    operationId,
    status,
    error,
    createdAt: 1,
    log: message === null ? null : {
      level: status === 'error'
        ? 'error'
        : status === 'open' || status === 'closed' ? 'info' : 'debug',
      source: 'serial',
      code: error?.code ?? null,
      message,
      details: null,
      createdAt: 1,
    },
  };
}

function snapshotState(state, { commandError = true } = {}) {
  return {
    activeEndpointId: state.activeEndpointId,
    activePeerId: state.activePeerId,
    operations: [...state.operations],
    statuses: [...state.statuses],
    peers: [...state.peers],
    frames: [...state.frames],
    logs: [...state.logs],
    counters: { ...state.counters },
    endpointCounters: [...state.endpointCounters],
    commandError: commandError ? state.commandError : undefined,
  };
}

function createAdapter({ endpoints: listedEndpoints = [], historyCalls = [] } = {}) {
  const listeners = { frames: [], status: [], peers: [] };
  const subscriptionCounts = { frames: 0, status: 0, peers: 0 };
  const unsubscribeCounts = { frames: 0, status: 0, peers: 0 };
  const subscribe = (name) => (listener) => {
    subscriptionCounts[name] += 1;
    listeners[name].push(listener);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unsubscribeCounts[name] += 1;
    };
  };
  const success = async (...args) => args[0] ?? null;
  const adapter = {
    runtimeName: 'test',
    endpoint: { list: async () => listedEndpoints, save: success, clone: success, delete: success },
    transport: {
      scanSerialPorts: async () => [], open: success, cancelOpen: success, close: success,
      send: success, disconnectPeer: success,
      onFrames: subscribe('frames'), onStatus: subscribe('status'), onPeers: subscribe('peers'),
    },
    modbus: {
      execute: success, readMap: success, writeMap: success, onTransactions: () => () => {},
    },
    modbusHistory: {
      recordBatch: success,
      querySeries: async () => ({ series: [], from: null, to: null }),
      queryRows: async () => ({ rows: [], total: 0, page: 1, pageSize: 50 }),
      exportCsv: success,
      clear: success,
      cleanup: success,
      flush: async () => ({ flushed: true }),
    },
    history: {
      queryFrames: async () => ({ rows: [], total: 0, page: 1, pageSize: 100 }),
      queryLogs: async () => ({ rows: [], total: 0, page: 1, pageSize: 100 }),
      delete: async (...args) => historyCalls.push(['delete', ...args]),
      clear: async (...args) => historyCalls.push(['clear', ...args]),
    },
    template: { list: async () => [], save: success, delete: success },
    sendHistory: {
      record: success,
      query: async () => ({ rows: [], total: 0, page: 1, pageSize: 20 }),
      delete: success,
      clear: success,
    },
    settings: { getAll: async () => ({}), save: success, saveAll: success },
    workspace: { export: success, import: success },
    storage: { stats: async () => ({}), clearHistory: success },
    window: { openHistory: success },
    lifecycle: { onBeforeShutdown: () => () => {}, readyForShutdown: success },
  };
  const emit = Object.fromEntries(Object.keys(listeners).map((name) => [
    name,
    (payload) => listeners[name].forEach((listener) => listener(payload)),
  ]));
  return { adapter, emit, subscriptionCounts, unsubscribeCounts };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settlesWithin(promise, timeoutMs = 30) {
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });
  const result = await Promise.race([promise, timeout]);
  assert.notDeepEqual(result, { timeout: true }, 'command did not settle before timeout');
  return result;
}

function snapshotModelState(state) {
  return {
    endpoints: [...state.endpoints],
    endpointFilter: state.endpointFilter,
    activeEndpointId: state.activeEndpointId,
    activePeerId: state.activePeerId,
    frameFilters: { ...state.frameFilters },
    operations: [...state.operations],
    reconnects: [...state.reconnects],
    statuses: [...state.statuses],
    peers: [...state.peers],
    frames: [...state.frames],
    logs: [...state.logs],
    counters: { ...state.counters },
    endpointCounters: [...state.endpointCounters].map(([id, counters]) => [id, { ...counters }]),
    commandError: state.commandError,
    disposed: state.disposed,
  };
}


test('persistence failure stays visible without inserting recursive transport logs', () => {
  const { adapter } = createAdapter();
  let listener;
  let unsubscribed = false;
  adapter.transport.onPersistenceWarning = (callback) => {
    listener = callback;
    return () => { unsubscribed = true; };
  };
  const model = createWorkbenchModel(adapter);
  assert.equal(typeof listener, 'function');
  listener({ message: 'database is locked', rowCount: 2 });
  assert.match(model.state.historyPersistenceWarning.message, /database is locked/);
  assert.equal(model.state.logs.length, 0);
  model.dispose();
  assert.equal(unsubscribed, true);
});


test('Modbus category contains TCP/RTU master/slave and leaves other categories intact', async () => {
  const modbus = ['modbus-tcp-master', 'modbus-tcp-slave', 'modbus-rtu-master', 'modbus-rtu-slave']
    .map((transport) => endpoint(transport, transport));
  const dlt = endpoint('dlt', 'dlt645-master');
  const { adapter } = createAdapter({ endpoints: [...endpoints, ...modbus, dlt] });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.setEndpointFilter('modbus');
  assert.deepEqual(model.filteredEndpoints.map(({ id }) => id), modbus.map(({ id }) => id));
  model.setEndpointFilter('tcp');
  assert.deepEqual(model.filteredEndpoints.map(({ id }) => id), ['tcp-client-1', 'tcp-server-1']);
  model.setEndpointFilter('dlt645');
  assert.deepEqual(model.filteredEndpoints.map(({ id }) => id), ['dlt']);
  model.setEndpointFilter('all');
  assert.equal(model.filteredEndpoints.length, endpoints.length + 5);
});

test('native frame contents and displayed peer address are searchable in active endpoint context', async () => {
  const { adapter, emit } = createAdapter({ endpoints });
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  model.selectEndpoint('tcp-server-1');
  model.activateOperation({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1' });
  emit.peers({ endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', peers: [
    { id: 'peer-a', remoteAddress: '127.0.0.1:23001', connectedAt: 1 },
  ] });
  emit.frames(normalizeFrameWireBatch({
    endpointId: 'tcp-server-1', sessionId: 's1', operationId: 'op1', frames: [
      { direction: 'in', peerId: 'peer-a', bytes: [...new TextEncoder().encode('Hello device')], createdAt: 2 },
    ],
  }));
  assert.equal(createFramePresenter().present(model.visibleFrames)[0].text, 'Hello device');
  for (const keyword of ['Hello DEVICE', '127.0.0.1:23001', '48656c6c6f', 'peer-a']) {
    model.setFrameFilters({ keyword });
    assert.equal(model.visibleFrames.length, 1, keyword);
  }
  model.setFrameFilters({ direction: 'out' });
  assert.equal(model.visibleFrames.length, 0);
  model.setFrameFilters({ direction: 'all', peerId: 'other' });
  assert.equal(model.visibleFrames.length, 0);
  model.setFrameFilters({ peerId: 'all', keyword: '127.0.0.1:23002' });
  model.state.peers.set('tcp-client-1', [{ id: 'peer-a', remoteAddress: '127.0.0.1:23002' }]);
  assert.equal(model.visibleFrames.length, 0);
  model.dispose();
});
