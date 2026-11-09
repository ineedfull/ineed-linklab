const INTEGER_RANGES = {
  SByte: [-128n, 127n], Byte: [0n, 255n], Int16: [-32768n, 32767n], UInt16: [0n, 65535n],
  Int32: [-2147483648n, 2147483647n], UInt32: [0n, 4294967295n],
  Int64: [-(1n << 63n), (1n << 63n) - 1n], UInt64: [0n, (1n << 64n) - 1n],
};
const WRITE_TYPES = new Set([...Object.keys(INTEGER_RANGES), 'Boolean', 'Float', 'Double', 'String', 'DateTime', 'ByteString', 'NodeId']);

function validateWriteValue(type, arrayType, value) {
  if (!WRITE_TYPES.has(type)) throw new Error('该数据类型仅支持读取');
  if (!['Scalar', 'Array'].includes(arrayType)) throw new Error('arrayType 必须为 Scalar 或 Array');
  if (arrayType === 'Array') {
    if (!Array.isArray(value) || value.length > 4096) throw new Error('数组必须是 JSON 数组且最多 4096 项');
    value.forEach(item => validateScalar(type, item));
  } else validateScalar(type, value);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('写入值最多 1 MiB');
  return value;
}
function validateScalar(type, value) {
  if (INTEGER_RANGES[type]) {
    const wide = type.endsWith('64');
    if (wide ? typeof value !== 'string' || !/^-?\d+$/.test(value) : !Number.isSafeInteger(value)) {
      throw new Error(wide ? '64 位整数必须使用十进制字符串' : '值必须为安全范围内的整数 integer');
    }
    const n = BigInt(value); const [min, max] = INTEGER_RANGES[type];
    if (n < min || n > max) throw new Error(`${type} 超出范围 range`);
  } else if (type === 'Boolean') {
    if (typeof value !== 'boolean') throw new Error('Boolean 必须为布尔值');
  } else if (type === 'Float' || type === 'Double') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'Float' && !Number.isFinite(Math.fround(value)))) throw new Error('数值必须为有限 finite 浮点数');
  } else {
    if (typeof value !== 'string') throw new Error(`${type} 必须为字符串`);
    if (value.length > 1024 * 1024) throw new Error('字符串过长');
    if (type === 'ByteString' && Buffer.from(value, 'base64').toString('base64') !== value) throw new Error('ByteString 必须为规范 base64');
    if (type === 'DateTime') {
      const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
      if (!match || !Number.isFinite(Date.parse(value)) || Date.parse(value) < Date.UTC(1601, 0, 1) || +match[2] < 1 || +match[2] > 12 || +match[3] < 1 || +match[3] > new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate()) throw new Error('DateTime 必须为不早于 1601 年的有效 ISO8601 日期（含时区）');
    }
    if (type === 'NodeId') validateNodeId(value);
  }
}
function validateNodeId(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^(?:ns=\d+;)?(?:i=\d+|s=.+|g=[0-9a-fA-F-]{36}|b=[A-Za-z0-9+/=]*)$/.test(value)) throw new Error('NodeId 格式无效，例如 ns=2;s=Temperature');
  return value;
}
function decodeValue(type, arrayType, value, ua) {
  validateWriteValue(type, arrayType, value);
  const scalar = v => {
    if (type === 'Int64' || type === 'UInt64') {
      const n = BigInt.asUintN(64, BigInt(v));
      return [Number(n >> 32n), Number(n & 0xffffffffn)];
    }
    if (type === 'ByteString') return Buffer.from(v, 'base64');
    if (type === 'DateTime') return new Date(v);
    if (type === 'NodeId') return ua.coerceNodeId(v);
    return v;
  };
  return arrayType === 'Array' ? value.map(scalar) : scalar(value);
}
function encodeValue(type, value, arrayType = 'Scalar') {
  if (value === null || value === undefined) return null;
  if (arrayType !== 'Scalar') return Array.from(value, item => encodeValue(type, item));
  if (type === 'Int64' || type === 'UInt64') {
    const n = typeof value === 'bigint' ? value : (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0);
    return (type === 'Int64' ? BigInt.asIntN(64, n) : BigInt.asUintN(64, n)).toString();
  }
  if (type === 'ByteString') return Buffer.from(value).toString('base64');
  if (type === 'DateTime') return value instanceof Date ? value.toISOString() : String(value);
  if (type === 'NodeId' || type === 'ExpandedNodeId' || type === 'QualifiedName' || type === 'LocalizedText') return String(value);
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
}
function wireDataValue(nodeId, data, ua) {
  const variant = data.value;
  const type = ua.DataType[variant?.dataType] ?? 'Null';
  const arrayType = ua.VariantArrayType[variant?.arrayType] ?? 'Scalar';
  return { nodeId, dataType: type, arrayType, ...(arrayType === 'Matrix' ? { dimensions: [...(variant.dimensions ?? [])] } : {}), value: encodeValue(type, variant?.value, arrayType),
    statusCode: data.statusCode?.toString() ?? 'BadNoData', sourceTimestamp: data.sourceTimestamp?.toISOString() ?? null,
    serverTimestamp: data.serverTimestamp?.toISOString() ?? null };
}
module.exports = { validateNodeId, validateWriteValue, decodeValue, encodeValue, wireDataValue };
