# Modbus Master Nested Requests V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing Modbus master from version 2 request groups to version 3 groups containing independently scheduled requests, while preserving every existing endpoint configuration and history row.

**Architecture:** Keep native Electron and Rust services at the one-request/one-response boundary. Normalize persisted version 2 JSON into a stable version 3 hierarchy in the shared workbench model, schedule child requests through one serialized endpoint queue, and keep request/group runtime state in memory. Split group metadata editing from request/data-point editing so the UI mirrors the domain model.

**Tech Stack:** Vue 3, JavaScript ESM, Node test runner, Vitest, Playwright, Electron, Rust/Tauri, tokio-modbus, SQLite.

**Spec:** `docs/superpowers/specs/2026-09-12-modbus-master-request-groups-design.md`

## Global Constraints

- Preserve the existing TCP/RTU runtime boundary and immediate read/write tools.
- Store version 3 configuration only in the existing endpoint `config_json`; add no SQLite migration.
- Normalize version 2 configurations in memory and persist version 3 only after an explicit user save.
- Never delete, recreate, or rewrite endpoint history, frame history, logs, send history, templates, or settings during migration.
- One group owns exactly one Slave ID; one request owns exactly one FC01-FC04 function code and one contiguous range.
- Serialize scheduled, manual, retry, immediate-read, and write operations per endpoint.
- Keep Electron and Tauri behavior and visuals equivalent.
- Do not commit the shared dirty worktree until the user explicitly requests a commit.

---

### Task 1: Version 3 Configuration Normalization And Validation

**Files:**
- Modify: `packages/workbench/src/model/modbusMasterConfig.js`
- Modify: `packages/workbench/src/model/endpointDraft.js`
- Modify: `packages/workbench/tests/modbusMasterConfig.test.js`
- Modify: `packages/workbench/tests/endpointDraft.test.js`

**Interfaces:**
- Produces: `normalizeModbusMasterConfig(config)` returning `configVersion: 3` and nested `requestGroups[].requests[]`.
- Produces: `validateModbusRequestGroups(groups, master)` with group, request, and data-point field errors.
- Produces: `cloneModbusRequestGroup(group, createId)` and `cloneModbusRequest(request, createId)` with fresh nested IDs.
- Consumes: existing `normalizeModbusConfig()` endpoint normalization without changing non-master transports.

- [x] **Step 1: Add failing version 2 migration and idempotence tests**

```js
test('migrates one version 2 group into one deterministic version 3 request', () => {
  const normalized = normalizeModbusMasterConfig({
    configVersion: 2,
    requestGroups: [{
      id: 'boiler', name: '锅炉房', unitId: 7, enabled: true, order: 0,
      functionCode: 3, startAddress: 100, quantity: 10, intervalMs: 2000,
      timeoutMs: null, retryCount: null, retryIntervalMs: null,
      dataPoints: [{ id: 'temperature', key: 'temperature', name: '温度',
        enabled: true, offset: 0, dataType: 'float32', length: 2 }],
    }],
  });

  expect(normalized.configVersion).toBe(3);
  expect(normalized.requestGroups[0]).toMatchObject({
    id: 'boiler', name: '锅炉房', unitId: 7, enabled: true,
    requests: [expect.objectContaining({
      id: 'boiler-request', functionCode: 3, startAddress: 100,
      quantity: 10, intervalMs: 2000,
      dataPoints: [expect.objectContaining({ id: 'temperature', key: 'temperature' })],
    })],
  });
  expect(normalizeModbusMasterConfig(normalized)).toEqual(normalized);
});
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test packages/workbench/tests/modbusMasterConfig.test.js packages/workbench/tests/endpointDraft.test.js`

Expected: FAIL because normalization still keeps function/range/points on the group and reports `configVersion: 2`.

- [x] **Step 3: Implement deterministic v2-to-v3 normalization**

```js
function normalizeGroup(group, index) {
  const source = record(group);
  const id = text(source.id) || `request-group-${index + 1}`;
  const requests = Array.isArray(source.requests)
    ? source.requests.map(normalizeRequest)
    : hasLegacyRequestFields(source)
      ? [normalizeRequest({ ...pickLegacyRequestFields(source), id: `${id}-request` })]
      : [];
  return {
    id, name: text(source.name), description: text(source.description),
    unitId: integer(source.unitId, 1), enabled: source.enabled !== false,
    order: integer(source.order, index), requests,
  };
}
```

- [x] **Step 4: Add failing nested validation and cloning tests**

Cover literal cases for duplicate request IDs, duplicate point IDs/keys across sibling requests, FC limits, enabled points outside their request, disabled parked points, register bit overlap, nullable inheritance overrides, normalized ordering, and fresh IDs after group/request copy.

- [x] **Step 5: Implement nested validation and cloning**

Validation keys must identify the exact location, for example `requestGroup-0-request-1-quantity` and `requestGroup-0-request-1-dataPoint-2-offset`. Group cloning regenerates its own ID, every request ID, and every point ID/key; request cloning regenerates only that request and its point identities.

- [x] **Step 6: Run focused and endpoint component tests**

Run: `node --test packages/workbench/tests/modbusMasterConfig.test.js packages/workbench/tests/endpointDraft.test.js && npm run test:components -w @ineed-dev-tool/workbench -- tests/components/EndpointDialog.test.js tests/components/EndpointRow.test.js`

Expected: PASS with no configuration loss in existing endpoint-save tests.

---

### Task 2: Request-Level Decoding And Serialized Scheduling

**Files:**
- Modify: `packages/workbench/src/model/modbusMasterScheduler.js`
- Modify: `packages/workbench/src/model/modbusMasterDataPoints.js`
- Modify: `packages/workbench/tests/modbusMasterScheduler.test.js`
- Modify: `packages/workbench/tests/modbusMasterDataPoints.test.js`

**Interfaces:**
- Consumes: normalized `requestGroups[].requests[]` from Task 1.
- Produces: scheduler method `runRequest({ endpointId, groupId, requestId, sessionId })`.
- Produces: `runGroup(...)` returning `{ result: 'success'|'partial'|'failed', results: [...] }`.
- Produces: request-keyed status under `status.groups[groupId].requests[requestId]` and records containing both IDs.

- [x] **Step 1: Add failing independent-period and stable-order tests**

```js
test('schedules child requests by due time, group order, request order, and stable id', async () => {
  scheduler.start({ endpointId: 'master', sessionId: 'session', config: nestedConfig });
  await clock.advance(1000);
  expect(execute.mock.calls.map(([operation]) => [
    operation.requestGroupId, operation.requestId, operation.functionCode,
  ])).toEqual([
    ['boiler', 'coils', 1],
    ['boiler', 'registers', 3],
  ]);
});
```

- [x] **Step 2: Run scheduler tests and verify RED**

Run: `node --test packages/workbench/tests/modbusMasterScheduler.test.js packages/workbench/tests/modbusMasterDataPoints.test.js`

Expected: FAIL because the scheduler currently treats each group as one scheduled operation.

- [x] **Step 3: Replace group due-times with request due-times**

Use composite identities such as `${group.id}\u0000${request.id}` internally. Each request sets its next due time from completion plus its own `intervalMs`. Selection order is due time, group order, request order, group ID, then request ID.

- [x] **Step 4: Add failing manual execution and cancellation tests**

Cover manual execution of a disabled request, group execution of enabled children while the group is disabled, success/partial/failed summaries, continue-after-failure, inherited/overridden retries, minimum gaps, stop/dispose cancellation, reconcile during an active run, and no stale request state after move/delete.

- [x] **Step 5: Implement `runRequest`, group aggregation, and request state**

```js
async function runGroup({ endpointId, groupId, sessionId }) {
  const group = requireGroup(endpointId, groupId);
  const results = [];
  for (const request of ordered(group.requests).filter(({ enabled }) => enabled)) {
    if (isCancelled(endpointId)) break;
    results.push(await enqueueRequest({ endpointId, sessionId, group, request }));
  }
  return summarizeGroupRun(results);
}
```

Group execution must continue after a child error and store each child record. A connection-level close can still cancel the remaining queue.

- [x] **Step 6: Run scheduler and lifecycle regression tests**

Run: `node --test packages/workbench/tests/modbusMasterScheduler.test.js packages/workbench/tests/modbusMasterDataPoints.test.js packages/workbench/tests/workbenchModel.test.js packages/workbench/tests/tcpReconnectController.test.js`

Expected: PASS with periodic and manual operations serialized through one endpoint queue.

---

### Task 3: Native Correlation With Optional Request IDs

**Files:**
- Modify: `apps/electron/electron/modbusService.cjs`
- Modify: `apps/electron/tests/modbusService.test.js`
- Modify: `apps/tauri/src-tauri/src/modbus.rs`
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`

**Interfaces:**
- `modbus.execute` accepts optional nonblank `requestGroupId` and `requestId`.
- Transaction payloads emit `requestGroupId: string|null` and `requestId: string|null` without changing legacy calls.

- [x] **Step 1: Add failing Electron and Rust correlation tests**

```js
const transaction = await service.execute('master', {
  functionCode: 3, unitId: 1, address: 0, quantity: 2,
  requestGroupId: 'boiler', requestId: 'temperature',
});
assert.equal(transaction.requestGroupId, 'boiler');
assert.equal(transaction.requestId, 'temperature');
```

Rust tests must cover the same successful payload and rejection of blank request IDs. Electron tests must also verify correlation survives a Modbus exception response.

- [x] **Step 2: Run native focused tests and verify RED**

Run: `node --test apps/electron/tests/modbusService.test.js && cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml modbus -- --nocapture`

Expected: FAIL because `requestId` is not accepted or returned.

- [x] **Step 3: Implement optional request ID validation and propagation**

Keep both IDs optional for quick reads, writes, and older renderer callers. Do not require `requestGroupId` when `requestId` is supplied at the low-level boundary; shared scheduler calls will provide both.

- [x] **Step 4: Update deterministic preview transactions and run native tests**

Run: `node --test apps/electron/tests/modbusService.test.js && cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check && cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml modbus -- --nocapture`

Expected: PASS with legacy immediate-operation tests unchanged.

---

### Task 4: Separate Group And Request Editors

**Files:**
- Modify: `packages/workbench/src/components/ModbusRequestGroupDialog.vue`
- Create: `packages/workbench/src/components/ModbusRequestDialog.vue`
- Modify: `packages/workbench/tests/components/ModbusRequestGroupDialog.test.js`
- Create: `packages/workbench/tests/components/ModbusRequestDialog.test.js`
- Modify: `packages/workbench/src/styles/workbench.css`

**Interfaces:**
- Group dialog props: `open`, `group`, `masterConfig`, `existingGroups`; emits `save(groupMetadata)` and `cancel`.
- Request dialog props: `open`, `request`, `group`, `masterConfig`, `existingRequests`; emits `save(normalizedRequest)` and `cancel`.

- [x] **Step 1: Rewrite group-dialog tests to cover metadata only**

Assert that the dialog edits name, description, Slave ID, and enabled state and renders no function-code, range, period, retry, or point controls.

- [x] **Step 2: Add failing request-dialog tests**

Cover create/edit, FC01-FC04, range limits, independent interval, nullable inherited timeout/retry controls, point add/copy/reorder/toggle/delete, type-length updates, overlap errors, and focus/close behavior.

- [x] **Step 3: Run both component tests and verify RED**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusRequestGroupDialog.test.js tests/components/ModbusRequestDialog.test.js`

Expected: FAIL because the current group dialog still owns request fields and the request dialog does not exist.

- [x] **Step 4: Implement the focused dialogs**

The group dialog must preserve its `requests` array without exposing or rebuilding it. The request dialog must clone points into local draft state and emit only after nested validation succeeds. Both dialogs use stable dimensions and keep action buttons in the footer.

- [x] **Step 5: Run focused tests and lint only changed components**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusRequestGroupDialog.test.js tests/components/ModbusRequestDialog.test.js && npx eslint packages/workbench/src/components/ModbusRequestGroupDialog.vue packages/workbench/src/components/ModbusRequestDialog.vue packages/workbench/tests/components/ModbusRequestGroupDialog.test.js packages/workbench/tests/components/ModbusRequestDialog.test.js`

Expected: PASS with zero lint errors.

---

### Task 5: Expandable Master Hierarchy And Nested CRUD

**Files:**
- Modify: `packages/workbench/src/components/ModbusMasterPanel.vue`
- Modify: `packages/workbench/tests/components/ModbusMasterPanel.test.js`
- Modify: `packages/workbench/src/styles/workbench.css`

**Interfaces:**
- Consumes: `cloneModbusRequest()`, group/request dialogs, and scheduler `runRequest()`/`runGroup()`.
- Persists: one complete endpoint snapshot containing normalized version 3 request groups.

- [x] **Step 1: Add failing hierarchy and CRUD tests**

Verify group headers show Slave ID plus request/point totals; expanding a group shows ordered requests with FC, address range, interval, points, and state. Cover group add/edit/copy/reorder/toggle/delete, request add/edit/copy/reorder/toggle/delete, run-request, and run-group commands.

- [x] **Step 2: Add failing live-data and record tests**

Verify live rows are grouped by both IDs, request errors do not hide sibling values, group summaries render success/partial/failure, and run records identify group and request names.

- [x] **Step 3: Run the panel test and verify RED**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusMasterPanel.test.js`

Expected: FAIL because current rows read function/range/points directly from each group.

- [x] **Step 4: Implement nested hierarchy and persistence**

Use unframed expandable sections, compact request rows, icon actions with accessible names/tooltips, and request-level latest state. Save actions replace only the affected group/request while retaining unrelated endpoint configuration.

- [x] **Step 5: Run master, shell, and endpoint component tests**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusMasterPanel.test.js tests/components/ModbusPanel.test.js tests/components/EndpointDialog.test.js tests/components/EndpointRow.test.js`

Expected: PASS for both TCP and RTU master fixtures.

---

### Task 6: Persistence And Upgrade Safety Proofs

**Files:**
- Modify: `apps/electron/tests/managementDatabase.test.js`
- Modify: `apps/tauri/src-tauri/src/database.rs`
- Modify: `packages/workbench/tests/workbenchModel.test.js`
- Modify: `packages/workbench/tests/endpointDraft.test.js`

**Interfaces:**
- No production database schema changes.
- Existing workspace schema version 1 imports and exports nested version 3 endpoint JSON.

- [x] **Step 1: Add populated-database upgrade tests**

Create fixtures containing a version 2 master plus endpoint/frame/log/send history. Load through each runtime, normalize through the workbench, explicitly save, and assert that only the target endpoint JSON becomes version 3 while all row counts and byte payloads remain identical.

- [x] **Step 2: Add no-write-on-load and workspace round-trip tests**

Assert that opening a version 2 endpoint does not invoke persistence save, and that workspace version 1 export/import retains nested groups, requests, point IDs, disabled fields, and unrelated endpoint config keys.

- [x] **Step 3: Run persistence suites**

Run: `node --test apps/electron/tests/managementDatabase.test.js packages/workbench/tests/workbenchModel.test.js packages/workbench/tests/endpointDraft.test.js && cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml database -- --nocapture`

Expected: PASS with no new migration file or migration ledger entry.

---

### Task 7: E2E Acceptance And Cross-Runtime Verification

**Files:**
- Modify: `packages/workbench/e2e/workbench.spec.js`
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`
- Modify: `tooling/modbus-test/cross-runtime.mjs` only if its deterministic fixtures require nested IDs.

**Interfaces:**
- Preview and native runtimes exercise the same version 3 configuration and transaction fields.

- [x] **Step 1: Add failing version 3 E2E flows**

For Electron and Tauri previews, create one group with mixed FC01 and FC03 requests, assign distinct polling intervals, decode points from both responses, run one request, run the whole group with one child failure, and verify the partial summary plus correlated records.

- [x] **Step 2: Run targeted E2E and verify RED**

Run: `npm run test:e2e -w @ineed-dev-tool/workbench -- --grep "nested Modbus master"`

Expected: FAIL until the preview bridge and UI expose request-level behavior.

- [x] **Step 3: Complete preview fixtures and responsive layout**

Ensure group and request actions remain visible without overlap at 1440x900, 1120x720, and 820x1180. Electron and Tauri screenshots must differ only in the runtime footer.

- [x] **Step 4: Run full verification**

Run:

```bash
npm test
npm run lint
npm run build
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
npm run test:e2e
node tooling/modbus-test/cross-runtime.mjs
git diff --check
```

Expected: all commands exit 0; E2E reports zero Electron/Tauri visual parity differences; TCP and RTU cross-runtime directions both pass.

- [x] **Step 5: Start both development applications for user acceptance**

Run `npm run dev:electron` and `npm run dev:tauri` on separate ports, then manually verify create/edit consistency, nested CRUD, periodic reads, manual request execution, group partial results, live values, and run records.
