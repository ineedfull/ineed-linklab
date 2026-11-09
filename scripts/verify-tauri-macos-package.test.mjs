import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  copyFile,
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

let ARCHITECTURE_DESCRIPTORS;
let bundleRootFor;
let verifyTauriMacPackage;
let verifierModule;

try {
  verifierModule = await import('./verify-tauri-macos-package.mjs');
  ({
    ARCHITECTURE_DESCRIPTORS,
    bundleRootFor,
    verifyTauriMacPackage,
  } = verifierModule);
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
    throw error;
  }
}

const execFileAsync = promisify(execFile);
const APP_NAME = 'Ineed LinkLab.app';
const EXECUTABLE_NAME = 'ineed-linklab-tauri';
const ARCHITECTURES = Object.freeze({
  arm64: Object.freeze({
    rustTarget: 'aarch64-apple-darwin',
    dmgSuffix: 'aarch64',
    fileToken: 'arm64',
  }),
  x64: Object.freeze({
    rustTarget: 'x86_64-apple-darwin',
    dmgSuffix: 'x64',
    fileToken: 'x86_64',
  }),
});
const PLIST = {
  CFBundleIdentifier: 'com.ineedfull.dev-tool',
  CFBundleShortVersionString: '0.1.0',
  CFBundleVersion: '0.1.0',
  CFBundleDisplayName: 'Ineed LinkLab',
  CFBundleExecutable: EXECUTABLE_NAME,
  CFBundleIconFile: 'icon.icns',
};

async function createFixture(t, options = {}) {
  const architecture = options.architecture ?? 'arm64';
  const iconName = options.iconName ?? PLIST.CFBundleIconFile;
  const descriptor = ARCHITECTURES[architecture];
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), 'tauri-macos-package-'));
  if (options.cleanup !== false) {
    t.after(() => rm(root, { recursive: true, force: true }));
  }

  const bundleRoot = options.bundleRoot ?? path.join(root, descriptor.rustTarget, 'release', 'bundle');
  const appPath = path.join(bundleRoot, 'macos', APP_NAME);
  const contentsPath = path.join(appPath, 'Contents');
  const dmgPath = path.join(
    bundleRoot,
    'dmg',
    `Ineed LinkLab_0.1.0_${descriptor.dmgSuffix}.dmg`,
  );
  const assetsPath = path.join(
    path.dirname(bundleRoot),
    'build',
    'ineed-linklab-tauri-current',
    'out',
    'tauri-codegen-assets',
  );

  await Promise.all([
    mkdir(path.join(contentsPath, 'MacOS'), { recursive: true }),
    mkdir(path.join(contentsPath, 'Resources'), { recursive: true }),
    mkdir(path.dirname(dmgPath), { recursive: true }),
    mkdir(assetsPath, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(path.join(contentsPath, 'Info.plist'), 'fixture plist'),
    writeFile(path.join(contentsPath, 'MacOS', EXECUTABLE_NAME), 'fixture executable'),
    writeFile(path.join(contentsPath, 'Resources', iconName), 'fixture icon'),
    writeFile(dmgPath, 'fixture dmg'),
    writeFile(path.join(assetsPath, 'index.html'), '<main></main>'),
    writeFile(path.join(assetsPath, 'main.js'), 'export {};'),
    writeFile(path.join(assetsPath, 'main.css'), 'main {}'),
  ]);
  await chmod(path.join(contentsPath, 'MacOS', EXECUTABLE_NAME), 0o755);

  return { architecture, root, bundleRoot, appPath, contentsPath, dmgPath, assetsPath };
}

function createRunner({
  architecture = 'arm64',
  fileDescription = `Mach-O 64-bit executable ${ARCHITECTURES[architecture].fileToken}`,
  plist = PLIST,
  authority,
  verifyError,
} = {}) {
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });

    if (file === 'plutil') {
      const resolvedPlist = typeof plist === 'function' ? plist(args.at(-1)) : plist;
      return { stdout: JSON.stringify(resolvedPlist), stderr: '' };
    }

    if (file === 'file') {
      const resolvedDescription = typeof fileDescription === 'function'
        ? fileDescription(args.at(-1))
        : fileDescription;
      return { stdout: resolvedDescription, stderr: '' };
    }

    if (file === 'codesign' && args[0] === '-dv') {
      const resolvedAuthority = typeof authority === 'function' ? authority(args.at(-1)) : authority;
      const authorityOutput = resolvedAuthority ? `Authority=${resolvedAuthority}\n` : '';
      return { stdout: '', stderr: `Executable=/fixture\nSignature=adhoc\n${authorityOutput}` };
    }

    if (file === 'codesign' && args[0] === '--verify') {
      if (verifyError) {
        throw verifyError;
      }
      return { stdout: '', stderr: '' };
    }

    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };

  return { execute, calls };
}

function expectedCommand(file, args) {
  return { file, args, options: { encoding: 'utf8' } };
}

async function verifyFixture(
  fixture,
  runner = createRunner({ architecture: fixture.architecture }),
  options = {},
) {
  return verifyTauriMacPackage({
    architecture: fixture.architecture,
    bundleRoot: fixture.bundleRoot,
    execute: runner.execute,
    inspectDmgApp: async ({ inspect }) => inspect(fixture.appPath),
    ...options,
  });
}

async function createMountedCopy(fixture, name = 'mounted-copy') {
  const mountedAppPath = path.join(fixture.root, name, APP_NAME);
  await mkdir(path.dirname(mountedAppPath), { recursive: true });
  await cp(fixture.appPath, mountedAppPath, { recursive: true, verbatimSymlinks: true });
  return realpath(mountedAppPath);
}

function inspectMountedCopy(mountedAppPath, observeError) {
  return async ({ inspect }) => {
    try {
      return await inspect(mountedAppPath);
    } catch (error) {
      observeError?.(error);
      throw error;
    }
  };
}

test('exports frozen architecture descriptors and resolves architecture-specific bundle roots', () => {
  assert.deepEqual(Object.keys(verifierModule).sort(), [
    'ARCHITECTURE_DESCRIPTORS',
    'DEFAULT_BUNDLE_ROOT',
    'bundleRootFor',
    'verifyTauriMacPackage',
  ]);
  assert.equal(Object.isFrozen(ARCHITECTURE_DESCRIPTORS), true);
  assert.equal(Object.isFrozen(ARCHITECTURE_DESCRIPTORS.arm64), true);
  assert.equal(Object.isFrozen(ARCHITECTURE_DESCRIPTORS.x64), true);
  assert.equal(Object.isFrozen(ARCHITECTURE_DESCRIPTORS.arm64.fileTokenPattern), true);
  assert.equal(Object.isFrozen(ARCHITECTURE_DESCRIPTORS.arm64.dmgPattern), true);
  assert.equal(Object.isFrozen(ARCHITECTURE_DESCRIPTORS.x64.fileTokenPattern), true);
  assert.equal(Object.isFrozen(ARCHITECTURE_DESCRIPTORS.x64.dmgPattern), true);
  assert.deepEqual(
    {
      rustTarget: ARCHITECTURE_DESCRIPTORS.arm64.rustTarget,
      fileToken: ARCHITECTURE_DESCRIPTORS.arm64.fileToken,
    },
    { rustTarget: 'aarch64-apple-darwin', fileToken: 'arm64' },
  );
  assert.deepEqual(
    {
      rustTarget: ARCHITECTURE_DESCRIPTORS.x64.rustTarget,
      fileToken: ARCHITECTURE_DESCRIPTORS.x64.fileToken,
    },
    { rustTarget: 'x86_64-apple-darwin', fileToken: 'x86_64' },
  );
  assert.match('Ineed LinkLab_0.1.0_aarch64.dmg', ARCHITECTURE_DESCRIPTORS.arm64.dmgPattern);
  assert.doesNotMatch('Ineed LinkLab_0.1.0_x64.dmg', ARCHITECTURE_DESCRIPTORS.arm64.dmgPattern);
  assert.match('Ineed LinkLab_0.1.0_x64.dmg', ARCHITECTURE_DESCRIPTORS.x64.dmgPattern);
  assert.doesNotMatch('Ineed LinkLab_0.1.0_aarch64.dmg', ARCHITECTURE_DESCRIPTORS.x64.dmgPattern);

  assert.equal(
    bundleRootFor('arm64'),
    fileURLToPath(new URL('../apps/tauri/src-tauri/target/aarch64-apple-darwin/release/bundle', import.meta.url)),
  );
  assert.equal(
    bundleRootFor('x64'),
    fileURLToPath(new URL('../apps/tauri/src-tauri/target/x86_64-apple-darwin/release/bundle', import.meta.url)),
  );
});

test('verifies a complete arm64 macOS package and invokes exact commands', async (t) => {
  assert.equal(typeof verifyTauriMacPackage, 'function');
  const fixture = await createFixture(t);
  const runner = createRunner();

  const result = await verifyFixture(fixture, runner);

  assert.deepEqual(result, {
    appPath: fixture.appPath,
    dmgPath: fixture.dmgPath,
    architecture: 'arm64',
    signing: 'unsigned',
    embeddedAssetExtensions: ['.css', '.html', '.js'],
  });
  assert.deepEqual(runner.calls, [
    ...Array.from({ length: 3 }, () => [
      expectedCommand('plutil', ['-convert', 'json', '-o', '-', path.join(fixture.contentsPath, 'Info.plist')]),
      expectedCommand('file', ['-b', path.join(fixture.contentsPath, 'MacOS', EXECUTABLE_NAME)]),
      expectedCommand('codesign', ['-dv', '--verbose=4', fixture.appPath]),
    ]).flat(),
  ]);
});

test('verifies a complete x64 macOS package', async (t) => {
  const fixture = await createFixture(t, { architecture: 'x64' });

  const result = await verifyFixture(fixture);

  assert.equal(result.architecture, 'x64');
  assert.equal(result.appPath, fixture.appPath);
  assert.equal(result.dmgPath, fixture.dmgPath);
});

test('verifies a production-shaped Tauri app with its plist-referenced icon', async (t) => {
  const iconName = 'Ineed LinkLab.icns';
  const fixture = await createFixture(t, { iconName });
  const runner = createRunner({
    plist: { ...PLIST, CFBundleIconFile: iconName },
  });

  const result = await verifyFixture(fixture, runner);

  assert.equal(result.appPath, fixture.appPath);
  assert.equal(result.architecture, 'arm64');
});

test('rejects a plist-referenced icon with a non-icns extension', async (t) => {
  const iconName = 'Ineed LinkLab.png';
  const fixture = await createFixture(t, { iconName });

  await assert.rejects(
    verifyFixture(fixture, createRunner({
      plist: { ...PLIST, CFBundleIconFile: iconName },
    })),
    /CFBundleIconFile.*\.icns/i,
  );
});

test('rejects unsupported architecture before inspecting the filesystem', async () => {
  let executeCalled = false;
  for (const architecture of ['ppc64', 'toString', new String('arm64')]) {
    await assert.rejects(
      verifyTauriMacPackage({
        architecture,
        bundleRoot: '/definitely/missing/bundle',
        execute: async () => {
          executeCalled = true;
          throw new Error('must not execute');
        },
      }),
      { message: 'architecture must be arm64 or x64' },
    );
  }
  assert.equal(executeCalled, false);
  assert.throws(() => bundleRootFor('x86_64'), {
    message: 'architecture must be arm64 or x64',
  });
});

test('rejects wrong and Universal executable slices for each requested architecture', async (t) => {
  const cases = [
    {
      architecture: 'arm64',
      fileDescription: 'Mach-O 64-bit executable x86_64',
    },
    {
      architecture: 'arm64',
      fileDescription: 'Mach-O universal binary with 2 architectures: [x86_64] [arm64]',
    },
    {
      architecture: 'x64',
      fileDescription: 'Mach-O 64-bit executable arm64',
    },
    {
      architecture: 'x64',
      fileDescription: 'Mach-O universal binary with 2 architectures: [x86_64] [arm64]',
    },
  ];

  for (const { architecture, fileDescription } of cases) {
    const fixture = await createFixture(t, { architecture });
    await assert.rejects(
      verifyFixture(fixture, createRunner({ architecture, fileDescription })),
      new RegExp(`exactly ${architecture}`, 'i'),
    );
  }
});

test('rejects an x64 Universal executable without a standalone arm64 token', async (t) => {
  const fixture = await createFixture(t, { architecture: 'x64' });
  const fileDescription = [
    'Mach-O universal binary with 2 architectures:',
    '[x86_64: Mach-O 64-bit executable x86_64]',
    '[arm64e: Mach-O 64-bit executable arm64e]',
  ].join(' ');

  await assert.rejects(
    verifyFixture(fixture, createRunner({ architecture: 'x64', fileDescription })),
    /universal binary/i,
  );
});

test('rejects architecture names that only contain the selected file token as a substring', async (t) => {
  const cases = [
    { architecture: 'arm64', fileDescription: 'Mach-O 64-bit executable notarm64slice' },
    { architecture: 'x64', fileDescription: 'Mach-O 64-bit executable notx86_64slice' },
  ];

  for (const { architecture, fileDescription } of cases) {
    const fixture = await createFixture(t, { architecture });
    await assert.rejects(
      verifyFixture(fixture, createRunner({ architecture, fileDescription })),
      new RegExp(`exactly ${architecture}`, 'i'),
    );
  }
});

test('rejects a DMG named for the other architecture', async (t) => {
  const fixture = await createFixture(t, { architecture: 'x64' });
  await rename(
    fixture.dmgPath,
    path.join(path.dirname(fixture.dmgPath), 'Ineed LinkLab_0.1.0_aarch64.dmg'),
  );
  await assert.rejects(verifyFixture(fixture), /DMG.*name.*x64/i);
});

test('rejects a non-Mach-O text executable when its path contains arm64', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tauri-arm64-spoof-'));
  const fixture = await createFixture(t, { root });
  const runner = createRunner();
  const execute = async (file, args, options) => {
    if (file === 'file') {
      return execFileAsync('/usr/bin/file', args, options);
    }
    return runner.execute(file, args, options);
  };

  await assert.rejects(
    verifyTauriMacPackage({ bundleRoot: fixture.bundleRoot, execute }),
    /Mach-O.*arm64/i,
  );
});

test('requires the exact executable name and an executable permission bit', async (t) => {
  const namedFixture = await createFixture(t);
  const alternateName = 'other-executable';
  const alternatePath = path.join(namedFixture.contentsPath, 'MacOS', alternateName);
  await writeFile(alternatePath, 'alternate executable');
  await chmod(alternatePath, 0o755);
  await assert.rejects(
    verifyFixture(namedFixture, createRunner({
      plist: { ...PLIST, CFBundleExecutable: alternateName },
    })),
    /CFBundleExecutable.*ineed-linklab-tauri/,
  );

  const modeFixture = await createFixture(t);
  await chmod(path.join(modeFixture.contentsPath, 'MacOS', EXECUTABLE_NAME), 0o644);
  await assert.rejects(verifyFixture(modeFixture), /executable permission bit/i);
});

test('rejects an extra app bundle even when the expected app exists', async (t) => {
  const fixture = await createFixture(t);
  await mkdir(path.join(fixture.bundleRoot, 'macos', 'Old.app'));
  await assert.rejects(verifyFixture(fixture), /exactly one.*app/i);
});

test('rejects an expected source app bundle that is a symbolic link', async (t) => {
  const fixture = await createFixture(t);
  const externalApp = path.join(fixture.root, 'External.app');
  await rename(fixture.appPath, externalApp);
  await symlink(externalApp, fixture.appPath);

  await assert.rejects(verifyFixture(fixture), /App bundle.*symbolic link/i);
});

test('rejects a wrongly named DMG', async (t) => {
  const fixture = await createFixture(t);
  await rename(fixture.dmgPath, path.join(path.dirname(fixture.dmgPath), 'garbage.dmg'));
  await assert.rejects(verifyFixture(fixture), /DMG.*name/i);
});

test('rejects duplicate DMG files', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(path.dirname(fixture.dmgPath), 'Ineed-LinkLab-0.1.0-arm64.dmg'), 'duplicate');
  await assert.rejects(verifyFixture(fixture), /exactly one.*DMG/i);
});

test('rejects an expected source DMG artifact that is a symbolic link', async (t) => {
  const fixture = await createFixture(t);
  const externalDmg = path.join(fixture.root, 'external.dmg');
  await writeFile(externalDmg, 'external dmg');
  await rm(fixture.dmgPath);
  await symlink(externalDmg, fixture.dmgPath);

  await assert.rejects(verifyFixture(fixture), /DMG artifact.*symbolic link/i);
});

test('rejects a mounted app whose icon has a different regular-file hash', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  await writeFile(
    path.join(mountedAppPath, 'Contents', 'Resources', 'icon.icns'),
    'mounted icon',
  );

  await assert.rejects(
    verifyFixture(fixture, createRunner(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /tauri:arm64.*Contents\/Resources\/icon\.icns.*SHA-256 difference/i,
  );
});

test('rejects a mounted app with a different CFBundleIdentifier', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  const runner = createRunner({
    plist: (plistPath) => plistPath.startsWith(mountedAppPath)
      ? { ...PLIST, CFBundleIdentifier: 'com.example.wrong' }
      : PLIST,
  });

  await assert.rejects(
    verifyFixture(fixture, runner, { inspectDmgApp: inspectMountedCopy(mountedAppPath) }),
    /tauri:arm64.*mounted app.*CFBundleIdentifier/i,
  );
});

test('rejects a mounted app with a different CFBundleShortVersionString', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  const runner = createRunner({
    plist: (plistPath) => plistPath.startsWith(mountedAppPath)
      ? { ...PLIST, CFBundleShortVersionString: '0.2.0' }
      : PLIST,
  });

  await assert.rejects(
    verifyFixture(fixture, runner, { inspectDmgApp: inspectMountedCopy(mountedAppPath) }),
    /tauri:arm64.*mounted app.*CFBundleShortVersionString/i,
  );
});

test('rejects a mounted app with a different CFBundleVersion', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  const runner = createRunner({
    plist: (plistPath) => plistPath.startsWith(mountedAppPath)
      ? { ...PLIST, CFBundleVersion: '2' }
      : PLIST,
  });

  await assert.rejects(
    verifyFixture(fixture, runner, { inspectDmgApp: inspectMountedCopy(mountedAppPath) }),
    /tauri:arm64.*mounted app.*CFBundleVersion/i,
  );
});

test('rejects mounted executable architecture and propagates callback validation failures', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  let callbackError;
  const runner = createRunner({
    fileDescription: (executablePath) => executablePath.startsWith(mountedAppPath)
      ? 'Mach-O 64-bit executable x86_64'
      : 'Mach-O 64-bit executable arm64',
  });

  await assert.rejects(
    verifyFixture(fixture, runner, {
      inspectDmgApp: inspectMountedCopy(mountedAppPath, (error) => {
        callbackError = error;
      }),
    }),
    (error) => {
      assert.match(error.message, /tauri:arm64.*mounted app.*exactly arm64/i);
      assert.equal(error.cause, callbackError);
      assert.equal(error.message.match(/tauri:arm64/g)?.length, 1);
      assert.ok(error.message.endsWith(`source DMG: ${fixture.dmgPath}`));
      return true;
    },
  );
  assert.match(callbackError.message, /tauri:arm64.*mounted app.*exactly arm64/i);
});

test('rejects a mounted app with a different signing classification', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  const runner = createRunner({
    authority: (appPath) => appPath.startsWith(mountedAppPath)
      ? 'Developer ID Application: Example Corp (TEAMID)'
      : undefined,
  });

  await assert.rejects(
    verifyFixture(fixture, runner, { inspectDmgApp: inspectMountedCopy(mountedAppPath) }),
    /tauri:arm64.*runtime mismatch.*signing.*unsigned.*developer-id/i,
  );
});

test('rejects a mounted app with a different symbolic-link target', async (t) => {
  const fixture = await createFixture(t);
  const linkPath = path.join(fixture.contentsPath, 'runtime-channel');
  await symlink('runtime-one', linkPath);
  const mountedAppPath = await createMountedCopy(fixture);
  const mountedLinkPath = path.join(mountedAppPath, 'Contents', 'runtime-channel');
  await rm(mountedLinkPath);
  await symlink('runtime-two', mountedLinkPath);

  await assert.rejects(
    verifyFixture(fixture, createRunner(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /tauri:arm64.*Contents\/runtime-channel.*link target difference/i,
  );
});

test('adds package context to a DMG inspector lifecycle failure', async (t) => {
  const fixture = await createFixture(t);
  const mountPoint = path.join(fixture.root, 'mount-session', 'mount');
  const inspectionFailure = new Error(
    `Mounted image must contain exactly one top-level .app; found 0 at mount point ${mountPoint}`,
  );

  await assert.rejects(
    verifyFixture(fixture, createRunner(), {
      inspectDmgApp: async () => {
        throw inspectionFailure;
      },
    }),
    (error) => {
      assert.equal(error.cause, inspectionFailure);
      assert.equal(
        error.message,
        `tauri:arm64: DMG inspection failed: ${inspectionFailure.message}; `
          + `source DMG: ${fixture.dmgPath}`,
      );
      return true;
    },
  );
});

test('preserves AggregateError lifecycle diagnostics with package context', async (t) => {
  const fixture = await createFixture(t);
  const mountPoint = path.join(fixture.root, 'mount-session', 'mount');
  const primaryError = new Error('Mounted image invariant failed: found no top-level app');
  const detachError = new Error(
    `Failed to detach disk image; mount point preserved at ${mountPoint}`,
  );
  const inspectionFailure = new AggregateError(
    [primaryError, detachError],
    'DMG inspection and detach both failed',
  );

  await assert.rejects(
    verifyFixture(fixture, createRunner(), {
      inspectDmgApp: async () => {
        throw inspectionFailure;
      },
    }),
    (error) => {
      assert.equal(error.cause, inspectionFailure);
      assert.match(error.message, /tauri:arm64/);
      assert.ok(error.message.includes(inspectionFailure.message));
      assert.ok(error.message.includes(primaryError.message));
      assert.ok(error.message.includes(detachError.message));
      assert.ok(error.message.includes(mountPoint));
      assert.ok(error.message.endsWith(`source DMG: ${fixture.dmgPath}`));
      return true;
    },
  );
});

test('rejects a sidecar changed after its initial manifest snapshot', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);

  await assert.rejects(
    verifyFixture(fixture, createRunner(), {
      inspectDmgApp: async ({ inspect }) => {
        await writeFile(
          path.join(fixture.contentsPath, 'Resources', 'icon.icns'),
          'sidecar icon mutated after initial snapshot',
        );
        return inspect(mountedAppPath);
      },
    }),
    /tauri:arm64: sidecar changed during verification.*Contents\/Resources\/icon\.icns.*(?:byte size|SHA-256) difference/i,
  );
});

test('rejects multiple app-specific codegen directories even when one is newer and complete', async (t) => {
  const fixture = await createFixture(t);
  const staleAssets = path.join(
    path.dirname(fixture.bundleRoot),
    'build',
    'ineed-linklab-tauri-stale',
    'out',
    'tauri-codegen-assets',
  );
  await mkdir(staleAssets, { recursive: true });
  await writeFile(path.join(staleAssets, 'stale.html'), '<main></main>');
  await utimes(staleAssets, new Date(1_000), new Date(1_000));
  await utimes(fixture.assetsPath, new Date(2_000), new Date(2_000));

  await assert.rejects(verifyFixture(fixture), /exactly one.*app-specific.*codegen/i);
});

test('rejects empty required embedded assets', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.assetsPath, 'main.css'), '');
  await assert.rejects(verifyFixture(fixture), /must include nonempty \.css/);
});

test('rejects loose web assets in app Resources', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.contentsPath, 'Resources', 'loose.js'), 'export {};');
  await assert.rejects(verifyFixture(fixture), /loose web asset/i);
});

test('rejects a nested Resources directory symlink before following it', async (t) => {
  const fixture = await createFixture(t);
  const externalWeb = path.join(fixture.root, 'external-web');
  await mkdir(externalWeb);
  await writeFile(path.join(externalWeb, 'loose.js'), 'export {};');
  await symlink(externalWeb, path.join(fixture.contentsPath, 'Resources', 'web'));

  await assert.rejects(verifyFixture(fixture), /Resources.*symbolic link/i);
});

test('verifies a Developer ID Application signature before classifying it', async (t) => {
  const fixture = await createFixture(t);
  const runner = createRunner({ authority: 'Developer ID Application: Example Corp (TEAMID)' });

  const result = await verifyFixture(fixture, runner);

  assert.equal(result.signing, 'developer-id');
  assert.deepEqual(runner.calls.at(-1), expectedCommand('codesign', [
    '--verify',
    '--deep',
    '--strict',
    fixture.appPath,
  ]));
});

test('rejects an invalid Developer ID signature', async (t) => {
  const fixture = await createFixture(t);
  const verifyError = new Error('invalid signature');
  const runner = createRunner({
    authority: 'Developer ID Application: Example Corp (TEAMID)',
    verifyError,
  });
  await assert.rejects(verifyFixture(fixture, runner), /invalid signature/);
});

test('rejects a non-Developer-ID signing identity', async (t) => {
  const fixture = await createFixture(t);
  const runner = createRunner({ authority: 'Apple Development: Example Corp (TEAMID)' });
  await assert.rejects(verifyFixture(fixture, runner), /unsupported signing identity/i);
});

test('rejects executable and icon traversal names', async (t) => {
  const fixture = await createFixture(t);
  await Promise.all([
    writeFile(path.join(fixture.contentsPath, 'outside-executable'), 'outside executable'),
    writeFile(path.join(fixture.contentsPath, 'outside.icns'), 'outside icon'),
  ]);

  await assert.rejects(
    verifyFixture(fixture, createRunner({
      plist: { ...PLIST, CFBundleExecutable: '../outside-executable' },
    })),
    /CFBundleExecutable.*leaf filename/,
  );
  await assert.rejects(
    verifyFixture(fixture, createRunner({
      plist: { ...PLIST, CFBundleIconFile: '../outside.icns' },
    })),
    /CFBundleIconFile.*leaf filename/,
  );
});

test('rejects symlinked executable and icon files', async (t) => {
  const fixture = await createFixture(t);
  const externalExecutable = path.join(fixture.root, 'external-executable');
  const externalIcon = path.join(fixture.root, 'external.icns');
  const executablePath = path.join(fixture.contentsPath, 'MacOS', EXECUTABLE_NAME);
  const iconPath = path.join(fixture.contentsPath, 'Resources', 'icon.icns');
  await Promise.all([
    writeFile(externalExecutable, 'external executable'),
    writeFile(externalIcon, 'external icon'),
    rm(executablePath),
  ]);
  await symlink(externalExecutable, executablePath);
  await assert.rejects(verifyFixture(fixture), /must not be a symbolic link/);

  await rm(executablePath);
  await writeFile(executablePath, 'fixture executable');
  await rm(iconPath);
  await symlink(externalIcon, iconPath);
  await assert.rejects(verifyFixture(fixture), /must not be a symbolic link/);
});

test('rejects a symlinked app Contents directory', async (t) => {
  const fixture = await createFixture(t);
  const externalContents = path.join(fixture.root, 'external-Contents');
  await rename(fixture.contentsPath, externalContents);
  await symlink(externalContents, fixture.contentsPath);

  await assert.rejects(verifyFixture(fixture), /Contents.*must not be a symbolic link/);
});

test('rejects symlinked MacOS and Resources directories', async (t) => {
  const macFixture = await createFixture(t);
  const macosPath = path.join(macFixture.contentsPath, 'MacOS');
  const externalMacos = path.join(macFixture.root, 'external-MacOS');
  await rename(macosPath, externalMacos);
  await symlink(externalMacos, macosPath);
  await assert.rejects(verifyFixture(macFixture), /MacOS.*must not be a symbolic link/);

  const resourcesFixture = await createFixture(t);
  const resourcesPath = path.join(resourcesFixture.contentsPath, 'Resources');
  const externalResources = path.join(resourcesFixture.root, 'external-Resources');
  await rename(resourcesPath, externalResources);
  await symlink(externalResources, resourcesPath);
  await assert.rejects(verifyFixture(resourcesFixture), /Resources.*must not be a symbolic link/);
});

test('rejects a symlinked Info.plist', async (t) => {
  const fixture = await createFixture(t);
  const plistPath = path.join(fixture.contentsPath, 'Info.plist');
  const externalPlist = path.join(fixture.root, 'external.plist');
  await writeFile(externalPlist, 'external plist');
  await rm(plistPath);
  await symlink(externalPlist, plistPath);

  await assert.rejects(verifyFixture(fixture), /Info\.plist.*must not be a symbolic link/);
});

test('direct invocation through a symlink prints one result line and reports failures', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tauri-macos-package-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'scripts', 'verify-tauri-macos-package.mjs');
  const bindingHelperPath = path.join(root, 'scripts', 'macos-dmg-app-binding.mjs');
  const manifestHelperPath = path.join(root, 'scripts', 'macos-app-manifest.py');
  const symlinkPath = path.join(root, 'run-verifier.mjs');
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await Promise.all([
    copyFile(fileURLToPath(new URL('./verify-tauri-macos-package.mjs', import.meta.url)), scriptPath),
    copyFile(fileURLToPath(new URL('./macos-dmg-app-binding.mjs', import.meta.url)), bindingHelperPath),
    copyFile(fileURLToPath(new URL('./macos-app-manifest.py', import.meta.url)), manifestHelperPath),
  ]);
  await symlink(scriptPath, symlinkPath);
  const fixtures = await Promise.all(Object.keys(ARCHITECTURES).map((architecture) => createFixture(t, {
    architecture,
    root,
    bundleRoot: path.join(
      root,
      'apps',
      'tauri',
      'src-tauri',
      'target',
      ARCHITECTURES[architecture].rustTarget,
      'release',
      'bundle',
    ),
    cleanup: false,
  })));
  await Promise.all(fixtures.flatMap((fixture) => [
    writeFile(
      path.join(fixture.contentsPath, 'MacOS', EXECUTABLE_NAME),
      `fixture executable ${fixture.architecture}`,
    ),
    writeFile(fixture.dmgPath, fixture.appPath),
  ]));

  const binPath = path.join(root, 'bin');
  await mkdir(binPath);
  const fakeCommands = {
    hdiutil: `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'attach') {
  const mountPoint = args[args.indexOf('-mountpoint') + 1];
  const dmgPath = args.at(-1);
  const appPath = fs.readFileSync(dmgPath, 'utf8');
  fs.cpSync(appPath, path.join(mountPoint, ${JSON.stringify(APP_NAME)}), {
    recursive: true,
    verbatimSymlinks: true,
  });
  process.stdout.write(JSON.stringify({
    'system-entities': [{ 'mount-point': mountPoint, 'dev-entry': '/dev/disk99' }],
  }));
} else if (args[0] !== 'detach') {
  throw new Error(\`unexpected hdiutil arguments: \${args.join(' ')}\`);
}
`,
    plutil: `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv.at(-1);
if (path.basename(target) === 'attach.plist') {
  process.stdout.write(fs.readFileSync(target, 'utf8'));
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify(PLIST))});
}
`,
    file: `#!/usr/bin/env node
const fs = require('node:fs');
const architecture = fs.readFileSync(process.argv.at(-1), 'utf8').includes('x64')
  ? 'x86_64'
  : 'arm64';
process.stdout.write(\`Mach-O 64-bit executable \${architecture}\\n\`);
`,
    codesign: '#!/usr/bin/env node\nprocess.stderr.write("Signature=adhoc\\n");\n',
  };
  await Promise.all(Object.entries(fakeCommands).map(async ([name, source]) => {
    const commandPath = path.join(binPath, name);
    await writeFile(commandPath, source);
    await chmod(commandPath, 0o755);
  }));
  const options = {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH ?? ''}` },
  };

  const success = await execFileAsync(process.execPath, [symlinkPath], options);
  const lines = success.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^TAURI_MAC_PACKAGE_RESULT=/);
  const expectedResults = await Promise.all(fixtures.map(async (fixture) => ({
    appPath: await realpath(fixture.appPath),
    dmgPath: await realpath(fixture.dmgPath),
    architecture: fixture.architecture,
    signing: 'unsigned',
    embeddedAssetExtensions: ['.css', '.html', '.js'],
  })));
  assert.deepEqual(
    JSON.parse(lines[0].slice('TAURI_MAC_PACKAGE_RESULT='.length)),
    expectedResults,
  );

  await rm(fixtures[0].dmgPath);
  await assert.rejects(
    execFileAsync(process.execPath, [symlinkPath], options),
    (error) => error.code !== 0 && error.stdout === '' && /exactly one.*DMG/i.test(error.stderr),
  );

  await writeFile(fixtures[0].dmgPath, fixtures[0].appPath);
  await rm(fixtures[1].dmgPath);
  await assert.rejects(
    execFileAsync(process.execPath, [symlinkPath], options),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.equal(error.stdout, '');
      assert.doesNotMatch(error.stdout, /TAURI_MAC_PACKAGE_RESULT=/);
      assert.match(error.stderr, /x86_64-apple-darwin/);
      assert.match(error.stderr, /exactly one.*DMG.*found 0/i);
      return true;
    },
  );
});
