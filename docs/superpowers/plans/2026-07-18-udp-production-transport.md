# UDP Production Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the interrupted production UDP client/server implementation for Electron and Tauri, including runtime contracts, peer-aware workbench behavior, persistence, localhost acceptance, and a Phase 05 verification gate.

**Architecture:** Keep UDP beside the proven TCP services and reuse the same transport event, persistence, and coordinator boundaries. UDP clients bind one local socket with a default target; UDP servers passively discover remote peers and can send to one peer, all peers, or an optional default target. Each datagram enters the configured receive framer before it becomes a persisted realtime frame.

**Tech Stack:** Node.js `dgram`, Rust `std::net::UdpSocket`, Tauri 2, Vue 3, Node test runner, Vitest, Playwright, `rusqlite`, localhost acceptance scripts.

---

## File Structure

- Finish `apps/tauri/src-tauri/src/udp.rs`: production UDP lifecycle, framing, peer tracking, shutdown, and Rust tests.
- Modify `apps/tauri/src-tauri/src/transport.rs`: route UDP commands and cover coordinator persistence.
- Modify `apps/tauri/src-tauri/src/lib.rs`: manage UDP service and include it in ordered shutdown.
- Finish `apps/electron/electron/udpService.cjs`, `transportCoordinator.cjs`, and `main.cjs`: preserve the already passing Electron implementation and close integration gaps.
- Modify `packages/runtime-contract/src/serialWireNormalizer.js` and contract fixtures/tests: accept `source: "udp"` while preserving serial/TCP aliases.
- Modify `packages/workbench/src/model/endpointDraft.js`, `sendPanelState.js`, `createWorkbenchModel.js`, `EndpointDialog.vue`, and `SendPanel.vue`: save UDP receive framing and expose server peer/default-target sends.
- Add/update focused unit and component tests beside each module.
- Create `tooling/udp-test/localhost-loopback.mjs`: Electron, Tauri, and mixed runtime UDP probes.
- Modify `package.json` and create `docs/verification/phase-05.md`: define and record the complete Phase 05 gate.

## Task 1: Complete Tauri UDP Service

**Files:**
- Modify: `apps/tauri/src-tauri/src/udp.rs`
- Reference: `apps/tauri/src-tauri/src/tcp.rs`
- Test: inline `#[cfg(test)]` tests in `apps/tauri/src-tauri/src/udp.rs`

- [ ] **Step 1: Preserve the current compiler RED**

Run:

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --no-run
```

Expected: FAIL at `Mutex<Option<SocketAddr>>::store`, `UdpSocket::shutdown`, incomplete coordinator constructors, shutdown test ordering, and the temporary frame borrow.

- [ ] **Step 2: Add lifecycle/framing regression tests before further production behavior**

Cover configuration parsing, duplicate open, open after shutdown, raw/delimiter/fixed/idle framing, peer discovery, targeted send, broadcast send, default-target send, close flush, and passive `disconnectPeer` rejection. Use real localhost `UdpSocket` pairs and event assertions, for example:

```rust
#[test]
fn udp_server_broadcasts_to_all_discovered_peers() {
    let sink = Arc::new(RecordingUdpSink::default());
    let service = Arc::new(UdpService::new(sink.clone()));
    service.open(udp_server_endpoint("udp-broadcast"), "open-broadcast").unwrap();
    // Bind two peers, send one datagram from each, then assert both receive the broadcast.
}
```

Run each new test by name and confirm it fails for the missing behavior before implementation.

- [ ] **Step 3: Implement the minimal lifecycle and framing model**

Replace ad hoc session storage with a stopped/active-open/session lifecycle matching TCP. Store the default target through its mutex:

```rust
*session.target.lock().map_err(poisoned)? = Some(target);
```

Do not call `shutdown` on `UdpSocket`; set the stop flag, drop both socket handles, and let the 50 ms read timeout release and join the reader. Parse `ReceiveFraming::from_config`, maintain a framer per client and per discovered server peer, flush pending frames on close, and reject new opens after shutdown.

- [ ] **Step 4: Verify Tauri UDP GREEN**

Run:

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml udp::tests -- --nocapture
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --no-run
```

Expected: all UDP tests pass and the crate compiles.

## Task 2: Complete Runtime Routing, Shutdown, And Persistence

**Files:**
- Modify: `apps/tauri/src-tauri/src/transport.rs`
- Modify: `apps/tauri/src-tauri/src/lib.rs`
- Modify: `apps/electron/electron/transportCoordinator.cjs`
- Modify: `apps/electron/electron/main.cjs`
- Modify: `packages/runtime-contract/src/serialWireNormalizer.js`
- Test: `apps/tauri/src-tauri/src/transport.rs`
- Test: `apps/tauri/src-tauri/src/lib.rs`
- Test: `apps/electron/tests/serialService.test.js`
- Test: `packages/runtime-contract/tests/runtimeContract.test.js`

- [ ] **Step 1: Add failing UDP routing and persistence assertions**

Add coordinator tests proving `udp-client` and `udp-server` call `UdpService`, UDP `disconnectPeer` returns controlled `IO_ERROR`, and UDP frames/logs reach `PersistenceEventSink` with unchanged `createdAt` and `peerId`. Update every test constructor to pass a UDP service. Add a shutdown ordering assertion:

```rust
assert_eq!(&*order.lock().unwrap(), &["serial", "tcp", "udp", "persistence"]);
```

Run focused Rust tests and confirm the new assertions fail before implementation.

- [ ] **Step 2: Finish coordinator and shutdown wiring**

Route UDP endpoints through `UdpService` for open/send/close, keep `disconnectPeer` unavailable, and call UDP before persistence during graceful and forced shutdown. Preserve the existing shared event sink so frames/status/peers follow the same persistence path as TCP.

- [ ] **Step 3: Finish runtime contract coverage**

Keep the transport source set exact:

```js
const TRANSPORT_SOURCES = new Set(['serial', 'tcp', 'udp']);
```

Add fixtures/tests for UDP open/listening/peer/frame events, including `peerId` on server traffic and serial/TCP regression cases.

- [ ] **Step 4: Verify routing and persistence GREEN**

Run:

```bash
node --test packages/runtime-contract/tests/runtimeContract.test.js apps/electron/tests/serialService.test.js apps/electron/tests/udpService.test.js
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml transport::tests lib::tests -- --nocapture
```

Expected: all selected tests pass.

## Task 3: Complete UDP Workbench Framing And Peer Sends

**Files:**
- Modify: `packages/workbench/src/model/endpointDraft.js`
- Modify: `packages/workbench/src/model/sendPanelState.js`
- Modify: `packages/workbench/src/model/createWorkbenchModel.js`
- Modify: `packages/workbench/src/components/EndpointDialog.vue`
- Modify: `packages/workbench/src/components/SendPanel.vue`
- Test: `packages/workbench/tests/endpointDraft.test.js`
- Test: `packages/workbench/tests/sendPanelState.test.js`
- Test: `packages/workbench/tests/workbenchModel.test.js`
- Test: `packages/workbench/tests/components/EndpointDialog.test.js`
- Test: `packages/workbench/tests/components/SendPanel.test.js`
- Test: `packages/workbench/tests/uiContract.test.js`

- [ ] **Step 1: Add failing UDP framing tests**

For both UDP transports, validate and save `receiveFraming`. Assert exact control names:

```text
udp-receive-framing
udp-receive-delimiter
udp-receive-length
udp-receive-idle-ms
```

Run endpoint/model/component tests and confirm they fail because UDP currently omits framing.

- [ ] **Step 2: Add failing peer-target tests**

Prove UDP server normalizes and validates `all` and discovered `peerId` targets, falls back to its optional default target only when no peer target is selected, and emits `{ broadcast: true }` or `{ peerId }` from `SendPanel`. Keep serial/TCP client and TCP server behavior unchanged.

- [ ] **Step 3: Implement minimal UI/model changes**

Reuse `validateReceiveFraming(config)` in `validateUdp`, save `receiveFraming` from `EndpointDialog`, share one receive-framing template across TCP/UDP with transport-specific names, and treat both `tcp-server` and `udp-server` as peer-aware send surfaces. Model UDP structured logs with `source: "udp"`.

- [ ] **Step 4: Verify workbench GREEN**

Run:

```bash
node --test packages/workbench/tests/endpointDraft.test.js packages/workbench/tests/sendPanelState.test.js packages/workbench/tests/workbenchModel.test.js packages/workbench/tests/uiContract.test.js
npm run test:components -w @ineed-dev-tool/workbench -- --run tests/components/EndpointDialog.test.js tests/components/SendPanel.test.js
```

Expected: all selected tests pass.

## Task 4: Add Real UDP Acceptance And Phase 05 Gate

**Files:**
- Modify: `apps/tauri/src-tauri/src/udp.rs`
- Create: `tooling/udp-test/localhost-loopback.mjs`
- Modify: `package.json`
- Create: `docs/verification/phase-05.md`

- [ ] **Step 1: Add ignored Tauri acceptance entry point**

Add `real_udp_transport_contract`, with a loopback mode and a mixed Electron-client-to-Tauri-server mode. Emit parseable `PHASE05_TAURI_*` JSON summaries with frame/log/peer counts.

- [ ] **Step 2: Implement the Node acceptance orchestrator**

Mirror the managed-child cleanup in the TCP tool. Run Electron loopback, Tauri loopback, and mixed runtime UDP; require frames, `source: "udp"` logs, peer ids, and `managedChildren=0`.

- [ ] **Step 3: Define the Phase 05 gate**

Add:

```json
"verify:phase-05": "npm run verify:phase-04 && node tooling/udp-test/localhost-loopback.mjs && git diff --check"
```

- [ ] **Step 4: Run full verification and record exact evidence**

Run:

```bash
npm run verify:phase-05
```

Record exact Node, component, Cargo, Playwright, serial, TCP, and UDP acceptance counts in `docs/verification/phase-05.md`. Re-run `git diff --check` after the document update.

## Task 5: Review And Finish

- [ ] **Step 1: Review the complete diff against the UDP design spec**

Verify Electron/Tauri parity, lifecycle race safety, event exactness, persistence timestamps/peer ids, UI controls, target semantics, acceptance cleanup, and absence of multicast/DTLS/managed UDP disconnect behavior.

- [ ] **Step 2: Run focused and full gates fresh**

Run focused UDP tests, `cargo fmt --check`, `npm run lint`, `npm run build`, and `npm run verify:phase-05`. No completion claim is allowed without fresh zero-exit evidence.

- [ ] **Step 3: Commit the completed UDP milestone**

Stage only the intended UDP/spec/plan/verification files and commit:

```bash
git commit -m "feat: add production UDP transport"
```
