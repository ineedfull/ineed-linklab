# LinkLab WebSocket Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for implementation and independent review. User approved the scope in conversation. Work directly in the original shared source directory, preserving initial changes; no commits/publication.

**Goal:** WebSocket client/server in both native runtimes with the shared existing endpoint workbench.
**Architecture:** Existing transport request/events, dedicated WS services, one shared config/UI and additive SQLite migration.
**Tech Stack:** Vue, Node ws, Rust tokio-tungstenite with rustls/native roots.
**Spec:** docs/superpowers/specs/2026-10-21-websocket-design.md

## Global Constraints

Read the spec's exact field names/limits. Loopback targets only. Never log credentials or persist custom headers. Preserve existing source, OPC UA, database identity and paths. Work in original directory; no commits or releases.

### Task 1: Rust native transport
**Files owned:** apps/tauri/src-tauri Rust/Cargo and focused WS native harness/tests; no JS/SQL files.
**Interface:** existing transport open options gains websocketHeaders, send gains optional messageType; frame optional messageType; use existing status/peers identities. Coordinator keeps existing constructors compatible for tests via builder/additional method if needed.
- [x] Write failing config, real loopback text/binary+server/multi-peer tests; run before implementation.
- [x] Add bounded client/server service with strict wss, headers/protocols, heartbeat and cancellations, then wire coordinator/lifecycle/persistence.
- [x] Include shared migration006 and update native allowlists; prove old data survives and secret config rejected.
- [x] Run focused/full Rust, fmt, native CLI acceptance; report exact evidence in own report.

### Task 2: Shared workbench
**Files owned:** packages/workbench all relevant model/UI/tests/e2e only; no runtime adapters, persistence or native files.
**Interface:** same request/events; memory-only headers in open options; config exact as spec. Avoid module global persistence of auth. messageType on send and received frames optional.
- [x] Write failing draft/config/name/peer-target/reconnect and form/send component regressions; run before implementation.
- [x] Add client/server forms and native message controls, redact transient headers from saved data, extend existing lifecycle/reconnect and server target handling.
- [x] Preserve WS message boundaries, format and close information in frame/state views; no stream framing controls for WS.
- [x] Run focused models/components and browser display/interaction matrix, report evidence.

### Task 3: Electron + shared persistence (root)
**Files owned:** Electron service/wiring/tests/package+lock, packages/persistence-contract schema+006 migration/tests; cross-runtime adapter fixtures if required.
**Interface:** runtime existing methods; service open(endpoint,{operationId,websocketHeaders}), send({endpointId,bytes,target,messageType}), events use established envelope plus frame.messageType.
- [x] Real local WS tests first: client/server, headers/subprotocol, text/binary, heartbeat, cancellation and limits. Observe missing implementation failure.
- [x] Implement dedicated bounded service and lifecycle/coordinator wiring; messages/history preserve boundary and type.
- [x] Append migration006 without changing prior migrations; test preexisting rows/children retained and save/import secret protection.
- [x] Run focused protocol/persistence/coordinator/adapter tests.

### Task 4: integration, review, docs
**Files:** tooling/websocket-test, product WS docs/README, workspace task and status.
- [x] Native client/server cross-runtime and secure failure checks on loopback; actual Electron/Tauri GUI and browser matrix.
- [x] Run npm test/lint/build/artifacts and Rust gates. Independent task+integration review, fix concrete issues and retest affected scope.
- [x] Record tested platforms/dialog/packaging limits, preserve initial baseline, update task/STATUS. No commits/packages/upload.
