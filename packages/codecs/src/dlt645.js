const START = 0x68;
const END = 0x16;
const WAKE = 0xfe;
const READ_DATA = 0x11;
const READ_DATA_RESPONSE = 0x91;
const ERROR_RESPONSE_MASK = 0xc0;

export const DLT645_READ_CONTROL = READ_DATA;
export const DLT645_READ_RESPONSE_CONTROL = READ_DATA_RESPONSE;

export function normalizeDlt645Address(value) {
  const address = String(value ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(address)) {
    throw new TypeError('DL/T 645 address must contain exactly 12 decimal digits');
  }
  return address;
}

export function normalizeDlt645DataIdentifier(value) {
  const identifier = String(value ?? '').replace(/\s/g, '').toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(identifier)) {
    throw new TypeError('DL/T 645 data identifier must contain exactly 8 hexadecimal digits');
  }
  return identifier;
}

export function encodeDlt645Address(value) {
  const address = normalizeDlt645Address(value);
  return Uint8Array.from(address.match(/../g).reverse().map((pair) => Number.parseInt(pair, 16)));
}

export function decodeDlt645Address(bytes) {
  const value = bytesOf(bytes, 'address');
  if (value.length !== 6 || value.some((byte) => !isBcdByte(byte))) {
    throw new TypeError('DL/T 645 address must be six BCD bytes');
  }
  return [...value].reverse().map(hexByte).join('');
}

export function encodeDlt645DataIdentifier(value) {
  const identifier = normalizeDlt645DataIdentifier(value);
  return Uint8Array.from(identifier.match(/../g).reverse().map((pair) => Number.parseInt(pair, 16)));
}

export function decodeDlt645DataIdentifier(bytes) {
  const value = bytesOf(bytes, 'data identifier');
  if (value.length !== 4) throw new TypeError('DL/T 645 data identifier must be four bytes');
  return [...value].reverse().map(hexByte).join('');
}

export function encodeDlt645Data(bytes) {
  return Uint8Array.from(bytesOf(bytes, 'data'), (byte) => (byte + 0x33) & 0xff);
}

export function decodeDlt645Data(bytes) {
  return Uint8Array.from(bytesOf(bytes, 'data'), (byte) => (byte - 0x33 + 0x100) & 0xff);
}

export function dlt645Checksum(bytes) {
  return bytesOf(bytes, 'frame').reduce((sum, byte) => (sum + byte) & 0xff, 0);
}

export function buildDlt645Frame({ address, control, data = [], wakeUpBytes = 0 } = {}) {
  if (!Number.isInteger(control) || control < 0 || control > 0xff) {
    throw new TypeError('DL/T 645 control must be a byte');
  }
  if (!Number.isInteger(wakeUpBytes) || wakeUpBytes < 0 || wakeUpBytes > 16) {
    throw new TypeError('DL/T 645 wake-up byte count must be between 0 and 16');
  }
  const encodedAddress = encodeDlt645Address(address);
  const encodedData = encodeDlt645Data(data);
  if (encodedData.length > 255) throw new RangeError('DL/T 645 data cannot exceed 255 bytes');
  const body = Uint8Array.of(
    START, ...encodedAddress, START, control, encodedData.length, ...encodedData,
  );
  return Uint8Array.of(...new Uint8Array(wakeUpBytes).fill(WAKE), ...body, dlt645Checksum(body), END);
}

export function buildDlt645ReadRequest({ address, dataIdentifier, wakeUpBytes = 4 } = {}) {
  return buildDlt645Frame({
    address,
    control: READ_DATA,
    data: encodeDlt645DataIdentifier(dataIdentifier),
    wakeUpBytes,
  });
}

export function encodeDlt645Bcd(value, decimals = 0, byteLength = 1, { signed = false } = {}) {
  if (!Number.isFinite(value)) throw new TypeError('DL/T 645 BCD value must be finite');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new TypeError('BCD decimals must be an integer between 0 and 12');
  }
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 64) {
    throw new TypeError('BCD byte length must be an integer between 1 and 64');
  }
  if (typeof signed !== 'boolean') throw new TypeError('BCD signed option must be a boolean');
  if (!signed && value < 0) throw new RangeError('Unsigned DL/T 645 BCD value cannot be negative');
  const scaled = Math.round(Math.abs(value) * (10 ** decimals));
  if (!Number.isSafeInteger(scaled)) throw new RangeError('DL/T 645 BCD value is outside the safe range');
  const digits = String(scaled).padStart(byteLength * 2, '0');
  if (digits.length > byteLength * 2) throw new RangeError('DL/T 645 BCD value exceeds configured byte length');
  const bytes = Uint8Array.from(digits.match(/../g).reverse().map((pair) => Number.parseInt(pair, 16)));
  if (signed && (bytes.at(-1) & 0x80) !== 0) {
    throw new RangeError('DL/T 645 BCD value exceeds configured signed range');
  }
  if (value < 0) bytes[bytes.length - 1] |= 0x80;
  return bytes;
}

export function buildDlt645ReadResponse({
  address,
  dataIdentifier,
  value,
  decimals = 0,
  byteLength = 1,
  signed = false,
  wakeUpBytes = 0,
} = {}) {
  const valueBytes = value instanceof Uint8Array || Array.isArray(value)
    ? bytesOf(value, 'response value')
    : encodeDlt645Bcd(value, decimals, byteLength, { signed });
  return buildDlt645Frame({
    address,
    control: READ_DATA_RESPONSE,
    data: [...encodeDlt645DataIdentifier(dataIdentifier), ...valueBytes],
    wakeUpBytes,
  });
}

export function buildDlt645ErrorResponse({
  address,
  requestControl = READ_DATA,
  errorCode = 0x02,
  wakeUpBytes = 0,
} = {}) {
  if (!Number.isInteger(requestControl) || requestControl < 0 || requestControl > 0x1f) {
    throw new TypeError('DL/T 645 request control must be a five-bit value');
  }
  if (!Number.isInteger(errorCode) || errorCode < 1 || errorCode > 0xff) {
    throw new TypeError('DL/T 645 error code must be a nonzero byte');
  }
  return buildDlt645Frame({
    address,
    control: requestControl | ERROR_RESPONSE_MASK,
    data: [errorCode],
    wakeUpBytes,
  });
}

export function parseDlt645Frame(input) {
  const source = bytesOf(input, 'frame');
  let offset = 0;
  while (source[offset] === WAKE) offset += 1;
  const wakeUpBytes = offset;
  if (source.length - offset < 12) throw frameError('INCOMPLETE_FRAME', 'DL/T 645 frame is incomplete');
  if (source[offset] !== START || source[offset + 7] !== START) {
    throw frameError('INVALID_START', 'DL/T 645 frame start bytes are invalid');
  }
  const dataLength = source[offset + 9];
  const frameLength = 12 + dataLength;
  if (source.length - offset !== frameLength) {
    throw frameError('INVALID_LENGTH', `DL/T 645 frame length must be ${frameLength} bytes`);
  }
  if (source.at(-1) !== END) throw frameError('INVALID_END', 'DL/T 645 frame end byte is invalid');
  const checksumIndex = source.length - 2;
  const expectedChecksum = dlt645Checksum(source.slice(offset, checksumIndex));
  if (source[checksumIndex] !== expectedChecksum) {
    throw frameError('CHECKSUM_MISMATCH', 'DL/T 645 checksum does not match');
  }
  const control = source[offset + 8];
  const data = decodeDlt645Data(source.slice(offset + 10, checksumIndex));
  const response = (control & 0x80) !== 0;
  const abnormal = (control & 0x40) !== 0;
  const following = (control & 0x20) !== 0;
  const dataIdentifier = !abnormal && data.length >= 4
    ? decodeDlt645DataIdentifier(data.slice(0, 4))
    : null;
  return Object.freeze({
    bytes: new Uint8Array(source),
    wakeUpBytes,
    address: decodeDlt645Address(source.slice(offset + 1, offset + 7)),
    control,
    response,
    abnormal,
    following,
    functionCode: control & 0x1f,
    dataLength,
    encodedData: source.slice(offset + 10, checksumIndex),
    data,
    dataIdentifier,
    valueBytes: dataIdentifier === null ? new Uint8Array() : data.slice(4),
    errorFlags: abnormal && data.length > 0 ? decodeErrorFlags(data[0]) : [],
    checksum: source[checksumIndex],
    checksumValid: true,
    segments: segmentDlt645Frame(source, offset, dataLength),
  });
}

export function extractDlt645Frames(input, { resynchronizing = false } = {}) {
  const source = bytesOf(input, 'stream');
  const frames = [];
  let recovering = resynchronizing === true;
  let incompleteStart = null;
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && source[cursor] !== START) cursor += 1;
    if (cursor >= source.length) break;
    let preambleStart = cursor;
    // The builder supports at most 16 wake-up bytes. Discard an excessive noise
    // prefix so an unfinished candidate cannot retain an unbounded preamble.
    while (preambleStart > Math.max(0, cursor - 16) && source[preambleStart - 1] === WAKE) preambleStart -= 1;
    if (source.length - cursor < 10) {
      incompleteStart ??= preambleStart;
      break;
    }
    if (source[cursor + 7] !== START) {
      cursor += 1;
      continue;
    }
    const length = 12 + source[cursor + 9];
    if (source.length - cursor < length) {
      incompleteStart ??= preambleStart;
      if (!recovering) break;
      // Keep the earliest partial candidate, but a false header encountered
      // after corruption must not hide a complete validated successor.
      cursor += 1;
      continue;
    }
    const end = cursor + length;
    const candidate = source.slice(preambleStart, end);
    try {
      frames.push(parseDlt645Frame(candidate));
      cursor = end;
      incompleteStart = null;
      recovering = false;
    } catch {
      // A corrupt length may span a valid successor. Search again from the next
      // byte instead of trusting the rejected candidate's declared boundary.
      recovering = true;
      cursor += 1;
    }
  }
  return {
    frames,
    remainder: incompleteStart === null ? new Uint8Array() : source.slice(incompleteStart),
    resynchronizing: incompleteStart !== null && recovering,
  };
}

export function decodeDlt645Bcd(bytes, decimals = 0, { signed = false } = {}) {
  const value = bytesOf(bytes, 'BCD value');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new TypeError('BCD decimals must be an integer between 0 and 12');
  }
  if (typeof signed !== 'boolean') throw new TypeError('BCD signed option must be a boolean');
  if (value.length === 0) return null;
  let sign = 1;
  if (signed && (value.at(-1) & 0x80) !== 0) {
    value[value.length - 1] &= 0x7f;
    sign = -1;
  }
  if (value.some((byte) => !isBcdByte(byte))) return null;
  const digits = [...value].reverse().map(hexByte).join('');
  const integer = Number.parseInt(digits, 10);
  return Number.isSafeInteger(integer) ? sign * integer / (10 ** decimals) : null;
}

export function formatDlt645Hex(bytes) {
  return [...bytesOf(bytes, 'bytes')].map(hexByte).join(' ');
}

function segmentDlt645Frame(source, offset, dataLength) {
  const checksumIndex = source.length - 2;
  const segments = [];
  if (offset > 0) segments.push(segment('wake', '唤醒符', source.slice(0, offset)));
  segments.push(
    segment('start1', '起始符', source.slice(offset, offset + 1)),
    segment('address', '电表地址', source.slice(offset + 1, offset + 7)),
    segment('start2', '起始符', source.slice(offset + 7, offset + 8)),
    segment('control', '控制码', source.slice(offset + 8, offset + 9)),
    segment('length', '数据长度', source.slice(offset + 9, offset + 10)),
  );
  if (dataLength > 0) segments.push(segment('data', '数据域（+33H）', source.slice(offset + 10, checksumIndex)));
  segments.push(
    segment('checksum', '校验和', source.slice(checksumIndex, checksumIndex + 1)),
    segment('end', '结束符', source.slice(checksumIndex + 1)),
  );
  return Object.freeze(segments);
}

function segment(key, label, bytes) {
  return Object.freeze({ key, label, bytes: new Uint8Array(bytes), hex: formatDlt645Hex(bytes) });
}

function decodeErrorFlags(byte) {
  const flags = [
    [0x01, '其他错误'], [0x02, '无请求数据'], [0x04, '密码错误或未授权'],
    [0x08, '通信速率不能更改'], [0x10, '年时区数超'], [0x20, '日时段数超'],
    [0x40, '费率数超'], [0x80, '保留'],
  ];
  return flags.filter(([mask]) => (byte & mask) !== 0).map(([, label]) => label);
}

function bytesOf(value, label) {
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
    throw new TypeError(`${label} must be a Uint8Array or byte array`);
  }
  const bytes = Array.from(value);
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) {
    throw new TypeError(`${label} contains an invalid byte`);
  }
  return bytes;
}

function isBcdByte(byte) {
  return (byte & 0x0f) <= 9 && ((byte >> 4) & 0x0f) <= 9;
}

function hexByte(byte) {
  return byte.toString(16).padStart(2, '0').toUpperCase();
}

function frameError(code, message) {
  const error = new Error(message);
  error.name = 'Dlt645FrameError';
  error.code = code;
  return error;
}
