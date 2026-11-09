# Unified Protocol Endpoints Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development; preserve shared edits and do not commit or publish.

**Goal:** Multiple independent OPC UA/STOMP endpoints in the existing endpoint tree and creation flow.

**Architecture:** A shared catalog owns persisted protocol profiles and per-endpoint controllers. Shell combines catalog entries with existing transport endpoints and dispatches by source; protocol traffic remains outside transport history.

**Tech Stack:** Vue shared workbench, existing Electron/Tauri adapters, existing profile stores.

**Spec:** `docs/superpowers/specs/2026-10-22-protocol-endpoints-design.md`.

## Global Constraints

- Existing profiles, data directories and PKI remain compatible. No credential/frame persistence; no database migration.
- STOMP 4 / OPC UA 8 concurrent native sessions. Independent attempt UUIDs and session fencing.
- Source in place, no commits/releases; GUI tests strictly serial with existing 20+3 soak.

## Task 1: Catalog, session ownership and settings serialization

- [x] Add failing `protocolEndpointCatalog.test.js`: existing profiles, independent controllers, serialized merge/update/delete, cancellation/deletion, persistence failure, credentials omitted and disposal.
- [x] Add `protocolEndpointCatalog.js`, minimal shared `settingsMutation.js`; coordinate uiPreferences and SettingsPanel fallback saveAll with fresh STOMP profiles inside the same queue.
- [x] Expose default OPC UA config and guard repeated connect with regression test.
- [x] Verify focused controller/catalog/settings tests and review.

## Task 2: Unified UI

- [x] Add failing tree/dialog/panel ownership/browser tests.
- [x] Shell creates catalog and merges lists/state maps; dispatches CRUD/lifecycle, preserves keyed panels and imports.
- [x] EndpointDialog creates protocol drafts; EndpointTree/Row add protocol categories/addresses/status. Remove singleton sidebar buttons.
- [x] Bound panels accept externally owned API, fixed role and catalog persistence; retain standalone mode for protocol checks.
- [x] Verify components, lint and full display matrix; adapt old OPC UA/STOMP e2e to the unified entry.

## Task 3: Native cap and final acceptance

- [x] Rust OPC UA 8-session cap, including pending connections, with regression and release of cancelled/failed slots.
- [x] Independent review, full npm/Rust/build/contract/e2e gates; record counts.
- [ ] Actual desktop multiple simultaneous endpoints in each runtime, cross-runtime/SDK communication and isolated real OPC UA node servers, UI switch/close/delete/persist.
- [x] Preserve WebSocket formal rerun and STOMP native five-minute/attack evidence as separate reports.
- [x] Update product usage/verification and workspace task/STATUS with exact results and limits; no publishing.
