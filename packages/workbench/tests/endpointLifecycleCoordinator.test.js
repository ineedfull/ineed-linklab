import assert from 'node:assert/strict';
import test from 'node:test';

import { createEndpointLifecycleCoordinator } from '../src/model/endpointLifecycleCoordinator.js';

test('coordinator serializes one endpoint while different endpoints remain concurrent', async () => {
  const gate = deferred();
  const calls = [];
  const coordinator = createCoordinator();

  const a1 = coordinator.enqueue('a', async () => {
    calls.push('a1:start');
    await gate.promise;
    calls.push('a1:end');
  });
  const a2 = coordinator.enqueue('a', async () => { calls.push('a2'); });
  const b1 = coordinator.enqueue('b', async () => { calls.push('b1'); });
  await tick();
  assert.deepEqual(calls, ['a1:start', 'b1']);
  gate.resolve();
  await Promise.all([a1, a2, b1]);
  assert.deepEqual(calls, ['a1:start', 'b1', 'a1:end', 'a2']);
  assert.deepEqual(coordinator.diagnostics(), { endpoints: 0, queued: 0, running: 0, opens: 0 });
});

test('successful cancellation acknowledgement releases an in-flight open', async () => {
  const openGate = deferred();
  const cancelGate = deferred();
  const calls = [];
  const coordinator = createCoordinator(async (...args) => {
    calls.push(args);
    return cancelGate.promise;
  });
  const first = coordinator.beginOpenIntent('a', 'op1');
  await first.cancellation;
  const opening = coordinator.enqueueOpen(first.intent, () => openGate.promise);
  await tick();

  const closing = coordinator.beginInvalidation('a');
  assert.deepEqual(calls, [['a', { operationId: 'op1' }]]);
  cancelGate.resolve();
  await closing.cancellation;
  const openResult = await opening.then(
    () => null,
    (error) => error,
  );

  assert.equal(openResult.code, 'OPEN_CANCELLED');
  assert.equal(coordinator.isCurrent(closing.intent), true);
  assert.deepEqual(coordinator.diagnostics(), { endpoints: 0, queued: 0, running: 0, opens: 0 });
});

test('failed cancellation keeps the running open and rolls back intent', async () => {
  const openGate = deferred();
  const failure = new Error('cancel failed');
  const coordinator = createCoordinator(async () => { throw failure; });
  const first = coordinator.beginOpenIntent('a', 'op1');
  await first.cancellation;
  const opening = coordinator.enqueueOpen(first.intent, () => openGate.promise);
  await tick();

  const replacement = coordinator.beginOpenIntent('a', 'op2');
  await assert.rejects(replacement.cancellation, failure);
  assert.equal(coordinator.isCurrent(first.intent), true);
  openGate.resolve('connected');
  assert.equal(await opening, 'connected');
  assert.deepEqual(coordinator.diagnostics(), { endpoints: 0, queued: 0, running: 0, opens: 0 });
});

test('dispose aborts running and queued items and observes abandoned rejections', async () => {
  const runningGate = deferred();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const calls = [];
  const coordinator = createCoordinator();
  const running = coordinator.enqueue('a', async () => {
    calls.push('running');
    return runningGate.promise;
  });
  const queued = coordinator.enqueue('a', async () => { calls.push('queued'); });
  await tick();

  try {
    coordinator.dispose();
    const [runningError, queuedError] = await Promise.all([
      running.catch((error) => error),
      queued.catch((error) => error),
    ]);
    assert.equal(runningError.code, 'WORKBENCH_DISPOSED');
    assert.equal(queuedError.code, 'WORKBENCH_DISPOSED');
    assert.deepEqual(calls, ['running']);
    assert.deepEqual(coordinator.diagnostics(), { endpoints: 0, queued: 0, running: 0, opens: 0 });

    runningGate.reject(new Error('late failure'));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('same operation id replacement blocks the prior session until explicitly bound', async () => {
  const coordinator = createCoordinator();
  const first = coordinator.beginOpenIntent('a', 'same');
  await first.cancellation;
  coordinator.bindSession(first.intent, 'old-session');

  const second = coordinator.beginOpenIntent('a', 'same', { blockedSessionIds: ['old-session'] });
  await second.cancellation;
  assert.equal(coordinator.acceptsEvent('a', 'same', 'old-session'), false);
  coordinator.bindSession(second.intent, 'old-session');
  assert.equal(coordinator.acceptsEvent('a', 'same', 'old-session'), true);
});

test('operation identity remains tracked until both intent and running open retire', async () => {
  const openGate = deferred();
  const coordinator = createCoordinator();
  const transition = coordinator.beginOpenIntent('a', 'op1');
  await transition.cancellation;
  const opening = coordinator.enqueueOpen(transition.intent, () => openGate.promise);

  assert.equal(coordinator.hasOperation('a', 'op1'), true);
  coordinator.clearIntent(transition.intent);
  assert.equal(coordinator.hasOperation('a', 'op1'), true);

  openGate.resolve({ sessionId: 's1' });
  await opening;
  assert.equal(coordinator.hasOperation('a', 'op1'), false);
});

function createCoordinator(cancelOpen = async () => null) {
  return createEndpointLifecycleCoordinator({
    cancelOpen,
    createDisposedError() {
      return Object.assign(new Error('disposed'), {
        name: 'WorkbenchDisposedError',
        code: 'WORKBENCH_DISPOSED',
      });
    },
  });
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
