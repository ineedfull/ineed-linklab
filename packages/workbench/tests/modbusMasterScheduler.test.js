import assert from 'node:assert/strict';
import test from 'node:test';

import { createModbusMasterScheduler } from '../src/model/modbusMasterScheduler.js';

test('scheduler serializes due requests by group and request order and enforces the minimum gap', async () => {
  const clock = fakeClock();
  const first = deferred();
  const calls = [];
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: (request) => {
      calls.push(request);
      if (calls.length === 1) return first.promise;
      return Promise.resolve(transaction(request, [20]));
    },
  });
  scheduler.start(context({
    scheduler: { minGapMs: 50, autoStart: false },
    requestGroups: [group('later', 2), group('first', 1)],
  }));

  await clock.advance(0);
  assert.deepEqual(calls.map(({ requestGroupId, requestId }) => [requestGroupId, requestId]), [
    ['first', 'first-request'],
  ]);
  first.resolve(transaction(calls[0], [10]));
  await flush();
  await clock.advance(49);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.deepEqual(calls.map(({ requestGroupId, requestId }) => [requestGroupId, requestId]), [
    ['first', 'first-request'], ['later', 'later-request'],
  ]);
  scheduler.dispose();
});

test('scheduler keeps request identities distinct when group and request IDs contain NUL', async () => {
  const clock = fakeClock();
  const calls = [];
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (operation) => {
      calls.push([operation.requestGroupId, operation.requestId]);
      return transaction(operation, [1]);
    },
  });
  scheduler.start(context({
    requestGroups: [
      group('group\u0000request', 0, { requests: [request('one', 0)] }),
      group('group', 1, { requests: [request('request\u0000one', 0)] }),
    ],
  }));

  await clock.advance(0);
  await flush(8);
  await clock.advance(0);

  assert.deepEqual(calls, [
    ['group\u0000request', 'one'],
    ['group', 'request\u0000one'],
  ]);
  scheduler.dispose();
});

test('scheduler applies inherited retry settings and records one successful cycle', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary failure');
      return transaction(request, [42]);
    },
  });
  scheduler.start(context({
    retryCount: 2,
    retryIntervalMs: 0,
    requestGroups: [group('read', 0)],
  }));

  await clock.advance(0);
  await flush(8);
  const state = scheduler.getStatus('master-1').groups.read.requests['read-request'];
  assert.equal(attempts, 3);
  assert.equal(state.successCount, 1);
  assert.equal(state.failureCount, 0);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastError, null);
  scheduler.dispose();
});

test('scheduler does not retry a connection-level failure after native session retirement', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async () => {
      attempts += 1;
      const error = new Error('connection closed');
      error.code = 'IO_ERROR';
      throw error;
    },
  });
  scheduler.start(context({
    retryCount: 2,
    retryIntervalMs: 0,
    requestGroups: [group('read', 0)],
  }));

  await clock.advance(0);
  await flush(8);

  assert.equal(attempts, 1);
  assert.equal(scheduler.getStatus('master-1').groups.read.requests['read-request'].failureCount, 1);
  scheduler.dispose();
});

test('scheduler retries a Modbus exception because the native connection remains usable', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('illegal data address');
        error.code = 'MODBUS_EXCEPTION';
        throw error;
      }
      return transaction(request, [42]);
    },
  });
  scheduler.start(context({
    retryCount: 2,
    retryIntervalMs: 0,
    requestGroups: [group('read', 0)],
  }));

  await clock.advance(0);
  await flush(8);

  const state = scheduler.getStatus('master-1').groups.read.requests['read-request'];
  assert.equal(attempts, 3);
  assert.equal(state.successCount, 1);
  assert.equal(state.failureCount, 0);
  scheduler.dispose();
});

test('exhausted requests mark group points as communication failures without stopping peers', async () => {
  const clock = fakeClock();
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      if (request.requestGroupId === 'failed') throw new Error('device offline');
      return transaction(request, [7]);
    },
  });
  scheduler.start(context({
    scheduler: { minGapMs: 0, autoStart: false },
    requestGroups: [group('failed', 0), group('healthy', 1)],
  }));

  await clock.advance(0);
  await flush(8);
  await clock.advance(0);
  await flush(8);
  const status = scheduler.getStatus('master-1');
  assert.equal(status.groups.failed.requests['failed-request'].failureCount, 1);
  assert.equal(status.groups.failed.requests['failed-request'].points['failed-point'].quality, 'bad-communication');
  assert.equal(status.groups.healthy.requests['healthy-request'].points['healthy-point'].value, 7);
  assert.deepEqual(status.records.map(({ groupId, requestId, success }) => [groupId, requestId, success]), [
    ['healthy', 'healthy-request', true], ['failed', 'failed-request', false],
  ]);
  scheduler.dispose();
});

test('keep-last-good preserves the last value while reporting a later communication failure', async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      calls += 1;
      if (calls === 1) return transaction(request, [42]);
      throw new Error('device offline');
    },
  });
  scheduler.start(context({
    requestGroups: [group('read', 0, {
      intervalMs: 100,
      dataPoints: [{
        ...group('template', 0).requests[0].dataPoints[0],
        id: 'retained', key: 'retained', invalidPolicy: 'keep-last-good',
      }],
    })],
  }));

  await clock.advance(0);
  await flush();
  await clock.advance(100);
  await flush();

  const reading = scheduler.getStatus('master-1').groups.read.requests['read-request'].points.retained;
  assert.equal(reading.value, 42);
  assert.equal(reading.display, '42');
  assert.equal(reading.quality, 'bad-communication');
  assert.match(reading.reason, /device offline/);
  scheduler.dispose();
});

test('keep-last-good never retains a value that was already outside its valid range', async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      calls += 1;
      if (calls === 1) return transaction(request, [42]);
      throw new Error('device offline');
    },
  });
  scheduler.start(context({
    requestGroups: [group('read', 0, {
      intervalMs: 100,
      dataPoints: [{
        ...group('template', 0).requests[0].dataPoints[0],
        id: 'invalid', key: 'invalid', maximum: 10, invalidPolicy: 'keep-last-good',
      }],
    })],
  }));

  await clock.advance(0);
  await flush();
  assert.equal(scheduler.getStatus('master-1').groups.read.requests['read-request'].points.invalid.quality, 'bad-value');
  await clock.advance(100);
  await flush();

  const reading = scheduler.getStatus('master-1').groups.read.requests['read-request'].points.invalid;
  assert.equal(reading.value, null);
  assert.equal(reading.quality, 'bad-communication');
  assert.doesNotMatch(reading.reason, /保留上次正常值/);
  scheduler.dispose();
});

test('failed group summaries retain native transaction duration when available', async () => {
  const scheduler = createModbusMasterScheduler({
    execute: async (request) => {
      const error = new Error('device offline');
      error.transaction = { ...transaction(request, []), success: false, durationMs: 37 };
      throw error;
    },
  });

  const summary = await scheduler.runGroup({
    ...context(),
    config: { ...context().config, requestGroups: [group('read', 0)] },
    groupId: 'read',
  });

  assert.equal(summary.result, 'failed');
  assert.equal(scheduler.getStatus('master-1').records[0].durationMs, 37);
  scheduler.dispose();
});

test('stopping a scheduler cancels future group runs', async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      calls += 1;
      return transaction(request, [calls]);
    },
  });
  scheduler.start(context({ requestGroups: [group('read', 0, { intervalMs: 100 })] }));
  await clock.advance(0);
  await flush();
  scheduler.stop('master-1', 'session-1');
  await clock.advance(1000);

  assert.equal(calls, 1);
  assert.equal(scheduler.getStatus('master-1').active, false);
});

test('stopping a scheduler during retry delay prevents the retry and late status updates', async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async () => {
      calls += 1;
      throw new Error('device offline');
    },
  });
  scheduler.start(context({
    retryCount: 2,
    retryIntervalMs: 100,
    requestGroups: [group('read', 0)],
  }));

  await clock.advance(0);
  assert.equal(calls, 1);
  scheduler.stop('master-1', 'session-1');
  await clock.advance(1000);

  const state = scheduler.getStatus('master-1');
  assert.equal(calls, 1);
  assert.equal(state.active, false);
  assert.equal(state.groups.read.requests['read-request'].failureCount, 0);
  assert.equal(state.records.length, 0);
});

test('manual group runs obey the same minimum gap as scheduled requests', async () => {
  const clock = fakeClock();
  const calls = [];
  const config = context({
    scheduler: { minGapMs: 50, autoStart: false },
    requestGroups: [group('read', 0)],
  }).config;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      calls.push(clock.now());
      return transaction(request, [calls.length]);
    },
  });
  scheduler.start({ endpointId: 'master-1', sessionId: 'session-1', config });
  await clock.advance(0);
  await flush();

  const manual = scheduler.runGroup({
    endpointId: 'master-1', sessionId: 'session-1', config, groupId: 'read',
  });
  await flush();
  assert.deepEqual(calls, [0]);
  await clock.advance(49);
  assert.deepEqual(calls, [0]);
  await clock.advance(1);
  await manual;

  assert.deepEqual(calls, [0, 50]);
  scheduler.dispose();
});

test('immediate reads and writes use the endpoint queue and minimum gap', async () => {
  const clock = fakeClock();
  const calls = [];
  const config = context({
    scheduler: { minGapMs: 50, autoStart: false },
    requestGroups: [group('read', 0)],
  }).config;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      calls.push({ at: clock.now(), request });
      return transaction(request, request.values.length ? request.values : [1]);
    },
  });
  await scheduler.runGroup({
    endpointId: 'master-1', sessionId: 'session-1', config, groupId: 'read',
  });

  const writing = scheduler.executeImmediate({
    endpointId: 'master-1', sessionId: 'session-1', config,
    request: { functionCode: 6, unitId: 1, address: 20, quantity: 1, values: [9] },
  });
  await flush();
  assert.equal(calls.length, 1);
  await clock.advance(50);
  await writing;

  assert.equal(calls[1].at, 50);
  assert.deepEqual(calls[1].request, {
    endpointId: 'master-1', expectedSessionId: 'session-1', functionCode: 6, unitId: 1,
    address: 20, quantity: 1, values: [9],
  });
  scheduler.dispose();
});

test('stopping also cancels a manual group waiting to retry', async () => {
  const clock = fakeClock();
  let calls = 0;
  const config = context({
    retryCount: 2,
    retryIntervalMs: 100,
    requestGroups: [group('read', 0)],
  }).config;
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async () => {
      calls += 1;
      throw new Error('device offline');
    },
  });

  const manual = scheduler.runGroup({
    endpointId: 'master-1', sessionId: 'session-1', config, groupId: 'read',
  });
  await flush();
  assert.equal(calls, 1);
  assert.equal(scheduler.stop('master-1', 'session-1'), true);
  await clock.advance(1000);
  await manual;

  assert.equal(calls, 1);
  assert.equal(scheduler.getStatus('master-1').records.length, 0);
});

test('runGroup executes enabled requests in a disabled scheduler group and updates decoded data', async () => {
  const scheduler = createModbusMasterScheduler({
    execute: async (request) => transaction(request, [0x4120, 0]),
  });
  const config = {
    ...context().config,
    requestGroups: [group('manual', 0, {
      groupEnabled: false,
      dataPoints: [{
        id: 'temperature', key: 'temperature', name: '温度', enabled: true,
        offset: 0, dataType: 'float32', length: 2, byteOrder: 'big-endian',
        wordOrder: 'high-first', bitIndex: null, scale: 1, valueOffset: 0,
        unit: '℃', decimals: 1, minimum: null, maximum: null,
        invalidPolicy: 'mark-bad', saveHistory: false,
      }],
    })],
  };

  const result = await scheduler.runGroup({
    endpointId: 'master-1', sessionId: 'session-1', config, groupId: 'manual',
  });
  assert.equal(result.result, 'success');
  assert.equal(result.results[0].transaction.values[0], 0x4120);
  assert.equal(scheduler.getStatus('master-1').groups.manual.requests['manual-request'].points.temperature.display, '10.0');
  scheduler.dispose();
});

test('runGroup reports skipped when the group has no enabled requests', async () => {
  let calls = 0;
  const scheduler = createModbusMasterScheduler({
    execute: async () => { calls += 1; },
  });
  const config = context({
    requestGroups: [group('parked', 0, {
      requests: [request('disabled', 0, { enabled: false })],
    })],
  }).config;

  const result = await scheduler.runGroup({
    endpointId: 'master-1', sessionId: 'session-1', config, groupId: 'parked',
  });

  assert.equal(calls, 0);
  assert.equal(result.result, 'skipped');
  assert.deepEqual(result.results, []);
  assert.equal(scheduler.getStatus('master-1').groups.parked.lastResult, 'skipped');
  scheduler.dispose();
});

test('requests in one group keep independent completion-based polling intervals', async () => {
  const clock = fakeClock();
  const calls = [];
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (operation) => {
      calls.push([clock.now(), operation.requestId]);
      return transaction(operation, [1]);
    },
  });
  scheduler.start(context({
    requestGroups: [group('boiler', 0, {
      requests: [
        request('fast', 0, { intervalMs: 100 }),
        request('slow', 1, { functionCode: 4, intervalMs: 250 }),
      ],
    })],
  }));

  await clock.advance(0);
  await clock.advance(100);
  await clock.advance(100);
  await clock.advance(50);

  assert.deepEqual(calls, [
    [0, 'fast'], [0, 'slow'], [100, 'fast'], [200, 'fast'], [250, 'slow'],
  ]);
  scheduler.dispose();
});

test('runRequest executes one disabled request even when its parent group is disabled', async () => {
  const calls = [];
  const config = context({
    requestGroups: [group('boiler', 0, {
      groupEnabled: false,
      requests: [request('manual', 0, { enabled: false })],
    })],
  }).config;
  const scheduler = createModbusMasterScheduler({
    execute: async (operation) => {
      calls.push(operation);
      return transaction(operation, [9]);
    },
  });

  const result = await scheduler.runRequest({
    endpointId: 'master-1', sessionId: 'session-1', config,
    groupId: 'boiler', requestId: 'manual',
  });

  assert.equal(result.values[0], 9);
  assert.deepEqual(calls.map(({ requestGroupId, requestId }) => [requestGroupId, requestId]), [
    ['boiler', 'manual'],
  ]);
  scheduler.dispose();
});

test('runGroup continues after child failure and records a partial aggregate result', async () => {
  const config = context({
    requestGroups: [group('boiler', 0, {
      groupEnabled: false,
      requests: [request('failed', 0), request('healthy', 1, { functionCode: 4 })],
    })],
  }).config;
  const scheduler = createModbusMasterScheduler({
    execute: async (operation) => {
      if (operation.requestId === 'failed') throw new Error('device offline');
      return transaction(operation, [7]);
    },
  });

  const summary = await scheduler.runGroup({
    endpointId: 'master-1', sessionId: 'session-1', config, groupId: 'boiler',
  });

  assert.equal(summary.result, 'partial');
  assert.deepEqual(summary.results.map(({ requestId, success }) => [requestId, success]), [
    ['failed', false], ['healthy', true],
  ]);
  assert.equal(scheduler.getStatus('master-1').groups.boiler.lastResult, 'partial');
  scheduler.dispose();
});

test('reconcile replaces an active job when persisted request-group configuration changes', async () => {
  const clock = fakeClock();
  const calls = [];
  const scheduler = createModbusMasterScheduler({
    clock: clock.now,
    timers: clock,
    execute: async (request) => {
      calls.push(request.requestGroupId);
      return transaction(request, [1]);
    },
  });
  const reconcile = (requestGroups) => scheduler.reconcile({
    endpoints: [{
      id: 'master-1', transport: 'modbus-tcp-master',
      config: context({
        scheduler: { minGapMs: 0, autoStart: true }, requestGroups,
      }).config,
    }],
    operations: new Map([['master-1', { sessionId: 'session-1' }]]),
    statuses: new Map([['master-1', { status: 'open' }]]),
  });

  reconcile([group('old', 0)]);
  await clock.advance(0);
  reconcile([group('new', 0)]);
  await clock.advance(0);

  assert.deepEqual(calls, ['old', 'new']);
  assert.equal(scheduler.getStatus('master-1').groups.old, undefined);
  assert.ok(scheduler.getStatus('master-1').groups.new);
  scheduler.dispose();
});

test('scheduler publishes one immutable point outcome batch after final retry success', async () => {
  let attempts = 0;
  const batches = [];
  const scheduler = createModbusMasterScheduler({
    clock: () => 1_700_000_000_000,
    execute: async (operation) => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary failure');
      return { ...transaction(operation, [42]), createdAt: 1_700_000_000_123 };
    },
    onPointOutcomes: (batch) => batches.push(batch),
  });
  const config = context({
    retryCount: 2,
    requestGroups: [group('read', 0, {
      dataPoints: [{
        ...request('template', 0).dataPoints[0],
        id: 'temperature', key: 'temperature', name: 'Temperature',
        saveHistory: true, historyMode: 'every-poll',
      }],
    })],
  }).config;

  await scheduler.runRequest({
    endpointId: 'master-1', sessionId: 'session-1', config,
    groupId: 'read', requestId: 'read-request',
  });

  assert.equal(attempts, 3);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], {
    endpointId: 'master-1',
    sessionId: 'session-1',
    requestGroupId: 'read',
    requestId: 'read-request',
    createdAt: 1_700_000_000_123,
    points: [{
      id: 'temperature', key: 'temperature', name: 'Temperature', enabled: true,
      offset: 0, dataType: 'uint16', length: 1, byteOrder: 'big-endian',
      wordOrder: 'high-first', bitIndex: null, scale: 1, valueOffset: 0,
      unit: '', decimals: null, minimum: null, maximum: null,
      invalidPolicy: 'mark-bad', saveHistory: true, historyMode: 'every-poll',
      raw: [42], value: 42, display: '42', quality: 'good', reason: null,
    }],
  });

  batches[0].points[0].raw[0] = 99;
  batches[0].points[0].name = 'Mutated';
  const reading = scheduler.getStatus('master-1').groups.read.requests['read-request'].points.temperature;
  assert.equal(reading.raw[0], 42);
  assert.equal(config.requestGroups[0].requests[0].dataPoints[0].name, 'Temperature');
  scheduler.dispose();
});

test('scheduler publishes one final communication failure and excludes disabled points', async () => {
  let attempts = 0;
  const batches = [];
  const scheduler = createModbusMasterScheduler({
    clock: () => 1_700_000_000_500,
    execute: async () => {
      attempts += 1;
      throw new Error(`device offline ${attempts}`);
    },
    onPointOutcomes: (batch) => batches.push(batch),
  });
  const active = {
    ...request('template', 0).dataPoints[0],
    id: 'active', key: 'active', name: 'Active', saveHistory: true,
  };
  const disabled = {
    ...active, id: 'disabled', key: 'disabled', name: 'Disabled', enabled: false,
  };
  const config = context({
    retryCount: 2,
    requestGroups: [group('read', 0, { dataPoints: [active, disabled] })],
  }).config;

  const summary = await scheduler.runGroup({
    endpointId: 'master-1', sessionId: 'session-1', config, groupId: 'read',
  });

  assert.equal(summary.result, 'failed');
  assert.equal(attempts, 3);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].createdAt, 1_700_000_000_500);
  assert.deepEqual(batches[0].points.map(({ id }) => id), ['active']);
  assert.equal(batches[0].points[0].quality, 'bad-communication');
  assert.equal(batches[0].points[0].reason, 'device offline 3');
  scheduler.dispose();
});

test('point outcome observer failures do not affect request execution or later scheduling', async () => {
  let observerCalls = 0;
  const scheduler = createModbusMasterScheduler({
    execute: async (operation) => transaction(operation, [observerCalls + 1]),
    onPointOutcomes: () => {
      observerCalls += 1;
      if (observerCalls === 1) throw new Error('observer failed synchronously');
      return Promise.reject(new Error('observer failed asynchronously'));
    },
  });
  const config = context({ requestGroups: [group('read', 0)] }).config;

  const first = await scheduler.runRequest({
    endpointId: 'master-1', sessionId: 'session-1', config,
    groupId: 'read', requestId: 'read-request',
  });
  const second = await scheduler.runRequest({
    endpointId: 'master-1', sessionId: 'session-1', config,
    groupId: 'read', requestId: 'read-request',
  });
  await flush();

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(observerCalls, 2);
  assert.equal(scheduler.getStatus('master-1').groups.read.requests['read-request'].successCount, 2);
  scheduler.dispose();
});

function context(overrides = {}) {
  return {
    endpointId: 'master-1',
    sessionId: 'session-1',
    config: {
      enabled: true, timeoutMs: 1000, retryCount: 0, retryIntervalMs: 0,
      scheduler: { minGapMs: 0, autoStart: false }, requestGroups: [],
      ...overrides,
    },
  };
}

function group(id, order, overrides = {}) {
  const {
    requests,
    groupEnabled = true,
    description = '',
    unitId = 1,
    ...requestOverrides
  } = overrides;
  return {
    id, name: id, description, enabled: groupEnabled, order, unitId,
    requests: requests ?? [request(`${id}-request`, 0, {
      startAddress: order,
      ...requestOverrides,
    })],
  };
}

function request(id, order, overrides = {}) {
  return {
    id, name: id, enabled: true, order, functionCode: 3,
    startAddress: order, quantity: 1, intervalMs: 1000,
    timeoutMs: null, retryCount: null, retryIntervalMs: null,
    dataPoints: [{
      id: `${id.replace(/-request$/, '')}-point`, key: `${id.replace(/-request$/, '')}_point`,
      name: id, enabled: true,
      offset: 0, dataType: 'uint16', length: 1, byteOrder: 'big-endian',
      wordOrder: 'high-first', bitIndex: null, scale: 1, valueOffset: 0,
      unit: '', decimals: null, minimum: null, maximum: null,
      invalidPolicy: 'mark-bad', saveHistory: false, historyMode: 'on-change',
    }],
    ...overrides,
  };
}

function transaction(request, values) {
  return {
    ...request, endpointId: request.endpointId, sessionId: 'session-1', origin: 'master',
    address: request.address, quantity: request.quantity, requestValues: [], values,
    success: true, exceptionCode: null, message: null, createdAt: Date.now(), durationMs: 4,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeClock() {
  let time = 0;
  let id = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay = 0) {
      const taskId = ++id;
      tasks.set(taskId, { at: time + Math.max(0, delay), callback });
      return taskId;
    },
    clearTimeout(taskId) { tasks.delete(taskId); },
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
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
