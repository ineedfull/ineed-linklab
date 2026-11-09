import assert from 'node:assert/strict';
import test from 'node:test';

import { createScheduledSender } from '../src/model/scheduledSender.js';

test('starts with an immediate send then schedules from completion using timer id zero', async () => {
  const clock = createClock();
  const send = createSuccessfulSend();
  const sender = createScheduledSender({ send, clock });

  sender.start(job({ intervalMs: 250 }));
  assert.equal(send.calls.length, 1);
  assert.equal(clock.timers.size, 0);
  await settle();
  assert.deepEqual(clock.delays(), [250]);
  assert.equal(sender.getStatus('serial-1').sentCount, 1);

  assert.equal(sender.stop('serial-1', 'session-1'), true);
  assert.deepEqual(clock.cleared, [0]);
  assert.equal(sender.getStatus('serial-1').active, false);
  assert.equal(sender.stop('serial-1', 'session-1'), false);
});

test('never overlaps sends and starts the next interval only after completion', async () => {
  const clock = createClock();
  const first = deferred();
  const send = createSend(() => first.promise);
  const sender = createScheduledSender({ send, clock });

  sender.start(job());
  assert.equal(send.calls.length, 1);
  assert.equal(clock.timers.size, 0);
  await settle();
  assert.equal(clock.timers.size, 0);

  first.resolve({ ok: true, value: null });
  await settle();
  assert.deepEqual(clock.delays(), [100]);
  clock.fire(0);
  assert.equal(send.calls.length, 2);
});

test('finite count includes the immediate send while unlimited jobs continue', async () => {
  const clock = createClock();
  const send = createSuccessfulSend();
  const sender = createScheduledSender({ send, clock });

  sender.start(job({ count: 3 }));
  await settle();
  for (const timerId of [0, 1]) {
    clock.fire(timerId);
    await settle();
  }
  assert.equal(send.calls.length, 3);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(sender.getStatus('serial-1'), {
    active: false,
    endpointId: 'serial-1',
    sessionId: 'session-1',
    sentCount: 3,
    reason: 'completed',
    error: null,
  });

  sender.start(job({ count: null }));
  await settle();
  clock.fire(2);
  await settle();
  assert.equal(send.calls.length, 5);
  assert.equal(sender.getStatus('serial-1').active, true);
  assert.equal(clock.timers.size, 1);
});

test('enforces interval and finite count bounds', () => {
  const sender = createScheduledSender({ send: createSuccessfulSend(), clock: createClock() });
  assert.throws(() => sender.start(job({ intervalMs: 99 })), /intervalMs/);
  assert.throws(() => sender.start(job({ intervalMs: 60_001 })), /intervalMs/);
  assert.throws(() => sender.start(job({ count: 0 })), /count/);
  assert.throws(() => sender.start(job({ count: 1.5 })), /count/);
});

test('new start replaces only the same endpoint and stop requires the exact session', async () => {
  const clock = createClock();
  const send = createSuccessfulSend();
  const sender = createScheduledSender({ send, clock });

  sender.start(job({ endpointId: 'serial-1', sessionId: 'old-session' }));
  sender.start(job({ endpointId: 'serial-2', sessionId: 'other-session' }));
  await settle();
  assert.equal(sender.stop('serial-1', 'wrong-session'), false);
  assert.equal(sender.getStatus('serial-1').active, true);

  sender.start(job({ endpointId: 'serial-1', sessionId: 'new-session' }));
  assert.equal(sender.getStatus('serial-1').sessionId, 'new-session');
  assert.equal(sender.getStatus('serial-2').active, true);
  assert.equal(sender.stop('serial-1', 'old-session'), false);
  assert.equal(sender.stop('serial-1', 'new-session'), true);
  assert.equal(sender.getStatus('serial-2').active, true);
});

test('send rejection or thrown failure stops immediately without an error storm', async () => {
  for (const implementation of [
    () => Promise.resolve({ ok: false, error: new Error('rejected') }),
    () => Promise.reject(new Error('thrown')),
  ]) {
    const clock = createClock();
    const sender = createScheduledSender({ send: implementation, clock });
    sender.start(job());
    await settle();

    const status = sender.getStatus('serial-1');
    assert.equal(status.active, false);
    assert.equal(status.reason, 'error');
    assert.match(status.error.message, /rejected|thrown/);
    assert.equal(clock.timers.size, 0);
  }
});

test('late completion after stop or replacement is inert and cannot revive a job', async () => {
  const clock = createClock();
  const oldSend = deferred();
  const send = createSend(() => oldSend.promise);
  const sender = createScheduledSender({ send, clock });

  sender.start(job({ sessionId: 'old-session' }));
  sender.stop('serial-1', 'old-session');
  oldSend.resolve({ ok: true, value: null });
  await settle();
  assert.equal(clock.timers.size, 0);
  assert.equal(sender.getStatus('serial-1').active, false);

  const replacedSend = deferred();
  send.implementation = () => replacedSend.promise;
  sender.start(job({ sessionId: 'replaced-session' }));
  send.implementation = () => Promise.resolve({ ok: true, value: null });
  sender.start(job({ sessionId: 'current-session' }));
  replacedSend.resolve({ ok: false, error: new Error('late replacement') });
  await settle();
  assert.equal(sender.getStatus('serial-1').active, true);
  assert.equal(sender.getStatus('serial-1').sessionId, 'current-session');
  assert.equal(sender.getStatus('serial-1').error, null);
});

test('snapshots requests at start and gives every send fresh byte storage', async () => {
  const clock = createClock();
  const send = createSuccessfulSend();
  const sender = createScheduledSender({ send, clock });
  const request = {
    endpointId: 'serial-1',
    bytes: new Uint8Array([1, 2, 3]),
    target: { endpointId: 'serial-1' },
    framing: 'none',
  };

  sender.start(job({ request }));
  request.bytes[0] = 99;
  request.target.endpointId = 'mutated';
  await settle();
  clock.fire(0);
  await settle();

  assert.deepEqual([...send.calls[0].bytes], [1, 2, 3]);
  assert.deepEqual([...send.calls[1].bytes], [1, 2, 3]);
  assert.equal(send.calls[1].target.endpointId, 'serial-1');
  assert.notEqual(send.calls[0], send.calls[1]);
  assert.notEqual(send.calls[0].bytes, send.calls[1].bytes);
  assert.notEqual(send.calls[0].target, send.calls[1].target);
});

test('reconcile stops close, closing, error, delete, reset, dispose, and replaced sessions', async () => {
  const terminalStatuses = ['close', 'closed', 'closing', 'error'];
  for (const status of terminalStatuses) {
    const sender = activeSender();
    sender.reconcile(reconcileState({ status }));
    assert.equal(sender.getStatus('serial-1').active, false, status);
  }

  const deleted = activeSender();
  deleted.reconcile(reconcileState({ endpoints: [] }));
  assert.equal(deleted.getStatus('serial-1').active, false);

  const reset = activeSender();
  reset.reconcile(reconcileState({ reset: true }));
  assert.equal(reset.getStatus('serial-1').active, false);

  const replaced = activeSender();
  replaced.reconcile(reconcileState({ sessionId: 'session-2' }));
  assert.equal(replaced.getStatus('serial-1').active, false);

  const disposed = activeSender();
  disposed.reconcile(reconcileState({ disposed: true }));
  assert.equal(disposed.getStatus('serial-1').active, false);
  assert.doesNotThrow(() => disposed.dispose());
  assert.doesNotThrow(() => disposed.dispose());
  await settle();
});

test('status subscriptions reflect start, progress, and stop', async () => {
  const clock = createClock();
  const sender = createScheduledSender({ send: createSuccessfulSend(), clock });
  const statuses = [];
  const unsubscribe = sender.subscribe((endpointId, status) => statuses.push([endpointId, status]));

  sender.start(job({ count: 1 }));
  await settle();
  unsubscribe();
  sender.stop('serial-1', 'session-1');

  assert.equal(statuses[0][1].active, true);
  assert.equal(statuses.at(-1)[1].reason, 'completed');
});

test('isolates throwing listeners across start, progress, stop, and dispose', async () => {
  const clock = createClock();
  const send = createSuccessfulSend();
  const listenerError = new Error('malicious listener');
  const asyncListenerError = new Error('malicious async listener');
  const reports = [];
  const observed = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const sender = createScheduledSender({
      send,
      clock,
      reporter: (error, context) => reports.push({ error, context }),
    });
    sender.subscribe(() => { throw listenerError; });
    sender.subscribe(() => Promise.reject(asyncListenerError));
    sender.subscribe((endpointId, status) => observed.push([endpointId, status]));

    assert.doesNotThrow(() => sender.start(job()));
    assert.equal(send.calls.length, 1);
    await settle();
    assert.deepEqual(clock.delays(), [100]);
    assert.equal(observed.at(-1)[1].sentCount, 1);

    clock.fire(0);
    await settle();
    assert.equal(send.calls.length, 2);
    assert.deepEqual(clock.delays(), [100]);
    assert.equal(observed.at(-1)[1].sentCount, 2);

    assert.equal(sender.stop('serial-1', 'session-1'), true);
    assert.equal(observed.at(-1)[1].reason, 'stopped');

    assert.doesNotThrow(() => sender.start(job({ sessionId: 'dispose-session' })));
    assert.doesNotThrow(() => sender.dispose());
    assert.equal(observed.at(-1)[1].reason, 'disposed');
    await settle();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reports.length, observed.length * 2);
    assert.equal(reports.filter(({ error }) => error === listenerError).length, observed.length);
    assert.equal(reports.filter(({ error }) => error === asyncListenerError).length, observed.length);
    assert.ok(reports.every(({ context }) => (
      context.source === 'scheduledSender.listener'
      && context.endpointId === 'serial-1'
      && typeof context.status.reason === 'string'
    )));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

function activeSender() {
  const sender = createScheduledSender({ send: createSuccessfulSend(), clock: createClock() });
  sender.start(job());
  return sender;
}

function reconcileState({
  endpoints = [{ id: 'serial-1' }],
  sessionId = 'session-1',
  status = 'open',
  reset = false,
  disposed = false,
} = {}) {
  return {
    endpoints,
    operations: new Map([['serial-1', {
      endpointId: 'serial-1', operationId: 'operation-1', sessionId,
    }]]),
    statuses: new Map([['serial-1', {
      endpointId: 'serial-1', operationId: 'operation-1', sessionId, status,
    }]]),
    reset,
    disposed,
  };
}

function job(overrides = {}) {
  const endpointId = overrides.endpointId ?? 'serial-1';
  return {
    endpointId,
    sessionId: overrides.sessionId ?? 'session-1',
    intervalMs: overrides.intervalMs ?? 100,
    count: Object.hasOwn(overrides, 'count') ? overrides.count : null,
    request: overrides.request ?? {
      endpointId,
      bytes: new Uint8Array([0x50, 0x49, 0x4e, 0x47]),
      target: { endpointId },
      framing: 'none',
    },
  };
}

function createClock() {
  let nextId = 0;
  const timers = new Map();
  const cleared = [];
  return {
    timers,
    cleared,
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
    fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, `timer ${id} must exist`);
      timers.delete(id);
      timer.callback();
    },
    delays() {
      return [...timers.values()].map(({ delay }) => delay);
    },
  };
}

function createSuccessfulSend() {
  return createSend(() => Promise.resolve({ ok: true, value: null }));
}

function createSend(implementation) {
  const send = (request) => {
    send.calls.push(request);
    return send.implementation(request);
  };
  send.calls = [];
  send.implementation = implementation;
  return send;
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

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
