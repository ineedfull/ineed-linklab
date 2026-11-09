import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyModbusDataOrder,
  modbusDataOrderCode,
  modbusDataOrderLabel,
  modbusDataOrderOptions,
} from '../src/model/modbusDataOrder.js';

test('data order maps every legacy byte and word order combination in both directions', () => {
  const combinations = [
    ['big-endian', 'high-first', 'ABCD'],
    ['little-endian', 'high-first', 'BADC'],
    ['big-endian', 'low-first', 'CDAB'],
    ['little-endian', 'low-first', 'DCBA'],
  ];

  for (const [byteOrder, wordOrder, code] of combinations) {
    assert.equal(modbusDataOrderCode({ byteOrder, wordOrder, dataType: 'float32', length: 2 }), code);
    assert.deepEqual(applyModbusDataOrder(code), { byteOrder, wordOrder });
  }
});

test('data order offers AB and BA for one-register values and hides ordering for booleans', () => {
  assert.deepEqual(modbusDataOrderOptions({ dataType: 'uint16', length: 1 }), [
    { value: 'AB', label: 'AB · 标准字节序' },
    { value: 'BA', label: 'BA · 字节交换' },
  ]);
  assert.deepEqual(modbusDataOrderOptions({ dataType: 'boolean', length: 1 }), []);
  assert.equal(modbusDataOrderCode({
    byteOrder: 'little-endian', wordOrder: 'low-first', dataType: 'int16', length: 1,
  }), 'BA');
  assert.deepEqual(applyModbusDataOrder('AB'), {
    byteOrder: 'big-endian', wordOrder: 'high-first',
  });
  assert.deepEqual(applyModbusDataOrder('BA'), {
    byteOrder: 'little-endian', wordOrder: 'high-first',
  });
});

test('multi-register values expose four orders and legacy invalid values fall back safely', () => {
  assert.deepEqual(modbusDataOrderOptions({ dataType: 'uint32', length: 2 }).map(({ value }) => value), [
    'ABCD', 'BADC', 'CDAB', 'DCBA',
  ]);
  assert.equal(modbusDataOrderCode({ dataType: 'float32', length: 2 }), 'ABCD');
  assert.equal(modbusDataOrderLabel({ dataType: 'float32', length: 2 }), 'ABCD · 标准顺序');
  assert.equal(modbusDataOrderLabel({
    byteOrder: 'little-endian', wordOrder: 'high-first', dataType: 'uint32', length: 2,
  }), 'BADC · 字节交换');
  assert.equal(modbusDataOrderLabel({ dataType: 'boolean', length: 1 }), '不适用');
});
