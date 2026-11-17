// Frame/log history validation, row conversion, and transactional batches.
const {
  assertJsonValue,
  assertJsonSafeIntegers,
  snapshotRecord,
  runtimeHistoryTimestamp,
  requireNonblankString,
  requireNullableNonblankString,
  isPlainObject,
} = require('./validation.cjs');
const { types: { isProxy } } = require('node:util');

const FRAME_DIRECTIONS = new Set(['in', 'out']);

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function queryHistory(connection, kind, rawQuery) {
  const query = normalizeHistoryQuery(rawQuery);
  const isFrames = kind === 'frames';
  const table = isFrames ? 'transfer_frames' : 'runtime_logs';
  const conditions = [];
  const values = [];
  const add = (sql, value) => {
    conditions.push(sql);
    values.push(value);
  };
  if (query.endpointId) add('endpoint_id = ?', query.endpointId);
  if (query.from !== null) add('created_at >= ?', query.from);
  if (query.to !== null) add('created_at <= ?', query.to);
  if (isFrames && query.direction) add('direction = ?', query.direction);
  if (!isFrames && query.level) add('level = ?', query.level);
  if (!isFrames && query.source) add('source = ?', query.source);
  if (query.search) {
    const escaped = `%${query.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    add(
      isFrames
        ? "CAST(payload AS TEXT) LIKE ? ESCAPE '\\'"
        : "(message LIKE ? ESCAPE '\\' OR COALESCE(code, '') LIKE ? ESCAPE '\\' OR COALESCE(details_json, '') LIKE ? ESCAPE '\\')",
      escaped,
    );
    if (!isFrames) values.push(escaped, escaped);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(connection.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...values).count);
  const offset = (query.page - 1) * query.pageSize;
  const rows = connection.prepare(
    `SELECT * FROM ${table}${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...values, query.pageSize, offset).map(isFrames ? frameFromRow : logFromRow);
  return { rows, total, page: query.page, pageSize: query.pageSize };
}

function normalizeHistoryQuery(value) {
  if (!isPlainObject(value)) throw new TypeError('history query must be an object');
  const page = value.page ?? 1;
  const pageSize = value.pageSize ?? 50;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
    throw new TypeError('page must be an integer from 1 to 1000000');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new TypeError('pageSize must be an integer from 1 to 200');
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new TypeError('history page offset is too large');
  for (const key of ['endpointId', 'search', 'direction', 'level', 'source']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new TypeError(`${key} must be a string`);
  }
  for (const key of ['from', 'to']) {
    if (value[key] !== undefined && value[key] !== null
      && (!Number.isSafeInteger(value[key]) || value[key] < 0)) {
      throw new TypeError(`${key} must be a timestamp`);
    }
  }
  return {
    endpointId: value.endpointId?.trim() || '',
    search: value.search?.trim() || '',
    direction: value.direction?.trim() || '',
    level: value.level?.trim() || '',
    source: value.source?.trim() || '',
    from: value.from ?? null,
    to: value.to ?? null,
    page,
    pageSize,
  };
}

function frameFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    sessionId: row.session_id,
    peerId: row.peer_id,
    direction: row.direction,
    format: row.format,
    framing: row.framing,
    payloadBase64: Buffer.from(row.payload).toString('base64'),
    byteCount: Number(row.byte_count),
    createdAt: Number(row.created_at),
  };
}

function logFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    sessionId: row.session_id,
    peerId: row.peer_id,
    level: row.level,
    source: row.source,
    code: row.code,
    message: row.message,
    details: row.details_json === null ? null : JSON.parse(row.details_json),
    createdAt: Number(row.created_at),
  };
}

function snapshotHistoryBatch(rows, kind, normalizeRow) {
  const label = `${kind} batch`;
  if (!Array.isArray(rows) || isProxy(rows) || Object.getPrototypeOf(rows) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const keys = Reflect.ownKeys(rows).filter((key) => key !== 'length');
  if (keys.length !== rows.length || keys.some((key, index) => key !== String(index))) {
    throw new TypeError(`${label} must be dense and contain no extra properties`);
  }

  return keys.map((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(rows, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}[${index}] must be an enumerable data value`);
    }
    return normalizeRow(descriptor.value, `${kind} row`);
  });
}

function writeHistoryBatch(connection, values, statement, parametersFor) {
  if (values.length === 0) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    for (const value of values) statement.run(...parametersFor(value));
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

function frameForWrite(row, label) {
  const value = snapshotRecord(row, {
    label,
    requiredKeys: [
      'endpointId', 'sessionId', 'peerId', 'direction', 'format', 'framing',
      'payload', 'byteCount', 'createdAt',
    ],
  });
  requireNonblankString(value.endpointId, `${label}.endpointId`);
  requireNonblankString(value.sessionId, `${label}.sessionId`);
  requireNullableNonblankString(value.peerId, `${label}.peerId`);
  if (!FRAME_DIRECTIONS.has(value.direction)) {
    throw new TypeError(`${label}.direction must be in or out`);
  }
  requireNonblankString(value.format, `${label}.format`);
  requireNonblankString(value.framing, `${label}.framing`);
  if (!(value.payload instanceof Uint8Array)) {
    throw new TypeError(`${label}.payload must be a Uint8Array`);
  }
  if (!Number.isSafeInteger(value.byteCount) || value.byteCount < 0
    || Object.is(value.byteCount, -0)) {
    throw new TypeError(`${label}.byteCount must be a nonnegative safe integer`);
  }
  const payload = Buffer.from(value.payload);
  if (payload.byteLength !== value.byteCount) {
    throw new TypeError(`${label}.payload length must equal byteCount`);
  }
  return {
    endpointId: value.endpointId,
    sessionId: value.sessionId,
    peerId: value.peerId,
    direction: value.direction,
    format: value.format,
    framing: value.framing,
    payload,
    byteCount: value.byteCount,
    createdAt: runtimeHistoryTimestamp(value.createdAt, `${label}.createdAt`),
  };
}

function logForWrite(row, label) {
  const value = snapshotRecord(row, {
    label,
    requiredKeys: [
      'endpointId', 'sessionId', 'peerId', 'level', 'source', 'code', 'message',
      'details', 'createdAt',
    ],
  });
  requireNonblankString(value.endpointId, `${label}.endpointId`);
  requireNullableNonblankString(value.sessionId, `${label}.sessionId`);
  requireNullableNonblankString(value.peerId, `${label}.peerId`);
  if (!LOG_LEVELS.has(value.level)) {
    throw new TypeError(`${label}.level must be debug, info, warn, or error`);
  }
  requireNonblankString(value.source, `${label}.source`);
  requireNullableNonblankString(value.code, `${label}.code`);
  requireNonblankString(value.message, `${label}.message`);
  return {
    endpointId: value.endpointId,
    sessionId: value.sessionId,
    peerId: value.peerId,
    level: value.level,
    source: value.source,
    code: value.code,
    message: value.message,
    detailsJson: snapshotDetailsJson(value.details, `${label}.details`),
    createdAt: runtimeHistoryTimestamp(value.createdAt, `${label}.createdAt`),
  };
}

function snapshotDetailsJson(value, label) {
  if (value === null) return null;
  if (typeof value !== 'object' || isProxy(value)) {
    throw new TypeError(`${label} must be a plain JSON object, array, or null`);
  }
  const prototype = Object.getPrototypeOf(value);
  if ((Array.isArray(value) && prototype !== Array.prototype)
    || (!Array.isArray(value) && prototype !== Object.prototype)) {
    throw new TypeError(`${label} must be a plain JSON object, array, or null`);
  }
  try {
    assertJsonValue(value, new Set(), label);
    assertJsonSafeIntegers(value, label);
  } catch (error) {
    throw new TypeError(`${label} must be plain JSON data: ${error.message}`, { cause: error });
  }
  return JSON.stringify(value);
}

module.exports = { queryHistory, snapshotHistoryBatch, writeHistoryBatch, frameForWrite, logForWrite };
