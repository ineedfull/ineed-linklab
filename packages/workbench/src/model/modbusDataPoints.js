export const MODBUS_POINT_TYPES = Object.freeze([
  'boolean', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'float64', 'ascii',
]);

const BIT_AREAS = new Set(['coils', 'discreteInputs']);
const REGISTER_AREAS = new Set(['holdingRegisters', 'inputRegisters']);
const FIXED_LENGTHS = Object.freeze({
  boolean: 1,
  uint16: 1,
  int16: 1,
  uint32: 2,
  int32: 2,
  float32: 2,
  float64: 4,
});

export function modbusPointLength(type, requestedLength = 1) {
  if (Object.hasOwn(FIXED_LENGTHS, type)) return FIXED_LENGTHS[type];
  const length = Number(requestedLength);
  return Number.isInteger(length) && length >= 1 && length <= 125 ? length : 1;
}

export function normalizeModbusDataPoints(points = []) {
  if (!Array.isArray(points)) return [];
  return points.map((point, index) => normalizePoint(point, index));
}

export function validateModbusDataPoints(points, dataAreas) {
  if (points === undefined) return {};
  if (!Array.isArray(points)) return { dataPoints: '业务数据点配置格式无效。' };

  const errors = {};
  const occupied = new Map();
  points.forEach((source, index) => {
    const key = (field) => `dataPoint-${index}-${field}`;
    if (!isPlainObject(source)) {
      errors[key('row')] = '业务数据点配置格式无效。';
      return;
    }
    const point = normalizePoint(source, index);
    if (!point.name) errors[key('name')] = '请输入业务名称。';
    if (!BIT_AREAS.has(point.area) && !REGISTER_AREAS.has(point.area)) {
      errors[key('area')] = '请选择有效的数据区。';
      return;
    }
    if (!MODBUS_POINT_TYPES.includes(point.dataType)) {
      errors[key('dataType')] = '请选择有效的数据类型。';
      return;
    }
    if (BIT_AREAS.has(point.area) && point.dataType !== 'boolean') {
      errors[key('dataType')] = '线圈和离散输入只能使用布尔类型。';
    }
    if (REGISTER_AREAS.has(point.area) && point.dataType === 'boolean') {
      errors[key('dataType')] = '寄存器不能使用布尔类型。';
    }
    if (!Number.isInteger(Number(source.address)) || point.address < 0 || point.address > 65_535) {
      errors[key('address')] = '地址必须为 0 到 65535 的整数。';
    }
    if (source.dataType === 'ascii'
      && (!Number.isInteger(Number(source.length)) || point.length < 1 || point.length > 125)) {
      errors[key('length')] = '字符串长度必须为 1 到 125 个寄存器。';
    }
    if (point.address + point.length > 65_536) {
      errors[key('length')] = '数据点地址范围不能超过 65535。';
    }
    if (!['big-endian', 'little-endian'].includes(point.byteOrder)) {
      errors[key('byteOrder')] = '请选择有效的字节序。';
    }
    if (!['high-first', 'low-first'].includes(point.wordOrder)) {
      errors[key('wordOrder')] = '请选择有效的字序。';
    }
    if (Object.hasOwn(source, 'scale') && (!Number.isFinite(Number(source.scale)) || point.scale === 0)) {
      errors[key('scale')] = '缩放系数必须是非零数字。';
    }
    if (Object.hasOwn(source, 'offset') && !Number.isFinite(Number(source.offset))) {
      errors[key('offset')] = '偏移量必须是数字。';
    }
    if (Object.hasOwn(source, 'access') && !['read-only', 'read-write'].includes(source.access)) {
      errors[key('access')] = '请选择有效的读写属性。';
    }

    const area = dataAreas?.[point.area];
    if (area && (point.address < area.start || point.address + point.length > area.start + area.count)) {
      errors[key('address')] = '数据点必须位于已配置的数据区范围内。';
    }
    const ranges = occupied.get(point.area) ?? [];
    if (ranges.some(({ start, end }) => point.address < end && point.address + point.length > start)) {
      errors[key('address')] = '该地址范围与同一数据区的其他业务点重叠。';
    }
    ranges.push({ start: point.address, end: point.address + point.length });
    occupied.set(point.area, ranges);
  });
  return errors;
}

export function readModbusDataPoint(pointSource, dataMap) {
  const point = normalizePoint(pointSource, 0);
  const area = dataMap?.areas?.[point.area];
  const offset = point.address - Number(area?.start ?? 0);
  if (!area || offset < 0 || offset + point.length > area.values.length) {
    return { available: false, raw: [], value: null };
  }
  const raw = area.values.slice(offset, offset + point.length);
  if (point.dataType === 'boolean') {
    return { available: true, raw, value: Boolean(raw[0]) };
  }
  if (point.dataType === 'ascii') {
    return { available: true, raw, value: decodeAscii(raw, point.byteOrder, point.wordOrder) };
  }
  const bytes = wordsToBytes(raw, point.byteOrder, point.wordOrder);
  const view = new DataView(bytes.buffer);
  const decoded = {
    uint16: () => view.getUint16(0, false),
    int16: () => view.getInt16(0, false),
    uint32: () => view.getUint32(0, false),
    int32: () => view.getInt32(0, false),
    float32: () => view.getFloat32(0, false),
    float64: () => view.getFloat64(0, false),
  }[point.dataType]?.();
  return {
    available: true,
    raw,
    value: Number.isFinite(decoded) ? decoded * point.scale + point.offset : decoded,
  };
}

export function writeModbusDataPoint(pointSource, businessValue) {
  const point = normalizePoint(pointSource, 0);
  if (point.dataType === 'boolean') return [Boolean(businessValue)];
  if (point.dataType === 'ascii') {
    return encodeAscii(String(businessValue), point.length, point.byteOrder, point.wordOrder);
  }
  const numeric = Number(businessValue);
  if (!Number.isFinite(numeric)) throw new TypeError('业务值必须是有效数字。');
  const rawValue = (numeric - point.offset) / point.scale;
  const buffer = new ArrayBuffer(point.length * 2);
  const view = new DataView(buffer);
  const writer = {
    uint16: () => view.setUint16(0, requireInteger(rawValue, 0, 0xffff), false),
    int16: () => view.setInt16(0, requireInteger(rawValue, -0x8000, 0x7fff), false),
    uint32: () => view.setUint32(0, requireInteger(rawValue, 0, 0xffff_ffff), false),
    int32: () => view.setInt32(0, requireInteger(rawValue, -0x8000_0000, 0x7fff_ffff), false),
    float32: () => view.setFloat32(0, rawValue, false),
    float64: () => view.setFloat64(0, rawValue, false),
  }[point.dataType];
  if (!writer) throw new TypeError('不支持的数据类型。');
  writer();
  return bytesToWords(new Uint8Array(buffer), point.byteOrder, point.wordOrder);
}

export function formatModbusBusinessValue(point, value) {
  if (value === null || value === undefined) return '不可用';
  if (point.dataType === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'number' && !Number.isInteger(value)) return String(Number(value.toPrecision(10)));
  return String(value);
}

export function modbusDataPointRawBytes(pointSource, rawValues) {
  if (!Array.isArray(rawValues) || rawValues.length === 0) return [];
  const point = normalizePoint(pointSource, 0);
  if (point.dataType === 'boolean') return [rawValues[0] ? 1 : 0];
  return [...wordsToBytes(rawValues.slice(0, point.length), point.byteOrder, point.wordOrder)];
}

function normalizePoint(source, index) {
  const point = isPlainObject(source) ? source : {};
  const dataType = typeof point.dataType === 'string' ? point.dataType : 'uint16';
  const area = typeof point.area === 'string' ? point.area : 'holdingRegisters';
  return {
    id: nonblank(point.id, `point-${index + 1}`),
    name: nonblank(point.name, ''),
    group: nonblank(point.group, '默认分组'),
    area,
    address: integer(point.address, 0),
    dataType,
    length: modbusPointLength(dataType, point.length),
    byteOrder: point.byteOrder ?? 'big-endian',
    wordOrder: point.wordOrder ?? 'high-first',
    scale: finite(point.scale, 1),
    offset: finite(point.offset, 0),
    unit: typeof point.unit === 'string' ? point.unit.trim() : '',
    access: point.access === 'read-only' ? 'read-only' : 'read-write',
  };
}

function wordsToBytes(source, byteOrder, wordOrder) {
  const words = wordOrder === 'low-first' ? [...source].reverse() : [...source];
  return Uint8Array.from(words.flatMap((word) => {
    const high = (Number(word) >> 8) & 0xff;
    const low = Number(word) & 0xff;
    return byteOrder === 'little-endian' ? [low, high] : [high, low];
  }));
}

function bytesToWords(source, byteOrder, wordOrder) {
  const words = [];
  for (let index = 0; index < source.length; index += 2) {
    const first = source[index] ?? 0;
    const second = source[index + 1] ?? 0;
    words.push(byteOrder === 'little-endian' ? (second << 8) | first : (first << 8) | second);
  }
  return wordOrder === 'low-first' ? words.reverse() : words;
}

function decodeAscii(words, byteOrder, wordOrder) {
  return String.fromCharCode(...wordsToBytes(words, byteOrder, wordOrder)).replace(/\0+$/u, '');
}

function encodeAscii(value, length, byteOrder, wordOrder) {
  const bytes = new TextEncoder().encode(value).slice(0, length * 2);
  const padded = new Uint8Array(length * 2);
  padded.set(bytes);
  return bytesToWords(padded, byteOrder, wordOrder);
}

function requireInteger(value, minimum, maximum) {
  const normalized = Math.abs(value - Math.round(value)) < Number.EPSILON * 16
    ? Math.round(value)
    : value;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`原始值必须为 ${minimum} 到 ${maximum} 的整数。`);
  }
  return normalized;
}

function nonblank(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
