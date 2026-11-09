# Real Serial PTY Verification

`pty-loopback.mjs` verifies both desktop runtimes against operating-system pseudo-terminals. It
does not use the JavaScript or Rust fake serial backends.

For each runtime, the orchestrator creates a unique directory under the operating-system temp
directory and starts a separate `socat` process with this topology:

```text
production SerialService <-> PTY <-> socat <-> PTY <-> real peer file descriptor
```

The Electron probe constructs the production `SerialService` with `serialport` 13. The Tauri probe
runs the ignored Rust test `serial::tests::real_pty_transport_contract`, which constructs the
production `RealSerialBackend` and `SerialService`. Each runtime also creates an isolated temporary
SQLite database, routes its numbered PTY history endpoint through the Task 6 persistence worker,
closes and flushes it, then queries exact inbound/outbound order, payload bytes, byte counts, serial
INFO logs, and safe millisecond timestamps. Text, HEX, and JSON are encoded first and then verified
as exact bytes in both directions. The probes also cover raw, cross-chunk delimiter,
multi-frame fixed length, idle timeout, 200 ms batching, send-buffer isolation, device removal,
terminal status ordering, listener cleanup, and resource cleanup.

## Prerequisites

- Node.js 22.13 or newer and installed workspace dependencies (`npm run bootstrap`)
- Rust and Cargo compatible with `apps/tauri/src-tauri/Cargo.lock`
- `socat` 1.8 or newer on macOS or Linux

macOS with Homebrew:

```sh
brew install socat
node tooling/serial-test/pty-loopback.mjs
```

Linux with apt or dnf:

```sh
sudo apt-get install socat
# or: sudo dnf install socat
node tooling/serial-test/pty-loopback.mjs
```

Run one runtime while diagnosing a platform issue:

```sh
node tooling/serial-test/pty-loopback.mjs --runtime electron
node tooling/serial-test/pty-loopback.mjs --runtime tauri
```

Required acceptance commands run with skipping disabled:

```sh
INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs --runtime electron
INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs --runtime tauri
INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs
```

Run the complete Phase 03 gate from the repository root:

```sh
npm run verify:phase-03
```

The final line starts with `PHASE03_PTY_RESULT=` and contains JSON with the resolved native port
names, TX/RX byte counts, framing results, removal error, resource state, and elapsed time. Every
POSIX child, including `socat`, Cargo, and Cargo's Rust test process, starts in its own process
group. Timeout, `SIGINT`, and `SIGTERM` send `SIGTERM` to the complete group, wait for the first
deadline, escalate the group to `SIGKILL`, and wait for a second deadline. Natural child exit also
kills any same-group orphan. The top-level `finally` drains the child registry before removing temp
directories. Automated self-tests cover timeout, both signals, natural exit, TERM-resistant leaders
and descendants, zero surviving PIDs, and an empty registry.

Missing `socat` is a nonzero failure in every environment, including CI. CI runners executing
`npm run verify:phase-03` must install `socat`. The complete gate uses `cross-env` to force
`INEED_ALLOW_PTY_SKIP=0`, so an inherited value of `1` cannot bypass the real PTY check on any
supported npm host. A non-gating workflow that intentionally cannot provide PTYs may explicitly run:

```sh
INEED_ALLOW_PTY_SKIP=1 node tooling/serial-test/pty-loopback.mjs
```

Only the exact value `1` enables this behavior. The command then exits zero and prints
`PHASE03_PTY_SKIPPED={"reason":"socat-not-installed"}` for machine detection. Do not set this
variable in required verification or release gates.

## Windows Equivalent

Windows does not provide POSIX PTYs or `socat`. Use a signed com0com build and an elevated com0com
Setup Command Prompt:

```bat
setupc.exe install PortName=COM11 PortName=COM12
setupc.exe list
```

Use `COM11` as the application endpoint and `COM12` as the peer. Open the peer with a serial
terminal or a small `.NET System.IO.Ports.SerialPort` harness configured to the same baud, data
bits, parity, stop bits, and flow control. Repeat the byte and framing vectors reported by the POSIX
probe. To test removal, disable the com0com pair in Device Manager while the endpoint is open and
verify one `DEVICE_REMOVED` error followed by `closed`; then confirm both COM handles can be opened
again. Remove the pair after testing:

```bat
setupc.exe remove 0
```

The automated Node orchestrator currently targets macOS/Linux `socat`; Windows remains a manual
verification item. macOS verification does not imply, and this project does not claim, local
cross-compilation of Tauri Windows or Linux desktop artifacts.

## Troubleshooting

- `socat is not installed`: install it with the platform command above, including on CI runners.
  Use `INEED_ALLOW_PTY_SKIP=1` only for an explicitly non-gating workflow.
- `Permission denied`: on Linux, check the generated PTY permissions and the user's serial groups;
  do not run the application as root to hide a permissions defect.
- `Port busy` or `already open`: close terminal programs using the generated path and check for an
  older probe process with `pgrep -lf socat`.
- `Not a typewriter` on macOS: use this orchestrator. `serialport` 4.9 requires a baud of zero only
  while opening a complete numeric `/dev/ttys[0-9]+` pseudo-terminal path. Temp symlinks such as
  `/tmp/ttys019` and physical device paths retain the configured baud.
- Timeout during removal: confirm the owned `socat` PID exited. Electron's Darwin binding needs a
  real post-removal write to surface `EIO`; the probe performs that write and requires it to map to
  `DEVICE_REMOVED`. This POSIX mapping is not applied on Windows, where `EIO` remains `IO_ERROR`.
- Interrupted run: the signal handler should clean all owned resources. If the host forcibly killed
  Node, terminate only the `socat` command whose arguments contain `ineed-phase03-` and remove the
  matching temp directory.
