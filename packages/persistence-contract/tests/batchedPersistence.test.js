import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchedPersistence } from '../src/batchedPersistence.js';

test('scheduled flush persists queued rows in FIFO order', async () => {
  const saved = [];
  const timers = createTimerHarness();
  const batcher = createBatchedPersistence({
    ...timers.options,
    persistBatch: async (rows) => saved.push(rows.map((row) => row.id)),
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });

  assert.equal(batcher.size(), 2);
  assert.equal(timers.scheduled[0].delay, 1000);
  await timers.scheduled[0].callback();
  assert.deepEqual(saved, [[1, 2]]);
  assert.equal(batcher.size(), 0);
});

test('reaching the default maximum batch size flushes immediately', async () => {
  const saved = [];
  const timers = createTimerHarness();
  const batcher = createBatchedPersistence({
    ...timers.options,
    persistBatch: async (rows) => saved.push(rows.map((row) => row.id)),
  });

  for (let id = 1; id <= 200; id += 1) batcher.enqueue({ id });
  await batcher.flush();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].length, 200);
  assert.equal(saved[0][0], 1);
  assert.equal(saved[0].at(-1), 200);
  assert.deepEqual(timers.cleared, [0]);
});

test('bounded queue drops the exact oldest rows and reports each overflow', async () => {
  const saved = [];
  const dropped = [];
  const timers = createTimerHarness();
  const batcher = createBatchedPersistence({
    ...timers.options,
    maxBatchSize: 10,
    maxQueueSize: 3,
    onDrop: (rows) => dropped.push(rows.map((row) => row.id)),
    persistBatch: async (rows) => saved.push(rows.map((row) => row.id)),
  });

  for (let id = 1; id <= 5; id += 1) batcher.enqueue({ id });
  await assert.rejects(batcher.flush(), { code: 'HISTORY_INCOMPLETE' });

  assert.deepEqual(dropped, [[1], [2]]);
  assert.deepEqual(saved, [[3, 4, 5]]);
});

test('asynchronous writes stay serialized across immediate flushes', async () => {
  const calls = [];
  const releases = [];
  let signalSecondStarted;
  const secondStarted = new Promise((resolve) => { signalSecondStarted = resolve; });
  let active = 0;
  let maximumActive = 0;
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    persistBatch: async (rows) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(rows[0].id);
      if (rows[0].id === 2) signalSecondStarted();
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
    },
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  await Promise.resolve();
  assert.deepEqual(calls, [1]);

  releases.shift()();
  await secondStarted;
  assert.deepEqual(calls, [1, 2]);
  releases.shift()();
  await batcher.flush();
  assert.equal(maximumActive, 1);
});

test('writes stay serialized when persistence synchronously enqueues another full batch', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  let batcher;

  batcher = createBatchedPersistence({
    maxBatchSize: 1,
    persistBatch: async (rows) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(rows[0].id);
      if (rows[0].id === 1) batcher.enqueue({ id: 2 });
      await Promise.resolve();
      active -= 1;
    },
  });

  batcher.enqueue({ id: 1 });
  await batcher.flush();

  assert.deepEqual(calls, [1, 2]);
  assert.equal(maximumActive, 1);
});

test('failed writes retry finitely with the injected delay', async () => {
  const retryAttempts = [];
  let attempts = 0;
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    maxRetries: 2,
    retryDelay: async (attempt) => retryAttempts.push(attempt),
    persistBatch: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('busy');
    },
  });

  batcher.enqueue({ id: 1 });
  await batcher.flush();

  assert.equal(attempts, 3);
  assert.deepEqual(retryAttempts, [1, 2]);
});

test('exhausted failures call onError once with the original rows and continue draining', async () => {
  const failures = [];
  const persisted = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    maxRetries: 0,
    onError: (error, rows) => failures.push({ error, rows }),
    persistBatch: async (rows) => {
      if (rows[0].id === 1) throw new Error('disk failed');
      persisted.push(rows[0].id);
    },
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  await assert.rejects(batcher.flush(), { code: 'HISTORY_INCOMPLETE' });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].error.message, 'disk failed');
  assert.deepEqual(failures[0].rows.map((row) => row.id), [1]);
  assert.deepEqual(persisted, [2]);
});

test('flush drains rows enqueued while a write is in progress before resolving', async () => {
  const saved = [];
  let releaseFirst;
  const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
  const batcher = createBatchedPersistence({
    maxBatchSize: 2,
    persistBatch: async (rows) => {
      saved.push(rows.map((row) => row.id));
      if (rows[0].id === 1) await firstWrite;
    },
  });

  batcher.enqueue({ id: 1 });
  const flushing = batcher.flush();
  batcher.enqueue({ id: 2 });
  batcher.enqueue({ id: 3 });
  releaseFirst();
  await flushing;

  assert.deepEqual(saved, [[1], [2, 3]]);
  assert.equal(batcher.size(), 0);
});

test('timer IDs equal to zero are cleared and only one timer is scheduled', async () => {
  const timers = createTimerHarness();
  const batcher = createBatchedPersistence({
    ...timers.options,
    persistBatch: async () => {},
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  assert.equal(timers.scheduled.length, 1);
  await batcher.flush();
  assert.deepEqual(timers.cleared, [0]);
});

test('dispose clears the timer, flushes the final batch, rejects enqueue, and is idempotent', async () => {
  const saved = [];
  const timers = createTimerHarness();
  const batcher = createBatchedPersistence({
    ...timers.options,
    persistBatch: async (rows) => saved.push(rows.map((row) => row.id)),
  });

  batcher.enqueue({ id: 1 });
  const disposing = batcher.dispose();

  assert.strictEqual(batcher.dispose(), disposing);
  assert.throws(() => batcher.enqueue({ id: 2 }), /disposed/i);
  await disposing;
  assert.deepEqual(timers.cleared, [0]);
  assert.deepEqual(saved, [[1]]);
  assert.equal(batcher.size(), 0);
  assert.strictEqual(batcher.dispose(), disposing);
});

test('dispose waits for an in-flight write and drains queued rows without concurrent writes', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    persistBatch: async (rows) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(rows[0].id);
      if (rows[0].id === 1) await firstWrite;
      active -= 1;
    },
  });

  batcher.enqueue({ id: 1 });
  await Promise.resolve();
  batcher.enqueue({ id: 2 });
  const disposing = batcher.dispose();
  assert.deepEqual(calls, [1]);

  releaseFirst();
  await disposing;

  assert.deepEqual(calls, [1, 2]);
  assert.equal(maximumActive, 1);
  assert.equal(batcher.size(), 0);
});

test('invalid options fail before scheduling or persistence', () => {
  assert.throws(() => createBatchedPersistence(), /persistBatch/);
  assert.throws(() => createBatchedPersistence({ persistBatch: 'nope' }), /persistBatch/);

  for (const [name, value] of [
    ['flushMs', 0],
    ['maxBatchSize', 1.5],
    ['maxQueueSize', -1],
    ['maxRetries', -1],
  ]) {
    assert.throws(
      () => createBatchedPersistence({ persistBatch: async () => {}, [name]: value }),
      new RegExp(name),
    );
  }
});

function createTimerHarness() {
  let nextId = 0;
  const scheduled = [];
  const cleared = [];

  return {
    scheduled,
    cleared,
    options: {
      schedule(callback, delay) {
        const timer = { id: nextId, callback, delay };
        nextId += 1;
        scheduled.push(timer);
        return timer.id;
      },
      clear(id) {
        cleared.push(id);
      },
    },
  };
}


test('background failures remain detectable with bounded summaries and no rejected timer', async () => {
  const timers = createTimerHarness();
  const batcher = createBatchedPersistence({ ...timers.options, maxRetries: 0,
    persistBatch: async () => { throw new Error('x'.repeat(10000)); } });
  batcher.enqueue({ id: 1 });
  await assert.doesNotReject(timers.scheduled[0].callback());
  await assert.rejects(batcher.flush(), (error) => (
    error.code === 'HISTORY_INCOMPLETE' && error.summary.rowCount === 1
    && error.summary.firstMessage.length === 256 && error.summary.latestMessage.length === 256
  ));
  await batcher.flush();
  await batcher.dispose();
});
