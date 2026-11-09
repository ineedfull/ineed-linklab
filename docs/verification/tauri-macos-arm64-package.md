# Tauri macOS arm64 package verification

Verified on 2026-07-19 (Asia/Shanghai) from source commit
`4dbb78ba5064b252684eafd68276a29d59883cad`.

This package is unsigned, unnotarized, local-only, and not intended for public
distribution. The DMG was not installed and the app was not copied to
`/Applications`.

## Environment

| Item | Observed value |
| --- | --- |
| Host | macOS 26.5.2 (25F84), arm64 |
| Node.js | `v26.5.0` |
| npm | `11.17.0` |
| rustc | `rustc 1.96.1 (31fca3adb 2026-06-26)` |
| cargo | `cargo 1.96.1 (356927216 2026-06-26)` |
| Tauri CLI | `tauri-cli 2.11.4` |
| Installed Rust target | `aarch64-apple-darwin` |

`rustup target list --installed` exited 0 and included
`aarch64-apple-darwin`.

## Package commands

```sh
npm run package:mac
npm run verify:package:mac
```

`npm run package:mac` exited 0. Tauri reported the `--no-sign` flag, skipped
signing, finished the arm64 release build, and produced exactly one `.app` and
one `.dmg` below
`apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/`.

`npm run verify:package:mac` exited 0 before the full Phase 05 gate and again
after that gate. Each run printed exactly one result line:

```text
TAURI_MAC_PACKAGE_RESULT={"appPath":"/Users/pangzhigang/develop/com.ineedfull/ineed-dev-tool/.worktrees/tauri-macos-arm64-packaging/apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Ineed DevTool.app","dmgPath":"/Users/pangzhigang/develop/com.ineedfull/ineed-dev-tool/.worktrees/tauri-macos-arm64-packaging/apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Ineed DevTool_0.1.0_aarch64.dmg","architecture":"arm64","signing":"unsigned","embeddedAssetExtensions":[".css",".html",".js"]}
```

## Artifacts

| Artifact | Relative path | Absolute path | Observed size |
| --- | --- | --- | --- |
| App | `apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Ineed DevTool.app` | `/Users/pangzhigang/develop/com.ineedfull/ineed-dev-tool/.worktrees/tauri-macos-arm64-packaging/apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Ineed DevTool.app` | 12,815,915 regular-file bytes (12,524 KiB on disk) |
| DMG | `apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Ineed DevTool_0.1.0_aarch64.dmg` | `/Users/pangzhigang/develop/com.ineedfull/ineed-dev-tool/.worktrees/tauri-macos-arm64-packaging/apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Ineed DevTool_0.1.0_aarch64.dmg` | 4,698,498 bytes (4,592 KiB on disk) |

The app size is the sum of its regular-file byte sizes because an `.app` is a
directory bundle. The verifier also found nonempty embedded `.css`, `.html`,
and `.js` assets and no loose web assets in `Contents/Resources`.

## Bundle metadata

`plutil`/`PlistBuddy` inspection of `Contents/Info.plist` returned:

| Key | Value |
| --- | --- |
| `CFBundleIdentifier` | `com.ineedfull.dev-tool` |
| `CFBundleShortVersionString` | `0.1.0` |
| `CFBundleVersion` | `0.1.0` |
| `CFBundleName` | `Ineed DevTool` |
| `CFBundleDisplayName` | `Ineed DevTool` |
| `CFBundleExecutable` | `ineed-dev-tool-tauri` |
| `CFBundleIconFile` | `Ineed DevTool.icns` |

The executable architecture check returned:

```text
apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Ineed DevTool.app/Contents/MacOS/ineed-dev-tool-tauri: Mach-O 64-bit executable arm64
```

The build intentionally skipped distribution signing. `codesign -dvvv`
reported a linker-generated ad hoc signature (`flags=0x20002(adhoc,linker-signed)`,
`Signature=adhoc`, `TeamIdentifier=not set`) with no signing authority, which
the package verifier classified as `unsigned`. Strict bundle verification
exited 1 with:

```text
apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Ineed DevTool.app: code has no resources but signature indicates they must be present
```

No Developer ID signature or notarization was applied.

## Packaged UI smoke

The exact generated app path was launched directly. Computer Use inspected the
native packaged window without a Vite server:

- The window title and product name were `Ineed DevTool`; the runtime label was
  `tauri` and the accessibility URL was `tauri://localhost`.
- The production workbench was nonblank. The persisted endpoint-list surface
  loaded without an error and factually showed the empty state `暂无端点`.
- `全部`, `SERIAL`, `TCP`, and `UDP` filters responded, and the endpoint sidebar
  collapsed to its compact state and expanded again.
- Settings opened with runtime, display, workspace, and data-storage sections.
  Its history surface showed 0 history messages, 0 logs, 0 send records, and 0
  total rows. No setting was changed or saved.
- About opened and showed `Ineed DevTool`, version `0.1.0`, and runtime `tauri`.
- The endpoint dialog exposed serial port, baud rate, data bits, parity, stop
  bits, flow control, and receive-framing fields; TCP client/server address and
  port fields; and UDP client/server bind, target, port, and framing fields.
- One UDP-server draft with a blank local bind address was submitted. The form
  remained open with `请输入本地绑定地址。`; cancel returned to the unchanged
  `暂无端点` list. No test endpoint was persisted, saved, or deleted.

In the normal profile, no user endpoint was opened and no saved setting or data
was changed. The DMG was not installed. The packaged history/storage surface
and its zero persisted counts were inspected in Settings.

### Isolated dedicated history windows

The dedicated history windows were inspected in a separate run with the exact
packaged executable and a disposable profile rooted at
`/tmp/ineed-packaged-history.kxXbZw`. The process received this isolated
environment:

```text
HOME=/tmp/ineed-packaged-history.kxXbZw/home
CFFIXED_USER_HOME=/tmp/ineed-packaged-history.kxXbZw/home
TMPDIR=/tmp/ineed-packaged-history.kxXbZw/tmp
XDG_CONFIG_HOME=/tmp/ineed-packaged-history.kxXbZw/xdg-config
XDG_DATA_HOME=/tmp/ineed-packaged-history.kxXbZw/xdg-data
XDG_CACHE_HOME=/tmp/ineed-packaged-history.kxXbZw/xdg-cache
```

Before saving an endpoint, filesystem inspection found the new database at
`/tmp/ineed-packaged-history.kxXbZw/home/Library/Application Support/com.ineedfull.dev-tool/ineed-dev-tool.db`.
The normal profile remained at
`/Users/pangzhigang/Library/Application Support/com.ineedfull.dev-tool`.
Its directory metadata and every database file's size, timestamps, inode,
mode, and SHA-256 hash matched the pre-launch manifest before the isolated
endpoint was saved. The normal-profile content hashes were:

| File | SHA-256 |
| --- | --- |
| `ineed-dev-tool.db` | `1fe8f6113488865c546d2faa55b21482662ce4be19d4f505eeefa09bc3131489` |
| `ineed-dev-tool.db-shm` | `6985dc415948c9397d505d57c911e646f3c5a8670a308d31dc04ebe1200cb8a4` |
| `ineed-dev-tool.db-wal` | `79d27ace48a9d50230221939e95fe6be9ca00338eb6bee112c2a60ad37dda6d7` |

Only after this isolation proof, a minimal TCP client profile for
`127.0.0.1:9000` was saved and selected in the disposable profile. It remained
`已关闭 RX 0 TX 0`; the transport-open control was not used. A direct read-only
database query confirmed 1 temporary endpoint, 0 transfer frames, and 0
runtime logs.

The packaged message-history window rendered with title and header `历史消息` /
`消息历史` at this production URL:

```text
tauri://localhost/index.html?view=history&kind=frames&endpointId=endpoint-1784447315477
```

It displayed the endpoint scope, search, direction, start/end time filters,
the `时间`, `端点`, `方向`, `格式`, `字节`, and `预览` table headers, the empty
state `没有匹配的历史记录`, `共 0 条`, disabled previous/next controls, page
`0 / 0`, and the 50-row page-size selector.

The packaged log-history window rendered with title and header `历史日志` /
`日志历史` at:

```text
tauri://localhost/index.html?view=history&kind=logs&endpointId=endpoint-1784447315477
```

It displayed the endpoint scope, search, level, source, and start/end time
filters, the `时间`, `端点`, `级别`, `来源`, and `消息` table headers, the same
zero-row empty and pagination states, and the 50-row page-size selector. Both
history windows were closed before quitting the packaged app.

After the app exited 0, the complete normal-profile metadata and hash manifest
still matched its pre-launch state. The disposable profile contained 1
endpoint, 0 frames, and 0 runtime logs immediately before cleanup. Its entire
root was then removed; a `/tmp/ineed-packaged-history.*` search returned no
remaining profile. Thus the temporary endpoint no longer exists and the
user's normal Tauri data was not modified.

The `tauri://localhost` packaged URL and `tauri` runtime state contain no
development Vite origin. A process inspection after closing the app found no
Vite process owned by this repository or worktree. One Vite process belonging
to a different repository was observed and left untouched.

## Phase 05 gate

```sh
npm run verify:phase-05
```

The gate exited 0 with these final counts:

| Check | Result |
| --- | --- |
| Node test runner | 574 tests: 573 passed, 0 failed, 1 skipped |
| Vitest | 9 files passed; 83 tests passed |
| Rust | 125 passed, 0 failed, 3 ignored |
| Playwright | 51 passed |
| Serial acceptance | 2 runtime summaries; `managedChildren: 0` |
| TCP acceptance | 4 scenarios; `managedChildren: 0` |
| UDP acceptance | 4 scenarios; `managedChildren: 0` |

Serial covered Electron and Tauri. TCP and UDP each covered Electron loopback,
Tauri loopback, Electron-client-to-Tauri-server, and
Tauri-client-to-Electron-server scenarios. `git diff --check` inside the gate
also passed.

## Cleanup

The packaged app was closed through its native window. Final targeted process
inspection found no executable inside the generated `Ineed DevTool.app`, no
repository-owned Vite process, and no packaging or acceptance child process.
The isolated history run also exited 0 before its temporary profile was
removed. No unrelated process was terminated.
