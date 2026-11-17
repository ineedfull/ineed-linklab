// Endpoint, send-template, and workspace import serialization.
const { WORKSPACE_VERSION } = require('./contracts.cjs');
const {
  cloneSerializable,
  assertJsonValue,
  assertJsonObject,
  assertJsonObjectOrNull,
  snapshotRecord,
  assertNoSensitiveKeys,
  runtimeHistoryTimestamp,
  requireWorkspaceTimestamps,
  validateOptionalTimestamps,
  requireNonblankString,
  requireNullableNonblankString,
  isPlainObject,
} = require('./validation.cjs');
const { normalizeImportedSettings } = require('./settings.cjs');

function endpointForWrite(profile, { requireTimestamps = false } = {}) {
  const snapshot = snapshotRecord(profile, {
    label: 'endpoint profile',
    requiredKeys: ['id', 'name', 'transport', 'config'],
    optionalKeys: ['createdAt', 'updatedAt'],
  });
  assertJsonObject(snapshot.config, 'config');
  requireNonblankString(snapshot.id, 'id');
  requireNonblankString(snapshot.name, 'name');
  requireNonblankString(snapshot.transport, 'transport');
  if (!['serial', 'tcp-client', 'tcp-server', 'udp-client', 'udp-server', 'websocket-client', 'websocket-server', 'dlt645-master', 'dlt645-slave', 'modbus-tcp-master', 'modbus-tcp-slave', 'modbus-rtu-master', 'modbus-rtu-slave'].includes(snapshot.transport)) throw new TypeError('Unsupported transport');
  if (snapshot.transport.startsWith('websocket-')) {
    if (Object.hasOwn(snapshot.config, 'headers') || Object.hasOwn(snapshot.config, 'websocketHeaders')) {
      throw new TypeError('WebSocket headers are session-only and cannot be saved');
    }
  }
  if (requireTimestamps) requireWorkspaceTimestamps(snapshot, 'endpoint profile');
  validateOptionalTimestamps(snapshot, 'endpoint profile');
  assertNoSensitiveKeys(snapshot);
  const value = cloneSerializable({
    id: snapshot.id,
    name: snapshot.name,
    transport: snapshot.transport,
    config: snapshot.config,
  });
  if (Object.hasOwn(snapshot, 'createdAt')) value.createdAt = snapshot.createdAt;
  if (Object.hasOwn(snapshot, 'updatedAt')) value.updatedAt = snapshot.updatedAt;
  return value;
}

function templateForWrite(template, { requireTimestamps = false } = {}) {
  const snapshot = snapshotRecord(template, {
    label: 'send template',
    requiredKeys: ['id', 'endpointId', 'name', 'format', 'framing', 'target', 'payloadBase64'],
    optionalKeys: ['createdAt', 'updatedAt'],
  });
  assertJsonObjectOrNull(snapshot.target, 'target');
  for (const key of ['id', 'endpointId', 'name', 'format', 'framing', 'payloadBase64']) {
    requireNonblankString(snapshot[key], key);
  }
  const payload = Buffer.from(snapshot.payloadBase64, 'base64');
  if (payload.toString('base64') !== snapshot.payloadBase64) {
    throw new TypeError('payloadBase64 must be canonical base64');
  }
  if (requireTimestamps) requireWorkspaceTimestamps(snapshot, 'send template');
  validateOptionalTimestamps(snapshot, 'send template');
  assertNoSensitiveKeys(snapshot);
  const value = cloneSerializable({
    id: snapshot.id,
    endpointId: snapshot.endpointId,
    name: snapshot.name,
    format: snapshot.format,
    framing: snapshot.framing,
    target: snapshot.target,
    payloadBase64: snapshot.payloadBase64,
  });
  if (Object.hasOwn(snapshot, 'createdAt')) value.createdAt = snapshot.createdAt;
  if (Object.hasOwn(snapshot, 'updatedAt')) value.updatedAt = snapshot.updatedAt;
  return value;
}

function sendHistoryForWrite(record) {
  const snapshot = snapshotRecord(record, {
    label: 'send history',
    requiredKeys: [
      'endpointId', 'sessionId', 'peerId', 'target', 'format', 'framing',
      'payloadBase64', 'createdAt',
    ],
  });
  requireNonblankString(snapshot.endpointId, 'endpointId');
  requireNullableNonblankString(snapshot.sessionId, 'sessionId');
  requireNullableNonblankString(snapshot.peerId, 'peerId');
  requireNonblankString(snapshot.format, 'format');
  requireNonblankString(snapshot.framing, 'framing');
  requireNonblankString(snapshot.payloadBase64, 'payloadBase64');
  assertJsonObjectOrNull(snapshot.target, 'target');
  const payload = Buffer.from(snapshot.payloadBase64, 'base64');
  if (payload.toString('base64') !== snapshot.payloadBase64) {
    throw new TypeError('payloadBase64 must be canonical base64');
  }
  return {
    endpointId: snapshot.endpointId,
    sessionId: snapshot.sessionId,
    peerId: snapshot.peerId,
    target: cloneSerializable(snapshot.target),
    format: snapshot.format,
    framing: snapshot.framing,
    payload,
    byteCount: payload.byteLength,
    createdAt: runtimeHistoryTimestamp(snapshot.createdAt, 'createdAt'),
  };
}

function normalizeSendHistoryQuery(query) {
  const snapshot = snapshotRecord(query, {
    label: 'send history query',
    requiredKeys: ['endpointId'],
    optionalKeys: ['page', 'pageSize'],
  });
  requireNonblankString(snapshot.endpointId, 'endpointId');
  const page = snapshot.page ?? 1;
  const pageSize = snapshot.pageSize ?? 20;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
    throw new TypeError('page must be an integer from 1 to 1000000');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('pageSize must be an integer from 1 to 100');
  }
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw new TypeError('send history page offset is too large');
  }
  return { endpointId: snapshot.endpointId, page, pageSize };
}

function workspaceForImport(workspace) {
  const snapshot = snapshotRecord(workspace, {
    label: 'workspace',
    requiredKeys: ['version', 'endpointProfiles', 'settings', 'sendTemplates'],
  });
  assertJsonValue(snapshot, new Set(), 'workspace');
  if (snapshot.version !== WORKSPACE_VERSION) {
    throw new TypeError(`workspace version must be ${WORKSPACE_VERSION}`);
  }
  if (!Array.isArray(snapshot.endpointProfiles)
    || !isPlainObject(snapshot.settings)
    || !Array.isArray(snapshot.sendTemplates)) {
    throw new TypeError('workspace has an invalid shape');
  }
  assertNoSensitiveKeys(snapshot);
  return cloneSerializable({ ...snapshot, settings: normalizeImportedSettings(snapshot.settings) });
}

function endpointFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    config: JSON.parse(row.config_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function templateFromRow(row) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    name: row.name,
    format: row.format,
    framing: row.framing,
    target: row.target_json === null ? null : JSON.parse(row.target_json),
    payloadBase64: Buffer.from(row.payload).toString('base64'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function sendHistoryFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    sessionId: row.session_id,
    peerId: row.peer_id,
    target: row.target_json === null ? null : JSON.parse(row.target_json),
    format: row.format,
    framing: row.framing,
    payloadBase64: Buffer.from(row.payload).toString('base64'),
    byteCount: Number(row.byte_count),
    createdAt: Number(row.created_at),
  };
}

function cloneOverrides(overrides) {
  const snapshot = snapshotRecord(overrides, {
    label: 'clone overrides',
    requiredKeys: ['id'],
    optionalKeys: ['name'],
  });
  requireNonblankString(snapshot.id, 'clone overrides.id');
  if (Object.hasOwn(snapshot, 'name')) {
    requireNonblankString(snapshot.name, 'clone overrides.name');
  }
  return snapshot;
}

module.exports = {
  endpointForWrite,
  templateForWrite,
  sendHistoryForWrite,
  normalizeSendHistoryQuery,
  workspaceForImport,
  endpointFromRow,
  templateFromRow,
  sendHistoryFromRow,
  cloneOverrides,
};
