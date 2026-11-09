# Electron and Tauri Multi-Architecture DMG Packaging Design

## Goal

Produce four independent, locally installable macOS disk images for Ineed
DevTool: Electron and Tauri variants for both Apple Silicon (`arm64`) and Intel
(`x64`). Both runtimes remain first-class implementations of the same product,
and every packaged application must preserve the existing runtime behavior.

This phase produces unsigned, unnotarized local artifacts. It does not claim
public macOS distribution readiness.

## Decisions

- Tauri continues to use the official Tauri 2 bundler. No Electron packaging
  tool is introduced into the Tauri workspace.
- Electron integrates `electron-builder` and uses its macOS DMG target. No
  custom application-bundle or disk-image assembly is introduced.
- Both runtimes produce separate Apple Silicon and Intel builds. Universal
  binaries are not produced in this phase.
- The user-facing product name remains `Ineed DevTool` in all four application
  bundles.
- Final deliverable filenames identify both runtime and architecture so the
  four DMGs cannot be confused.
- `.app` bundles remain necessary build products and verification inputs, but
  the four `.dmg` files are the distribution-facing outputs.

## Host Capability Baseline

The Apple Silicon development host has both Rust targets installed:
`aarch64-apple-darwin` and `x86_64-apple-darwin`. Its Xcode macOS SDK can link
both architectures. A repository-independent Rust probe compiled to a real
x86_64 Mach-O executable and ran successfully through Rosetta 2.

Rosetta is required to launch-test x64 output on this arm64 host, but it is not
the mechanism that cross-compiles the packages. Rust and `electron-builder`
select their x64 targets directly. The Electron 43.1.0 darwin-x64 runtime is
already present in the local Electron cache; a clean machine may download it
through the repository's existing dependency mirror configuration.

## Approaches Considered

### electron-builder plus the Tauri bundler (selected)

Use each runtime's established packaging tool. Tauri already generates a valid
DMG. `electron-builder` adds Electron application assembly, native dependency
handling, and DMG creation without replacing the existing Electron main
process or renderer build. This is the smallest change with the clearest path
to future signing and notarization.

### Electron Forge plus the Tauri bundler

Electron Forge can produce a DMG through a maker, but adopting Forge would add
its project structure and lifecycle to an application that already has direct
Vite and Electron commands. That migration has no benefit for this local
packaging goal.

### Custom app and DMG assembly

Manually construct the Electron `.app` and call `hdiutil`, while retaining the
Tauri bundler. This avoids a high-level Electron packager but makes native
module placement, ASAR rules, metadata, icons, and DMG layout repository-owned
concerns. The maintenance and verification burden is not justified.

### Universal DMGs

Merge arm64 and x64 application contents into one Universal DMG per runtime.
This reduces the visible artifact count but increases each download size and
makes Electron native-module merging substantially harder to verify. Separate
architecture-specific DMGs provide clearer failure attribution and are
selected for this local testing phase.

## Scope

The implementation will:

- add `electron-builder` to the Electron workspace;
- add a focused Electron macOS arm64 and x64 packaging configuration;
- preserve the existing Tauri packaging configuration and official bundler;
- provide separate root commands for each runtime and architecture;
- provide runtime-level commands that build both architectures;
- provide one root command that builds all four variants;
- retain each framework's native build output for diagnostics;
- collect exactly four runtime-and-architecture-labelled DMGs into one ignored
  local artifact directory;
- add Electron package verification and an aggregate four-package gate;
- smoke-test all four packaged application variants; and
- rerun the existing complete cross-runtime verification gate.

The implementation will not:

- sign, notarize, staple, upload, or publish any artifact;
- configure automatic updates;
- add Universal macOS, Windows, or Linux artifacts;
- replace the Tauri bundler with `electron-builder`;
- combine both runtimes into one DMG;
- change application behavior, persisted data formats, or UI; or
- install any DMG into `/Applications`.

## Electron Packaging

The Electron workspace owns its `electron-builder` configuration. The package
entry point remains `electron/main.cjs`, and the production renderer remains
`apps/electron/dist`. Packaging includes only the files required to run the
Electron application, its production renderer, and runtime dependencies.

The build targets the DMG format separately for macOS arm64 and x64. It sets
the Electron application identifier to `com.ineedfull.dev-tool.electron`,
distinct from the Tauri identifier `com.ineedfull.dev-tool`. This prevents
macOS from treating the two runtime variants as the same application during
side-by-side testing.

The current product icon source is a 128 x 128 PNG. The implementation derives
and commits the valid `.icns` resource required by `electron-builder` using
deterministic macOS icon tooling. It does not redesign the icon or fall back to
the Electron default icon.

Electron native dependencies, including `serialport`, are rebuilt separately
for the packaged Electron version and each target architecture. Native `.node`
binaries are kept outside ASAR when required by `electron-builder`; packaging
must fail rather than silently omit a module or reuse an arm64 module in x64
output, or the reverse.

The Electron packaging command disables automatic code-signing discovery so a
developer certificate present on one machine cannot make the local result
different from an unsigned build on another machine.

## Tauri Packaging

Tauri remains configured with its official application and DMG bundle targets.
The existing product name, version, identifier, icon, and production renderer
embedding remain authoritative. Packaging invokes the installed
`aarch64-apple-darwin` target for arm64 and `x86_64-apple-darwin` for x64.

The Tauri packaging command continues to pass `--no-sign --ci`. No
`electron-builder` configuration or dependency is shared with this workspace.
The existing hardened Tauri verifier remains the runtime-specific source of
truth for its application metadata, executable, embedded frontend assets, and
unsigned status.

## Commands and Artifacts

The root command surface will be:

- `npm run package:mac:electron:arm64` builds the Electron arm64 `.app` and
  DMG;
- `npm run package:mac:electron:x64` builds the Electron x64 `.app` and DMG;
- `npm run package:mac:electron` builds both Electron architectures;
- `npm run package:mac:tauri:arm64` builds the Tauri arm64 `.app` and DMG;
- `npm run package:mac:tauri:x64` builds the Tauri x64 `.app` and DMG;
- `npm run package:mac:tauri` builds both Tauri architectures;
- `npm run package:mac` builds all four variants and collects the final DMGs;
- `npm run verify:package:mac:electron` verifies both Electron architectures;
- `npm run verify:package:mac:tauri` verifies both Tauri architectures; and
- `npm run verify:package:mac` verifies all four native outputs and collected
  deliverables.

The aggregate build is deterministic and sequential. Concurrent macOS
packaging provides little benefit and makes native rebuild and DMG tooling
failures harder to attribute.

Framework-owned output directories remain unchanged. A small repository-owned
collector copies, rather than moves, the uniquely located source DMGs into the
ignored `artifacts/macos/` directory. It rejects missing or duplicate source
DMGs and replaces only the four known destination files. The aggregate
verifier then validates all native outputs and the collected copies.

The collected filenames are versioned and runtime-and-architecture-labelled:

- `Ineed DevTool-Electron_0.1.0_arm64.dmg`
- `Ineed DevTool-Electron_0.1.0_x64.dmg`
- `Ineed DevTool-Tauri_0.1.0_arm64.dmg`
- `Ineed DevTool-Tauri_0.1.0_x64.dmg`

## Verification

The aggregate verifier treats all four artifacts independently and fails if
any runtime-and-architecture pair is absent. It verifies:

- exactly one DMG is selected for each runtime-and-architecture pair;
- every source `.app` and DMG exists and is non-empty;
- every application executable is a real Mach-O file containing exactly its
  declared `arm64` or `x86_64` architecture;
- product names and versions are `Ineed DevTool` and `0.1.0`;
- the Electron and Tauri bundle identifiers match their configured values;
- each bundle contains its icon and production renderer resources;
- each Electron application contains `serialport` native modules matching its
  declared architecture and no development server dependency;
- each Tauri application contains the expected embedded `.css`, `.html`, and
  `.js` assets and no loose web-asset bypass;
- all four code-signing classifications are explicitly unsigned;
- the collected DMGs match the verified source DMGs by SHA-256; and
- no extra runtime-and-architecture-labelled DMG remains in the collection
  directory.

Runtime-specific verifier logic stays separate so Electron ASAR/native-module
rules do not weaken the Tauri executable-embedding checks. Shared helpers may
cover safe filesystem traversal, command execution, checksums, and common
metadata assertions only when doing so removes genuine duplication.

Verifier tests use temporary synthetic artifact trees and mocked macOS command
results. They cover valid artifacts plus wrong architecture, text-file
executable spoofing, symlink traversal, missing renderer assets, duplicate
DMGs, bad identifiers, unexpected signing, native-module omission, stale
collected files, and checksum mismatch.

## Packaged Application Smoke Tests

After artifact verification, launch each exact packaged `.app` directly from
its framework output. Arm64 applications run natively. On an Apple Silicon
host, x64 applications run explicitly through Rosetta 2. Use isolated
disposable application-data locations so the tests cannot alter the normal
user profile.

For each packaged application, confirm:

- the production workbench is nonblank and identifies the expected runtime;
- sidebar, filtering, settings, about, message history, and log history open;
- serial, TCP client/server, and UDP client/server forms expose their fields;
- invalid endpoint input is rejected;
- no Vite development origin is used;
- the application exits cleanly; and
- no package-owned process remains.

The existing serial, TCP, and UDP cross-runtime acceptance tests remain the
behavioral authority. Packaging smoke tests do not duplicate every transport
scenario; the full Phase 05 gate is run from the same final source revision.

## Failure Handling

Every build, collection, and verification command uses a nonzero exit for a
missing Rust target, unavailable Rosetta when x64 smoke testing is required,
missing dependency, native rebuild failure, bundler failure, absent or
ambiguous artifact, metadata mismatch, wrong architecture, checksum mismatch,
unexpected signature, smoke-test failure, or residual package-owned process.

Errors identify the runtime, failed invariant, and relevant artifact path.
Cleanup removes only processes and disposable data created by the current
packaging or smoke-test run. Existing user applications and long-lived virtual
serial laboratories are not terminated.

## Verification Sequence

1. Add failing configuration and verifier tests for the Electron DMG contract
   and the aggregate four-DMG contract.
2. Configure `electron-builder` and implement the architecture-specific and
   aggregate root commands.
3. Build and verify the Electron macOS arm64 and x64 packages.
4. Build and verify the Tauri macOS arm64 and x64 packages.
5. Collect and checksum the four runtime-and-architecture-labelled DMGs.
6. Launch all four exact packaged applications with isolated data and complete
   the native and Rosetta production smoke tests.
7. Run `npm run verify:phase-05` from the final source revision.
8. Confirm `git diff --check`, a clean submitted worktree, and no package-owned
   residual processes.

## Deferred Release Work

Apple Developer ID signing, notarization, stapling, automatic updates, remote
artifact publication, CI packaging runners, and additional operating-system or
CPU targets, including Universal macOS DMGs, remain separate follow-up work.
The local unsigned DMGs must not be presented as ready for public distribution.
