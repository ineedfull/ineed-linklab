# Phase 03 Verification

Verified on 2026-07-15 in the local `ineed-dev-tool` repository.

## Scope

Phase 03 delivers production serial transport parity for Electron and Tauri, serial endpoint and
receive-framing controls, scheduled sending, and a real virtual-serial acceptance probe. The probe
uses separate `socat` processes and unique temp directories for each runtime. Electron runs its
production `SerialService` with `serialport` 13; Tauri runs its production `RealSerialBackend` and
`SerialService` through one ignored, environment-driven Rust test. No fake backend participates in
the PTY result.

## Environment

- macOS 26.5.2, Darwin 25.5.0, arm64
- Node.js `v26.5.0`; npm `11.17.0`
- socat `1.8.1.3`
- Electron serialport `13.0.0`
- rustc `1.96.1 (31fca3adb 2026-06-26)`
- cargo `1.96.1 (356927216 2026-06-26)`
- Rust serialport `4.9.0`
- Playwright Test `1.61.1`; bundled Chromium `149.0.7827.55`
- Branch `codex/history-transport-logging`; Task 6 quality-review base revision `cdba976`

## Automated Gates

All commands were run from the repository root.

| Command | Exact result |
| --- | --- |
| `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml real_pty_transport_contract -- --ignored --nocapture` with env-provided `socat` PTYs | PASS, correct ignored test name `serial::tests::real_pty_transport_contract`, 1 passed, 0 failed, 91 filtered out |
| `node_modules/.bin/cross-env INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs --runtime electron` | PASS, `PHASE03_PTY_RESULT`, 1 runtime probe, 4 persisted history frames, 4 persisted logs, frame/log timestamp arrays, `managedChildren: 0` |
| `node_modules/.bin/cross-env INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs --runtime tauri` | PASS, `PHASE03_PTY_RESULT`, 1 runtime probe, 4 persisted history frames, 4 persisted logs, frame/log timestamp arrays, `managedChildren: 0` |
| `node_modules/.bin/cross-env INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs` | PASS, `PHASE03_PTY_RESULT`, 2 runtime probes, 10 real serial sessions, 8 framing cases, 2 exact terminal cycles, 4 persisted history frames and 4 logs per runtime with timestamp arrays, 0 managed children remaining |
| `npm test` | PASS, 516 Node tests and 77 Vitest component tests |
| `npm run lint` | PASS, 0 errors |
| `npm run build` | PASS, 2 Vite production builds |
| `cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check` | PASS, no diff |
| `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml` | PASS, 91 passed, 1 ignored PTY test, 0 failed; main/doc targets 0 tests |
| `npm run test:e2e` | PASS, 51 Playwright tests |
| `npm run verify:phase-03` | PASS; 516 Node tests, 77 Vitest component tests, ESLint, 2 Vite builds, `cargo fmt --check`, 91 Rust lib tests with 1 ignored real PTY test, 51 Playwright tests, real PTY, and working-tree `git diff --check` gates completed |
| `git diff --check` | PASS, no whitespace errors |

The root script uses plain `git diff --check`. It checks the current working-tree patch and does not
invent a `HEAD^..HEAD` range, so a repository with an unrelated prior commit cannot produce a false
Phase 03 failure.

- Timestamp display: `YYYY-MM-DD HH:mm:ss.SSS` across realtime and history views.
- Persistence: Electron and Tauri reject seconds-level frame/log history timestamps.
- Layout: timestamp columns remain single-line in normal and large-font compact viewports.

## Real PTY Results

The recorded final gate resolved `/dev/ttys023` as the service side and `/dev/ttys024` as the peer side.
macOS reused those native names after the Electron pair was fully removed; each runtime still had a
different `socat` PID, unique temp directory, and independently created PTY pair.

| Runtime | TX | RX | Raw | Delimiter | Fixed | Idle | Batch | Total |
| --- | ---: | ---: | --- | --- | --- | --- | ---: | ---: |
| Electron | 61 B | 92 B | 1 frame / 49 B | 2 frames / 13 B, delimiter split across writes | 3 frames / 12 B | 1 frame / 4 B, 314 ms | 202 ms | 1,764 ms |
| Tauri | 46 B | 75 B | 1 frame / 46 B | 2 frames / 13 B, delimiter split across writes | 3 frames / 12 B | 1 frame / 4 B, 305 ms | 254 ms | 2,032 ms |

The Text vector was UTF-8 `TEXT:你好\n`, the HEX vector was
`00 10 7F 80 FF`, and the JSON vector encoded `{ "phase": 3, "runtime": runtime }` without
whitespace. Each runtime sent all three vectors through its production service, the real peer read
their exact concatenated bytes, and the peer sent the same bytes back for exact raw-frame
comparison. Electron's runtime name is three UTF-8 bytes longer, accounting for the TX/RX count
difference. Mutating each Electron caller buffer after `send` did not alter any peer byte or emitted
outbound frame, and the three sends remained three isolated outbound frames.

Delimiter framing split `0D 0A` between two physical peer writes and produced exact `alpha` and
`beta` frames. Fixed framing produced three exact four-byte frames from one 12-byte write. Idle
framing emitted no early frame after 40 ms, then emitted exact `ABCD` only after the configured
90 ms idle period. Both runtimes also emitted their outbound frame batch after the production 200 ms
batch threshold; Tauri's 50 ms native read timeout and scheduler produced the longer observed
latency without changing bytes or ordering.

Each runtime's numbered PTY history endpoint persisted exactly four history frames and four status
logs. Electron's Node oracle and Tauri's real PTY result both compared persisted SQLite rows to the
observed runtime frame/log events before reporting. The `PHASE03_PTY_RESULT` history summaries now
carry `frames.createdAt` and `logs.createdAt` arrays for both runtimes, and the Node cross-runtime
oracle requires every summary timestamp to be a safe epoch-millisecond integer between
`1_000_000_000_000` and a post-query upper bound. Electron applies the same bounded timestamp
oracle to persisted SQLite frame/log rows. Electron and Tauri both assert each structured status log
uses the exact timestamp of its owning status event before comparing persisted rows.

## Removal And Cleanup

For each runtime the probe opened a fifth production session, terminated that runtime's owning
`socat`, and required the complete terminal history to contain exactly one `DEVICE_REMOVED` error,
exactly one `closed`, and no duplicate terminal event. Electron performs a
real post-removal write because serialport 13 on Darwin repeatedly reads zero bytes from a detached
PTY instead of emitting passive disconnect; that write returns POSIX `EIO`. Tauri's native reader
receives the removal error directly. Both POSIX runtimes map post-open `EIO` to `DEVICE_REMOVED`;
Electron win32 keeps `EIO` as `IO_ERROR`.

Electron finished with zero `data`, `error`, and `close` listeners on every native port, no open
ports, and an empty service session map. Tauri finished with no registered session and a closed
native connection. Every POSIX child, including Cargo and its Rust test process, runs in an
independent process group. Timeout, `SIGINT`, and `SIGTERM` apply `SIGTERM` to the group, wait for a
first deadline, then apply `SIGKILL` and wait for a second deadline. Self-tests verified timeout,
both signal handlers, and natural exit against TERM-resistant leaders and descendants; all PIDs
disappeared and the child registry returned to zero. The top-level `finally` also removed both
unique temp directories. No PTY file, `socat` process, Vite server, Playwright worker, trace, or
unignored `test-results` artifact remained in the submitted tree.

## RED To GREEN Record

The initial real integration probes were intentionally run before production fixes.

- Electron completed exact byte and framing checks but timed out waiting for removal. A real write
  after `socat` termination exposed `EIO`; its first mapping was `IO_ERROR`, and serialport queued a
  duplicate Writable error after the service had cleaned its listeners.
- Tauri initially failed while opening the real numeric macOS PTY with `IO_ERROR: Not a typewriter`.
  serialport 4.9 documents that macOS pseudo-terminals cannot accept `IOSSIOSPEED` and must be
  opened with baud zero.
- The minimal fixes map post-open POSIX `EIO` to `DEVICE_REMOVED` in both runtimes, briefly guard
  Electron's already-queued duplicate stream error without retaining listeners, and use baud zero
  only when the complete path matches macOS `/dev/ttys[0-9]+`. `/tmp/ttys019`, `/dev/ttyUSB0`, and
  physical serial paths retain the configured baud.
- The specification review then exposed that Cargo descendants were outside the original cleanup
  registry and successful command timeout timers kept Node alive. Process-group self-tests were RED
  for timeout, natural exit, `SIGINT`, and `SIGTERM` before the supervisor and cancelable timers were
  implemented. The final probe exits immediately after reporting with zero managed children.
- The final quality review exposed that `CI=1` implicitly converted a missing `socat` dependency
  into a successful skip. Dependency-probe tests were RED for CI failure and the machine-readable
  explicit skip contract. The probe now fails by default in every environment and skips only for
  the exact non-gating opt-in `INEED_ALLOW_PTY_SKIP=1`; the required npm gate uses `cross-env` to
  force the value to `0`, overriding any inherited opt-in.

## Electron And Tauri Parity

Both production runtimes passed the same exact byte vectors, raw/delimiter/fixed/idle semantics,
batching, removal ordering, and terminal resource assertions. The same shared renderer controls are
covered at 1440 x 900, 1120 x 720, and 820 x 1180. E2E reported 0 changed pixels after masking the
runtime-specific footer at all three viewports:

| Viewport | Tests | Pixel difference |
| --- | ---: | ---: |
| 1440 x 900 | 17/17 | 0 / 1,296,000 (0.000000%) |
| 1120 x 720 | 17/17 | 0 / 806,400 (0.000000%) |
| 820 x 1180 | 17/17 | 0 / 967,600 (0.000000%) |

The stable Task 4 desktop and 820 captures were visually inspected: no control text is truncated,
no dialog or scheduled-send control overlaps another element, and the message list remains
internally scrollable. Comparing each stable Electron/Tauri pair above the 24 px runtime footer
also produced 0 changed pixels for both scenarios: desktop `0 / 1,261,440`, portrait
`0 / 947,920`.

| Scenario | Electron | Tauri |
| --- | --- | --- |
| Framing, desktop | [PNG](assets/phase-03/electron-serial-framing-desktop-1440x900.png) | [PNG](assets/phase-03/tauri-serial-framing-desktop-1440x900.png) |
| Framing, 820 | [PNG](assets/phase-03/electron-serial-framing-portrait-820x1180.png) | [PNG](assets/phase-03/tauri-serial-framing-portrait-820x1180.png) |
| Scheduled send, desktop | [PNG](assets/phase-03/electron-scheduled-send-desktop-1440x900.png) | [PNG](assets/phase-03/tauri-scheduled-send-desktop-1440x900.png) |
| Scheduled send, 820 | [PNG](assets/phase-03/electron-scheduled-send-portrait-820x1180.png) | [PNG](assets/phase-03/tauri-scheduled-send-portrait-820x1180.png) |

## Known Limits

- Tauri serialport 4.9 does not support mark parity, space parity, or 1.5 stop bits. Requests for
  those values remain explicit `IO_ERROR` configuration failures; they are not silently changed.
- Windows com0com remains a manual verification item. The equivalent setup and removal procedure
  is documented in `tooling/serial-test/README.md`; no Windows result is claimed here.
- Missing `socat` is a nonzero failure locally and in CI. Required CI runners must install it, and
  `verify:phase-03` explicitly forces `INEED_ALLOW_PTY_SKIP=0` through `cross-env`. Only explicitly
  non-gating workflows may set `INEED_ALLOW_PTY_SKIP=1`; that path prints a machine-readable
  `PHASE03_PTY_SKIPPED` record. This local Task 6 verification used socat 1.8.1.3 and did not skip.
- This macOS result does not claim local cross-compilation or runtime verification of Tauri Windows
  or Linux desktop artifacts.
