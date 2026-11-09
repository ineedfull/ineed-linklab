import { compareDecimalFractions, parseDecimalFraction } from './modbusDecimal.js';

export function decodeModbusMasterPoint(point, values, functionCode) {
  if (point?.enabled === false) return reading([], null, 'disabled', '数据点已停用');
  const source = Array.isArray(values) ? values : [];
  const offset = Number(point?.offset ?? 0);
  const bitFunction = functionCode === 1 || functionCode === 2;
  const length = bitFunction ? 1 : Number(point?.length ?? 1);
  if (!Number.isInteger(offset) || offset < 0 || offset + length > source.length) {
    return reading([], null, 'bad-value', '响应数据不足');
  }
  const raw = source.slice(offset, offset + length);
  try {
    if (point.dataType === 'boolean') {
      const value = bitFunction
        ? Boolean(raw[0])
        : (Number(raw[0]) & (1 << Number(point.bitIndex))) !== 0;
      return reading(raw, value, 'good', null, value ? 'ON' : 'OFF');
    }
    if (point.dataType === 'string') {
      const value = decodeString(raw, point.byteOrder, point.wordOrder);
      return reading(raw, value, 'good', null, value);
    }
    const bytes = wordsToBytes(raw, point.byteOrder, point.wordOrder);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let decoded;
    switch (point.dataType) {
      case 'uint16': decoded = view.getUint16(0, false); break;
      case 'int16': decoded = view.getInt16(0, false); break;
      case 'uint32': decoded = view.getUint32(0, false); break;
      case 'int32': decoded = view.getInt32(0, false); break;
      case 'float32': decoded = view.getFloat32(0, false); break;
      case 'float64': decoded = view.getFloat64(0, false); break;
      case 'uint64': decoded = view.getBigUint64(0, false); break;
      case 'int64': decoded = view.getBigInt64(0, false); break;
      default: return reading(raw, null, 'bad-value', '不支持的数据类型');
    }
    return numericReading(point, raw, decoded);
  } catch (error) {
    return reading(raw, null, 'bad-value', error instanceof Error ? error.message : String(error));
  }
}

export function communicationFailureReading(point, reason) {
  if (point?.enabled === false) return reading([], null, 'disabled', '数据点已停用');
  return reading([], null, 'bad-communication', reason || '通信失败');
}

function numericReading(point, raw, decoded) {
  const scale = Number(point.scale ?? 1);
  const valueOffset = Number(point.valueOffset ?? 0);
  const exactOutOfRange = typeof decoded === 'bigint'
    ? exactScaledIntegerOutOfRange(decoded, point)
    : null;
  if (typeof decoded === 'bigint' && scale === 1 && valueOffset === 0) {
    const value = decoded.toString();
    return reading(
      raw,
      value,
      exactOutOfRange ? 'bad-value' : 'good',
      exactOutOfRange ? '数值超出合理范围' : null,
      value,
    );
  }
  const numeric = Number(decoded) * scale + valueOffset;
  if (!Number.isFinite(numeric)) return reading(raw, null, 'bad-value', '解析结果不是有限数值');
  let quality = 'good';
  let reason = null;
  if (typeof decoded === 'bigint' && !Number.isSafeInteger(Number(decoded))) {
    quality = 'uncertain-overflow';
    reason = '64 位整数换算超过 JavaScript 安全整数范围';
  }
  const outOfRange = typeof decoded === 'bigint'
    ? exactOutOfRange
    : (point.minimum !== null && point.minimum !== undefined && numeric < Number(point.minimum))
      || (point.maximum !== null && point.maximum !== undefined && numeric > Number(point.maximum));
  if (outOfRange) {
    quality = 'bad-value';
    reason = '数值超出合理范围';
  }
  const decimals = point.decimals;
  const display = Number.isInteger(decimals) && decimals >= 0
    ? numeric.toFixed(decimals)
    : String(Number(numeric.toPrecision(12)));
  return reading(raw, numeric, quality, reason, display);
}

function exactScaledIntegerOutOfRange(value, point) {
  const scale = parseDecimalFraction(point.scale ?? 1);
  const valueOffset = parseDecimalFraction(point.valueOffset ?? 0);
  if (!scale || !valueOffset) return false;
  const transformed = {
    numerator: value * scale.numerator * valueOffset.denominator
      + valueOffset.numerator * scale.denominator,
    denominator: scale.denominator * valueOffset.denominator,
  };
  const minimum = parseDecimalFraction(point.minimum);
  const maximum = parseDecimalFraction(point.maximum);
  return minimum !== null && compareDecimalFractions(transformed, minimum) < 0
    || maximum !== null && compareDecimalFractions(transformed, maximum) > 0;
}

function reading(raw, value, quality, reason, display = '—') {
  return { raw, value, display, quality, reason };
}

function wordsToBytes(source, byteOrder, wordOrder) {
  const words = wordOrder === 'low-first' ? [...source].reverse() : [...source];
  return Uint8Array.from(words.flatMap((word) => {
    const high = (Number(word) >> 8) & 0xff;
    const low = Number(word) & 0xff;
    return byteOrder === 'little-endian' ? [low, high] : [high, low];
  }));
}

function decodeString(words, byteOrder, wordOrder) {
  const bytes = wordsToBytes(words, byteOrder, wordOrder);
  return new TextDecoder().decode(bytes).replace(/\0+$/u, '');
}
