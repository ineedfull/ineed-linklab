# UDP Production Transport Implementation Plan

Goal: implement production `udp-client` and `udp-server` transports for Electron and Tauri with realtime frames/logs/peers, history persistence, workbench compatibility, real localhost acceptance, and a Phase 05 verification gate.

## Tasks

- [ ] Generalize runtime/workbench contracts to allow `source: "udp"` and UDP peer-scoped frames/logs.
- [ ] Implement Electron UDP service, route it through Electron `TransportCoordinator`, wire it in `main.cjs`, and cover client/server localhost behavior.
- [ ] Implement Tauri UDP service, route it through Tauri transport coordinator, wire it into shutdown, and cover client/server localhost behavior.
- [ ] Extend persistence/history coverage for UDP `source` and `peerId`.
- [ ] Expose UDP receive-framing controls in the endpoint dialog, matching TCP controls.
- [ ] Add real UDP acceptance probe and `verify:phase-05`.
- [ ] Run focused tests, full gate, update verification docs, review scope, and commit.

## Verification Commands

- `node --test packages/runtime-contract/tests/runtimeContract.test.js packages/workbench/tests/workbenchModel.test.js apps/electron/tests/udpService.test.js apps/electron/tests/serialService.test.js`
- `cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check`
- `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml udp::tests transport::tests`
- `node tooling/udp-test/localhost-loopback.mjs`
- `npm run verify:phase-05`
