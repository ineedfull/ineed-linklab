# Modbus Point History and Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist selected Modbus Master point outcomes and provide bounded, cross-point historical trend analysis in both Electron and Tauri.

**Architecture:** The shared Workbench scheduler emits final decoded point outcomes to a bounded `ModbusPointHistoryCollector`. The collector applies per-point capture policy and writes immutable batches through a shared runtime contract; Electron and Tauri validate and persist the same row shape in SQLite, perform bounded native aggregation, and expose identical query results to an ECharts-based trends tab.

**Tech Stack:** Vue 3, JavaScript ESM, Node/Electron IPC, Tauri 2/Rust, SQLite, Vitest, Node test runner, Cargo test, Playwright, Apache ECharts.

**Spec:** `docs/superpowers/specs/2026-09-14-modbus-point-history-design.md`

## Global Constraints

- Existing endpoint rows, frames, logs, send history, settings, and workspace data must survive migration unchanged.
- Legacy `saveHistory: true` with no `historyMode` means `on-change` in memory and is not automatically persisted.
- New and legacy points default to history disabled unless `saveHistory` is explicitly true.
- All persisted timestamps are safe Unix epoch milliseconds.
- Polling never waits for history persistence.
- Electron and Tauri must return the same normalized rows, series, paging, retention, and error behavior.
- Runtime assets and ECharts are bundled locally; no remote scripts or data are permitted.
- Alarm rules, Slave history, and request merge/split optimization remain out of scope.
- This checkout already contains substantial uncommitted Modbus Master/Slave work that this plan depends on. Do not create a worktree from `HEAD`, because it would omit that foundation; continue on a dedicated feature branch in the current checkout.
- Every `git add` block below is conditional. Before each task checkpoint, inspect the actual diff and stage only newly created files or hunks that are unambiguously owned by this plan. Never use a broad directory add when it could include pre-existing work.
- When a task modifies a file that was already dirty before this plan, complete and verify the task but defer its commit unless the history-specific hunks can be isolated without staging the earlier Modbus changes. Record the verified checkpoint and include it in a later user-approved integration commit.

---

### Task 1: Shared schema, settings, and runtime contract

**Files:**
- Create: `packages/persistence-contract/migrations/003-modbus-point-history.sql`
- Create: `packages/runtime-contract/src/modbusPointHistoryNormalizer.js`
- Create: `packages/runtime-contract/tests/modbusPointHistoryNormalizer.test.js`
- Modify: `packages/persistence-contract/src/schema.js`
- Modify: `packages/persistence-contract/tests/schema.test.js`
- Modify: `packages/runtime-contract/src/index.js`
- Modify: `packages/runtime-contract/src/settingsSchema.json`
- Modify: `packages/runtime-contract/tests/runtimeContract.test.js`
- Modify: `packages/runtime-contract/tests/settingsSchema.test.js`

**Interfaces:**
- Produces `normalizeModbusPointHistoryRows(rows)`, `normalizeModbusPointHistoryRow(row)`, `normalizeModbusPointHistoryQuery(query)`, and `normalizeModbusPointSeriesQuery(query)`.
- Produces runtime namespace `modbusHistory` with `recordBatch`, `querySeries`, `queryRows`, `exportCsv`, `clear`, `cleanup`, and `flush`.
- Produces lifecycle methods `onBeforeShutdown` and `readyForShutdown` for the bounded renderer flush handshake.
- Produces setting `modbusPointHistoryRetention: "7-days" | "30-days" | "90-days" | "forever"`.

- [x] **Step 1: Write failing migration and runtime-contract tests**

```js
assert.equal(SCHEMA_VERSION, 3);
assert.deepEqual(REQUIRED_RUNTIME_METHODS.filter((name) => name.startsWith('modbusHistory.')), [
  'modbusHistory.recordBatch', 'modbusHistory.querySeries', 'modbusHistory.queryRows',
  'modbusHistory.exportCsv', 'modbusHistory.clear', 'modbusHistory.cleanup',
  'modbusHistory.flush',
]);
assert.deepEqual(REQUIRED_RUNTIME_METHODS.filter((name) => name.startsWith('lifecycle.')), [
  'lifecycle.onBeforeShutdown', 'lifecycle.readyForShutdown',
]);
assert.equal(DEFAULT_SETTINGS.modbusPointHistoryRetention, '30-days');
```

The schema test must execute migrations 1, 2, and 3 in order and assert the exact `modbus_point_history` columns, three indexes, foreign key cascade, and ledger row `3:003-modbus-point-history`.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
node --test packages/persistence-contract/tests/schema.test.js \
  packages/runtime-contract/tests/runtimeContract.test.js \
  packages/runtime-contract/tests/settingsSchema.test.js \
  packages/runtime-contract/tests/modbusPointHistoryNormalizer.test.js
```

Expected: failures for schema version 2, missing migration, missing setting, missing runtime methods, and missing normalizers.

- [x] **Step 3: Add the additive migration and normalizers**

The migration must create this table and indexes inside one transaction:

```sql
CREATE TABLE modbus_point_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  request_group_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  point_id TEXT NOT NULL,
  point_key TEXT NOT NULL,
  point_name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  unit TEXT,
  raw_json TEXT NOT NULL,
  value_json TEXT NOT NULL,
  numeric_value REAL,
  display_value TEXT NOT NULL,
  quality TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoint_profiles(id) ON DELETE CASCADE
);
CREATE INDEX modbus_point_history_by_point
  ON modbus_point_history(
    endpoint_id, request_group_id, request_id, point_id, created_at DESC, id DESC
  );
CREATE INDEX modbus_point_history_by_request
  ON modbus_point_history(
    endpoint_id, request_group_id, request_id, created_at DESC, id DESC
  );
CREATE INDEX modbus_point_history_by_retention
  ON modbus_point_history(created_at, endpoint_id);
INSERT INTO schema_migrations(version, name, applied_at)
VALUES (3, '003-modbus-point-history', CAST(unixepoch('subsec') * 1000 AS INTEGER));
```

The row normalizer returns a deeply snapshotted plain object and validates finite `numericValue`, exact JSON-compatible raw/value values, ID byte bounds, known data types/qualities, and timestamp safety. Point identities use the exact `{ requestGroupId, requestId, pointId }` triple. The query normalizers cap point identities at six, page size at 200, bucket count at 2,000, and require `from <= to`.

- [x] **Step 4: Extend unavailable adapters and settings schema**

```js
modbusHistory: {
  recordBatch: reject('modbusHistory.recordBatch'),
  querySeries: async () => ({ series: [], from: null, to: null }),
  queryRows: async () => ({ rows: [], total: 0, page: 1, pageSize: 50 }),
  exportCsv: reject('modbusHistory.exportCsv'),
  clear: reject('modbusHistory.clear'),
  cleanup: reject('modbusHistory.cleanup'),
  flush: async () => ({ flushed: true }),
},
lifecycle: {
  onBeforeShutdown: () => () => {},
  readyForShutdown: reject('lifecycle.readyForShutdown'),
}
```

- [x] **Step 5: Run focused tests and commit**

```bash
node --test packages/persistence-contract/tests/schema.test.js packages/runtime-contract/tests/*.test.js
git add packages/persistence-contract packages/runtime-contract
git commit -m "feat(history): define modbus point history contract"
```

### Task 2: Electron SQLite persistence and bounded queries

**Files:**
- Modify: `apps/electron/electron/database.cjs`
- Modify: `apps/electron/tests/managementDatabase.test.js`
- Modify: `apps/electron/tests/configPersistence.test.js`

**Interfaces:**
- Consumes Task 1 migration and normalized row/query shapes.
- Produces database methods `recordModbusPointHistory`, `queryModbusPointHistoryRows`, `queryModbusPointSeries`, `clearModbusPointHistory`, and `cleanupModbusPointHistory`.

- [x] **Step 1: Write failing Electron database tests**

Create tests that insert an endpoint, atomically record numeric/Boolean/String/Int64 rows, and assert:

```js
assert.deepEqual(database.queryModbusPointHistoryRows({
  endpointId: 'master', points: [{
    requestGroupId: 'environment', requestId: 'holding-registers', pointId: 'temperature',
  }], from: start, to: end,
  page: 1, pageSize: 50,
}), {
  rows: [expectedNewest, expectedOlder], total: 2, page: 1, pageSize: 50,
});
```

Add rollback tests for one invalid row in a batch, foreign-key failure, stable `created_at DESC, id DESC` ordering, endpoint/point/time filters, and preservation of all existing tables through migration.

- [x] **Step 2: Verify Electron database RED**

```bash
node --test apps/electron/tests/managementDatabase.test.js apps/electron/tests/configPersistence.test.js
```

Expected: missing migration 3 and missing database methods.

- [x] **Step 3: Implement prepared statements and atomic batch writes**

Use `DatabaseSync.exec('BEGIN IMMEDIATE')`, validate and snapshot all rows before the transaction, insert with one prepared statement, and roll back on every error. Map rows with `JSON.parse(raw_json)` and `JSON.parse(value_json)` without coercing exact integer strings.

- [x] **Step 4: Implement detail paging, native series folding, clear, cleanup, and stats**

Series queries must iterate matching rows in ascending time order and fold into bounded buckets:

```js
const bucket = Math.min(
  query.bucketCount - 1,
  Math.floor(((row.createdAt - query.from) * query.bucketCount) / span),
);
```

Numeric buckets retain first/last/min/max and worst quality. Boolean results contain transitions only; String results contain value changes only; abnormal rows are retained as markers. Cleanup maps the retention enum to a cutoff and makes `forever` a no-op. Stats return `modbusPointHistoryCount`, `modbusPointHistoryEstimatedBytes`, and `modbusPointHistoryLastCleanupAt`.

- [x] **Step 5: Verify and commit Electron persistence**

```bash
node --test apps/electron/tests/managementDatabase.test.js apps/electron/tests/configPersistence.test.js
git add apps/electron/electron/database.cjs apps/electron/tests/managementDatabase.test.js \
  apps/electron/tests/configPersistence.test.js
git commit -m "feat(electron): persist modbus point history"
```

### Task 3: Tauri SQLite persistence parity

**Files:**
- Modify: `apps/tauri/src-tauri/src/database.rs`
- Modify: `apps/tauri/tests/configPersistence.test.js`

**Interfaces:**
- Consumes Task 1 migration and contract limits.
- Produces Rust structs `ModbusPointHistoryInput`, `ModbusPointHistoryQuery`, `ModbusPointSeriesQuery`, `ModbusPointHistoryPage`, and `ModbusPointSeriesResult` plus matching `ConfigurationDatabase` methods.

- [x] **Step 1: Write failing Rust database tests**

Add Rust tests mirroring Task 2 fixtures. The core parity assertion must compare serialized JSON:

```rust
assert_eq!(
    serde_json::to_value(database.query_modbus_point_history_rows(query).unwrap()).unwrap(),
    json!({"rows": expected_rows, "total": 2, "page": 1, "pageSize": 50})
);
```

Test exact UInt64 strings, composite point identity isolation, batch rollback, extrema-preserving numeric buckets, Boolean transitions, String events, abnormal markers, cleanup isolation, and migration preservation.

- [x] **Step 2: Verify Rust database RED**

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml database::tests::modbus_point_history -- --nocapture
```

Expected: missing types and methods.

- [x] **Step 3: Implement Rust validation, batch writes, queries, and retention**

Deserialize with `#[serde(rename_all = "camelCase", deny_unknown_fields)]`. Prevalidate the entire vector, use one SQLite transaction, preserve JSON as canonical `serde_json::Value`, and fold row iterators into the same bucket shape and quality ranking as Electron.

- [x] **Step 4: Extend storage statistics without changing existing totals unexpectedly**

Add explicit point-history fields and define `total_count` to include point-history rows only after updating both runtime tests and UI labels. Existing frame/log/send counts retain their meanings.

- [x] **Step 5: Verify parity fixtures and commit**

```bash
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml database::tests:: -- --nocapture
node --test apps/tauri/tests/configPersistence.test.js
git add apps/tauri/src-tauri/src/database.rs apps/tauri/tests/configPersistence.test.js
git commit -m "feat(tauri): persist modbus point history"
```

### Task 4: Electron and Tauri runtime boundaries plus CSV export

**Files:**
- Modify: `apps/electron/electron/main.cjs`
- Modify: `apps/electron/electron/preload.cjs`
- Modify: `apps/electron/renderer/runtimeAdapter.js`
- Modify: `apps/electron/tests/electronBoundary.test.js`
- Modify: `apps/electron/renderer/main.js`
- Modify: `apps/tauri/renderer/runtimeAdapter.js`
- Modify: `apps/tauri/renderer/main.js`
- Modify: `apps/tauri/src-tauri/src/database.rs`
- Modify: `apps/tauri/src-tauri/src/lib.rs`
- Modify: `apps/tauri/tests/tauriBoundary.test.js`

**Interfaces:**
- Consumes Task 2 and 3 database methods.
- Produces complete `runtime.modbusHistory` implementations and a two-second `lifecycle.onBeforeShutdown/readyForShutdown` handshake in both apps.

- [x] **Step 1: Write failing boundary tests**

Electron tests must assert exact IPC channels and plain envelopes. Tauri tests must assert exact command names. Both adapters must expose:

```js
Object.keys(adapter.modbusHistory).sort()
// ['cleanup', 'clear', 'exportCsv', 'flush', 'queryRows', 'querySeries', 'recordBatch']
```

Test untrusted sender rejection and ensure history-only windows cannot call point-history mutation methods. Add fake-clock tests proving shutdown waits for the matching renderer acknowledgement, ignores stale/wrong request IDs, joins repeated close signals, and proceeds after two seconds when the renderer does not answer.

- [x] **Step 2: Verify boundary RED**

```bash
node --test apps/electron/tests/electronBoundary.test.js apps/tauri/tests/tauriBoundary.test.js \
  packages/runtime-contract/tests/runtimeContract.test.js
```

- [x] **Step 3: Implement runtime methods and flush barriers**

Wire `recordBatch/querySeries/queryRows/clear/cleanup/flush` through both boundaries. `flush` resolves only after native database work already accepted by that boundary has completed. Workspace import, point-history clear, and CSV export await the collector/native flush barrier before reading or mutating history.

For application/window shutdown, generate a unique request ID, send `lifecycle:before-shutdown`, and wait for `readyForShutdown(requestId)` or a 2,000 ms deadline before closing transports and the database. Electron intercepts main-window `close` and `before-quit`; Tauri intercepts `CloseRequested` and `ExitRequested`. Normal renderer unmount is not treated as an asynchronous flush barrier.

- [x] **Step 4: Implement native CSV export safely**

Use the existing workspace file safety pattern: native save dialog, explicit regular-file checks, a sibling temporary file, streaming escaped CSV rows, atomic rename, and cleanup on failure. CSV escaping must quote fields containing comma, quote, CR, or LF and double embedded quotes.

- [x] **Step 5: Verify and commit runtime boundaries**

```bash
node --test apps/electron/tests/electronBoundary.test.js apps/tauri/tests/tauriBoundary.test.js
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml runtime::tests:: -- --nocapture
git add apps/electron/electron/main.cjs apps/electron/electron/preload.cjs \
  apps/electron/renderer/runtimeAdapter.js apps/electron/renderer/main.js \
  apps/electron/tests/electronBoundary.test.js apps/tauri/renderer/runtimeAdapter.js \
  apps/tauri/renderer/main.js apps/tauri/src-tauri/src/database.rs \
  apps/tauri/src-tauri/src/lib.rs apps/tauri/tests/tauriBoundary.test.js
git commit -m "feat(runtime): expose modbus point history operations"
```

### Task 5: Point policy normalization and scheduler outcome hook

**Files:**
- Modify: `packages/workbench/src/model/modbusMasterConfig.js`
- Modify: `packages/workbench/src/model/modbusMasterScheduler.js`
- Modify: `packages/workbench/tests/modbusMasterConfig.test.js`
- Modify: `packages/workbench/tests/modbusMasterScheduler.test.js`

**Interfaces:**
- Produces normalized point fields `saveHistory` and `historyMode`.
- Produces scheduler option `onPointOutcomes(outcomeBatch)`.
- `outcomeBatch` shape is `{ endpointId, sessionId, requestGroupId, requestId, createdAt, points }`, where each point contains immutable point config plus `{ raw, value, display, quality, reason }`.

- [x] **Step 1: Write failing policy and scheduler tests**

```js
assert.equal(normalizePoint({ saveHistory: true }).historyMode, 'on-change');
assert.equal(normalizePoint({ saveHistory: false, historyMode: 'every-poll' }).saveHistory, false);
```

Scheduler tests must prove one callback after final success, one after retries are exhausted, none for intermediate retry failures, none for disabled points, and immutable callback snapshots.

- [x] **Step 2: Verify scheduler RED**

```bash
node --test packages/workbench/tests/modbusMasterConfig.test.js \
  packages/workbench/tests/modbusMasterScheduler.test.js
```

- [x] **Step 3: Implement policy normalization and callback isolation**

Call `onPointOutcomes` only after request state has its final decoded readings. Wrap the callback so synchronous throws and rejected promises cannot stop scheduling:

```js
try {
  Promise.resolve(onPointOutcomes(structuredClone(batch))).catch(() => {});
} catch {
  // History observers do not own scheduler progress.
}
```

- [x] **Step 4: Verify and commit scheduler hook**

```bash
node --test packages/workbench/tests/modbusMasterConfig.test.js \
  packages/workbench/tests/modbusMasterScheduler.test.js
git add packages/workbench/src/model/modbusMasterConfig.js \
  packages/workbench/src/model/modbusMasterScheduler.js \
  packages/workbench/tests/modbusMasterConfig.test.js \
  packages/workbench/tests/modbusMasterScheduler.test.js
git commit -m "feat(workbench): publish final modbus point outcomes"
```

### Task 6: Bounded Modbus point history collector

**Files:**
- Create: `packages/workbench/src/model/modbusPointHistoryCollector.js`
- Create: `packages/workbench/tests/modbusPointHistoryCollector.test.js`

**Interfaces:**
- Consumes `recordBatch(rows)` and Task 5 `outcomeBatch`.
- Produces `createModbusPointHistoryCollector({ recordBatch, clock, timers, batchSize, flushDelayMs, maxPendingRows })`.
- Public methods: `capture(batch)`, `flush()`, `reset(endpointId?)`, `getStatus()`, `subscribe(listener)`, and `dispose()`.

- [x] **Step 1: Write failing collector tests**

Cover first observation, identical-value suppression, value/quality/reason changes, every-poll mode, session/config reset, 200-row immediate flush, one-second deadline, 2,000-row drop-oldest behavior, immutable snapshots, finite retry, explicit flush, and dispose.

```js
collector.capture(pointBatch({ value: 42, quality: 'good' }));
collector.capture(pointBatch({ value: 42, quality: 'good' }));
await collector.flush();
assert.equal(savedRows.length, 1);
```

- [x] **Step 2: Verify collector RED**

```bash
node --test packages/workbench/tests/modbusPointHistoryCollector.test.js
```

- [x] **Step 3: Implement one-owner queue and change signatures**

Use a serialized promise tail for native writes. Scope signatures by endpoint, request group, request, and point; build the change signature from canonical JSON value, quality, and reason. Update the signature when a row is accepted into the queue, not after persistence, so slow writes do not duplicate samples.

- [x] **Step 4: Implement bounded retry and observable status**

Retry a failed batch twice with delays of 100 ms and 500 ms, then count the failed batch and drop it. `flush()` waits for timers, queued rows, active retry, and promise tail. Status snapshots expose `pendingCount`, `droppedCount`, `failedBatchCount`, `lastFlushedAt`, and normalized `lastError`.

- [x] **Step 5: Verify and commit collector**

```bash
node --test packages/workbench/tests/modbusPointHistoryCollector.test.js
git add packages/workbench/src/model/modbusPointHistoryCollector.js \
  packages/workbench/tests/modbusPointHistoryCollector.test.js
git commit -m "feat(workbench): collect modbus point history"
```

### Task 7: Workbench lifecycle, flush barriers, and retention controller

**Files:**
- Modify: `packages/workbench/src/model/createWorkbenchModel.js`
- Modify: `packages/workbench/src/App.vue`
- Modify: `packages/workbench/tests/workbenchModel.test.js`
- Modify: `packages/workbench/tests/components/AppObserver.test.js`

**Interfaces:**
- Consumes Tasks 4-6.
- Produces `model.modbusPointHistoryCollector`, `model.modbusPointHistoryStatus`, and command `cleanupModbusPointHistory()`.

- [x] **Step 1: Write failing model integration tests**

Test real scheduler success -> collector -> `runtime.modbusHistory.recordBatch`, polling independence while `recordBatch` is pending, session-change signature reset, reset/import/dispose cleanup, and workspace-import flush ordering:

```js
assert.deepEqual(trace, [
  'collector.flush', 'history.flush', 'workspace.import',
]);
```

Also test cleanup once after settings load, every 24 hours, immediately after retention-setting change, and `forever` no-op behavior. Component tests must emit a native before-shutdown request, assert `collector.flush()` then `runtime.modbusHistory.flush()` then `readyForShutdown(requestId)`, and prove a failed flush still acknowledges so native timeout is not the normal path.

- [x] **Step 2: Verify model integration RED**

```bash
node --test packages/workbench/tests/workbenchModel.test.js
```

- [x] **Step 3: Wire collector and lifecycle barriers**

Create the collector before the Master scheduler, pass `onPointOutcomes: collector.capture`, reset endpoint signatures when operation identity changes, and await `collector.flush()` before workspace import and explicit point-history clear. Expose `flushModbusPointHistory()` which awaits collector flush followed by native history flush. `App.vue` subscribes once to `lifecycle.onBeforeShutdown`, calls this method, and acknowledges the request ID in `finally`; unmount only unsubscribes and disposes synchronously.

- [x] **Step 4: Implement retention scheduling**

Map setting values to native cleanup calls, store the returned completion time in model state, and schedule the next check exactly 24 hours after completion. Cancel the timer on reset/dispose and isolate cleanup failures from polling.

- [x] **Step 5: Verify and commit integration**

```bash
node --test packages/workbench/tests/workbenchModel.test.js \
  packages/workbench/tests/modbusPointHistoryCollector.test.js
git add packages/workbench/src/model/createWorkbenchModel.js \
  packages/workbench/src/App.vue packages/workbench/tests/workbenchModel.test.js \
  packages/workbench/tests/components/AppObserver.test.js
git commit -m "feat(workbench): wire modbus history lifecycle"
```

### Task 8: Point controls, retention settings, and storage status UI

**Files:**
- Modify: `packages/workbench/src/components/ModbusRequestDialog.vue`
- Modify: `packages/workbench/src/components/SettingsPanel.vue`
- Modify: `packages/workbench/src/components/StoragePanel.vue`
- Modify: `packages/workbench/src/model/secondaryViews.js`
- Modify: `packages/workbench/src/styles/workbench.css`
- Modify: `packages/workbench/tests/components/ModbusRequestDialog.test.js`
- Modify: `packages/workbench/tests/components/SecondaryViews.test.js`
- Modify: `packages/workbench/tests/secondaryViews.test.js`
- Modify: `packages/workbench/tests/uiPreferences.test.js`

**Interfaces:**
- Consumes normalized policy, setting, and storage stats.
- Produces user controls for capture mode, retention, status warning, and scoped clear.

- [x] **Step 1: Write failing component and settings tests**

Assert history is off for new points, enabling it reveals a segmented `on-change/every-poll` control, edit round-trips both fields, settings offer exactly four retention options, and storage displays row count, estimated bytes, cleanup time, pending/dropped/failure status.

- [x] **Step 2: Verify UI RED**

```bash
npm test -w @ineed-dev-tool/workbench -- \
  tests/components/ModbusRequestDialog.test.js \
  tests/components/SecondaryViews.test.js \
  tests/secondaryViews.test.js tests/uiPreferences.test.js
```

- [x] **Step 3: Implement compact controls and status presentation**

Use a checkbox for `saveHistory`, a two-option segmented control for `historyMode`, a select menu for retention, and a warning row only when dropped/failed counts are nonzero. Keep the existing detail-form layout and do not add nested cards.

- [x] **Step 4: Implement exact scoped-clear confirmation copy**

The confirmation states endpoint name, selected point count, time range, and that Master configuration is retained. Disable clear while a collector flush or clear is active.

- [ ] **Step 5: Verify and commit UI controls**

```bash
npm test -w @ineed-dev-tool/workbench -- \
  tests/components/ModbusRequestDialog.test.js tests/components/SecondaryViews.test.js \
  tests/secondaryViews.test.js tests/uiPreferences.test.js
git add packages/workbench/src/components/ModbusRequestDialog.vue \
  packages/workbench/src/components/SettingsPanel.vue \
  packages/workbench/src/components/StoragePanel.vue \
  packages/workbench/src/model/secondaryViews.js packages/workbench/src/styles/workbench.css \
  packages/workbench/tests/components/ModbusRequestDialog.test.js \
  packages/workbench/tests/components/SecondaryViews.test.js \
  packages/workbench/tests/secondaryViews.test.js packages/workbench/tests/uiPreferences.test.js
git commit -m "feat(ui): configure modbus point history"
```

### Task 9: Trend query controller and cross-point ECharts view

**Files:**
- Create: `packages/workbench/src/model/modbusPointTrends.js`
- Create: `packages/workbench/src/components/ModbusPointTrends.vue`
- Create: `packages/workbench/tests/modbusPointTrends.test.js`
- Create: `packages/workbench/tests/components/ModbusPointTrends.test.js`
- Modify: `packages/workbench/src/components/ModbusMasterPanel.vue`
- Modify: `packages/workbench/tests/components/ModbusMasterPanel.test.js`
- Modify: `packages/workbench/src/styles/workbench.css`
- Modify: `packages/workbench/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes `runtime.modbusHistory.querySeries/queryRows/exportCsv/clear` and Master config.
- Produces `createModbusPointTrendsController(runtime, endpoint, config)` and the “Data trends” Master tab.

- [x] **Step 1: Install ECharts and write failing controller tests**

```bash
npm install echarts -w @ineed-dev-tool/workbench
```

Test six-point selection limit, grouping by exact unit, preset/custom ranges, stale-query generation protection, paging, export/clear forwarding, and preservation of selection after query errors.

- [x] **Step 2: Write failing component tests**

Mount with a fake controller and assert tree grouping, numeric line series, Boolean step series, String event list, shared range controls, summary fields, quality tooltips, empty/loading/error states, retry, CSV export, and clear confirmation.

- [x] **Step 3: Verify trend RED**

```bash
npm test -w @ineed-dev-tool/workbench -- \
  tests/modbusPointTrends.test.js tests/components/ModbusPointTrends.test.js \
  tests/components/ModbusMasterPanel.test.js
```

- [x] **Step 4: Implement controller with bounded requests**

Derive `bucketCount` from measured chart width, clamped to `50..2000`. Debounce resize/range/selection changes, abort stale application through a generation counter, and keep detail paging independent from series loading.

- [x] **Step 5: Implement approved B layout**

Create a left request-group/request/point selector and an unframed main analysis area. Build one synchronized ECharts grid per unit, cap selection at six, use `step: 'end'` for Boolean data, and render String values as a compact event timeline below numeric charts. Dispose charts and observers on unmount.

- [x] **Step 6: Verify responsive visual behavior and commit**

Run component tests, then use Playwright screenshots at 1440x900 and 390x844. Assert the canvas has non-background pixels, controls do not overlap, and no horizontal scrollbar appears.

```bash
npm test -w @ineed-dev-tool/workbench -- \
  tests/modbusPointTrends.test.js tests/components/ModbusPointTrends.test.js \
  tests/components/ModbusMasterPanel.test.js
git add packages/workbench/src/model/modbusPointTrends.js \
  packages/workbench/src/components/ModbusPointTrends.vue \
  packages/workbench/src/components/ModbusMasterPanel.vue \
  packages/workbench/src/styles/workbench.css packages/workbench/package.json package-lock.json \
  packages/workbench/tests/modbusPointTrends.test.js \
  packages/workbench/tests/components/ModbusPointTrends.test.js \
  packages/workbench/tests/components/ModbusMasterPanel.test.js
git commit -m "feat(ui): add modbus point trend analysis"
```

### Task 10: Cross-runtime acceptance, compatibility, and release verification

**Files:**
- Create: `packages/test-contracts/fixtures/modbusPointHistoryCases.json`
- Modify: `packages/test-contracts/tests/serialRuntimeContract.test.js`
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`
- Modify: `packages/workbench/e2e/workbench.spec.js`
- Modify: `apps/electron/tests/managementDatabase.test.js`
- Modify: `apps/tauri/src-tauri/src/database.rs`

**Interfaces:**
- Consumes every preceding task.
- Produces evidence that both runtimes and the complete UI workflow satisfy the spec.

- [x] **Step 1: Add shared contract fixtures**

Fixtures cover valid rows, rejected rows, page ordering, numeric extrema, Boolean transitions, String changes, abnormal markers, each retention enum, CSV escaping, and legacy database upgrade. Electron and Rust tests must consume the same JSON cases.

- [x] **Step 2: Add end-to-end workflow**

The preview bridge records point history in memory. The browser test creates/edits a Master point, enables on-change history, opens the endpoint, observes two value changes plus one communication-quality change, opens Data trends, selects two points, changes range, inspects detail, and exports the active query.

- [x] **Step 3: Run focused cross-runtime verification**

```bash
node --test packages/test-contracts/tests/serialRuntimeContract.test.js \
  apps/electron/tests/managementDatabase.test.js apps/tauri/tests/tauriBoundary.test.js
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml modbus_point_history -- --nocapture
npm run test:e2e -w @ineed-dev-tool/workbench -- --grep "Modbus point history"
```

- [x] **Step 4: Run complete verification**

```bash
npm test
npm run lint
npm run build
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml -- --test-threads=1
git diff --check
```

Expected: zero failures and zero lint errors. Existing lint warnings may remain only when unchanged by this plan. External PTY/hardware tests may be ignored only under their existing explicit environment gates.

- [x] **Step 5: Request independent review and commit acceptance coverage**

Review migration safety, batch ownership, shutdown/import barriers, query bounds, CSV file safety, Electron/Tauri parity, chart disposal, and old-config preservation. Resolve every Critical or Important finding, rerun the complete verification, then commit:

Verified on 2026-09-14 with no remaining Critical or Important findings. Acceptance
hunks in the already-dirty runtime, database, model, and E2E files remain deferred to
the later user-approved integration commit required by the global staging constraint.

```bash
git add packages/test-contracts/fixtures/modbusPointHistoryCases.json \
  packages/test-contracts/tests/serialRuntimeContract.test.js \
  packages/workbench/e2e/fixtures/previewBridge.js packages/workbench/e2e/workbench.spec.js \
  apps/electron/tests/managementDatabase.test.js apps/tauri/src-tauri/src/database.rs
git commit -m "test(history): verify modbus point history end to end"
```
