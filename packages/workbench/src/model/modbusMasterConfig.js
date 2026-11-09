export const MODBUS_MASTER_POINT_TYPES = Object.freeze([
  'boolean', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
  'float32', 'float64', 'string',
]);

const READ_FUNCTIONS = new Set([1, 2, 3, 4]);
const BIT_FUNCTIONS = new Set([1, 2]);
const EXACT_INTEGER_TYPES = new Set(['uint64', 'int64']);
const FIXED_LENGTHS = Object.freeze({
  boolean: 1, uint16: 1, int16: 1, uint32: 2, int32: 2,
  uint64: 4, int64: 4, float32: 2, float64: 4,
});

export function modbusMasterPointLength(type, requestedLength = 1) {
  if (Object.hasOwn(FIXED_LENGTHS, type)) return FIXED_LENGTHS[type];
  const value = Number(requestedLength);
  return Number.isInteger(value) && value >= 1 && value <= 125 ? value : 1;
}

export function normalizeModbusMasterConfig(config = {}) {
  const source = isPlainObject(config) ? config : {};
  const scheduler = isPlainObject(source.scheduler) ? source.scheduler : {};
  return {
    ...source,
    configVersion: 3,
    description: text(source.description),
    enabled: source.enabled !== false,
    unitId: integer(source.unitId, 1),
    timeoutMs: integer(source.timeoutMs, 1000),
    retryCount: integer(source.retryCount, 0),
    retryIntervalMs: integer(source.retryIntervalMs, 200),
    autoReconnect: source.autoReconnect === true,
    scheduler: {
      minGapMs: integer(scheduler.minGapMs, 50),
      autoStart: scheduler.autoStart === true,
    },
    requestGroups: normalizeOrdered(source.requestGroups, normalizeGroup),
    writeCommands: normalizeModbusWriteCommands(source.writeCommands),
  };
}

export function normalizeModbusRequestGroup(group, index = 0) {
  return normalizeGroup(group, index);
}

export function normalizeModbusRequest(request, index = 0) {
  return normalizeRequest(request, index);
}

export function validateModbusMasterSettings(config) {
  const source = isPlainObject(config) ? config : {};
  const normalized = normalizeModbusMasterConfig(source);
  const errors = {};
  if (typeof source.enabled !== 'undefined' && typeof source.enabled !== 'boolean') {
    errors.enabled = '主站启用状态必须为布尔值。';
  }
  if (!Number.isInteger(normalized.retryCount) || normalized.retryCount < 0 || normalized.retryCount > 10) {
    errors.retryCount = '失败重试次数必须为 0 到 10 的整数。';
  }
  if (!boundedInteger(normalized.retryIntervalMs, 0, 60_000)) {
    errors.retryIntervalMs = '重试间隔必须为 0 到 60000 毫秒。';
  }
  if (!boundedInteger(normalized.scheduler.minGapMs, 0, 60_000)) {
    errors.schedulerMinGapMs = '最小请求间隔必须为 0 到 60000 毫秒。';
  }
  if (typeof source.autoReconnect !== 'undefined' && typeof source.autoReconnect !== 'boolean') {
    errors.autoReconnect = '自动重连必须为布尔值。';
  }
  return {
    ...errors,
    ...validateModbusRequestGroups(source.requestGroups, normalized),
    ...validateModbusWriteCommands(source.writeCommands),
  };
}

export function validateModbusRequestGroups(groups) {
  if (groups === undefined) return {};
  if (!Array.isArray(groups)) return { requestGroups: '请求组配置格式无效。' };
  const errors = {};
  const groupIds = new Set();
  groups.forEach((source, groupIndex) => {
    const prefix = `requestGroup-${groupIndex}`;
    if (!isPlainObject(source)) {
      errors[`${prefix}-row`] = '请求组配置格式无效。';
      return;
    }
    const group = normalizeGroup(source, groupIndex);
    group.unitId = draftNumber(source.unitId, group.unitId);
    if (!group.name) errors[`${prefix}-name`] = '请输入请求组名称。';
    if (groupIds.has(group.id)) errors[`${prefix}-id`] = '请求组标识必须唯一。';
    groupIds.add(group.id);
    if (!boundedInteger(group.unitId, 1, 247)) {
      errors[`${prefix}-unitId`] = '从站 ID 必须为 1 到 247 的整数。';
    }
    if (source.requests !== undefined && !Array.isArray(source.requests)) {
      errors[`${prefix}-requests`] = '请求配置格式无效。';
      return;
    }
    const requestIds = new Set();
    const pointIds = new Set();
    const pointKeys = new Set();
    // Validate in source order while the explicit drafts are still available.
    // Legacy V2 groups carry their single request directly on the group.
    const requestSources = Array.isArray(source.requests) ? source.requests
      : hasLegacyRequestFields(source) ? [source] : [];
    requestSources.forEach((requestSource, requestIndex) => {
      const raw = isPlainObject(requestSource) ? requestSource : {};
      const request = normalizeRequest(raw, requestIndex);
      for (const field of ['functionCode', 'startAddress', 'quantity', 'intervalMs']) {
        request[field] = draftNumber(raw[field], request[field]);
      }
      const requestPrefix = `${prefix}-request-${requestIndex}`;
      if (!request.name) errors[`${requestPrefix}-name`] = '请输入请求名称。';
      if (requestIds.has(request.id)) {
        errors[`${requestPrefix}-id`] = '请求标识在请求组内必须唯一。';
      }
      requestIds.add(request.id);
      if (!READ_FUNCTIONS.has(request.functionCode)) {
        errors[`${requestPrefix}-functionCode`] = '请求仅支持 FC01、FC02、FC03 或 FC04。';
      }
      if (!boundedInteger(request.startAddress, 0, 65_535)) {
        errors[`${requestPrefix}-startAddress`] = '起始地址必须为 0 到 65535 的整数。';
      }
      const maximum = BIT_FUNCTIONS.has(request.functionCode) ? 2000 : 125;
      if (!boundedInteger(request.quantity, 1, maximum)
        || request.startAddress + request.quantity > 65_536) {
        const unit = BIT_FUNCTIONS.has(request.functionCode) ? '位' : '寄存器';
        errors[`${requestPrefix}-quantity`] = `FC${String(request.functionCode).padStart(2, '0')} 单次最多读取 ${maximum} 个${unit}，且地址不能超过 65535。`;
      }
      if (!boundedInteger(request.intervalMs, 100, 3_600_000)) {
        errors[`${requestPrefix}-intervalMs`] = '轮询周期必须为 100 到 3600000 毫秒。';
      }
      validateNullableOverride(request.timeoutMs, 50, 60_000, `${requestPrefix}-timeoutMs`, '超时时间', errors);
      validateNullableOverride(request.retryCount, 0, 10, `${requestPrefix}-retryCount`, '失败重试次数', errors);
      validateNullableOverride(request.retryIntervalMs, 0, 60_000, `${requestPrefix}-retryIntervalMs`, '重试间隔', errors);
      validatePoints(request.dataPoints, request, requestPrefix, errors, pointIds, pointKeys);
    });
  });
  return errors;
}

export function cloneModbusRequestGroup(group, createId = defaultId) {
  const source = normalizeGroup(group, 0);
  const pointKeys = new Set();
  return {
    ...source,
    id: createId('group', 0),
    name: `${source.name}副本`,
    requests: source.requests.map((request) => cloneRequest(request, createId, false, pointKeys)),
  };
}

export function cloneModbusRequest(request, createId = defaultId, existingPointKeys = []) {
  return cloneRequest(normalizeRequest(request, 0), createId, true, existingPointKeys);
}

function normalizeGroup(source, index) {
  const group = isPlainObject(source) ? source : {};
  const id = nonblank(group.id, `group-${index + 1}`);
  const name = text(group.name);
  const legacyRequest = hasLegacyRequestFields(group)
    ? [{
      id: `${id}-request`,
      name: `${name || `请求组 ${index + 1}`}请求`,
      enabled: true,
      order: 0,
      functionCode: group.functionCode,
      startAddress: group.startAddress,
      quantity: group.quantity,
      intervalMs: group.intervalMs,
      timeoutMs: group.timeoutMs,
      retryCount: group.retryCount,
      retryIntervalMs: group.retryIntervalMs,
      dataPoints: group.dataPoints,
    }]
    : [];
  return {
    ...withoutLegacyRequestFields(group),
    id,
    name,
    description: text(group.description),
    enabled: group.enabled !== false,
    order: integer(group.order, index),
    unitId: integer(group.unitId, 1),
    requests: normalizeOrdered(Array.isArray(group.requests) ? group.requests : legacyRequest, normalizeRequest),
  };
}

function normalizeRequest(source, index) {
  const request = isPlainObject(source) ? source : {};
  return {
    ...request,
    id: nonblank(request.id, `request-${index + 1}`),
    name: text(request.name),
    enabled: request.enabled !== false,
    order: integer(request.order, index),
    functionCode: integer(request.functionCode, 3),
    startAddress: integer(request.startAddress, 0),
    quantity: integer(request.quantity, 10),
    intervalMs: integer(request.intervalMs, 1000),
    timeoutMs: nullableInteger(request.timeoutMs),
    retryCount: nullableInteger(request.retryCount),
    retryIntervalMs: nullableInteger(request.retryIntervalMs),
    dataPoints: Array.isArray(request.dataPoints)
      ? request.dataPoints.map(normalizePoint)
      : [],
  };
}

function normalizePoint(source, index) {
  const point = isPlainObject(source) ? source : {};
  const dataType = typeof point.dataType === 'string' ? point.dataType : 'uint16';
  return {
    id: nonblank(point.id, `point-${index + 1}`),
    key: nonblank(point.key, `point_${index + 1}`),
    name: text(point.name),
    enabled: point.enabled !== false,
    offset: integer(point.offset, 0),
    dataType,
    length: modbusMasterPointLength(dataType, point.length),
    byteOrder: point.byteOrder ?? 'big-endian',
    wordOrder: point.wordOrder ?? 'high-first',
    bitIndex: point.bitIndex === null || point.bitIndex === undefined
      ? null : integer(point.bitIndex, -1),
    scale: finite(point.scale, 1),
    valueOffset: finite(point.valueOffset, 0),
    unit: text(point.unit),
    decimals: point.decimals === null || point.decimals === undefined
      ? null : integer(point.decimals, -1),
    minimum: normalizePointBound(point.minimum, dataType),
    maximum: normalizePointBound(point.maximum, dataType),
    invalidPolicy: point.invalidPolicy === 'keep-last-good' ? 'keep-last-good' : 'mark-bad',
    saveHistory: point.saveHistory === true,
    historyMode: point.historyMode === 'every-poll' ? 'every-poll' : 'on-change',
  };
}

function validatePoints(points, request, prefix, errors, ids, keys) {
  if (points === undefined) return;
  if (!Array.isArray(points)) {
    errors[`${prefix}-dataPoints`] = '数据点配置格式无效。';
    return;
  }
  const occupied = [];
  points.forEach((source, pointIndex) => {
    const pointPrefix = `${prefix}-point-${pointIndex}`;
    if (!isPlainObject(source)) {
      errors[`${pointPrefix}-row`] = '数据点配置格式无效。';
      return;
    }
    const point = normalizePoint(source, pointIndex);
    if (!point.name) errors[`${pointPrefix}-name`] = '请输入数据点名称。';
    if (ids.has(point.id)) errors[`${pointPrefix}-id`] = '数据点标识在请求组内必须唯一。';
    if (keys.has(point.key)) errors[`${pointPrefix}-key`] = '数据点标识在请求组内必须唯一。';
    ids.add(point.id);
    keys.add(point.key);
    if (!MODBUS_MASTER_POINT_TYPES.includes(point.dataType)) {
      errors[`${pointPrefix}-dataType`] = '请选择支持的数据类型。';
      return;
    }
    const bitFunction = BIT_FUNCTIONS.has(request.functionCode);
    if (bitFunction && point.dataType !== 'boolean') {
      errors[`${pointPrefix}-dataType`] = '线圈和离散输入只能解析为 Bool。';
    }
    if (!bitFunction && point.dataType === 'boolean'
      && !boundedInteger(point.bitIndex, 0, 15)) {
      errors[`${pointPrefix}-bitIndex`] = '寄存器 Bool 数据点必须选择 0 到 15 的位索引。';
    }
    if (bitFunction && point.bitIndex !== null) {
      errors[`${pointPrefix}-bitIndex`] = '线圈和离散输入不使用寄存器位索引。';
    }
    const width = bitFunction ? 1 : point.length;
    if (point.enabled && (!boundedInteger(point.offset, 0, Math.max(0, request.quantity - 1))
      || point.offset + width > request.quantity)) {
      errors[`${pointPrefix}-offset`] = '数据点超出请求响应范围。';
    }
    if (source.dataType === 'string'
      && (!Number.isInteger(Number(source.length)) || point.length < 1 || point.length > 125)) {
      errors[`${pointPrefix}-length`] = '字符串长度必须为 1 到 125 个寄存器。';
    }
    if (!['big-endian', 'little-endian'].includes(point.byteOrder)) {
      errors[`${pointPrefix}-byteOrder`] = '请选择有效的字节序。';
    }
    if (!['high-first', 'low-first'].includes(point.wordOrder)) {
      errors[`${pointPrefix}-wordOrder`] = '请选择有效的字序。';
    }
    if (!Number.isFinite(Number(source.scale ?? 1)) || point.scale === 0) {
      errors[`${pointPrefix}-scale`] = '倍率必须是非零数字。';
    }
    if (point.decimals !== null && !boundedInteger(point.decimals, 0, 12)) {
      errors[`${pointPrefix}-decimals`] = '小数位数必须为 0 到 12。';
    }
    if (point.minimum !== null && !validPointBound(point.minimum)) {
      errors[`${pointPrefix}-minimum`] = '合理值下限必须是有效数字。';
    }
    if (point.maximum !== null && !validPointBound(point.maximum)) {
      errors[`${pointPrefix}-maximum`] = '合理值上限必须是有效数字。';
    }
    if (point.minimum !== null && point.maximum !== null
      && validPointBound(point.minimum) && validPointBound(point.maximum)
      && comparePointBounds(point.minimum, point.maximum) > 0) {
      errors[`${pointPrefix}-minimum`] = '合理值下限不能大于上限。';
    }
    if (point.enabled) {
      const range = { start: point.offset, end: point.offset + width, point };
      const conflict = occupied.find((candidate) => rangesOverlap(range, candidate)
        && !distinctBitViews(range.point, candidate.point));
      if (conflict) errors[`${pointPrefix}-offset`] = '数据点范围与同一请求的其他数据点重叠。';
      occupied.push(range);
    }
  });
}

function cloneRequest(request, createId, rename, existingPointKeys = []) {
  const pointKeys = existingPointKeys instanceof Set
    ? existingPointKeys
    : new Set(existingPointKeys);
  return {
    ...request,
    id: createId('request', request.order),
    name: rename ? `${request.name}副本` : request.name,
    dataPoints: request.dataPoints.map((point, index) => {
      const key = nextCloneKey(point.key, pointKeys);
      pointKeys.add(key);
      return { ...point, id: createId('point', index), key };
    }),
  };
}

function nextCloneKey(source, existing) {
  const base = `${source}_copy`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function normalizeOrdered(values, normalize) {
  if (!Array.isArray(values)) return [];
  return values
    .map(normalize)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((value, order) => ({ ...value, order }));
}

function hasLegacyRequestFields(group) {
  return ['functionCode', 'startAddress', 'quantity', 'intervalMs', 'dataPoints']
    .some((key) => Object.hasOwn(group, key));
}

function withoutLegacyRequestFields(group) {
  const result = { ...group };
  for (const key of [
    'functionCode', 'startAddress', 'quantity', 'intervalMs',
    'timeoutMs', 'retryCount', 'retryIntervalMs', 'dataPoints',
  ]) delete result[key];
  return result;
}

function rangesOverlap(left, right) {
  return left.start < right.end && left.end > right.start;
}

function distinctBitViews(left, right) {
  return left.dataType === 'boolean' && right.dataType === 'boolean'
    && left.offset === right.offset && left.bitIndex !== null && right.bitIndex !== null
    && left.bitIndex !== right.bitIndex;
}

function validateNullableOverride(value, minimum, maximum, key, label, errors) {
  if (value === null || value === undefined) return;
  if (!boundedInteger(Number(value), minimum, maximum)) {
    errors[key] = `${label}必须为 ${minimum} 到 ${maximum} 的整数，或使用主站默认值。`;
  }
}

function defaultId(kind, index) {
  return `${kind}-${Date.now()}-${index + 1}`;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonblank(value, fallback) {
  return text(value) || fallback;
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function draftNumber(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return NaN;
}

function nullableInteger(value) {
  return value === null || value === undefined || value === '' ? null : integer(value, -1);
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableFinite(value) {
  return value === null || value === undefined || value === '' ? null : finite(value, Number.NaN);
}

function normalizePointBound(value, dataType) {
  if (value === null || value === undefined || value === '') return null;
  if (!EXACT_INTEGER_TYPES.has(dataType)) return nullableFinite(value);
  if (typeof value === 'string') {
    const source = value.trim();
    if (source === '') return null;
    return parseDecimalFraction(source) ? source : Number.NaN;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return Number.NaN;
  return Number.isInteger(number) && !Number.isSafeInteger(number)
    ? BigInt(number).toString()
    : number;
}

function validPointBound(value) {
  return parseDecimalFraction(value) !== null;
}

function comparePointBounds(left, right) {
  return compareDecimalFractions(
    parseDecimalFraction(left),
    parseDecimalFraction(right),
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
import {
  normalizeModbusWriteCommands,
  validateModbusWriteCommands,
} from './modbusWriteCommands.js';
import { compareDecimalFractions, parseDecimalFraction } from './modbusDecimal.js';
