import assert from 'node:assert/strict';
import test from 'node:test';

import { createModbusPointHistoryCollector } from '../src/model/modbusPointHistoryCollector.js';

test('on-change capture stores first observation and value, quality, or reason changes', async () => {
  const saved = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => saved.push(...rows),
  });
  const first = pointBatch({ value: 42, raw: [42], display: '42' });

  collector.capture(first);
  first.points[0].name = 'Mutated outside';
  first.points[0].raw[0] = 99;
  collector.capture(pointBatch({ value: 42, raw: [42], display: '42' }));
  collector.capture(pointBatch({ value: 43, raw: [43], display: '43' }));
  collector.capture(pointBatch({
    value: 43, raw: [43], display: '43', quality: 'bad-value', reason: 'above range',
  }));
  collector.capture(pointBatch({
    value: 43, raw: [43], display: '43', quality: 'bad-value', reason: 'sensor invalid',
  }));
  await collector.flush();

  assert.equal(saved.length, 4);
  assert.deepEqual(saved[0], historyRow({ value: 42, raw: [42], displayValue: '42' }));
  assert.deepEqual(saved.map(({ value, quality, reason }) => [value, quality, reason]), [
    [42, 'good', null],
    [43, 'good', null],
    [43, 'bad-value', 'above range'],
    [43, 'bad-value', 'sensor invalid'],
  ]);
  await collector.dispose();
});

test('every-poll captures identical values while disabled history captures nothing', async () => {
  const saved = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => saved.push(...rows),
  });

  collector.capture(pointBatch({ historyMode: 'every-poll' }));
  collector.capture(pointBatch({ historyMode: 'every-poll' }));
  collector.capture(pointBatch({ saveHistory: false, pointId: 'disabled-history' }));
  await collector.flush();

  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(({ pointId }) => pointId), ['temperature', 'temperature']);
  await collector.dispose();
});

test('on-change identity keeps points distinct when IDs contain NUL characters', async () => {
  const saved = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => saved.push(...rows),
  });

  assert.equal(collector.capture(pointBatch({
    requestGroupId: 'group\u0000request', requestId: 'one', pointId: 'point',
  })), 1);
  assert.equal(collector.capture(pointBatch({
    requestGroupId: 'group', requestId: 'request\u0000one', pointId: 'point',
  })), 1);
  await collector.flush();

  assert.deepEqual(saved.map(({ requestGroupId, requestId, pointId }) => (
    [requestGroupId, requestId, pointId]
  )), [
    ['group\u0000request', 'one', 'point'],
    ['group', 'request\u0000one', 'point'],
  ]);
  await collector.dispose();
});

test('session changes and explicit configuration resets capture a fresh baseline', async () => {
  const saved = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => saved.push(...rows),
  });

  collector.capture(pointBatch());
  collector.capture(pointBatch());
  collector.capture(pointBatch({ sessionId: 'session-2' }));
  collector.capture(pointBatch({ sessionId: 'session-2' }));
  collector.reset('master-1');
  collector.capture(pointBatch({ sessionId: 'session-2' }));
  await collector.flush();

  assert.equal(saved.length, 3);
  await collector.dispose();
});

test('collector flushes at batch size or after the bounded delay', async () => {
  const clock = fakeClock();
  const batches = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => batches.push(rows),
    clock: clock.now,
    timers: clock,
  });

  collector.capture(pointBatch({ value: 1, raw: [1], display: '1', createdAt: 1 }));
  await clock.advance(999);
  assert.equal(batches.length, 0);
  await clock.advance(1);
  assert.deepEqual(batches.map((rows) => rows.length), [1]);

  for (let index = 2; index <= 200; index += 1) {
    collector.capture(pointBatch({
      pointId: `point-${index}`,
      pointKey: `point_${index}`,
      pointName: `Point ${index}`,
      value: index,
      raw: [index],
      display: String(index),
      createdAt: index,
    }));
  }
  assert.deepEqual(batches.map((rows) => rows.length), [1]);
  collector.capture(pointBatch({
    pointId: 'point-201', pointKey: 'point_201', pointName: 'Point 201',
    value: 201, raw: [201], display: '201', createdAt: 201,
  }));
  await flushMicrotasks();
  assert.deepEqual(batches.map((rows) => rows.length), [1, 200]);
  await collector.dispose();
});

test('bounded queue drops oldest pending rows and reports immutable status snapshots', async () => {
  const saved = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => saved.push(...rows),
    batchSize: 3_000,
  });

  for (let index = 1; index <= 2_002; index += 1) {
    collector.capture(pointBatch({
      pointId: `point-${index}`,
      pointKey: `point_${index}`,
      pointName: `Point ${index}`,
      value: index,
      raw: [index],
      display: String(index),
    }));
  }
  const snapshot = collector.getStatus();
  assert.deepEqual(snapshot, {
    pendingCount: 2_000,
    droppedCount: 2,
    failedBatchCount: 0,
    lastFlushedAt: null,
    lastError: null,
  });
  snapshot.pendingCount = 999;
  assert.equal(collector.getStatus().pendingCount, 2_000);

  await collector.flush();
  assert.equal(saved.length, 2_000);
  assert.equal(saved[0].pointId, 'point-3');
  assert.equal(saved.at(-1).pointId, 'point-2002');
  assert.equal(collector.getStatus().pendingCount, 0);
  await collector.dispose();
});

test('bounded queue includes the active write batch in its row limit', async () => {
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const saved = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => {
      markWriteStarted();
      await writeGate;
      saved.push(...rows);
    },
    batchSize: 2,
    maxPendingRows: 3,
  });

  collector.capture(pointBatch({ pointId: 'point-1' }));
  collector.capture(pointBatch({ pointId: 'point-2' }));
  await writeStarted;
  collector.capture(pointBatch({ pointId: 'point-3' }));
  collector.capture(pointBatch({ pointId: 'point-4' }));

  assert.equal(collector.getStatus().pendingCount, 3);
  assert.equal(collector.getStatus().droppedCount, 1);

  releaseWrite();
  await collector.flush();
  assert.deepEqual(saved.map(({ pointId }) => pointId), ['point-1', 'point-2', 'point-4']);
  await collector.dispose();
});

test('failed batches retry twice with bounded backoff and are then dropped', async () => {
  const clock = fakeClock();
  let calls = 0;
  const collector = createModbusPointHistoryCollector({
    recordBatch: async () => {
      calls += 1;
      throw new Error('database offline');
    },
    clock: clock.now,
    timers: clock,
  });
  collector.capture(pointBatch());

  const flushing = collector.flush();
  await flushMicrotasks();
  assert.equal(calls, 1);
  await clock.advance(99);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  await clock.advance(499);
  assert.equal(calls, 2);
  await clock.advance(1);
  await flushing;

  assert.equal(calls, 3);
  assert.deepEqual(collector.getStatus(), {
    pendingCount: 0,
    droppedCount: 0,
    failedBatchCount: 1,
    lastFlushedAt: null,
    lastError: 'database offline',
  });
  await collector.dispose();
});

test('dispose flushes accepted rows, is idempotent, and ignores later captures', async () => {
  const batches = [];
  const collector = createModbusPointHistoryCollector({
    recordBatch: async (rows) => batches.push(rows),
  });
  collector.capture(pointBatch());

  await collector.dispose();
  await collector.dispose();
  collector.capture(pointBatch({ value: 99, raw: [99], display: '99' }));
  await collector.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].value, 42);
});

function pointBatch(overrides = {}) {
  const {
    endpointId = 'master-1',
    sessionId = 'session-1',
    requestGroupId = 'environment',
    requestId = 'holding-registers',
    createdAt = 1_780_000_000_000,
    pointId = 'temperature',
    pointKey = 'room_temperature',
    pointName = 'Room temperature',
    ...pointOverrides
  } = overrides;
  return {
    endpointId,
    sessionId,
    requestGroupId,
    requestId,
    createdAt,
    points: [{
      id: pointId,
      key: pointKey,
      name: pointName,
      enabled: true,
      offset: 0,
      dataType: 'float32',
      length: 2,
      byteOrder: 'big-endian',
      wordOrder: 'high-first',
      bitIndex: null,
      scale: 1,
      valueOffset: 0,
      unit: 'C',
      decimals: 1,
      minimum: null,
      maximum: null,
      invalidPolicy: 'mark-bad',
      saveHistory: true,
      historyMode: 'on-change',
      raw: [42],
      value: 42,
      display: '42.0',
      quality: 'good',
      reason: null,
      ...pointOverrides,
    }],
  };
}

function historyRow(overrides = {}) {
  return {
    endpointId: 'master-1',
    requestGroupId: 'environment',
    requestId: 'holding-registers',
    pointId: 'temperature',
    pointKey: 'room_temperature',
    pointName: 'Room temperature',
    dataType: 'float32',
    unit: 'C',
    raw: [42],
    value: 42,
    numericValue: 42,
    displayValue: '42.0',
    quality: 'good',
    reason: null,
    createdAt: 1_780_000_000_000,
    ...overrides,
  };
}

function fakeClock() {
  let time = 0;
  let nextId = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay = 0) {
      const id = ++nextId;
      tasks.set(id, { at: time + Math.max(0, delay), callback });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    async advance(milliseconds) {
      const target = time + milliseconds;
      while (true) {
        const next = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) break;
        tasks.delete(next[0]);
        time = next[1].at;
        next[1].callback();
        await flushMicrotasks();
      }
      time = target;
      await flushMicrotasks();
    },
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
