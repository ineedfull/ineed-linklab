# OPC UA simulator implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans; shared source stays in place as required by the workspace.

**Goal:** Add usable multi-instance OPC UA simulator endpoints to both desktop runtimes.

**Architecture:** A shared simulator controller and Vue panel use the existing OPC UA request bridge. Electron node-opcua and Tauri async-opcua own listening, node state and automatic changes. Separate profile storage preserves client compatibility.

**Tech Stack:** Vue3, Node/node-opcua2.187.10, Rust/async-opcua0.19, existing native adapters.

**Spec:** `docs/superpowers/specs/2026-10-22-opcua-simulator-design.md` (user approved the proposed simulator; routine details resolved in this design).

## Constraints

Use original shared directories, preserve recorded starting edits. No source copies/worktrees. No commits/releases/uploads unless separately authorized. Only localhost test targets and isolated user data. GUI tests serial. Follow exact profile/node/action shapes and numeric/resource limits in the spec; do not silently add secure endpoints or fabricate client data.

## 1. Native server adapters

Files: Electron `electron/opcuaSimulator*.cjs`, `opcuaService.cjs`, tests `opcuaSimulator.test.js`; Tauri `src/opcua/simulator.rs`, `opcua.rs`, Cargo manifests and native tests.

Interfaces: the six action requests and responses in the spec. The parent service delegates all server actions and includes simulators in shutdown.

- [x] Add failing tests that `startServer` is supported, remote read/write reflects configured values and readonly writes fail.
- [x] Validate profiles and nodes before binding; implement per-instance server with pending/cancel/session ownership and bounded automatic changes.
- [x] Test multiple instances, port conflict, invalid values, stale updates/stops, cancellation and full shutdown.
- [x] Run Rust fmt/tests and Electron Node tests; use independent Node SDK for browse/read/write/subscribe and stop/restart.

## 2. Shared controller and endpoint ownership

Files: `model/opcuaSimulator.js`, `model/protocolEndpointCatalog.js`, corresponding tests.

Interfaces: `createOpcuaSimulator(runtime,{reactive})` exposing state, initialize/selectProfile/connect/disconnect/saveProfile/importProfiles/exportProfiles/dispose and node editing/value update methods. Catalog gets separate `opcua-server` kind with profile actions serverProfiles/saveServerProfiles and compatible key `protocol:opcua-server:<id>`.

- [x] Write failing validation/controller tests for node limits, type conversion, start/cancel/stale completion, snapshot polling and disposal.
- [x] Implement strict pure normalizers and bounded controller with explicit initial/current values and serial polling.
- [x] Extend catalog load/save/import/delete/instance ownership for the new kind; preserve existing client/STOMP IDs, locking and settings queues.
- [x] Run catalog/controller regressions including deleting one running server while another remains active.

## 3. Shared UI

Files: `components/OpcuaServerPanel.vue`, EndpointDialog/Row/Tree, endpointDraft, LinkLabShell and styles; component/e2e fixtures and tests.

- [x] Add failing components for new role in the add dialog, server routing, node editing, locked structure while running and complete timestamps.
- [x] Use existing semantic controls, grouped node editor and values table; expose exact endpoint URL/NodeIds, examples, save/import/export and start/stop feedback.
- [x] Keep runtime controller mounted across navigation, avoid work on hidden lists, unmount owned views before disposal/import.
- [x] Verify keyboard, theme/font/sidebar/window matrix, then real native desktop startup and read/write/subscribe with isolated profiles.

## 4. Review and handoff

- [x] Run actual npm tests/lint/build and Rust fmt/tests, artifact boundaries and affected browser tests.
- [x] Obtain independent spec/code review and fix confirmed findings.
- [x] Record evidence and current scope in product docs; workspace task includes each repo state and cross-tool date policy verification. No automatic package rebuild/publication in this new task.

## Acceptance record

Implemented and locally verified on 2026-10-22. Final Node 1277/1277, components 341/341, Rust serial 225 passed/5 existing ignored, artifact boundaries 63/63, lint/build/fmt and affected browser matrix 18/18 passed. Both native desktop runtimes passed independent SDK browse/read/write/readonly/subscription, value UI, instance isolation, timestamps, save/restart and released-port checks. Independent review findings were fixed and rechecked, including shutdown failure ownership and resource-group cleanup. See workspace `tasks/2026-10-22-opcua-server-time.md` for evidence and cross-tool time verification.

No new long-duration Server soak, other-platform installation or remote-device acceptance is claimed. Source remains uncommitted; no installer rebuild or publication.
