# History Entry And Transport Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move history actions into the realtime toolbar, add bilingual structured serial logs, and persist serial frames and logs in Electron and Tauri.

**Architecture:** Serial status events carry an exact nullable structured `log` record. Each desktop runtime forwards events immediately while a native persistence coordinator batches frames and logs into SQLite after one second or 200 rows. Vue remains responsible only for bounded realtime presentation and independent history queries.

**Tech Stack:** Vue 3, Vitest, Node.js/Electron, `node:sqlite`, Rust, Tauri 2, `rusqlite`, serialport, Playwright, socat PTYs.

---

## File Structure

- Create `packages/workbench/src/model/logLevels.js` for canonical bilingual level labels.
- Extend `packages/runtime-contract` and `packages/test-contracts` with exact structured status logs.
- Move the generic JavaScript batch queue into `packages/persistence-contract`.
- Create `apps/electron/electron/transportPersistence.cjs` for Electron history batching.
- Create `apps/tauri/src-tauri/src/persistence.rs` for the equivalent Rust worker.
- Extend both database repositories with transactional frame/log batch inserts.
- Update the shared Vue toolbar, log list, history window, and Settings panel.

### Task 1: Shared Structured Log Contract

**Files:**
- Modify: `packages/test-contracts/fixtures/serialRuntimeCases.json`
- Modify: `packages/test-contracts/fixtures/serialRuntimeContract.js`
- Modify: `packages/runtime-contract/src/serialWireNormalizer.js`
- Modify: `packages/workbench/src/model/createWorkbenchModel.js`
- Test: `packages/test-contracts/tests/serialRuntimeContract.test.js`
- Test: `packages/workbench/tests/workbenchModel.test.js`
- Test: `apps/electron/tests/serialService.test.js`
- Test: `apps/tauri/tests/serialServiceContract.test.js`

- [ ] **Step 1: Add failing valid and invalid log fixtures**

Add `log` to every status fixture. A valid log uses exact fields:

```json
{
  "level": "info",
  "source": "serial",
  "code": null,
  "message": "串口已打开: /dev/ttyUSB0",
  "details": { "path": "/dev/ttyUSB0" },
  "createdAt": 2
}
```

Add invalid cases for unknown level, blank source/message, unsafe timestamp, accessor/extra fields, non-plain details, and non-string code.

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```bash
node --test packages/test-contracts/tests/serialRuntimeContract.test.js apps/electron/tests/serialService.test.js apps/tauri/tests/serialServiceContract.test.js
```

Expected: FAIL because status events reject `log` and renderer normalization replaces it with `null`.

- [ ] **Step 3: Implement exact log normalization**

Use this shape in the contract normalizers and snapshot the same fields in the workbench model:

```js
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function normalizeStatusLog(value) {
  if (value === null) return null;
  requireExactRecord(value, ['level', 'source', 'code', 'message', 'details', 'createdAt'], 'status log');
  if (!LOG_LEVELS.has(value.level)) throw new TypeError('status log.level is invalid');
  requireId(value.source, 'status log.source');
  if (value.code !== null) requireId(value.code, 'status log.code');
  requireId(value.message, 'status log.message');
  requireTimestamp(value.createdAt, 'status log.createdAt');
  return { ...value, details: normalizePlainJson(value.details, 'status log.details') };
}
```

`normalizePlainJson` accepts `null` or cloned JSON-compatible plain records/arrays and rejects proxies, accessors, symbols, cycles, and unsafe numbers. Return the normalized log instead of `log: null`.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/test-contracts packages/runtime-contract packages/workbench/src/model/createWorkbenchModel.js packages/workbench/tests/workbenchModel.test.js apps/electron/tests/serialService.test.js apps/tauri/tests/serialServiceContract.test.js
git commit -m "feat: define structured transport logs"
```

### Task 2: History Toolbar And Bilingual Level Presentation

**Files:**
- Create: `packages/workbench/src/model/logLevels.js`
- Modify: `packages/workbench/src/components/FrameToolbar.vue`
- Modify: `packages/workbench/src/layouts/DevToolShell.vue`
- Modify: `packages/workbench/src/components/LogList.vue`
- Modify: `packages/workbench/src/layouts/HistoryWindow.vue`
- Modify: `packages/workbench/src/components/SettingsPanel.vue`
- Test: `packages/workbench/tests/components/EndpointDialog.test.js`
- Test: `packages/workbench/tests/components/SecondaryViews.test.js`
- Test: `packages/workbench/tests/uiContract.test.js`

- [ ] **Step 1: Write failing toolbar and label tests**

Assert the footer no longer contains history actions, the toolbar emits `frames` or `logs`, and history is immediately before clear:

```js
expect(shell.find('[aria-label="打开消息历史"]').exists()).toBe(false);
await toolbar.get('[aria-label="打开消息历史"]').trigger('click');
expect(toolbar.emitted('history')).toEqual([['frames']]);
await toolbar.setProps({ activeView: 'logs' });
expect(toolbar.get('[aria-label="打开日志历史"]').element.nextElementSibling)
  .toBe(toolbar.get('[aria-label="清空实时视图"]').element);
```

Mount realtime logs, history logs, and Settings and assert all four bilingual labels.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -w @ineed-dev-tool/workbench -- tests/components/EndpointDialog.test.js tests/components/SecondaryViews.test.js tests/uiContract.test.js
```

Expected: FAIL because history buttons remain in the footer and labels remain Chinese-only.

- [ ] **Step 3: Add the shared level helper**

```js
export const LOG_LEVEL_OPTIONS = Object.freeze(['debug', 'info', 'warn', 'error']);
const LABELS = Object.freeze({
  debug: 'DEBUG 调试', info: 'INFO 信息', warn: 'WARN 警告',
  warning: 'WARN 警告', error: 'ERROR 错误',
});
export function formatLogLevel(level) { return LABELS[level] ?? String(level); }
```

Use it in `LogList`, `HistoryWindow`, and `SettingsPanel`.

- [ ] **Step 4: Move history into `FrameToolbar`**

Import `FileClock` and `ScrollText`, add `history` to emits, and insert before clear:

```vue
<button
  type="button"
  class="icon-button"
  :aria-label="activeView === 'messages' ? '打开消息历史' : '打开日志历史'"
  :title="activeView === 'messages' ? '消息历史' : '日志历史'"
  @click="emit('history', activeView === 'messages' ? 'frames' : 'logs')"
>
  <FileClock v-if="activeView === 'messages'" :size="15" />
  <ScrollText v-else :size="15" />
</button>
```

In `DevToolShell`, remove both footer buttons/imports and bind `@history="openHistory"` on `FrameToolbar`. Retain Settings, About, and runtime label.

- [ ] **Step 5: Verify GREEN and commit**

Run Step 2. Expected: all selected tests pass.

```bash
git add packages/workbench/src packages/workbench/tests
git commit -m "feat: move history actions into realtime toolbar"
```

### Task 3: Shared JavaScript Queue And Electron Database Writes

**Files:**
- Create: `packages/persistence-contract/src/batchedPersistence.js`
- Modify: `packages/persistence-contract/package.json`
- Delete: `packages/workbench/src/lib/batchedPersistence.js`
- Move: `packages/workbench/tests/batchedPersistence.test.js` to `packages/persistence-contract/tests/batchedPersistence.test.js`
- Modify: `apps/electron/electron/database.cjs`
- Test: `apps/electron/tests/managementDatabase.test.js`

- [ ] **Step 1: Move the queue test first and verify RED**

Change its import to:

```js
import { createBatchedPersistence } from '../src/batchedPersistence.js';
```

Export `./batchedPersistence.js` from the persistence package and run:

```bash
node --test packages/persistence-contract/tests/batchedPersistence.test.js
```

Expected: FAIL until the implementation is moved. Preserve defaults: 1000 ms, 200 rows, bounded FIFO, serialized writes, finite retries, `flush()`, and `dispose()`.

- [ ] **Step 2: Move the implementation and verify GREEN**

Run Step 1 again. Expected: all queue tests pass.

- [ ] **Step 3: Add failing transactional insert tests**

Exercise these methods:

```js
database.insertFrameBatch([{
  endpointId: endpoint.id, sessionId: 's1', peerId: null, direction: 'in',
  format: 'hex', framing: 'delimiter', payload: Uint8Array.of(0, 128, 255),
  byteCount: 3, createdAt: 1_720_000_000_123,
}]);
database.insertLogBatch([{
  endpointId: endpoint.id, sessionId: 's1', peerId: null, level: 'info',
  source: 'serial', code: null, message: '串口已打开',
  details: { path: '/dev/ttyUSB0' }, createdAt: 1_720_000_000_124,
}]);
```

Assert exact BLOB bytes, milliseconds, JSON details, rollback on an invalid row, and input snapshot isolation.

- [ ] **Step 4: Run database tests and verify RED**

```bash
node --test apps/electron/tests/managementDatabase.test.js
```

Expected: FAIL because batch insert methods do not exist.

- [ ] **Step 5: Implement strict transactional inserts**

Prepare `insertFrame`/`insertLog` statements. Validate all rows before `BEGIN IMMEDIATE`, insert each batch, commit once, and roll back on failure. Copy payload with `Buffer.from(row.payload)` and serialize non-null details.

- [ ] **Step 6: Verify and commit**

Run Steps 1 and 4. Expected: both pass.

```bash
git add packages/persistence-contract packages/workbench/src/lib/batchedPersistence.js packages/workbench/tests/batchedPersistence.test.js apps/electron/electron/database.cjs apps/electron/tests/managementDatabase.test.js
git commit -m "feat: add batched history persistence primitives"
```

### Task 4: Electron Lifecycle Logs And Persistence Coordinator

**Files:**
- Create: `apps/electron/electron/transportPersistence.cjs`
- Create: `apps/electron/tests/transportPersistence.test.js`
- Modify: `apps/electron/package.json`
- Modify: `apps/electron/electron/serialService.cjs`
- Modify: `apps/electron/electron/transportCoordinator.cjs`
- Modify: `apps/electron/electron/main.cjs`
- Test: `apps/electron/tests/serialService.test.js`
- Test: `apps/electron/tests/electronBoundary.test.js`

- [ ] **Step 1: Write failing lifecycle log tests**

Assert opening DEBUG, open INFO, closing DEBUG, normal closed INFO, `DEVICE_REMOVED` WARN, other failures ERROR, and no normal-close INFO after failure. Each log uses `source: 'serial'`, one shared timestamp, stable error code, and `{ path }` details.

- [ ] **Step 2: Run serial tests and verify RED**

```bash
node --test apps/electron/tests/serialService.test.js
```

Expected: FAIL because status payloads have no `log`.

- [ ] **Step 3: Emit logs at the source**

```js
const createdAt = this.clock();
this.#publishEvent('transport:status', {
  endpointId: session.endpointId,
  operationId: session.operationId,
  sessionId,
  status,
  error,
  createdAt,
  log: serialStatusLog(session, status, error, createdAt),
});
```

`serialStatusLog` applies the approved lifecycle table and returns `null` only for a failure-cycle terminal close.

- [ ] **Step 4: Write failing persistence coordinator tests**

Assert renderer forwarding precedes asynchronous persistence, one status log maps to one row, frames use lossless HEX plus endpoint receive mode, 200 rows flush immediately, smaller batches flush after one second, `flush()` drains both queues, and database failures do not throw through event delivery.

- [ ] **Step 5: Implement `transportPersistence.cjs`**

Create two batchers via dynamic import of `@ineed-dev-tool/persistence-contract/batchedPersistence.js`. Snapshot frame rows as:

```js
{
  endpointId: batch.endpointId,
  sessionId: batch.sessionId,
  peerId: null,
  direction: frame.direction,
  format: 'hex',
  framing: endpointReceiveMode(batch.endpointId),
  payload: Uint8Array.from(frame.bytes),
  byteCount: frame.bytes.length,
  createdAt: frame.createdAt,
}
```

Map non-null status logs to `runtime_logs`. Expose `handle(channel, payload)`, `flush()`, and `dispose()`.

- [ ] **Step 6: Integrate ownership and flush boundaries**

Create persistence before `SerialService`. Handle persistence first and forward the event to the renderer immediately without awaiting disk. Give `TransportCoordinator` `flushPersistence()`. Shutdown closes serial sessions before flushing. `storage.clearHistory` and workspace import flush before database mutation.

- [ ] **Step 7: Verify and commit**

```bash
node --test apps/electron/tests/serialService.test.js apps/electron/tests/transportPersistence.test.js apps/electron/tests/electronBoundary.test.js
git add apps/electron packages/persistence-contract
git commit -m "feat: persist Electron serial history"
```

### Task 5: Tauri Lifecycle Logs And Transactional Inserts

**Files:**
- Modify: `apps/tauri/src-tauri/src/serial.rs`
- Modify: `apps/tauri/src-tauri/src/database.rs`
- Test: Rust unit tests in both files
- Test: `apps/tauri/tests/serialServiceContract.test.js`

- [ ] **Step 1: Write failing Rust lifecycle-log tests**

Add the intended serialized structure to tests:

```rust
pub(crate) struct StatusLog {
    level: &'static str,
    source: &'static str,
    code: Option<String>,
    message: String,
    details: Option<Value>,
    created_at: u64,
}
```

Assert the same lifecycle mapping and Chinese messages as Electron, including WARN for `DeviceRemoved`, ERROR for other failures, and no misleading INFO close after failure.

- [ ] **Step 2: Run Rust serial tests and verify RED**

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml serial::tests
```

Expected: FAIL because `StatusEvent` has no log.

- [ ] **Step 3: Implement Rust status logs**

Capture one timestamp in `emit_status`, build `StatusLog` from `SerialStatus`, `SerialErrorCode`, and `session.config.path`, and include `log: Option<StatusLog>` in the event.

- [ ] **Step 4: Write failing database batch tests**

Test `insert_frame_batch` and `insert_log_batch` with the same data as Task 3. Assert BLOB equality, JSON detail round trip, millisecond precision, one transaction per batch, and rollback on an invalid endpoint or row.

- [ ] **Step 5: Implement Rust inserts and verify GREEN**

Add strict `FrameHistoryInsert` and `LogHistoryInsert` structs plus transaction-based methods on `ConfigurationDatabase`. Store `Vec<u8>` directly, encode details with the existing safe JSON encoder, and preserve foreign-key enforcement.

Run:

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml serial::tests database::tests
node --test apps/tauri/tests/serialServiceContract.test.js
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/tauri/src-tauri/src/serial.rs apps/tauri/src-tauri/src/database.rs apps/tauri/tests/serialServiceContract.test.js
git commit -m "feat: add Tauri serial logs and history writes"
```

### Task 6: Tauri Bounded Persistence Worker

**Files:**
- Create: `apps/tauri/src-tauri/src/persistence.rs`
- Modify: `apps/tauri/src-tauri/src/transport.rs`
- Modify: `apps/tauri/src-tauri/src/lib.rs`
- Modify: `apps/tauri/src-tauri/src/database.rs`
- Test: Rust unit tests in `persistence.rs`, `transport.rs`, and `lib.rs`

- [ ] **Step 1: Write failing queue behavior tests**

Using an in-memory database and deterministic clock/flush signal, assert FIFO order, immediate flush at 200 rows, one-second timed flush, bounded queue overflow reporting, serialized writes, explicit flush, shutdown drain, and event forwarding before database acknowledgement.

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml persistence::tests
```

Expected: FAIL because `persistence` does not exist.

- [ ] **Step 3: Implement the bounded worker**

Create `TransportPersistence` around a bounded `sync_channel` and one worker thread:

```rust
enum PersistenceCommand {
    Event(SerialEvent),
    Flush(mpsc::Sender<Result<(), String>>),
    Shutdown(mpsc::Sender<Result<(), String>>),
}
```

The worker snapshots events, accumulates frame/log rows, flushes at 200 rows or one second, and reports failed writes to stderr without recursively creating a runtime log. Its row buffers drop their oldest rows at the configured bound. `handle(event)` uses non-blocking `try_send`; if the command channel itself is full, it reports and skips only that event's persistence copy, then still forwards the event through `TauriSerialEventSink` immediately.

- [ ] **Step 4: Integrate Tauri ownership**

Create one persistence coordinator during `setup`, pass it as the serial event sink, and store it in `AppState`. Flush before history clear and workspace import. During shutdown, close serial sessions, drain persistence, disconnect the event sink, and exit.

- [ ] **Step 5: Verify and commit**

```bash
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
node --test apps/tauri/tests/*.test.js
git add apps/tauri
git commit -m "feat: persist Tauri serial history in batches"
```

### Task 7: Lossless HEX History Rendering

**Files:**
- Modify: `packages/workbench/src/layouts/HistoryWindow.vue`
- Modify: `packages/workbench/src/model/secondaryViews.js`
- Test: `packages/workbench/tests/components/SecondaryViews.test.js`
- Test: `packages/workbench/tests/secondaryViews.test.js`

- [ ] **Step 1: Write a failing HEX history rendering test**

Return `format: 'hex'` with Base64 bytes `[0x00, 0x80, 0xff]`. Assert table preview and detail display `00 80 FF`, not replacement UTF-8 characters. Assert framing labels for `raw`, `delimiter`, `fixed`, and `idle`.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -w @ineed-dev-tool/workbench -- tests/components/SecondaryViews.test.js tests/secondaryViews.test.js
```

Expected: FAIL because history payloads always decode as UTF-8.

- [ ] **Step 3: Implement byte-aware formatting**

Decode Base64 into `Uint8Array`. For HEX, return uppercase two-digit bytes separated by spaces. For text and JSON, decode UTF-8 and format valid JSON with two-space indentation. Return Base64 only when byte decoding fails.

Use this framing map:

```js
const labels = {
  raw: '原始数据', delimiter: '分隔符', fixed: '固定长度', idle: '空闲超时',
  none: '无', line: '按行', 'length-prefix': '长度前缀',
};
```

- [ ] **Step 4: Verify and commit**

Run Step 2. Expected: all selected tests pass.

```bash
git add packages/workbench/src/layouts/HistoryWindow.vue packages/workbench/src/model/secondaryViews.js packages/workbench/tests/components/SecondaryViews.test.js packages/workbench/tests/secondaryViews.test.js
git commit -m "fix: render binary history without data loss"
```

### Task 8: Cross-Runtime Acceptance And Full Verification

**Files:**
- Modify: `tooling/serial-test/pty-loopback.mjs`
- Modify: `tooling/serial-test/README.md`
- Modify: `packages/workbench/e2e/workbench.spec.js`

- [ ] **Step 1: Extend PTY acceptance with exact history assertions**

For each runtime, use a temporary database and endpoint, send numbered inbound/outbound frames, close, flush, and assert:

```js
assert.equal(history.frames.total, expectedInbound + expectedOutbound);
assert.equal(history.logs.rows.some((row) => row.level === 'info' && row.source === 'serial'), true);
assert.deepEqual(decodedPayloads, expectedPayloads);
```

- [ ] **Step 2: Add E2E toolbar assertions**

Verify the sidebar has no history actions, switch message/log tabs, assert the correct history icon is immediately before clear, and assert the opened history URL uses the matching kind plus active endpoint ID.

- [ ] **Step 3: Run the full verification gate**

```bash
npm test
npm run lint
npm run build
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
npm run test:e2e
cross-env INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs
```

Expected: zero failed tests, both frontend builds succeed, Rust checks pass, Playwright passes, and both PTY runs report exact frame/log history counts. Run `git diff --check` separately and require no output.

- [ ] **Step 4: Perform the live virtual-serial smoke test**

Open `SERIAL_VIRTUAL_TEST`, wait for five heartbeats, send `hello virtual serial`, then verify Open state, RX +6 or more, TX +1, DEBUG/INFO lifecycle logs, matching message/log history rows with milliseconds, and unchanged historical counts after clearing realtime views.

- [ ] **Step 5: Commit acceptance coverage**

```bash
git add tooling/serial-test packages/workbench/e2e/workbench.spec.js
git commit -m "test: verify persisted serial history end to end"
```
