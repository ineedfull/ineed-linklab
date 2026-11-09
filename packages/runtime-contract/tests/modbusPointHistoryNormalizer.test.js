import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeModbusPointHistoryQuery,
  normalizeModbusPointHistoryRow,
  normalizeModbusPointHistoryRows,
  normalizeModbusPointSeriesQuery,
} from '../src/index.js';

function validRow(overrides = {}) {
  return {
    endpointId: 'master-1',
    requestGroupId: 'environment',
    requestId: 'holding-registers',
    pointId: 'temperature',
    pointKey: 'room_temperature',
    pointName: 'Room temperature',
    dataType: 'float32',
    unit: 'C',
    raw: [0x41cc, 0x0000],
    value: 25.5,
    numericValue: 25.5,
    displayValue: '25.5',
    quality: 'good',
    reason: null,
    createdAt: 1_780_000_000_000,
    ...overrides,
  };
}

const point = Object.freeze({
  requestGroupId: 'environment', requestId: 'holding-registers', pointId: 'temperature',
});

test('normalizes immutable lossless history row snapshots', () => {
  const source = validRow({ value: '18446744073709551615', numericValue: null });
  const row = normalizeModbusPointHistoryRow(source);
  source.raw[0] = 0;
  source.value = 'changed';

  assert.deepEqual(row, validRow({ value: '18446744073709551615', numericValue: null }));
  assert.equal(Object.isFrozen(row), true);
  assert.equal(Object.isFrozen(row.raw), true);
  assert.throws(() => { row.raw[0] = 0; }, TypeError);
});

test('normalizes a dense batch and rejects malformed history rows atomically', () => {
  const rows = normalizeModbusPointHistoryRows([
    validRow(),
    validRow({ pointId: 'enabled', dataType: 'boolean', raw: [true], value: true,
      numericValue: 1, displayValue: 'ON' }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(Object.isFrozen(rows), true);

  const malformed = [validRow(), validRow({ quality: 'unknown' })];
  assert.throws(() => normalizeModbusPointHistoryRows(malformed), /quality/i);
  assert.equal(malformed.length, 2);
});

test('rejects unsafe identities, timestamps, numeric projections, and JSON values', () => {
  const valueWithSymbol = { status: 'ok' };
  valueWithSymbol[Symbol('hidden')] = true;
  const invalidRows = [
    validRow({ endpointId: '' }),
    validRow({ pointId: 'x'.repeat(129) }),
    validRow({ createdAt: Number.MAX_SAFE_INTEGER + 1 }),
    validRow({ numericValue: Number.POSITIVE_INFINITY }),
    validRow({ raw: [1, Number.NaN] }),
    validRow({ value: 1n }),
    validRow({ value: valueWithSymbol }),
    validRow({ dataType: 'decimal128' }),
  ];
  for (const row of invalidRows) {
    assert.throws(() => normalizeModbusPointHistoryRow(row), TypeError);
  }
});

test('detail query uses composite point identities and bounded paging defaults', () => {
  const query = normalizeModbusPointHistoryQuery({
    endpointId: 'master-1', points: [point],
    from: 100, to: 200, page: 0, pageSize: 10_000,
  });
  assert.deepEqual(query, {
    endpointId: 'master-1', points: [point], from: 100, to: 200, page: 1, pageSize: 200,
  });
  assert.equal(Object.isFrozen(query.points[0]), true);

  assert.throws(() => normalizeModbusPointHistoryQuery({
    endpointId: 'master-1', pointIds: ['temperature'], from: 100, to: 200,
  }), /unknown or missing fields/i);
  assert.throws(() => normalizeModbusPointHistoryQuery({
    endpointId: 'master-1', points: [point], from: 201, to: 200,
  }), /from.*to/i);
});

test('series query requires one to six composite identities and caps buckets', () => {
  assert.deepEqual(normalizeModbusPointSeriesQuery({
    endpointId: 'master-1', points: [point], from: 100, to: 200, bucketCount: 50_000,
  }), {
    endpointId: 'master-1', points: [point], from: 100, to: 200, bucketCount: 2_000,
  });

  assert.throws(() => normalizeModbusPointSeriesQuery({
    endpointId: 'master-1', points: [], from: 100, to: 200, bucketCount: 100,
  }), /one to six/i);
  assert.throws(() => normalizeModbusPointSeriesQuery({
    endpointId: 'master-1',
    points: Array.from({ length: 7 }, (_, index) => ({ ...point, pointId: `point-${index}` })),
    from: 100, to: 200, bucketCount: 100,
  }), /one to six/i);
  assert.throws(() => normalizeModbusPointSeriesQuery({
    endpointId: 'master-1', points: [{ requestId: 'request', pointId: 'point' }],
    from: 100, to: 200, bucketCount: 100,
  }), /point identity/i);
});
