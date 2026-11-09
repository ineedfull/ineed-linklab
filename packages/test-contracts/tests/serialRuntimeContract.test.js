import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SERIAL_ERROR_CODES,
  normalizeSerialCancelAcknowledgement,
  normalizeSerialCommandEnvelope,
  normalizeSerialFrameBatch,
  normalizeSerialPortRecord,
  normalizeSerialStatusEvent,
  normalizeTransportPeerEvent,
} from '../fixtures/serialRuntimeContract.js';

const identity = {
  endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
};
const serialRuntimeCases = JSON.parse(readFileSync(
  new URL('../fixtures/serialRuntimeCases.json', import.meta.url),
  'utf8',
));
const modbusPointHistoryCases = JSON.parse(readFileSync(
  new URL('../fixtures/modbusPointHistoryCases.json', import.meta.url),
  'utf8',
));

function frameBatchToWire(batch) {
  return {
    ...batch,
    frames: batch.frames.map((frame) => ({ ...frame, bytes: [...frame.bytes] })),
  };
}

test('language-neutral serial runtime fixtures define the shared wire contract', () => {
  assert.equal(serialRuntimeCases.schemaVersion, 1);
  assert.deepEqual(serialRuntimeCases.errorCodes, [...SERIAL_ERROR_CODES]);

  for (const fixture of serialRuntimeCases.port.valid) {
    assert.deepEqual(normalizeSerialPortRecord(fixture.input), fixture.expected, fixture.name);
  }
  for (const fixture of serialRuntimeCases.port.invalid) {
    assert.throws(() => normalizeSerialPortRecord(fixture.input), TypeError, fixture.name);
  }

  for (const fixture of serialRuntimeCases.status.valid) {
    assert.deepEqual(normalizeSerialStatusEvent(fixture.input), fixture.input, fixture.name);
  }
  for (const fixture of serialRuntimeCases.status.invalid) {
    assert.throws(() => normalizeSerialStatusEvent(fixture.input), TypeError, fixture.name);
  }

  for (const fixture of serialRuntimeCases.frame.valid) {
    assert.deepEqual(frameBatchToWire(normalizeSerialFrameBatch(fixture.input)), fixture.input, fixture.name);
  }
  for (const fixture of serialRuntimeCases.frame.invalid) {
    assert.throws(() => normalizeSerialFrameBatch(fixture.input), TypeError, fixture.name);
  }

  for (const fixture of serialRuntimeCases.cancel.valid) {
    assert.deepEqual(normalizeSerialCancelAcknowledgement(fixture.input), fixture.input, fixture.name);
  }
  for (const fixture of serialRuntimeCases.cancel.invalid) {
    assert.throws(() => normalizeSerialCancelAcknowledgement(fixture.input), TypeError, fixture.name);
  }

  for (const fixture of serialRuntimeCases.error.valid) {
    assert.deepEqual(normalizeSerialCommandEnvelope({ ok: false, error: fixture.input }), {
      ok: false,
      error: fixture.input,
    }, fixture.name);
  }
  for (const fixture of serialRuntimeCases.error.invalid) {
    assert.throws(
      () => normalizeSerialCommandEnvelope({ ok: false, error: fixture.input }),
      TypeError,
      fixture.name,
    );
  }

  for (const fixture of serialRuntimeCases.peer.valid) {
    assert.deepEqual(normalizeTransportPeerEvent(fixture.input), fixture.input, fixture.name);
  }
  for (const fixture of serialRuntimeCases.peer.invalid) {
    assert.throws(() => normalizeTransportPeerEvent(fixture.input), TypeError, fixture.name);
  }
});

test('language-neutral Modbus point history fixtures define cross-runtime acceptance cases', () => {
  assert.equal(modbusPointHistoryCases.schemaVersion, 1);
  assert.equal(modbusPointHistoryCases.endpointId, 'fixture-master');
  assert.equal(modbusPointHistoryCases.validRows.length, 10);
  assert.deepEqual(modbusPointHistoryCases.pointIdentities.map(({ pointId }) => pointId), [
    'numeric', 'switch', 'label',
  ]);
  assert.deepEqual(modbusPointHistoryCases.retention.values, [
    '7-days', '30-days', '90-days', 'forever',
  ]);
  assert.deepEqual(modbusPointHistoryCases.legacyUpgrade, {
    sourceSchemaVersion: 2,
    targetSchemaVersion: 3,
    preserveTables: ['endpoint_profiles', 'transfer_frames', 'runtime_logs', 'send_history'],
  });
});

test('serial error codes are exact and immutable', () => {
  assert.deepEqual([...SERIAL_ERROR_CODES], [
    'PORT_NOT_FOUND',
    'PORT_BUSY',
    'PERMISSION_DENIED',
    'OPEN_CANCELLED',
    'DEVICE_REMOVED',
    'IO_ERROR',
  ]);
  assert.equal(Object.isFrozen(SERIAL_ERROR_CODES), true);
});

test('port records require a path and normalize optional metadata to string or null', () => {
  assert.deepEqual(normalizeSerialPortRecord({ path: '/dev/ttyUSB0' }), {
    path: '/dev/ttyUSB0',
    manufacturer: null,
    serialNumber: null,
    vendorId: null,
    productId: null,
  });
  assert.deepEqual(normalizeSerialPortRecord({
    path: 'COM3',
    manufacturer: 'Ineed Lab',
    serialNumber: 'SN-1',
    vendorId: '1209',
    productId: '0001',
  }), {
    path: 'COM3',
    manufacturer: 'Ineed Lab',
    serialNumber: 'SN-1',
    vendorId: '1209',
    productId: '0001',
  });

  for (const record of [
    { path: ' ' },
    { path: 'COM3', manufacturer: 42 },
    { path: 'COM3', friendlyName: 'alias' },
  ]) {
    assert.throws(() => normalizeSerialPortRecord(record), TypeError);
  }
});

test('port records read optional metadata only from own data properties', () => {
  let sideEffect = 0;
  Object.defineProperty(Object.prototype, 'manufacturer', {
    configurable: true,
    get() {
      sideEffect += 1;
      return 'inherited manufacturer';
    },
  });

  try {
    assert.deepEqual(normalizeSerialPortRecord({ path: '/dev/ttyUSB0' }), {
      path: '/dev/ttyUSB0',
      manufacturer: null,
      serialNumber: null,
      vendorId: null,
      productId: null,
    });
    assert.equal(sideEffect, 0);
  } finally {
    delete Object.prototype.manufacturer;
  }

  const nullPrototypeRecord = Object.create(null);
  nullPrototypeRecord.path = 'COM4';
  assert.deepEqual(normalizeSerialPortRecord(nullPrototypeRecord), {
    path: 'COM4',
    manufacturer: null,
    serialNumber: null,
    vendorId: null,
    productId: null,
  });
});

test('status events preserve lifecycle identity and normalized serial errors', () => {
  assert.deepEqual(normalizeSerialStatusEvent({
    ...identity,
    status: 'open',
    error: null,
    createdAt: 1_700_000_000_000,
    log: null,
  }), {
    ...identity,
    status: 'open',
    error: null,
    createdAt: 1_700_000_000_000,
    log: null,
  });

  const error = { code: 'DEVICE_REMOVED', message: 'Device unplugged' };
  const normalized = normalizeSerialStatusEvent({
    ...identity, status: 'error', error, createdAt: 1_700_000_000_001, log: null,
  });
  assert.deepEqual(normalized.error, error);
  assert.notEqual(normalized.error, error);
  assert.equal(Object.isFrozen(normalized.error), true);

  assert.deepEqual(normalizeSerialStatusEvent({
    ...identity,
    sessionId: null,
    status: 'opening',
    error: null,
    createdAt: 1_700_000_000_002,
    log: null,
  }).sessionId, null);
});

test('status logs have an exact structured shape and clone nested plain details', () => {
  const details = {
    path: '/dev/ttyUSB0',
    settings: [115200, true, null, { parity: 'none' }],
  };
  const log = {
    level: 'info',
    source: 'serial',
    code: null,
    message: '串口已打开: /dev/ttyUSB0',
    details,
    createdAt: 1_700_000_000_000,
  };
  const normalized = normalizeSerialStatusEvent({
    ...identity, status: 'open', error: null, createdAt: 1_700_000_000_000, log,
  });

  assert.deepEqual(normalized.log, log);
  assert.notEqual(normalized.log, log);
  assert.notEqual(normalized.log.details, details);
  assert.notEqual(normalized.log.details.settings, details.settings);
  assert.equal(Object.isFrozen(normalized.log), true);
  assert.equal(Object.isFrozen(normalized.log.details), true);
  assert.equal(Object.isFrozen(normalized.log.details.settings), true);
  details.path = 'mutated';
  details.settings[3].parity = 'odd';
  assert.equal(normalized.log.details.path, '/dev/ttyUSB0');
  assert.equal(normalized.log.details.settings[3].parity, 'none');

  for (const lifecycle of [
    { status: 'opening', sessionId: null, error: null, level: 'debug', code: null },
    { status: 'open', sessionId: identity.sessionId, error: null, level: 'info', code: null },
    {
      status: 'error', sessionId: identity.sessionId,
      error: { code: 'DEVICE_REMOVED', message: 'removed' },
      level: 'warn', code: 'DEVICE_REMOVED',
    },
    {
      status: 'error', sessionId: identity.sessionId,
      error: { code: 'IO_ERROR', message: 'failed' },
      level: 'error', code: 'IO_ERROR',
    },
  ]) {
    assert.equal(normalizeSerialStatusEvent({
      ...identity,
      status: lifecycle.status,
      sessionId: lifecycle.sessionId,
      error: lifecycle.error,
      createdAt: 1,
      log: { ...log, level: lifecycle.level, code: lifecycle.code, details: null, createdAt: 1 },
    }).log.level, lifecycle.level);
  }
});

test('status log details reject non-plain or lossy JSON data', () => {
  const accessor = {};
  let accessorReads = 0;
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { accessorReads += 1; return 'hidden'; },
  });
  const symbol = { value: 1 };
  symbol[Symbol('extra')] = true;
  const cycle = {};
  cycle.self = cycle;
  const sparse = new Array(1);
  const extraArrayProperty = [1];
  extraArrayProperty.extra = true;
  const nonstandardArray = [1];
  Object.setPrototypeOf(nonstandardArray, Object.create(Array.prototype));
  const unsupportedPrototype = Object.create({ inherited: true });
  unsupportedPrototype.value = 1;
  const nullPrototype = Object.create(null);
  nullPrototype.value = 1;
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'hidden', { value: true });
  let proxyTraps = 0;
  const proxy = new Proxy({ value: 1 }, {
    get() { proxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });

  for (const details of [
    accessor,
    symbol,
    cycle,
    sparse,
    extraArrayProperty,
    nonstandardArray,
    unsupportedPrototype,
    nullPrototype,
    nonEnumerable,
    proxy,
    true,
    'text',
    1,
    { value: undefined },
    { value: -0 },
    { value: Number.MAX_SAFE_INTEGER + 1 },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => normalizeSerialStatusEvent({
      ...identity,
      status: 'open',
      error: null,
      createdAt: 1,
      log: {
        level: 'info', source: 'serial', code: null, message: 'opened', details, createdAt: 1,
      },
    }), TypeError);
  }
  assert.equal(accessorReads, 0);
  assert.equal(proxyTraps, 0);
});

test('status log fields reject missing values, blank code, and unsafe timestamps', () => {
  const log = {
    level: 'info',
    source: 'serial',
    code: null,
    message: '串口已打开: /dev/ttyUSB0',
    details: null,
    createdAt: 1,
  };
  const status = {
    ...identity, status: 'open', error: null, createdAt: 1, log,
  };

  for (const invalidLog of [
    { ...log, code: ' ' },
    { ...log, createdAt: -1 },
    { ...log, createdAt: -0 },
    { ...log, createdAt: 1.5 },
    { ...log, createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...log, createdAt: Number.NaN },
  ]) {
    assert.throws(() => normalizeSerialStatusEvent({ ...status, log: invalidLog }), TypeError);
  }
  for (const field of Object.keys(log)) {
    const missing = { ...log };
    delete missing[field];
    assert.throws(() => normalizeSerialStatusEvent({ ...status, log: missing }), TypeError, field);
  }
});

test('status event session identity follows the reducer lifecycle matrix', () => {
  const serialError = { code: 'IO_ERROR', message: 'Serial operation failed' };
  const validCases = [
    { status: 'opening', sessionId: null, error: null },
    { status: 'closed', sessionId: null, error: null },
    { status: 'open', sessionId: identity.sessionId, error: null },
    { status: 'closing', sessionId: identity.sessionId, error: null },
    { status: 'error', sessionId: null, error: serialError },
    { status: 'error', sessionId: identity.sessionId, error: serialError },
  ];
  for (const lifecycle of validCases) {
    assert.equal(normalizeSerialStatusEvent({
      ...identity,
      ...lifecycle,
      createdAt: 1,
      log: null,
    }).sessionId, lifecycle.sessionId);
  }

  const invalidCases = [
    { status: 'opening', sessionId: identity.sessionId, error: null },
    { status: 'closed', sessionId: identity.sessionId, error: null },
    { status: 'open', sessionId: null, error: null },
    { status: 'closing', sessionId: null, error: null },
    { status: 'opening', sessionId: ' ', error: null },
    { status: 'closed', sessionId: ' ', error: null },
    { status: 'open', sessionId: ' ', error: null },
    { status: 'closing', sessionId: ' ', error: null },
    { status: 'error', sessionId: ' ', error: serialError },
  ];
  for (const lifecycle of invalidCases) {
    assert.throws(() => normalizeSerialStatusEvent({
      ...identity,
      ...lifecycle,
      createdAt: 1,
      log: null,
    }), TypeError);
  }
});

test('frame batches retain raw bytes without aliasing caller buffers', () => {
  const bytes = Uint8Array.of(0x00, 0x80, 0xff);
  const batch = normalizeSerialFrameBatch({
    ...identity,
    frames: [{ direction: 'in', bytes, createdAt: 1_700_000_000_000 }],
  });

  assert.deepEqual(batch, {
    ...identity,
    frames: [{ direction: 'in', bytes: Uint8Array.of(0x00, 0x80, 0xff), createdAt: 1_700_000_000_000 }],
  });
  assert.notEqual(batch.frames[0].bytes, bytes);
  bytes[0] = 0xff;
  assert.deepEqual([...batch.frames[0].bytes], [0x00, 0x80, 0xff]);
  assert.equal(Object.isFrozen(batch), true);
  assert.equal(Object.isFrozen(batch.frames), true);
  assert.equal(Object.isFrozen(batch.frames[0]), true);
});

test('frame batches isolate normalized bytes from Buffer input mutations', () => {
  const bytes = Buffer.from([0x00, 0x80, 0xff]);
  const batch = normalizeSerialFrameBatch({
    ...identity,
    frames: [{ direction: 'in', bytes, createdAt: 1_700_000_000_000 }],
  });
  const normalizedBytes = batch.frames[0].bytes;

  assert.equal(Buffer.isBuffer(normalizedBytes), false);
  assert.equal(Object.getPrototypeOf(normalizedBytes), Uint8Array.prototype);
  bytes[0] = 0xff;
  assert.deepEqual([...normalizedBytes], [0x00, 0x80, 0xff]);
});

test('frame batches isolate Buffer inputs from normalized output mutations', () => {
  const bytes = Buffer.from([0x00, 0x80, 0xff]);
  const batch = normalizeSerialFrameBatch({
    ...identity,
    frames: [{ direction: 'out', bytes, createdAt: 1_700_000_000_000 }],
  });

  batch.frames[0].bytes[1] = 0x01;
  assert.deepEqual([...bytes], [0x00, 0x80, 0xff]);
});

test('frame batches accept Tauri wire byte arrays as fresh plain Uint8Array values', () => {
  const bytes = [0x00, 0x80, 0xff];
  const batch = normalizeSerialFrameBatch({
    ...identity,
    frames: [{ direction: 'in', bytes, createdAt: 1_700_000_000_000 }],
  });
  const normalizedBytes = batch.frames[0].bytes;

  assert.equal(normalizedBytes instanceof Uint8Array, true);
  assert.equal(Buffer.isBuffer(normalizedBytes), false);
  assert.equal(Object.getPrototypeOf(normalizedBytes), Uint8Array.prototype);
  assert.deepEqual([...normalizedBytes], [0x00, 0x80, 0xff]);
  bytes[0] = 0xff;
  normalizedBytes[1] = 0x01;
  assert.deepEqual(bytes, [0xff, 0x80, 0xff]);
  assert.deepEqual([...normalizedBytes], [0x00, 0x01, 0xff]);
});

test('Tauri wire byte arrays reject values outside the byte integer domain', () => {
  for (const byte of [-1, 256, 1.5, Number.NaN]) {
    assert.throws(() => normalizeSerialFrameBatch({
      ...identity,
      frames: [{ direction: 'in', bytes: [byte], createdAt: 1 }],
    }), TypeError);
  }
});

test('Tauri wire byte arrays reject sparse, accessor, and extra properties', () => {
  const sparse = new Array(1);
  const nonEnumerableElement = [];
  Object.defineProperty(nonEnumerableElement, 0, {
    configurable: true, enumerable: false, value: 1, writable: true,
  });
  nonEnumerableElement.length = 1;

  let accessorReads = 0;
  const accessorElement = [];
  Object.defineProperty(accessorElement, 0, {
    configurable: true,
    enumerable: true,
    get() {
      accessorReads += 1;
      return 1;
    },
  });
  accessorElement.length = 1;

  const extraProperty = [1];
  extraProperty.extra = true;
  const symbolProperty = [1];
  symbolProperty[Symbol('extra')] = true;

  for (const bytes of [
    sparse,
    nonEnumerableElement,
    accessorElement,
    extraProperty,
    symbolProperty,
  ]) {
    assert.throws(() => normalizeSerialFrameBatch({
      ...identity,
      frames: [{ direction: 'out', bytes, createdAt: 1 }],
    }), TypeError);
  }
  assert.equal(accessorReads, 0);
});

test('frame arrays reject index accessors without executing getters', () => {
  let frameReads = 0;
  const frames = [];
  Object.defineProperty(frames, 0, {
    configurable: true,
    enumerable: true,
    get() {
      frameReads += 1;
      return { direction: 'in', bytes: [1], createdAt: 1 };
    },
  });
  frames.length = 1;

  assert.throws(() => normalizeSerialFrameBatch({ ...identity, frames }), TypeError);
  assert.equal(frameReads, 0);
});

test('frame arrays reject holes, non-enumerable elements, symbols, and extra keys', () => {
  const sparse = new Array(1);
  const nonEnumerableElement = [];
  Object.defineProperty(nonEnumerableElement, 0, {
    configurable: true,
    enumerable: false,
    value: { direction: 'in', bytes: [1], createdAt: 1 },
    writable: true,
  });
  nonEnumerableElement.length = 1;

  const extraProperty = [{ direction: 'in', bytes: [1], createdAt: 1 }];
  extraProperty.extra = true;
  const symbolProperty = [{ direction: 'in', bytes: [1], createdAt: 1 }];
  symbolProperty[Symbol('extra')] = true;

  for (const frames of [sparse, nonEnumerableElement, extraProperty, symbolProperty]) {
    assert.throws(() => normalizeSerialFrameBatch({ ...identity, frames }), TypeError);
  }
});

test('frame arrays reject proxies without executing traps', () => {
  let proxyTraps = 0;
  const frames = new Proxy([{ direction: 'in', bytes: [1], createdAt: 1 }], {
    get() { proxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Array.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });

  assert.throws(() => normalizeSerialFrameBatch({ ...identity, frames }), TypeError);
  assert.equal(proxyTraps, 0);
});

test('frame records and byte arrays reject proxies without executing traps', () => {
  for (const nestedValue of [
    {
      label: 'frame',
      value: { direction: 'in', bytes: [1], createdAt: 1 },
      createBatch(value) { return { ...identity, frames: [value] }; },
    },
    {
      label: 'bytes',
      value: [1],
      createBatch(value) {
        return {
          ...identity,
          frames: [{ direction: 'in', bytes: value, createdAt: 1 }],
        };
      },
    },
  ]) {
    let proxyTraps = 0;
    const value = new Proxy(nestedValue.value, {
      get() { proxyTraps += 1; return undefined; },
      getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
      getPrototypeOf() { proxyTraps += 1; return Object.getPrototypeOf(nestedValue.value); },
      ownKeys() { proxyTraps += 1; return []; },
    });

    assert.throws(
      () => normalizeSerialFrameBatch(nestedValue.createBatch(value)),
      TypeError,
      nestedValue.label,
    );
    assert.equal(proxyTraps, 0, nestedValue.label);
  }
});

test('nested status, frame, and command accessors are never executed', () => {
  const cases = [
    {
      label: 'status error code',
      createInput(reads) {
        const error = { message: 'failed' };
        Object.defineProperty(error, 'code', {
          enumerable: true,
          get() { reads.count += 1; return 'IO_ERROR'; },
        });
        return () => normalizeSerialStatusEvent({
          ...identity, status: 'error', error, createdAt: 1, log: null,
        });
      },
    },
    {
      label: 'frame bytes',
      createInput(reads) {
        const frame = { direction: 'in', createdAt: 1 };
        Object.defineProperty(frame, 'bytes', {
          enumerable: true,
          get() { reads.count += 1; return [1]; },
        });
        return () => normalizeSerialFrameBatch({ ...identity, frames: [frame] });
      },
    },
    {
      label: 'command value',
      createInput(reads) {
        const envelope = { ok: true };
        Object.defineProperty(envelope, 'value', {
          enumerable: true,
          get() { reads.count += 1; return null; },
        });
        return () => normalizeSerialCommandEnvelope(envelope);
      },
    },
    {
      label: 'command error code',
      createInput(reads) {
        const error = { message: 'failed' };
        Object.defineProperty(error, 'code', {
          enumerable: true,
          get() { reads.count += 1; return 'IO_ERROR'; },
        });
        return () => normalizeSerialCommandEnvelope({ ok: false, error });
      },
    },
  ];

  for (const fixture of cases) {
    const reads = { count: 0 };
    assert.throws(fixture.createInput(reads), TypeError, fixture.label);
    assert.equal(reads.count, 0, fixture.label);
  }
});

test('cancel acknowledgement binds cancellation to the opening operation', () => {
  const acknowledgement = normalizeSerialCancelAcknowledgement({
    endpointId: identity.endpointId,
    operationId: identity.operationId,
    cancelled: true,
  });
  assert.deepEqual(acknowledgement, {
    endpointId: identity.endpointId,
    operationId: identity.operationId,
    cancelled: true,
  });

  assert.throws(() => normalizeSerialCancelAcknowledgement({
    endpointId: identity.endpointId,
    operationId: identity.operationId,
    cancelled: false,
  }), TypeError);
});

test('command result envelopes distinguish values from exact serial errors', () => {
  const value = { sessionId: identity.sessionId };
  const success = normalizeSerialCommandEnvelope({ ok: true, value });
  assert.deepEqual(success, { ok: true, value });

  for (const code of SERIAL_ERROR_CODES) {
    assert.deepEqual(normalizeSerialCommandEnvelope({
      ok: false,
      error: { code, message: `${code} message` },
    }), {
      ok: false,
      error: { code, message: `${code} message` },
    });
  }

  for (const envelope of [
    { ok: false, error: { code: 'UNKNOWN', message: 'unknown' } },
    { ok: false, error: { code: 'IO_ERROR', message: 'failed', errno: 5 } },
    { ok: true, value, error: null },
  ]) {
    assert.throws(() => normalizeSerialCommandEnvelope(envelope), TypeError);
  }
});

test('command envelope discriminators reject accessors without executing getters', () => {
  let okReads = 0;
  const envelope = { value: { sessionId: identity.sessionId } };
  Object.defineProperty(envelope, 'ok', {
    enumerable: true,
    get() {
      okReads += 1;
      return true;
    },
  });

  assert.throws(() => normalizeSerialCommandEnvelope(envelope), TypeError);
  assert.equal(okReads, 0);
});

test('command envelope validation rejects proxies without executing traps', () => {
  let proxyTraps = 0;
  const envelope = new Proxy({ ok: true, value: null }, {
    get() { proxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });

  assert.throws(() => normalizeSerialCommandEnvelope(envelope), TypeError);
  assert.equal(proxyTraps, 0);
});

test('all runtime payloads reject unknown fields and blank identities', () => {
  const validCases = [
    [normalizeSerialStatusEvent, {
      ...identity, status: 'closed', error: null, createdAt: 1, log: null,
    }],
    [normalizeSerialFrameBatch, {
      ...identity, frames: [{ direction: 'out', bytes: Uint8Array.of(1), createdAt: 1 }],
    }],
    [normalizeSerialCancelAcknowledgement, {
      endpointId: identity.endpointId, operationId: identity.operationId, cancelled: true,
    }],
  ];

  for (const [normalizePayload, payload] of validCases) {
    assert.throws(() => normalizePayload({ ...payload, unknown: true }), TypeError);
    for (const field of ['endpointId', 'operationId']) {
      assert.throws(() => normalizePayload({ ...payload, [field]: ' ' }), TypeError);
    }
  }
  assert.throws(() => normalizeSerialStatusEvent({ ...validCases[0][1], sessionId: '' }), TypeError);
  assert.throws(() => normalizeSerialStatusEvent({
    ...validCases[0][1], status: 'open', sessionId: null,
  }), TypeError);
  assert.throws(() => normalizeSerialFrameBatch({ ...validCases[1][1], sessionId: '' }), TypeError);
});

test('status and frame timestamps reject unsafe epoch milliseconds', () => {
  const invalidTimestamps = [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN];
  for (const createdAt of invalidTimestamps) {
    assert.throws(() => normalizeSerialStatusEvent({
      ...identity, status: 'open', error: null, createdAt, log: null,
    }), TypeError);
    assert.throws(() => normalizeSerialFrameBatch({
      ...identity, frames: [{ direction: 'in', bytes: Uint8Array.of(1), createdAt }],
    }), TypeError);
  }
});

test('nested runtime records reject aliases and unknown fields', () => {
  assert.throws(() => normalizeSerialStatusEvent({
    ...identity,
    status: 'error',
    error: { code: 'IO_ERROR', message: 'read failed', name: 'Error' },
    createdAt: 1,
    log: null,
  }), TypeError);
  assert.throws(() => normalizeSerialFrameBatch({
    ...identity,
    frames: [{ direction: 'in', bytes: Uint8Array.of(1), createdAt: 1, data: [1] }],
  }), TypeError);
});
