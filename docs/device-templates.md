# Modbus device templates and engineering acceptance

Open **工具箱 → 设备模板** in the sidebar. Choose an existing Modbus TCP/RTU master, enter the model name and click **提取点表**. This copies normalized read request groups and point decoding settings: types, offsets, byte/word order, scale, value offset, unit, reasonable bounds, and Boolean bit index/name. It excludes endpoint identities, field addresses, serial paths, write commands, passwords and unknown configuration fields.

The separate conditions editor contains an array of readonly checks. Each condition references an enabled group, request and point; it uses the existing assertion structure. Example:

```json
[
  {
    "groupId": "boiler-collection",
    "requestId": "holding-read",
    "pointId": "temperature",
    "assertion": { "kind": "range", "minimum": 20, "maximum": 30 }
  }
]
```

A range is initially generated for each enabled point with both reasonable bounds. For an exact 64-bit integer, use decimal strings for equality or range boundaries, for example `{"kind":"equals","expected":"18446744073709551615"}`. Boolean and text points use equality; ranges require numeric points. Templates with no conditions can still create endpoints. An acceptance scheme requires at least one condition.

**点表与解码配置 JSON** is the advanced editor for group/request/point settings. The separate conditions editor supplies the conditions when saving or exporting. Validation rejects unknown fields and invalid references. **保存新版本** appends a new revision; selecting an older revision and saving still appends after the latest revision for that template ID. Previous revisions and reports remain immutable. The first slice has no revision pruning interface: the library holds at most 50 revisions in total and reports the limit instead of deleting models automatically.

**导出模板** uses the native Save dialog and the fixed filename `linklab-device-template.json`. **导入设备模板** accepts a file or pasted JSON, validates it, and shows model name, source revision, group, point and condition counts before saving. **确认导入为新模板** creates a new template identity at revision 1, so importing the same file never overwrites a saved model. A successful preview alone does not save anything. Editing the import text invalidates the preview.

After saving a revision, fill the new endpoint name, actual TCP host/port or RTU serial path/baud/parity, and field unit ID. Instantiation replaces every group unit ID, starts with automatic polling/reconnect disabled, and assigns a new endpoint ID. TCP and RTU share the same model. Root communication timeouts/retries use application defaults unless a request has its own override. RTU instances use 8 data bits, 1 stop bit and no flow control initially; ordinary endpoint editing remains available. Open the new endpoint explicitly to communicate.

**新建端点和验收方案** also saves a named engineering acceptance scheme. Open **验收检查**, choose the saved scheme and the connected instance, then run. If saving the scheme fails after creating the endpoint, **重试保存验收方案** saves the existing scheme without creating another endpoint. A failed library save retains the draft in memory and offers **重试保存**; pending library writes must succeed before creating instances.

Each engineering check executes a fresh read through the existing scheduler and session guards. It never uses a displayed or cached last-good value. For example, raw register `253`, scale `0.1` and unit `℃` produce `25.3`; a range of 20–30 passes. Both native transport quality and point decoding quality must be good. Communication failure, insufficient/invalid raw words, reasonable-range failure and uncertain scaled 64-bit conversion cannot pass. Unscaled 64-bit integers remain exact strings; decimal fraction comparison preserves range boundary precision.

The existing report format keeps its fields. Engineering checks add a point/template snapshot to the check and put original raw words, native quality/evidence, decoding quality/reason/display, unit/configuration and template ID/model/revision in result evidence. Loading a passed engineering report replays decoding and checks its evidence/value/assertion consistency. This provides reproducibility, not a signature or tamper-proof audit. Native session guards, stop/invalidation behavior and JSON/Markdown report export remain shared with raw Modbus and OPC UA checks.

The library is an optional `templates` array in the existing `acceptanceWorkspace` version 1 document. Old documents containing only plans/reports still load; old raw Modbus/OPC UA plans and reports are unchanged. Full workspace export/import includes models through the existing settings path; ordinary send templates are independent. Existing app IDs, SQLite schema and user directories are unchanged. Each template is bounded at 256 KiB, the total document at 2 MiB; existing limits remain 50 schemes, 25 checks per scheme and the latest 20 reports. There is no automatic endpoint update when a template changes. OPC UA models, private-frame parsing and fault-scenario execution are outside this slice.

## Verification

Run commands in the repository root:

```sh
npm test
npm run lint
npm run build
npm run test:e2e -w @ineed-linklab/workbench -- device-templates.spec.js acceptance.spec.js
cargo test --offline --manifest-path apps/tauri/src-tauri/Cargo.toml acceptance_document_native_boundary_and_corruption_are_explicit
cargo test --offline --manifest-path apps/tauri/src-tauri/Cargo.toml acceptance_exports_are_fixed_bounded_and_reject_renderer_paths
node tooling/acceptance-test/device-templates-native.mjs electron
node tooling/acceptance-test/device-templates-native.mjs tauri
```

The native workload creates independent profiles/SQLite, two local Modbus simulators on dynamically allocated ports, two instances and schemes, successful engineering reads, a failing range check, and a changed template revision. It checks retained report snapshots after renderer reload and independently compares native SQLite with the renderer document. Both simulators reject writes and record actual read traffic. Their processes/sockets are closed by the harness; results/screenshots remain in the printed temporary evidence directory. Physical serial devices, production networks, Windows/Linux desktops and new installer packages are not covered by these local checks.

## Repeated native desktop acceptance

`node tooling/acceptance-test/device-templates-soak.mjs electron` and the same
command with `tauri` run visible desktop hosts against two dynamically allocated
loopback Modbus peers. The default is 1,200 seconds of repeated UI-triggered
engineering checks followed by 180 seconds idle in the same process and document.
Durations use `performance.now()`. Document nonce, DOM root and performance object
references check identity; progress also records actual `performance.timeOrigin`
values. WebKit can vary that wall-clock approximation by 1 ms within one document,
so strict equality of that number is not a reload check.
Two models, two instances and four revisions exercise passed readings, assertion
mismatch, native exception quality, decoded reasonable-bound quality, stop/late
reply and disconnect/session invalidation. Slow fault reads use a fixture barrier:
the peer first observes the native request, then holds its response until Stop or
native close has been dispatched. This avoids treating a legitimately completed
read as an invalidation failure when the desktop is busy. Every report checks the latest-20
retention order. Final checks compare reload state, native SQLite and `quick_check`;
Electron also checks actual template and JSON/Markdown export files with the Save
dialog destination controlled by the test host.

Set `LINKLAB_TEMPLATE_OUT` to an isolated evidence directory. Resource samples
contain CPU/RSS for the host's process tree; WebKit XPC entries are explicitly
shared-host observations because their parent is launchd. Do not sum those entries
into application memory without establishing ownership. `LINKLAB_TEMPLATE_SOAK_MS`
and `LINKLAB_TEMPLATE_IDLE_MS` allow short harness diagnostics; those runs do not
satisfy the default duration gate.

After the soak exits, `LINKLAB_TEMPLATE_OUT=<same-directory> node
tooling/acceptance-test/device-templates-reopen.mjs <runtime>` starts a second
native process against the same isolated profile and compares the exact document.
`LINKLAB_REOPEN_BASELINE=<filename>` can select an explicitly retained independent
SQLite baseline after a failed soak; it does not change the failed soak result.
`LINKLAB_REOPEN_EXPORT=1` additionally exercises template/report exports; on Tauri
this opens real macOS Save panels that must be completed in the evidence directory.
A progress record names the pending export. Select that directory through the
Save panel’s folder navigation and retain the fixed basename; putting an absolute
path into Save As can create a filename containing colons instead of navigating.
These scripts do not build installers,
change production profiles or access field networks.

The 2026-11-01 macOS acceptance retained an Electron full-run pass and a Tauri
full-run harness exit 1 at its former strict time-origin guard. Tauri had completed
both duration gates and 1,481 checked reports in one pending async invocation. A
60-second native probe reproduced a 1 ms time-origin change while its nonce and
DOM root references stayed identical. Independent SQLite, new-process reopen and
three actual macOS Save panels then passed against that run's data. The original
failed files remain failed; a supplemental record carries the duration lower
bounds and separate checks. The old run's final renderer-error and renderer-reload
checks were not reached. Both hosts passed a short complete regression after the
identity guard change. Cross-tool evidence and exact limits are recorded in the
workspace task `tasks/2026-11-01-linklab-template-acceptance.md`.
