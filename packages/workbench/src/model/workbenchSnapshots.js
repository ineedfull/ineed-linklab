/**
 * Pure runtime-boundary snapshots. Invalid input throws TypeError; callers decide
 * whether to report command errors or drop malformed events. Records and arrays
 * are copied and frozen; byte buffers are copied, preserving their existing API.
 * Strict status-log JSON validation intentionally differs from general data cloning.
 */
const serialErrorCodes = new Set([
  'PORT_NOT_FOUND', 'PORT_BUSY', 'PERMISSION_DENIED',
  'OPEN_CANCELLED', 'DEVICE_REMOVED', 'IO_ERROR',
]);
const transportStatusValues = new Set(['opening', 'open', 'listening', 'closing', 'closed', 'error']);
const statusLogLevels = new Set(['debug', 'info', 'warn', 'error']);
const transportLogSources = new Set(['serial', 'tcp', 'udp', 'modbus', 'websocket']);
const nativeIsProxy = globalThis.process
  ?.getBuiltinModule?.('node:util')
  ?.types?.isProxy;
const transportTypes = new Set([
  'serial', 'tcp-client', 'tcp-server', 'udp-client', 'udp-server', 'websocket-client', 'websocket-server',
  'dlt645-master', 'dlt645-slave',
  'modbus-tcp-master', 'modbus-tcp-slave', 'modbus-rtu-master', 'modbus-rtu-slave',
]);

export function snapshotEndpointList(value) {
  if (!Array.isArray(value)) throw new TypeError('endpoint.list must return an array');
  const ids = new Set();
  const endpoints = Array.from(value, (endpoint) => {
    const snapshot = snapshotEndpoint(endpoint);
    if (ids.has(snapshot.id)) throw new TypeError(`Duplicate endpoint id: ${snapshot.id}`);
    ids.add(snapshot.id);
    return snapshot;
  });
  return Object.freeze(endpoints);
}

export function snapshotEndpoint(value) {
  const snapshot = snapshotRecord(value, 'endpoint');
  requireNonblankString(snapshot.id, 'endpoint.id');
  requireNonblankString(snapshot.name, 'endpoint.name');
  if (!transportTypes.has(snapshot.transport)) {
    throw new TypeError('endpoint.transport must be supported');
  }
  if (!isPlainObject(snapshot.config)) throw new TypeError('endpoint.config must be a plain object');
  return Object.freeze({
    id: snapshot.id,
    name: snapshot.name,
    transport: snapshot.transport,
    config: snapshot.config,
  });
}

export function snapshotCloneOverrides(value) {
  const overrides = snapshotRecord(value, 'clone overrides');
  for (const key of Object.keys(overrides)) {
    if (key !== 'id' && key !== 'name') {
      throw new TypeError(`Unsupported clone override: ${key}`);
    }
  }
  requireNonblankString(overrides.id, 'clone overrides.id');
  const snapshot = { id: overrides.id };
  if (overrides.name !== undefined) {
    requireNonblankString(overrides.name, 'clone overrides.name');
    snapshot.name = overrides.name;
  }
  return Object.freeze(snapshot);
}

export function snapshotFrameEvent(value) {
  const event = snapshotEnvelope(value, 'frame event');
  if (!Array.isArray(event.frames)) throw new TypeError('frame event frames must be an array');
  const frames = Array.from(event.frames, (frame) => {
    if (!isPlainObject(frame)) throw new TypeError('frame must be a plain object');
    requireMatchingIdentity(frame, event, 'frame');
    if (frame.direction !== 'in' && frame.direction !== 'out') {
      throw new TypeError('frame.direction must be in or out');
    }
    if (!(frame.bytes instanceof Uint8Array)) throw new TypeError('frame.bytes must be Uint8Array');
    return frame;
  });
  return Object.freeze({ ...event, frames: Object.freeze(frames) });
}

export function snapshotStatusEvent(value) {
  rejectProxy(value, 'status event');
  const logDescriptor = Object.getOwnPropertyDescriptor(value, 'log');
  if (!logDescriptor || !Object.hasOwn(logDescriptor, 'value')) {
    throw new TypeError('status event.log must be an own data property');
  }
  const log = snapshotStatusLog(logDescriptor.value);
  const event = snapshotRecord(value, 'status event');
  requireNonblankString(event.endpointId, 'status event.endpointId');
  requireNonblankString(event.operationId, 'status event.operationId');
  if (!transportStatusValues.has(event.status)) throw new TypeError('status event.status is invalid');
  if (event.sessionId === null) {
    if (event.status === 'open' || event.status === 'listening' || event.status === 'closing') {
      throw new TypeError(`${event.status} status requires a sessionId`);
    }
  } else {
    requireNonblankString(event.sessionId, 'status event.sessionId');
    if (event.status === 'opening' || event.status === 'closed') {
      throw new TypeError(`${event.status} status cannot retain a sessionId`);
    }
  }
  requireTimestamp(event.createdAt, 'status event.createdAt');
  if (event.status === 'error') {
    requireStatusError(event.error);
  } else if (
    event.status === 'opening'
    || event.status === 'open'
    || event.status === 'listening'
    || event.status === 'closing'
  ) {
    if (event.error !== null) throw new TypeError(`${event.status} status cannot include an error`);
  } else if (event.error !== null) {
    requireStatusError(event.error);
  }
  validateStatusLogSemantics(event, log);
  return Object.freeze({ ...event, log });
}

function snapshotStatusLog(value) {
  if (value === null) return null;
  const fields = Object.hasOwn(value, 'peerId')
    ? ['level', 'source', 'peerId', 'code', 'message', 'details', 'createdAt']
    : ['level', 'source', 'code', 'message', 'details', 'createdAt'];
  requireExactDataRecord(
    value,
    fields,
    'status event.log',
  );
  if (!statusLogLevels.has(value.level)) throw new TypeError('status event.log.level is invalid');
  requireNonblankString(value.source, 'status event.log.source');
  if (value.peerId !== undefined && value.peerId !== null) {
    requireNonblankString(value.peerId, 'status event.log.peerId');
  }
  if (value.code !== null) requireNonblankString(value.code, 'status event.log.code');
  if (!transportLogSources.has(value.source)) throw new TypeError('status event.log.source is invalid');
  requireNonblankString(value.message, 'status event.log.message');
  requireTimestamp(value.createdAt, 'status event.log.createdAt');
  return Object.freeze({
    level: value.level,
    source: value.source,
    ...(value.peerId === undefined || value.peerId === null ? {} : { peerId: value.peerId }),
    code: value.code,
    message: value.message,
    details: snapshotPlainJson(value.details, 'status event.log.details'),
    createdAt: value.createdAt,
  });
}

function requireStatusError(error) {
  requireExactDataRecord(error, ['code', 'message'], 'status event.error');
  if (!serialErrorCodes.has(error.code)) throw new TypeError('status event.error.code is invalid');
  requireNonblankString(error.message, 'status event.error.message');
}

function validateStatusLogSemantics(event, log) {
  if (event.status === 'listening' && log === null) {
    throw new TypeError('listening status requires a log');
  }
  if (log === null) return;
  if (log.createdAt !== event.createdAt) {
    throw new TypeError('status event.log.createdAt must match status event.createdAt');
  }
  if (event.status === 'error') {
    const level = event.error.code === 'DEVICE_REMOVED' ? 'warn' : 'error';
    if (log.level !== level || log.code !== event.error.code) {
      throw new TypeError(`error status log must use ${level} with the serial error code`);
    }
    return;
  }
  if (event.status === 'closed' && event.error !== null) {
    throw new TypeError('failure terminal closed status cannot include a log');
  }
  if (event.status === 'listening' && log.level === 'warn' && log.code === null) return;
  if (event.status === 'closed' && ['tcp', 'websocket'].includes(log.source) && log.level === 'warn' && log.code === null) return;
  const level = event.status === 'open' || event.status === 'listening' || event.status === 'closed'
    ? 'info'
    : 'debug';
  if (log.level !== level || log.code !== null) {
    throw new TypeError(`${event.status} status log must use ${level} without a code`);
  }
}

export function snapshotPlainJson(value, label) {
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

function requireExactDataRecord(value, fields, label) {
  rejectProxy(value, label);
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
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

function requireTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${field} must be safe non-negative integer epoch milliseconds`);
  }
}

function rejectProxy(value, label) {
  if (value !== null && typeof value === 'object' && nativeIsProxy?.(value)) {
    globalThis.structuredClone(value);
    throw new TypeError(`${label} must not be a proxy`);
  }
}

export function snapshotPeerEvent(value) {
  const event = snapshotEnvelope(value, 'peer event');
  if (!Array.isArray(event.peers)) throw new TypeError('peer event peers must be an array');
  const peers = Array.from(event.peers, (peer) => {
    if (!isPlainObject(peer)) throw new TypeError('peer must be a plain object');
    requireNonblankString(peer.id, 'peer.id');
    requireNonblankString(peer.remoteAddress, 'peer.remoteAddress');
    requireTimestamp(peer.connectedAt, 'peer.connectedAt');
    // Native peers carry identity on the event envelope, not on each peer.
    // Retain validation for callers that include nested identity fields.
    if (['endpointId', 'sessionId', 'operationId'].some((key) => Object.hasOwn(peer, key))) {
      requireMatchingIdentity(peer, event, 'peer');
    }
    return peer;
  });
  return Object.freeze({ ...event, peers: Object.freeze(peers) });
}

function snapshotEnvelope(value, label) {
  const event = snapshotRecord(value, label);
  requireNonblankString(event.endpointId, `${label}.endpointId`);
  requireNonblankString(event.operationId, `${label}.operationId`);
  requireNonblankString(event.sessionId, `${label}.sessionId`);
  return event;
}

function requireMatchingIdentity(item, event, label) {
  requireNonblankString(item.endpointId, `${label}.endpointId`);
  requireNonblankString(item.sessionId, `${label}.sessionId`);
  if (item.endpointId !== event.endpointId || item.sessionId !== event.sessionId) {
    throw new TypeError(`${label} identity must match its event`);
  }
  if (item.operationId !== undefined && item.operationId !== event.operationId) {
    throw new TypeError(`${label}.operationId must match its event`);
  }
}

export function snapshotOperation(operation) {
  const snapshot = snapshotRecord(operation, 'operation');
  requireNonblankString(snapshot.endpointId, 'endpointId');
  requireNonblankString(snapshot.operationId, 'operationId');
  if (snapshot.sessionId !== null) requireNonblankString(snapshot.sessionId, 'sessionId');
  return Object.freeze({
    endpointId: snapshot.endpointId,
    sessionId: snapshot.sessionId,
    operationId: snapshot.operationId,
  });
}

function snapshotRecord(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  return cloneData(value, new Set(), label);
}

function cloneData(value, ancestors, label) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== 'object') throw new TypeError(`${label} contains unsupported data`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(Array.from(
        value,
        (item) => cloneData(item, ancestors, label),
      ));
    }
    if (!isPlainObject(value)) throw new TypeError(`${label} contains unsupported data`);
    const clone = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!('value' in descriptor)) throw new TypeError(`${label} must not contain accessors`);
      clone[key] = cloneData(descriptor.value, ancestors, label);
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireNonblankString(value, field) {
  if (!isNonblankString(value)) throw new TypeError(`${field} must be a nonblank string`);
}

export function isNonblankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}
