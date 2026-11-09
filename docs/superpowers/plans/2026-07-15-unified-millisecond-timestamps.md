# Unified Millisecond Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every message and log timestamp use `YYYY-MM-DD HH:mm:ss.SSS`, prevent timestamp wrapping, and reject seconds-level values from new Electron and Tauri frame/log history writes.

**Architecture:** The shared workbench owns one local-time formatter and no longer exposes a time-display preference. Native transports capture one epoch-millisecond integer per event; Electron and Tauri persistence validate and store that exact value without conversion or a second clock read. CSS reserves stable timestamp widths while allowing history tables to scroll inside their own region on compact windows.

**Tech Stack:** Vue 3, Node.js test runner, Vitest, Playwright, Electron, `node:sqlite`, Rust, Tauri 2, `rusqlite`, socat PTYs.

---

## File Structure

- Modify `packages/workbench/src/model/secondaryViews.js` as the sole timestamp formatter.
- Remove timestamp-mode props from `FrameList.vue` and `LogList.vue`, and remove their bindings from `DevToolShell.vue`.
- Keep `HistoryWindow.vue` preferences only for payload preview limits; remove its timestamp-mode branch.
- Remove `timeDisplayMode` from `packages/runtime-contract/src/settingsSchema.json` and Settings UI/test fixtures.
- Update `packages/workbench/src/styles/workbench.css` with stable no-wrap timestamp tracks.
- Add runtime-history-only millisecond validation in both native database repositories.
- Extend existing unit, component, E2E, database, and PTY tests; do not create a second timestamp utility.

### Task 1: One Shared Timestamp Formatter

**Files:**
- Modify: `packages/workbench/src/model/secondaryViews.js:129-137`
- Modify: `packages/workbench/src/components/FrameList.vue:8-29`
- Modify: `packages/workbench/src/components/LogList.vue:7-16`
- Modify: `packages/workbench/src/layouts/HistoryWindow.vue:23-38,176,196`
- Modify: `packages/workbench/src/layouts/DevToolShell.vue:223-236`
- Test: `packages/workbench/tests/secondaryViews.test.js:172-179`
- Test: `packages/workbench/tests/components/FrameList.test.js`
- Test: `packages/workbench/tests/components/SecondaryViews.test.js`

- [ ] **Step 1: Write failing formatter and component tests**

Replace the formatter expectations with a local-time value constructed in the test process timezone:

```js
test('timestamps use one local millisecond format and invalid values are explicit', () => {
  const timestamp = new Date(2024, 6, 3, 17, 46, 40, 123).getTime();
  assert.equal(formatTimestamp(timestamp), '2024-07-03 17:46:40.123');
  assert.equal(formatTimestamp(Number.NaN), '--');
  assert.equal(formatTimestamp('1720000000123'), '--');
});
```

Update component tests so an obsolete `timeDisplayMode: 'iso'` prop cannot produce ISO text:

```js
expect(wrapper.text()).toContain('2024-07-03 17:46:40.123');
expect(wrapper.text()).not.toContain('T17:46:40.123');
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test packages/workbench/tests/secondaryViews.test.js
npm run test:components -w @ineed-dev-tool/workbench -- --run tests/components/FrameList.test.js tests/components/SecondaryViews.test.js
```

Expected: FAIL because `formatTimestamp` still accepts `iso`, returns an empty string for invalid input, and components still pass the mode.

- [ ] **Step 3: Implement the single formatter and remove mode plumbing**

Use this exact formatter:

```js
export function formatTimestamp(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return '--';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '--';
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}`;
}
```

Remove `timeDisplayMode` from `FrameList` and `LogList` props. Their helpers become:

```js
function frameTime(value) { return formatTimestamp(value); }
function logTime(value) { return formatTimestamp(value); }
```

Remove `timeDisplayMode` from `HistoryWindow` and call `formatTimestamp(row.createdAt)` and `formatTimestamp(selected.createdAt)`. Remove both `:time-display-mode` bindings from `DevToolShell`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 commands. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workbench/src/model/secondaryViews.js \
  packages/workbench/src/components/FrameList.vue \
  packages/workbench/src/components/LogList.vue \
  packages/workbench/src/layouts/HistoryWindow.vue \
  packages/workbench/src/layouts/DevToolShell.vue \
  packages/workbench/tests/secondaryViews.test.js \
  packages/workbench/tests/components/FrameList.test.js \
  packages/workbench/tests/components/SecondaryViews.test.js
git commit -m "feat: unify timestamp presentation"
```

### Task 2: Remove The Time Display Setting

**Files:**
- Modify: `packages/runtime-contract/src/settingsSchema.json`
- Modify: `packages/runtime-contract/tests/settingsSchema.test.js`
- Modify: `packages/workbench/src/components/SettingsPanel.vue:157-166`
- Modify: `packages/workbench/tests/secondaryViews.test.js:257-269`
- Modify: `packages/workbench/tests/components/SecondaryViews.test.js`
- Modify: `packages/workbench/tests/components/EndpointDialog.test.js`
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`
- Modify: `packages/test-contracts/tests/configPersistenceContract.test.js`
- Modify: `apps/electron/tests/managementDatabase.test.js`
- Modify: `apps/tauri/src-tauri/src/database.rs`

- [ ] **Step 1: Write failing schema, Settings UI, and legacy-row tests**

Change the exact settings-key expectations to:

```js
[
  'logLevel', 'realtimeFrameLimit', 'realtimeLogLimit', 'previewByteLimit',
  'defaultFraming', 'autoScroll', 'theme', 'largeFont',
]
```

Update the Settings component assertion:

```js
expect(wrapper.find('select[name="time-display-mode"]').exists()).toBe(false);
expect(wrapper.text()).not.toContain('时间显示');
```

In the existing Electron unknown-row recovery test, insert the retired key directly:

```sql
INSERT OR REPLACE INTO settings (key, value, updated_at)
VALUES ('timeDisplayMode', '"iso"', 1720000000123)
```

Assert `database.getSettings()` has no `timeDisplayMode`, then call `saveSettings(validSettings())` and assert the raw row was removed. Add the equivalent assertion to the Rust unknown-setting recovery test.

- [ ] **Step 2: Run settings tests and verify RED**

Run:

```bash
node --test packages/runtime-contract/tests/settingsSchema.test.js \
  packages/workbench/tests/secondaryViews.test.js \
  packages/test-contracts/tests/configPersistenceContract.test.js \
  apps/electron/tests/managementDatabase.test.js
npm run test:components -w @ineed-dev-tool/workbench -- --run tests/components/SecondaryViews.test.js tests/components/EndpointDialog.test.js
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml native_settings_schema_rejects_invalid_values_and_recovers_unknown_rows
```

Expected: FAIL because the key and selector still exist and fixtures still require `local`/`iso`.

- [ ] **Step 3: Remove the schema key, selector, and all owned fixtures**

Delete this JSON member completely:

```json
"timeDisplayMode": {
  "type": "string",
  "enum": ["local", "iso"],
  "default": "local"
}
```

Delete the corresponding `<label>` from `SettingsPanel`. Remove `timeDisplayMode` from JavaScript and Rust valid-settings objects, E2E preview settings, and endpoint-dialog preference fixtures.

In the workspace export/import contract, replace:

```js
first.database.saveSetting('timeDisplayMode', 'iso');
```

with:

```js
first.database.saveSetting('theme', 'dark');
```

and assert the exported settings contain `theme: 'dark'` with no `timeDisplayMode` key.

- [ ] **Step 4: Run settings tests and verify GREEN**

Run the Step 2 commands. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-contract/src/settingsSchema.json \
  packages/runtime-contract/tests/settingsSchema.test.js \
  packages/workbench/src/components/SettingsPanel.vue \
  packages/workbench/tests packages/workbench/e2e/fixtures/previewBridge.js \
  packages/test-contracts/tests/configPersistenceContract.test.js \
  apps/electron/tests/managementDatabase.test.js \
  apps/tauri/src-tauri/src/database.rs
git commit -m "feat: remove timestamp display modes"
```

### Task 3: Stable No-Wrap Timestamp Layout

**Files:**
- Modify: `packages/workbench/src/styles/workbench.css:700-767,1178-1213,1220-1235,1450-1470`
- Modify: `packages/workbench/tests/uiContract.test.js`
- Modify: `packages/workbench/e2e/workbench.spec.js`

- [ ] **Step 1: Add failing CSS contract and browser assertions**

Add source-level assertions for the required fixed tracks and no-wrap rules:

```js
assert.match(css, /\.log-list__row\s*\{[^}]*grid-template-columns:\s*17px 168px 58px minmax\(0, 1fr\)/s);
assert.match(css, /\.log-list__row time[^}]*white-space:\s*nowrap/s);
assert.match(css, /\.history-table th:nth-child\(1\)\s*\{\s*width:\s*180px/s);
assert.match(css, /\.history-table\s*\{[^}]*min-width:\s*760px/s);
assert.match(css, /\.large-font \.log-list__row[^}]*grid-template-columns:\s*19px 204px 68px/s);
```

Extend E2E checks for realtime messages, realtime logs, and history rows:

```js
const timestampLayout = await page.locator('.log-list__row time').first().evaluate((element) => ({
  whiteSpace: getComputedStyle(element).whiteSpace,
  wraps: element.getClientRects().length > 1,
}));
expect(timestampLayout).toEqual({ whiteSpace: 'nowrap', wraps: false });
```

For compact history, assert the page itself does not overflow while `.history-table-wrap` can scroll its own table:

```js
expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
expect(await page.locator('.history-table-wrap').evaluate((el) => el.scrollWidth >= el.clientWidth)).toBe(true);
```

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
node --test packages/workbench/tests/uiContract.test.js
npm run test:e2e -w @ineed-dev-tool/workbench -- --grep "timestamp|history|active protocol workbench"
```

Expected: FAIL because realtime log tracks are 86/102px and the history time column is 155px.

- [ ] **Step 3: Implement stable timestamp dimensions**

Apply these rules without adding page-level overflow:

```css
.log-list__row {
  grid-template-columns: 17px 168px 58px minmax(0, 1fr);
}

.log-list__row time,
.frame-list__item header time,
.history-detail__identity time {
  white-space: nowrap;
}

.history-table {
  min-width: 760px;
}

.history-table th:nth-child(1) {
  width: 180px;
}

.large-font .log-list__row {
  grid-template-columns: 19px 204px 68px minmax(0, 1fr);
}

.large-font .history-table th:nth-child(1) {
  width: 210px;
}
```

Keep `.history-table-wrap { overflow: auto; }`, `table-layout: fixed`, and existing ellipsis behavior for non-time columns.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run the Step 2 commands at desktop, compact, and portrait projects. Expected: all selected tests pass with no timestamp wrap or page overflow.

- [ ] **Step 5: Commit**

```bash
git add packages/workbench/src/styles/workbench.css \
  packages/workbench/tests/uiContract.test.js \
  packages/workbench/e2e/workbench.spec.js
git commit -m "feat: stabilize timestamp columns"
```

### Task 4: Electron Runtime-History Millisecond Validation

**Files:**
- Modify: `apps/electron/electron/database.cjs:648-715,1015-1021`
- Test: `apps/electron/tests/managementDatabase.test.js:57-140`
- Test: `apps/electron/tests/transportPersistence.test.js`
- Test: `apps/electron/tests/serialService.test.js`

- [ ] **Step 1: Add failing seconds-rejection and exact-preservation tests**

Add one prevalidation test for each history type:

```js
assert.throws(
  () => fixture.database.insertFrameBatch([validFrameRow({ createdAt: 1_720_000_000 })]),
  /createdAt.*millisecond/i,
);
assert.throws(
  () => fixture.database.insertLogBatch([validLogRow({ createdAt: 1_720_000_000 })]),
  /createdAt.*millisecond/i,
);
assert.equal(fixture.database.storageStats().totalCount, 0);
```

In transport persistence, emit a status event with `createdAt: 1_720_000_000_124` and an identical `log.createdAt`; flush and assert the queued database row preserves that exact value. In serial service tests, inject a clock returning `1_720_000_000_125` and assert the status event and log share it.

- [ ] **Step 2: Run Electron tests and verify RED**

Run:

```bash
node --test apps/electron/tests/managementDatabase.test.js \
  apps/electron/tests/transportPersistence.test.js \
  apps/electron/tests/serialService.test.js
```

Expected: FAIL because `integerTimestamp` accepts a seconds-level integer.

- [ ] **Step 3: Add a history-only validator**

Keep generic endpoint/template timestamp behavior unchanged. Add:

```js
const MIN_RUNTIME_HISTORY_TIMESTAMP = 1_000_000_000_000;

function runtimeHistoryTimestamp(value, name) {
  const timestamp = integerTimestamp(value, undefined, name);
  if (timestamp < MIN_RUNTIME_HISTORY_TIMESTAMP) {
    throw new TypeError(`${name} must be an epoch-millisecond timestamp`);
  }
  return timestamp;
}
```

Use `runtimeHistoryTimestamp` only in `frameForWrite` and `logForWrite`. Keep `integerTimestamp` for endpoint profiles, templates, workspace documents, and history query filters.

- [ ] **Step 4: Run Electron tests and verify GREEN**

Run the Step 2 command. Expected: all selected tests pass and no partial history rows are written.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/electron/database.cjs \
  apps/electron/tests/managementDatabase.test.js \
  apps/electron/tests/transportPersistence.test.js \
  apps/electron/tests/serialService.test.js
git commit -m "feat: validate Electron history milliseconds"
```

### Task 5: Tauri Runtime-History Millisecond Validation

**Files:**
- Modify: `apps/tauri/src-tauri/src/database.rs:1132-1192,2005-2017`
- Modify: `apps/tauri/src-tauri/src/database.rs` database tests near `history_batch_inserts_round_trip_blob_json_null_and_milliseconds`
- Test: `apps/tauri/src-tauri/src/persistence.rs`
- Test: `apps/tauri/src-tauri/src/serial.rs`

- [ ] **Step 1: Add failing Rust seconds-rejection tests**

Add this database test with a real endpoint and empty-history assertions:

```rust
#[test]
fn runtime_history_rejects_seconds_before_any_batch_row_is_written() {
    let (database, directory) = temporary_database("history-milliseconds");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    let frame_error = database
        .insert_frame_batch(&[frame_insert("one", vec![1], 1_720_000_000)])
        .unwrap_err();
    let log_error = database
        .insert_log_batch(&[log_insert("one", None, 1_720_000_000)])
        .unwrap_err();
    assert!(frame_error.contains("epoch-millisecond"));
    assert!(log_error.contains("epoch-millisecond"));
    assert_eq!(database.storage_stats().unwrap().total_count, 0);
    drop(database);
    std::fs::remove_dir_all(directory).unwrap();
}
```

Update database-history test fixtures that intentionally use `10`, `11`, or `12` to use `1_720_000_000_000 + offset`. Do not change query-bound tests that intentionally exercise zero or small filter values.

- [ ] **Step 2: Run Rust tests and verify RED**

Run:

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml runtime_history_rejects_seconds_before_any_batch_row_is_written
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml persistence::tests serial::tests::lifecycle_status_logs_match_the_electron_contract
```

Expected: the new database test FAILS because `validate_timestamp` accepts seconds.

- [ ] **Step 3: Add the Rust history-only validator**

Add:

```rust
const MIN_RUNTIME_HISTORY_TIMESTAMP: i64 = 1_000_000_000_000;

fn validate_runtime_history_timestamp(value: i64, name: &str) -> DbResult<()> {
    validate_timestamp(value, name)?;
    if value < MIN_RUNTIME_HISTORY_TIMESTAMP {
        return Err(format!("{name} must be an epoch-millisecond timestamp"));
    }
    Ok(())
}
```

Call it from `validate_frame_history_batch` and `validate_log_history_batch`. Leave endpoint/template and query validation on `validate_timestamp`.

- [ ] **Step 4: Verify exact producer/persistence equality**

In the existing serial lifecycle test, assert `status.created_at >= 1_000_000_000_000` and `status.log.as_ref().unwrap().created_at == status.created_at`. In persistence tests, assert `LogHistoryInsert.created_at` and `FrameHistoryInsert.created_at` equal their source wire values after flush.

- [ ] **Step 5: Run Rust tests and verify GREEN**

Run:

```bash
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
```

Expected: all Rust tests pass; the real PTY-only test remains ignored in the ordinary cargo run.

- [ ] **Step 6: Commit**

```bash
git add apps/tauri/src-tauri/src/database.rs \
  apps/tauri/src-tauri/src/persistence.rs \
  apps/tauri/src-tauri/src/serial.rs
git commit -m "feat: validate Tauri history milliseconds"
```

### Task 6: Cross-Runtime Acceptance And Final Verification

**Files:**
- Modify: `tooling/serial-test/pty-loopback.mjs`
- Modify: `docs/verification/phase-03.md`
- Test: `packages/workbench/e2e/workbench.spec.js`

- [ ] **Step 1: Strengthen the PTY timestamp oracle**

For every persisted frame and log in both runtime summaries, assert:

```js
assert.ok(Number.isSafeInteger(row.createdAt));
assert.ok(row.createdAt >= 1_000_000_000_000);
```

For every structured status log, assert its timestamp equals its owning status-event timestamp before comparing SQLite rows. Keep exact frame/log counts and byte-vector comparisons unchanged.

- [ ] **Step 2: Run standalone real PTY acceptance**

Run:

```bash
cross-env INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs --runtime electron
cross-env INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs --runtime tauri
cross-env INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs
```

Expected: all three commands emit `PHASE03_PTY_RESULT`, report four persisted history frames and four logs per runtime, and leave `managedChildren: 0`.

- [ ] **Step 3: Run the complete gate**

Run:

```bash
npm run verify:phase-03
```

Expected:

- Node and component tests have zero failures.
- ESLint passes.
- Electron and Tauri Vite builds pass.
- `cargo fmt --check` and all non-ignored Rust tests pass.
- All 51 Playwright tests pass at desktop, compact, and portrait sizes.
- Electron/Tauri visual parity remains at the configured threshold.
- The final real PTY probe passes for both runtimes.
- `git diff --check` passes.

- [ ] **Step 4: Update verification evidence**

In `docs/verification/phase-03.md`, record:

```markdown
- Timestamp display: `YYYY-MM-DD HH:mm:ss.SSS` across realtime and history views.
- Persistence: Electron and Tauri reject seconds-level frame/log history timestamps.
- Layout: timestamp columns remain single-line in normal and large-font compact viewports.
```

Include the fresh command date and exact test counts from Step 3. Do not copy stale counts from an earlier run.

- [ ] **Step 5: Commit**

```bash
git add tooling/serial-test/pty-loopback.mjs \
  packages/workbench/e2e/workbench.spec.js \
  docs/verification/phase-03.md
git commit -m "test: verify unified millisecond timestamps"
```

- [ ] **Step 6: Confirm final repository state**

Run:

```bash
git status --short
git diff --check
git log -7 --oneline
```

Expected: clean worktree, no whitespace errors, and the six implementation commits above the design and plan commits.
