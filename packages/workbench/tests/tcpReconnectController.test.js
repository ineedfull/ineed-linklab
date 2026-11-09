import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTcpReconnectController,
  reconnectDelayMs,
} from '../src/model/tcpReconnectController.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

test('failed desired connection retries with exact capped exponential delays', async () => {
  const timers = createFakeTimers();
  const attempts = [];
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: ({ attempt }) => `retry-${attempt}`,
    openAttempt: async (request) => {
      attempts.push(request);
      return { ok: false, error: { code: 'IO_ERROR', message: 'refused' } };
    },
  });
  controller.arm('client-1', 'manual-1');
  controller.failed({
    endpointId: 'client-1', operationId: 'manual-1', sessionId: null,
    error: { code: 'IO_ERROR', message: 'refused' },
  });

  for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.equal(timers.nextDelay(), delay);
    await timers.runNext();
  }
  assert.deepEqual(attempts.map(({ operationId }) => operationId), [
    'retry-1', 'retry-2', 'retry-3', 'retry-4',
    'retry-5', 'retry-6', 'retry-7', 'retry-8',
  ]);
});

test('success resets backoff and duplicate terminal events own one timer', async () => {
  const harness = createControllerHarness();
  harness.controller.arm('client-1', 'manual-1');
  harness.controller.connected({
    endpointId: 'client-1', operationId: 'manual-1', sessionId: 'session-1',
  });
  const terminal = {
    endpointId: 'client-1', operationId: 'manual-1', sessionId: 'session-1',
    error: { code: 'IO_ERROR', message: 'remote closed' },
  };
  harness.controller.failed(terminal);
  harness.controller.failed(terminal);
  assert.equal(harness.timers.pendingCount(), 1);
  assert.equal(harness.controller.stateFor('client-1').attempt, 1);
  assert.equal(harness.timers.nextDelay(), 500);
});

test('waiting snapshots expose no automatic operation id', async () => {
  const harness = createControllerHarness();
  harness.controller.arm('client-1', 'manual-1');
  harness.controller.failed(failure('manual-1', null));

  assert.equal(harness.controller.stateFor('client-1').operationId, null);

  await harness.timers.runNext();

  const waiting = harness.controller.stateFor('client-1');
  assert.equal(waiting.phase, 'waiting');
  assert.equal(waiting.operationId, null);
});

test('cancel and newer manual intent make stale callbacks inert', async () => {
  const harness = createControllerHarness();
  harness.controller.arm('client-1', 'manual-1');
  harness.controller.failed({
    endpointId: 'client-1', operationId: 'manual-1', sessionId: null,
    error: { code: 'IO_ERROR', message: 'refused' },
  });
  const stale = harness.timers.nextCallback();
  const cancelled = harness.controller.cancel('client-1');
  harness.controller.arm('client-1', 'manual-2');
  await stale();
  assert.deepEqual(cancelled, { phase: 'waiting', operationId: 'manual-1' });
  assert.deepEqual(harness.openAttempts, []);
  assert.equal(harness.controller.stateFor('client-1'), null);
});

test('success acknowledgement before status preserves desired identity for later failure', async () => {
  const timers = createFakeTimers();
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: () => 'retry-1',
    openAttempt: async () => ({ ok: true, value: { sessionId: 'session-1' } }),
  });
  controller.arm('client-1', 'manual-1');
  controller.failed(failure('manual-1', null));
  await timers.runNext();

  assert.equal(controller.stateFor('client-1'), null);
  controller.connected(identity('retry-1', 'session-1'));
  controller.failed(failure('retry-1', 'session-1', 'remote closed'));
  assert.equal(controller.stateFor('client-1').attempt, 1);
  assert.equal(timers.nextDelay(), 500);
});

test('status before acknowledgement accepts the matching session and keeps late success inert', async () => {
  const timers = createFakeTimers();
  const attempt = deferred();
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: () => 'retry-1',
    openAttempt: () => attempt.promise,
  });
  controller.arm('client-1', 'manual-1');
  controller.failed(failure('manual-1', null));
  const running = timers.runNext();
  await Promise.resolve();

  controller.connected(identity('retry-1', 'session-1'));
  assert.equal(controller.stateFor('client-1'), null);
  attempt.resolve({ ok: true, value: { sessionId: 'session-1' } });
  await running;
  controller.failed(failure('retry-1', 'session-1', 'remote closed'));
  assert.equal(controller.stateFor('client-1').attempt, 1);
  assert.equal(timers.nextDelay(), 500);
});

test('stale operation and session terminal events cannot replace current state', () => {
  const harness = createControllerHarness();
  harness.controller.arm('client-1', 'manual-1');
  harness.controller.connected(identity('manual-1', 'session-1'));
  harness.controller.failed(failure('manual-1', 'stale-session'));
  harness.controller.failed(failure('stale-operation', 'session-1'));
  assert.equal(harness.timers.pendingCount(), 0);
  assert.equal(harness.controller.stateFor('client-1'), null);

  harness.controller.failed(failure('manual-1', 'session-1'));
  const snapshot = harness.controller.stateFor('client-1');
  harness.controller.connected(identity('stale-operation', 'session-1'));
  assert.equal(harness.controller.stateFor('client-1'), snapshot);
  assert.equal(harness.timers.pendingCount(), 1);
});

test('reconcile retains eligible TCP clients and Modbus TCP masters only', () => {
  const timers = createFakeTimers();
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: ({ endpointId }) => `retry-${endpointId}`,
    openAttempt: async () => ({ ok: false, error: new Error('refused') }),
  });
  for (const endpointId of ['missing', 'disabled', 'server', 'eligible', 'modbus-master']) {
    controller.arm(endpointId, `manual-${endpointId}`);
    controller.failed(failure(`manual-${endpointId}`, null, 'refused', endpointId));
  }

  controller.reconcile([
    tcpClient('disabled', false),
    { id: 'server', transport: 'tcp-server', config: { autoReconnect: true } },
    tcpClient('eligible', true),
    { id: 'modbus-master', transport: 'modbus-tcp-master', config: { autoReconnect: true } },
    tcpClient('loaded-only', true),
  ]);

  assert.equal(controller.stateFor('missing'), null);
  assert.equal(controller.stateFor('disabled'), null);
  assert.equal(controller.stateFor('server'), null);
  assert.equal(controller.stateFor('eligible').phase, 'waiting');
  assert.equal(controller.stateFor('modbus-master').phase, 'waiting');
  assert.equal(controller.stateFor('loaded-only'), null);
  assert.equal(timers.pendingCount(), 2);
});

test('dispose clears every timer and public and private state', async () => {
  const harness = createControllerHarness();
  for (const endpointId of ['client-1', 'client-2']) {
    harness.controller.arm(endpointId, `manual-${endpointId}`);
    harness.controller.failed({
      endpointId,
      operationId: `manual-${endpointId}`,
      sessionId: null,
      error: new Error('refused'),
    });
  }
  const stale = harness.timers.nextCallback();

  harness.controller.dispose();
  assert.equal(harness.timers.pendingCount(), 0);
  assert.equal(harness.controller.states.size, 0);
  assert.equal(harness.controller.cancel('client-1'), null);
  await stale();
  assert.deepEqual(harness.openAttempts, []);
});

test('openAttempt throwing follows the failed retry path', async () => {
  const timers = createFakeTimers();
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: () => 'retry-1',
    openAttempt: async () => { throw Object.assign(new Error('socket exploded'), { code: 'IO_ERROR' }); },
  });
  controller.arm('client-1', 'manual-1');
  controller.failed(failure('manual-1', null));

  await timers.runNext();
  assert.deepEqual(controller.stateFor('client-1'), {
    endpointId: 'client-1',
    phase: 'waiting',
    attempt: 2,
    nextRetryAt: timers.now + 1000,
    operationId: null,
    lastError: { code: 'IO_ERROR', message: 'socket exploded' },
  });
});

test('onChange observer failures cannot interrupt state and timer ownership', async () => {
  const timers = createFakeTimers();
  const states = new Map();
  let changes = 0;
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    states,
    createOperationId: () => 'retry-1',
    openAttempt: async () => ({ ok: false, error: new Error('still refused') }),
    onChange(received) {
      changes += 1;
      assert.equal(received, states);
      throw new Error('observer failed');
    },
  });

  controller.arm('client-1', 'manual-1');
  assert.doesNotThrow(() => controller.failed(failure('manual-1', null)));
  assert.equal(timers.pendingCount(), 1);
  await timers.runNext();
  assert.equal(controller.stateFor('client-1').attempt, 2);
  assert.equal(timers.pendingCount(), 1);
  assert.equal(changes, 3);
});

test('reentrant observer cancellation prevents a published attempt from opening', async () => {
  const timers = createFakeTimers();
  const openAttempts = [];
  let controller;
  controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: () => 'retry-1',
    openAttempt: async (request) => {
      openAttempts.push(request);
      return { ok: true, value: { sessionId: 'session-1' } };
    },
    onChange(states) {
      if (states.get('client-1')?.phase === 'connecting') controller.cancel('client-1');
    },
  });
  controller.arm('client-1', 'manual-1');
  controller.failed(failure('manual-1', null));

  await timers.runNext();
  assert.deepEqual(openAttempts, []);
  assert.equal(controller.stateFor('client-1'), null);
  assert.equal(timers.pendingCount(), 0);
});

test('publishes frozen snapshots and errors through the injected stable map', () => {
  const states = new Map();
  const timers = createFakeTimers();
  const error = { code: 'IO_ERROR', message: 'refused' };
  const controller = createTcpReconnectController({
    states,
    clock: () => timers.now,
    timers,
    openAttempt: async () => ({ ok: false, error }),
  });
  assert.equal(controller.states, states);
  controller.arm('client-1', 'manual-1');
  controller.failed({
    endpointId: 'client-1', operationId: 'manual-1', sessionId: null, error,
  });

  const snapshot = states.get('client-1');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.lastError), true);
  error.message = 'mutated';
  assert.deepEqual(snapshot.lastError, { code: 'IO_ERROR', message: 'refused' });
});

test('rejects blank generated operation ids without invoking openAttempt', async () => {
  for (const generated of ['', '   ', null]) {
    const timers = createFakeTimers();
    const attempts = [];
    const controller = createTcpReconnectController({
      clock: () => timers.now,
      timers,
      createOperationId: () => generated,
      openAttempt: async (request) => {
        attempts.push(request);
        return { ok: true, value: { sessionId: 'session-1' } };
      },
    });
    controller.arm('client-1', 'manual-1');
    controller.failed(failure('manual-1', null));

    await timers.runNext();
    assert.deepEqual(attempts, []);
    assert.equal(controller.stateFor('client-1').attempt, 2);
    assert.equal(timers.nextDelay(), 1000);
  }
});

test('rejects generated ids reused from the manual intent or an earlier retry', async () => {
  const timers = createFakeTimers();
  const generated = [
    'manual-1', 'retry-1', 'retry-1', 'retry-4', 'retry-1', 'retry-6',
  ];
  const openAttempts = [];
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: () => generated.shift(),
    openAttempt: async (request) => {
      openAttempts.push(request);
      return request.operationId === 'retry-4'
        ? { ok: true, value: { sessionId: 'session-4' } }
        : { ok: false, error: { code: 'IO_ERROR', message: 'refused' } };
    },
  });
  controller.arm('client-1', 'manual-1');
  controller.failed(failure('manual-1', null));

  await timers.runNext();
  assert.deepEqual(openAttempts, []);
  assert.equal(controller.stateFor('client-1').attempt, 2);
  assert.equal(controller.stateFor('client-1').operationId, null);
  const afterManualCollision = controller.stateFor('client-1');
  controller.failed(failure('manual-1', null, 'late manual failure'));
  assert.equal(controller.stateFor('client-1'), afterManualCollision);

  await timers.runNext();
  assert.deepEqual(openAttempts.map(({ operationId }) => operationId), ['retry-1']);
  assert.equal(controller.stateFor('client-1').attempt, 3);
  await timers.runNext();
  assert.deepEqual(openAttempts.map(({ operationId }) => operationId), ['retry-1']);
  assert.equal(controller.stateFor('client-1').attempt, 4);
  assert.equal(controller.stateFor('client-1').operationId, null);
  const afterRetryCollision = controller.stateFor('client-1');
  controller.failed(failure('retry-1', null, 'late retry failure'));
  assert.equal(controller.stateFor('client-1'), afterRetryCollision);

  await timers.runNext();
  assert.deepEqual(
    openAttempts.map(({ operationId, attempt }) => ({ operationId, attempt })),
    [
      { operationId: 'retry-1', attempt: 2 },
      { operationId: 'retry-4', attempt: 4 },
    ],
  );
  assert.equal(controller.stateFor('client-1'), null);

  controller.arm('client-1', 'manual-2');
  controller.failed(failure('manual-2', null));
  await timers.runNext();
  assert.deepEqual(
    openAttempts.map(({ operationId }) => operationId),
    ['retry-1', 'retry-4'],
  );
  assert.equal(controller.stateFor('client-1').attempt, 2);
  assert.equal(controller.stateFor('client-1').operationId, null);
  await timers.runNext();
  assert.deepEqual(
    openAttempts.map(({ operationId, attempt }) => ({ operationId, attempt })),
    [
      { operationId: 'retry-1', attempt: 2 },
      { operationId: 'retry-4', attempt: 4 },
      { operationId: 'retry-6', attempt: 2 },
    ],
  );
});

test('generated operation id freshness is independent per endpoint', async () => {
  const timers = createFakeTimers();
  const openAttempts = [];
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: () => 'shared-retry',
    openAttempt: async (request) => {
      openAttempts.push(request);
      return { ok: true, value: { sessionId: `session-${request.endpointId}` } };
    },
  });
  for (const endpointId of ['client-1', 'client-2']) {
    controller.arm(endpointId, `manual-${endpointId}`);
    controller.failed(failure(
      `manual-${endpointId}`,
      null,
      'refused',
      endpointId,
    ));
  }

  await timers.runNext();
  await timers.runNext();
  assert.deepEqual(
    openAttempts.map(({ endpointId, operationId }) => ({ endpointId, operationId })),
    [
      { endpointId: 'client-1', operationId: 'shared-retry' },
      { endpointId: 'client-2', operationId: 'shared-retry' },
    ],
  );
});

test('default retries retain no collision history while injected factories retain every id', async () => {
  const defaultTimers = createFakeTimers();
  const defaultHistory = new Map();
  const defaultController = createTcpReconnectController({
    clock: () => defaultTimers.now,
    timers: defaultTimers,
    _issuedOperationIds: defaultHistory,
    openAttempt: async () => ({ ok: false, error: new Error('refused') }),
  });
  defaultController.arm('default-client', 'manual-default');
  defaultController.failed(failure('manual-default', null, 'refused', 'default-client'));
  for (let attempt = 0; attempt < 64; attempt += 1) await defaultTimers.runNext();
  assert.equal(defaultHistory.size, 0);

  const customTimers = createFakeTimers();
  const customHistory = new Map();
  const customController = createTcpReconnectController({
    clock: () => customTimers.now,
    timers: customTimers,
    _issuedOperationIds: customHistory,
    createOperationId: ({ attempt }) => `custom-${attempt}`,
    openAttempt: async () => ({ ok: false, error: new Error('refused') }),
  });
  customController.arm('custom-client', 'manual-custom');
  customController.failed(failure('manual-custom', null, 'refused', 'custom-client'));
  for (let attempt = 0; attempt < 3; attempt += 1) await customTimers.runNext();
  assert.deepEqual([...customHistory.get('custom-client')], [
    'manual-custom', 'custom-1', 'custom-2', 'custom-3',
  ]);
});

test('reconnectDelayMs validates attempts and caps exponential growth', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(reconnectDelayMs),
    [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => reconnectDelayMs(attempt), {
      name: 'TypeError', message: 'attempt must be a positive integer',
    });
  }
});

function createControllerHarness() {
  const timers = createFakeTimers();
  const openAttempts = [];
  const controller = createTcpReconnectController({
    clock: () => timers.now,
    timers,
    createOperationId: ({ attempt }) => `retry-${attempt}`,
    openAttempt: async (request) => {
      openAttempts.push(request);
      return { ok: false, error: { code: 'IO_ERROR', message: 'refused' } };
    },
  });
  return { controller, timers, openAttempts };
}

function identity(operationId, sessionId, endpointId = 'client-1') {
  return { endpointId, operationId, sessionId };
}

function failure(operationId, sessionId, message = 'refused', endpointId = 'client-1') {
  return {
    ...identity(operationId, sessionId, endpointId),
    error: { code: 'IO_ERROR', message },
  };
}

function tcpClient(id, autoReconnect) {
  return { id, transport: 'tcp-client', config: { autoReconnect } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
