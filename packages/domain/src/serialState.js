import { types as utilTypes } from 'node:util';

const { isProxy } = utilTypes;

export const SERIAL_ERROR_CODES = Object.freeze([
  'PORT_NOT_FOUND',
  'PORT_BUSY',
  'PERMISSION_DENIED',
  'OPEN_CANCELLED',
  'DEVICE_REMOVED',
  'IO_ERROR',
]);

const serialErrorCodes = new Set(SERIAL_ERROR_CODES);
const phases = new Set(['closed', 'opening', 'open', 'closing', 'error']);
const stateFields = ['phase', 'endpointId', 'operationId', 'sessionId', 'error'];
const eventFields = Object.freeze({
  'open-requested': ['type', 'endpointId', 'operationId'],
  'open-succeeded': ['type', 'endpointId', 'operationId', 'sessionId'],
  'open-failed': ['type', 'endpointId', 'operationId', 'error'],
  'open-cancelled': ['type', 'endpointId', 'operationId'],
  'close-requested': ['type', 'endpointId', 'operationId', 'sessionId'],
  closed: ['type', 'endpointId', 'operationId', 'sessionId'],
  'device-removed': ['type', 'endpointId', 'operationId', 'sessionId', 'message'],
});

export function createInitialSerialState() {
  return createState({
    phase: 'closed',
    endpointId: null,
    operationId: null,
    sessionId: null,
    error: null,
  });
}

export function reduceSerialState(state, event) {
  validateState(state);
  validateEvent(event);

  if (event.type === 'open-requested') {
    if (
      state.phase === 'closed'
      && (state.operationId === null || state.operationId !== event.operationId)
    ) {
      return changed(createState({
        phase: 'opening',
        endpointId: event.endpointId,
        operationId: event.operationId,
        sessionId: null,
        error: null,
      }));
    }
    return invalid(state, event);
  }

  if (isStaleIdentity(state, event) || isStaleSession(state, event)) {
    return unchanged(state);
  }

  switch (event.type) {
    case 'open-succeeded':
      if (state.phase !== 'opening') return invalid(state, event);
      return changed(createState({
        ...identityFrom(state), phase: 'open', sessionId: event.sessionId, error: null,
      }));
    case 'open-failed':
      if (state.phase !== 'opening') return invalid(state, event);
      return changed(createState({
        ...identityFrom(state), phase: 'error', sessionId: null,
        error: normalizeError(event.error),
      }));
    case 'open-cancelled':
      if (state.phase !== 'opening') return invalid(state, event);
      return changed(createState({
        ...identityFrom(state), phase: 'closed', sessionId: null,
        error: normalizeError({
          code: 'OPEN_CANCELLED', message: 'Serial open cancelled',
        }),
      }));
    case 'close-requested':
      if (state.phase !== 'open') return invalid(state, event);
      return changed(createState({ ...state, phase: 'closing' }));
    case 'device-removed':
      if (state.phase !== 'open') return invalid(state, event);
      return changed(createState({
        ...identityFrom(state), phase: 'error', sessionId: state.sessionId,
        error: normalizeError({ code: 'DEVICE_REMOVED', message: event.message }),
      }));
    case 'closed':
      if (state.phase !== 'closing' && state.phase !== 'error') {
        return invalid(state, event);
      }
      return changed(createState({ ...state, phase: 'closed', sessionId: null }));
    default:
      return invalid(state, event);
  }
}

function changed(state) {
  return Object.freeze({ state, diagnostic: null });
}

function unchanged(state) {
  return Object.freeze({ state, diagnostic: null });
}

function invalid(state, event) {
  const diagnostic = Object.freeze({
    code: 'INVALID_TRANSITION',
    phase: state.phase,
    event: event.type,
    endpointId: event.endpointId,
    operationId: event.operationId,
  });
  return Object.freeze({ state, diagnostic });
}

function createState(value) {
  return Object.freeze(value);
}

function identityFrom(state) {
  return { endpointId: state.endpointId, operationId: state.operationId };
}

function isStaleIdentity(state, event) {
  return state.endpointId !== null
    && (state.endpointId !== event.endpointId || state.operationId !== event.operationId);
}

function isStaleSession(state, event) {
  if (state.endpointId === null || !Object.hasOwn(event, 'sessionId')) return false;
  if (state.phase === 'opening' && event.type === 'open-succeeded') return false;
  return state.sessionId !== event.sessionId;
}

function validateState(state) {
  requireExactRecord(state, stateFields, 'state');
  if (!phases.has(state.phase)) throw new TypeError('state.phase is invalid');
  requireNullableId(state.endpointId, 'state.endpointId');
  requireNullableId(state.operationId, 'state.operationId');
  requireNullableId(state.sessionId, 'state.sessionId');
  if (state.error !== null) normalizeError(state.error);

  if ((state.endpointId === null) !== (state.operationId === null)) {
    throw new TypeError('state endpoint and operation identities must be set together');
  }
  if (state.phase !== 'closed' && state.endpointId === null) {
    throw new TypeError('active state requires endpoint and operation identities');
  }
  if (state.phase === 'closed' && state.endpointId === null && state.error !== null) {
    throw new TypeError('closed state without lifecycle identity cannot retain an error');
  }
  if ((state.phase === 'open' || state.phase === 'closing') && state.sessionId === null) {
    throw new TypeError(`${state.phase} state requires a sessionId`);
  }
  if ((state.phase === 'opening' || state.phase === 'closed') && state.sessionId !== null) {
    throw new TypeError(`${state.phase} state cannot retain a sessionId`);
  }
  if (state.phase === 'error' && state.error === null) {
    throw new TypeError('error state requires an error');
  }
  if (state.phase !== 'error' && state.phase !== 'closed' && state.error !== null) {
    throw new TypeError(`${state.phase} state cannot retain an error`);
  }
}

function validateEvent(event) {
  requirePlainRecord(event, 'event');
  const type = readOwnDataProperty(event, 'type', 'event.type');
  const expectedFields = eventFields[type];
  if (!expectedFields) throw new TypeError('event.type is invalid');
  requireExactRecord(event, expectedFields, 'event');
  requireId(event.endpointId, 'event.endpointId');
  requireId(event.operationId, 'event.operationId');

  if (Object.hasOwn(event, 'sessionId')) {
    if (event.type === 'closed') requireNullableId(event.sessionId, 'event.sessionId');
    else requireId(event.sessionId, 'event.sessionId');
  }
  if (event.type === 'open-failed') normalizeError(event.error);
  if (event.type === 'device-removed') requireId(event.message, 'event.message');
}

function normalizeError(error) {
  requireExactRecord(error, ['code', 'message'], 'error');
  if (!serialErrorCodes.has(error.code)) {
    throw new TypeError(`error.code must be one of: ${SERIAL_ERROR_CODES.join(', ')}`);
  }
  requireId(error.message, 'error.message');
  return Object.freeze({ code: error.code, message: error.message });
}

function requireNullableId(value, field) {
  if (value !== null) requireId(value, field);
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a nonblank string`);
  }
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.some((field) => !Object.hasOwn(descriptors[field], 'value'))) {
    throw new TypeError(`${label} fields must be data properties`);
  }
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

function readOwnDataProperty(value, field, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${label} must be an own data property`);
  }
  return descriptor.value;
}
