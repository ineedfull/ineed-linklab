# macOS multi-architecture package verification

Verified on 2026-07-20 (Asia/Shanghai). The final aggregate package build was
made from source commit `848c675c5d91370618f214b4dac7a13ae9df521f`
(`fix: package Electron runtime contracts`). The packaging work before the
runtime-asset correction ended at
`eb74b3c3a5c1d681a013f5c131d028300d05c088`; an actual packaged Electron launch
at that revision exposed the missing contract assets, so those earlier
Electron artifacts are not accepted here.

All packages in this document are unsigned, unnotarized local test artifacts.
No app was copied to `/Applications`, no DMG was installed, and no Vite server
was started for a packaged-window smoke.

## Environment

| Item | Observed value |
| --- | --- |
| Host | macOS 26.5.2 (25F84), arm64 |
| Node.js / npm | `v26.5.0` / `11.17.0` |
| Electron / electron-builder | `43.1.0` / `26.15.3` |
| Rust | `rustc 1.96.1 (31fca3adb 2026-06-26)` |
| Cargo | `cargo 1.96.1 (356927216 2026-06-26)` |
| Tauri CLI | `tauri-cli 2.11.4` |
| Playwright | `1.61.1` |
| Xcode / SDK | Xcode 26.6 (17F113) / macOS SDK 26.5 |
| Installed Rust targets | `aarch64-apple-darwin`, `x86_64-apple-darwin` |
| Rosetta check | `arch -x86_64 uname -m` exited 0 and printed `x86_64` |

## Build and gate commands

After the runtime-asset correction, the two Electron roots were first rebuilt
with the following commands. Both exited 0; their individual durations were
not separately recorded.

```sh
npm run package:mac:electron:arm64
npm run package:mac:electron:x64
```

The complete source and transport gate first ran at that source commit, followed
by the aggregate package verifier and `git diff --check`. The accepted gate run
was:

| Command | Exit | Duration |
| --- | ---: | ---: |
| `npm run verify:phase-05` | 0 | 56.65 s |
| `npm run verify:package:mac` | 0 | 0.64 s |
| `git diff --check` | 0 | not timed |

An artifact audit then required one final four-package build at the same clean
source commit so that all four deliverables had explicit same-revision build
evidence:

```sh
npm run package:mac
```

It exited 0 in 120.15 seconds. The command rebuilt Electron and Tauri for both
architectures, printed Electron's `identity explicitly is set to null`, printed
Tauri's `--no-sign` warning for both targets, and collected exactly four DMGs
under `artifacts/macos/`.

The package-only checks were repeated after that aggregate build:

| Command | Exit | Duration |
| --- | ---: | ---: |
| `npm run verify:package:mac` | 0 | 0.63 s |
| `git diff --check` | 0 | not timed |

The package verifier was run again after the final aggregate build. The hashes
and paths below are from that post-build run, not from an earlier package.

## Final artifacts

The table paths are relative to this exact repository root:

```text
/Users/pangzhigang/develop/com.ineedfull/ineed-dev-tool/.worktrees/multi-architecture-dmg-packaging
```

Each source/collected pair has the same byte size and SHA-256 hash.

| Runtime | Arch | Source DMG | Collected DMG | Bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| Electron | arm64 | `apps/electron/release/arm64/Ineed DevTool-Electron_0.1.0_arm64.dmg` | `artifacts/macos/Ineed DevTool-Electron_0.1.0_arm64.dmg` | 130,160,769 | `5041db626d6674fa528446775155bc00dfe8f821116bcb25758b6025cdd6965c` |
| Electron | x64 | `apps/electron/release/x64/Ineed DevTool-Electron_0.1.0_x64.dmg` | `artifacts/macos/Ineed DevTool-Electron_0.1.0_x64.dmg` | 131,946,606 | `e9eb36414d7922333025388f049279c5d37db667d5d4910193fdb4863bb27ea9` |
| Tauri | arm64 | `apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Ineed DevTool_0.1.0_aarch64.dmg` | `artifacts/macos/Ineed DevTool-Tauri_0.1.0_arm64.dmg` | 4,698,504 | `5717b0a5a388d12d0a0409d669e79a8d01bde07dd4eb40794f86a5fc89d89c4e` |
| Tauri | x64 | `apps/tauri/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Ineed DevTool_0.1.0_x64.dmg` | `artifacts/macos/Ineed DevTool-Tauri_0.1.0_x64.dmg` | 4,870,021 | `7e1aca6ed9e99c968c0c39afd0a6bfbec79a3842762cec908176b65835de9353` |

The verifier-returned app paths and regular-file bundle sizes were:

| Runtime | Arch | App path | Regular-file bytes | Disk KiB |
| --- | --- | --- | ---: | ---: |
| Electron | arm64 | `apps/electron/release/arm64/mac-arm64/Ineed DevTool.app` | 334,261,467 | 327,420 |
| Electron | x64 | `apps/electron/release/x64/mac/Ineed DevTool.app` | 333,688,079 | 326,872 |
| Tauri | arm64 | `apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Ineed DevTool.app` | 12,815,915 | 12,524 |
| Tauri | x64 | `apps/tauri/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Ineed DevTool.app` | 13,120,371 | 12,820 |

## Executables and native modules

`file` and `lipo -archs` returned:

| Runtime | Arch | Executable | `file` result | `lipo` |
| --- | --- | --- | --- | --- |
| Electron | arm64 | `apps/electron/release/arm64/mac-arm64/Ineed DevTool.app/Contents/MacOS/Ineed DevTool` | Mach-O 64-bit executable arm64 | `arm64` |
| Electron | x64 | `apps/electron/release/x64/mac/Ineed DevTool.app/Contents/MacOS/Ineed DevTool` | Mach-O 64-bit executable x86_64 | `x86_64` |
| Tauri | arm64 | `apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Ineed DevTool.app/Contents/MacOS/ineed-dev-tool-tauri` | Mach-O 64-bit executable arm64 | `arm64` |
| Tauri | x64 | `apps/tauri/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Ineed DevTool.app/Contents/MacOS/ineed-dev-tool-tauri` | Mach-O 64-bit executable x86_64 | `x86_64` |

For both Electron packages, the verifier's runtime-selected serial binding was
`Contents/Resources/app.asar.unpacked/node_modules/@serialport/bindings-cpp/build/Release/bindings.node`.
`file` identified each as a Mach-O universal bundle and `lipo -archs` printed
`x86_64 arm64`. The verifier also executed the packaged Electron ABI resolver
and confirmed that the selected binding contains the requested app slice.

The corrected Electron bundles contain the two exact runtime contracts in both
architectures:

| Resource | Bytes | SHA-256 |
| --- | ---: | --- |
| `Resources/contracts/persistence-contract/migrations/001-initial.sql` | 2,650 | `9e74c71b64c758c8994efb647c8ef9905f7cf513c4f875ad8269ff481d722164` |
| `Resources/contracts/runtime-contract/src/settingsSchema.json` | 936 | `5f4f47d143768512091f68c3c9c0777c35baf670360947593c56e57610cf4e04` |

## Metadata, assets, and signing

| Runtime | Identifier | Name / display name | Version | Executable | Icon |
| --- | --- | --- | --- | --- | --- |
| Electron arm64/x64 | `com.ineedfull.dev-tool.electron` | `Ineed DevTool` | `0.1.0` / build `0.1.0` | `Ineed DevTool` | `icon.icns` |
| Tauri arm64/x64 | `com.ineedfull.dev-tool` | `Ineed DevTool` | `0.1.0` / build `0.1.0` | `ineed-dev-tool-tauri` | `Ineed DevTool.icns` |

Both Electron icons were 664,301 bytes with SHA-256
`941a4a3cf199357a390046a7de18952809ebc2c1a31f1a19fbdccd8f4188aa9e`.
Both Tauri icons were 28,996 bytes with SHA-256
`17f0e4f1a5bc5127f5d95b38a8a3f5e5a89ee5bb46b2f0d784470d9efc0fa5de`.

The verifiers found nonempty local HTML, JavaScript, and CSS renderer assets in
all four apps. Electron additionally passed exact ASAR reference validation and
the packaged runtime-contract byte checks. Tauri passed its embedded-asset
inspection and contained no loose web asset in `Contents/Resources`.

All four verifier records reported `signing: "unsigned"`. Electron and Tauri
arm64 executables carried linker-generated ad hoc signatures
(`Signature=adhoc`, `TeamIdentifier=not set`, no `Authority=`); the x64 bundles
reported `code object is not signed at all`. No Developer ID identity or
notarization was applied.

## Packaged-window smoke

Every accepted launch directly targeted the verifier-returned executable. Each
launch used a unique disposable `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, and XDG
directory. Electron also received a unique `--user-data-dir`. The x64 commands
explicitly used `/usr/bin/arch -x86_64 <exact executable>`; `open` was not used,
so no existing process or profile could be reused.

| Runtime | Arch | Main PID | Child PIDs | Live code type | Screenshot bytes | Exit |
| --- | --- | ---: | --- | --- | ---: | ---: |
| Electron | arm64 | 37633 | 37638, 37639, 37641 | main and helpers `ARM64` | 126,646 | 0 |
| Electron | x64 | 43396 | 43398, 43399, 43466 | main and helpers `X86-64 (translated)` | 126,644 | 0 |
| Tauri | arm64 | 45117 | none | `ARM64` | 425,280 | 0 |
| Tauri | x64 | 46685 | none | `X86-64 (translated)` | 425,333 | 0 |

`vmmap` reported each process path inside the exact app bundle and the expected
bundle identifier. All accepted screenshots were visually inspected and were
nonblank. No package-owned child remained after exit.

### Electron semantic smoke

Playwright connected to each real packaged Electron renderer over a unique CDP
port. Both architecture runs verified the same complete behavior:

- title/product `Ineed DevTool`, runtime footer `electron`, nonblank 1360 x 828
  workbench, sidebar, endpoint search, and `ALL`/serial/TCP/UDP filtering;
- production `file://.../Contents/Resources/app.asar/dist/index.html` origin,
  with no localhost, Vite, HTTP, or development origin;
- Settings with runtime/display/workspace/data-storage sections and initial
  history/log/send/total counts of zero;
- About with product `Ineed DevTool`, version `0.1.0`, and runtime `electron`;
- serial port, baud rate, data bits, parity, stop bits, flow control, and
  receive-framing controls;
- TCP client/server and UDP client/server address, port, and receive-framing
  forms; every transport exposed raw, delimiter, fixed, and idle modes;
- a UDP-client draft with blank local bind and target addresses stayed open and
  showed `请输入本地绑定地址。` and `请输入默认目标地址。`;
- one closed `127.0.0.1:9000` TCP-client smoke endpoint was then created only in
  the disposable profile so the real message-history and log-history windows
  could be opened;
- both history windows used packaged `file://` URLs, exposed their complete
  filters/tables/pagers, and showed zero rows and `共 0 条`.

The final Electron databases each contained exactly one intentional endpoint
and zero transfer frames, runtime logs, send history rows, or templates.
Read-only queries did not change either database SHA-256.

### Tauri native smoke and limitation

Both real Tauri windows had native title `Ineed DevTool`, rendered a nonblank
production workbench with the product brand, endpoint sidebar, search,
`ALL`/serial/TCP/UDP filters, empty endpoint state, settings/about controls, and
visible `tauri` runtime footer. Both disposable databases contained zero
endpoints, frames, logs, sends, and templates.

This environment did not expose Computer Use `node_repl`, and macOS System
Events could not enumerate either Tauri WKWebView (`-1719`). Therefore the
Tauri packaged WebView was not semantically automated and no arbitrary GUI
scripting was used. The actual packaged-window evidence is the native window
metadata, `vmmap` architecture/path, screenshot, isolated database, and clean
exit. Feature-level Tauri evidence is supplied by the deterministic renderer
suite in the same verification run. Playwright covers the Tauri sidebar,
filters, settings, frame/log history, serial form, and active workbench; the
component/UI-contract and endpoint-draft tests cover the About panel, all five
transport forms, and invalid-input handling. Electron/Tauri Playwright visual
parity was 0 differing pixels at all three viewports. The packaged process scan
found no repository Vite process, and the package verifier confirmed embedded
local production assets. The actual Tauri WebView URL could not be read through
the unavailable semantic interface; this is the sole packaged-UI automation
limitation.

## Profile isolation

Source inspection established the normal locations before launch:

- Electron opens `ineed-dev-tool.db` below `app.getPath('userData')`, whose
  product-name default is `~/Library/Application Support/Ineed DevTool`;
- Tauri opens the same filename below `app.path().app_data_dir()`, which is
  `~/Library/Application Support/com.ineedfull.dev-tool` for this identifier.

The normal Electron location did not exist before or after any launch. The
normal Tauri directory's metadata was identical before and after: mode `0755`,
inode `104814751`, size 160, mtime
`1784445610362205680` ns. Its regular files were unchanged:

| File | Bytes | SHA-256 before and after |
| --- | ---: | --- |
| `ineed-dev-tool.db` | 4,096 | `1fe8f6113488865c546d2faa55b21482662ce4be19d4f505eeefa09bc3131489` |
| `ineed-dev-tool.db-shm` | 32,768 | `6985dc415948c9397d505d57c911e646f3c5a8670a308d31dc04ebe1200cb8a4` |
| `ineed-dev-tool.db-wal` | 65,952 | `79d27ace48a9d50230221939e95fe6be9ca00338eb6bee112c2a60ad37dda6d7` |

Only metadata and SHA-256 were read from the normal profile; user data contents
were not inspected. Disposable queries used `PRAGMA query_only=ON`. Opening the
Tauri WAL databases for those queries performed SQLite housekeeping and
changed the disposable database file hashes, but the queried row counts stayed
zero and no user profile was involved. After all app processes exited, every
Task 6 disposable profile directory was removed; a final `/tmp` search found
none remaining.

## Phase 05 and transport evidence

The final `npm run verify:phase-05` run reported:

| Check | Result |
| --- | --- |
| Node test runner | 667 passed, 0 failed, 0 skipped |
| Workbench Vitest | 9 files, 83 passed |
| ESLint / production builds / `cargo fmt --check` | passed |
| Rust | 125 passed, 0 failed, 3 ignored environment-driven probes |
| Playwright | 51 passed; 0 differing Electron/Tauri pixels at 1440x900, 1120x720, and 820x1180 |
| Serial acceptance | Electron and Tauri summaries; `managedChildren: 0` |
| TCP acceptance | four scenarios; `managedChildren: 0` |
| UDP acceptance | four scenarios; `managedChildren: 0` |

The ignored Rust probes are deliberately run by the real acceptance tools, so
they are not skipped from the gate. Serial ran with `INEED_ALLOW_PTY_SKIP=0`:
both runtimes passed raw, delimiter, fixed, and idle framing, device removal,
resource cleanup, four persisted frames (two inbound/two outbound), and four
logs. The Electron summary reported 61 transmitted and 92 received bytes; the
Tauri summary reported 46 transmitted and 75 received bytes. The wrapper ended
with `managedChildren: 0`.

TCP and UDP each passed these four real localhost scenarios:

| Transport | Scenario | Frames | Logs | Peer frames |
| --- | --- | ---: | ---: | ---: |
| TCP | Electron loopback | 4 | 8 | 2 |
| TCP | Tauri loopback | 4 | 8 | 2 |
| TCP | Electron client -> Tauri server | 4 (2 each runtime) | 8 (3 Electron, 5 Tauri) | 2 |
| TCP | Tauri client -> Electron server | 4 (2 each runtime) | 8 (5 Electron, 3 Tauri) | 2 |
| UDP | Electron loopback | 4 | 9 | 2 |
| UDP | Tauri loopback | 4 | 9 | 2 |
| UDP | Electron client -> Tauri server | 4 (2 each runtime) | 9 (4 Electron, 5 Tauri) | 2 |
| UDP | Tauri client -> Electron server | 4 (2 each runtime) | 9 (5 Electron, 4 Tauri) | 2 |

The mixed-role source and summaries were independently checked. For both TCP
and UDP, the Electron client sent `61 62`; the Tauri server asserted that
inbound frame and replied `71 72`; the Electron client asserted the reply. In
the reverse direction, the Tauri client sent `81 82`; the Electron server
asserted it and replied `91 92`; the Tauri client asserted that inbound reply.
The server-side frames retained peer identity. Both TCP and UDP wrappers ended
with `managedChildren: 0`.

These are production transport-module probes using Electron JavaScript modules
and Tauri Rust modules over real PTYs or localhost sockets. They are distinct
from packaged-window evidence and do not claim that the transport sessions
were driven through the packaged UI.

## Cleanup

Final targeted scans found no package executable, Electron helper,
electron-builder, Tauri, Cargo, repository Vite, Playwright, or acceptance
process started by this verification. The pre-existing long-lived virtual
serial laboratory was preserved, including `socat` PIDs 45971 and 88429 and
their supervisors. No unrelated process was terminated. Screenshots, logs,
profiles, and the disposable smoke harness are not committed.

Immediately before the original evidence commit, `git status --short` showed
exactly the two intended documentation paths:

```text
 M README.md
?? docs/verification/macos-multi-architecture-packages.md
```

`git diff --check` exited 0. The original evidence commit was
`782c88092b3ebdd04e1ed33c240cab1e3ee5218a` (`docs: verify
multi-architecture macOS packages`). Immediately after that commit,
`git status --short` printed nothing, and `git log -6 --oneline` printed:

```text
782c880 docs: verify multi-architecture macOS packages
848c675 fix: package Electron runtime contracts
eb74b3c fix: pin Electron Builder runtime version
321ef17 fix: bind DMG matrix validation to commit
dddf6e0 fix: preserve atomic DMG collection failures
8d16f7d fix: make DMG collection transactional
```

The subsequent `docs: record final package cleanup evidence` commit only adds
this missing Git cleanup record; it follows `782c880` and does not change the
packages, launch results, hashes, or test evidence above.
