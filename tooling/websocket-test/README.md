# Native WebSocket acceptance

Run from the repository root with installed dependencies and the Rust toolchain.
All scripts use loopback and isolated profiles. They do not validate Windows/Linux
installation or remote TLS environments.

- `node tooling/websocket-test/cross-runtime.mjs`: native client/server interoperability.
- `node tooling/websocket-test/adversarial-duel.mjs`: malformed frames/handshakes,
  cancellation, slow peers and five minutes of native service pressure. Set
  `LINKLAB_NATIVE_PRESSURE_MS=0` for just the attack matrix. The Node driver and
  Rust harness memory in this report is separate from desktop memory.
- `node tooling/websocket-test/desktop-duel.mjs`: real branded Electron/Tauri
  windows, two clients to the opposite server, text/binary/broadcast, scheduled
  UI-owned reconnect, final SQLite byte/sequence and cross-runtime wire-order
  checks. Defaults to twenty minutes plus three minutes of same-process idle.

Set `LINKLAB_DUEL_OUT` to a new output directory for each run. The desktop run
requires an unlocked desktop. Keep both windows visible and avoid interacting
with their connections. A locked screen, minimized window, persistence warning,
page error or lost message fails acceptance. `LINKLAB_DUEL_MS`,
`LINKLAB_DUEL_IDLE_MS`, `LINKLAB_DUEL_RECONNECT_MS` and `LINKLAB_DUEL_BURST` allow
short driver pilots; those must not be described as the full soak.

On macOS compile the optional native samplers into the output parent directory:

```sh
mkdir -p /tmp/linklab-soak-helpers
clang -Wall -Wextra tooling/soak-test/macos/resource-sample.c -o /tmp/linklab-soak-helpers/resource-sample
swiftc tooling/soak-test/macos/window-state.swift -o /tmp/linklab-soak-helpers/window-state
LINKLAB_DUEL_RESOURCE_HELPER=/tmp/linklab-soak-helpers/resource-sample \
LINKLAB_DUEL_WINDOW_HELPER=/tmp/linklab-soak-helpers/window-state \
LINKLAB_DUEL_OUT=/tmp/linklab-desktop-duel-new \
node tooling/websocket-test/desktop-duel.mjs
```

The window sampler restores only the two owned host PIDs at startup and checks
real main-window visibility thereafter. AppKit menu/utility windows are excluded.
Resource grouping uses macOS responsibility IDs for WebKit subprocesses; unrelated
applications are excluded. Electron's own app metrics include renderer/GPU/network
RSS; macOS `phys_footprint` and RSS are different measures and must be reported as
such. No forced GC, reload or process restart is used during idle recovery.

The JSON summary, progress/samples, isolated database paths and logs are the
evidence. Preserve failing pilots alongside successful runs when diagnosing
test-driver mistakes. Test profiles are intentionally retained for independent
SQLite inspection; remove only those exact isolated directories after review.
