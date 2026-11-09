# Device Templates Implementation Plan

**Goal:** Reuse a versioned device point table and verify fresh engineering measurements.
**Architecture:** Shared template validation and generation modules extend the existing acceptance document and runner; one shared modal handles model management. Native changes only extend the bounded persistence envelope.
**Tech Stack:** Vue 3, Node test runner, Vitest, Playwright, Electron SQLite, Rust/Tauri SQLite.
**Spec:** ../specs/2026-10-31-device-templates.md

## Global constraints

Preserve existing unrelated edits. Never overwrite an endpoint. Never export addresses or secrets in a model. Keep immutable revisions/reports. No commits or publishing. Inline execution is already authorized; no subagents.

### Task 1: Safe template domain

- [x] Add `packages/workbench/tests/deviceTemplates.test.js` with extraction/no secrets, validation, new instance identities, unit overrides, readonly conditions and revision isolation assertions. Run `node --test packages/workbench/tests/deviceTemplates.test.js` and observe failure.
- [x] Create `src/model/deviceTemplates.js`: `extractDeviceTemplate(endpoint, model)`, `normalizeDeviceTemplate(input)`, `instantiateDeviceTemplate(template, site)`, `deviceTemplatePlan(template, unitId)`. Use existing Modbus normalizer/validator and explicit field whitelists.
- [x] Repeat test command and resolve failures.

### Task 2: Engineering acceptance and version persistence

- [x] Extend domain tests with fresh raw 253 -> 25.3℃, uncertain64 rejection, bad quality, report replay validation, and immutable revisions through `createAcceptanceWorkspace`. Observe failures with Node test runner.
- [x] Add focused `engineeringAcceptance.js`; extend acceptance plan/check validation, runner decode and report evidence replay. Extend acceptance workspace optional templates validation and serialized operations: `saveTemplate`, `importTemplate`.
- [x] Update native Electron/Rust envelope validators and add regression cases for valid optional library/invalid count. Run relevant Node and Rust tests.

### Task 3: Shared model workflow

- [x] Add failing `tests/components/DeviceTemplatesPanel.test.js`: extraction, editable conditions, explicit import preview, new instance and saved scheme. Run the component test.
- [x] Build `components/DeviceTemplatesPanel.vue`, reuse acceptance dialog styles/focus trap and export adapter. Wire sidebar, model/acceptance workspace and reload lifecycle in LinkLabShell. Preserve engineering check metadata when existing AcceptancePanel edits an imported scheme.
- [x] Add `e2e/device-templates.spec.js` for both renderer entries with export/import, two new endpoints, fresh engineering acceptance and all appearance combinations. Run both component and UI tests.

### Task 4: Verification and documentation

- [x] Run `npm test`, `npm run lint`, `npm run build`, targeted Playwright and relevant native isolated acceptance where feasible. Fix discovered issues with failing regression tests.
- [x] Document usage, schema/limits and exact verification boundaries in `docs/device-templates.md` and the workspace task handoff. Run `git diff --check`; preserve the seven initial form-layout edits.

Execution evidence and limits: see `docs/device-templates.md` and workspace task `2026-10-31-linklab-device-templates.md`. Implementation executed inline as authorized; no commits or subagents.
