import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_ARTIFACT_ROOT,
  verifyMacPackages,
} from './verify-macos-packages.mjs';

const execFileAsync = promisify(execFile);
const MATRIX = Object.freeze([
  Object.freeze(['electron', 'arm64']),
  Object.freeze(['electron', 'x64']),
  Object.freeze(['tauri', 'arm64']),
  Object.freeze(['tauri', 'x64']),
]);
const EXPECTED_NAMES = Object.freeze([
  'Ineed LinkLab-Electron_0.1.0_arm64.dmg',
  'Ineed LinkLab-Electron_0.1.0_x64.dmg',
  'Ineed LinkLab-Tauri_0.1.0_arm64.dmg',
  'Ineed LinkLab-Tauri_0.1.0_x64.dmg',
]);
const SOURCE_NAMES = Object.freeze([
  EXPECTED_NAMES[0],
  EXPECTED_NAMES[1],
  'Ineed LinkLab_0.1.0_aarch64.dmg',
  'Ineed LinkLab_0.1.0_x64.dmg',
]);
const PUBLIC_RECORD_KEYS = Object.freeze([
  'runtime',
  'architecture',
  'appPath',
  'sourceDmgPath',
  'collectedDmgPath',
  'sha256',
  'signing',
]);
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createMatrixFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mac-package-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts', 'macos');
  const electronResults = [];
  const tauriResults = [];
  const records = [];
  await mkdir(artifactRoot, { recursive: true });
  const canonicalArtifactRoot = await realpath(artifactRoot);

  for (const [index, [runtime, architecture]] of MATRIX.entries()) {
    const packageRoot = path.join(root, 'packages', runtime, architecture);
    const appPath = path.join(packageRoot, 'Ineed LinkLab.app');
    const sourceDmgPath = path.join(packageRoot, SOURCE_NAMES[index]);
    const collectedDmgPath = path.join(canonicalArtifactRoot, EXPECTED_NAMES[index]);
    const content = Buffer.from(`${runtime}:${architecture}:real checksum fixture`);
    const signing = architecture === 'arm64' ? 'unsigned' : 'developer-id';
    await mkdir(appPath, { recursive: true });
    await Promise.all([
      writeFile(sourceDmgPath, content),
      writeFile(collectedDmgPath, content),
    ]);
    const verifierResult = {
      appPath,
      dmgPath: sourceDmgPath,
      architecture,
      signing,
      internalBindingEvidence: {
        sidecarManifestSha256: sha256(`${runtime}:${architecture}:app manifest`),
        mountedManifestSha256: sha256(`${runtime}:${architecture}:app manifest`),
      },
      ...(runtime === 'electron'
        ? {
            bundleIdentifier: 'com.ineedfull.dev-tool.electron',
            rendererAssets: ['.css', '.html', '.js'],
            nativeModules: [path.join(appPath, 'Contents', 'Resources', 'bindings.node')],
          }
        : { embeddedAssetExtensions: ['.css', '.html', '.js'] }),
    };
    (runtime === 'electron' ? electronResults : tauriResults).push(verifierResult);
    records.push({
      runtime,
      architecture,
      appPath,
      sourceDmgPath,
      collectedDmgPath,
      sha256: sha256(content),
      signing,
    });
  }

  return {
    root,
    artifactRoot,
    electronResults,
    tauriResults,
    records,
    options: { artifactRoot, electronResults, tauriResults },
  };
}

function cloneResults(results) {
  return results.map((result) => ({
    ...result,
    rendererAssets: result.rendererAssets && [...result.rendererAssets],
    nativeModules: result.nativeModules && [...result.nativeModules],
    embeddedAssetExtensions: result.embeddedAssetExtensions
      && [...result.embeddedAssetExtensions],
  }));
}

test('exports the repository artifact root', () => {
  assert.equal(
    DEFAULT_ARTIFACT_ROOT,
    fileURLToPath(new URL('../artifacts/macos', import.meta.url)),
  );
});

test('verifies all four collected DMGs by SHA-256 in exact matrix order', async (t) => {
  const fixture = await createMatrixFixture(t);

  const result = await verifyMacPackages(fixture.options);

  assert.deepEqual(result, fixture.records);
  assert.deepEqual(result.map(({ runtime, architecture }) => `${runtime}:${architecture}`), [
    'electron:arm64',
    'electron:x64',
    'tauri:arm64',
    'tauri:x64',
  ]);
  for (const record of result) {
    assert.deepEqual(Object.keys(record), PUBLIC_RECORD_KEYS);
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
  }
});

test('rejects a missing runtime and architecture pair', async (t) => {
  const fixture = await createMatrixFixture(t);
  fixture.tauriResults.pop();

  await assert.rejects(verifyMacPackages(fixture.options), /exactly four|missing.*tauri:x64/i);
});

test('rejects a duplicate runtime and architecture pair', async (t) => {
  const fixture = await createMatrixFixture(t);
  fixture.electronResults.push({ ...fixture.electronResults[0] });

  await assert.rejects(verifyMacPackages(fixture.options), /duplicate.*electron:arm64/i);
});

test('rejects an unsupported runtime and architecture pair', async (t) => {
  const fixture = await createMatrixFixture(t);
  fixture.tauriResults[1].architecture = 'ppc64';

  await assert.rejects(verifyMacPackages(fixture.options), /unsupported.*tauri:ppc64/i);
});

test('rejects verifier results with invalid signing or path fields', async (t) => {
  const fixture = await createMatrixFixture(t);
  const cases = [
    ['signing', 'adhoc', /signing.*unsigned.*developer-id/i],
    ['appPath', 'relative.app', /appPath.*absolute/i],
    ['dmgPath', 'relative.dmg', /dmgPath.*absolute/i],
  ];

  for (const [field, value, expectedError] of cases) {
    const electronResults = cloneResults(fixture.electronResults);
    electronResults[0][field] = value;
    await assert.rejects(
      verifyMacPackages({ ...fixture.options, electronResults }),
      expectedError,
    );
  }
});

test('rejects an unexpected collected DMG filename', async (t) => {
  const fixture = await createMatrixFixture(t);
  await rename(
    fixture.records[0].collectedDmgPath,
    path.join(fixture.artifactRoot, 'unexpected-name.dmg'),
  );

  await assert.rejects(verifyMacPackages(fixture.options), /unexpected-name\.dmg|expected.*DMG/i);
});

test('rejects a collected DMG symlink', async (t) => {
  const fixture = await createMatrixFixture(t);
  const record = fixture.records[0];
  await rm(record.collectedDmgPath);
  await symlink(record.sourceDmgPath, record.collectedDmgPath);

  await assert.rejects(verifyMacPackages(fixture.options), /collected.*symbolic link/i);
});

test('rejects a collected DMG hard-linked to its source', async (t) => {
  const fixture = await createMatrixFixture(t);
  const record = fixture.records[0];
  await rm(record.collectedDmgPath);
  await link(record.sourceDmgPath, record.collectedDmgPath);

  await assert.rejects(
    verifyMacPackages(fixture.options),
    /matrix.*identity|identity.*source.*collected/i,
  );
});

test('rejects collected DMGs hard-linked to each other', async (t) => {
  const fixture = await createMatrixFixture(t);
  const [firstRecord, secondRecord] = fixture.records;
  await rm(secondRecord.collectedDmgPath);
  await link(firstRecord.collectedDmgPath, secondRecord.collectedDmgPath);

  await assert.rejects(
    verifyMacPackages(fixture.options),
    /matrix.*identity|identity.*collected/i,
  );
});

test('rejects a stale fifth collected DMG', async (t) => {
  const fixture = await createMatrixFixture(t);
  await writeFile(path.join(fixture.artifactRoot, 'stale-fifth.dmg'), 'stale');

  await assert.rejects(verifyMacPackages(fixture.options), /unexpected.*stale-fifth\.dmg/i);
});

test('rejects stale collector-owned stage and backup files', async (t) => {
  const fixture = await createMatrixFixture(t);
  for (const suffix of ['stage', 'backup']) {
    const stalePath = path.join(
      fixture.artifactRoot,
      `.ineed-dmg-collection-stale-0-${suffix}`,
    );
    await writeFile(stalePath, 'stale transaction artifact');
    await assert.rejects(
      verifyMacPackages(fixture.options),
      /stale collector-owned.*(?:stage|backup)/i,
    );
    await rm(stalePath);
  }
});

test('returns canonical collected paths through a symlinked artifact ancestor', async (t) => {
  const fixture = await createMatrixFixture(t);
  const lexicalAncestor = path.join(fixture.root, 'artifacts');
  const controlledAncestor = path.join(fixture.root, 'controlled-artifacts');
  await rename(lexicalAncestor, controlledAncestor);
  await symlink(controlledAncestor, lexicalAncestor);
  const canonicalArtifactRoot = path.join(await realpath(controlledAncestor), 'macos');

  const result = await verifyMacPackages(fixture.options);

  assert.deepEqual(
    result.map(({ collectedDmgPath }) => collectedDmgPath),
    EXPECTED_NAMES.map((name) => path.join(canonicalArtifactRoot, name)),
  );
  assert.deepEqual((await readdir(canonicalArtifactRoot)).sort(), [...EXPECTED_NAMES]);
});

test('rejects a source and collected checksum mismatch', async (t) => {
  const fixture = await createMatrixFixture(t);
  await writeFile(fixture.records[2].collectedDmgPath, 'one byte is different');

  await assert.rejects(
    verifyMacPackages(fixture.options),
    /checksum.*tauri:arm64|tauri:arm64.*checksum/i,
  );
});

async function createCliRepository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mac-package-matrix-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptsDirectory = path.join(root, 'scripts');
  const scriptPath = path.join(scriptsDirectory, 'verify-macos-packages.mjs');
  const invocationPath = path.join(root, 'verify-link.mjs');
  const artifactRoot = path.join(root, 'artifacts', 'macos');
  const results = { electron: [], tauri: [] };
  await Promise.all([
    mkdir(scriptsDirectory, { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(fileURLToPath(new URL('./verify-macos-packages.mjs', import.meta.url)), scriptPath),
    copyFile(
      fileURLToPath(new URL('./macos-package-matrix.mjs', import.meta.url)),
      path.join(scriptsDirectory, 'macos-package-matrix.mjs'),
    ),
  ]);
  await symlink(scriptPath, invocationPath);

  for (const [index, [runtime, architecture]] of MATRIX.entries()) {
    const packageRoot = path.join(root, 'packages', runtime, architecture);
    const appPath = path.join(packageRoot, 'Ineed LinkLab.app');
    const dmgPath = path.join(packageRoot, SOURCE_NAMES[index]);
    const content = `cli:${runtime}:${architecture}`;
    await mkdir(appPath, { recursive: true });
    await Promise.all([
      writeFile(dmgPath, content),
      writeFile(path.join(artifactRoot, EXPECTED_NAMES[index]), content),
    ]);
    results[runtime].push({
      appPath,
      dmgPath,
      architecture,
      signing: 'unsigned',
    });
  }

  await writeFile(
    path.join(scriptsDirectory, 'verify-electron-macos-package.mjs'),
    `const results = ${JSON.stringify(results.electron)};\n`
      + 'export async function verifyElectronMacPackage({ architecture }) {\n'
      + '  return results.find((result) => result.architecture === architecture);\n'
      + '}\n',
  );
  await writeFile(
    path.join(scriptsDirectory, 'verify-tauri-macos-package.mjs'),
    `const results = ${JSON.stringify(results.tauri)};\n`
      + 'export async function verifyTauriMacPackage({ architecture }) {\n'
      + "  if (process.env.FAIL_TAURI_X64 === '1' && architecture === 'x64') {\n"
      + "    throw new Error('simulated Tauri x64 verifier failure');\n"
      + '  }\n'
      + '  return results.find((result) => result.architecture === architecture);\n'
      + '}\n',
  );
  return { invocationPath };
}

test('direct symlink invocation prints one matrix result and no partial result on failure', async (t) => {
  const fixture = await createCliRepository(t);

  const success = await execFileAsync(process.execPath, [fixture.invocationPath], {
    encoding: 'utf8',
  });
  const lines = success.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^MAC_PACKAGE_MATRIX_RESULT=/);
  assert.deepEqual(
    JSON.parse(lines[0].slice('MAC_PACKAGE_MATRIX_RESULT='.length))
      .map(({ runtime, architecture }) => `${runtime}:${architecture}`),
    MATRIX.map(([runtime, architecture]) => `${runtime}:${architecture}`),
  );

  await assert.rejects(
    execFileAsync(process.execPath, [fixture.invocationPath], {
      encoding: 'utf8',
      env: { ...process.env, FAIL_TAURI_X64: '1' },
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.equal(error.stdout, '');
      assert.doesNotMatch(error.stdout, /MAC_PACKAGE_MATRIX_RESULT=/);
      assert.match(error.stderr, /simulated Tauri x64 verifier failure/);
      return true;
    },
  );
});
