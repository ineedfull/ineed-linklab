# Modbus Master Request Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backward-compatible multi-request Modbus master polling with decoded business points, diagnostics, and management UI.

**Architecture:** Preserve native one-request/one-response services and add pure shared configuration/codec modules plus a shared serialized scheduler owned by the Workbench model. Persist configuration only in the existing endpoint JSON; keep current values and statistics in memory.

**Tech Stack:** Vue 3, JavaScript ESM, Node test runner, Vitest, Playwright, Electron, Rust/Tauri, tokio-modbus, SQLite.

**Spec:** `docs/superpowers/specs/2026-09-12-modbus-master-request-groups-design.md`

## Global Constraints

- Preserve all existing endpoint, frame, log, template, and send-history data.
- Do not add an SQLite migration in phase one.
- Legacy masters normalize to an empty, stopped schedule.
- Support both Modbus TCP and RTU with identical shared behavior.
- Keep `modbus.execute` backward compatible.
- Serialize all scheduled requests per master connection.
- Do not persist point history or implement alarms in phase one.

---

### Task 1: Master configuration and data-point codec

**Files:**
- Create: `packages/workbench/src/model/modbusMasterConfig.js`
- Create: `packages/workbench/src/model/modbusMasterDataPoints.js`
- Create: `packages/workbench/tests/modbusMasterConfig.test.js`
- Create: `packages/workbench/tests/modbusMasterDataPoints.test.js`
- Modify: `packages/workbench/src/model/endpointDraft.js`

**Interfaces:**
- Produces `normalizeModbusMasterConfig(config)`, `validateModbusRequestGroups(groups, master)`, `cloneModbusRequestGroup(group, ids)`.
- Produces `decodeModbusMasterPoint(point, values, functionCode)` returning `{ value, display, raw, quality, reason }`.

- [x] Write failing literal-fixture tests for legacy defaults, limits, point ranges, bit overlaps, ID uniqueness, byte/word order, scale/offset, bounds, and 64-bit display.
- [x] Run `node --test packages/workbench/tests/modbusMasterConfig.test.js packages/workbench/tests/modbusMasterDataPoints.test.js` and confirm missing-module failures.
- [x] Implement normalization, validation, cloning, and decoding without changing native services.
- [x] Run the focused tests and existing `modbusDataPoints.test.js`; confirm all pass.

### Task 2: Serialized scheduler

**Files:**
- Create: `packages/workbench/src/model/modbusMasterScheduler.js`
- Create: `packages/workbench/tests/modbusMasterScheduler.test.js`

**Interfaces:**
- Produces `createModbusMasterScheduler({ execute, clock, timers, recordLimit })`.
- Public methods: `start`, `stop`, `runGroup`, `executeImmediate`, `getStatus`, `subscribe`, `reconcile`, `dispose`.

- [x] Write fake-clock failing tests proving due-time/order selection, one in-flight request, minimum gaps, inherited overrides, retry exhaustion, disabled groups, stop, and decoded status updates.
- [x] Run `node --test packages/workbench/tests/modbusMasterScheduler.test.js` and confirm the module is missing.
- [x] Implement one-timer scheduling with completion-based next due times and bounded records.
- [x] Run scheduler tests and refactor only while green.

### Task 3: Workbench lifecycle integration and reconnect eligibility

**Files:**
- Modify: `packages/workbench/src/model/createWorkbenchModel.js`
- Modify: `packages/workbench/src/model/tcpReconnectController.js`
- Modify: `packages/workbench/tests/workbenchModel.test.js`
- Modify: `packages/workbench/tests/tcpReconnectController.test.js`

**Interfaces:**
- Exposes `model.modbusMasterScheduler`.
- Reconciles scheduler with endpoint collection, operation sessions, terminal statuses, reset, and disposal.
- Makes `modbus-tcp-master` eligible for existing `autoReconnect` behavior.

- [x] Add failing lifecycle tests for auto-start after open, stop after close/save/delete/import, and Modbus TCP reconnect eligibility.
- [x] Run focused model/controller tests and verify behavioral failures.
- [x] Wire the scheduler beside `scheduledSender` and generalize reconnect eligibility without changing TCP-client behavior.
- [x] Run focused tests until green.

### Task 4: Per-request timeout and group correlation boundary

**Files:**
- Modify: `apps/electron/electron/modbusService.cjs`
- Modify: `apps/electron/tests/modbusService.test.js`
- Modify: `apps/tauri/src-tauri/src/modbus.rs`
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`

**Interfaces:**
- `modbus.execute` accepts optional `timeoutMs` and `requestGroupId`.
- `ModbusTransaction` emits nullable `requestGroupId` while retaining all current fields.

- [x] Add failing Electron and Rust tests for override validation, timeout restoration, and correlation on success/failure.
- [x] Run the focused Node and Cargo tests and confirm missing-field/behavior failures.
- [x] Implement the optional fields in both runtimes and preview bridge.
- [x] Re-run focused tests and the ignored TCP/RTU cross-runtime test.

### Task 5: Request-group editor

**Files:**
- Create: `packages/workbench/src/components/ModbusRequestGroupDialog.vue`
- Create: `packages/workbench/tests/components/ModbusRequestGroupDialog.test.js`
- Modify: `packages/workbench/src/styles/workbench.css`

**Interfaces:**
- Props: `open`, `group`, `masterConfig`, `existingGroups`.
- Emits: `save(normalizedGroup)`, `cancel`.

- [x] Write failing component tests for add/edit/remove/reorder/enable points and visible range/overlap errors.
- [x] Run the component test and confirm the component is missing.
- [x] Implement compact request settings and tabular point controls with accessible labels.
- [x] Run the focused component test and lint.

### Task 6: Master workbench tabs and request CRUD

**Files:**
- Create: `packages/workbench/src/components/ModbusMasterPanel.vue`
- Create: `packages/workbench/tests/components/ModbusMasterPanel.test.js`
- Modify: `packages/workbench/src/components/ModbusPanel.vue`
- Modify: `packages/workbench/src/layouts/DevToolShell.vue`
- Modify: `packages/workbench/src/styles/workbench.css`

**Interfaces:**
- Master panel consumes endpoint, runtime, running, scheduler, and `saveCommand`.
- It persists group configuration by saving a complete endpoint snapshot.

- [x] Write failing component tests for the five tabs, group add/edit/copy/order/toggle/delete/run, live quality, statistics, and write confirmation.
- [x] Run focused component tests and verify missing UI behavior.
- [x] Implement the master panel, retain the existing slave panel, and remove component-local master polling.
- [x] Run focused component tests, accessibility selectors, and lint.

### Task 7: Endpoint configuration and list summaries

**Files:**
- Modify: `packages/workbench/src/components/EndpointDialog.vue`
- Modify: `packages/workbench/src/components/EndpointRow.vue`
- Modify: `packages/workbench/tests/components/EndpointDialog.test.js`
- Modify: `packages/workbench/tests/components/EndpointRow.test.js`

**Interfaces:**
- Master endpoint editor saves description, enabled, retry defaults, reconnect, and scheduler defaults while preserving request groups.
- Endpoint rows show enabled/total request-group counts.

- [x] Add failing component tests for legacy values, preservation during base edits, validation, and list counts.
- [x] Run focused tests and confirm failures.
- [x] Implement fields and summaries without embedding the request-group editor in the generic endpoint dialog.
- [x] Run focused tests and lint.

### Task 8: Persistence and workspace compatibility proofs

**Files:**
- Modify: `apps/electron/tests/database.test.js`
- Modify: `apps/tauri/src-tauri/src/database.rs`
- Modify: `packages/workbench/tests/endpointDraft.test.js`

**Interfaces:**
- No production database schema changes.
- Existing workspace version 1 imports and exports nested request groups through endpoint config.

- [x] Add failing-or-characterization tests using legacy endpoint fixtures and populated history tables.
- [x] Prove normalization does not write during load and save/import preserves all unrelated config/history fields.
- [x] Run Electron/Rust persistence tests and inspect table counts before/after.

### Task 9: E2E acceptance and full verification

**Files:**
- Modify: `packages/workbench/e2e/workbench.spec.js`
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`

**Interfaces:**
- Preview bridge produces deterministic multi-group transactions for Electron and Tauri views.

- [x] Add E2E coverage for saving two groups, scheduled reads, decoded values, failed quality, run records, and legacy immediate writes.
- [x] Run targeted desktop/compact/portrait E2E and inspect screenshots for overflow or overlap.
- [x] Run `npm test`, `npm run lint -- --quiet`, `npm run build`, `cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check`, `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml`, `npm run test:e2e`, the ignored cross-runtime Modbus test, and `git diff --check`.
- [x] Start Electron and Tauri development applications for user acceptance.
