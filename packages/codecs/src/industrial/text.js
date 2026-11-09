import { assertToolInput, boundedBytes, parseToolHex } from './bytes.js';

export function encodeAscii(input) {
  assertToolInput(input);
  for (const char of input) {
    if (char.codePointAt(0) > 127) throw new TypeError('ASCII 仅支持 00–7F；中文等字符需要其他编码。');
  }
  return boundedBytes(Uint8Array.from(input, char => char.charCodeAt(0)));
}

export function decodeAscii(input) {
  const bytes = parseToolHex(input);
  if (bytes.some(byte => byte > 127)) throw new TypeError('包含超出 00–7F 的非 ASCII 字节。');
  const text = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  const escapes = { 9: '\\t', 10: '\\n', 13: '\\r', 92: '\\\\' };
  const escaped = Array.from(bytes, byte => escapes[byte]
    ?? (byte < 32 || byte === 127 ? '\\x' + byte.toString(16).padStart(2, '0').toUpperCase() : String.fromCharCode(byte))).join('');
  return { text, escaped };
}

function bcdOptions(decimals, order) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new RangeError('BCD 小数位必须为 0–12 的整数。');
  if (!['big', 'little'].includes(order)) throw new TypeError('请选择有效的 BCD 字节顺序。');
}

export function encodeBcd(input, decimals, order) {
  bcdOptions(decimals, order);
  assertToolInput(input);
  const value = input.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new TypeError('请输入无符号十进制数字，可包含小数点。');
  const [integer, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new RangeError('输入小数位超过配置，不能自动舍入。');
  let digits = integer + fraction.padEnd(decimals, '0');
  if (digits.length > 128) throw new RangeError('BCD 最多支持 128 个十进制数字。');
  if (digits.length % 2) digits = '0' + digits;
  const bytes = Uint8Array.from(digits.match(/../g), pair => Number.parseInt(pair, 16));
  return order === 'little' ? bytes.reverse() : bytes;
}

export function decodeBcd(input, decimals, order) {
  bcdOptions(decimals, order);
  const bytes = parseToolHex(input);
  if (!bytes.length || bytes.length > 64) throw new RangeError('压缩 BCD 需要 1–64 字节。');
  if (bytes.some(byte => (byte & 15) > 9 || (byte >> 4) > 9)) throw new TypeError('无效 BCD：每个半字节必须为 0–9，当前不含符号位。');
  const source = order === 'little' ? bytes.slice().reverse() : bytes;
  let digits = Array.from(source, byte => byte.toString(16).padStart(2, '0')).join('');
  if (!decimals) return digits;
  digits = digits.padStart(decimals + 1, '0');
  return digits.slice(0, -decimals) + '.' + digits.slice(-decimals);
}
