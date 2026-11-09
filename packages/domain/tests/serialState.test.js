import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialSerialState,
  reduceSerialState,
} from '../src/serialState.js';

const endpointId = 'serial-1';
const operationId = 'open-1';
const sessionId = 'session-1';

function transition(state, event) {
  const result = reduceSerialState(state, event);
  assert.equal(result.diagnostic, null);
  assert.equal(Object.isFrozen(result), true);
  return result.state;
}

function openState() {
  let state = createInitialSerialState();
  state = transition(state, { type: 'open-requested', endpointId, operationId });
  return transition(state, {
    type: 'open-succeeded', endpointId, operationId, sessionId,
  });
}

test('serial lifecycle follows closed to opening to open to closing to closed', () => {
  const initial = createInitialSerialState();
  assert.deepEqual(initial, {
    phase: 'closed', endpointId: null, operationId: null, sessionId: null, error: null,
  });
  assert.equal(Object.isFrozen(initial), true);

  const opening = transition(initial, { type: 'open-requested', endpointId, operationId });
  assert.deepEqual(opening, {
    phase: 'opening', endpointId, operationId, sessionId: null, error: null,
  });

  const open = transition(opening, {
    type: 'open-succeeded', endpointId, operationId, sessionId,
  });
  assert.deepEqual(open, {
    phase: 'open', endpointId, operationId, sessionId, error: null,
  });

  const closing = transition(open, {
    type: 'close-requested', endpointId, operationId, sessionId,
  });
  assert.deepEqual(closing, {
    phase: 'closing', endpointId, operationId, sessionId, error: null,
  });

  const closed = transition(closing, {
    type: 'closed', endpointId, operationId, sessionId,
  });
  assert.deepEqual(closed, {
    phase: 'closed', endpointId, operationId, sessionId: null, error: null,
  });
  assert.equal(Object.isFrozen(closed), true);
});

test('opening cancellation closes without creating a session', () => {
  const opening = transition(
    createInitialSerialState(),
    { type: 'open-requested', endpointId, operationId },
  );
  const closed = transition(opening, { type: 'open-cancelled', endpointId, operationId });

  assert.deepEqual(closed, {
    phase: 'closed',
    endpointId,
    operationId,
    sessionId: null,
    error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' },
  });
  assert.equal(Object.isFrozen(closed.error), true);
});

test('open failure stores a normalized immutable error and closes without a session', () => {
  const opening = transition(
    createInitialSerialState(),
    { type: 'open-requested', endpointId, operationId },
  );
  const inputError = { code: 'PORT_BUSY', message: 'Port is already in use' };
  const failed = transition(opening, {
    type: 'open-failed', endpointId, operationId, error: inputError,
  });

  assert.deepEqual(failed, {
    phase: 'error',
    endpointId,
    operationId,
    sessionId: null,
    error: inputError,
  });
  assert.notEqual(failed.error, inputError);
  assert.equal(Object.isFrozen(failed.error), true);

  const closed = transition(failed, {
    type: 'closed', endpointId, operationId, sessionId: null,
  });
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.sessionId, null);
  assert.deepEqual(closed.error, inputError);
});

test('device removal reports error before closed and preserves the normalized reason', () => {
  const open = openState();
  const removed = transition(open, {
    type: 'device-removed',
    endpointId,
    operationId,
    sessionId,
    message: 'USB serial device was removed',
  });

  assert.deepEqual(removed, {
    phase: 'error',
    endpointId,
    operationId,
    sessionId,
    error: { code: 'DEVICE_REMOVED', message: 'USB serial device was removed' },
  });

  const closed = transition(removed, {
    type: 'closed', endpointId, operationId, sessionId,
  });
  assert.deepEqual(closed, {
    phase: 'closed',
    endpointId,
    operationId,
    sessionId: null,
    error: { code: 'DEVICE_REMOVED', message: 'USB serial device was removed' },
  });
});

test('closed state retains terminal errors only when lifecycle identity is present', () => {
  const terminalError = { code: 'IO_ERROR', message: 'Serial operation failed' };
  const closedWithIdentity = {
    phase: 'closed',
    endpointId,
    operationId,
    sessionId: null,
    error: terminalError,
  };

  const reopened = reduceSerialState(closedWithIdentity, {
    type: 'open-requested',
    endpointId,
    operationId: 'open-2',
  });
  assert.equal(reopened.diagnostic, null);
  assert.deepEqual(reopened.state, {
    phase: 'opening',
    endpointId,
    operationId: 'open-2',
    sessionId: null,
    error: null,
  });

  assert.throws(() => reduceSerialState({
    phase: 'closed',
    endpointId: null,
    operationId: null,
    sessionId: null,
    error: terminalError,
  }, {
    type: 'open-requested', endpointId, operationId,
  }), /closed.*identity.*error|error.*identity/i);
});

test('state validation rejects unreachable lifecycle error combinations', () => {
  const terminalError = { code: 'IO_ERROR', message: 'Serial operation failed' };
  const invalidStates = [
    {
      phase: 'opening', endpointId, operationId, sessionId: null, error: terminalError,
    },
    {
      phase: 'open', endpointId, operationId, sessionId, error: terminalError,
    },
    {
      phase: 'closing', endpointId, operationId, sessionId, error: terminalError,
    },
    {
      phase: 'error', endpointId, operationId, sessionId: null, error: null,
    },
  ];

  for (const state of invalidStates) {
    assert.throws(() => reduceSerialState(state, {
      type: 'open-requested', endpointId, operationId: 'open-2',
    }), TypeError);
  }
});

test('same endpoint duplicate open is rejected without replacing state', () => {
  const opening = transition(
    createInitialSerialState(),
    { type: 'open-requested', endpointId, operationId },
  );
  const result = reduceSerialState(opening, {
    type: 'open-requested', endpointId, operationId,
  });

  assert.equal(result.state, opening);
  assert.deepEqual(result.diagnostic, {
    code: 'INVALID_TRANSITION',
    phase: 'opening',
    event: 'open-requested',
    endpointId,
    operationId,
  });
  assert.equal(Object.isFrozen(result.diagnostic), true);
  assert.equal(Object.isFrozen(result), true);
});

test('a completed operation ID cannot immediately be reused', () => {
  let state = openState();
  state = transition(state, {
    type: 'close-requested', endpointId, operationId, sessionId,
  });
  state = transition(state, { type: 'closed', endpointId, operationId, sessionId });

  const result = reduceSerialState(state, { type: 'open-requested', endpointId, operationId });
  assert.equal(result.state, state);
  assert.equal(result.diagnostic.code, 'INVALID_TRANSITION');
});

test('stale operation and session events are ignored without diagnostics', () => {
  const opening = transition(
    createInitialSerialState(),
    { type: 'open-requested', endpointId, operationId: 'open-current' },
  );
  const staleOpen = reduceSerialState(opening, {
    type: 'open-succeeded',
    endpointId,
    operationId: 'open-stale',
    sessionId: 'session-stale',
  });
  assert.equal(staleOpen.state, opening);
  assert.equal(staleOpen.diagnostic, null);

  const open = transition(opening, {
    type: 'open-succeeded',
    endpointId,
    operationId: 'open-current',
    sessionId: 'session-current',
  });
  const staleClosed = reduceSerialState(open, {
    type: 'closed',
    endpointId,
    operationId: 'open-current',
    sessionId: 'session-stale',
  });
  assert.equal(staleClosed.state, open);
  assert.equal(staleClosed.diagnostic, null);

  const failed = transition(opening, {
    type: 'open-failed',
    endpointId,
    operationId: 'open-current',
    error: { code: 'IO_ERROR', message: 'Open failed' },
  });
  const staleFailureClose = reduceSerialState(failed, {
    type: 'closed',
    endpointId,
    operationId: 'open-current',
    sessionId: 'session-never-bound',
  });
  assert.equal(staleFailureClose.state, failed);
  assert.equal(staleFailureClose.diagnostic, null);
});

test('validly shaped invalid transitions never throw and include transition context', () => {
  const state = createInitialSerialState();
  const result = reduceSerialState(state, {
    type: 'close-requested',
    endpointId,
    operationId,
    sessionId,
  });

  assert.equal(result.state, state);
  assert.deepEqual(result.diagnostic, {
    code: 'INVALID_TRANSITION',
    phase: 'closed',
    event: 'close-requested',
    endpointId,
    operationId,
  });
});

test('malformed states and events throw TypeError before transition handling', () => {
  const initial = createInitialSerialState();
  assert.throws(() => reduceSerialState(null, { type: 'open-requested', endpointId, operationId }), TypeError);
  assert.throws(() => reduceSerialState({ ...initial, extra: true }, {
    type: 'open-requested', endpointId, operationId,
  }), /state.*field/i);

  for (const event of [
    null,
    { type: 'open-requested', endpointId: ' ', operationId },
    { type: 'open-requested', endpointId, operationId: '' },
    { type: 'open-requested', endpointId, operationId, extra: true },
    { type: 'open-failed', endpointId, operationId, error: { code: '', message: 'failed' } },
  ]) {
    assert.throws(() => reduceSerialState(initial, event), TypeError);
  }
});

test('event discriminators reject accessors without executing getters', () => {
  let typeReads = 0;
  const event = { endpointId, operationId };
  Object.defineProperty(event, 'type', {
    enumerable: true,
    get() {
      typeReads += 1;
      return 'open-requested';
    },
  });

  assert.throws(() => reduceSerialState(createInitialSerialState(), event), TypeError);
  assert.equal(typeReads, 0);
});

test('event validation rejects proxies without executing traps', () => {
  let proxyTraps = 0;
  const event = new Proxy({ type: 'open-requested', endpointId, operationId }, {
    get() { proxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });

  assert.throws(() => reduceSerialState(createInitialSerialState(), event), TypeError);
  assert.equal(proxyTraps, 0);
});
