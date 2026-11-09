# Phase 02 Verification

Verified on 2026-07-13 in the local `ineed-dev-tool` repository.

## Scope

Phase 02 delivers and verifies the shared protocol workbench in both Electron and Tauri renderers.
The deterministic previews cover serial, TCP client, TCP server, UDP client, and UDP server
endpoints; two TCP server peers; 36 transfer frames; 48 logs; send state; settings; storage
statistics; and frame/log history without using native devices, network services, or browser
persistence.

The preview bridge selects exactly one runtime from the page origin. Electron pages expose only
`ineedDevTool`; Tauri pages expose only `__TAURI_INTERNALS__` and
`__TAURI_EVENT_PLUGIN_INTERNALS__`. E2E assertions verify this isolation before exercising either
shell.

## Environment

- macOS arm64
- Node.js `v26.5.0`
- npm `11.17.0`
- Playwright Test `1.61.1` resolved by the lockfile from manifest range `^1.55.0`
- Chrome for Testing `149.0.7827.55`, Playwright bundled Chromium revision `1228`
- rustc `1.96.1 (31fca3adb 2026-06-26)`
- cargo `1.96.1 (356927216 2026-06-26)`

## Source Revision

- Branch: `codex/phase-02-workbench`
- Phase base revision: `8c57fe9`
- Final verified revision: `d83bfae`
- Repository has no remote.

## Automated Gates

All commands were run from the repository root.

| Command | Result |
| --- | --- |
| `npm run test -w @ineed-dev-tool/workbench` | PASS, 9 files; 50 tests passed |
| `npm test` | PASS, 343 Node tests and 50 Vitest component tests passed |
| `npm run lint` | PASS, 0 errors |
| `npm run build` | PASS, Electron and Tauri Vite builds completed |
| `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml` | PASS, 27 tests passed; main and doc-test targets contained 0 tests |
| `npm run test:e2e` | PASS, 39 Playwright tests passed in 22.7 seconds |
| `git diff --check` | PASS, no output |

The root `npm test` command remains a fast unit/component gate and does not start browsers. Root
`npm run test:e2e` owns the browser suite, while `npm run verify:phase-02` combines the complete
phase gate.

## Final Audit Regressions

The final whole-phase review found and closed four cross-task regressions before approval:

- Workspace import now keeps the Settings surface busy through the native import and the complete
  endpoint/settings refresh. Close, cancel, save, Escape, backdrop close, and repeated import stay
  blocked until the refresh settles; component disposal does not write state back to its parent.
- UDP servers may listen without a default outbound target, but sending stays disabled until both
  target host and target port are valid. Other client/serial transports retain the endpoint target
  contract, while TCP servers retain peer and broadcast targeting.
- Electron tracks the main window by identity. On macOS, an open history window no longer prevents
  Dock activation from recreating a closed main workbench.
- Delimiter framing now uses incremental KMP matching and amortized buffer growth. For 20,000
  single-byte chunks, measured `Uint8Array.set` copying fell from `200,010,000` bytes to `52,752`
  bytes. A drained 32 MiB frame, with either no remainder or a one-byte remainder, retains zero
  additional ArrayBuffer bytes after GC. Sparse compaction remains linear for multi-frame pushes.

The final reviewer reran the complete phase gate and approved the phase at revision `d83bfae`.
Fixed-length and idle-timeout framers still use concatenation, but no Phase 02 production path
constructs them; their optimization remains a prerequisite for a future native receive pipeline.

## Browser Matrix

Playwright uses one worker against the real Electron and Tauri Vite renderer entries. Active/send,
resize, collapsed endpoint, and settings/storage scenarios are parameterized across both shells.
Each viewport executes 13 tests, including runtime isolation, bundled-browser identity, history,
and visual parity.

Three complete E2E runs were executed consecutively:

| Run | Result | Duration |
| ---: | --- | ---: |
| 1 | PASS, 39/39 | 23.8 seconds |
| 2 | PASS, 39/39 | 24.5 seconds |
| 3 | PASS, 39/39 | 24.4 seconds |
| Final gate | PASS, 39/39 | 22.7 seconds |

| Project | Viewport | Result per run | Decoded pixel diff per run |
| --- | ---: | --- | ---: |
| `desktop-1440x900` | 1440 x 900 | PASS, 13/13 | 0 / 1,296,000 (0.000000%) |
| `compact-1120x720` | 1120 x 720 | PASS, 13/13 | 0 / 806,400 (0.000000%) |
| `portrait-820x1180` | 820 x 1180 | PASS, 13/13 | 0 / 967,600 (0.000000%) |

The test-owned Vite servers use ports 4173 and 4174. Both ports were free after verification, and
no Playwright or Vite process for this worktree remained.

## Visual Verification

- Both captures must have equal decoded dimensions and equal normalized DOM/layout contracts. The
  normalized DOM is a detached clone in which only the runtime title and text are replaced; the
  live page and its runtime label are never modified.
- The layout contract compares the shell, endpoint tree, runtime footer, main area, status bar,
  frame toolbar/list, stream, and all send-panel row rectangles.
- Screenshots keep the live runtime label and mask the complete runtime footer. The parity scope is
  therefore the active workbench excluding that runtime-specific footer.
- PNGs are decoded with locked `pngjs@7.0.0` and compared with locked `pixelmatch@7.1.0` using a
  per-pixel threshold of `0.05`, anti-aliasing pixels included, and a maximum changed-pixel ratio of
  `0.0001` (0.01%). Every comparison prints the changed-pixel count and ratio.
- Unit tests accept four isolated anti-aliasing-style changes in 40,000 pixels, reject a changed
  20 x 20 block, and reject different image dimensions.
- Every viewport also checks document overflow, visible control text clipping, key-region overlap,
  internal frame/log scrolling, nonblank content, and bounded send-panel resizing.
- Screenshots, traces, and failure artifacts are written under ignored
  `packages/workbench/test-results/` and are not committed.

This verifies visual and layout parity. It intentionally does not claim PNG byte equality or SHA
equality, because encoding and raster anti-aliasing differences are not layout regressions.

## Installation Mirrors

The repository `.npmrc` contains only the standard npmmirror npm registry. Electron binary mirrors
are supplied by the dependency wrapper before spawning npm:

```sh
npm run bootstrap
```

`scripts/install-dependencies.mjs` has no package dependencies, inherits the caller environment,
uses the current Node executable to launch the npm CLI path supplied by `npm_execpath`, and sets
`ELECTRON_MIRROR` plus `ELECTRON_BUILDER_BINARIES_MIRROR`. It rejects direct invocation without
`npm_execpath` and directs callers to `npm run bootstrap`. Tests cover the spawn boundary and a real
fake npm CLI child process, environment inheritance, failure propagation, and no retry.

The reproducible Playwright browser command is:

```sh
npm run install:chromium -w @ineed-dev-tool/workbench
```

It sets `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright` and runs
`playwright install chromium --no-shell`.

### Chromium Root Cause And Resolution

Playwright 1.55.0 revision 1187 downloaded a valid 135,997,748-byte mirror ZIP: `unzip -tq`
reported no errors. Under Node 26.5.0, its old extractor repeatedly stopped while writing
`Assets.car` at 435,335 of 437,192 bytes, leaving a 624 KB cache directory. This identified the
failure as the Playwright 1.55/Node 26 extraction path rather than a mirror or Chromium artifact
failure. The stalled process was stopped, and revision 1187 plus its temporary ZIP were removed.

The manifest remains compatible with `@playwright/test@^1.55.0`; the lockfile now resolves registry
stable `1.61.1`. Its `browsers.json` selects Chrome for Testing `149.0.7827.55`, Chromium revision
1228. With the 1228 path absent, the domestic mirror command downloaded and fully extracted the
171 MiB archive in one run. `npx playwright install --list` reports Playwright 1.61.1 with
`chromium-1228`, and the cache contains Playwright-created `INSTALLATION_COMPLETE` and
`DEPENDENCIES_VALIDATED` markers.

Because `--no-shell` installs the complete bundled browser, the config uses `channel: 'chromium'`
to select Playwright's new headless mode. A `DEBUG=pw:browser` launch probe recorded the executable
as:

```text
~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/
Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

The E2E suite also asserts browser version `149.0.7827.55`. No system Chrome fallback is configured
or used.
