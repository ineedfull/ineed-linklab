# Modbus Master Saved Write Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multiple reusable Modbus master write commands with individual execution, and make request-group deletion visible and confirmation-protected.

**Architecture:** Store normalized write definitions as an additive `writeCommands` array in the existing version 3 endpoint JSON. Keep native Electron and Rust execution unchanged, run selected commands through the shared serialized immediate-operation queue, and hold latest per-command results only in component memory. Use focused dialogs for editing and destructive confirmation while preserving all legacy configuration and history.

**Tech Stack:** Vue 3, JavaScript ESM, Node test runner, Vitest, Playwright, Electron, Rust/Tauri, SQLite.

**Spec:** `docs/superpowers/specs/2026-09-12-modbus-master-write-commands-design.md`

## Global Constraints

- One saved definition represents exactly one FC05, FC06, FC15, or FC16 request and response.
- Saved writes are manual only; never schedule them periodically.
- Every run requires explicit confirmation before device I/O.
- A disabled command remains persisted but cannot execute.
- FC05/FC06 require exactly one value; FC15 allows 1-1968 coils; FC16 allows 1-123 registers.
- Store Boolean values for FC05/FC15 and unsigned 16-bit integers for FC06/FC16.
- Keep `configVersion: 3`, use the existing endpoint `config_json`, and add no SQLite migration.
- Loading legacy configuration performs no write; explicit saves preserve unrelated endpoint keys and every history row.
- Keep Electron and Tauri behavior and layout equivalent; change no native API unless verification proves it necessary.
- Preserve the shared dirty worktree and do not commit until the user explicitly requests it.

---

### Task 1: Write Command Configuration Model

**Files:**
- Create: `packages/workbench/src/model/modbusWriteCommands.js`
- Create: `packages/workbench/tests/modbusWriteCommands.test.js`
- Modify: `packages/workbench/src/model/modbusMasterConfig.js`
- Modify: `packages/workbench/tests/modbusMasterConfig.test.js`

**Interfaces:**
- Produces: `normalizeModbusWriteCommands(commands)` returning stable, ordered plain command records.
- Produces: `normalizeModbusWriteCommand(command, index = 0)`.
- Produces: `validateModbusWriteCommands(commands)` returning field errors such as `writeCommand-1-values`.
- Produces: `cloneModbusWriteCommand(command, createId)` with a fresh ID and copied value array.
- Consumed by: `normalizeModbusMasterConfig`, the command dialog, and the master panel.

- [x] **Step 1: Add failing normalization, idempotence, and cloning tests**

```js
test('normalizes ordered write commands without aliasing values', () => {
  const source = [{
    id: 'target', name: '设定目标', description: '', enabled: true, order: 2,
    unitId: 7, functionCode: 16, address: 20, values: [100, 200],
  }];
  const normalized = normalizeModbusWriteCommands(source);
  assert.deepEqual(normalized[0], { ...source[0], order: 0 });
  assert.notEqual(normalized[0].values, source[0].values);
  assert.deepEqual(normalizeModbusWriteCommands(normalized), normalized);
});

test('clones a command with fresh identity and isolated values', () => {
  const clone = cloneModbusWriteCommand(command(), () => 'write-copy');
  assert.equal(clone.id, 'write-copy');
  assert.equal(clone.name, '设定目标副本');
  assert.notEqual(clone.values, command().values);
});
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test packages/workbench/tests/modbusWriteCommands.test.js packages/workbench/tests/modbusMasterConfig.test.js`

Expected: FAIL because `modbusWriteCommands.js` and `writeCommands` normalization do not exist.

- [x] **Step 3: Implement normalization and clone behavior**

```js
export function normalizeModbusWriteCommand(source, index = 0) {
  const command = plainRecord(source);
  const functionCode = integer(command.functionCode, 6);
  return {
    id: nonblank(command.id, `write-command-${index + 1}`),
    name: text(command.name),
    description: text(command.description),
    enabled: command.enabled !== false,
    order: integer(command.order, index),
    unitId: integer(command.unitId, 1),
    functionCode,
    address: integer(command.address, 0),
    values: Array.isArray(command.values)
      ? command.values.map((value) => normalizeValue(value, functionCode))
      : [],
  };
}
```

Add `writeCommands: normalizeModbusWriteCommands(source.writeCommands)` to `normalizeModbusMasterConfig`. Preserve all source keys through the existing top-level spread.

- [x] **Step 4: Add failing exact validation tests**

Cover duplicate IDs, blank names, Slave IDs 0/248, unsupported FC03, negative/overflowing addresses, FC05/06 multiple values, FC15 empty/1969 values, FC16 empty/124 values, non-Boolean coils, register values below 0 or above 65535, and `address + values.length > 65536`.

```js
assert.deepEqual(validateModbusWriteCommands([
  { ...command(), functionCode: 16, address: 65535, values: [1, 2] },
]), {
  'writeCommand-0-values': '写入范围不能超过地址 65535。',
});
```

- [x] **Step 5: Implement field-specific validation and integrate master validation**

```js
export function validateModbusWriteCommands(commands) {
  if (commands === undefined) return {};
  if (!Array.isArray(commands)) return { writeCommands: '写入指令配置格式无效。' };
  // Validate exact function limits and return writeCommand-${index}-${field} keys.
}
```

Merge its result from `validateModbusMasterSettings` without weakening existing request-group errors.

- [x] **Step 6: Run model regression tests**

Run: `node --test packages/workbench/tests/modbusWriteCommands.test.js packages/workbench/tests/modbusMasterConfig.test.js packages/workbench/tests/endpointDraft.test.js`

Expected: PASS with old masters receiving `writeCommands: []` only in normalized memory.

---

### Task 2: Focused Write Command Editor

**Files:**
- Create: `packages/workbench/src/components/ModbusWriteCommandDialog.vue`
- Create: `packages/workbench/tests/components/ModbusWriteCommandDialog.test.js`
- Modify: `packages/workbench/src/styles/workbench.css`

**Interfaces:**
- Props: `open`, `command`, `masterConfig`, `existingCommands`.
- Emits: `save(normalizedCommand)` and `cancel`.
- Consumes: `normalizeModbusWriteCommand` and `validateModbusWriteCommands` from Task 1.

- [x] **Step 1: Add failing create/edit dialog tests**

Verify new-command defaults use the master Slave ID, edit uses isolated local state, opening focuses the name, Escape/cancel closes without save, and save emits a plain normalized command.

```js
await setValue('input[name="modbus-write-command-name"]', '启动水泵');
await setValue('select[name="modbus-write-command-function"]', '5');
await setValue('input[name="modbus-write-command-values"]', '1');
await wrapper.get('form').trigger('submit');
expect(wrapper.emitted('save')[0][0]).toMatchObject({
  name: '启动水泵', unitId: 1, functionCode: 5, address: 0, values: [true],
});
```

- [x] **Step 2: Add failing input and limit validation tests**

Cover `1, 0, true, false` for coil functions, decimal and `0x` register values, exact single-value rules, FC15/FC16 limits, address overflow, duplicate command IDs, and visible field messages without emitting save.

- [x] **Step 3: Run the dialog test and verify RED**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusWriteCommandDialog.test.js`

Expected: FAIL because the component does not exist.

- [x] **Step 4: Implement the dialog using existing modal behavior**

Use the same teleport, focus trap, backdrop, Escape, field layout, footer, and saving-safe controls as `ModbusRequestDialog.vue`. Keep values as editor text until submit, parse by selected function family, then validate the full candidate before emitting.

```js
function parseValues(text, functionCode) {
  const coil = functionCode === 5 || functionCode === 15;
  return text.split(',').map((part) => coil
    ? parseCoil(part.trim())
    : parseRegister(part.trim()));
}
```

- [x] **Step 5: Run component tests and targeted lint**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusWriteCommandDialog.test.js tests/components/ModbusRequestDialog.test.js && npx eslint packages/workbench/src/components/ModbusWriteCommandDialog.vue packages/workbench/tests/components/ModbusWriteCommandDialog.test.js`

Expected: PASS with zero lint errors.

---

### Task 3: Write Command Workspace And Confirmed Group Deletion

**Files:**
- Modify: `packages/workbench/src/components/ModbusMasterPanel.vue`
- Modify: `packages/workbench/tests/components/ModbusMasterPanel.test.js`
- Modify: `packages/workbench/src/styles/workbench.css`

**Interfaces:**
- Consumes: Task 1 model helpers and Task 2 dialog.
- Persists: one complete endpoint snapshot retaining request groups, write commands, and unrelated config.
- Executes: `scheduler.executeImmediate({ endpointId, sessionId, config, request })`.

- [x] **Step 1: Add a failing visible request-group deletion test**

Assert the delete action is present before group expansion, opens an `alertdialog` containing the group name plus request/point counts, cancel performs no save, and confirm removes exactly that group.

```js
await wrapper.get('[aria-label="删除请求组 锅炉环境"]').trigger('click');
expect(wrapper.get('[role="alertdialog"]').text()).toContain('2 个请求');
expect(saveCommand).not.toHaveBeenCalled();
await wrapper.get('[aria-label="确认删除请求组 锅炉环境"]').trigger('click');
await flushPromises();
expect(saveCommand.mock.lastCall[0].config.requestGroups).toHaveLength(0);
```

- [x] **Step 2: Add failing write-command CRUD tests**

Cover empty state, add, edit, copy with fresh ID, reorder, enable/disable, delete confirmation, preservation of request groups, and failed-save rollback. Assert each row exposes name, Slave ID, FC label, address/range, values, and latest result.

- [x] **Step 3: Add failing execution-safety tests**

Verify disabled commands cannot run; Run performs no I/O before confirmation; confirmation sends a fresh plain request with derived quantity and copied values; repeat execution is disabled while pending; success/failure updates only the selected command and records the native transaction; endpoint/session changes clear stale confirmation.

```js
await wrapper.get('[aria-label="执行写入指令 设定目标"]').trigger('click');
expect(executeImmediate).not.toHaveBeenCalled();
await wrapper.get('[aria-label="确认执行写入指令 设定目标"]').trigger('click');
expect(executeImmediate).toHaveBeenCalledWith(expect.objectContaining({
  request: expect.objectContaining({
    functionCode: 16, unitId: 1, address: 20, quantity: 2, values: [100, 200],
  }),
}));
```

- [x] **Step 4: Run panel tests and verify RED**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusMasterPanel.test.js`

Expected: FAIL because deletion is immediate and the write tab is still a one-off form.

- [x] **Step 5: Implement shared persistence and command state**

Add `persistConfig(patch)` as the single save helper, and have group and command mutations call it with normalized collections. Keep local state unchanged until `saveCommand` succeeds.

```js
const writeResults = ref(new Map());
const writeDialogOpen = ref(false);
const editingWriteCommand = ref(null);
const deleteConfirmation = ref(null);

async function persistCommands(commands) {
  return persistConfig({
    writeCommands: commands.map((command, order) => ({ ...command, order })),
  });
}
```

- [x] **Step 6: Replace the one-off write form with the saved-command workspace**

Render the toolbar, compact rows, empty state, CRUD controls, latest result, command dialog, run confirmation, and delete confirmation. Keep all actions stable while results or labels change.

- [x] **Step 7: Make destructive actions visible at narrow widths**

Remove the group header's effective clipped minimum width. At compact widths, place counts and actions on a second grid row while keeping actions right-aligned and visible. Do the same for write-command rows, with wrapping values rather than page overflow.

- [x] **Step 8: Run related components and lint**

Run: `npm run test:components -w @ineed-dev-tool/workbench -- tests/components/ModbusMasterPanel.test.js tests/components/ModbusPanel.test.js tests/components/EndpointDialog.test.js tests/components/EndpointRow.test.js tests/components/ModbusWriteCommandDialog.test.js && npx eslint packages/workbench/src/components/ModbusMasterPanel.vue packages/workbench/src/components/ModbusWriteCommandDialog.vue packages/workbench/tests/components/ModbusMasterPanel.test.js packages/workbench/tests/components/ModbusWriteCommandDialog.test.js`

Expected: PASS with zero lint errors.

---

### Task 4: Upgrade And Persistence Safety

**Files:**
- Modify: `packages/workbench/src/components/EndpointDialog.vue`
- Modify: `packages/workbench/tests/components/EndpointDialog.test.js`
- Modify: `packages/workbench/tests/endpointDraft.test.js`
- Modify: `packages/workbench/tests/workbenchModel.test.js`
- Modify: `apps/electron/tests/managementDatabase.test.js`
- Modify: `apps/tauri/src-tauri/src/database.rs`

**Interfaces:**
- No production database or native service change.
- Existing workspace schema version 1 imports and exports `writeCommands` inside endpoint JSON.

- [x] **Step 1: Add failing endpoint-editor preservation tests**

Open a master containing write commands, change connection/retry settings, save, and assert exact command IDs, values, disabled states, order, and unknown config keys survive.

- [x] **Step 2: Add failing no-write-on-load and workspace round-trip tests**

Verify old configurations normalize to `writeCommands: []` with zero persistence writes. Export/import a populated version 3 master and prove write commands plus request groups, frames, logs, send history, and unrelated config keys remain byte-for-byte unchanged.

- [x] **Step 3: Run persistence tests and verify RED where preservation is missing**

Run: `node --test apps/electron/tests/managementDatabase.test.js packages/workbench/tests/workbenchModel.test.js packages/workbench/tests/endpointDraft.test.js && npm run test:components -w @ineed-dev-tool/workbench -- tests/components/EndpointDialog.test.js && cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml database -- --nocapture`

Expected: Any explicit command-preservation assertion fails until the endpoint editor carries the normalized list through save; database round-trip assertions already demonstrate the generic JSON boundary.

- [x] **Step 4: Preserve commands in endpoint master saves**

When constructing the Modbus master endpoint draft, copy `normalizeModbusConfig(...).writeCommands` alongside `requestGroups`. Do not add a migration or database production code.

- [x] **Step 5: Run persistence and endpoint regression suites**

Run the command from Step 3 again.

Expected: PASS; loading remains read-only and explicit saves change only the intended endpoint JSON.

---

### Task 5: E2E Acceptance And Full Verification

**Files:**
- Modify: `packages/workbench/e2e/fixtures/previewBridge.js`
- Modify: `packages/workbench/e2e/workbench.spec.js`
- Modify: `packages/workbench/src/styles/workbench.css` only if responsive E2E exposes layout defects.

**Interfaces:**
- Preview and native runtimes consume the same version 3 `writeCommands` configuration.
- Native transaction format stays unchanged.

- [x] **Step 1: Add failing saved-command E2E flows**

For Electron and Tauri previews, configure saved FC05 and FC16 commands. Verify list rendering, add/edit/copy/toggle/delete, mandatory execution confirmation, independent success/failure results, correlated instruction records, and confirmed request-group deletion.

- [x] **Step 2: Run targeted E2E and verify RED**

Run: `npm run test:e2e -w @ineed-dev-tool/workbench -- --grep "saved Modbus write commands"`

Expected: FAIL until preview fixtures and the write-command workspace exist.

- [x] **Step 3: Complete deterministic fixtures and responsive assertions**

At 1440x900, 1120x720, and 820x1180, assert the request-group Delete action and all write-command actions are inside the visible content area, control text fits, no page overflow exists, and Electron/Tauri screenshots differ by zero pixels after masking the runtime footer.

- [x] **Step 4: Run full verification sequentially**

Run:

```bash
npm test
npm run lint
npm run build
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
npm run test:e2e
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml \
  electron_and_rust_cross_runtime_tcp_and_rtu -- --ignored --nocapture
git diff --check
```

Expected: all commands exit 0; run the complete npm and Rust suites sequentially to avoid starving timing-sensitive transport tests.

- [ ] **Step 5: Start or reuse both development applications for acceptance**

Use the existing `npm run dev:electron` and `npm run dev:tauri` processes when ports 5173 and 5174 belong to this repository. Confirm both native windows render the saved-command workspace and visible request-group delete action. Do not create, delete, or execute commands against the user's real devices during visual acceptance.

Acceptance status (2026-09-12): both existing native processes have one visible `Ineed DevTool` window, and ports 5173/5174 were verified against this repository. Saved-command and request-group rendering is verified in both previews at all three sizes. Native content-level inspection remains unverified because terminal Accessibility access is unavailable; Step 5 stays unchecked rather than equating window visibility with content verification. See `.superpowers/sdd/2026-09-12-modbus-master-write-commands/task-5-report.md`.

No commit step is included because the user explicitly requested that the shared dirty worktree remain uncommitted.
