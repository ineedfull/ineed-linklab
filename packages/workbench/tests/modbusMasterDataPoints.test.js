import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeModbusMasterConfig } from '../src/model/modbusMasterConfig.js';
import { decodeModbusMasterPoint } from '../src/model/modbusMasterDataPoints.js';

test('decodes float32 with byte and word order then applies scale offset and decimals', () => {
  const reading = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'float32', length: 2,
    byteOrder: 'little-endian', wordOrder: 'low-first', bitIndex: null,
    scale: 0.1, valueOffset: -5, decimals: 2, minimum: 0, maximum: 100,
  }, [0x0000, 0x5c43], 3);

  assert.equal(reading.value, 17);
  assert.equal(reading.display, '17.00');
  assert.deepEqual(reading.raw, [0x0000, 0x5c43]);
  assert.equal(reading.quality, 'good');
});

test('decodes coil offsets and register bit indexes', () => {
  const coil = decodeModbusMasterPoint({
    enabled: true, offset: 2, dataType: 'boolean', bitIndex: null,
    scale: 1, valueOffset: 0,
  }, [false, false, true], 1);
  const statusBit = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'boolean', bitIndex: 5,
    scale: 1, valueOffset: 0,
  }, [0x0020], 3);

  assert.equal(coil.value, true);
  assert.equal(statusBit.value, true);
  assert.equal(statusBit.display, 'ON');
});

test('formats exact 64-bit integers without losing precision', () => {
  const unsigned = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'uint64', length: 4,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 1, valueOffset: 0, decimals: null, minimum: null, maximum: null,
  }, [0xffff, 0xffff, 0xffff, 0xffff], 3);
  const signed = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'int64', length: 4,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 1, valueOffset: 0, decimals: null, minimum: null, maximum: null,
  }, [0xffff, 0xffff, 0xffff, 0xfffe], 3);

  assert.equal(unsigned.value, '18446744073709551615');
  assert.equal(unsigned.display, '18446744073709551615');
  assert.equal(unsigned.quality, 'good');
  assert.equal(signed.value, '-2');
});

test('applies configured bounds to exact UInt64 and Int64 readings', () => {
  const base = {
    enabled: true, offset: 0, length: 4,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 1, valueOffset: 0, decimals: null,
  };
  const unsigned = decodeModbusMasterPoint({
    ...base, dataType: 'uint64', minimum: null, maximum: 100,
  }, [0x0000, 0x0000, 0x0000, 0x0065], 3);
  const signed = decodeModbusMasterPoint({
    ...base, dataType: 'int64', minimum: -1, maximum: null,
  }, [0xffff, 0xffff, 0xffff, 0xfffe], 3);

  assert.deepEqual(
    [unsigned.value, unsigned.display, unsigned.quality, unsigned.reason],
    ['101', '101', 'bad-value', '数值超出合理范围'],
  );
  assert.deepEqual(
    [signed.value, signed.display, signed.quality, signed.reason],
    ['-2', '-2', 'bad-value', '数值超出合理范围'],
  );
});

test('compares UInt64 readings against unsafe decimal-string bounds exactly', () => {
  const reading = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'uint64', length: 4,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 1, valueOffset: 0, decimals: null,
    minimum: null, maximum: '9007199254740995',
  }, [0x0020, 0x0000, 0x0000, 0x0004], 3);

  assert.deepEqual(
    [reading.value, reading.display, reading.quality, reading.reason],
    ['9007199254740996', '9007199254740996', 'bad-value', '数值超出合理范围'],
  );
});

test('compares scaled UInt64 readings against unsafe decimal-string bounds exactly', () => {
  const reading = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'uint64', length: 4,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 2, valueOffset: 0, decimals: null,
    minimum: null, maximum: '18014398509481991',
  }, [0x0020, 0x0000, 0x0000, 0x0004], 3);

  assert.equal(reading.value, 18_014_398_509_481_992);
  assert.equal(reading.quality, 'bad-value');
  assert.equal(reading.reason, '数值超出合理范围');
});

test('retains exact scaled UInt64 bounds through configuration normalization', () => {
  const normalized = normalizeModbusMasterConfig({
    requestGroups: [{
      id: 'group', name: '读取区', enabled: true, order: 0, unitId: 1,
      requests: [{
        id: 'request', name: '读取请求', enabled: true, order: 0,
        functionCode: 3, startAddress: 0, quantity: 4, intervalMs: 1000,
        dataPoints: [{
          id: 'point', key: 'point', name: '累计量', enabled: true, offset: 0,
          dataType: 'uint64', length: 4,
          byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
          scale: 0.1, valueOffset: 0, decimals: null,
          minimum: null, maximum: '900719925474099.59',
        }],
      }],
    }],
  });
  const point = normalized.requestGroups[0].requests[0].dataPoints[0];
  const reading = decodeModbusMasterPoint(
    point,
    [0x0020, 0x0000, 0x0000, 0x0004],
    3,
  );

  assert.equal(point.maximum, '900719925474099.59');
  assert.equal(reading.quality, 'bad-value');
  assert.equal(reading.reason, '数值超出合理范围');
});

test('marks out-of-range, unavailable and disabled values with explicit quality', () => {
  const base = {
    enabled: true, offset: 0, dataType: 'uint16', length: 1,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 1, valueOffset: 0, decimals: null, minimum: 0, maximum: 10,
  };
  assert.equal(decodeModbusMasterPoint(base, [11], 3).quality, 'bad-value');
  assert.equal(decodeModbusMasterPoint({ ...base, offset: 2 }, [1], 3).quality, 'bad-value');
  assert.equal(decodeModbusMasterPoint({ ...base, enabled: false }, [1], 3).quality, 'disabled');
});

test('decodes fixed-length ASCII strings from register responses', () => {
  const reading = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'string', length: 3,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 1, valueOffset: 0, decimals: null, minimum: null, maximum: null,
  }, [0x4142, 0x3132, 0], 4);

  assert.equal(reading.value, 'AB12');
  assert.equal(reading.display, 'AB12');
});

test('decodes multi-register strings using the configured low-first word order', () => {
  const reading = decodeModbusMasterPoint({
    enabled: true, offset: 0, dataType: 'string', length: 2,
    byteOrder: 'big-endian', wordOrder: 'low-first', bitIndex: null,
    scale: 1, valueOffset: 0, decimals: null, minimum: null, maximum: null,
  }, [0x4344, 0x4142], 3);

  assert.equal(reading.value, 'ABCD');
  assert.equal(reading.display, 'ABCD');
});
