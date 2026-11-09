const ORDER_DEFINITIONS = Object.freeze({
  ABCD: Object.freeze({
    byteOrder: 'big-endian', wordOrder: 'high-first', label: 'ABCD · 标准顺序',
  }),
  BADC: Object.freeze({
    byteOrder: 'little-endian', wordOrder: 'high-first', label: 'BADC · 字节交换',
  }),
  CDAB: Object.freeze({
    byteOrder: 'big-endian', wordOrder: 'low-first', label: 'CDAB · 字交换',
  }),
  DCBA: Object.freeze({
    byteOrder: 'little-endian', wordOrder: 'low-first', label: 'DCBA · 字节与字交换',
  }),
  AB: Object.freeze({
    byteOrder: 'big-endian', wordOrder: 'high-first', label: 'AB · 标准字节序',
  }),
  BA: Object.freeze({
    byteOrder: 'little-endian', wordOrder: 'high-first', label: 'BA · 字节交换',
  }),
});

const MULTI_REGISTER_OPTIONS = Object.freeze(['ABCD', 'BADC', 'CDAB', 'DCBA']);
const SINGLE_REGISTER_OPTIONS = Object.freeze(['AB', 'BA']);

export function modbusDataOrderCode(point = {}) {
  if (point.dataType === 'boolean') return '';
  const byteOrder = point.byteOrder === 'little-endian' ? 'little-endian' : 'big-endian';
  if (!isMultiRegister(point)) return byteOrder === 'little-endian' ? 'BA' : 'AB';
  const wordOrder = point.wordOrder === 'low-first' ? 'low-first' : 'high-first';
  if (byteOrder === 'little-endian') return wordOrder === 'low-first' ? 'DCBA' : 'BADC';
  return wordOrder === 'low-first' ? 'CDAB' : 'ABCD';
}

export function applyModbusDataOrder(code) {
  const order = ORDER_DEFINITIONS[code] ?? ORDER_DEFINITIONS.ABCD;
  return { byteOrder: order.byteOrder, wordOrder: order.wordOrder };
}

export function modbusDataOrderOptions(point = {}) {
  if (point.dataType === 'boolean') return [];
  const codes = isMultiRegister(point) ? MULTI_REGISTER_OPTIONS : SINGLE_REGISTER_OPTIONS;
  return codes.map((value) => ({ value, label: ORDER_DEFINITIONS[value].label }));
}

export function modbusDataOrderLabel(point = {}) {
  if (point.dataType === 'boolean') return '不适用';
  const code = modbusDataOrderCode(point);
  return ORDER_DEFINITIONS[code].label;
}

function isMultiRegister(point) {
  return Number(point.length ?? defaultLength(point.dataType)) > 1;
}

function defaultLength(dataType) {
  return {
    int32: 2,
    uint32: 2,
    float32: 2,
    int64: 4,
    uint64: 4,
    float64: 4,
  }[dataType] ?? 1;
}
