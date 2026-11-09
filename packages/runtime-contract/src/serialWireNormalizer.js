const ERROR_CODES = new Set([
  'PORT_NOT_FOUND',
  'PORT_BUSY',
  'PERMISSION_DENIED',
  'OPEN_CANCELLED',
  'DEVICE_REMOVED',
  'IO_ERROR',
]);
const TRANSPORT_SOURCES = new Set(['serial', 'tcp', 'udp', 'modbus', 'websocket']);
const STATUS_VALUES = new Set(['opening', 'open', 'listening', 'closing', 'closed', 'error']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const nativeIsProxy = globalThis.process
  ?.getBuiltinModule?.('node:util')
  ?.types?.isProxy;

export const normalizeFrameWireBatch = normalizeTransportFrameBatch;
export const normalizeStatusWireEvent = normalizeTransportStatusEvent;

export function normalizeTransportFrameBatch(value) {
  const batch = snapshotWirePayload(value);
  requireExactRecord(batch, ['endpointId', 'operationId', 'sessionId', 'frames'], 'frame batch');
  requireIdentity(batch, 'frame batch');
  const inputFrames = readDenseArray(batch.frames, 'frame batch.frames');
  const frames = inputFrames.map((frame) => {
    const fields = Object.hasOwn(frame, 'peerId')
      ? ['direction', 'peerId', 'bytes', 'createdAt']
      : ['direction', 'bytes', 'createdAt'];
    if (Object.hasOwn(frame, 'messageType')) {
      fields.push('messageType');
      if (!['text', 'binary'].includes(frame.messageType)) throw new TypeError('frame.messageType must be text or binary');
    }
    if (Object.hasOwn(frame, 'framing')) {
      fields.push('framing');
      if (frame.framing !== 'websocket') throw new TypeError('frame.framing must be websocket');
    }
    requireExactRecord(frame, fields, 'frame');
    if (frame.direction !== 'in' && frame.direction !== 'out') {
      throw new TypeError('frame.direction is invalid');
    }
    const peerId = normalizeOptionalId(frame.peerId, 'frame.peerId');
    requireTimestamp(frame.createdAt, 'frame.createdAt');
    return {
      endpointId: batch.endpointId,
      operationId: batch.operationId,
      sessionId: batch.sessionId,
      ...(peerId === null ? {} : { peerId }),
      direction: frame.direction,
      ...(frame.framing ? { framing: frame.framing } : {}),
      ...(frame.messageType ? { messageType: frame.messageType } : {}),
      bytes: normalizeBytes(frame.bytes),
      createdAt: frame.createdAt,
    };
  });
  return {
    endpointId: batch.endpointId,
    operationId: batch.operationId,
    sessionId: batch.sessionId,
    frames,
  };
}

export function normalizeTransportStatusEvent(value) {
  validateStatusWireEventSource(value);
  const event = snapshotWirePayload(value);
  requireExactRecord(
    event,
    ['endpointId', 'operationId', 'sessionId', 'status', 'error', 'createdAt', 'log'],
    'status event',
  );
  requireId(event.endpointId, 'status event.endpointId');
  requireId(event.operationId, 'status event.operationId');
  if (!STATUS_VALUES.has(event.status)) throw new TypeError('status event.status is invalid');
  if (event.sessionId === null) {
    if (event.status === 'open' || event.status === 'listening' || event.status === 'closing') {
      throw new TypeError(`${event.status} status requires a sessionId`);
    }
  } else {
    requireId(event.sessionId, 'status event.sessionId');
    if (event.status === 'opening' || event.status === 'closed') {
      throw new TypeError(`${event.status} status cannot retain a sessionId`);
    }
  }
  requireTimestamp(event.createdAt, 'status event.createdAt');
  if (event.status === 'error') {
    if (event.error === null) throw new TypeError('error status requires an error');
  } else if (
    event.status === 'opening'
    || event.status === 'open'
    || event.status === 'listening'
    || event.status === 'closing'
  ) {
    if (event.error !== null) throw new TypeError(`${event.status} status cannot include an error`);
  }
  const error = event.error === null ? null : normalizeError(event.error);
  const log = normalizeStatusLog(event.log);
  validateStatusLogSemantics(event, error, log);
  return {
    endpointId: event.endpointId,
    operationId: event.operationId,
    sessionId: event.sessionId,
    status: event.status,
    error,
    createdAt: event.createdAt,
    log,
  };
}

export function normalizeTransportPeerEvent(value) {
  const event = snapshotWirePayload(value);
  requireExactRecord(event, ['endpointId', 'operationId', 'sessionId', 'peers'], 'peer event');
  requireIdentity(event, 'peer event');
  const peers = readDenseArray(event.peers, 'peer event.peers').map((peer) => {
    requireExactRecord(peer, ['id', 'remoteAddress', 'connectedAt'], 'peer');
    requireId(peer.id, 'peer.id');
    requireId(peer.remoteAddress, 'peer.remoteAddress');
    requireTimestamp(peer.connectedAt, 'peer.connectedAt');
    return Object.freeze({
      id: peer.id,
      remoteAddress: peer.remoteAddress,
      connectedAt: peer.connectedAt,
    });
  });
  return Object.freeze({
    endpointId: event.endpointId,
    operationId: event.operationId,
    sessionId: event.sessionId,
    peers: Object.freeze(peers),
  });
}

function validateStatusWireEventSource(value) {
  requireExactRecord(
    value,
    ['endpointId', 'operationId', 'sessionId', 'status', 'error', 'createdAt', 'log'],
    'status event',
  );
  if (value.error !== null) normalizeError(value.error);
  normalizeStatusLog(value.log);
}

function snapshotWirePayload(value) {
  return globalThis.structuredClone(value);
}

function normalizeBytes(value) {
  if (
    value instanceof Uint8Array
    && Object.getPrototypeOf(value) === Uint8Array.prototype
  ) return new Uint8Array(value);
  const values = readDenseArray(value, 'frame.bytes');
  const bytes = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const byte = values[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError('frame.bytes contains an invalid byte');
    }
    bytes[index] = byte;
  }
  return bytes;
}

function normalizeError(error) {
  requireExactRecord(error, ['code', 'message'], 'serial error');
  if (!ERROR_CODES.has(error.code)) throw new TypeError('serial error.code is invalid');
  requireId(error.message, 'serial error.message');
  return { code: error.code, message: error.message };
}

function normalizeOptionalId(value, label) {
  if (value === undefined || value === null) return null;
  requireId(value, label);
  return value;
}

function normalizeStatusLog(value) {
  if (value === null) return null;
  const fields = Object.hasOwn(value, 'peerId')
    ? ['level', 'source', 'peerId', 'code', 'message', 'details', 'createdAt']
    : ['level', 'source', 'code', 'message', 'details', 'createdAt'];
  requireExactRecord(
    value,
    fields,
    'status log',
  );
  if (!LOG_LEVELS.has(value.level)) throw new TypeError('status log.level is invalid');
  requireId(value.source, 'status log.source');
  const peerId = normalizeOptionalId(value.peerId, 'status log.peerId');
  if (value.code !== null) requireId(value.code, 'status log.code');
  requireId(value.message, 'status log.message');
  requireTimestamp(value.createdAt, 'status log.createdAt');
  return Object.freeze({
    level: value.level,
    source: value.source,
    ...(peerId === null ? {} : { peerId }),
    code: value.code,
    message: value.message,
    details: normalizePlainJson(value.details, 'status log.details'),
    createdAt: value.createdAt,
  });
}

function validateStatusLogSemantics(event, error, log) {
  if (event.status === 'listening' && log === null) {
    throw new TypeError('listening status requires a log');
  }
  if (log === null) return;
  if (!TRANSPORT_SOURCES.has(log.source)) {
    throw new TypeError('status log.source must be serial, tcp, udp, modbus, or websocket');
  }
  if (log.createdAt !== event.createdAt) {
    throw new TypeError('status log.createdAt must match status event.createdAt');
  }
  if (event.status === 'error') {
    const level = error.code === 'DEVICE_REMOVED' ? 'warn' : 'error';
    if (log.level !== level || log.code !== error.code) {
      throw new TypeError(`error status log must use ${level} with the serial error code`);
    }
    return;
  }
  if (event.status === 'closed' && error !== null) {
    throw new TypeError('failure terminal closed status cannot include a log');
  }
  if (event.status === 'listening') {
    if (event.sessionId === null) throw new TypeError('listening status requires a sessionId');
    if (!['info', 'warn'].includes(log.level) || log.code !== null) {
      throw new TypeError('listening status log must use info or warn without a code');
    }
    return;
  }
  if (event.status === 'closed' && log.source === 'tcp' && log.level === 'warn' && log.code === null) return;
  const level = event.status === 'open' || event.status === 'closed' ? 'info' : 'debug';
  if (log.level !== level || log.code !== null) {
    throw new TypeError(`${event.status} status log must use ${level} without a code`);
  }
}

function normalizePlainJson(value, label) {
  if (value === null) return null;
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must be a plain object, array, or null`);
  }
  return clonePlainJsonValue(value, new Set(), label);
}

function clonePlainJsonValue(value, ancestors, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value)
      || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new TypeError(`${label} contains an unsafe number`);
    }
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} contains unsupported data`);
  rejectProxy(value, label);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${label} arrays must use the standard prototype`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const names = Object.getOwnPropertyNames(descriptors);
      if (
        Object.getOwnPropertySymbols(value).length !== 0
        || names.length !== value.length + 1
      ) {
        throw new TypeError(`${label} arrays must be dense without extra properties`);
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${label} arrays must contain dense data elements`);
        }
        clone[index] = clonePlainJsonValue(descriptor.value, ancestors, `${label}[${index}]`);
      }
      return Object.freeze(clone);
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} objects must use the standard prototype`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError(`${label} must not contain symbol properties`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const clone = {};
    for (const key of Object.getOwnPropertyNames(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} properties must be enumerable data values`);
      }
      Object.defineProperty(clone, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: clonePlainJsonValue(descriptor.value, ancestors, `${label}.${key}`),
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

function readDenseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(descriptors);
  if (
    Object.getOwnPropertySymbols(descriptors).length !== 0
    || names.length !== value.length + 1
  ) {
    throw new TypeError(`${label} must be dense without extra fields`);
  }
  const values = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must contain data elements`);
    }
    values[index] = descriptor.value;
  }
  return values;
}

function requireIdentity(value, label) {
  requireId(value.endpointId, `${label}.endpointId`);
  requireId(value.operationId, `${label}.operationId`);
  requireId(value.sessionId, `${label}.sessionId`);
}

function requireTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a nonblank string`);
  }
}

function requireExactRecord(value, fields, label) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must be a plain object`);
  }
  rejectProxy(value, label);
  if (Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || names.length !== fields.length
    || fields.some((field) => !names.includes(field))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.some((field) => !Object.hasOwn(descriptors[field], 'value'))) {
    throw new TypeError(`${label} fields must be data properties`);
  }
}

function rejectProxy(value, label) {
  if (nativeIsProxy?.(value)) {
    globalThis.structuredClone(value);
    throw new TypeError(`${label} must not be a proxy`);
  }
}
