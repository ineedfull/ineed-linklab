# LinkLab Read-only Acceptance Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 完成 Modbus/OPC UA 检查方案到可复核报告的用户闭环。
**Architecture:** 共享严格领域模型、顺序执行器和设置持久化控制器；UI 通过小型端点桥接使用现有 Modbus scheduler/OPC UA native read。复用 settings 与受限原生导出。
**Tech Stack:** JavaScript、Vue、Electron/SQLite、Rust/Tauri。
**Spec:** `docs/superpowers/specs/2026-10-24-acceptance-checks.md`

## Global Constraints

- 源码原址串行实现；已有 601 文件基线和 OPC UA Server 等改动必须保留；不提交任何已有改动。
- Modbus 只允许 FC1/2/3/4；只读已连接端点，不自动连接或扫描。
- Electron/Tauri 共用 packages/ 的领域逻辑和 UI；不更改数据库迁移/数据位置/应用 ID。
- 最多 50 方案、25 项/方案、64 KiB/方案、20 报告、512 KiB/报告、2 MiB 总保存量。
- 严格类型相等；有限数字闭区间；OPC UA 非 Good 不通过；断连/停止/会话变化不能误通过。
- 本轮不提交、不发布、不上传。测试使用隔离数据和 localhost。

### Task 1: 领域执行与可持久化证据

**Files:** Create `packages/workbench/src/model/acceptancePlan.js`, `acceptanceRunner.js`, `acceptanceWorkspace.js` and corresponding Node tests; modify `packages/runtime-contract/src/settingsSchema.json`, `model/secondaryViews.js`, `model/uiPreferences.js`, native database validators and their tests as needed. Small native helpers permitted; keep responsibilities focused.

**Interfaces:**
- `normalizeAcceptancePlan(input)` returns a validated JSON clone of `{id,name,protocol,checks:[{id,name,query,assertion}]}` (see Spec).
- `createAcceptanceRunner({captureTarget,isCurrent,read,now,onChange})` returns `{state,run(plan,endpointId),stop()}`. `state` has `running`, `report`; `read(target,check)` returns `{actual,quality,evidence}`. captureTarget returns private immutable target plus safe report metadata. Capture protocol/session and validate before and after each read. Bind exact final target/result shape in report for Task 2.
- `createAcceptanceWorkspace(runtime,{runner,onChange})` returns `{state,load(),savePlan(plan),deletePlan(id),importPlan(text),exportPlan(plan),run(plan,endpointId),stop(),flush(),reload(),dispose()}`. State exposes plans/reports/loaded/saving/error; report export `formatAcceptanceReport(report,'json'|'markdown')`. Use mutateSettings for every read-modify-write; appearance saves preserve its custom key. Run saves report even on stop; failed persistence keeps report in memory and flush retries.

- [x] Write tests before implementation: write function code rejected, string numeric not range number, strict expected types, missing/bad quality never pass, stop prevents second read and suppresses in-flight pass, session change invalidates, immutable snapshots, retention bounds, save/import failure preserves state, settings appearance concurrent writes retain acceptance docs. Native boundaries reject oversized/wrong-type docs and allow backward defaults.
- [x] Run new tests to observe expected RED, capture command/output.
- [x] Implement schema/assertions, sequential runner, report formatter and persistence. Native boundary can store an opaque bounded JSON string with documented envelope validation; shared domain must fully validate before use/save/import. Use a single persistence setting with a stable versioned representation, document exact type/key for UI worker. Avoid silently normalizing corruption to empty evidence. Keep cancellation synchronous to permit shutdown flush without waiting for native network read.
- [x] Run focused new/adjacent tests, native persistence parity tests, lint relevant files; write report with exact API/schema, red/green evidence and files. No commits. Controller independently reviews before Task 2.

### Task 2: 用户界面与实际端点桥接

**Files:** Create `components/AcceptancePanel.vue`, `styles/acceptance.css`, `model/acceptanceTargets.js`, component/target tests, relevant e2e. Modify `layouts/LinkLabShell.vue`, `App.vue` only for integration/lifecycle, `apps/electron/electron/opcuaExport.cjs`, `apps/tauri/src-tauri/src/opcua.rs` for fixed report/plan filenames; corresponding export tests. Preserve preexisting hunks in shared files.

**Interfaces:** Consume Task 1 APIs and report schema from its report. `createAcceptanceTargets({model,getCatalog,runtime})` supplies `list()`, `captureTarget(endpointId,protocol)`, `isCurrent(target)`, `read(target,check)` for the runner. Eligible targets only connected Modbus masters and OPC UA clients. Private target config must not be included in report.

- [x] Write failing tests for a real edited scheme to execute/report/export flow; disconnected targets unavailable; wrong endpoint/old session rejected; save failure leaves draft; stop and close/reopen result; invalid plan import preserves existing. Test target bridge using real scheduler when practical and direct OPC UA read returning fresh values.
- [x] Run tests RED; implement scoped shared panel, keyboard focus trap, named form labels and semantic CSS variables. Use native fixed `linklab-acceptance-plan.json`, `linklab-acceptance-report.json`, `linklab-acceptance-report.md` filenames; preserve export cancel handling and reject renderer paths in both runtimes. Add Markdown filter.
- [x] Wire shell-owned controller persistence and bridge. App shutdown calls exposed shell `prepareForShutdown()` before readyForShutdown; method stop+flush, no waiting for unbounded read. Stop before workspace import; reload acceptance after import; old runtime/plan must not write pre-import data back.
- [x] Add side action without squeezing existing footer. Run components/target/export tests GREEN, browser matrices for each runtime light/dark normal/large narrow/expanded/collapsed; lint. Write task report with evidence. No commits. Controller reviews before final validation.

### Task 3: 双端原生闭环与交接

**Files:** Add `tooling/acceptance-test/desktop-acceptance.mjs` (or equivalent maintainable isolated harness), `docs/acceptance-checks.md`; update README/code-reading only relevant sections. Workspace `tasks/2026-10-24-linklab-acceptance-checks.md` and STATUS.

- [x] Build on existing desktop simulator harness to start branded isolated Electron/Tauri. Local Modbus and independent OPC UA fixture; configure clients, create/execute actual UI schemes with success/failure and reports, then verify persistence reload/stop/cleanup. Record exact runtime boundaries and artifact paths. No external targets.
- [x] Run all Node/components tests, lint/build, native Rust tests/fmt, artifact boundaries and targeted browser integration once. Fix concrete regressions; repeat only affected gates.
- [x] Review all task-owned diff against preexisting 601-file baseline, with independent final reviewer; resolve findings and record deferred platform limits. No releases or commits.
- [x] Update user documentation/task/STATUS with actual evidence, completion scope and remaining platform limits.
