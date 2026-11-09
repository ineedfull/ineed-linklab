import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolHex, hexBytes, reorderBytes } from '../src/industrial/bytes.js';
import { convertRadix, encodeInteger, decodeInteger, encodeFloat, decodeFloat, bitMask } from '../src/industrial/numbers.js';
import { encodeAscii, decodeAscii, encodeBcd, decodeBcd } from '../src/industrial/text.js';
import { calculateChecksum, checksumDetails } from '../src/industrial/checksums.js';

test('HEX accepts complete bytes without changing the byte stream', () => {
  assert.equal(hexBytes(parseToolHex('01ab\t00 FF\r\n')), '01 AB 00 FF');
  for (const input of ['A', 'A B', '0x01', '01,02', 'GG']) assert.throws(() => parseToolHex(input));
});
test('oversize input is refused before calculation, never truncated', () => {
  assert.throws(() => parseToolHex('00'.repeat(16385)), /16,?384/);
  assert.throws(() => parseToolHex(' '.repeat(65537)), /65,?536/);
  assert.equal(parseToolHex('00'.repeat(16384)).length, 16384);
});
test('radix conversion treats non-decimal signed patterns as fixed-width two complement', () => {
  assert.deepEqual(convertRadix('FF', 16, 8, true), { binary: '11111111', octal: '377', decimal: '-1', hex: 'FF' });
  assert.equal(convertRadix('-128', 10, 8, true).hex, '80');
  assert.equal(convertRadix('18446744073709551615', 10, 64, false).hex, 'FFFFFFFFFFFFFFFF');
  assert.equal(convertRadix('0b00000001', 2, 8, false).hex, '01');
});
test('radix refuses overflow, invalid digits, ambiguous widths and partial numbers', () => {
  for (const args of [['256',10,8,false], ['-129',10,8,true], ['-1',10,8,false], ['12z',10,16,false], ['102',2,8,false], ['1',10,7,false], ['',10,8,false], ['1e3',10,16,false]]) {
    assert.throws(() => convertRadix(...args));
  }
});
test('integer encoding and decoding preserves the exact 64-bit range', () => {
  assert.equal(hexBytes(encodeInteger('-9223372036854775808',64,true,'normal')), '80 00 00 00 00 00 00 00');
  assert.deepEqual(decodeInteger('FF FF FF FF FF FF FF FF',64,'normal'), { unsigned:'18446744073709551615', signed:'-1' });
  assert.equal(hexBytes(encodeInteger('4660',16,false,'reverse')), '34 12');
  assert.throws(() => decodeInteger('00 01',32,'normal'));
  assert.throws(() => encodeInteger('9223372036854775808',64,true,'normal'));
});
for (const [order,expected] of [['normal','12 34 56 78'],['swap-bytes','34 12 78 56'],['reverse-words','56 78 12 34'],['reverse','78 56 34 12']]) {
  test(`32-bit ${order} produces the documented wire order`, () => {
    assert.equal(hexBytes(reorderBytes(parseToolHex('12 34 56 78'),order)),expected);
  });
}
test('64-bit word reversal reverses complete registers and refuses partial words', () => {
  assert.equal(hexBytes(reorderBytes(parseToolHex('01 02 03 04 05 06 07 08'),'reverse-words')),'07 08 05 06 03 04 01 02');
  assert.throws(() => reorderBytes(parseToolHex('01 02 03'),'swap-bytes'));
  assert.throws(() => reorderBytes(parseToolHex('01 02'),'unknown'));
});
test('IEEE encodes known values and explicitly reports Float32 rounding', () => {
  assert.equal(hexBytes(encodeFloat('1',32,'normal').bytes),'3F 80 00 00');
  assert.equal(hexBytes(encodeFloat('-0',64,'normal').bytes),'80 00 00 00 00 00 00 00');
  assert.equal(encodeFloat('0.1',32,'normal').value,'0.10000000149011612');
  assert.equal(decodeFloat('00 00 80 3F',32,'reverse'),'1');
  assert.equal(decodeFloat('80 00 00 00 00 00 00 00',64,'normal'),'-0');
});
test('IEEE decodes special values but refuses malformed or overflowing finite input', () => {
  assert.equal(decodeFloat('7F 80 00 00',32,'normal'),'Infinity');
  assert.equal(decodeFloat('7F C0 00 00',32,'normal'),'NaN');
  for (const input of ['','1x','0x10','Infinity','NaN','1e40']) assert.throws(() => encodeFloat(input,32,'normal'));
  assert.throws(() => decodeFloat('00 00',32,'normal'));
});
test('bit masks use the full width and number bit zero as the least significant', () => {
  assert.deepEqual(bitMask('8001','0000',16,'view'),{hex:'8001',binary:'1000000000000001',setBits:[15,0]});
  assert.equal(bitMask('00F0','000F',16,'or').hex,'00FF');
  assert.equal(bitMask('FFFF','00FF',16,'and').hex,'00FF');
  assert.equal(bitMask('F0F0','FFFF',16,'xor').hex,'0F0F');
  assert.throws(() => bitMask('100','00',8,'view'));
});
test('ASCII preserves controls and makes them visible without silently using UTF-8', () => {
  assert.equal(hexBytes(encodeAscii('A\0\r\n\t\x7f')),'41 00 0D 0A 09 7F');
  assert.deepEqual(decodeAscii('41 00 0D 0A 09 7F'),{text:'A\0\r\n\t\x7f',escaped:'A\\x00\\r\\n\\t\\x7F'});
  assert.throws(() => encodeAscii('中文'));
  assert.throws(() => decodeAscii('80'));
  assert.throws(() => encodeAscii('a'.repeat(16385)));
});
test('BCD is exact, preserves identifiers and applies decimals without numeric rounding', () => {
  assert.equal(hexBytes(encodeBcd('001234',0,'big')),'00 12 34');
  assert.equal(hexBytes(encodeBcd('123',0,'little')),'23 01');
  assert.equal(hexBytes(encodeBcd('0012.34',2,'big')),'00 12 34');
  assert.equal(decodeBcd('34 12 00',2,'little'),'0012.34');
  assert.equal(decodeBcd('01',3,'big'),'0.001');
  assert.equal(decodeBcd('99'.repeat(64),0,'big'),'9'.repeat(128));
});
test('BCD refuses signs, invalid nibbles, excess decimals and oversized values', () => {
  for (const input of ['-1','+1','12.345','1e2','']) assert.throws(() => encodeBcd(input,2,'big'));
  for (const input of ['1A','FA','']) assert.throws(() => decodeBcd(input,0,'big'));
  assert.throws(() => encodeBcd('1'.repeat(129),0,'big'));
  assert.throws(() => decodeBcd('00',13,'big'));
});
const checkBytes=Uint8Array.from([49,50,51,52,53,54,55,56,57]);
for (const [id,expected] of [['crc8-smbus','F4'],['crc16-modbus','4B37'],['crc16-arc','BB3D'],['crc16-ibm3740','29B1'],['crc16-xmodem','31C3'],['crc16-kermit','2189'],['crc16-ibmsdlc','906E'],['crc32-isohdlc','CBF43926']]) {
  test(`${id} matches the independent CRC catalogue check for 123456789`, () => {
    assert.equal(calculateChecksum(checkBytes,id).hex,expected);
    assert.equal(checksumDetails(id).check,expected);
  });
}
test('Modbus known request produces low-byte-first CRC C5 CD', () => {
  const result=calculateChecksum(parseToolHex('01 03 00 00 00 0A'),'crc16-modbus');
  assert.equal(result.hex,'CDC5');
  assert.equal(result.littleEndian,'C5 CD');
  assert.equal(result.bigEndian,'CD C5');
});
test('simple checksums explicitly sum bytes and calculate the two complement LRC', () => {
  const bytes=parseToolHex('FF 02 03');
  assert.equal(calculateChecksum(bytes,'sum8').hex,'04');
  assert.equal(calculateChecksum(bytes,'sum16').hex,'0104');
  assert.equal(calculateChecksum(bytes,'xor8').hex,'FE');
  assert.equal(calculateChecksum(bytes,'lrc8').hex,'FC');
  assert.equal(calculateChecksum(new Uint8Array(),'crc16-modbus').hex,'FFFF');
  assert.throws(() => calculateChecksum(bytes,'CRC16'));
});
