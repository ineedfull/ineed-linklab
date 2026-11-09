import { assertToolInput, parseToolHex, reorderBytes } from './bytes.js';

function integerWidth(width) {
  if (![8, 16, 32, 64].includes(width)) throw new RangeError('整数位宽必须为 8、16、32 或 64。');
  return BigInt(width);
}

function parseBase(input, base) {
  assertToolInput(input);
  if (![2, 8, 10, 16].includes(base)) throw new TypeError('不支持的输入进制。');
  const text = input.trim();
  const negative = text.startsWith('-');
  let digits = text.replace(/^[+-]/, '').toUpperCase();
  const prefix = { 2: '0B', 8: '0O', 16: '0X' }[base];
  if (prefix && digits.startsWith(prefix)) digits = digits.slice(2);
  if (!digits || digits.length > 128) throw new RangeError('请输入所选位宽内的完整整数。');
  let result = 0n;
  for (const digit of digits) {
    const value = '0123456789ABCDEF'.indexOf(digit);
    if (value < 0 || value >= base) throw new TypeError('输入包含不属于所选进制的字符。');
    result = result * BigInt(base) + BigInt(value);
  }
  return negative ? -result : result;
}

function checkedPattern(value, width, signed) {
  const bits = integerWidth(width);
  if (typeof signed !== 'boolean') throw new TypeError('请选择有符号或无符号模式。');
  const min = signed ? -(1n << (bits - 1n)) : 0n;
  const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (value < min || value > max) throw new RangeError(`数值超出 ${width} 位${signed ? '有符号' : '无符号'}整数范围。`);
  return BigInt.asUintN(width, value);
}

function integerRows(pattern, width, signed) {
  return {
    binary: pattern.toString(2).padStart(width, '0'),
    octal: pattern.toString(8).padStart(Math.ceil(width / 3), '0'),
    decimal: (signed ? BigInt.asIntN(width, pattern) : pattern).toString(),
    hex: pattern.toString(16).toUpperCase().padStart(width / 4, '0'),
  };
}

export function convertRadix(input, base, width, signed) {
  const bits = integerWidth(width);
  const value = parseBase(input, base);
  // Non-decimal positive input denotes a bit pattern; decimal denotes a numeric value.
  const patternInput = base !== 10 && value >= 0n;
  if (patternInput && value >= (1n << bits)) throw new RangeError('输入位模式超出所选位宽。');
  const pattern = checkedPattern(patternInput && signed ? BigInt.asIntN(width, value) : value, width, signed);
  return integerRows(pattern, width, signed);
}

export function encodeInteger(input, width, signed, order) {
  let pattern = checkedPattern(parseBase(input, 10), width, signed);
  const bytes = new Uint8Array(width / 8);
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = Number(pattern & 255n);
    pattern >>= 8n;
  }
  return reorderBytes(bytes, order);
}

function numericBytes(input, width, order) {
  const bytes = parseToolHex(input);
  if (bytes.length !== width / 8) throw new RangeError(`所选类型需要恰好 ${width / 8} 字节。`);
  return reorderBytes(bytes, order);
}

export function decodeInteger(input, width, order) {
  integerWidth(width);
  let value = 0n;
  for (const byte of numericBytes(input, width, order)) value = (value << 8n) | BigInt(byte);
  return { unsigned: value.toString(), signed: BigInt.asIntN(width, value).toString() };
}

function floatWidth(width) {
  if (![32, 64].includes(width)) throw new RangeError('浮点位宽必须为 32 或 64。');
}

function floatText(value) { return Object.is(value, -0) ? '-0' : String(value); }

export function encodeFloat(input, width, order) {
  floatWidth(width);
  assertToolInput(input);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input.trim())) {
    throw new TypeError('请输入有限的十进制浮点数，可使用科学计数法。');
  }
  const value = Number(input);
  if (!Number.isFinite(value)) throw new RangeError('输入超出有限浮点数范围。');
  const view = new DataView(new ArrayBuffer(width / 8));
  if (width === 32) view.setFloat32(0, value); else view.setFloat64(0, value);
  const encoded = width === 32 ? view.getFloat32(0) : view.getFloat64(0);
  if (!Number.isFinite(encoded)) throw new RangeError('输入超出所选浮点类型的有限范围。');
  return { bytes: reorderBytes(new Uint8Array(view.buffer), order), value: floatText(encoded) };
}

export function decodeFloat(input, width, order) {
  floatWidth(width);
  const bytes = numericBytes(input, width, order);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return floatText(width === 32 ? view.getFloat32(0) : view.getFloat64(0));
}

export function bitMask(input, mask, width, operation) {
  integerWidth(width);
  const value = checkedPattern(parseBase(input, 16), width, false);
  const operand = operation === 'view' ? 0n : checkedPattern(parseBase(mask, 16), width, false);
  const operations = { view: () => value, and: () => value & operand, or: () => value | operand, xor: () => value ^ operand };
  if (!Object.hasOwn(operations, operation)) throw new TypeError('不支持的位操作。');
  const result = operations[operation]();
  const rows = integerRows(result, width, false);
  return { hex: rows.hex, binary: rows.binary,
    setBits: Array.from({ length: width }, (_, index) => width - index - 1).filter(bit => (result & (1n << BigInt(bit))) !== 0n) };
}
