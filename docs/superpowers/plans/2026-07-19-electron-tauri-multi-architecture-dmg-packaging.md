# Electron and Tauri Multi-Architecture DMG Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, collect, and verify four unsigned local macOS DMGs: Electron and Tauri for arm64 and x64.

**Architecture:** Tauri keeps its official bundler and gains an x64 target alongside the existing arm64 target. Electron uses `electron-builder` with architecture-specific output roots, while separate runtime verifiers inspect each `.app` before an aggregate collector and checksum gate publish four clearly named DMGs under one ignored artifact directory.

**Tech Stack:** Electron 43.1.0, electron-builder 26.15.3, @electron/asar 4.2.0, Tauri CLI 2.11.4, Rust `aarch64-apple-darwin` and `x86_64-apple-darwin`, Node.js test runner, macOS `file`, `plutil`, `codesign`, `sips`, `iconutil`, and Rosetta 2.

---

## File Structure

- Modify `apps/electron/package.json`: add pinned packaging dependencies and arm64/x64 Electron Builder commands.
- Create `apps/electron/electron-builder.yml`: own Electron app metadata, ASAR rules, DMG target, icon, and runtime-labelled filename.
- Create `apps/electron/build/icon.icns`: deterministic macOS icon derived from the tracked product PNG.
- Modify `apps/electron/tests/electronBoundary.test.js`: lock Electron packaging dependencies, configuration, scripts, and icon contract.
- Modify `apps/tauri/tests/tauriBoundary.test.js`: lock the separate Tauri arm64/x64 root commands.
- Modify `package.json`: expose architecture-specific, runtime-level, aggregate packaging, and verifier commands.
- Modify `package-lock.json`: lock electron-builder 26.15.3 and @electron/asar 4.2.0.
- Modify `scripts/verify-tauri-macos-package.mjs`: verify either Tauri target and default to the complete two-architecture matrix.
- Modify `scripts/verify-tauri-macos-package.test.mjs`: cover arm64, x64, wrong-architecture, Universal, and CLI matrix behavior.
- Create `scripts/verify-electron-macos-package.mjs`: inspect Electron app metadata, ASAR contents, native modules, architecture, and signing.
- Create `scripts/verify-electron-macos-package.test.mjs`: cover Electron success and hardened failure cases with isolated fixtures.
- Create `scripts/collect-macos-dmgs.mjs`: copy exactly four framework-owned DMGs to stable runtime/architecture filenames.
- Create `scripts/collect-macos-dmgs.test.mjs`: cover copy, replacement, missing, duplicate, and stale-artifact behavior.
- Create `scripts/verify-macos-packages.mjs`: run both runtime verifiers and compare collected copies by SHA-256.
- Create `scripts/verify-macos-packages.test.mjs`: cover the complete matrix, missing variants, unexpected DMGs, and checksum mismatch.
- Modify `.gitignore`: ignore `/artifacts/` while retaining the existing framework output ignores.
- Modify `README.md`: document the four local unsigned DMGs and command surface.
- Create `docs/verification/macos-multi-architecture-packages.md`: record real build, artifact, Rosetta smoke, and full-gate evidence.

### Task 1: Configure Electron Builder and Lock the Command Matrix

**Files:**
- Modify: `apps/electron/tests/electronBoundary.test.js`
- Modify: `apps/tauri/tests/tauriBoundary.test.js`
- Modify: `apps/electron/package.json`
- Create: `apps/electron/electron-builder.yml`
- Create: `apps/electron/build/icon.icns`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing Electron packaging assertions**

Extend the first Electron manifest test and add a focused configuration test:

```js
test('Electron Builder owns unsigned arm64 and x64 DMG packaging', async () => {
  const [manifest, rootManifest, builderConfig, icon] = await Promise.all([
    read('package.json').then(JSON.parse),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    read('electron-builder.yml'),
    readFile(path.join(packageRoot, 'build', 'icon.icns')),
  ]);

  assert.equal(manifest.devDependencies['electron-builder'], '26.15.3');
  assert.equal(manifest.devDependencies['@electron/asar'], '4.2.0');
  assert.match(manifest.scripts['package:mac:arm64'], /electron-builder --mac dmg --arm64/);
  assert.match(manifest.scripts['package:mac:x64'], /electron-builder --mac dmg --x64/);
  assert.match(manifest.scripts['package:mac:arm64'], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(manifest.scripts['package:mac:x64'], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(builderConfig, /appId:\s*com\.ineedfull\.dev-tool\.electron/);
  assert.match(builderConfig, /productName:\s*Ineed DevTool/);
  assert.match(builderConfig, /asarUnpack:[\s\S]*node_modules\/\*\*\/\*\.node/);
  assert.match(builderConfig, /artifactName:\s*['"]?\$\{productName\}-Electron_\$\{version\}_\$\{arch\}\.\$\{ext\}/);
  assert.ok(icon.length > 0);

  assert.equal(rootManifest.scripts['package:mac:electron:arm64'],
    'npm run package:mac:arm64 -w @ineed-dev-tool/electron');
  assert.equal(rootManifest.scripts['package:mac:electron:x64'],
    'npm run package:mac:x64 -w @ineed-dev-tool/electron');
  assert.equal(rootManifest.scripts['package:mac:electron'],
    'npm run package:mac:electron:arm64 && npm run package:mac:electron:x64');
});
```

- [ ] **Step 2: Replace the old Tauri arm64-only script assertions with the matrix contract**

Keep the existing `bundle.active` and `['app', 'dmg']` assertions, then assert:

```js
assert.equal(rootManifest.scripts['package:mac:tauri:arm64'],
  'npm run tauri:build -w @ineed-dev-tool/tauri -- --target aarch64-apple-darwin --bundles app,dmg --no-sign --ci');
assert.equal(rootManifest.scripts['package:mac:tauri:x64'],
  'npm run tauri:build -w @ineed-dev-tool/tauri -- --target x86_64-apple-darwin --bundles app,dmg --no-sign --ci');
assert.equal(rootManifest.scripts['package:mac:tauri'],
  'npm run package:mac:tauri:arm64 && npm run package:mac:tauri:x64');
assert.equal(rootManifest.scripts['package:mac'],
  'npm run package:mac:electron && npm run package:mac:tauri && node scripts/collect-macos-dmgs.mjs');
assert.equal(rootManifest.scripts['verify:package:mac:electron'],
  'node scripts/verify-electron-macos-package.mjs');
assert.equal(rootManifest.scripts['verify:package:mac:tauri'],
  'node scripts/verify-tauri-macos-package.mjs');
assert.equal(rootManifest.scripts['verify:package:mac'],
  'node scripts/verify-macos-packages.mjs');
```

- [ ] **Step 3: Run the focused boundary tests and verify RED**

Run:

```bash
node --test apps/electron/tests/electronBoundary.test.js apps/tauri/tests/tauriBoundary.test.js
```

Expected: FAIL because Electron Builder, its config/icon, the x64 Tauri command, and aggregate scripts do not exist.

- [ ] **Step 4: Install the exact Electron packaging dependencies**

Run:

```bash
npm install --save-dev --save-exact electron-builder@26.15.3 @electron/asar@4.2.0 -w @ineed-dev-tool/electron
```

Expected: exit 0; `apps/electron/package.json` and `package-lock.json` lock the exact versions, using the repository mirror wrapper environment when installation is required in mainland China.

- [ ] **Step 5: Generate the committed Electron `.icns` from the tracked PNG**

Run these macOS commands from the repository root:

```bash
iconset="$(mktemp -d)/IneedDevTool.iconset"
mkdir -p "$iconset" apps/electron/build
sips -z 16 16 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_16x16.png"
sips -z 32 32 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_16x16@2x.png"
sips -z 32 32 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_32x32.png"
sips -z 64 64 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_32x32@2x.png"
sips -z 128 128 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_128x128.png"
sips -z 256 256 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_128x128@2x.png"
sips -z 256 256 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_256x256.png"
sips -z 512 512 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_256x256@2x.png"
sips -z 512 512 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_512x512.png"
sips -z 1024 1024 apps/tauri/src-tauri/icons/icon.png --out "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o apps/electron/build/icon.icns
file apps/electron/build/icon.icns
```

Expected: `file` reports an Apple icon image containing a valid `.icns` resource. The temporary iconset is not committed.

- [ ] **Step 6: Add Electron Builder configuration and workspace scripts**

Create `apps/electron/electron-builder.yml`:

```yaml
appId: com.ineedfull.dev-tool.electron
productName: Ineed DevTool
asar: true
asarUnpack:
  - node_modules/**/*.node
npmRebuild: true
directories:
  output: release
  buildResources: build
files:
  - dist/**/*
  - electron/**/*
  - package.json
mac:
  category: public.app-category.developer-tools
  icon: build/icon.icns
  identity: null
  target: dmg
dmg:
  artifactName: ${productName}-Electron_${version}_${arch}.${ext}
```

Add to `apps/electron/package.json`:

```json
"package:mac:arm64": "npm run build && cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dmg --arm64 --config.directories.output=release/arm64",
"package:mac:x64": "npm run build && cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dmg --x64 --config.directories.output=release/x64"
```

Replace the root packaging scripts with the exact matrix asserted in Steps 1-2. Do not add packaging to `verify:phase-05`; real DMG generation remains an explicit release gate.

- [ ] **Step 7: Run boundary tests and verify GREEN**

Run:

```bash
node --test apps/electron/tests/electronBoundary.test.js apps/tauri/tests/tauriBoundary.test.js
npm run lint
```

Expected: all focused subtests pass and ESLint exits 0.

- [ ] **Step 8: Commit the packaging configuration**

```bash
git add package.json package-lock.json apps/electron/package.json apps/electron/electron-builder.yml apps/electron/build/icon.icns apps/electron/tests/electronBoundary.test.js apps/tauri/tests/tauriBoundary.test.js
git commit -m "build: configure multi-architecture macOS packaging"
```

### Task 2: Generalize the Hardened Tauri Verifier to x64

**Files:**
- Modify: `scripts/verify-tauri-macos-package.test.mjs`
- Modify: `scripts/verify-tauri-macos-package.mjs`

- [ ] **Step 1: Add x64 and strict-architecture tests**

Make `createFixture` accept `architecture`, using `aarch64-apple-darwin` plus `aarch64` DMG suffix for arm64 and `x86_64-apple-darwin` plus `x64` suffix for x64. Add:

```js
test('verifies a complete x64 Tauri macOS package', async (t) => {
  const fixture = await createFixture(t, { architecture: 'x64' });
  const result = await verifyTauriMacPackage({
    architecture: 'x64',
    bundleRoot: fixture.bundleRoot,
    execute: createRunner({ architecture: 'x86_64' }).execute,
  });
  assert.equal(result.architecture, 'x64');
  assert.equal(result.dmgPath, fixture.dmgPath);
});

test('rejects a Universal executable for an architecture-specific package', async (t) => {
  const fixture = await createFixture(t, { architecture: 'x64' });
  await assert.rejects(
    verifyTauriMacPackage({
      architecture: 'x64',
      bundleRoot: fixture.bundleRoot,
      execute: createRunner({ architecture: 'universal x86_64 arm64' }).execute,
    }),
    /must contain exactly x86_64/,
  );
});

test('rejects unsupported architecture input', async () => {
  await assert.rejects(verifyTauriMacPackage({ architecture: 'universal' }), /arm64 or x64/);
});
```

Update every existing arm64 test to pass `architecture: 'arm64'` explicitly where the behavior under test depends on architecture.

- [ ] **Step 2: Run the Tauri verifier tests and verify RED**

Run: `node --test scripts/verify-tauri-macos-package.test.mjs`

Expected: FAIL because the verifier ignores `architecture`, uses only the arm64 target root, and accepts an architecture merely by substring.

- [ ] **Step 3: Add explicit architecture descriptors**

Replace the single default root and regex with:

```js
const ARCHITECTURES = Object.freeze({
  arm64: Object.freeze({
    rustTarget: 'aarch64-apple-darwin',
    fileToken: 'arm64',
    dmgName: /^Ineed(?: DevTool|[_-]DevTool)[_-]0\.1\.0[_-](?:aarch64|arm64)\.dmg$/,
  }),
  x64: Object.freeze({
    rustTarget: 'x86_64-apple-darwin',
    fileToken: 'x86_64',
    dmgName: /^Ineed(?: DevTool|[_-]DevTool)[_-]0\.1\.0[_-](?:x64|x86_64|amd64)\.dmg$/,
  }),
});

export function bundleRootFor(architecture) {
  const descriptor = ARCHITECTURES[architecture];
  if (!descriptor) throw new TypeError('architecture must be arm64 or x64');
  return path.resolve(scriptDirectory, '..', 'apps', 'tauri', 'src-tauri', 'target',
    descriptor.rustTarget, 'release', 'bundle');
}
```

Change the public signature to:

```js
export async function verifyTauriMacPackage({
  architecture = 'arm64',
  bundleRoot = bundleRootFor(architecture),
  execute = defaultExecute,
} = {})
```

Validate the DMG with the selected descriptor. Parse `file -b` output as a Mach-O description and require the selected token while rejecting the other token. Return the requested `architecture`.

- [ ] **Step 4: Make direct invocation verify both targets**

On direct invocation, run arm64 then x64 and emit exactly one line:

```js
const results = [];
for (const architecture of ['arm64', 'x64']) {
  results.push(await verifyTauriMacPackage({ architecture }));
}
console.log(`TAURI_MAC_PACKAGE_RESULT=${JSON.stringify(results)}`);
```

Retain the existing canonical direct-invocation check and single nonzero failure path.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
node --test scripts/verify-tauri-macos-package.test.mjs
npm test
```

Expected: all Tauri verifier tests pass; the complete Node and Vitest suites have zero failures.

- [ ] **Step 6: Commit the Tauri verifier matrix**

```bash
git add scripts/verify-tauri-macos-package.mjs scripts/verify-tauri-macos-package.test.mjs
git commit -m "test: verify both Tauri macOS architectures"
```

### Task 3: Add the Hardened Electron Package Verifier

**Files:**
- Create: `scripts/verify-electron-macos-package.test.mjs`
- Create: `scripts/verify-electron-macos-package.mjs`

- [ ] **Step 1: Write the Electron verifier fixture and success tests**

Create an isolated `.app`, DMG, `app.asar`, and unpacked serial binding per test. Inject `execute` and `readAsarFile` so tests never require real package output:

```js
test('verifies complete unsigned Electron arm64 and x64 packages', async (t) => {
  for (const architecture of ['arm64', 'x64']) {
    const fixture = await createElectronFixture(t, { architecture });
    const result = await verifyElectronMacPackage({
      architecture,
      releaseRoot: fixture.releaseRoot,
      execute: fixture.execute,
      readAsarFile: fixture.readAsarFile,
    });
    assert.equal(result.architecture, architecture);
    assert.equal(result.signing, 'unsigned');
    assert.equal(result.bundleIdentifier, 'com.ineedfull.dev-tool.electron');
    assert.deepEqual(result.rendererAssets, ['.css', '.html', '.js']);
    assert.ok(result.nativeModules.some((entry) => entry.endsWith('.node')));
  }
});
```

The fixture plist is:

```js
const PLIST = {
  CFBundleIdentifier: 'com.ineedfull.dev-tool.electron',
  CFBundleShortVersionString: '0.1.0',
  CFBundleDisplayName: 'Ineed DevTool',
  CFBundleExecutable: 'Ineed DevTool',
  CFBundleIconFile: 'icon.icns',
};
```

- [ ] **Step 2: Add hardened failure tests**

Make `createElectronFixture` accept the exact `executableDescription`,
`serialDescription`, `rendererAssets`, `plist`, `authority`, `duplicate`, and
`symlinkPart` overrides used below. Add this parameterized matrix:

```js
const FAILURE_CASES = [
  ['wrong executable architecture',
    { architecture: 'arm64', executableDescription: 'Mach-O 64-bit executable x86_64' },
    /must contain exactly arm64/],
  ['Universal app executable',
    { architecture: 'x64', executableDescription: 'Mach-O universal binary x86_64 arm64' },
    /must contain exactly x86_64/],
  ['text executable architecture spoof',
    { architecture: 'arm64', executableDescription: 'ASCII text named arm64' },
    /must be a Mach-O/],
  ['duplicate app', { architecture: 'arm64', duplicate: 'app' }, /exactly one Electron app/],
  ['duplicate DMG', { architecture: 'arm64', duplicate: 'dmg' }, /exactly one Electron DMG/],
  ['missing app', { architecture: 'arm64', missing: 'app' }, /exactly one Electron app/],
  ['missing DMG', { architecture: 'arm64', missing: 'dmg' }, /exactly one Electron DMG/],
  ['missing HTML', { architecture: 'arm64', rendererAssets: ['main.js', 'main.css'] }, /\.html/],
  ['missing JavaScript', { architecture: 'arm64', rendererAssets: ['index.html', 'main.css'] }, /\.js/],
  ['missing CSS', { architecture: 'arm64', rendererAssets: ['index.html', 'main.js'] }, /\.css/],
  ['wrong serial slice',
    { architecture: 'x64', serialDescription: 'Mach-O 64-bit bundle arm64' },
    /serial.*x86_64/i],
  ['wrong bundle id',
    { architecture: 'arm64', plist: { ...PLIST, CFBundleIdentifier: 'invalid.id' } },
    /CFBundleIdentifier/],
  ['wrong version',
    { architecture: 'arm64', plist: { ...PLIST, CFBundleShortVersionString: '9.9.9' } },
    /CFBundleShortVersionString/],
  ['wrong name',
    { architecture: 'arm64', plist: { ...PLIST, CFBundleDisplayName: 'Other' } },
    /display.*Ineed DevTool/i],
  ['unsupported signer',
    { architecture: 'arm64', authority: 'Apple Development: Example' },
    /Unsupported signing identity/],
];

for (const [name, options, error] of FAILURE_CASES) {
  test(`rejects ${name}`, async (t) => {
    const fixture = await createElectronFixture(t, options);
    await assert.rejects(verifyElectronMacPackage({
      architecture: options.architecture,
      releaseRoot: fixture.releaseRoot,
      execute: fixture.execute,
      readAsarFile: fixture.readAsarFile,
    }), error);
  });
}

for (const symlinkPart of ['app', 'Contents', 'executable', 'icon', 'asar', 'native-module']) {
  test(`rejects symlinked Electron ${symlinkPart}`, async (t) => {
    const fixture = await createElectronFixture(t, { architecture: 'arm64', symlinkPart });
    await assert.rejects(verifyElectronMacPackage({
      architecture: 'arm64',
      releaseRoot: fixture.releaseRoot,
      execute: fixture.execute,
      readAsarFile: fixture.readAsarFile,
    }), /symbolic link/);
  });
}
```

Add one direct-invocation test using `symlink`, `execFile`, and the real script
path. Invoke the symlink without package artifacts, assert a nonzero exit,
assert no result line, and assert one clear missing-release-root error. This
proves the canonical invocation guard runs once; Task 5 proves the successful
matrix result against real packages.

- [ ] **Step 3: Run Electron verifier tests and verify RED**

Run: `node --test scripts/verify-electron-macos-package.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` or an undefined `verifyElectronMacPackage` export.

- [ ] **Step 4: Implement the Electron verifier interface**

Create `scripts/verify-electron-macos-package.mjs`. Export
`releaseRootFor(architecture)`, rejecting values other than `arm64` and `x64`,
and resolve the valid values to `apps/electron/release/<architecture>`.

Export `verifyElectronMacPackage({ architecture = 'arm64', releaseRoot =
releaseRootFor(architecture), execute = defaultExecute, readAsarFile =
defaultReadAsarFile } = {})`. After completing the checks below, return exactly:

```js
{
  appPath,
  dmgPath,
  architecture,
  bundleIdentifier: 'com.ineedfull.dev-tool.electron',
  signing,
  rendererAssets,
  nativeModules,
}
```

Implement the body with structured filesystem APIs and the same containment rules already proven by the Tauri verifier. Requirements:

```js
const expected = architecture === 'arm64'
  ? { fileToken: 'arm64', otherToken: 'x86_64' }
  : { fileToken: 'x86_64', otherToken: 'arm64' };
```

- Find exactly one `.app` recursively below the architecture release root and exactly one top-level `.dmg` named `Ineed DevTool-Electron_0.1.0_${architecture}.dmg`.
- Require real directories/files and canonical containment for `Contents`, `MacOS`, `Resources`, `Info.plist`, `app.asar`, the icon, executable, and unpacked `.node` files.
- Read plist JSON through `plutil`; require the exact fixture values above.
- Require the executable `file -b` result to be Mach-O and contain only the requested app architecture.
- Read `dist/index.html` from `app.asar` through `@electron/asar`'s structured API; parse local asset references and require nonempty `.html`, `.js`, and `.css` entries.
- Locate the unpacked Darwin serial binding below `Contents/Resources/app.asar.unpacked`; require at least one real `.node` file whose Mach-O description contains the requested architecture. A Universal serial binding is valid because the current serialport prebuild contains both slices.
- Reuse the Tauri signing classification semantics: no authority is `unsigned`; an unsupported authority fails; a Developer ID authority must pass strict verification.
- On direct invocation, verify arm64 then x64 and print exactly one `ELECTRON_MAC_PACKAGE_RESULT=[...]` line.

- [ ] **Step 5: Run Electron tests and verify GREEN**

Run:

```bash
node --test scripts/verify-electron-macos-package.test.mjs
npm run lint
```

Expected: all Electron verifier tests pass and ESLint exits 0.

- [ ] **Step 6: Commit the Electron verifier**

```bash
git add scripts/verify-electron-macos-package.mjs scripts/verify-electron-macos-package.test.mjs
git commit -m "test: verify Electron macOS packages"
```

### Task 4: Collect and Verify the Four-DMG Matrix

**Files:**
- Create: `scripts/collect-macos-dmgs.test.mjs`
- Create: `scripts/collect-macos-dmgs.mjs`
- Create: `scripts/verify-macos-packages.test.mjs`
- Create: `scripts/verify-macos-packages.mjs`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `apps/tauri/tests/tauriBoundary.test.js`

- [ ] **Step 1: Write failing collector tests**

Use temporary Electron and Tauri source directories and assert:

```js
const EXPECTED_NAMES = [
  'Ineed DevTool-Electron_0.1.0_arm64.dmg',
  'Ineed DevTool-Electron_0.1.0_x64.dmg',
  'Ineed DevTool-Tauri_0.1.0_arm64.dmg',
  'Ineed DevTool-Tauri_0.1.0_x64.dmg',
];

test('collects and replaces exactly four known DMGs', async (t) => {
  const fixture = await createCollectionFixture(t);
  const result = await collectMacDmgs(fixture.options);
  assert.deepEqual(result.map(({ destinationPath }) => path.basename(destinationPath)), EXPECTED_NAMES);
  assert.deepEqual(await readdir(fixture.artifactRoot), EXPECTED_NAMES);
});
```

Add failures for zero/multiple source DMGs, a symlink source, an empty source, and an unexpected fifth `.dmg` already present in the artifact directory.

- [ ] **Step 2: Write failing aggregate checksum tests**

Inject four runtime-verifier results and assert:

```js
test('verifies all four collected DMGs by SHA-256', async (t) => {
  const fixture = await createMatrixFixture(t);
  const result = await verifyMacPackages(fixture.options);
  assert.deepEqual(result.map(({ runtime, architecture }) => `${runtime}:${architecture}`), [
    'electron:arm64', 'electron:x64', 'tauri:arm64', 'tauri:x64',
  ]);
});
```

Add failures for a missing pair, duplicate pair, unexpected collected filename, and one-byte checksum mismatch.

- [ ] **Step 3: Run aggregate tests and verify RED**

Run:

```bash
node --test scripts/collect-macos-dmgs.test.mjs scripts/verify-macos-packages.test.mjs
```

Expected: FAIL because collector and aggregate verifier modules do not exist.

- [ ] **Step 4: Implement the collector**

Export `collectMacDmgs({ sources = defaultSources(), artifactRoot = DEFAULT_ARTIFACT_ROOT } = {})`. The four default source directories are:

```js
[
  ['electron', 'arm64', 'apps/electron/release/arm64'],
  ['electron', 'x64', 'apps/electron/release/x64'],
  ['tauri', 'arm64', 'apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg'],
  ['tauri', 'x64', 'apps/tauri/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg'],
]
```

For each source, locate exactly one nonempty real `.dmg`, pass
`constants.COPYFILE_FICLONE` to `copyFile` so Node attempts a clone and falls
back to a regular copy when cloning is unsupported, and return
`{ runtime, architecture, sourcePath, destinationPath }`. Before copying,
reject any existing `.dmg` in `artifactRoot` whose name is not one of the four
expected names. Replace only the four expected files. Direct invocation prints
one `MAC_DMG_COLLECTION_RESULT=[...]` line.

- [ ] **Step 5: Implement the aggregate verifier**

Export:

```js
export async function verifyMacPackages({
  electronResults,
  tauriResults,
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
} = {})
```

When results are omitted, call `verifyElectronMacPackage` and `verifyTauriMacPackage` for arm64 then x64. Require exactly the four expected runtime/architecture keys, exactly the four expected collected filenames, and SHA-256 equality between every runtime verifier's `dmgPath` and its collected copy. Return four records containing runtime, architecture, appPath, sourceDmgPath, collectedDmgPath, SHA-256, and signing. Direct invocation prints one `MAC_PACKAGE_MATRIX_RESULT=[...]` line.

- [ ] **Step 6: Finalize root scripts and ignore collected artifacts**

Add `/artifacts/` to `.gitignore`. Ensure `package.json` contains the exact scripts asserted in Task 1. The aggregate package command must invoke `node scripts/collect-macos-dmgs.mjs` only after all four framework builds exit 0.

- [ ] **Step 7: Run aggregate tests and verify GREEN**

Run:

```bash
node --test scripts/collect-macos-dmgs.test.mjs scripts/verify-macos-packages.test.mjs apps/tauri/tests/tauriBoundary.test.js
npm test
npm run lint
```

Expected: all focused tests, complete Node/Vitest suites, and ESLint pass.

- [ ] **Step 8: Commit collection and aggregate verification**

```bash
git add .gitignore package.json apps/tauri/tests/tauriBoundary.test.js scripts/collect-macos-dmgs.mjs scripts/collect-macos-dmgs.test.mjs scripts/verify-macos-packages.mjs scripts/verify-macos-packages.test.mjs
git commit -m "build: collect macOS package matrix"
```

### Task 5: Build and Verify the Real arm64/x64 Package Matrix

**Files:**
- Verify only: framework output under ignored `apps/electron/release/`, `apps/tauri/src-tauri/target/`, and `artifacts/macos/`.

- [ ] **Step 1: Confirm host prerequisites**

Run:

```bash
rustup target list --installed
arch -x86_64 /usr/bin/true
xcrun --sdk macosx --show-sdk-path
```

Expected: both `aarch64-apple-darwin` and `x86_64-apple-darwin` are installed; Rosetta exits 0; the Xcode macOS SDK path exists.

- [ ] **Step 2: Build Electron arm64 and x64 separately**

Run:

```bash
npm run package:mac:electron:arm64
npm run package:mac:electron:x64
```

Expected: both commands exit 0; each release root contains one unpacked `Ineed DevTool.app` and one runtime-labelled DMG. Electron Builder reports signing disabled and rebuilds or selects a Darwin serialport binding compatible with the target.

- [ ] **Step 3: Verify both real Electron packages**

Run: `npm run verify:package:mac:electron`

Expected: one `ELECTRON_MAC_PACKAGE_RESULT` line with arm64 and x64 records, unsigned status, exact bundle id/version, `.css/.html/.js`, and at least one compatible serial binding per record.

- [ ] **Step 4: Build Tauri arm64 and x64 separately**

Run:

```bash
npm run package:mac:tauri:arm64
npm run package:mac:tauri:x64
```

Expected: both commands exit 0; Tauri reports app and DMG bundles under their target-triple release roots and skips signing.

- [ ] **Step 5: Verify both real Tauri packages**

Run: `npm run verify:package:mac:tauri`

Expected: one `TAURI_MAC_PACKAGE_RESULT` line with arm64 and x64 records, unsigned status, exact metadata, and embedded `.css/.html/.js` assets.

- [ ] **Step 6: Run the aggregate build and verification entry points**

Run:

```bash
npm run package:mac
npm run verify:package:mac
```

Expected: all four builds are reproducible; `artifacts/macos/` contains exactly the four specified DMGs; one `MAC_PACKAGE_MATRIX_RESULT` line reports four distinct keys and matching SHA-256 values.

- [ ] **Step 7: Confirm ignored artifacts and no source mutation**

Run:

```bash
git status --short
git diff --check
```

Expected: no artifact path appears in status and diff-check emits no output. Source remains at the same commit used to build all four packages.

### Task 6: Smoke-Test All Four Packaged Applications and Record Evidence

**Files:**
- Modify: `README.md`
- Create: `docs/verification/macos-multi-architecture-packages.md`

- [ ] **Step 1: Launch each exact packaged `.app` with isolated data**

Use the verifier-returned `appPath` values. Launch Electron and Tauri arm64 natively. Launch Electron and Tauri x64 explicitly with `arch -x86_64`. Set disposable runtime-specific profile/data directories before launch; do not copy to `/Applications` and do not start Vite.

Expected for each of four windows:

- title/product `Ineed DevTool` and correct runtime identity;
- nonblank production workbench;
- sidebar, endpoint filtering, settings, about, frame history, and log history;
- serial, TCP client/server, and UDP client/server forms;
- invalid endpoint input blocked;
- no development origin;
- clean exit and no package-owned child process.

- [ ] **Step 2: Prove disposable profiles did not affect user data**

Record normal user-profile metadata and hashes before and after all four launches. Query disposable databases for only the intentionally created smoke records, then remove only those disposable profiles after the applications exit.

Expected: normal profile metadata/hashes are unchanged; no application-owned process remains; temporary profiles contain no unintended transport frames or logs.

- [ ] **Step 3: Update README command and artifact documentation**

Replace the arm64-only packaging section with:

````markdown
## Local macOS packages

```sh
npm run package:mac:electron
npm run package:mac:tauri
npm run package:mac
npm run verify:package:mac
```

The aggregate command produces unsigned, unnotarized Electron and Tauri DMGs
for arm64 and x64 under `artifacts/macos/`. They are local test artifacts, not
public distribution releases. Architecture-specific commands are available in
the root `package.json`.
````

- [ ] **Step 4: Create the verification evidence document**

Create `docs/verification/macos-multi-architecture-packages.md` with:

- source commit and host versions;
- installed Rust targets, Xcode SDK, Rosetta result, Electron/Tauri tool versions;
- exact build and verification commands with exit codes;
- all four native and collected artifact paths, byte sizes, and SHA-256 hashes;
- `file` output for all app executables and Electron serial bindings;
- plist identifiers, names, versions, icons, and signing classifications;
- packaged UI evidence for all four apps and isolated-profile proof;
- complete Phase 05 counts and transport `managedChildren=0` results; and
- final Git and process cleanup evidence.

- [ ] **Step 5: Run the complete source and transport gate**

Run:

```bash
npm run verify:phase-05
npm run verify:package:mac
git diff --check
```

Expected: Node, Vitest, lint, both Vite builds, Rust, Playwright, serial, four TCP scenarios, and four UDP scenarios pass; all acceptance tools report `managedChildren=0`; the four-DMG verifier still passes against artifacts built from the same source revision.

- [ ] **Step 6: Confirm final repository and process state**

Run `git status --short` and a targeted process scan for repository Electron, Tauri, Cargo, Vite, Playwright, and package executables.

Expected: only `README.md` and `docs/verification/macos-multi-architecture-packages.md` are pending; no process started by this package verification remains. Do not terminate pre-existing long-lived virtual serial laboratories.

- [ ] **Step 7: Commit the verified release evidence**

```bash
git add README.md docs/verification/macos-multi-architecture-packages.md
git commit -m "docs: verify multi-architecture macOS packages"
```

- [ ] **Step 8: Verify final clean state**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: status is empty and the packaging configuration, Tauri verifier, Electron verifier, aggregate collector/verifier, and verification evidence commits are present.
