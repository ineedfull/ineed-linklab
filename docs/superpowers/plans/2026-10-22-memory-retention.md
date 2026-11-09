# LinkLab memory retention investigation plan

**Goal:** Attribute high STOMP desktop retention, repair confirmed application leaks, verify repeated reuse, then archive the authorized existing LinkLab work and prepare installers.

**Architecture:** Preserve the shared workbench/runtime boundaries. Extend only the desktop test entry with a separate memory diagnostic path, keeping the existing full-order high-pressure path unchanged. Compare full-string observers against bounded streaming sequence counters and no observation. Inspect JavaScript/native live allocations separately from RSS and physical footprint.

**Tech Stack:** Vue3, Electron, Tauri/Rust, macOS WebKit, Node diagnostic scripts.

**Spec:** User-approved four-step plan in this conversation; preceding defect evidence in docs/stomp-soak-fixes-verification-2026-10-22.md.

## Constraints

Use the existing shared source directory and preserve all recorded uncommitted work. Only isolated databases/app IDs and localhost. One visible GUI validation at a time; keep visibility/foreground and integrity assertions. No forcedGC/reload/restart in recovery acceptance. Heap/Inspector captures are separate diagnostics, never natural recovery evidence. No production fix without confirmed evidence and failing regression. Upload/publication requires its own task.

## 1. Observer and lifecycle evidence

- [x] Add a separate diagnostic runner under tooling/stomp-test/memory-cycles.mjs; receive existing command/sample callbacks, drive existing configure/subscribe/raw/disconnect/clear/start/delete UI actions, and report each identical count/rate cycle.
- [x] Add bounded observer option only to the test browser agent: for each connection retain count, last numeric sequence and errors; fail on gaps/duplicates; default existing full-body map remains unchanged. Add retention counters and DOM counts to diagnostic metrics. Record identical full/bounded observer workloads with separate fresh processes.
- [x] Start with a finite dual-end pilot, then at least three rounds per existing host with two native consumers and independent SDK. Check exact count/order, visible names, current PIDs/timeOrigin, empty views after clear and complete deletion.
- [x] Capture native heap/vmmap and optional Inspector heap separately after an ordinary recovery sample, clearly labelling any collection-triggering operation.

## 2. Confirm or reject retained-object hypotheses

- [x] Trace controller messages/display snapshots, pending ACK/receipt maps, broker peers/queues, runtime event subscriptions and native timers. Match live heap/retention paths to source ownership; compare changes across equal repeated workloads.
- [x] For each confirmed defect, add a minimal regression to the relevant controller/component/native test file and observe the expected failure. Change only the owner responsible, rerun the new regression and relevant adjacent tests.
- [x] If the retained process memory is not reachable application objects, document measured live heap, native allocation categories, natural recovery and diagnostic limitations without introducing forced collection or speculative memory trimming.

## Confirmed rendering repair

The baseline shows roughly12286 DOM nodes for two native client endpoints despite only one foreground panel. Shell usesv-show while StompPanel continues scheduling500-row snapshots for hidden panels.

- [x] After the untouched baseline finishes, run the prepared StompPanel/ProtocolEndpoints component regressions and save expected failures.
- [x] Pass an explicit visible prop from LinkLabShell to StompPanel. While hidden cancel pending history RAFs, release the display snapshot and message DOM; retain the controller,500-row model history, credentials and local form drafts. On return schedule the latest bounded snapshot. Do not disconnect or dispose on visibility changes.
- [x] Verify real-controller1201-message delivery,500-row latest history,hidden RAF/DOM suppression,visible restoration,draft/ACK/receipt and Shell selection. Rebuild both renderers and repeat equal-count/rate cycles.

## 3. Verify and archive

- [x] Run meaningful targeted gates plus required lint/build. Rerun the repeated visible memory scenario after any application fix; preserve earlier failures.
- [x] Document actual counts, cycle resources, object cleanup and platform limits in docs/memory-retention-verification-2026-10-22.md; update workspace task/STATUS.
- [x] Review exact changed files and run required regression gates for all existing uncommitted LinkLab features before the authorized archive commit; record product/workspace commits separately.
- [x] Prepare current supported macOS Electron/Tauri installers using maintained release scripts, verify generated package identity/integrity and record artifacts; no upload/publication and no claim of Windows/Linux native acceptance.

Execution: application archive f7e4df3; four macOS DMGs built from clean source and verified. Heap3 message/controller release is documented separately from natural recovery. Native allocation stacks and Intel/installation/signing acceptance remain explicit limits; see docs/memory-retention-verification-2026-10-22.md.
