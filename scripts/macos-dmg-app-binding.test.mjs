import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  access,
  appendFile,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertAppManifestsEqual,
  createAppManifest,
  inspectMountedDmgApp,
} from './macos-dmg-app-binding.mjs';

const execFileAsync = promisify(execFile);
const MANIFEST_HELPER_PATH = fileURLToPath(
  new URL('./macos-app-manifest.py', import.meta.url),
);
const PYTHON_EXECUTABLE = process.env.PYTHON ?? 'python3';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rootEntry(mode = 0o755) {
  return { path: '.', type: 'directory', mode };
}

function directoryEntry(entryPath, mode = 0o755) {
  return { path: entryPath, type: 'directory', mode };
}

function fileEntry(entryPath, bytes, digest, mode = 0o644) {
  return {
    path: entryPath,
    type: 'file',
    mode,
    bytes,
    sha256: digest,
  };
}

async function createTemporaryRoot(t, prefix = 'macos-dmg-app-binding-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createAppFixture(t, name = 'Ineed LinkLab.app') {
  const root = await createTemporaryRoot(t);
  const appPath = path.join(root, name);
  await mkdir(path.join(appPath, 'Contents', 'empty'), { recursive: true });
  await writeFile(path.join(appPath, 'Contents', 'payload.txt'), 'same payload');
  await writeFile(path.join(appPath, 'root.txt'), 'root file');
  await symlink(
    'payload.txt',
    path.join(appPath, 'Contents', 'payload-link'),
  );
  await Promise.all([
    chmod(appPath, 0o755),
    chmod(path.join(appPath, 'Contents'), 0o755),
    chmod(path.join(appPath, 'Contents', 'empty'), 0o755),
    chmod(path.join(appPath, 'Contents', 'payload.txt'), 0o644),
    chmod(path.join(appPath, 'root.txt'), 0o644),
  ]);
  return { root, appPath };
}

test('creates equal, lexically ordered manifests for matching app trees', async (t) => {
  const first = await createAppFixture(t);
  const second = await createAppFixture(t);

  const expected = await createAppManifest(first.appPath);
  const actual = await createAppManifest(second.appPath);

  assert.deepEqual(expected, [
    rootEntry(),
    directoryEntry('Contents'),
    directoryEntry('Contents/empty'),
    {
      path: 'Contents/payload-link',
      type: 'symlink',
      target: 'payload.txt',
    },
    fileEntry('Contents/payload.txt', 12, sha256('same payload')),
    fileEntry('root.txt', 9, sha256('root file')),
  ]);
  assert.doesNotThrow(() => assertAppManifestsEqual(expected, actual, 'fixture apps'));
});

async function createModeComparisonFixture(t) {
  const root = await createTemporaryRoot(t, 'manifest-mode-');
  const sidecarAppPath = path.join(root, 'sidecar', 'Ineed LinkLab.app');
  const mountedAppPath = path.join(root, 'mounted', 'Ineed LinkLab.app');
  const helperRelativePath = path.join('Contents', 'Helpers', 'runtime-helper');
  await mkdir(path.join(sidecarAppPath, 'Contents', 'Helpers'), {
    recursive: true,
    mode: 0o755,
  });
  await writeFile(path.join(sidecarAppPath, helperRelativePath), 'helper executable');
  await Promise.all([
    chmod(sidecarAppPath, 0o755),
    chmod(path.join(sidecarAppPath, 'Contents', 'Helpers'), 0o755),
    chmod(path.join(sidecarAppPath, helperRelativePath), 0o755),
  ]);
  await mkdir(path.dirname(mountedAppPath), { recursive: true });
  await cp(sidecarAppPath, mountedAppPath, { recursive: true, verbatimSymlinks: true });
  return { sidecarAppPath, mountedAppPath, helperRelativePath };
}

test('reports a regular-file mode difference before certifying matching bytes', async (t) => {
  const fixture = await createModeComparisonFixture(t);
  await chmod(path.join(fixture.mountedAppPath, fixture.helperRelativePath), 0o644);
  const expected = await createAppManifest(fixture.sidecarAppPath);
  const actual = await createAppManifest(fixture.mountedAppPath);

  assert.throws(
    () => assertAppManifestsEqual(expected, actual, 'mounted versus sidecar'),
    /mounted versus sidecar.*Contents\/Helpers\/runtime-helper.*mode difference/i,
  );
});

test('reports a directory mode difference', async (t) => {
  const fixture = await createModeComparisonFixture(t);
  await chmod(path.join(fixture.mountedAppPath, 'Contents', 'Helpers'), 0o700);
  const expected = await createAppManifest(fixture.sidecarAppPath);
  const actual = await createAppManifest(fixture.mountedAppPath);

  assert.throws(
    () => assertAppManifestsEqual(expected, actual, 'mounted versus sidecar'),
    /mounted versus sidecar.*Contents\/Helpers.*mode difference/i,
  );
});

test('reports an app root mode difference at the deterministic root path', async (t) => {
  const fixture = await createModeComparisonFixture(t);
  await chmod(fixture.mountedAppPath, 0o700);
  const expected = await createAppManifest(fixture.sidecarAppPath);
  const actual = await createAppManifest(fixture.mountedAppPath);

  assert.throws(
    () => assertAppManifestsEqual(expected, actual, 'mounted versus sidecar'),
    /mounted versus sidecar.*\.: mode difference/i,
  );
});

test('ignores inherited Python module paths when hashing app files', async (t) => {
  const fixture = await createAppFixture(t);
  const maliciousModules = await createTemporaryRoot(t, 'manifest-pythonpath-');
  await writeFile(path.join(maliciousModules, 'hashlib.py'), [
    'class FakeDigest:',
    '    def update(self, value):',
    '        pass',
    '    def hexdigest(self):',
    '        return "0" * 64',
    'def sha256():',
    '    return FakeDigest()',
    '',
  ].join('\n'));
  const previousPythonPath = process.env.PYTHONPATH;
  process.env.PYTHONPATH = maliciousModules;
  t.after(() => {
    if (previousPythonPath === undefined) {
      delete process.env.PYTHONPATH;
    } else {
      process.env.PYTHONPATH = previousPythonPath;
    }
  });

  const manifest = await createAppManifest(fixture.appPath);
  const rootFile = manifest.find((entry) => entry.path === 'root.txt');

  assert.equal(rootFile.sha256, sha256('root file'));
});

test('orders the complete manifest by POSIX relative path', async (t) => {
  const root = await createTemporaryRoot(t);
  const appPath = path.join(root, 'Ineed LinkLab.app');
  await mkdir(path.join(appPath, 'a'), { recursive: true });
  await writeFile(path.join(appPath, 'a', 'z.txt'), 'nested');
  await writeFile(path.join(appPath, 'a.txt'), 'sibling');

  const manifest = await createAppManifest(appPath);

  assert.deepEqual(manifest.map((entry) => entry.path), [
    '.',
    'a',
    'a.txt',
    'a/z.txt',
  ]);
});

test('reports the first missing manifest entry', () => {
  const expected = [
    rootEntry(),
    fileEntry('a.txt', 1, sha256('a')),
    fileEntry('z.txt', 1, sha256('z')),
  ];
  const actual = [rootEntry()];

  assert.throws(
    () => assertAppManifestsEqual(expected, actual, 'mounted versus sidecar'),
    /mounted versus sidecar.*a\.txt.*missing/i,
  );
});

test('reports the first unexpected manifest entry', () => {
  const expected = [rootEntry()];
  const actual = [
    rootEntry(),
    fileEntry('a.txt', 1, sha256('a')),
    fileEntry('z.txt', 1, sha256('z')),
  ];

  assert.throws(
    () => assertAppManifestsEqual(expected, actual, 'mounted versus sidecar'),
    /mounted versus sidecar.*a\.txt.*unexpected/i,
  );
});

test('reports a file-to-directory type difference', () => {
  const expected = [
    rootEntry(),
    fileEntry('Contents/payload', 7, sha256('payload')),
  ];
  const actual = [rootEntry(), directoryEntry('Contents/payload')];

  assert.throws(
    () => assertAppManifestsEqual(expected, actual, 'mounted versus sidecar'),
    /mounted versus sidecar.*Contents\/payload.*type/i,
  );
});

test('reports a symbolic-link target difference', () => {
  const expected = [rootEntry(), { path: 'current', type: 'symlink', target: 'one' }];
  const actual = [rootEntry(), { path: 'current', type: 'symlink', target: 'two' }];

  assert.throws(
    () => assertAppManifestsEqual(expected, actual, 'mounted versus sidecar'),
    /mounted versus sidecar.*current.*link target/i,
  );
});

test('reports byte size before SHA-256 for differing regular files', () => {
  const expected = [rootEntry(), fileEntry('payload', 3, sha256('one'))];
  const differentSize = [rootEntry(), fileEntry('payload', 4, sha256('four'))];
  const differentHash = [rootEntry(), fileEntry('payload', 3, sha256('two'))];

  assert.throws(
    () => assertAppManifestsEqual(expected, differentSize, 'mounted versus sidecar'),
    /mounted versus sidecar.*payload.*byte size/i,
  );
  assert.throws(
    () => assertAppManifestsEqual(expected, differentHash, 'mounted versus sidecar'),
    /mounted versus sidecar.*payload.*SHA-256/i,
  );
});

test('rejects non-array, unsafe, and duplicate manifest paths before comparison', () => {
  assert.throws(
    () => assertAppManifestsEqual(null, [rootEntry()], 'schema check'),
    /expected manifest.*array/i,
  );
  for (const unsafePath of ['', '/absolute', '../escape', 'a/../escape', 'a\\windows']) {
    assert.throws(
      () => assertAppManifestsEqual(
        [rootEntry(), directoryEntry(unsafePath)],
        [rootEntry()],
        'schema check',
      ),
      /expected manifest.*safe relative POSIX path/i,
    );
  }
  assert.doesNotThrow(
    () => assertAppManifestsEqual([rootEntry()], [rootEntry()], 'schema check'),
  );
  assert.throws(
    () => assertAppManifestsEqual(
      [rootEntry(), directoryEntry('same'), directoryEntry('same')],
      [rootEntry()],
      'schema check',
    ),
    /expected manifest.*duplicate.*same/i,
  );
});

test('requires exactly one directory root entry in each manifest', () => {
  assert.throws(
    () => assertAppManifestsEqual([directoryEntry('Contents')], [rootEntry()], 'schema check'),
    /expected manifest.*root directory entry/i,
  );
  assert.throws(
    () => assertAppManifestsEqual(
      [fileEntry('.', 0, sha256(''))],
      [rootEntry()],
      'schema check',
    ),
    /expected manifest.*root entry.*directory/i,
  );
  assert.throws(
    () => assertAppManifestsEqual(
      [{ path: '.', type: 'symlink', target: 'Contents' }],
      [rootEntry()],
      'schema check',
    ),
    /expected manifest.*root entry.*directory/i,
  );
});

test('rejects unknown manifest types, fields, and invalid metadata', () => {
  assert.throws(
    () => assertAppManifestsEqual(
      [rootEntry(), { path: 'entry', type: 'device' }],
      [rootEntry()],
      'schema check',
    ),
    /expected manifest.*type/i,
  );
  assert.throws(
    () => assertAppManifestsEqual([
      rootEntry(),
      { ...directoryEntry('entry'), extra: true },
    ], [rootEntry()], 'schema check'),
    /expected manifest.*exact fields/i,
  );
  assert.throws(
    () => assertAppManifestsEqual([
      rootEntry(),
      { path: 'entry', type: 'symlink', target: 42 },
    ], [rootEntry()], 'schema check'),
    /expected manifest.*target/i,
  );
  for (const mode of [-1, 1.5, 0o10000, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertAppManifestsEqual([rootEntry(mode)], [rootEntry()], 'schema check'),
      /expected manifest.*mode/i,
    );
    assert.throws(
      () => assertAppManifestsEqual(
        [rootEntry(), fileEntry('entry', 1, sha256('entry'), mode)],
        [rootEntry()],
        'schema check',
      ),
      /expected manifest.*mode/i,
    );
  }
  for (const bytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertAppManifestsEqual([
        rootEntry(),
        fileEntry('entry', bytes, sha256('entry')),
      ], [rootEntry()], 'schema check'),
      /expected manifest.*bytes/i,
    );
  }
  assert.throws(
    () => assertAppManifestsEqual([
      rootEntry(),
      fileEntry('entry', 1, 'ABC'),
    ], [rootEntry()], 'schema check'),
    /expected manifest.*SHA-256/i,
  );
});

test('rejects missing, symlinked, and non-directory app roots', async (t) => {
  const root = await createTemporaryRoot(t);
  const realApp = path.join(root, 'Real.app');
  const linkedApp = path.join(root, 'Linked.app');
  const fileApp = path.join(root, 'File.app');
  await mkdir(realApp);
  await symlink(realApp, linkedApp);
  await writeFile(fileApp, 'not a directory');

  await assert.rejects(createAppManifest(path.join(root, 'Missing.app')), /app root.*missing/i);
  await assert.rejects(createAppManifest(linkedApp), /app root.*symbolic link/i);
  await assert.rejects(createAppManifest(fileApp), /app root.*directory/i);
});

test('rejects a Unix-domain socket inside an app tree', async (t) => {
  const root = await createTemporaryRoot(t, 'dmg-');
  const appPath = path.join(root, 'A.app');
  const socketPath = path.join(appPath, 's.socket');
  await mkdir(appPath);
  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  await assert.rejects(createAppManifest(appPath), /s\.socket.*socket/i);
});

async function waitForPathOrExit(targetPath, state, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await access(targetPath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    if (state.exitResult) {
      throw new Error(
        `Manifest helper exited before synchronization: ${state.stderr.trim()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for manifest helper synchronization: ${targetPath}`);
}

async function runManifestHelperRace(t, {
  appPath,
  phase,
  relativePath = '',
  mutate,
}) {
  const controlRoot = await createTemporaryRoot(t, 'manifest-helper-control-');
  const readyPath = path.join(controlRoot, 'ready');
  const continuePath = path.join(controlRoot, 'continue');
  const child = spawn(PYTHON_EXECUTABLE, [MANIFEST_HELPER_PATH, appPath], {
    env: {
      ...process.env,
      INEED_TEST_MANIFEST_HOOK_PHASE: phase,
      INEED_TEST_MANIFEST_HOOK_RELATIVE_PATH: relativePath,
      INEED_TEST_MANIFEST_READY_FILE: readyPath,
      INEED_TEST_MANIFEST_CONTINUE_FILE: continuePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { stdout: '', stderr: '', exitResult: undefined };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      state.exitResult = { code, signal };
      resolve(state.exitResult);
    });
  });
  t.after(() => {
    if (!state.exitResult) {
      child.kill();
    }
  });

  await waitForPathOrExit(readyPath, state);
  await mutate();
  await writeFile(continuePath, 'continue');
  let exitTimeout;
  await Promise.race([
    exitPromise,
    new Promise((resolve, reject) => {
      exitTimeout = setTimeout(() => {
        child.kill();
        reject(new Error('Manifest helper did not reject the race promptly'));
      }, 5_000);
    }),
  ]).finally(() => clearTimeout(exitTimeout));
  return state;
}

function assertRaceRejected(state) {
  assert.notEqual(state.exitResult.code, 0);
  assert.equal(state.stdout, '');
  assert.match(state.stderr, /changed|replaced|stable|size|identity/i);
}

test('rejects a nested directory chmod during traversal', async (t) => {
  const root = await createTemporaryRoot(t, 'manifest-directory-mode-race-');
  const appPath = path.join(root, 'Ineed LinkLab.app');
  const contentsPath = path.join(appPath, 'Contents');
  await mkdir(contentsPath, { recursive: true });
  await writeFile(path.join(contentsPath, 'inside.txt'), 'inside');
  await chmod(contentsPath, 0o755);

  const state = await runManifestHelperRace(t, {
    appPath,
    phase: 'after_directory_open',
    relativePath: 'Contents',
    mutate: () => chmod(contentsPath, 0o700),
  });

  assertRaceRejected(state);
});

test('rejects a nested directory swapped to an external symlink during traversal', async (t) => {
  const root = await createTemporaryRoot(t, 'manifest-directory-swap-');
  const appPath = path.join(root, 'Ineed LinkLab.app');
  const contentsPath = path.join(appPath, 'Contents');
  const parkedContentsPath = path.join(root, 'parked-Contents');
  const externalPath = path.join(root, 'external');
  await mkdir(contentsPath, { recursive: true });
  await mkdir(externalPath);
  await writeFile(path.join(contentsPath, 'inside.txt'), 'inside');
  await writeFile(path.join(externalPath, 'outside.txt'), 'outside');

  const state = await runManifestHelperRace(t, {
    appPath,
    phase: 'after_directory_open',
    relativePath: 'Contents',
    mutate: async () => {
      await rename(contentsPath, parkedContentsPath);
      await symlink(externalPath, contentsPath);
    },
  });

  assertRaceRejected(state);
  assert.doesNotMatch(state.stdout, /outside\.txt/);
});

test('rejects an app root chmod after its descriptor is opened', async (t) => {
  const root = await createTemporaryRoot(t, 'manifest-root-mode-race-');
  const appPath = path.join(root, 'Ineed LinkLab.app');
  await mkdir(appPath);
  await writeFile(path.join(appPath, 'inside.txt'), 'inside');
  await chmod(appPath, 0o755);

  const state = await runManifestHelperRace(t, {
    appPath,
    phase: 'after_root_open',
    mutate: () => chmod(appPath, 0o700),
  });

  assertRaceRejected(state);
});

test('rejects an app root swapped after its descriptor is opened', async (t) => {
  const root = await createTemporaryRoot(t, 'manifest-root-swap-');
  const appPath = path.join(root, 'Ineed LinkLab.app');
  const parkedAppPath = path.join(root, 'parked.app');
  const externalPath = path.join(root, 'external.app');
  await mkdir(appPath);
  await mkdir(externalPath);
  await writeFile(path.join(appPath, 'inside.txt'), 'inside');
  await writeFile(path.join(externalPath, 'outside.txt'), 'outside');

  const state = await runManifestHelperRace(t, {
    appPath,
    phase: 'after_root_open',
    mutate: async () => {
      await rename(appPath, parkedAppPath);
      await symlink(externalPath, appPath);
    },
  });

  assertRaceRejected(state);
  assert.doesNotMatch(state.stdout, /outside\.txt/);
});

async function createLargeFileFixture(t) {
  const root = await createTemporaryRoot(t, 'manifest-file-race-');
  const appPath = path.join(root, 'Ineed LinkLab.app');
  const filePath = path.join(appPath, 'payload.bin');
  await mkdir(appPath);
  await writeFile(filePath, Buffer.alloc(256 * 1024, 0x61));
  return { root, appPath, filePath };
}

test('rejects a regular-file chmod during hashing', async (t) => {
  const fixture = await createLargeFileFixture(t);
  await chmod(fixture.filePath, 0o644);
  const state = await runManifestHelperRace(t, {
    appPath: fixture.appPath,
    phase: 'during_file_hash',
    relativePath: 'payload.bin',
    mutate: () => chmod(fixture.filePath, 0o600),
  });

  assertRaceRejected(state);
});

test('rejects a same-size in-place mutation during file hashing', async (t) => {
  const fixture = await createLargeFileFixture(t);
  const state = await runManifestHelperRace(t, {
    appPath: fixture.appPath,
    phase: 'during_file_hash',
    relativePath: 'payload.bin',
    mutate: () => writeFile(fixture.filePath, Buffer.alloc(256 * 1024, 0x62)),
  });

  assertRaceRejected(state);
});

test('rejects truncation during file hashing', async (t) => {
  const fixture = await createLargeFileFixture(t);
  const state = await runManifestHelperRace(t, {
    appPath: fixture.appPath,
    phase: 'during_file_hash',
    relativePath: 'payload.bin',
    mutate: () => truncate(fixture.filePath, 1024),
  });

  assertRaceRejected(state);
});

test('rejects append during file hashing', async (t) => {
  const fixture = await createLargeFileFixture(t);
  const state = await runManifestHelperRace(t, {
    appPath: fixture.appPath,
    phase: 'during_file_hash',
    relativePath: 'payload.bin',
    mutate: () => appendFile(fixture.filePath, 'appended'),
  });

  assertRaceRejected(state);
});

test('rejects pathname replacement while the original file descriptor remains open', async (t) => {
  const fixture = await createLargeFileFixture(t);
  const parkedPath = path.join(fixture.root, 'parked-payload.bin');
  const state = await runManifestHelperRace(t, {
    appPath: fixture.appPath,
    phase: 'after_file_open',
    relativePath: 'payload.bin',
    mutate: async () => {
      await rename(fixture.filePath, parkedPath);
      await writeFile(fixture.filePath, Buffer.alloc(256 * 1024, 0x62));
    },
  });

  assertRaceRejected(state);
});

test('rejects a regular file replaced by an external symlink after opening', async (t) => {
  const fixture = await createLargeFileFixture(t);
  const parkedPath = path.join(fixture.root, 'parked-payload.bin');
  const externalPath = path.join(fixture.root, 'outside.txt');
  await writeFile(externalPath, 'outside content must never be hashed');
  const state = await runManifestHelperRace(t, {
    appPath: fixture.appPath,
    phase: 'after_file_open',
    relativePath: 'payload.bin',
    mutate: async () => {
      await rename(fixture.filePath, parkedPath);
      await symlink(externalPath, fixture.filePath);
    },
  });

  assertRaceRejected(state);
  assert.doesNotMatch(state.stdout, /outside content/);
});

test('rejects a regular file replaced by a FIFO before opening without blocking', async (t) => {
  const fixture = await createLargeFileFixture(t);
  const parkedPath = path.join(fixture.root, 'parked-payload.bin');
  const state = await runManifestHelperRace(t, {
    appPath: fixture.appPath,
    phase: 'before_file_open',
    relativePath: 'payload.bin',
    mutate: async () => {
      await rename(fixture.filePath, parkedPath);
      await execFileAsync('mkfifo', [fixture.filePath], { encoding: 'utf8' });
    },
  });

  assertRaceRejected(state);
});

function command(file, args) {
  return { file, args, options: { encoding: 'utf8' } };
}

function createMountRunner({
  appNames = ['Ineed LinkLab.app'],
  appKind = 'directory',
  device = '/dev/disk99',
  mountPointValue,
  plistOutput,
  detachError,
  events,
  onAttach,
} = {}) {
  const calls = [];
  let mountPoint;
  let canonicalAppPath;
  let attachedDmgPath;
  let attachedDmgContents;
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'hdiutil' && args[0] === 'attach') {
      events?.push('attach');
      mountPoint = args[args.indexOf('-mountpoint') + 1];
      attachedDmgPath = args.at(-1);
      await onAttach?.({ dmgPath: attachedDmgPath, mountPoint });
      attachedDmgContents = await readFile(attachedDmgPath, 'utf8');
      for (const appName of appNames) {
        const appPath = path.join(mountPoint, appName);
        if (appKind === 'symlink') {
          const outsideApp = path.join(path.dirname(mountPoint), `outside-${appName}`);
          await mkdir(path.join(outsideApp, 'Contents'), { recursive: true });
          await symlink(outsideApp, appPath);
        } else {
          await mkdir(path.join(appPath, 'Contents'), { recursive: true });
          await writeFile(path.join(appPath, 'Contents', 'payload.txt'), 'mounted payload');
        }
      }
      if (appNames.length === 1 && appKind === 'directory') {
        canonicalAppPath = await realpath(path.join(mountPoint, appNames[0]));
      }
      return { stdout: '<plist>attached fixture</plist>', stderr: '' };
    }
    if (file === 'plutil') {
      events?.push('plutil');
      assert.equal(
        await readFile(args.at(-1), 'utf8'),
        '<plist>attached fixture</plist>',
      );
      const entityMountPoint = typeof mountPointValue === 'function'
        ? await mountPointValue(mountPoint)
        : mountPointValue ?? mountPoint;
      return {
        stdout: plistOutput ?? JSON.stringify({
          'system-entities': [{
            'mount-point': entityMountPoint,
            'dev-entry': device,
          }],
        }),
        stderr: '',
      };
    }
    if (file === 'hdiutil' && args[0] === 'detach') {
      events?.push('detach');
      if (events && !events.includes('inspect')) {
        throw new Error('detach attempted before inspect');
      }
      if (detachError) {
        throw detachError;
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };
  return {
    execute,
    calls,
    get mountPoint() {
      return mountPoint;
    },
    get canonicalAppPath() {
      return canonicalAppPath;
    },
    get attachedDmgPath() {
      return attachedDmgPath;
    },
    get attachedDmgContents() {
      return attachedDmgContents;
    },
  };
}

async function createMountOptions(t, runner) {
  const root = await createTemporaryRoot(t, 'dmg-mount-test-');
  const temporaryRoot = path.join(root, 'sessions');
  const dmgPath = path.join(root, 'fixture.dmg');
  await mkdir(temporaryRoot);
  await writeFile(dmgPath, 'fixture dmg');
  return {
    root,
    temporaryRoot,
    dmgPath,
    execute: runner.execute,
  };
}

test('attaches, converts, inspects, and detaches in order', async (t) => {
  const events = [];
  const runner = createMountRunner({ events });
  const options = await createMountOptions(t, runner);
  const inspected = [];

  const result = await inspectMountedDmgApp({
    ...options,
    inspect: async (appPath) => {
      events.push('inspect');
      inspected.push(appPath);
      return readFile(path.join(appPath, 'Contents', 'payload.txt'), 'utf8');
    },
  });

  assert.equal(result, 'mounted payload');
  assert.deepEqual(events, ['attach', 'plutil', 'inspect', 'detach']);
  assert.deepEqual(inspected, [runner.canonicalAppPath]);
  assert.notEqual(runner.attachedDmgPath, options.dmgPath);
  assert.equal(runner.attachedDmgPath, path.join(path.dirname(runner.mountPoint), 'source.dmg'));
  assert.equal(runner.attachedDmgContents, 'fixture dmg');
  assert.deepEqual(runner.calls, [
    command('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-plist',
      '-mountpoint',
      runner.mountPoint,
      runner.attachedDmgPath,
    ]),
    command('plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      path.join(path.dirname(runner.mountPoint), 'attach.plist'),
    ]),
    command('hdiutil', ['detach', '/dev/disk99']),
  ]);
  assert.deepEqual(await readdir(options.temporaryRoot), []);
});

test('mounts a pinned stage and rejects source inode replacement during attach', async (t) => {
  let options;
  const runner = createMountRunner({
    onAttach: async () => {
      const parkedPath = path.join(options.root, 'original.dmg');
      await rename(options.dmgPath, parkedPath);
      await writeFile(options.dmgPath, 'replacement dmg');
    },
  });
  options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({
      ...options,
      inspect: async () => 'must not succeed',
    }),
    /source DMG.*(?:changed|identity|inode)/i,
  );

  assert.notEqual(runner.attachedDmgPath, options.dmgPath);
  assert.equal(path.dirname(runner.attachedDmgPath), path.dirname(runner.mountPoint));
  assert.equal(runner.attachedDmgContents, 'fixture dmg');
});

test('rejects a source DMG changed to a symlink during mounted inspection', async (t) => {
  const runner = createMountRunner();
  const options = await createMountOptions(t, runner);
  const parkedPath = path.join(options.root, 'original.dmg');
  const replacementPath = path.join(options.root, 'replacement.dmg');
  await writeFile(replacementPath, 'replacement dmg');

  await assert.rejects(
    inspectMountedDmgApp({
      ...options,
      inspect: async () => {
        await rename(options.dmgPath, parkedPath);
        await symlink(replacementPath, options.dmgPath);
        return 'must not succeed';
      },
    }),
    /source DMG.*(?:changed|symbolic link)/i,
  );

  assert.notEqual(runner.attachedDmgPath, options.dmgPath);
  assert.equal(runner.attachedDmgContents, 'fixture dmg');
});

function createRejectedAttachRunner({ detachError } = {}) {
  const calls = [];
  const attachError = new Error('attach rejected after mounting');
  let mountPoint;
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'hdiutil' && args[0] === 'attach') {
      mountPoint = args[args.indexOf('-mountpoint') + 1];
      await rename(mountPoint, path.join(path.dirname(mountPoint), 'pre-attach-mount'));
      await mkdir(mountPoint);
      throw attachError;
    }
    if (file === 'hdiutil' && args[0] === 'detach') {
      if (detachError) {
        throw detachError;
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };
  return {
    execute,
    calls,
    attachError,
    get mountPoint() {
      return mountPoint;
    },
  };
}

test('detaches the controlled mount point when attach rejects after changing its identity', async (t) => {
  const runner = createRejectedAttachRunner();
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    (error) => error === runner.attachError,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', runner.mountPoint]));
  assert.deepEqual(await readdir(options.temporaryRoot), []);
});

test('aggregates rejected attach and reconciliation detach failures', async (t) => {
  const detachError = new Error('reconciliation detach failed');
  const runner = createRejectedAttachRunner({ detachError });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0], runner.attachError);
      assert.equal(error.errors[1].cause, detachError);
      return true;
    },
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', runner.mountPoint]));
  assert.deepEqual(await readdir(options.temporaryRoot), [path.basename(path.dirname(runner.mountPoint))]);
});

test('preserves primary, reconciliation, and cleanup failures in stable order', async (t) => {
  const runner = createRejectedAttachRunner();
  const options = await createMountOptions(t, runner);
  const reconciliationError = new Error('injected reconciliation lstat failure');
  const cleanupError = new Error('injected session cleanup failure');
  const originalLstat = fs.promises.lstat;
  const originalRm = fs.promises.rm;
  fs.promises.lstat = async (targetPath, ...args) => {
    if (runner.mountPoint && targetPath === runner.mountPoint) {
      throw reconciliationError;
    }
    return originalLstat(targetPath, ...args);
  };
  fs.promises.rm = async (targetPath, ...args) => {
    if (runner.mountPoint && targetPath === path.dirname(runner.mountPoint)) {
      throw cleanupError;
    }
    return originalRm(targetPath, ...args);
  };
  t.after(() => {
    fs.promises.lstat = originalLstat;
    fs.promises.rm = originalRm;
  });

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [
        runner.attachError,
        reconciliationError,
        cleanupError,
      ]);
      return true;
    },
  );
});

test('removes the session root when mount-point setup fails after mkdtemp', async (t) => {
  const root = await createTemporaryRoot(t, 'mount-setup-failure-');
  const temporaryRoot = path.join(root, 'sessions');
  const dmgPath = path.join(root, 'fixture.dmg');
  await mkdir(temporaryRoot);
  await writeFile(dmgPath, 'fixture dmg');
  const setupError = new Error('injected mount-point mkdir failure');
  const originalMkdir = fs.promises.mkdir;
  fs.promises.mkdir = async (targetPath, ...args) => {
    if (path.basename(targetPath) === 'mount') {
      throw setupError;
    }
    return originalMkdir(targetPath, ...args);
  };
  t.after(() => {
    fs.promises.mkdir = originalMkdir;
  });

  await assert.rejects(
    inspectMountedDmgApp({
      dmgPath,
      temporaryRoot,
      execute: async () => {
        throw new Error('execute must not be called');
      },
      inspect: async () => undefined,
    }),
    (error) => error === setupError,
  );

  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('detaches the explicit mount point after malformed attach JSON', async (t) => {
  const runner = createMountRunner({ plistOutput: '{not json' });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /malformed.*JSON/i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', runner.mountPoint]));
  assert.deepEqual(await readdir(options.temporaryRoot), []);
});

test('rejects a returned mount-point mismatch and detaches the explicit mount point', async (t) => {
  const runner = createMountRunner({
    mountPointValue: async (mountPoint) => {
      const otherMountPoint = path.join(path.dirname(mountPoint), 'other-mount');
      await mkdir(otherMountPoint);
      return otherMountPoint;
    },
  });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /mount-point.*mismatch/i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', runner.mountPoint]));
});

test('rejects an empty device suffix without detaching the untrusted device', async (t) => {
  const runner = createMountRunner({ device: '/dev/' });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /dev-entry.*nonblank \/dev\/\.\.\./i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', runner.mountPoint]));
});

test('rejects a traversal device and detaches only the explicit mount point', async (t) => {
  const traversalDevice = '/dev/../tmp/untrusted-volume';
  const runner = createMountRunner({ device: traversalDevice });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /dev-entry.*safe device path/i,
  );

  const detachCalls = runner.calls.filter(({ file, args }) => (
    file === 'hdiutil' && args[0] === 'detach'
  ));
  assert.deepEqual(detachCalls, [command('hdiutil', ['detach', runner.mountPoint])]);
  assert.equal(detachCalls.some(({ args }) => args.includes(traversalDevice)), false);
});

test('rejects a whitespace-wrapped noncanonical device', async (t) => {
  const runner = createMountRunner({ device: ' /dev/disk99 ' });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /dev-entry.*safe device path/i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', runner.mountPoint]));
});

test('rejects a mounted image with no top-level app and detaches its validated device', async (t) => {
  const runner = createMountRunner({ appNames: [] });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /exactly one top-level \.app.*found 0/i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', '/dev/disk99']));
});

test('rejects a mounted image with two top-level apps', async (t) => {
  const runner = createMountRunner({ appNames: ['Ineed LinkLab.app', 'Other.app'] });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /exactly one top-level \.app.*found 2/i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', '/dev/disk99']));
});

test('rejects a single wrongly named top-level app', async (t) => {
  const runner = createMountRunner({ appNames: ['Wrong.app'] });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /expected.*Ineed LinkLab\.app.*Wrong\.app/i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', '/dev/disk99']));
});

test('rejects a symlinked mounted app', async (t) => {
  const runner = createMountRunner({ appKind: 'symlink' });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({ ...options, inspect: async () => undefined }),
    /mounted app.*symbolic link/i,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', '/dev/disk99']));
});

test('preserves an inspection failure after detaching', async (t) => {
  const runner = createMountRunner();
  const options = await createMountOptions(t, runner);
  const inspectionError = new Error('injected inspection failure');

  await assert.rejects(
    inspectMountedDmgApp({
      ...options,
      inspect: async () => {
        throw inspectionError;
      },
    }),
    (error) => error === inspectionError,
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', '/dev/disk99']));
  assert.deepEqual(await readdir(options.temporaryRoot), []);
});

test('reports a detach failure with the preserved mount session', async (t) => {
  const detachError = new Error('injected detach failure');
  const runner = createMountRunner({ detachError });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({
      ...options,
      inspect: async () => 'inspected',
    }),
    (error) => {
      assert.match(error.message, /failed to detach/i);
      assert.match(error.message, new RegExp(runner.mountPoint.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(error.cause, detachError);
      return true;
    },
  );

  assert.deepEqual(runner.calls.at(-1), command('hdiutil', ['detach', '/dev/disk99']));
  assert.deepEqual(await readdir(options.temporaryRoot), [path.basename(path.dirname(runner.mountPoint))]);
});

test('aggregates inspection and detach failures with the primary error first', async (t) => {
  const inspectionError = new Error('injected inspection failure');
  const detachError = new Error('injected detach failure');
  const runner = createMountRunner({ detachError });
  const options = await createMountOptions(t, runner);

  await assert.rejects(
    inspectMountedDmgApp({
      ...options,
      inspect: async () => {
        throw inspectionError;
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0], inspectionError);
      assert.equal(error.errors[1].cause, detachError);
      assert.match(error.message, /inspection.*detach/i);
      return true;
    },
  );
});

test('validates mount-session arguments before executing commands', async (t) => {
  const root = await createTemporaryRoot(t);
  const dmgPath = path.join(root, 'fixture.dmg');
  const execute = async () => {
    throw new Error('execute must not be called');
  };
  const inspect = async () => undefined;

  await assert.rejects(inspectMountedDmgApp({ dmgPath: '  ', execute, inspect }), /DMG path.*nonblank/i);
  await assert.rejects(inspectMountedDmgApp({ dmgPath, execute, inspect: undefined }), /inspect.*function/i);
  await assert.rejects(inspectMountedDmgApp({ dmgPath, execute: null, inspect }), /execute.*function/i);
  await assert.rejects(
    inspectMountedDmgApp({ dmgPath, execute, inspect, expectedAppName: '../Unsafe.app' }),
    /expected app name.*safe leaf/i,
  );
});

test('handles valid and corrupt real macOS disk images without residue', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  await t.test('mounts, inspects, and detaches a valid HFS+ image', async (t) => {
    const root = await createTemporaryRoot(t, 'real-dmg-binding-');
    const imageRoot = path.join(root, 'image-root');
    const appPath = path.join(imageRoot, 'Ineed LinkLab.app');
    const sessionRoot = path.join(root, 'sessions');
    const dmgPath = path.join(root, 'fixture.dmg');
    await mkdir(path.join(appPath, 'Contents'), { recursive: true });
    await mkdir(sessionRoot);
    await writeFile(path.join(appPath, 'Contents', 'payload.txt'), 'real image payload');
    await execFileAsync('hdiutil', [
      'create',
      '-quiet',
      '-fs',
      'HFS+',
      '-srcfolder',
      imageRoot,
      dmgPath,
    ], { encoding: 'utf8' });

    const result = await inspectMountedDmgApp({
      dmgPath,
      temporaryRoot: sessionRoot,
      inspect: (mountedAppPath) => (
        readFile(path.join(mountedAppPath, 'Contents', 'payload.txt'), 'utf8')
      ),
    });

    assert.equal(result, 'real image payload');
    assert.deepEqual(await readdir(sessionRoot), []);
    const infoPlistPath = path.join(root, 'hdiutil-info.plist');
    const { stdout: infoPlist } = await execFileAsync('hdiutil', ['info', '-plist'], {
      encoding: 'utf8',
    });
    await writeFile(infoPlistPath, infoPlist);
    const { stdout: infoJson } = await execFileAsync(
      'plutil',
      ['-convert', 'json', '-o', '-', infoPlistPath],
      { encoding: 'utf8' },
    );
    const mountedImages = JSON.parse(infoJson).images ?? [];
    assert.equal(
      mountedImages.some((image) => image['image-path'] === dmgPath),
      false,
    );
  });

  await t.test('rejects a corrupt image without mount or session residue', async (t) => {
    const root = await createTemporaryRoot(t, 'corrupt-dmg-binding-');
    const sessionRoot = path.join(root, 'sessions');
    const dmgPath = path.join(root, 'corrupt.dmg');
    await mkdir(sessionRoot);
    await writeFile(dmgPath, 'not a disk image');

    await assert.rejects(
      inspectMountedDmgApp({
        dmgPath,
        temporaryRoot: sessionRoot,
        inspect: async () => {
          throw new Error('inspect must not be called');
        },
      }),
    );

    assert.deepEqual(await readdir(sessionRoot), []);
    const infoPlistPath = path.join(root, 'corrupt-hdiutil-info.plist');
    const { stdout: infoPlist } = await execFileAsync('hdiutil', ['info', '-plist'], {
      encoding: 'utf8',
    });
    await writeFile(infoPlistPath, infoPlist);
    const { stdout: infoJson } = await execFileAsync(
      'plutil',
      ['-convert', 'json', '-o', '-', infoPlistPath],
      { encoding: 'utf8' },
    );
    const mountedImages = JSON.parse(infoJson).images ?? [];
    assert.equal(
      mountedImages.some((image) => image['image-path'] === dmgPath),
      false,
    );
  });
});
