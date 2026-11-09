import { assertToolInput, hexBytes, parseToolHex, reorderBytes } from '@ineed-linklab/codecs/industrial/bytes.js';
import { bitMask, convertRadix, decodeFloat, decodeInteger, encodeFloat, encodeInteger } from '@ineed-linklab/codecs/industrial/numbers.js';
import { decodeAscii, decodeBcd, encodeAscii, encodeBcd } from '@ineed-linklab/codecs/industrial/text.js';
import { calculateChecksum, CHECKSUM_PRESETS, checksumDetails } from '@ineed-linklab/codecs/industrial/checksums.js';

export const TOOL_GROUPS = [
  { id: 'encoding', label: '编码转换' }, { id: 'numbers', label: '数值与字节' }, { id: 'checksums', label: '校验计算' },
];
const choices = values => values.map(([value, label]) => ({ value, label }));
const select = (key, label, values, initial) => ({ key, label, options: choices(values), initial });
const direction = select('direction', '转换方向', [['encode', '数值 / 字符 → HEX'], ['decode', 'HEX → 数值 / 字符']], 'encode');
const width = select('width', '位宽', [8, 16, 32, 64].map(value => [String(value), `${value} 位`]), '32');
const signed = select('signed', '符号', [['unsigned', '无符号'], ['signed', '有符号（补码）']], 'unsigned');
const order = select('order', '字节 / 字顺序', [
  ['normal', '原序 / 大端（32 位 ABCD）'], ['swap-bytes', '每 16 位字交换字节（32 位 BADC）'],
  ['reverse-words', '反转 16 位字顺序（32 位 CDAB）'], ['reverse', '整体反转 / 小端（32 位 DCBA）'],
], 'normal');
const wireOrder = select('wireOrder', '校验发送顺序', [['little', '低字节先行（Modbus RTU）'], ['big', '高字节先行']], 'little');
const expected = { key: 'expected', label: '待核对校验字节（HEX，可留空）', initial: '' };

export const INDUSTRIAL_TOOLS = [
  { id: 'ascii', group: 'encoding', label: 'ASCII ↔ HEX', fields: [direction], example: 'Hello\r\n',
    description: '严格 7 位 ASCII（00–7F）。字符输入保留真实换行；HEX 解码用 \\r、\\n、\\t、\\x00 等转义显示控制字符，反斜杠也会转义。' },
  { id: 'bcd', group: 'encoding', label: '压缩 BCD', fields: [direction,
    { key: 'decimals', label: '小数位', type: 'number', initial: '0', min: 0, max: 12 },
    select('order', 'BCD 字节顺序', [['big', '高位数字字节先行'], ['little', '低位数字字节先行']], 'big')], example: '001234',
    description: '无符号压缩 BCD；保留前导零，奇数个数字左补 0。小数位显式配置，超出精度拒绝，不推断协议符号位。' },
  { id: 'radix', group: 'numbers', label: '进制与补码', fields: [
    select('base', '输入进制', [['2', '二进制'], ['8', '八进制'], ['10', '十进制'], ['16', '十六进制']], '10'), width, signed], example: '12345',
    description: '非十进制输入按所选位宽的位模式解释；十进制输入表示实际数值。支持匹配进制的 0b / 0o / 0x 前缀，溢出拒绝。' },
  { id: 'integer', group: 'numbers', label: '整数 ↔ 字节', fields: [direction, width, signed, order], example: '12345',
    description: '编码输入十进制整数，解码输入 HEX；8/16/32/64 位，使用精确整数计算。解码同时显示有符号与无符号值。' },
  { id: 'float', group: 'numbers', label: '浮点 ↔ 字节', fields: [direction,
    select('width', '浮点位宽', [['32', 'Float32 · 4 字节'], ['64', 'Float64 · 8 字节']], '32'), order], example: '0.1',
    description: 'IEEE 754 二进制浮点。编码显示舍入后的实际值；解码可识别 NaN、Infinity 与负零。64 位顺序按完整 16 位字处理。' },
  { id: 'order', group: 'numbers', label: '字节与字顺序', fields: [order], example: '12 34 56 78',
    description: '输入 HEX，查看交换后的字节。字交换只接受完整的 16 位字；操作不改变原始输入。' },
  { id: 'bits', group: 'numbers', label: '位域与掩码', fields: [width,
    select('operation', '位操作', [['view', '查看位图'], ['and', 'AND · 掩码保留 / 清位'], ['or', 'OR · 掩码置位'], ['xor', 'XOR · 掩码翻转']], 'view'),
    { key: 'mask', label: '掩码（HEX 整数）', initial: 'FFFF' }], example: '8001',
    description: '输入无符号 HEX 整数（不含空格）。最低位编号为 bit 0；选择 AND / OR / XOR 进行掩码运算，超出位宽拒绝。' },
  { id: 'crc', group: 'checksums', label: 'CRC 校验', fields: [
    select('algorithm', 'CRC 算法', CHECKSUM_PRESETS.filter(item => item.poly).map(item => [item.id, item.label]), 'crc16-modbus'), wireOrder, expected],
    example: '01 03 00 00 00 0A', description: '输入参与校验的 HEX 数据，不含末尾校验字节。默认低字节先行；切换算法后也请核对发送顺序。待核对值留空时只计算。' },
  { id: 'checksum', group: 'checksums', label: '累加 / 异或 / LRC', fields: [
    select('algorithm', '校验算法', CHECKSUM_PRESETS.filter(item => !item.poly).map(item => [item.id, item.label]), 'sum8'), { ...wireOrder, initial: 'big' }, expected],
    example: '01 03 00 00 00 0A', description: 'SUM16 是逐字节累加模 65536；XOR8 为逐字节异或，不能代表所有名为 BCC 的算法。LRC 对解码后的字节求和再取 8 位二补码。输入不含校验字节。' },
];

export function industrialTool(id) {
  const tool = INDUSTRIAL_TOOLS.find(item => item.id === id);
  if (!tool) throw new TypeError('未找到所选工具。');
  return tool;
}

export function createToolDraft(id) {
  return { input: '', options: Object.fromEntries(industrialTool(id).fields.map(field => [field.key, field.initial])), result: null, error: '' };
}

function validatedOptions(tool, options) {
  const values = { ...createToolDraft(tool.id).options, ...options };
  for (const field of tool.fields) {
    const value = values[field.key];
    assertToolInput(value);
    if (field.options && !field.options.some(option => option.value === value)) throw new TypeError(`请选择有效的${field.label}。`);
    if (field.type === 'number' && !/^\d+$/.test(value)) throw new TypeError(`${field.label}必须为非负整数。`);
  }
  return values;
}

// Examples follow configuration; only input data and its auxiliary operands
// (mask / supplied checksum) are replaced. Never reset a selected scenario.
export function createToolExample(id, rawOptions) {
  const tool = industrialTool(id);
  const options = validatedOptions(tool, rawOptions);
  const width = Number(options.width);
  let input = tool.example;
  if (id === 'ascii' && options.direction === 'decode') input = hexBytes(encodeAscii(input));
  if (id === 'bcd') {
    const decimals = Number(options.decimals);
    input = decimals ? '0012.' + '34'.padEnd(decimals, '0').slice(0, decimals) : '001234';
    const bytes = encodeBcd(input, decimals, options.order);
    if (options.direction === 'decode') input = hexBytes(bytes);
  }
  if (id === 'radix' || id === 'integer') {
    const value = BigInt(width === 8 ? 123 : 12345) * (options.signed === 'signed' ? -1n : 1n);
    if (id === 'radix') {
      const base = Number(options.base);
      input = (base === 10 ? value : BigInt.asUintN(width, value)).toString(base).toUpperCase();
    } else {
      input = value.toString();
      if (options.direction === 'decode') input = hexBytes(encodeInteger(input, width, options.signed === 'signed', options.order));
    }
  }
  if (id === 'float' && options.direction === 'decode') input = hexBytes(encodeFloat(input, width, options.order).bytes);
  if (id === 'bits') {
    input = ((1n << BigInt(width - 1)) | 1n).toString(16).toUpperCase();
    options.mask = ((1n << BigInt(width / 2)) - 1n).toString(16).toUpperCase().padStart(width / 4, '0');
  }
  if (id === 'crc' || id === 'checksum') {
    // The Modbus frame demonstrates RTU; other CRC presets use the standard
    // ASCII "123456789" check vector, represented as HEX input.
    if (id === 'crc' && options.algorithm !== 'crc16-modbus') input = '31 32 33 34 35 36 37 38 39';
    if (options.expected.trim()) {
      const checksum = calculateChecksum(parseToolHex(input), options.algorithm);
      options.expected = options.wireOrder === 'little' ? checksum.littleEndian : checksum.bigEndian;
    }
  }
  return { input, options };
}

const row = (label, value) => ({ label, value: String(value) });
const result = (rows, note = '', verification = null) => ({ rows, note, verification });

function checksumResult(input, options) {
  const bytes = parseToolHex(input);
  const calculated = calculateChecksum(bytes, options.algorithm);
  const preset = checksumDetails(options.algorithm);
  const wire = options.wireOrder === 'little' ? calculated.littleEndian : calculated.bigEndian;
  const supplied = options.expected.trim() ? parseToolHex(options.expected) : null;
  if (supplied && supplied.length !== preset.width / 8) throw new RangeError(`待核对值应为 ${preset.width / 8} 字节。`);
  const verification = supplied ? hexBytes(supplied) === wire : null;
  const params = preset.poly
    ? `width=${preset.width} · poly=0x${preset.poly} · init=0x${preset.init} · refin=${preset.refin} · refout=${preset.refout} · xorout=0x${preset.xorout}`
    : preset.label;
  return result([row('校验数值（HEX）', calculated.hex), row('发送字节', wire),
    row('高字节先行', calculated.bigEndian), row('低字节先行', calculated.littleEndian),
    row('数据 + 校验字节', [hexBytes(bytes), wire].filter(Boolean).join(' '))],
  `${params}。参与计算 ${bytes.length} 字节。${supplied ? '按所选发送顺序核对。' : '未提供待核对字节，仅计算校验值。'}`, verification);
}

export function runTool(id, input, rawOptions) {
  const tool = industrialTool(id);
  assertToolInput(input);
  const options = validatedOptions(tool, rawOptions);
  const widthValue = Number(options.width);
  if (id === 'crc' || id === 'checksum') return checksumResult(input, options);
  if (id === 'ascii') {
    if (options.direction === 'encode') {
      const bytes = encodeAscii(input);
      return result([row('HEX 字节', hexBytes(bytes)), row('字符（转义展示）', decodeAscii(hexBytes(bytes)).escaped)], `${bytes.length} 字节；ASCII 不包含中文编码。`);
    }
    return result([row('字符（转义展示）', decodeAscii(input).escaped)], '控制字符与反斜杠以转义形式展示及复制。');
  }
  if (id === 'bcd') {
    return options.direction === 'encode'
      ? result([row('HEX 字节', hexBytes(encodeBcd(input, Number(options.decimals), options.order)))], '压缩无符号 BCD；若数字位数为奇数，已左补 0。解码保留该前导零。')
      : result([row('十进制数字', decodeBcd(input, Number(options.decimals), options.order))], '保留原始数字位数和配置的小数位，不推断符号位。');
  }
  if (id === 'radix') {
    const values = convertRadix(input, Number(options.base), widthValue, options.signed === 'signed');
    return result([row('二进制', values.binary), row('八进制', values.octal), row('十进制', values.decimal), row('十六进制', values.hex)], 'BIN/OCT/HEX 按所选位宽显示位模式；十进制按符号模式解释。');
  }
  if (id === 'integer') {
    if (options.direction === 'encode') return result([row('HEX 字节', hexBytes(encodeInteger(input, widthValue, options.signed === 'signed', options.order)))], '按所选字节与字顺序输出；不截断溢出值。');
    const values = decodeInteger(input, widthValue, options.order);
    return result([row('无符号十进制', values.unsigned), row('有符号十进制', values.signed)], '同一字节的两种解释；符号选择仅用于编码。');
  }
  if (id === 'float') {
    if (options.direction === 'decode') return result([row('浮点值', decodeFloat(input, widthValue, options.order))], '特殊值按 IEEE 754 显示，-0 为负零。');
    const encoded = encodeFloat(input, widthValue, options.order);
    return result([row('HEX 字节', hexBytes(encoded.bytes)), row('实际编码值', encoded.value)], '浮点可能舍入或下溢为零；请核对实际编码值。');
  }
  if (id === 'order') return result([row('HEX 字节', hexBytes(reorderBytes(parseToolHex(input), options.order)))], '交换的是字节排列，不是数值或字符编码。');
  const bits = bitMask(input, options.mask, widthValue, options.operation);
  return result([row('HEX 位模式', bits.hex), row('二进制位图', bits.binary), row('置 1 位号（从高到低）', bits.setBits.join(', ') || '无')], 'bit 0 为最低位；AND 清位时请使用所需保留位的掩码。');
}
