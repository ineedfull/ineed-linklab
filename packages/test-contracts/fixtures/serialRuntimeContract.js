import { types as utilTypes } from 'node:util';

import { SERIAL_ERROR_CODES } from '@ineed-linklab/domain/serial-state';

export { SERIAL_ERROR_CODES };

const { isProxy } = utilTypes;
const serialErrorCodes = new Set(SERIAL_ERROR_CODES);
const transportSources = new Set(['serial', 'tcp']);
const statusValues = new Set(['opening', 'open', 'listening', 'closing', 'closed', 'error']);
const logLevels = new Set(['debug', 'info', 'warn', 'error']);
const directions = new Set(['in', 'out']);
const portFields = ['path', 'manufacturer', 'serialNumber', 'vendorId', 'productId'];
const identityFields = ['endpointId', 'operationId', 'sessionId'];

export function normalizeSerialPortRecord(record) {
  requireAllowedRecord(record, portFields, ['path'], 'port record');
  requireId(record.path, 'port.path');
  const normalized = { path: record.path };
  for (const field of portFields.slice(1)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    const value = descriptor?.value ?? null;
    if (value !== null && typeof value !== 'string') {
      throw new TypeError(`port.${field} must be a string or null`);
    }
    Object.defineProperty(normalized, field, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return Object.freeze(normalized);
}

export const normalizeSerialStatusEvent = normalizeTransportStatusEvent;
export const normalizeSerialFrameBatch = normalizeTransportFrameBatch;

export function normalizeTransportStatusEvent(event) {
  requireExactRecord(
    event,
    [...identityFields, 'status', 'error', 'createdAt', 'log'],
    'status event',
  );
  requireId(event.endpointId, 'status event.endpointId');
  requireId(event.operationId, 'status event.operationId');
  if (!statusValues.has(event.status)) throw new TypeError('status event.status is invalid');
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
  if (event.status === 'error' && event.error === null) {
    throw new TypeError('error status requires an error');
  }
  if (
    (
      event.status === 'opening'
      || event.status === 'open'
      || event.status === 'listening'
      || event.status === 'closing'
    )
    && event.error !== null
  ) {
    throw new TypeError(`${event.status} status cannot include an error`);
  }
  const error = event.error === null ? null : normalizeSerialError(event.error);
  const log = normalizeStatusLog(event.log);
  validateStatusLogSemantics(event, error, log);
  return Object.freeze({
    endpointId: event.endpointId,
    operationId: event.operationId,
    sessionId: event.sessionId,
    status: event.status,
    error,
    createdAt: event.createdAt,
    log,
  });
}

export function normalizeTransportFrameBatch(batch) {
  requireExactRecord(batch, [...identityFields, 'frames'], 'frame batch');
  requireIdentity(batch, 'frame batch');
  const frameValues = readDenseDataArray(batch.frames, 'frame batch.frames');
  const frames = new Array(frameValues.length);
  for (let index = 0; index < frameValues.length; index += 1) {
    const frame = frameValues[index];
    requireExactRecord(frame, ['direction', 'bytes', 'createdAt'], 'frame');
    if (!directions.has(frame.direction)) throw new TypeError('frame.direction is invalid');
    requireTimestamp(frame.createdAt, 'frame.createdAt');
    frames[index] = Object.freeze({
      direction: frame.direction,
      bytes: normalizeFrameBytes(frame.bytes),
      createdAt: frame.createdAt,
    });
  }

  return Object.freeze({
    endpointId: batch.endpointId,
    operationId: batch.operationId,
    sessionId: batch.sessionId,
    frames: Object.freeze(frames),
  });
}

export function normalizeTransportPeerEvent(event) {
  requireExactRecord(event, [...identityFields, 'peers'], 'peer event');
  requireIdentity(event, 'peer event');
  const peerValues = readDenseDataArray(event.peers, 'peer event.peers');
  const peers = peerValues.map((peer) => {
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

export function normalizeSerialCancelAcknowledgement(acknowledgement) {
  requireExactRecord(
    acknowledgement,
    ['endpointId', 'operationId', 'cancelled'],
    'cancel acknowledgement',
  );
  requireId(acknowledgement.endpointId, 'cancel acknowledgement.endpointId');
  requireId(acknowledgement.operationId, 'cancel acknowledgement.operationId');
  if (acknowledgement.cancelled !== true) {
    throw new TypeError('cancel acknowledgement.cancelled must be true');
  }
  return Object.freeze({
    endpointId: acknowledgement.endpointId,
    operationId: acknowledgement.operationId,
    cancelled: true,
  });
}

export function normalizeSerialCommandEnvelope(envelope) {
  requirePlainRecord(envelope, 'command envelope');
  const ok = readOwnDataProperty(envelope, 'ok', 'command envelope.ok');
  if (ok === true) {
    requireExactRecord(envelope, ['ok', 'value'], 'command success envelope');
    return Object.freeze({ ok: true, value: envelope.value });
  }
  if (ok === false) {
    requireExactRecord(envelope, ['ok', 'error'], 'command error envelope');
    return Object.freeze({ ok: false, error: normalizeSerialError(envelope.error) });
  }
  throw new TypeError('command envelope.ok must be a boolean literal');
}

function normalizeSerialError(error) {
  requireExactRecord(error, ['code', 'message'], 'serial error');
  if (!serialErrorCodes.has(error.code)) {
    throw new TypeError(`serial error.code must be one of: ${SERIAL_ERROR_CODES.join(', ')}`);
  }
  requireId(error.message, 'serial error.message');
  return Object.freeze({ code: error.code, message: error.message });
}

function normalizeStatusLog(value) {
  if (value === null) return null;
  requireExactRecord(
    value,
    ['level', 'source', 'code', 'message', 'details', 'createdAt'],
    'status log',
  );
  if (!logLevels.has(value.level)) throw new TypeError('status log.level is invalid');
  requireId(value.source, 'status log.source');
  if (value.code !== null) requireId(value.code, 'status log.code');
  requireId(value.message, 'status log.message');
  requireTimestamp(value.createdAt, 'status log.createdAt');
  return Object.freeze({
    level: value.level,
    source: value.source,
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
  if (!transportSources.has(log.source)) {
    throw new TypeError('status log.source must be serial or tcp');
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
    if (log.level !== 'info' || log.code !== null) {
      throw new TypeError('listening status log must use info without a code');
    }
    return;
  }
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
  if (isProxy(value)) throw new TypeError(`${label} must not contain proxies`);
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

function normalizeFrameBytes(bytes) {
  if (bytes !== null && typeof bytes === 'object' && isProxy(bytes)) {
    throw new TypeError('frame.bytes must not be a proxy');
  }
  if (bytes instanceof Uint8Array) return new Uint8Array(bytes);
  const values = readDenseDataArray(bytes, 'frame.bytes', 'a Uint8Array or byte array');
  const normalized = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new TypeError('frame.bytes elements must be integers from 0 to 255');
    }
    normalized[index] = value;
  }
  return normalized;
}

function readDenseDataArray(value, label, expected = 'an array') {
  if (value !== null && typeof value === 'object' && isProxy(value)) {
    throw new TypeError(`${label} must not be a proxy`);
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be ${expected}`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(descriptors);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
    throw new TypeError(`${label} length must be a data property`);
  }
  const length = lengthDescriptor.value;
  if (
    Object.getOwnPropertySymbols(descriptors).length !== 0
    || names.length !== length + 1
  ) {
    throw new TypeError(`${label} must not contain extra properties`);
  }

  const values = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must contain dense data elements`);
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
    throw new TypeError(`${field} must be safe non-negative integer epoch milliseconds`);
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a nonblank string`);
  }
}

function requireAllowedRecord(value, allowedFields, requiredFields, label) {
  requirePlainRecord(value, label);
  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || names.some((field) => !allowedFields.includes(field))
    || requiredFields.some((field) => !names.includes(field))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  requireDataProperties(value, names, label);
}

function requireExactRecord(value, fields, label) {
  requirePlainRecord(value, label);
  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || names.length !== fields.length
    || fields.some((field) => !names.includes(field))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  requireDataProperties(value, fields, label);
}

function requirePlainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (isProxy(value)) throw new TypeError(`${label} must not be a proxy`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function requireDataProperties(value, fields, label) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.some((field) => !Object.hasOwn(descriptors[field], 'value'))) {
    throw new TypeError(`${label} fields must be data properties`);
  }
}

function readOwnDataProperty(value, field, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${label} must be an own data property`);
  }
  return descriptor.value;
}
