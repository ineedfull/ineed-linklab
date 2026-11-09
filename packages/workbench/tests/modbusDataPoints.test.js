import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modbusDataPointRawBytes,
  modbusPointLength,
  normalizeModbusDataPoints,
  readModbusDataPoint,
  validateModbusDataPoints,
  writeModbusDataPoint,
} from '../src/model/modbusDataPoints.js';

test('raw byte context follows the configured byte and word order', () => {
  assert.deepEqual(modbusDataPointRawBytes({
    dataType: 'float32', byteOrder: 'big-endian', wordOrder: 'high-first',
  }, [0x41cc, 0x0000]), [0x41, 0xcc, 0x00, 0x00]);
  assert.deepEqual(modbusDataPointRawBytes({
    dataType: 'float32', byteOrder: 'little-endian', wordOrder: 'low-first',
  }, [0x0000, 0xcc41]), [0x41, 0xcc, 0x00, 0x00]);
  assert.deepEqual(modbusDataPointRawBytes({ dataType: 'boolean' }, [true]), [1]);
  assert.deepEqual(modbusDataPointRawBytes({ dataType: 'uint16' }, []), []);
});

test('business point normalization derives fixed register lengths and preserves legacy empty configs', () => {
  assert.deepEqual(normalizeModbusDataPoints(), []);
  assert.equal(modbusPointLength('float32', 9), 2);
  assert.equal(modbusPointLength('ascii', 6), 6);
  assert.deepEqual(normalizeModbusDataPoints([{
    id: 'temperature', name: '出水温度', group: '温度', area: 'holdingRegisters',
    address: 100, dataType: 'int16', length: 8, scale: 0.1, offset: -20, unit: '℃',
  }])[0], {
    id: 'temperature', name: '出水温度', group: '温度', area: 'holdingRegisters',
    address: 100, dataType: 'int16', length: 1, byteOrder: 'big-endian',
    wordOrder: 'high-first', scale: 0.1, offset: -20, unit: '℃', access: 'read-write',
  });
});

test('business point validation rejects overlaps and points outside the raw data area', () => {
  const errors = validateModbusDataPoints([
    { name: 'A', area: 'holdingRegisters', address: 10, dataType: 'uint32', scale: 1, offset: 0 },
    { name: 'B', area: 'holdingRegisters', address: 11, dataType: 'uint16', scale: 1, offset: 0 },
    { name: 'C', area: 'inputRegisters', address: 30, dataType: 'float32', scale: 1, offset: 0 },
  ], {
    holdingRegisters: { start: 0, count: 100 },
    inputRegisters: { start: 0, count: 31 },
  });
  assert.equal(errors['dataPoint-1-address'], '该地址范围与同一数据区的其他业务点重叠。');
  assert.equal(errors['dataPoint-2-address'], '数据点必须位于已配置的数据区范围内。');
});

test('business values round-trip through register byte order, word order, scale and offset', () => {
  const point = {
    name: '压力', area: 'holdingRegisters', address: 20, dataType: 'float32',
    byteOrder: 'little-endian', wordOrder: 'low-first', scale: 0.1, offset: -5,
  };
  const words = writeModbusDataPoint(point, 12.5);
  const decoded = readModbusDataPoint(point, {
    areas: { holdingRegisters: { start: 20, values: words } },
  });
  assert.equal(decoded.available, true);
  assert.ok(Math.abs(decoded.value - 12.5) < 0.0001);
});

test('ascii and boolean business values encode into their native Modbus areas', () => {
  const textPoint = {
    name: '型号', area: 'inputRegisters', address: 0, dataType: 'ascii', length: 3,
    byteOrder: 'big-endian', wordOrder: 'high-first', scale: 1, offset: 0,
  };
  const textWords = writeModbusDataPoint(textPoint, 'AB12');
  assert.equal(readModbusDataPoint(textPoint, {
    areas: { inputRegisters: { start: 0, values: textWords } },
  }).value, 'AB12');
  const lowFirstTextPoint = { ...textPoint, length: 2, wordOrder: 'low-first' };
  const lowFirstWords = writeModbusDataPoint(lowFirstTextPoint, 'ABCD');
  assert.deepEqual(lowFirstWords, [0x4344, 0x4142]);
  assert.deepEqual(modbusDataPointRawBytes(lowFirstTextPoint, lowFirstWords), [0x41, 0x42, 0x43, 0x44]);
  assert.equal(readModbusDataPoint(lowFirstTextPoint, {
    areas: { inputRegisters: { start: 0, values: lowFirstWords } },
  }).value, 'ABCD');
  assert.deepEqual(writeModbusDataPoint({
    name: '启动', area: 'coils', address: 0, dataType: 'boolean', scale: 1, offset: 0,
  }, true), [true]);
});
