// Modbus point identities, series aggregation, and row/query conversion.
const {
  snapshotJsonValue,
  snapshotRecord,
  integerTimestamp,
  requireNonblankString,
  requireBoundedId,
  requireNullableString,
} = require('./validation.cjs');
const { types: { isProxy } } = require('node:util');

const MODBUS_POINT_DATA_TYPES = new Set([
  'boolean', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
  'float32', 'float64', 'string',
]);

const MODBUS_POINT_QUALITIES = new Set([
  'good', 'uncertain-overflow', 'bad-value', 'bad-communication', 'disabled',
]);

const MODBUS_POINT_QUALITY_RANK = Object.freeze({
  good: 0, disabled: 1, 'uncertain-overflow': 2, 'bad-value': 3, 'bad-communication': 4,
});

function modbusPointHistoryForWrite(row, label) {
  const value = snapshotRecord(row, {
    label,
    requiredKeys: [
      'endpointId', 'requestGroupId', 'requestId', 'pointId', 'pointKey', 'pointName',
      'dataType', 'unit', 'raw', 'value', 'numericValue', 'displayValue', 'quality',
      'reason', 'createdAt',
    ],
  });
  for (const key of ['endpointId', 'requestGroupId', 'requestId', 'pointId', 'pointKey']) {
    requireBoundedId(value[key], `${label}.${key}`);
  }
  requireNonblankString(value.pointName, `${label}.pointName`);
  if (!MODBUS_POINT_DATA_TYPES.has(value.dataType)) {
    throw new TypeError(`${label}.dataType is invalid`);
  }
  requireNullableString(value.unit, `${label}.unit`);
  if (!Array.isArray(value.raw)) throw new TypeError(`${label}.raw must be an array`);
  const rawJson = snapshotJsonValue(value.raw, `${label}.raw`);
  const valueJson = snapshotJsonValue(value.value, `${label}.value`);
  if (value.numericValue !== null
    && (typeof value.numericValue !== 'number' || !Number.isFinite(value.numericValue))) {
    throw new TypeError(`${label}.numericValue must be a finite number or null`);
  }
  requireNonblankString(value.displayValue, `${label}.displayValue`);
  if (!MODBUS_POINT_QUALITIES.has(value.quality)) {
    throw new TypeError(`${label}.quality is invalid`);
  }
  requireNullableString(value.reason, `${label}.reason`);
  return {
    endpointId: value.endpointId,
    requestGroupId: value.requestGroupId,
    requestId: value.requestId,
    pointId: value.pointId,
    pointKey: value.pointKey,
    pointName: value.pointName,
    dataType: value.dataType,
    unit: value.unit,
    rawJson,
    valueJson,
    numericValue: value.numericValue === null || !Object.is(value.numericValue, -0)
      ? value.numericValue
      : 0,
    displayValue: value.displayValue,
    quality: value.quality,
    reason: value.reason,
    createdAt: integerTimestamp(value.createdAt, undefined, `${label}.createdAt`),
  };
}

function normalizeModbusPointHistoryQuery(value, { page }) {
  const query = snapshotRecord(value, {
    label: 'Modbus point history query',
    requiredKeys: ['endpointId'],
    optionalKeys: ['points', 'from', 'to', 'page', 'pageSize'],
  });
  requireBoundedId(query.endpointId, 'query.endpointId');
  const from = query.from === undefined ? 0 : integerTimestamp(query.from, undefined, 'query.from');
  const to = query.to === undefined
    ? Number.MAX_SAFE_INTEGER
    : integerTimestamp(query.to, undefined, 'query.to');
  if (from > to) throw new TypeError('query.from must be less than or equal to query.to');
  const result = {
    endpointId: query.endpointId,
    points: normalizeModbusPointIdentities(query.points, { required: false }),
    from,
    to,
  };
  if (page) {
    result.page = boundedInteger(query.page, 1, 1, Number.MAX_SAFE_INTEGER, 'query.page');
    result.pageSize = boundedInteger(query.pageSize, 50, 1, 200, 'query.pageSize');
  }
  return result;
}

function normalizeModbusPointSeriesQuery(value) {
  const query = snapshotRecord(value, {
    label: 'Modbus point series query',
    requiredKeys: ['endpointId', 'points', 'from', 'to', 'bucketCount'],
  });
  const normalized = normalizeModbusPointHistoryQuery({
    endpointId: query.endpointId,
    points: query.points,
    from: query.from,
    to: query.to,
  }, { page: false });
  normalized.points = normalizeModbusPointIdentities(query.points, { required: true });
  normalized.bucketCount = boundedInteger(
    query.bucketCount,
    undefined,
    1,
    2_000,
    'query.bucketCount',
  );
  return normalized;
}

function normalizeModbusPointIdentities(value, { required }) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('query.points must be an array');
  }
  const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new TypeError('query.points must be dense and contain no extra properties');
  }
  if ((required && value.length === 0) || value.length > 6) {
    throw new TypeError('query.points must contain one to six point identities');
  }
  const seen = new Set();
  return keys.map((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`query.points[${index}] must be an enumerable data value`);
    }
    const point = snapshotRecord(descriptor.value, {
      label: `query.points[${index}]`,
      requiredKeys: ['requestGroupId', 'requestId', 'pointId'],
    });
    for (const field of ['requestGroupId', 'requestId', 'pointId']) {
      requireBoundedId(point[field], `query.points[${index}].${field}`);
    }
    const identity = {
      requestGroupId: point.requestGroupId,
      requestId: point.requestId,
      pointId: point.pointId,
    };
    const identityKey = JSON.stringify(identity);
    if (seen.has(identityKey)) throw new TypeError('query.points contains duplicate identities');
    seen.add(identityKey);
    return identity;
  });
}

function modbusPointHistorySelection(query) {
  const conditions = ['endpoint_id = ?', 'created_at >= ?', 'created_at <= ?'];
  const parameters = [query.endpointId, query.from, query.to];
  if (query.points.length > 0) {
    conditions.push(`(${query.points.map(() => (
      '(request_group_id = ? AND request_id = ? AND point_id = ?)'
    )).join(' OR ')})`);
    for (const point of query.points) {
      parameters.push(point.requestGroupId, point.requestId, point.pointId);
    }
  }
  return { where: conditions.join(' AND '), parameters };
}

function foldModbusPointSeries(rows, query) {
  let latest = null;
  let previousGoodValue;
  let minimum = null;
  let maximum = null;
  let changeCount = 0;
  let abnormalCount = 0;
  const numericBuckets = new Map();
  const events = [];
  let previousEventSignature;
  const span = Math.max(1, query.to - query.from + 1);

  for (const rawRow of rows) {
    const row = modbusPointHistoryFromRow(rawRow);
    latest = row;
    if (row.quality === 'good') {
      const signature = JSON.stringify(row.value);
      if (previousGoodValue !== undefined && previousGoodValue !== signature) changeCount += 1;
      previousGoodValue = signature;
    } else {
      abnormalCount += 1;
    }
    if (row.numericValue !== null) {
      minimum = minimum === null ? row.numericValue : Math.min(minimum, row.numericValue);
      maximum = maximum === null ? row.numericValue : Math.max(maximum, row.numericValue);
    }

    if (row.dataType !== 'boolean' && row.dataType !== 'string') {
      const bucketNumber = Math.min(
        query.bucketCount - 1,
        Math.floor(((row.createdAt - query.from) * query.bucketCount) / span),
      );
      const bucket = numericBuckets.get(bucketNumber) ?? {
        bucket: bucketNumber,
        firstAt: null,
        firstValue: null,
        lastAt: null,
        lastValue: null,
        minAt: null,
        minValue: null,
        maxAt: null,
        maxValue: null,
        goodCount: 0,
        abnormalCount: 0,
        worstQuality: 'good',
        marker: null,
      };
      if (row.quality === 'good') bucket.goodCount += 1;
      else bucket.abnormalCount += 1;
      if (MODBUS_POINT_QUALITY_RANK[row.quality] > MODBUS_POINT_QUALITY_RANK[bucket.worstQuality]) {
        bucket.worstQuality = row.quality;
      }
      if (row.quality !== 'good'
        && (bucket.marker === null
          || MODBUS_POINT_QUALITY_RANK[row.quality]
            > MODBUS_POINT_QUALITY_RANK[bucket.marker.quality])) {
        bucket.marker = { createdAt: row.createdAt, quality: row.quality, reason: row.reason };
      }
      if (row.numericValue !== null) {
        if (bucket.firstAt === null) {
          bucket.firstAt = row.createdAt;
          bucket.firstValue = row.numericValue;
        }
        bucket.lastAt = row.createdAt;
        bucket.lastValue = row.numericValue;
        if (bucket.minValue === null || row.numericValue < bucket.minValue) {
          bucket.minAt = row.createdAt;
          bucket.minValue = row.numericValue;
        }
        if (bucket.maxValue === null || row.numericValue > bucket.maxValue) {
          bucket.maxAt = row.createdAt;
          bucket.maxValue = row.numericValue;
        }
      }
      numericBuckets.set(bucketNumber, bucket);
    } else {
      const signature = JSON.stringify([row.value, row.quality, row.reason]);
      if (signature !== previousEventSignature) {
        events.push({
          createdAt: row.createdAt,
          value: row.value,
          displayValue: row.displayValue,
          quality: row.quality,
          reason: row.reason,
        });
        previousEventSignature = signature;
      }
    }
  }

  if (latest === null) return null;
  const kind = latest.dataType === 'boolean'
    ? 'boolean'
    : latest.dataType === 'string' ? 'string' : 'numeric';
  return {
    requestGroupId: latest.requestGroupId,
    requestId: latest.requestId,
    pointId: latest.pointId,
    pointKey: latest.pointKey,
    pointName: latest.pointName,
    dataType: latest.dataType,
    unit: latest.unit,
    kind,
    samples: kind === 'numeric'
      ? [...numericBuckets.values()]
      : compactSeriesEvents(events, (query.bucketCount * 2) + 2),
    summary: {
      lastValue: latest.value,
      lastDisplayValue: latest.displayValue,
      lastCreatedAt: latest.createdAt,
      minimum,
      maximum,
      changeCount,
      abnormalCount,
      latestQuality: latest.quality,
    },
  };
}

function compactSeriesEvents(events, limit) {
  if (events.length <= limit) return events;
  const result = [events[0]];
  const interiorCount = limit - 2;
  for (let index = 1; index <= interiorCount; index += 1) {
    result.push(events[Math.floor((index * (events.length - 1)) / (interiorCount + 1))]);
  }
  result.push(events.at(-1));
  return result;
}

function modbusPointHistoryFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    requestGroupId: row.request_group_id,
    requestId: row.request_id,
    pointId: row.point_id,
    pointKey: row.point_key,
    pointName: row.point_name,
    dataType: row.data_type,
    unit: row.unit,
    raw: JSON.parse(row.raw_json),
    value: JSON.parse(row.value_json),
    numericValue: row.numeric_value === null ? null : Number(row.numeric_value),
    displayValue: row.display_value,
    quality: row.quality,
    reason: row.reason,
    createdAt: Number(row.created_at),
  };
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new TypeError(`${label} must be an integer`);
  }
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer`);
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = {
  modbusPointHistoryForWrite,
  normalizeModbusPointHistoryQuery,
  normalizeModbusPointSeriesQuery,
  modbusPointHistorySelection,
  foldModbusPointSeries,
  modbusPointHistoryFromRow,
};
