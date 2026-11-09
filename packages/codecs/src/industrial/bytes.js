import { parseHex } from '../payloadCodec.js';

export const MAX_TOOL_CHARACTERS = 65536;
export const MAX_TOOL_BYTES = 16384;

export function assertToolInput(text) {
  if (typeof text !== 'string') throw new TypeError('输入必须为文本。');
  if (text.length > MAX_TOOL_CHARACTERS) throw new RangeError('输入不能超过 65,536 个字符。');
}

export function boundedBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('数据必须为字节数组。');
  if (bytes.length > MAX_TOOL_BYTES) throw new RangeError('数据不能超过 16,384 字节。');
  return bytes;
}

export function parseToolHex(text) {
  assertToolInput(text);
  let bytes;
  try { bytes = parseHex(text); }
  catch { throw new TypeError('HEX 格式无效：请输入完整字节，可用空白分隔，例如 01 0A FF。'); }
  return boundedBytes(bytes);
}

export function hexBytes(bytes) {
  return Array.from(boundedBytes(bytes), byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// All four orders are involutions: the same transformation encodes and decodes.
// Word reversal always operates on complete 16-bit registers, including 64-bit values.
export function reorderBytes(bytes, order) {
  const result = boundedBytes(bytes).slice();
  if (order === 'normal') return result;
  if (order === 'reverse') return result.reverse();
  if (!['swap-bytes', 'reverse-words'].includes(order)) throw new TypeError('不支持的字节顺序。');
  if (result.length % 2) throw new RangeError('按 16 位字交换时，输入必须为偶数字节。');
  if (order === 'swap-bytes') {
    for (let i = 0; i < result.length; i += 2) [result[i], result[i + 1]] = [result[i + 1], result[i]];
  } else {
    for (let i = 0; i < result.length; i += 2) result.set(bytes.subarray(bytes.length - i - 2, bytes.length - i), i);
  }
  return result;
}
