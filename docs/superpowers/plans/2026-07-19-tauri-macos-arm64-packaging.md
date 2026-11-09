# Tauri macOS arm64 Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify unsigned local macOS arm64 `.app` and `.dmg` artifacts from the production Tauri runtime.

**Architecture:** Tauri's official bundler owns application and DMG creation. A repository Node verifier inspects bundle structure and macOS metadata through structured filesystem and command APIs, while a real packaged-app smoke test proves the renderer assets embedded by Tauri load without Vite.

**Tech Stack:** Tauri CLI 2.11.4, Rust `aarch64-apple-darwin`, Node.js test runner, macOS `plutil`, `file`, and `codesign`.

---

## File Structure

- Modify `apps/tauri/src-tauri/tauri.conf.json`: enable official app and DMG bundle targets.
- Modify `package.json`: expose package and artifact-verification entry points.
- Modify `apps/tauri/tests/tauriBoundary.test.js`: lock packaging configuration and scripts.
- Create `scripts/verify-tauri-macos-package.mjs`: inspect real Tauri macOS artifacts.
- Create `scripts/verify-tauri-macos-package.test.mjs`: verify success and failure behavior with isolated fixtures.
- Modify `README.md`: document local unsigned packaging commands and limitations.
- Create `docs/verification/tauri-macos-arm64-package.md`: record the real package and smoke-test evidence.

### Task 1: Enable The Official Tauri macOS Bundle

**Files:**
- Modify: `apps/tauri/tests/tauriBoundary.test.js`
- Modify: `apps/tauri/src-tauri/tauri.conf.json`
- Modify: `package.json`

- [ ] **Step 1: Write the failing packaging contract**

Add this test after the existing Vite/Tauri configuration test:

```js
test('macOS arm64 packaging uses the official Tauri app and DMG targets', async () => {
  const [config, rootManifest] = await Promise.all([
    read('src-tauri/tauri.conf.json').then(JSON.parse),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ['app', 'dmg']);
  assert.equal(
    rootManifest.scripts['package:mac'],
    'npm run tauri:build -w @ineed-dev-tool/tauri -- --target aarch64-apple-darwin --bundles app,dmg --no-sign --ci',
  );
  assert.equal(
    rootManifest.scripts['verify:package:mac'],
    'node scripts/verify-tauri-macos-package.mjs',
  );
});
```

Remove the obsolete `assert.equal(config.bundle.active, false)` assertion from the preceding configuration test.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test apps/tauri/tests/tauriBoundary.test.js`

Expected: FAIL because `bundle.active` is `false`, `bundle.targets` is absent, and both root scripts are absent.

- [ ] **Step 3: Enable bundling and add root commands**

Change the Tauri bundle block to:

```json
"bundle": {
  "active": true,
  "targets": ["app", "dmg"],
  "icon": ["icons/icon.png"]
}
```

Add these root scripts without changing the existing phase gates:

```json
"package:mac": "npm run tauri:build -w @ineed-dev-tool/tauri -- --target aarch64-apple-darwin --bundles app,dmg --no-sign --ci",
"verify:package:mac": "node scripts/verify-tauri-macos-package.mjs"
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test apps/tauri/tests/tauriBoundary.test.js`

Expected: PASS with no failed subtests.

- [ ] **Step 5: Commit the packaging contract**

```bash
git add package.json apps/tauri/src-tauri/tauri.conf.json apps/tauri/tests/tauriBoundary.test.js
git commit -m "build: enable Tauri macOS arm64 packaging"
```

### Task 2: Add A Deterministic macOS Artifact Verifier

**Files:**
- Create: `scripts/verify-tauri-macos-package.test.mjs`
- Create: `scripts/verify-tauri-macos-package.mjs`

- [ ] **Step 1: Write failing verifier behavior tests**

Create `scripts/verify-tauri-macos-package.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let verifyTauriMacPackage;
try {
  ({ verifyTauriMacPackage } = await import('./verify-tauri-macos-package.mjs'));
} catch {
  verifyTauriMacPackage = undefined;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ineed-mac-package-'));
  const bundleRoot = path.join(root, 'release', 'bundle');
  const appPath = path.join(bundleRoot, 'macos', 'Ineed DevTool.app');
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'ineed-dev-tool-tauri');
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const dmgPath = path.join(bundleRoot, 'dmg', 'Ineed DevTool_0.1.0_aarch64.dmg');
  const assetsPath = path.join(
    root,
    'release',
    'build',
    'ineed-dev-tool-tauri-fixture',
    'out',
    'tauri-codegen-assets',
  );
  await Promise.all([
    mkdir(path.dirname(executablePath), { recursive: true }),
    mkdir(resourcesPath, { recursive: true }),
    mkdir(path.dirname(dmgPath), { recursive: true }),
    mkdir(assetsPath, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(appPath, 'Contents', 'Info.plist'), 'fixture'),
    writeFile(executablePath, 'binary'),
    writeFile(path.join(resourcesPath, 'icon.icns'), 'icon'),
    writeFile(dmgPath, 'dmg'),
    writeFile(path.join(assetsPath, 'index.html'), '<div id="app"></div>'),
    writeFile(path.join(assetsPath, 'index.js'), 'globalThis.__fixture = true;'),
    writeFile(path.join(assetsPath, 'index.css'), ':root { color: black; }'),
  ]);
  return { root, bundleRoot, appPath, executablePath, dmgPath };
}

function commandFixture({ executablePath, architecture = 'arm64' }) {
  const info = {
    CFBundleIdentifier: 'com.ineedfull.dev-tool',
    CFBundleShortVersionString: '0.1.0',
    CFBundleDisplayName: 'Ineed DevTool',
    CFBundleExecutable: path.basename(executablePath),
    CFBundleIconFile: 'icon.icns',
  };
  return async (command) => {
    if (command === 'plutil') return { stdout: JSON.stringify(info), stderr: '' };
    if (command === 'file') {
      return { stdout: `${executablePath}: Mach-O 64-bit executable ${architecture}`, stderr: '' };
    }
    if (command === 'codesign') return { stdout: '', stderr: 'Signature=adhoc\n' };
    throw new Error(`unexpected command: ${command}`);
  };
}

test('macOS package verifier accepts one complete unsigned arm64 app and DMG', async (t) => {
  assert.equal(typeof verifyTauriMacPackage, 'function');
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await verifyTauriMacPackage({
    bundleRoot: fixture.bundleRoot,
    execute: commandFixture(fixture),
  });

  assert.equal(result.appPath, fixture.appPath);
  assert.equal(result.dmgPath, fixture.dmgPath);
  assert.equal(result.architecture, 'arm64');
  assert.equal(result.signing, 'unsigned');
  assert.deepEqual(result.embeddedAssetExtensions, ['.css', '.html', '.js']);
});

test('macOS package verifier rejects an Intel-only executable', async (t) => {
  assert.equal(typeof verifyTauriMacPackage, 'function');
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    verifyTauriMacPackage({
      bundleRoot: fixture.bundleRoot,
      execute: commandFixture({ ...fixture, architecture: 'x86_64' }),
    }),
    /must include arm64/,
  );
});
```

- [ ] **Step 2: Run the verifier tests and verify RED**

Run: `node --test scripts/verify-tauri-macos-package.test.mjs`

Expected: two assertion failures because `verifyTauriMacPackage` is `undefined`.

- [ ] **Step 3: Implement the verifier**

Create `scripts/verify-tauri-macos-package.mjs`:

```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BUNDLE_ROOT = path.join(
  repositoryRoot,
  'apps',
  'tauri',
  'src-tauri',
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
);

async function defaultExecute(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8' });
}

async function oneEntry(directory, predicate, label) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(predicate);
  assert.equal(entries.length, 1, `${label} must contain exactly one matching artifact`);
  return path.join(directory, entries[0].name);
}

async function requireNonemptyFile(filePath, label) {
  const metadata = await stat(filePath);
  assert.equal(metadata.isFile(), true, `${label} must be a file: ${filePath}`);
  assert.ok(metadata.size > 0, `${label} must not be empty: ${filePath}`);
}

async function embeddedAssetExtensions(bundleRoot) {
  const releaseRoot = path.resolve(bundleRoot, '..');
  const buildRoot = path.join(releaseRoot, 'build');
  const builds = await readdir(buildRoot, { withFileTypes: true });
  const extensions = new Set();
  for (const build of builds.filter((entry) => entry.isDirectory())) {
    const assets = path.join(buildRoot, build.name, 'out', 'tauri-codegen-assets');
    try {
      for (const entry of await readdir(assets, { withFileTypes: true })) {
        if (entry.isFile()) extensions.add(path.extname(entry.name));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const result = [...extensions].filter(Boolean).sort();
  for (const extension of ['.css', '.html', '.js']) {
    assert.ok(result.includes(extension), `embedded Tauri assets must include ${extension}`);
  }
  return result;
}

export async function verifyTauriMacPackage({
  bundleRoot = DEFAULT_BUNDLE_ROOT,
  execute = defaultExecute,
} = {}) {
  const appPath = await oneEntry(
    path.join(bundleRoot, 'macos'),
    (entry) => entry.isDirectory() && entry.name === 'Ineed DevTool.app',
    'macOS app directory',
  );
  const dmgPath = await oneEntry(
    path.join(bundleRoot, 'dmg'),
    (entry) => entry.isFile() && entry.name.endsWith('.dmg'),
    'DMG directory',
  );
  await requireNonemptyFile(dmgPath, 'DMG');

  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  await requireNonemptyFile(plistPath, 'Info.plist');
  const plistResult = await execute('plutil', ['-convert', 'json', '-o', '-', plistPath]);
  const info = JSON.parse(plistResult.stdout);
  assert.equal(info.CFBundleIdentifier, 'com.ineedfull.dev-tool');
  assert.equal(info.CFBundleShortVersionString, '0.1.0');
  assert.equal(info.CFBundleDisplayName ?? info.CFBundleName, 'Ineed DevTool');
  assert.equal(typeof info.CFBundleExecutable, 'string');
  assert.ok(info.CFBundleExecutable.trim());
  assert.equal(typeof info.CFBundleIconFile, 'string');
  assert.ok(info.CFBundleIconFile.trim());

  const executablePath = path.join(appPath, 'Contents', 'MacOS', info.CFBundleExecutable);
  await requireNonemptyFile(executablePath, 'application executable');
  const architectureResult = await execute('file', [executablePath]);
  assert.match(architectureResult.stdout, /\barm64\b/, 'application executable must include arm64');

  const iconName = path.extname(info.CFBundleIconFile)
    ? info.CFBundleIconFile
    : `${info.CFBundleIconFile}.icns`;
  await requireNonemptyFile(
    path.join(appPath, 'Contents', 'Resources', iconName),
    'application icon',
  );

  let signing = 'unsigned';
  try {
    const signature = await execute('codesign', ['-dv', '--verbose=4', appPath]);
    const details = `${signature.stdout ?? ''}\n${signature.stderr ?? ''}`;
    if (/^Authority=/m.test(details)) signing = 'developer-id';
  } catch (error) {
    const details = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
    if (!/not signed|code object is not signed/i.test(details)) throw error;
  }

  return {
    appPath,
    dmgPath,
    architecture: 'arm64',
    signing,
    embeddedAssetExtensions: await embeddedAssetExtensions(bundleRoot),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  verifyTauriMacPackage()
    .then((result) => process.stdout.write(`TAURI_MAC_PACKAGE_RESULT=${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Run verifier tests and verify GREEN**

Run: `node --test scripts/verify-tauri-macos-package.test.mjs`

Expected: 2 tests passed, 0 failed.

- [ ] **Step 5: Run the root fast test gate**

Run: `npm test`

Expected: all Node and Vitest tests pass, including both new verifier tests.

- [ ] **Step 6: Commit the artifact verifier**

```bash
git add scripts/verify-tauri-macos-package.mjs scripts/verify-tauri-macos-package.test.mjs
git commit -m "test: verify Tauri macOS package artifacts"
```

### Task 3: Build And Validate The Real Package

**Files:**
- Modify: `README.md`
- Create: `docs/verification/tauri-macos-arm64-package.md`

- [ ] **Step 1: Confirm the target and build the package**

Run: `rustup target list --installed`

Expected: output contains `aarch64-apple-darwin`.

Run: `npm run package:mac`

Expected: exit 0 and Tauri reports one application bundle plus one DMG under `apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle/`.

- [ ] **Step 2: Verify the real artifacts**

Run: `npm run verify:package:mac`

Expected: exit 0 and one `TAURI_MAC_PACKAGE_RESULT` line with absolute `.app` and `.dmg` paths, `architecture: "arm64"`, no Developer ID claim without an authority, and embedded `.css`, `.html`, and `.js` assets.

- [ ] **Step 3: Launch the packaged application**

Launch the exact `appPath` returned by the verifier directly, without copying it to `/Applications` and without starting Vite. Use Computer Use to inspect the native window.

Expected UI evidence:

- title `Ineed DevTool` and runtime `tauri`;
- nonblank production workbench;
- persisted endpoint list;
- endpoint filtering and sidebar collapse/expand;
- settings, about, and history surfaces;
- serial, TCP client/server, and UDP client/server form fields;
- invalid endpoint input blocked without persistence changes.

Close the application after inspection. Confirm no process whose executable path is inside the generated `Ineed DevTool.app` remains.

- [ ] **Step 4: Document the local unsigned release**

Add this section to `README.md` after Phase Commands:

````markdown
## Local macOS arm64 package

```sh
npm run package:mac
npm run verify:package:mac
```

These commands produce and verify the Tauri `.app` and `.dmg` under the
`aarch64-apple-darwin` release target. The artifacts are local and unsigned;
they are not notarized or intended for public distribution.
````

Create `docs/verification/tauri-macos-arm64-package.md` with the source commit,
tool versions, exact commands, artifact paths and sizes, `Info.plist` values,
architecture output, signing status, packaged UI smoke evidence, Phase 05 gate
counts, and cleanup result observed during this execution.

- [ ] **Step 5: Run the complete verification gate**

Run: `npm run verify:phase-05`

Expected: exit 0 with all Node, Vitest, lint, build, Rust, Playwright, serial, TCP, and UDP checks passing; every transport acceptance result reports `managedChildren: 0`.

Run: `npm run verify:package:mac`

Expected: exit 0 against the previously built artifacts after the full source gate.

- [ ] **Step 6: Confirm cleanup and repository state**

Run: `git diff --check`

Expected: exit 0 with no output.

Run: `git status --short`

Expected: only `README.md` and `docs/verification/tauri-macos-arm64-package.md` are modified/untracked before the documentation commit.

Confirm no repository-owned Vite, Tauri application, Cargo build, or packaging process remains.

- [ ] **Step 7: Commit the verified packaging evidence**

```bash
git add README.md docs/verification/tauri-macos-arm64-package.md
git commit -m "docs: verify Tauri macOS arm64 package"
```

- [ ] **Step 8: Verify final clean state**

Run: `git status --short`

Expected: no output.

Run: `git log -4 --oneline`

Expected: design/plan documentation, packaging configuration, verifier, and package evidence commits are present on `main`.
