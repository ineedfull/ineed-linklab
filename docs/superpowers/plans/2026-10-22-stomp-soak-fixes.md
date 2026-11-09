# STOMP pressure findings repair plan

**Goal:** Repair S1/S2 from `docs/protocol-soak-verification-2026-10-22.md`, then repeat the original visible high pressure workload without lowering its rate.

**Architecture:** Keep the shared broker/controller and both native adapters. Isolate outgoing budgets and cancellation by peer; await actual outgoing completion for local publication. Diagnose the exact native/controller failure boundary before changing throughput behavior.

**Constraints:** Work in the existing shared source directory, preserve all existing uncommitted protocol work, use isolated databases and localhost targets. No commit, release or new feature. Keep one GUI test running at a time. The desktop workload remains 32 messages/batch, 50ms pause, 1-second heartbeats, two native consumers plus an independent SDK.

## 1. Reproduce and distinguish the failure

- [x] Add controller regression coverage in `packages/workbench/tests/stompWorkbench.test.js`: a blocked slow peer must not disconnect a healthy peer; publication must remain pending until native completion and report failure accurately; closing a peer/session must cancel queued sends.
- [x] Run `node --test packages/workbench/tests/stompWorkbench.test.js`, save expected failures.
- [x] Add bounded, credential-free diagnostics distinguishing controller admission failure from native rejection. Reproduce Tauri broker direction first if needed; retain the original diagnostics and tests.

## 2. Repair outgoing ownership and completion

- [x] Change `packages/workbench/src/model/stompWorkbench.js` so send admission, ordering and invalidation belong to a peer lane; keep bounded count/bytes. Release queued work immediately on closure and prevent delayed work reaching a replacement peer/session.
- [x] Propagate delivery promises through `packages/workbench/src/model/stompBroker.js` for local publication; await all intended deliveries, show sending/failed/sent based on completion, and preserve synchronous protocol validation and independent healthy delivery.
- [x] Add and run broker/controller tests for async rejection, partial failure, disconnect, retained queue recovery and wire order. Synchronous broker consumers must remain compatible.
- [x] If real diagnostics identify throughput starvation, cover that boundary with a failing test before repairing it. Do not increase capacity to hide sustained saturation.
- [x] After native sender coalescing still fails, separate immediate protocol processing from frame-scheduled display snapshots and reuse stable keyed rows. Verify full 600-message delivery, 500-row retention, clear/unmount and unchanged payload reuse with failing regressions.
- [x] Coalesce native Tauri GUI STOMP ingress before the WebView boundary, using bounded count/bytes and a fixed deadline. Preserve identity and flush input before peer/status changes; verify unit bounds and real ACK-before-disconnect order.

## 3. Verify the changed boundary

- [x] Run Node/component tests, lint, both renderer builds, relevant browser matrix and artifact checks. Run Rust tests/native builds if native code changes.
- [x] Run native STOMP malicious input and interoperability tests; run a short real desktop pilot with actual foreground endpoint checks and complete per-connection message order. Short runs are finite checks, not final pressure acceptance.
- [x] Repeat both real desktop roles for 600,000ms each at 32/50ms, then 180,000ms same-process idle. Verify full order/digests, no reconnect or false successful send, actual foreground names, visible windows, multi-OPC subscriptions, SQLite and cleanup.

## 4. Record results

- [x] Write `docs/stomp-soak-fixes-verification-2026-10-22.md` with root causes, failure/pass evidence and resource/platform limits. Update workspace task/STATUS and cross-link the original report without erasing historical failures.

## 5. Full existing-feature review (user scope extension)

Review both supported roles for each existing protocol, then compare add/edit/start/stop, peer selection, draft/persistence, status/error feedback, keyboard modals, typography and themes across shared panels. This is maintenance of existing roles; OPC UA remains a client, DL/T645 remains read-data master/simulator, and the STOMP server remains an ephemeral test broker.

Confirmed additional defects assigned for repair:

- Electron OPC UA terminal close retains a connection slot; TCP writes have no completion deadline.
- OPC UA browse continuation crosses sessions and invisible node selections survive navigation/filtering.
- Modbus request dialogs omit keyboard focus ownership; three configuration dialogs hide save failures and allow stale save completion to close another draft.
- Modbus trends omit theme colors/data-theme observation; OPC UA table body uses auxiliary text size.
- STOMP cancelled send overwrites ended-session status; stale async broker failure can close a replacement peer; long endpoint names overflow header.
- About protocol list omits WebSocket, OPC UA and STOMP.

Use failing regressions for behavioral fixes; verify lightweight display fixes in the final real rendering matrix. Retain the failed high1 pressure evidence: per-peer budgets alone did not resolve the native GUI load failure. A diagnostic rerun captures the first ERROR instead of relying on the last overwritten alert.

## Current handoff

Seventeen defect categories repaired; executable gates and independent review complete. Final desktop-high-final4 passed at unchanged32/50ms: Tauri602484ms/320576 messages, Electron602157ms/187552 messages, same-process idle180.700s. Full per-stream order/digests, SDK, foreground/visibility, multi-endpoint isolation, OPC UA subscriptions, SQLite and cleanup passed; process exit0 and no sampled processes remain. Resource recovery is partial: Electron final RSS829.6MiB, Tauri RSS1281.3MiB/footprint473.4MiB. Retained memory risk is documented; no claim of long-term leak exclusion. No commit/release. Historical failures remain preserved.
