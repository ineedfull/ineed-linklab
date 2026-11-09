const MAX_ID_BYTES = 128;
const MAX_BATCH_ROWS = 2_000;
const MAX_QUERY_POINTS = 6;
const MAX_PAGE_SIZE = 200;
const MAX_BUCKET_COUNT = 2_000;

const DATA_TYPES = new Set([
  'boolean', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
  'float32', 'float64', 'string',
]);
const QUALITIES = new Set([
  'good', 'uncertain-overflow', 'bad-value', 'bad-communication', 'disabled',
]);
const ROW_FIELDS = Object.freeze([
  'endpointId', 'requestGroupId', 'requestId', 'pointId', 'pointKey', 'pointName',
  'dataType', 'unit', 'raw', 'value', 'numericValue', 'displayValue', 'quality',
  'reason', 'createdAt',
]);
const POINT_IDENTITY_FIELDS = Object.freeze(['requestGroupId', 'requestId', 'pointId']);

export function normalizeModbusPointHistoryRow(value) {
  requireExactRecord(value, ROW_FIELDS, 'Modbus point history row');
  const endpointId = requireId(value.endpointId, 'row.endpointId');
  const requestGroupId = requireId(value.requestGroupId, 'row.requestGroupId');
  const requestId = requireId(value.requestId, 'row.requestId');
  const pointId = requireId(value.pointId, 'row.pointId');
  const pointKey = requireId(value.pointKey, 'row.pointKey');
  const pointName = requireText(value.pointName, 'row.pointName');
  if (!DATA_TYPES.has(value.dataType)) throw new TypeError('row.dataType is invalid');
  const unit = requireNullableText(value.unit, 'row.unit');
  const raw = cloneJsonValue(value.raw, 'row.raw');
  if (!Array.isArray(raw)) throw new TypeError('row.raw must be an array');
  const engineeringValue = cloneJsonValue(value.value, 'row.value');
  const numericValue = normalizeNumericProjection(value.numericValue);
  const displayValue = requireText(value.displayValue, 'row.displayValue');
  if (!QUALITIES.has(value.quality)) throw new TypeError('row.quality is invalid');
  const reason = requireNullableText(value.reason, 'row.reason');
  const createdAt = requireTimestamp(value.createdAt, 'row.createdAt');

  return Object.freeze({
    endpointId,
    requestGroupId,
    requestId,
    pointId,
    pointKey,
    pointName,
    dataType: value.dataType,
    unit,
    raw,
    value: engineeringValue,
    numericValue,
    displayValue,
    quality: value.quality,
    reason,
    createdAt,
  });
}

export function normalizeModbusPointHistoryRows(value) {
  const rows = readDenseArray(value, 'Modbus point history rows');
  if (rows.length > MAX_BATCH_ROWS) {
    throw new TypeError(`Modbus point history rows must contain at most ${MAX_BATCH_ROWS} rows`);
  }
  return Object.freeze(rows.map(normalizeModbusPointHistoryRow));
}

export function normalizeModbusPointHistoryQuery(value) {
  requireRecordWithAllowedFields(
    value,
    ['endpointId'],
    ['endpointId', 'points', 'from', 'to', 'page', 'pageSize'],
    'Modbus point history query',
  );
  const range = normalizeRange(value);
  return Object.freeze({
    endpointId: requireId(value.endpointId, 'query.endpointId'),
    points: normalizePointIdentities(value.points, { required: false }),
    ...range,
    page: normalizeBoundedInteger(value.page, 1, 1, Number.MAX_SAFE_INTEGER, 'query.page'),
    pageSize: normalizeBoundedInteger(value.pageSize, 50, 1, MAX_PAGE_SIZE, 'query.pageSize'),
  });
}

export function normalizeModbusPointSeriesQuery(value) {
  requireExactRecord(
    value,
    ['endpointId', 'points', 'from', 'to', 'bucketCount'],
    'Modbus point series query',
  );
  const range = normalizeRange(value);
  return Object.freeze({
    endpointId: requireId(value.endpointId, 'query.endpointId'),
    points: normalizePointIdentities(value.points, { required: true }),
    ...range,
    bucketCount: normalizeBoundedInteger(
      value.bucketCount,
      undefined,
      1,
      MAX_BUCKET_COUNT,
      'query.bucketCount',
    ),
  });
}

function normalizePointIdentities(value, { required }) {
  if (value === undefined && !required) return Object.freeze([]);
  const points = readDenseArray(value, 'query.points');
  if ((required && points.length === 0) || points.length > MAX_QUERY_POINTS) {
    throw new TypeError('query.points must contain one to six point identities');
  }
  const seen = new Set();
  const normalized = points.map((point) => {
    requireExactRecord(point, POINT_IDENTITY_FIELDS, 'point identity');
    const result = Object.freeze({
      requestGroupId: requireId(point.requestGroupId, 'point identity.requestGroupId'),
      requestId: requireId(point.requestId, 'point identity.requestId'),
      pointId: requireId(point.pointId, 'point identity.pointId'),
    });
    const key = JSON.stringify(result);
    if (seen.has(key)) throw new TypeError('query.points contains duplicate point identities');
    seen.add(key);
    return result;
  });
  return Object.freeze(normalized);
}

function normalizeRange(value) {
  const from = value.from === undefined ? 0 : requireTimestamp(value.from, 'query.from');
  const to = value.to === undefined
    ? Number.MAX_SAFE_INTEGER
    : requireTimestamp(value.to, 'query.to');
  if (from > to) throw new TypeError('query.from must be less than or equal to query.to');
  return { from, to };
}

function normalizeBoundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new TypeError(`${label} must be an integer`);
  }
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer`);
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeNumericProjection(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('row.numericValue must be a finite number or null');
  }
  return Object.is(value, -0) ? 0 : value;
}

function cloneJsonValue(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(`${label} contains a value that is not lossless JSON`);
    }
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} contains unsupported JSON data`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const source = readDenseArray(value, label);
      return Object.freeze(source.map((entry, index) => (
        cloneJsonValue(entry, `${label}[${index}]`, ancestors)
      )));
    }
    requirePlainRecord(value, label);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError(`${label} must not contain symbol properties`);
    }
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} properties must be enumerable data values`);
      }
      result[key] = cloneJsonValue(descriptor.value, `${label}.${key}`, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function requireId(value, label) {
  requireText(value, label);
  if (new globalThis.TextEncoder().encode(value).byteLength > MAX_ID_BYTES) {
    throw new TypeError(`${label} must be at most ${MAX_ID_BYTES} bytes`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a nonblank string`);
  }
  return value;
}

function requireNullableText(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string or null`);
  return value;
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function readDenseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(descriptors);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== value.length + 1) {
    throw new TypeError(`${label} must be dense without extra fields`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must contain data elements`);
    }
    return descriptor.value;
  });
}

function requireRecordWithAllowedFields(value, requiredFields, allowedFields, label) {
  requirePlainRecord(value, label);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0
    || requiredFields.some((field) => !names.includes(field))
    || names.some((field) => !allowedFields.includes(field))) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (names.some((field) => !Object.hasOwn(descriptors[field], 'value'))) {
    throw new TypeError(`${label} fields must be data properties`);
  }
}

function requireExactRecord(value, fields, label) {
  requireRecordWithAllowedFields(value, fields, fields, label);
  if (Object.getOwnPropertyNames(value).length !== fields.length) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function requirePlainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}
