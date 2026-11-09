export const TRANSPORT_TYPES = Object.freeze([
  'serial',
  'tcp-client',
  'tcp-server',
  'udp-client',
  'udp-server',
  'dlt645-master',
  'dlt645-slave',
  'modbus-tcp-master',
  'modbus-tcp-slave',
  'modbus-rtu-master',
  'modbus-rtu-slave',
]);

const transportTypes = new Set(TRANSPORT_TYPES);

export function createEndpointProfile({ id, name, transport, config } = {}) {
  requireNonblankString(id, 'id');
  requireNonblankString(name, 'name');
  if (!transportTypes.has(transport)) {
    throw new TypeError(`transport must be one of: ${TRANSPORT_TYPES.join(', ')}`);
  }
  if (!isPlainObject(config)) {
    throw new TypeError('config must be a plain object');
  }

  return Object.freeze({ id, name, transport, config });
}

export function createSession(endpoint, { sessionId, operationId } = {}) {
  if (!isPlainObject(endpoint)) {
    throw new TypeError('endpoint must be an endpoint profile');
  }
  requireNonblankString(endpoint.id, 'endpoint.id');
  if (!transportTypes.has(endpoint.transport)) {
    throw new TypeError('endpoint.transport must be a supported transport');
  }
  requireNonblankString(sessionId, 'sessionId');
  requireNonblankString(operationId, 'operationId');

  return Object.freeze({
    id: sessionId,
    endpointId: endpoint.id,
    transport: endpoint.transport,
    operationId,
  });
}

export function createPeer({ id, endpointId, sessionId } = {}) {
  requireNonblankString(id, 'id');
  requireNonblankString(endpointId, 'endpointId');
  requireNonblankString(sessionId, 'sessionId');

  return Object.freeze({ id, endpointId, sessionId });
}

export function createTransferFrame({
  endpointId,
  sessionId,
  direction,
  bytes,
  createdAt = Date.now(),
} = {}) {
  requireNonblankString(endpointId, 'endpointId');
  requireNonblankString(sessionId, 'sessionId');
  if (direction !== 'in' && direction !== 'out') {
    throw new TypeError('direction must be either "in" or "out"');
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Uint8Array');
  }
  if (!Number.isFinite(createdAt) || !Number.isInteger(createdAt)) {
    throw new TypeError('createdAt must be finite integer epoch milliseconds');
  }

  return Object.freeze({ endpointId, sessionId, direction, bytes, createdAt });
}

export function createTransportError({
  code,
  message,
  protocol = null,
  phase = null,
  source = null,
  rawReason = null,
  remoteAddress = null,
  retryable = false,
} = {}) {
  requireNonblankString(code, 'code');
  requireNonblankString(message, 'message');
  if (typeof retryable !== 'boolean') {
    throw new TypeError('retryable must be a boolean');
  }

  return Object.freeze({
    code,
    message,
    protocol,
    phase,
    source,
    rawReason,
    remoteAddress,
    retryable,
  });
}

function requireNonblankString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a nonblank string`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
