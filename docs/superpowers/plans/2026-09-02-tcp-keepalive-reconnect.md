# TCP Keepalive and Automatic Reconnection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-on configurable TCP keepalive and opt-in, cancellation-safe automatic reconnection for TCP clients in both desktop runtimes.

**Architecture:** Native Electron and Tauri TCP services configure keepalive on connected client and accepted peer sockets. A new shared workbench controller owns desired-open intent, deterministic retry timers, exponential backoff, and stale-operation rejection; all attempts still pass through the existing endpoint lifecycle coordinator.

**Tech Stack:** JavaScript ES modules, Vue 3, Node `net`, Node test runner, Vitest, Playwright, Rust, `socket2` 0.6.4, Cargo test.

**Spec:** `docs/superpowers/specs/2026-09-02-tcp-keepalive-reconnect-design.md`

## Global Constraints

- Keepalive defaults to enabled with a 30-second first-probe delay.
- `initialDelaySeconds` accepts integers from 1 through 3600 only.
- Operating-system keepalive interval and failure count remain untouched.
- Automatic reconnection defaults to disabled and applies only to `tcp-client`.
- Retry delays are exactly `500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, ...` milliseconds, without jitter or an attempt limit.
- Explicit close, cancel, edit, save, delete, workspace reset/import, and application disposal cancel automatic work immediately.
- Every automatic attempt uses a fresh operation id and the existing lifecycle/session gates.
- The runtime wire contract and native status enum remain unchanged; reconnecting is shared UI state.
- `socket2 = "0.6.4"` is the only new direct Rust dependency and matches the existing lockfile version.
- Production support remains macOS, Windows, and Linux.
- Do not implement application-level heartbeat payloads, server auto-restart, configurable retry policy, or persisted reconnect state.

## File Structure

- `packages/workbench/src/model/endpointDraft.js`: shared TCP resilience defaults, normalization, and draft validation.
- `packages/workbench/src/model/tcpReconnectController.js`: isolated desired-open and retry state machine with injected time, timers, ids, and open callback.
- `packages/workbench/tests/helpers/fakeTimers.js`: reusable deterministic timer harness for controller and model race tests.
- `packages/workbench/src/model/createWorkbenchModel.js`: lifecycle integration, public reconnect state, manual/automatic open origins, and cancellation wiring.
- `packages/workbench/src/components/EndpointDialog.vue`: TCP keepalive and client-only auto-reconnect controls.
- `packages/workbench/src/components/EndpointRow.vue`, `EndpointTree.vue`, and `SessionStatusBar.vue`: derived waiting/connecting state and cancellation controls.
- `packages/workbench/src/layouts/DevToolShell.vue` and `packages/workbench/src/App.vue`: reconnect state propagation and edit/cancel commands.
- `packages/workbench/src/styles/workbench.css`: compact advanced TCP controls and stable reconnect status styling.
- `apps/electron/electron/tcpService.cjs`: Node socket keepalive parsing, validation, and application.
- `apps/tauri/src-tauri/src/tcp.rs`: Rust keepalive parsing and `socket2` socket configuration.
- `tooling/tcp-test/localhost-loopback.mjs`: real localhost reconnect acceptance with leak checks.
- `packages/workbench/e2e/fixtures/previewBridge.js` and `packages/workbench/e2e/workbench.spec.js`: runtime-neutral browser acceptance for retry cancellation and TCP settings.
- `docs/verification/phase-05.md`: final gate evidence and actual counts.

---

### Task 1: Shared TCP Resilience Configuration Contract

**Files:**
- Modify: `packages/workbench/src/model/endpointDraft.js`
- Modify: `packages/workbench/tests/endpointDraft.test.js`

**Interfaces:**
- Produces: `MIN_TCP_KEEP_ALIVE_DELAY_SECONDS`, `MAX_TCP_KEEP_ALIVE_DELAY_SECONDS`, `DEFAULT_TCP_KEEP_ALIVE_DELAY_SECONDS`.
- Produces: `normalizeTcpResilienceConfig(config, transport) -> { keepAlive, autoReconnect? }`.
- Consumes: existing `isPlainObject`, `hasUnexpectedKeys`, and integer validation patterns in `endpointDraft.js`.

- [ ] **Step 1: Write failing normalization and validation tests**

Add imports for the new constants and normalizer, then add these cases:

```js
test('legacy TCP configs receive resilience defaults without source mutation', () => {
  const client = { host: 'localhost', port: 9000 };
  assert.deepEqual(normalizeTcpResilienceConfig(client, 'tcp-client'), {
    keepAlive: { enabled: true, initialDelaySeconds: 30 },
    autoReconnect: false,
  });
  assert.deepEqual(normalizeTcpResilienceConfig({}, 'tcp-server'), {
    keepAlive: { enabled: true, initialDelaySeconds: 30 },
  });
  assert.deepEqual(client, { host: 'localhost', port: 9000 });
});

test('TCP resilience preserves explicit values and validates exact bounds', () => {
  const base = { host: 'localhost', port: 9000 };
  for (const initialDelaySeconds of [1, 30, 3600]) {
    assert.deepEqual(validateEndpointDraft({
      transport: 'tcp-client',
      config: {
        ...base,
        keepAlive: { enabled: false, initialDelaySeconds },
        autoReconnect: true,
      },
    }), {});
  }
  for (const initialDelaySeconds of [0, 3601, 1.5, '30']) {
    assert.deepEqual(validateEndpointDraft({
      transport: 'tcp-client',
      config: { ...base, keepAlive: { enabled: true, initialDelaySeconds } },
    }), {
      keepAliveInitialDelaySeconds: '首次探测延迟必须为 1 到 3600 的整数秒。',
    });
  }
});

test('TCP resilience rejects malformed policy and server auto reconnect', () => {
  const server = { listenHost: '0.0.0.0', listenPort: 9000 };
  assert.deepEqual(validateEndpointDraft({
    transport: 'tcp-server', config: { ...server, autoReconnect: true },
  }), { autoReconnect: 'TCP 服务端不支持自动重连。' });
  assert.deepEqual(validateEndpointDraft({
    transport: 'tcp-client',
    config: {
      host: 'localhost', port: 9000,
      keepAlive: { enabled: 1, initialDelaySeconds: 30, interval: 10 },
      autoReconnect: 'yes',
    },
  }), {
    keepAlive: 'TCP Keepalive 配置格式无效。',
    autoReconnect: '自动重连必须为布尔值。',
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `node --test packages/workbench/tests/endpointDraft.test.js`

Expected: FAIL because the resilience exports and validation do not exist.

- [ ] **Step 3: Implement the minimal shared contract**

Add the constants and normalizer:

```js
export const MIN_TCP_KEEP_ALIVE_DELAY_SECONDS = 1;
export const MAX_TCP_KEEP_ALIVE_DELAY_SECONDS = 3600;
export const DEFAULT_TCP_KEEP_ALIVE_DELAY_SECONDS = 30;

export function normalizeTcpResilienceConfig(config = {}, transport = 'tcp-client') {
  const source = isPlainObject(config) ? config : {};
  const keepAlive = isPlainObject(source.keepAlive) ? source.keepAlive : {};
  return {
    keepAlive: {
      enabled: keepAlive.enabled ?? true,
      initialDelaySeconds:
        keepAlive.initialDelaySeconds ?? DEFAULT_TCP_KEEP_ALIVE_DELAY_SECONDS,
    },
    ...(transport === 'tcp-client'
      ? { autoReconnect: source.autoReconnect ?? false }
      : {}),
  };
}
```

Call a new `validateTcpResilience(config, allowAutoReconnect)` from both TCP cases. It must:

```js
function validateTcpResilience(config, allowAutoReconnect) {
  const errors = {};
  if (Object.hasOwn(config, 'keepAlive')) {
    const value = config.keepAlive;
    if (!isPlainObject(value)
      || hasUnexpectedKeys(value, ['enabled', 'initialDelaySeconds'])
      || typeof value.enabled !== 'boolean') {
      errors.keepAlive = 'TCP Keepalive 配置格式无效。';
    } else if (!isBoundedPositiveInteger(
      value.initialDelaySeconds,
      MAX_TCP_KEEP_ALIVE_DELAY_SECONDS,
    )) {
      errors.keepAliveInitialDelaySeconds =
        '首次探测延迟必须为 1 到 3600 的整数秒。';
    }
  }
  if (Object.hasOwn(config, 'autoReconnect')) {
    if (!allowAutoReconnect) errors.autoReconnect = 'TCP 服务端不支持自动重连。';
    else if (typeof config.autoReconnect !== 'boolean') {
      errors.autoReconnect = '自动重连必须为布尔值。';
    }
  }
  return errors;
}
```

Keep missing fields valid for legacy endpoints. Make the minimum bound explicit because `isBoundedPositiveInteger` already enforces `>= 1`.

- [ ] **Step 4: Run the focused test and lint**

Run: `node --test packages/workbench/tests/endpointDraft.test.js && npx eslint packages/workbench/src/model/endpointDraft.js packages/workbench/tests/endpointDraft.test.js`

Expected: all endpoint draft tests PASS and ESLint exits 0.

- [ ] **Step 5: Commit the configuration contract**

```bash
git add packages/workbench/src/model/endpointDraft.js packages/workbench/tests/endpointDraft.test.js
git commit -m "feat: add tcp resilience configuration"
```

---

### Task 2: Deterministic TCP Reconnect Controller

**Files:**
- Create: `packages/workbench/src/model/tcpReconnectController.js`
- Create: `packages/workbench/tests/tcpReconnectController.test.js`
- Create: `packages/workbench/tests/helpers/fakeTimers.js`

**Interfaces:**
- Consumes: injected `clock()`, `timers.setTimeout`, `timers.clearTimeout`, `states`, `createOperationId({ endpointId, attempt, generation })`, and async `openAttempt(request)`.
- Produces: `createTcpReconnectController(options)` with `arm`, `connected`, `failed`, `cancel`, `reconcile`, `stateFor`, `states`, and `dispose`.
- Produces public immutable reconnect snapshots shaped as `{ endpointId, phase, attempt, nextRetryAt, operationId, lastError }`.

- [ ] **Step 1: Write the failing state-machine tests**

Create the reusable timer helper with this interface:

```js
export function createFakeTimers(start = 1_720_000_000_000) {
  let nextId = 1;
  const queue = [];
  const api = {
    now: start,
    setTimeout(callback, delay) {
      const task = { id: nextId, callback, delay, cancelled: false };
      nextId += 1;
      queue.push(task);
      return task.id;
    },
    clearTimeout(id) {
      const task = queue.find((candidate) => candidate.id === id);
      if (task) task.cancelled = true;
    },
    pendingCount() {
      return queue.filter(({ cancelled }) => !cancelled).length;
    },
    nextDelay() {
      return queue.find(({ cancelled }) => !cancelled)?.delay ?? null;
    },
    nextCallback() {
      return queue.find(({ cancelled }) => !cancelled)?.callback ?? null;
    },
    async runNext() {
      const index = queue.findIndex(({ cancelled }) => !cancelled);
      if (index === -1) throw new Error('No pending timer');
      const [task] = queue.splice(index, 1);
      api.now += task.delay;
      await task.callback();
      await Promise.resolve();
    },
  };
  return api;
}
```

Test the public contract with deterministic ids:

```js
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

test('cancel and newer manual intent make stale callbacks inert', async () => {
  const harness = createControllerHarness();
  harness.controller.arm('client-1', 'manual-1');
  harness.controller.failed({
    endpointId: 'client-1', operationId: 'manual-1', sessionId: null,
    error: { code: 'IO_ERROR', message: 'refused' },
  });
  const stale = harness.timers.nextCallback();
  harness.controller.cancel('client-1');
  harness.controller.arm('client-1', 'manual-2');
  await stale();
  assert.deepEqual(harness.openAttempts, []);
  assert.equal(harness.controller.stateFor('client-1'), null);
});
```

Define the referenced controller harness in the test file:

```js
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
```

Also add named tests for: success acknowledgement before status, status before acknowledgement, stale operation/session rejection, `reconcile` cancelling missing/disabled/server endpoints, `dispose` clearing all timers, `openAttempt` throwing, and `onChange` observer failure isolation.

- [ ] **Step 2: Run the controller test and confirm the red state**

Run: `node --test packages/workbench/tests/tcpReconnectController.test.js`

Expected: FAIL with module-not-found for `tcpReconnectController.js`.

- [ ] **Step 3: Implement the controller and immutable snapshots**

Use one private record and at most one timer per endpoint. The exported construction contract is:

```js
export function createTcpReconnectController({
  clock = Date.now,
  timers = globalThis,
  states = new Map(),
  createOperationId = createDefaultOperationId(clock),
  openAttempt,
  onChange = () => {},
} = {})
```

Implement the exact delay function:

```js
export function reconnectDelayMs(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('attempt must be a positive integer');
  }
  return Math.min(500 * (2 ** Math.min(attempt - 1, 16)), 30_000);
}

function createDefaultOperationId(clock) {
  let sequence = 0;
  return ({ endpointId, attempt }) => {
    sequence += 1;
    return `reconnect-${endpointId}-${clock()}-${attempt}-${sequence}`;
  };
}
```

`arm(endpointId, operationId)` replaces any older generation and stores the manual operation without exposing a reconnect snapshot. `connected(identity)` accepts only the current operation/session, clears a timer, retains desired-open identity privately, and resets retry attempt to zero. `failed(identity)` accepts only the current identity, ignores a repeated terminal identity, increments the attempt, and publishes a frozen `waiting` snapshot with `nextRetryAt = clock() + delay`.

When the timer fires, verify record identity before and after every asynchronous boundary, publish `connecting`, create a fresh operation id, and call:

```js
const result = await openAttempt({ endpointId, operationId, generation, attempt });
if (result?.ok) {
  controller.connected({
    endpointId,
    operationId,
    sessionId: result.value?.sessionId ?? result.value?.id,
  });
} else {
  controller.failed({
    endpointId,
    operationId,
    sessionId: null,
    error: result?.error ?? new Error('TCP reconnect attempt failed'),
  });
}
```

Validate every generated operation id as a nonblank string before invoking `openAttempt`. Catch thrown `openAttempt` errors and route them through the same `failed` path. Normalize public `lastError` to a frozen `{ code, message }` object. `cancel` increments the internal generation, clears the timer, removes public/private state, and returns the cancelled `{ phase, operationId }` identity so the workbench can cancel an in-flight native open. `reconcile(endpoints)` only cancels existing records that are no longer eligible; it never arms loaded endpoints. Mutate the injected stable `states` map in place and call `onChange(states)` after each public-state change, isolating observer exceptions so they cannot interrupt timer/resource ownership.

- [ ] **Step 4: Run controller tests and shared lint**

Run: `node --test packages/workbench/tests/tcpReconnectController.test.js && npx eslint packages/workbench/src/model/tcpReconnectController.js packages/workbench/tests/tcpReconnectController.test.js`

Expected: all controller tests PASS and ESLint exits 0.

- [ ] **Step 5: Commit the controller**

```bash
git add packages/workbench/src/model/tcpReconnectController.js packages/workbench/tests/tcpReconnectController.test.js packages/workbench/tests/helpers/fakeTimers.js
git commit -m "feat: add tcp reconnect controller"
```

---

### Task 3: Workbench Lifecycle Integration

**Files:**
- Modify: `packages/workbench/src/model/createWorkbenchModel.js`
- Modify: `packages/workbench/tests/workbenchModel.test.js`

**Interfaces:**
- Consumes: `createTcpReconnectController` from Task 2 and `normalizeTcpResilienceConfig` from Task 1.
- Consumes: `createFakeTimers` from `packages/workbench/tests/helpers/fakeTimers.js` in model tests.
- Produces: `createWorkbenchModel(runtimeAdapter, { clock, timers, createReconnectOperationId, ... })`.
- Produces: `state.reconnects: Map<string, ReconnectSnapshot>` and `model.reconnectStateFor(endpointId)`.
- Produces: `model.commands.cancelReconnect(endpointId)`.
- Preserves: public `model.commands.open(endpointId, operationId)` and runtime `transport.open(endpointId, { operationId })` signatures.

- [ ] **Step 1: Write failing model integration and race tests**

Extend the existing adapter harness with fake timers and an auto-reconnect TCP client. Add tests proving:

```js
test('TCP client retries failed open through the lifecycle coordinator', async () => {
  const timers = createFakeTimers();
  const calls = [];
  const client = {
    ...endpoint('tcp-client-1', 'tcp-client'),
    config: { autoReconnect: true },
  };
  const { adapter } = createAdapter({ endpoints: [client] });
  adapter.transport.open = async (endpointId, options) => {
    calls.push([endpointId, options.operationId]);
    if (calls.length < 3) throw Object.assign(new Error('refused'), { code: 'IO_ERROR' });
    return { sessionId: 'reconnected-session' };
  };
  const model = createWorkbenchModel(adapter, {
    timers,
    clock: () => timers.now,
    createReconnectOperationId: ({ attempt }) => `retry-${attempt}`,
  });
  await model.commands.loadEndpoints();

  assert.equal((await model.commands.open('tcp-client-1', 'manual-1')).ok, false);
  assert.equal(model.reconnectStateFor('tcp-client-1').phase, 'waiting');
  await timers.runNext();
  await timers.runNext();

  assert.deepEqual(calls, [
    ['tcp-client-1', 'manual-1'],
    ['tcp-client-1', 'retry-1'],
    ['tcp-client-1', 'retry-2'],
  ]);
  assert.equal(model.state.operations.get('tcp-client-1').sessionId, 'reconnected-session');
  assert.equal(model.reconnectStateFor('tcp-client-1'), null);
});
```

Add separate tests for remote `error` then `closed` deduplication, close-before-native-closed, cancel during wait, cancel during automatic connect, edit/save/delete cancellation, manual-open replacement, workspace reset/load reconciliation, dispose, disabled client, TCP server, and late automatic acknowledgement after a newer manual operation.

- [ ] **Step 2: Run the model test and confirm the red state**

Run: `node --test packages/workbench/tests/workbenchModel.test.js`

Expected: FAIL because reconnect options/state/commands do not exist.

- [ ] **Step 3: Integrate without changing the runtime contract**

Add `reconnects: new Map()` to state and pass it as the controller's `states` option. `onChange` calls the existing notifier; the controller mutates the stable map before notification.

Factor the current open command body into one private function. The manual-origin policy decision happens only after the existing duplicate-id guard:

```js
function openEndpoint(endpointId, operationId, { origin = 'manual' } = {}) {
  return runCommand(`transport:${endpointId}`, async (command) => {
    requireTrackedEndpoint(state, endpointId);
    const intent = snapshotOperation({ endpointId, sessionId: null, operationId });
    if (state.operations.get(endpointId)?.operationId === operationId
      || coordinator.hasOperation(endpointId, operationId)) {
      throw new DuplicateOperationIdError(endpointId, operationId);
    }
    const endpoint = state.endpoints.find(({ id }) => id === endpointId);
    if (origin === 'manual') {
      const resilience = normalizeTcpResilienceConfig(endpoint.config, endpoint.transport);
      if (endpoint.transport === 'tcp-client' && resilience.autoReconnect) {
        reconnectController.arm(endpointId, operationId);
      } else {
        reconnectController.cancel(endpointId);
      }
    }
    return executeOpenLifecycle({ endpointId, operationId, intent, command });
  }, { endpointId });
}
```

Define `executeOpenLifecycle` inside `createCommands` by moving the current post-validation open body into it. Preserve the existing prior-gate rollback, coordinator readiness, enqueue, session binding, state invalidation, and notification statements in their current order. Add only these controller calls at the existing success and catch points:

```js
async function executeOpenLifecycle({ endpointId, operationId, intent, command }) {
  const priorGate = captureEndpointGate(state, endpointId);
  const transition = coordinator.beginOpenIntent(endpointId, operationId, {
    blockedSessionIds: priorGate.operation?.sessionId
      ? [priorGate.operation.sessionId]
      : [],
  });
  invalidateEndpointOperation(state, endpointId);
  state.operations.set(endpointId, intent);
  notify();
  const readiness = transition.cancellation.catch((error) => {
    if (transition.wasRolledBack()) {
      restoreEndpointGate(state, endpointId, priorGate);
      notify();
    }
    throw error;
  });
  try {
    const value = await coordinator.enqueueOpen(
      transition.intent,
      async () => {
        await readiness;
        requireTrackedEndpoint(state, endpointId);
        if (!coordinator.isCurrent(transition.intent)) {
          throw createSupersededOpenError(endpointId, operationId);
        }
        return runtimeAdapter.transport.open(endpointId, { operationId });
      },
      { readiness },
    );
    const sessionId = requireOpenSessionId(value);
    if (command.isActive()
      && coordinator.isCurrent(transition.intent)
      && endpointExists(state, endpointId)) {
      coordinator.bindSession(transition.intent, sessionId);
      model.activateOperation({ endpointId, sessionId, operationId });
      reconnectController.connected({ endpointId, operationId, sessionId });
    } else if (coordinator.isCurrent(transition.intent)) {
      coordinator.clearIntent(transition.intent);
      invalidateEndpointOperation(state, endpointId);
      notify();
    }
    return value;
  } catch (error) {
    reconnectController.failed({
      endpointId, operationId, sessionId: null, error,
    });
    if (coordinator.isCurrent(transition.intent)) {
      coordinator.clearIntent(transition.intent);
      invalidateEndpointOperation(state, endpointId);
      notify();
    }
    throw error;
  }
}
```

The controller identity gate makes `failed` inert after explicit cancellation, disposal, a newer manual generation, or for endpoints never armed for reconnect. Return a bundle from `createCommands`:

```js
return {
  commands,
  openReconnectAttempt: ({ endpointId, operationId }) =>
    openEndpoint(endpointId, operationId, { origin: 'reconnect' }),
};
```

Feed only already-validated, already-gated status events into the controller. `open` calls `connected`; `error` and `closed` call `failed`. Never infer eligibility from error text.

Implement a shared disarm helper used before close, cancel-open, edit/save, delete, reset/load invalidation, and dispose. For an automatic attempt in `connecting`, disarm synchronously first, then invalidate its operation through the lifecycle coordinator so native `cancelOpen` runs. Add `commands.cancelReconnect(endpointId)` for waiting/connecting UI and edit actions.

- [ ] **Step 4: Run model, controller, and lifecycle regression tests**

Run: `node --test packages/workbench/tests/tcpReconnectController.test.js packages/workbench/tests/workbenchModel.test.js packages/workbench/tests/endpointLifecycleCoordinator.test.js`

Expected: all tests PASS, including existing operation-id and dispose races.

- [ ] **Step 5: Run focused lint and commit**

Run: `npx eslint packages/workbench/src/model/createWorkbenchModel.js packages/workbench/tests/workbenchModel.test.js`

Then:

```bash
git add packages/workbench/src/model/createWorkbenchModel.js packages/workbench/tests/workbenchModel.test.js
git commit -m "feat: integrate tcp automatic reconnect"
```

---

### Task 4: TCP Settings and Reconnecting UI

**Files:**
- Modify: `packages/workbench/src/components/EndpointDialog.vue`
- Modify: `packages/workbench/src/components/EndpointRow.vue`
- Modify: `packages/workbench/src/components/EndpointTree.vue`
- Modify: `packages/workbench/src/components/SessionStatusBar.vue`
- Modify: `packages/workbench/src/layouts/DevToolShell.vue`
- Modify: `packages/workbench/src/App.vue`
- Modify: `packages/workbench/src/styles/workbench.css`
- Modify: `packages/workbench/tests/components/EndpointDialog.test.js`
- Modify: `packages/workbench/tests/components/EndpointRow.test.js`
- Create: `packages/workbench/tests/components/SessionStatusBar.test.js`

**Interfaces:**
- Consumes: Task 1 normalizer/constants and Task 3 `reconnectStateFor`/`cancelReconnect`.
- Produces dialog fields `keepAlive`, `keepAliveInitialDelaySeconds`, and client-only `autoReconnect` in saved endpoint config.
- Produces component prop `reconnectState` and derived visual states `reconnect-waiting` / `reconnecting`.

- [ ] **Step 1: Write failing dialog tests**

Add tests that open legacy TCP client/server endpoints and assert:

```js
expect(document.querySelector('input[name="tcp-keep-alive"]').checked).toBe(true);
expect(document.querySelector('input[name="tcp-keep-alive-delay"]').value).toBe('30');
expect(document.querySelector('input[name="tcp-auto-reconnect"]')).not.toBeNull();
```

For TCP server, assert `tcp-auto-reconnect` is absent. Toggle keepalive off, assert the delay control is disabled but retains `30`, submit, and assert:

```js
expect(saveCommand.mock.calls[0][0].config).toEqual(expect.objectContaining({
  keepAlive: { enabled: false, initialDelaySeconds: 30 },
  autoReconnect: true,
}));
```

Set delays `0`, `3601`, and `1.5`; assert save is blocked, the Chinese range error is rendered, and the delay input receives focus.

- [ ] **Step 2: Write failing reconnect status/action tests**

In row and status-bar tests, pass:

```js
const waiting = {
  endpointId: 'tcp-client-1', phase: 'waiting', attempt: 2,
  nextRetryAt: 1_720_000_001_000, operationId: null, lastError: null,
};
```

Assert `等待重连（第 2 次）`, a cancel button, no open button, and one emitted `cancel`. Repeat with phase `connecting` and assert `正在重连（第 2 次）`. Add a `DevToolShell` component assertion that choosing `编辑` calls `model.commands.cancelReconnect(endpoint.id)` before the dialog becomes visible.

- [ ] **Step 3: Run component tests and confirm the red state**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/EndpointDialog.test.js tests/components/EndpointRow.test.js tests/components/SessionStatusBar.test.js`

Expected: FAIL because controls, props, and labels do not exist.

- [ ] **Step 4: Implement the endpoint controls**

Initialize forms from `normalizeTcpResilienceConfig(endpoint?.config, endpoint?.transport)`. Add fields to `emptyForm` and include this shape in TCP client/server saves:

```js
keepAlive: {
  enabled: Boolean(form.keepAlive),
  initialDelaySeconds: Number(form.keepAliveInitialDelaySeconds),
},
```

Only the client save adds `autoReconnect: Boolean(form.autoReconnect)`. Render a compact TCP advanced fieldset with native checkbox/toggle semantics and a number input using `min="1"`, `max="3600"`, and `step="1"`. Keep the delay value in form state while disabled.

- [ ] **Step 5: Implement derived reconnect presentation and actions**

Pass reconnect snapshots through `DevToolShell -> EndpointTree -> EndpointRow` and directly to `SessionStatusBar`. Resolve reconnect state before existing operation/status logic:

```js
if (props.reconnectState?.phase === 'waiting') return 'reconnect-waiting';
if (props.reconnectState?.phase === 'connecting') return 'reconnecting';
```

Use labels `等待重连（第 ${attempt} 次）` and `正在重连（第 ${attempt} 次）`. Both states render the existing `X` cancel affordance with an accurate `aria-label`. In `App.vue`, route cancel to `commands.cancelReconnect` when reconnect state exists, otherwise retain current `commands.cancelOpen`. In `showEditDialog`, invoke `void props.model.commands.cancelReconnect(endpoint.id)` before setting `dialogOpen`.

Add restrained neutral/warning CSS for the two status-dot/session-state classes. Preserve fixed action dimensions and run existing text-fit assertions.

- [ ] **Step 6: Run component, localization, and UI contract tests**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/EndpointDialog.test.js tests/components/EndpointRow.test.js tests/components/SessionStatusBar.test.js tests/localization.test.js tests/uiContract.test.js`

Expected: all selected Vitest tests PASS.

- [ ] **Step 7: Run focused lint and commit**

Run: `npx eslint packages/workbench/src/components/EndpointDialog.vue packages/workbench/src/components/EndpointRow.vue packages/workbench/src/components/EndpointTree.vue packages/workbench/src/components/SessionStatusBar.vue packages/workbench/src/layouts/DevToolShell.vue packages/workbench/src/App.vue packages/workbench/tests/components/EndpointDialog.test.js packages/workbench/tests/components/EndpointRow.test.js packages/workbench/tests/components/SessionStatusBar.test.js`

Then:

```bash
git add packages/workbench/src packages/workbench/tests/components
git commit -m "feat: add tcp resilience controls"
```

---

### Task 5: Electron Socket Keepalive

**Files:**
- Modify: `apps/electron/electron/tcpService.cjs`
- Modify: `apps/electron/tests/tcpService.test.js`

**Interfaces:**
- Consumes endpoint config `keepAlive: { enabled, initialDelaySeconds }` with legacy defaults.
- Produces `configureConnectedSocket(socket, keepAlive)` applying `setNoDelay(true)` and `setKeepAlive(enabled, initialDelaySeconds * 1000)`.
- Preserves all `TcpService` public methods and event payloads.

- [ ] **Step 1: Write failing client and peer socket tests**

Extend `FakeSocket`:

```js
setKeepAlive(enabled, initialDelay) {
  if (this.keepAliveError) throw this.keepAliveError;
  this.keepAliveCalls ??= [];
  this.keepAliveCalls.push({ enabled, initialDelay });
}
```

Add tests for legacy default, explicit disabled, delay bounds/type errors, client setup failure, and accepted peer setup failure. Core assertions:

```js
assert.deepEqual(clientSocket.keepAliveCalls, [{ enabled: true, initialDelay: 30_000 }]);
assert.deepEqual(disabledSocket.keepAliveCalls, [{ enabled: false, initialDelay: 45_000 }]);
assert.equal(service.sessions.get('server-1').peers.size, 0);
assert.equal(server.listening, true);
assert.equal(statusLogs.some((log) => log.level === 'warn' && /keepalive/i.test(log.message)), true);
```

- [ ] **Step 2: Run Electron TCP tests and confirm the red state**

Run: `node --test apps/electron/tests/tcpService.test.js`

Expected: FAIL because `setKeepAlive` is never called and invalid keepalive configs are accepted.

- [ ] **Step 3: Implement strict native parsing and socket setup**

Make both `tcpClientOptions` and `tcpServerOptions` include `keepAlive: tcpKeepAliveOptions(config)` where missing means `{ enabled: true, initialDelaySeconds: 30 }`. Reject non-plain values, accessors/proxies through the existing record guards, extra nested keys, non-booleans, and non-integer/out-of-range delays.

Use:

```js
function configureConnectedSocket(socket, keepAlive) {
  socket.setNoDelay(true);
  socket.setKeepAlive(keepAlive.enabled, keepAlive.initialDelaySeconds * 1000);
}
```

For clients, call it after the connect event and before `session.phase = 'open'`. For accepted peers, allocate identity, pause, configure, and create the framer before adding the peer to `session.peers`. On peer setup failure, destroy only that socket and emit a `listening` status with a warning TCP log containing peer id and remote address. Do not close the server or emit endpoint `error`.

- [ ] **Step 4: Run Electron regression tests and lint**

Run: `node --test apps/electron/tests/tcpService.test.js apps/electron/tests/serialService.test.js && npx eslint apps/electron/electron/tcpService.cjs apps/electron/tests/tcpService.test.js`

Expected: all selected Node tests PASS and ESLint exits 0.

- [ ] **Step 5: Commit Electron keepalive**

```bash
git add apps/electron/electron/tcpService.cjs apps/electron/tests/tcpService.test.js
git commit -m "feat: configure electron tcp keepalive"
```

---

### Task 6: Tauri Socket Keepalive

**Files:**
- Modify: `apps/tauri/src-tauri/Cargo.toml`
- Modify: `apps/tauri/src-tauri/Cargo.lock`
- Modify: `apps/tauri/src-tauri/src/tcp.rs`

**Interfaces:**
- Consumes the same endpoint `keepAlive` shape and legacy defaults as Electron.
- Produces private `TcpKeepAliveConfig { enabled: bool, initial_delay: Duration }`.
- Produces `configure_stream(stream, keep_alive)` using `socket2::SockRef` and `TcpKeepalive`.
- Preserves Tauri command and serial-derived event contracts.

- [ ] **Step 1: Write failing Rust config and socket tests**

Extend `tcp_config_enforces_client_and_server_shapes` or add focused tests:

```rust
#[test]
fn tcp_config_normalizes_and_validates_keepalive() {
    let legacy = TcpConfig::client_from_value(&json!({
        "host": "127.0.0.1", "port": 4100
    })).unwrap();
    assert!(legacy.keep_alive.enabled);
    assert_eq!(legacy.keep_alive.initial_delay, Duration::from_secs(30));

    let disabled = TcpConfig::server_from_value(&json!({
        "listenHost": "127.0.0.1", "listenPort": 0,
        "keepAlive": { "enabled": false, "initialDelaySeconds": 3600 }
    })).unwrap();
    assert!(!disabled.keep_alive.enabled);
    assert_eq!(disabled.keep_alive.initial_delay, Duration::from_secs(3600));

    for value in [json!(0), json!(3601), json!(1.5), json!("30")] {
        assert!(TcpConfig::client_from_value(&json!({
            "host": "127.0.0.1", "port": 4100,
            "keepAlive": { "enabled": true, "initialDelaySeconds": value }
        })).is_err());
    }
}
```

Add a localhost test that calls `configure_stream` for enabled and disabled values and verifies `SockRef::keepalive()`. Add an accepted-stream configuration-failure seam, parallel to `fail_before_client_reader`, and assert the listener stays active while a warning log is emitted.

- [ ] **Step 2: Run focused Rust tests and confirm the red state**

Run: `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml tcp_config_normalizes_and_validates_keepalive`

Expected: compilation FAIL because `TcpConfig.keep_alive` and `socket2` imports are absent.

- [ ] **Step 3: Add the direct dependency and strict config parser**

Add:

```toml
socket2 = "0.6.4"
```

Define:

```rust
#[derive(Clone, Copy)]
struct TcpKeepAliveConfig {
    enabled: bool,
    initial_delay: Duration,
}
```

Parse missing as enabled/30 seconds. When present, require exactly `enabled` and `initialDelaySeconds`, a boolean, and an integer `1..=3600`. Store the result on `TcpConfig` so client and accepted streams use the endpoint's normalized policy.

- [ ] **Step 4: Apply keepalive before stream cloning or publication**

Change the helper signature and implementation:

```rust
fn configure_stream(stream: &TcpStream, keep_alive: TcpKeepAliveConfig) -> TcpResult<()> {
    let socket = socket2::SockRef::from(stream);
    socket.set_keepalive(keep_alive.enabled).map_err(map_tcp_error)?;
    if keep_alive.enabled {
        let options = socket2::TcpKeepalive::new().with_time(keep_alive.initial_delay);
        socket.set_tcp_keepalive(&options).map_err(map_tcp_error)?;
    }
    stream.set_nodelay(true).map_err(map_tcp_error)?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).map_err(map_tcp_error)?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT)).map_err(map_tcp_error)
}
```

Call it after client connect and immediately after server accept, before `try_clone`, peer insertion, or reader spawn. On accepted-peer setup failure, close that stream, emit one `SerialStatus::Listening` warning log with the allocated peer id/address, and continue the accept loop.

- [ ] **Step 5: Run Rust formatting and the complete Rust suite**

Run: `cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check && cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml`

Expected: formatting passes; all non-ignored Rust tests PASS; the existing three environment probes remain ignored in the normal suite.

- [ ] **Step 6: Confirm dependency lock scope and commit**

Run: `git diff -- apps/tauri/src-tauri/Cargo.lock`

Expected: `socket2 0.6.4` becomes a direct package dependency without a second `socket2` version or unrelated package updates. If Cargo does not alter the lockfile because the package already exists, do not stage a no-op file.

Then:

```bash
git add apps/tauri/src-tauri/Cargo.toml apps/tauri/src-tauri/Cargo.lock apps/tauri/src-tauri/src/tcp.rs
git commit -m "feat: configure tauri tcp keepalive"
```

---

### Task 7: Browser, Localhost, and Phase 05 Acceptance

**Files:**
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`
- Modify: `packages/workbench/e2e/workbench.spec.js`
- Modify: `tooling/tcp-test/localhost-loopback.mjs`
- Modify: `docs/verification/phase-05.md`

**Interfaces:**
- Consumes all prior shared-model/UI/native behavior.
- Produces preview counters in `globalThis.__INEED_PREVIEW_TCP_OPEN_ATTEMPTS__` for deterministic browser assertions.
- Produces an added `tcp-reconnect` summary in `TCP_ACCEPTANCE_RESULT` and retains `managedChildren: 0`.

- [ ] **Step 1: Write the failing Playwright flow for both bridges**

Add a preview TCP client configured with explicit keepalive and `autoReconnect: true`. Make preview `transport.open` reject that endpoint with a controlled `IO_ERROR` while recording operation ids. Add a runtime-looped test:

```js
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} configures TCP resilience and cancels a pending retry`, async ({ page }) => {
    await openPreview(page, runtime);
    const endpoint = page.getByRole('button', { name: '选择 云端TCP客户端' });
    const entry = page.locator('.endpoint-tree__entry').filter({ has: endpoint });

    await entry.getByRole('button', { name: '端点操作' }).click();
    await entry.getByRole('menuitem', { name: '编辑' }).click();
    const dialog = page.getByRole('dialog', { name: '编辑端点' });
    await expect(dialog.getByRole('checkbox', { name: 'TCP Keepalive' })).toBeChecked();
    await expect(dialog.getByRole('spinbutton', { name: '首次探测延迟（秒）' })).toHaveValue('30');
    await expect(dialog.getByRole('checkbox', { name: '自动重连' })).toBeChecked();
    await dialog.getByRole('button', { name: '取消' }).click();

    await entry.getByRole('button', { name: '打开端点' }).click();
    await expect(entry).toContainText('等待重连（第 1 次）');
    await entry.getByRole('button', { name: '取消自动重连' }).click();
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => globalThis.__INEED_PREVIEW_TCP_OPEN_ATTEMPTS__.length)).toBe(1);
    await expect(entry.getByRole('button', { name: '打开端点' })).toBeVisible();
  });
}
```

- [ ] **Step 2: Run the focused Playwright test and confirm the red state**

Run: `npm run test:e2e -w @ineed-dev-tool/workbench -- --grep "configures TCP resilience"`

Expected: FAIL because the fixture does not expose retry behavior and the UI controls/state are absent from the preview data.

- [ ] **Step 3: Implement preview failure instrumentation and pass browser acceptance**

Initialize `__INEED_PREVIEW_TCP_OPEN_ATTEMPTS__ = []` in the fixture. In both Electron and Tauri invocation routing, record `{ endpointId, operationId, createdAt }` and reject only the designated unavailable TCP client. Preserve all active-server fixture behavior.

Run: `npm run test:e2e -w @ineed-dev-tool/workbench -- --grep "configures TCP resilience"`

Expected: both Electron and Tauri preview cases PASS.

- [ ] **Step 4: Add a real localhost reconnect acceptance scenario**

In `localhost-loopback.mjs`, build a full runtime adapter from `createUnavailableRuntimeAdapter('tcp-reconnect-acceptance')`, overriding endpoint list and transport methods to route one endpoint through the real Electron `TcpService`. Forward service events to adapter subscribers and count open timestamps/operation ids.

The scenario must:

1. Reserve then release a localhost port.
2. Explicitly open an auto-reconnect client while unavailable and observe the manual failure.
3. Observe retry 1 after approximately 500 ms fail.
4. Start a server on the same port before retry 2 and observe connection success.
5. Destroy the server's accepted socket and close its listener, observe a fresh retry sequence beginning at 500 ms, cancel while waiting, and wait past the deadline.
6. Assert no additional open call occurs after cancellation, operation ids are unique, the service has no sessions, the model/controller is disposed, and `managedChildren.size === 0`.

Return:

```js
{
  runtime: 'shared-electron',
  scenario: 'tcp-reconnect',
  attempts,
  uniqueOperationIds,
  cancelled: true,
  managedSessions: 0,
}
```

Append it to the existing TCP acceptance summaries without weakening current frame/log/peer assertions; apply frame/log minimum assertions only to transport loopback summaries that contain those fields.

- [ ] **Step 5: Run TCP acceptance and inspect its reported evidence**

Run: `node tooling/tcp-test/localhost-loopback.mjs`

Expected: exit 0; `TCP_ACCEPTANCE_RESULT` contains existing Electron, Tauri, and two mixed-runtime summaries plus `tcp-reconnect`; final `managedChildren` is 0.

- [ ] **Step 6: Run the complete project verification gate**

Run: `npm run verify:phase-05`

Expected: exit 0 for Node tests, Vitest, ESLint, both production builds, Rust formatting/tests, Playwright across all configured viewports, serial PTY acceptance, TCP acceptance including reconnect, UDP acceptance, and `git diff --check`.

If the offline machine lacks a required cached dependency, record the exact failing command and network-resolution error, restore no files, and rerun this same gate once connectivity returns. Do not classify dependency download failure as a product regression.

- [ ] **Step 7: Update Phase 05 evidence with actual results**

Update `docs/verification/phase-05.md` with the current date and the exact counts printed by Step 6. Add evidence bullets for:

- default-on keepalive configuration on Electron and Tauri client/accepted sockets;
- client-only default-off automatic reconnect;
- exact capped backoff and cancellation races;
- browser acceptance on Electron and Tauri bridges;
- real localhost fail/start/reconnect/cancel behavior;
- final `managedChildren: 0` and no live TCP sessions.

Do not retain the older numeric counts if they changed.

- [ ] **Step 8: Review scope and commit final acceptance evidence**

Run: `git diff --check && git status --short`

Expected: only Task 7 files are pending and no generated screenshots, build output, database files, or package artifacts are untracked.

Then:

```bash
git add packages/workbench/e2e/fixtures/previewBridge.js packages/workbench/e2e/workbench.spec.js tooling/tcp-test/localhost-loopback.mjs docs/verification/phase-05.md
git commit -m "test: verify tcp resilience end to end"
```

---

## Final Review Checklist

- [ ] Read `docs/superpowers/specs/2026-09-02-tcp-keepalive-reconnect-design.md` beside the final diff and account for every in-scope requirement.
- [ ] Confirm no native runtime contains retry timers or reconnect policy.
- [ ] Confirm TCP server, serial, and UDP endpoint behavior is unchanged except server peer keepalive.
- [ ] Confirm explicit user actions disarm before native cancellation/close events can arrive.
- [ ] Confirm all automatic operation ids are unique and stale generations are inert.
- [ ] Confirm Electron and Tauri configure only keepalive enablement and first-probe delay.
- [ ] Confirm `npm run verify:phase-05` exits 0 and the verification document contains the actual results.
- [ ] Confirm `git status --short` is empty after the final commit.
