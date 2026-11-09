import { boundedBytes, hexBytes } from './bytes.js';

// CRC RevEng catalogue parameters: poly is always the normal (not reflected) form.
const CRC = [
  ['crc8-smbus', 'CRC-8/SMBUS', 8, '07', '00', false, false, '00', 'F4'],
  ['crc16-modbus', 'CRC-16/MODBUS', 16, '8005', 'FFFF', true, true, '0000', '4B37'],
  ['crc16-arc', 'CRC-16/ARC', 16, '8005', '0000', true, true, '0000', 'BB3D'],
  ['crc16-ibm3740', 'CRC-16/IBM-3740', 16, '1021', 'FFFF', false, false, '0000', '29B1'],
  ['crc16-xmodem', 'CRC-16/XMODEM', 16, '1021', '0000', false, false, '0000', '31C3'],
  ['crc16-kermit', 'CRC-16/KERMIT', 16, '1021', '0000', true, true, '0000', '2189'],
  ['crc16-ibmsdlc', 'CRC-16/IBM-SDLC', 16, '1021', 'FFFF', true, true, 'FFFF', '906E'],
  ['crc32-isohdlc', 'CRC-32/ISO-HDLC', 32, '04C11DB7', 'FFFFFFFF', true, true, 'FFFFFFFF', 'CBF43926'],
].map(([id, label, width, poly, init, refin, refout, xorout, check]) => Object.freeze({ id, label, width, poly, init, refin, refout, xorout, check }));

const SIMPLE = [
  { id: 'sum8', label: 'SUM8 · 字节累加模 256', width: 8 },
  { id: 'sum16', label: 'SUM16 · 字节累加模 65536', width: 16 },
  { id: 'xor8', label: 'XOR8 · 逐字节异或', width: 8 },
  { id: 'lrc8', label: 'Modbus ASCII LRC · 累加和二补码', width: 8 },
].map(Object.freeze);

export const CHECKSUM_PRESETS = Object.freeze([...CRC, ...SIMPLE]);

export function checksumDetails(id) {
  const preset = CHECKSUM_PRESETS.find(item => item.id === id);
  if (!preset) throw new TypeError('请选择明确的校验算法。');
  return preset;
}

function reflect(value, width) {
  let result = 0n;
  for (let bit = 0; bit < width; bit++) { result = (result << 1n) | (value & 1n); value >>= 1n; }
  return result;
}

function crcValue(bytes, preset) {
  const width = BigInt(preset.width);
  const mask = (1n << width) - 1n;
  const highBit = 1n << (width - 1n);
  const poly = BigInt('0x' + preset.poly);
  let crc = BigInt('0x' + preset.init);
  for (const byte of bytes) {
    const source = preset.refin ? reflect(BigInt(byte), 8) : BigInt(byte);
    crc ^= source << (width - 8n);
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1n) ^ ((crc & highBit) ? poly : 0n)) & mask;
  }
  if (preset.refout) crc = reflect(crc, preset.width);
  return (crc ^ BigInt('0x' + preset.xorout)) & mask;
}

export function calculateChecksum(bytes, id) {
  boundedBytes(bytes);
  const preset = checksumDetails(id);
  let value;
  if (preset.poly) value = crcValue(bytes, preset);
  else {
    const sum = bytes.reduce((total, byte) => total + byte, 0);
    value = BigInt(id === 'xor8' ? bytes.reduce((total, byte) => total ^ byte, 0)
      : id === 'lrc8' ? (-sum) & 255 : sum & (preset.width === 16 ? 65535 : 255));
  }
  const hex = value.toString(16).toUpperCase().padStart(preset.width / 4, '0');
  const wire = Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16));
  return { hex, bigEndian: hexBytes(wire), littleEndian: hexBytes(wire.slice().reverse()), width: preset.width };
}
