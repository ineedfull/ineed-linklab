# OPC UA Workbench Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for task implementation and review. User approved implementation in this session; work directly in the original source directory, preserving the recorded unrelated changes.

**Goal:** Add a usable OPC UA client workbench to LinkLab Electron and Tauri.

**Architecture:** Shared Vue/model, two native SDK adapters, a fixed JSON contract. Independent OPC UA profile/certificate storage avoids changes to the existing transport database.

**Tech Stack:** Vue3, node-opcua2.187.10, async-opcua0.19.0, Rust/Tokio, Vitest/Playwright/Node test.

**Spec:** docs/superpowers/specs/2026-10-21-opcua-workbench-design.md

## Global Constraints

- Implement the exact request/event/serialization contract in the spec; passwords remain memory-only.
- Preserve unrelated initial changes and all existing application/data identities.
- Test networks only on loopback. Do not publish or deploy.
- Shared UI uses semantic theme and font variables and remains mounted across navigation.
- Work in original directory per user workspace instructions; no source copies or worktrees.

### Task 1: Native Tauri OPC UA service

**Files:** Create `apps/tauri/src-tauri/src/opcua.rs` and focused OPC UA module files/tests; modify Cargo.toml/lock, lib.rs/runtime.rs only for registration/lifecycle. Do not change database/persistence/serial files.
**Interfaces:** Consumes the spec request contract; produces `opcua_execute` and `opcua:event`.
- [x] Read the downloaded async-opcua0.19.0 crate sources/examples for exact API, configure safe native client/certificate manager.
- [x] Write tests for type validation, profile redaction, stale sessions and service lifecycle; run before implementation to establish missing functionality.
- [x] Implement the request dispatcher with actual native client browsing/typed read-write/real subscriptions, bounded operations and explicit trust.
- [x] Register native command and shutdown cleanup, add a native CLI harness for local integration acceptance.
- [x] Run `cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml -- --check`, focused cargo tests and cargo check; report exact evidence and remaining gaps.

### Task 2: Native Electron and common runtime contract

**Files:** Create `apps/electron/electron/opcuaService.cjs`, focused helpers/tests and `tooling/opcua-test/server.mjs`; modify Electron package/lock, main/preload/runtime adapter, shared runtime contract and Tauri renderer adapter.
**Interfaces:** Consumes same JSON schema as Task1; produces the renderer `runtime.opcua` namespace for both platforms.
- [x] Create local real server with writable String/Boolean/Int32/Int64/Double/ByteString/array and read-only nodes, authentication and secured endpoints.
- [x] First write and execute Node tests exercising actual discovery/read/write/subscription and explicit certificate rejection/trust, plus invalid input and stale-session cancellation.
- [x] Implement node-opcua service, native-only file storage and request dispatch, preserving 64-bit precision and per-node status.
- [x] Integrate trusted Electron IPC and shutdown handling; adapt both renderers using existing envelope helpers. Add unavailable runtime methods and fixture implementations explicitly.
- [x] Run relevant Node/runtime adapter tests and the local native service integration suite.

### Task 3: Shared workbench and interaction

**Files:** Create `packages/workbench/src/model/opcuaWorkbench.js`, `components/OpcuaPanel.vue`, `styles/opcua.css` and model/component tests; modify LinkLabShell.vue minimally for navigation.
**Interfaces:** Consumes only `runtime.opcua.execute/onEvent`; all UI works in both runtimes.
- [x] Write model tests for save/import redaction, typed values and CSV, delayed connect/disconnect and stale events; execute to observe missing module behavior.
- [x] Build independently testable model with operation revision/session identity, current values and bounded1000-event log, favorites and profiles; no automatic network activity on opening.
- [x] Write component tests for endpoint selection, security/authentication, certificate confirmation, browse/read/write/monitor, profiles and export; implement semantic accessible forms.
- [x] Add sidebar OPC UA navigation without squeezing existing footer; keep existing protocol panels and UA panel mounted when switching.
- [x] Run model/components and browser display matrix: light/dark, normal/large, sidebar expanded/collapsed, narrow windows; validate failures and no clipped primary actions.

### Task 4: Integration, review, documentation and handoff

**Files:** `tooling/opcua-test/`, OPC UA docs, README and workspace task/index.
- [x] Exercise actual Electron service and Tauri harness against the same local server including secure/auth connections and reconnect restoration; document every boundary.
- [x] Run npm test/lint/build and Rust locked tests plus new focused native acceptance. Compare unrelated baseline hashes.
- [x] Have an independent reviewer check spec compliance and lifecycle/security/type correctness; fix concrete findings and repeat affected gates.
- [x] Document use, type support, persistence scope, exact verification and platform limits; mark task/index with live state.
