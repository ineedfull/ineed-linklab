import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
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
import { createPackage } from '@electron/asar';

let releaseRootFor;
let verifierModule;
let verifyElectronMacPackage;

try {
  verifierModule = await import('./verify-electron-macos-package.mjs');
  ({ releaseRootFor, verifyElectronMacPackage } = verifierModule);
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
    throw error;
  }
}

const execFileAsync = promisify(execFile);
const APP_NAME = 'Ineed LinkLab.app';
const EXECUTABLE_NAME = 'Ineed LinkLab';
const DMG_NAME = (architecture) => `Ineed LinkLab-Electron_0.1.0_${architecture}.dmg`;
const FILE_TOKEN = Object.freeze({ arm64: 'arm64', x64: 'x86_64' });
const PLIST = Object.freeze({
  CFBundleIdentifier: 'com.ineedfull.dev-tool.electron',
  CFBundleShortVersionString: '0.1.0',
  CFBundleVersion: '0.1.0',
  CFBundleDisplayName: 'Ineed LinkLab',
  CFBundleName: 'Ineed LinkLab',
  CFBundleExecutable: EXECUTABLE_NAME,
  CFBundleIconFile: 'icon.icns',
});
const ASAR_FILES = Object.freeze({
  'dist/index.html': '<!doctype html><link rel="stylesheet" href="./assets/main.css"><script type="module" src="./assets/main.js"></script>',
  'dist/assets/main.js': 'export {};',
  'dist/assets/main.css': 'body { color: black; }',
});
const MIGRATION_SQL = await readFile(
  new URL('../packages/persistence-contract/migrations/001-initial.sql', import.meta.url),
);
const SETTINGS_SCHEMA = await readFile(
  new URL('../packages/runtime-contract/src/settingsSchema.json', import.meta.url),
);

async function createFixture(t, options = {}) {
  const architecture = options.architecture ?? 'arm64';
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), 'electron-macos-package-'));
  if (options.cleanup !== false) {
    t.after(() => rm(root, { recursive: true, force: true }));
  }

  const releaseRoot = options.releaseRoot ?? path.join(root, 'apps', 'electron', 'release', architecture);
  const appPath = path.join(releaseRoot, `mac-${architecture}`, APP_NAME);
  const contentsPath = path.join(appPath, 'Contents');
  const macosPath = path.join(contentsPath, 'MacOS');
  const resourcesPath = path.join(contentsPath, 'Resources');
  const executablePath = path.join(macosPath, EXECUTABLE_NAME);
  const iconPath = path.join(resourcesPath, 'icon.icns');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked');
  const migrationPath = path.join(
    resourcesPath,
    'contracts',
    'persistence-contract',
    'migrations',
    '001-initial.sql',
  );
  const settingsSchemaPath = path.join(
    resourcesPath,
    'contracts',
    'runtime-contract',
    'src',
    'settingsSchema.json',
  );
  const nativeDirectory = path.join(
    unpackedPath,
    'node_modules',
    '@serialport',
    'bindings-cpp',
    'prebuilds',
    'darwin-x64+arm64',
  );
  const nativePath = path.join(nativeDirectory, 'bindings.node');
  const dmgPath = path.join(releaseRoot, DMG_NAME(architecture));

  await Promise.all([
    mkdir(macosPath, { recursive: true }),
    mkdir(nativeDirectory, { recursive: true }),
    mkdir(path.dirname(migrationPath), { recursive: true }),
    mkdir(path.dirname(settingsSchemaPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(contentsPath, 'Info.plist'), 'fixture plist'),
    writeFile(executablePath, 'fixture executable'),
    writeFile(iconPath, 'fixture icon'),
    writeFile(asarPath, 'fixture asar'),
    writeFile(nativePath, 'fixture native module'),
    writeFile(dmgPath, 'fixture dmg'),
    writeFile(migrationPath, MIGRATION_SQL),
    writeFile(settingsSchemaPath, SETTINGS_SCHEMA),
  ]);
  await chmod(executablePath, 0o755);

  return {
    architecture,
    root,
    releaseRoot,
    appPath,
    contentsPath,
    macosPath,
    resourcesPath,
    executablePath,
    iconPath,
    asarPath,
    unpackedPath,
    migrationPath,
    settingsSchemaPath,
    nativeDirectory,
    nativePath,
    dmgPath,
  };
}

function createRunner({
  architecture = 'arm64',
  executableDescription = `Mach-O 64-bit executable ${FILE_TOKEN[architecture]}`,
  executableArchitectures = FILE_TOKEN[architecture],
  nativeDescription = 'Mach-O universal binary with 2 architectures: [x86_64] [arm64] bundle',
  nativeArchitectures = 'x86_64 arm64',
  plist = PLIST,
  authority,
  inspectSigningError,
  verifyError,
  realDmgCommands = false,
} = {}) {
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });
    if (
      realDmgCommands
      && (
        file === 'hdiutil'
        || (file === 'plutil' && path.basename(args.at(-1)) === 'attach.plist')
      )
    ) {
      return execFileAsync(file, args, options);
    }
    if (file === 'plutil') {
      const resolvedPlist = typeof plist === 'function' ? plist(args.at(-1)) : plist;
      return { stdout: JSON.stringify(resolvedPlist), stderr: '' };
    }
    if (file === 'file') {
      const isNative = args.at(-1).endsWith('.node');
      const description = isNative ? nativeDescription : executableDescription;
      return {
        stdout: typeof description === 'function' ? description(args.at(-1)) : description,
        stderr: '',
      };
    }
    if (file === 'lipo') {
      const isNative = args.at(-1).endsWith('.node');
      const architectures = isNative ? nativeArchitectures : executableArchitectures;
      return {
        stdout: typeof architectures === 'function' ? architectures(args.at(-1)) : architectures,
        stderr: '',
      };
    }
    if (file === 'codesign' && args[0] === '-dv') {
      if (inspectSigningError) {
        throw inspectSigningError;
      }
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

function createAsarReader(files = ASAR_FILES) {
  const calls = [];
  const readAsarFile = async (asarPath, entryPath) => {
    calls.push({ asarPath, entryPath });
    if (!Object.hasOwn(files, entryPath)) {
      throw new Error(`missing ASAR entry ${entryPath}`);
    }
    return Buffer.from(files[entryPath]);
  };
  return { readAsarFile, calls };
}

async function verifyFixture(
  fixture,
  runner = createRunner({ architecture: fixture.architecture }),
  asarReader = createAsarReader(),
  options = {},
) {
  return verifyElectronMacPackage({
    architecture: fixture.architecture,
    releaseRoot: fixture.releaseRoot,
    execute: runner.execute,
    readAsarFile: asarReader.readAsarFile,
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

function expectedCommand(file, args) {
  return { file, args, options: { encoding: 'utf8' } };
}

test('exports architecture-specific release roots', () => {
  assert.equal(typeof verifyElectronMacPackage, 'function');
  assert.equal(typeof releaseRootFor, 'function');
  assert.deepEqual(Object.keys(verifierModule).sort(), [
    'releaseRootFor',
    'verifyElectronMacPackage',
  ]);
  assert.equal(
    releaseRootFor('arm64'),
    fileURLToPath(new URL('../apps/electron/release/arm64', import.meta.url)),
  );
  assert.equal(
    releaseRootFor('x64'),
    fileURLToPath(new URL('../apps/electron/release/x64', import.meta.url)),
  );
});

test('verifies complete arm64 and x64 packages with exact results', async (t) => {
  for (const architecture of ['arm64', 'x64']) {
    const fixture = await createFixture(t, { architecture });
    const runner = createRunner({ architecture });
    const asarReader = createAsarReader();

    const result = await verifyFixture(fixture, runner, asarReader);

    assert.deepEqual(result, {
      appPath: fixture.appPath,
      dmgPath: fixture.dmgPath,
      architecture,
      bundleIdentifier: 'com.ineedfull.dev-tool.electron',
      signing: 'unsigned',
      rendererAssets: ['.css', '.html', '.js'],
      nativeModules: [fixture.nativePath],
    });
    const expectedAsarCalls = [
      { asarPath: fixture.asarPath, entryPath: 'dist/index.html' },
      { asarPath: fixture.asarPath, entryPath: 'dist/assets/main.css' },
      { asarPath: fixture.asarPath, entryPath: 'dist/assets/main.js' },
    ];
    assert.deepEqual(asarReader.calls, [
      ...expectedAsarCalls,
      ...expectedAsarCalls,
      ...expectedAsarCalls,
    ]);
    const expectedAppCommands = [
      expectedCommand('plutil', ['-convert', 'json', '-o', '-', path.join(fixture.contentsPath, 'Info.plist')]),
      expectedCommand('file', ['-b', fixture.executablePath]),
      expectedCommand('lipo', ['-archs', fixture.executablePath]),
      expectedCommand('file', ['-b', fixture.nativePath]),
      expectedCommand('lipo', ['-archs', fixture.nativePath]),
      expectedCommand('codesign', ['-dv', '--verbose=4', fixture.appPath]),
    ];
    assert.deepEqual(runner.calls, [
      ...expectedAppCommands,
      ...expectedAppCommands,
      ...expectedAppCommands,
    ]);
  }
});

test('returns the original absolute selected native path for a relative release root', async (t) => {
  const fixture = await createFixture(t);
  const relativeReleaseRoot = path.relative(process.cwd(), fixture.releaseRoot);
  const resolverCalls = [];
  const result = await verifyElectronMacPackage({
    architecture: fixture.architecture,
    releaseRoot: relativeReleaseRoot,
    execute: createRunner().execute,
    readAsarFile: createAsarReader().readAsarFile,
    resolveNativeModule: async (bindingRoot) => {
      resolverCalls.push(bindingRoot);
      return fixture.nativePath;
    },
    inspectDmgApp: async ({ inspect }) => inspect(fixture.appPath),
  });

  assert.deepEqual(result.nativeModules, [fixture.nativePath]);
  assert.equal(path.isAbsolute(result.nativeModules[0]), true);
  assert.equal(resolverCalls.length, 3);
});

test('revalidates sidecar paths after inspecting a separate matching mounted app', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  const mountedNativePath = path.join(
    mountedAppPath,
    path.relative(fixture.appPath, fixture.nativePath),
  );
  const sidecarBindingRoot = path.dirname(path.dirname(path.dirname(fixture.nativePath)));
  const mountedBindingRoot = path.dirname(path.dirname(path.dirname(mountedNativePath)));
  const resolverCalls = [];

  const result = await verifyFixture(fixture, createRunner(), createAsarReader(), {
    resolveNativeModule: async (bindingRoot) => {
      resolverCalls.push(bindingRoot);
      return bindingRoot === mountedBindingRoot ? mountedNativePath : fixture.nativePath;
    },
    inspectDmgApp: inspectMountedCopy(mountedAppPath),
  });

  assert.deepEqual(resolverCalls, [
    sidecarBindingRoot,
    mountedBindingRoot,
    sidecarBindingRoot,
  ]);
  assert.deepEqual(result.nativeModules, [fixture.nativePath]);
});

test('rejects a sidecar changed after its initial manifest snapshot', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);

  await assert.rejects(
    verifyFixture(fixture, createRunner(), createAsarReader(), {
      inspectDmgApp: async ({ inspect }) => {
        await writeFile(fixture.iconPath, 'sidecar icon mutated after initial snapshot');
        return inspect(mountedAppPath);
      },
    }),
    /electron:arm64: sidecar changed during verification.*Contents\/Resources\/icon\.icns.*(?:byte size|SHA-256) difference/i,
  );
});

test('rejects a real DMG whose app icon differs from the validated sidecar', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const fixture = await createFixture(t);
  const imageRoot = path.join(fixture.root, 'image-root');
  const mountedAppPath = path.join(imageRoot, APP_NAME);
  await mkdir(imageRoot);
  await cp(fixture.appPath, mountedAppPath, { recursive: true, verbatimSymlinks: true });
  await writeFile(
    path.join(mountedAppPath, 'Contents', 'Resources', 'icon.icns'),
    'wrong fixture icon with a different size and digest',
  );
  await rm(fixture.dmgPath);
  await execFileAsync('hdiutil', [
    'create',
    '-quiet',
    '-fs',
    'HFS+',
    '-srcfolder',
    imageRoot,
    fixture.dmgPath,
  ]);

  await assert.rejects(
    verifyElectronMacPackage({
      architecture: fixture.architecture,
      releaseRoot: fixture.releaseRoot,
      execute: createRunner({ realDmgCommands: true }).execute,
      readAsarFile: createAsarReader().readAsarFile,
    }),
    (error) => {
      assert.match(error.message, /electron:arm64/);
      assert.match(error.message, /Contents\/Resources\/icon\.icns/);
      assert.match(error.message, /(?:byte size|SHA-256) difference/i);
      return true;
    },
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
    verifyFixture(fixture, runner, createAsarReader(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /electron:arm64.*mounted app.*CFBundleIdentifier/i,
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
    verifyFixture(fixture, runner, createAsarReader(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /electron:arm64.*mounted app.*CFBundleShortVersionString/i,
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
    verifyFixture(fixture, runner, createAsarReader(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /electron:arm64.*mounted app.*CFBundleVersion/i,
  );
});

test('rejects mounted executable slices and propagates callback validation failures', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  let callbackError;
  const runner = createRunner({
    executableArchitectures: (executablePath) => (
      executablePath.startsWith(mountedAppPath) ? 'x86_64' : 'arm64'
    ),
  });

  await assert.rejects(
    verifyFixture(fixture, runner, createAsarReader(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath, (error) => {
        callbackError = error;
      }),
    }),
    (error) => {
      assert.match(error.message, /electron:arm64.*mounted app.*exactly arm64/i);
      assert.equal(error.cause, callbackError);
      assert.equal(error.message.match(/electron:arm64/g)?.length, 1);
      assert.ok(error.message.endsWith(`source DMG: ${fixture.dmgPath}`));
      return true;
    },
  );
  assert.match(callbackError.message, /electron:arm64.*mounted app.*exactly arm64/i);
});

test('adds package context to a DMG inspector lifecycle failure', async (t) => {
  const fixture = await createFixture(t);
  const mountPoint = path.join(fixture.root, 'mount-session', 'mount');
  const inspectionFailure = new Error(
    `Mounted image must contain exactly one top-level .app; found 0 at mount point ${mountPoint}`,
  );

  await assert.rejects(
    verifyFixture(fixture, createRunner(), createAsarReader(), {
      inspectDmgApp: async () => {
        throw inspectionFailure;
      },
    }),
    (error) => {
      assert.equal(error.cause, inspectionFailure);
      assert.equal(
        error.message,
        `electron:arm64: DMG inspection failed: ${inspectionFailure.message}; `
          + `source DMG: ${fixture.dmgPath}`,
      );
      return true;
    },
  );
});

test('preserves nested AggregateError lifecycle diagnostics with package context', async (t) => {
  const fixture = await createFixture(t);
  const mountPoint = path.join(fixture.root, 'mount-session', 'mount');
  const primaryError = new Error('Mounted image invariant failed: found no top-level app');
  const detachError = new Error(
    `Failed to detach disk image; mount point preserved at ${mountPoint}`,
  );
  const nestedError = new AggregateError(
    ['non-Error cleanup diagnostic'],
    'Additional cleanup diagnostics',
  );
  nestedError.errors.push(nestedError);
  const inspectionFailure = new AggregateError(
    [primaryError, nestedError, detachError],
    'DMG inspection and detach both failed',
  );

  await assert.rejects(
    verifyFixture(fixture, createRunner(), createAsarReader(), {
      inspectDmgApp: async () => {
        throw inspectionFailure;
      },
    }),
    (error) => {
      assert.equal(error.cause, inspectionFailure);
      assert.match(error.message, /electron:arm64/);
      assert.ok(error.message.includes(inspectionFailure.message));
      assert.ok(error.message.includes(primaryError.message));
      assert.ok(error.message.includes(nestedError.message));
      assert.match(error.message, /non-Error cleanup diagnostic/);
      assert.match(error.message, /cyclic AggregateError/i);
      assert.ok(error.message.includes(detachError.message));
      assert.ok(error.message.includes(mountPoint));
      assert.ok(error.message.endsWith(`source DMG: ${fixture.dmgPath}`));
      return true;
    },
  );
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
    verifyFixture(fixture, runner, createAsarReader(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /electron:arm64.*runtime mismatch.*signing.*unsigned.*developer-id/i,
  );
});

test('rejects a mounted app with a different regular-file hash', async (t) => {
  const fixture = await createFixture(t);
  const mountedAppPath = await createMountedCopy(fixture);
  await writeFile(
    path.join(mountedAppPath, 'Contents', 'Resources', 'icon.icns'),
    'different icon contents',
  );

  await assert.rejects(
    verifyFixture(fixture, createRunner(), createAsarReader(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /electron:arm64.*Contents\/Resources\/icon\.icns.*(?:byte size|SHA-256) difference/i,
  );
});

test('rejects a mounted app with a different symbolic-link target', async (t) => {
  const fixture = await createFixture(t);
  const linkPath = path.join(fixture.resourcesPath, 'runtime-channel');
  await Promise.all([
    writeFile(path.join(fixture.resourcesPath, 'runtime-one'), 'one'),
    writeFile(path.join(fixture.resourcesPath, 'runtime-two'), 'two'),
  ]);
  await symlink('runtime-one', linkPath);
  const mountedAppPath = await createMountedCopy(fixture);
  const mountedLinkPath = path.join(mountedAppPath, 'Contents', 'Resources', 'runtime-channel');
  await rm(mountedLinkPath);
  await symlink('runtime-two', mountedLinkPath);

  await assert.rejects(
    verifyFixture(fixture, createRunner(), createAsarReader(), {
      inspectDmgApp: inspectMountedCopy(mountedAppPath),
    }),
    /electron:arm64.*Contents\/Resources\/runtime-channel.*link target difference/i,
  );
});

test('rejects missing packaged migration SQL before certifying an app', async (t) => {
  const fixture = await createFixture(t);
  await rm(fixture.migrationPath);

  await assert.rejects(verifyFixture(fixture), /migration.*missing/i);
});

test('rejects unsafe or incorrect packaged runtime contract assets', async (t) => {
  const cases = [
    {
      name: 'symlinked migration',
      mutate: async (fixture) => {
        const outside = path.join(fixture.root, 'outside.sql');
        await writeFile(outside, MIGRATION_SQL);
        await rm(fixture.migrationPath);
        await symlink(outside, fixture.migrationPath);
      },
      pattern: /migration.*symbolic link/i,
    },
    {
      name: 'empty migration',
      mutate: (fixture) => writeFile(fixture.migrationPath, ''),
      pattern: /migration.*nonempty/i,
    },
    {
      name: 'wrong migration source',
      mutate: (fixture) => writeFile(fixture.migrationPath, 'SELECT 1;'),
      pattern: /migration.*match.*source/i,
    },
    {
      name: 'missing settings schema',
      mutate: (fixture) => rm(fixture.settingsSchemaPath),
      pattern: /settings schema.*missing/i,
    },
    {
      name: 'symlinked settings schema',
      mutate: async (fixture) => {
        const outside = path.join(fixture.root, 'outside.json');
        await writeFile(outside, SETTINGS_SCHEMA);
        await rm(fixture.settingsSchemaPath);
        await symlink(outside, fixture.settingsSchemaPath);
      },
      pattern: /settings schema.*symbolic link/i,
    },
    {
      name: 'empty settings schema',
      mutate: (fixture) => writeFile(fixture.settingsSchemaPath, ''),
      pattern: /settings schema.*nonempty/i,
    },
    {
      name: 'invalid settings schema JSON',
      mutate: (fixture) => writeFile(fixture.settingsSchemaPath, '{'),
      pattern: /settings schema.*valid JSON/i,
    },
    {
      name: 'wrong settings schema source',
      mutate: (fixture) => writeFile(fixture.settingsSchemaPath, '{}'),
      pattern: /settings schema.*match.*source/i,
    },
  ];

  for (const fixtureCase of cases) {
    const fixture = await createFixture(t);
    await fixtureCase.mutate(fixture);
    await assert.rejects(
      verifyFixture(fixture),
      fixtureCase.pattern,
      fixtureCase.name,
    );
  }
});

test('rejects unsupported, prototype, and boxed architectures before filesystem access', async () => {
  for (const architecture of ['ppc64', 'toString', '__proto__', new String('arm64')]) {
    assert.throws(() => releaseRootFor(architecture), { message: 'architecture must be arm64 or x64' });
    await assert.rejects(
      verifyElectronMacPackage({
        architecture,
        releaseRoot: '/definitely/missing',
        execute: async () => assert.fail('must not execute commands'),
        readAsarFile: async () => assert.fail('must not inspect ASAR'),
      }),
      { message: 'architecture must be arm64 or x64' },
    );
  }
});

test('requires lipo to report exactly the selected non-Universal executable architecture', async (t) => {
  const cases = [
    ['arm64', 'x86_64'],
    ['x64', 'arm64'],
    ['arm64', 'x86_64 arm64'],
    ['x64', 'x86_64 arm64'],
    ['arm64', 'arm64e'],
    ['arm64', 'notarm64slice'],
    ['x64', 'notx86_64slice'],
  ];
  for (const [architecture, executableArchitectures] of cases) {
    const fixture = await createFixture(t, { architecture });
    await assert.rejects(
      verifyFixture(fixture, createRunner({ architecture, executableArchitectures })),
      new RegExp(`exactly ${architecture}`, 'i'),
    );
  }
});

test('rejects native architecture tokens found only in multiline file paths', async (t) => {
  const fixture = await createFixture(t);
  const nativeDescription = [
    'Mach-O 64-bit bundle x86_64',
    `${fixture.releaseRoot}/arm64/native/darwin-x64+arm64/bindings.node`,
  ].join('\n');

  await assert.rejects(
    verifyFixture(fixture, createRunner({ nativeDescription, nativeArchitectures: 'x86_64' })),
    /native.*requested arm64/i,
  );
});

test('rejects a non-Mach-O executable even when text contains the architecture token', async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    verifyFixture(fixture, createRunner({ executableDescription: 'ASCII text arm64' })),
    /Mach-O executable/i,
  );
});

test('requires exactly one recursively discovered real app bundle', async (t) => {
  const missingFixture = await createFixture(t);
  await rm(missingFixture.appPath, { recursive: true });
  await assert.rejects(verifyFixture(missingFixture), /exactly one.*app.*found 0/i);

  const duplicateFixture = await createFixture(t);
  await mkdir(path.join(duplicateFixture.releaseRoot, 'stale', 'Old.app'), { recursive: true });
  await assert.rejects(verifyFixture(duplicateFixture), /exactly one.*app.*found 2/i);

  const namedFixture = await createFixture(t);
  const wronglyNamedApp = path.join(path.dirname(namedFixture.appPath), 'Wrong.app');
  await rename(namedFixture.appPath, wronglyNamedApp);
  await assert.rejects(verifyFixture(namedFixture), /bundle name.*Ineed LinkLab\.app/i);

  const symlinkFixture = await createFixture(t);
  const externalApp = path.join(symlinkFixture.root, 'External.app');
  await rename(symlinkFixture.appPath, externalApp);
  await symlink(externalApp, symlinkFixture.appPath);
  await assert.rejects(verifyFixture(symlinkFixture), /app.*symbolic link/i);
});

test('requires one exact top-level nonempty real DMG', async (t) => {
  const missingFixture = await createFixture(t);
  await rm(missingFixture.dmgPath);
  await assert.rejects(verifyFixture(missingFixture), /exactly one.*DMG.*found 0/i);

  const duplicateFixture = await createFixture(t);
  await writeFile(path.join(duplicateFixture.releaseRoot, 'stale.dmg'), 'duplicate');
  await assert.rejects(verifyFixture(duplicateFixture), /exactly one.*DMG.*found 2/i);

  const namedFixture = await createFixture(t);
  await rename(namedFixture.dmgPath, path.join(namedFixture.releaseRoot, 'wrong.dmg'));
  await assert.rejects(verifyFixture(namedFixture), /DMG.*name/i);

  const emptyFixture = await createFixture(t);
  await writeFile(emptyFixture.dmgPath, '');
  await assert.rejects(verifyFixture(emptyFixture), /DMG.*nonempty/i);

  const symlinkFixture = await createFixture(t);
  const externalDmg = path.join(symlinkFixture.root, 'external.dmg');
  await writeFile(externalDmg, 'external dmg');
  await rm(symlinkFixture.dmgPath);
  await symlink(externalDmg, symlinkFixture.dmgPath);
  await assert.rejects(verifyFixture(symlinkFixture), /DMG.*symbolic link/i);

  const nestedFixture = await createFixture(t);
  await mkdir(path.join(nestedFixture.releaseRoot, 'nested'));
  await rename(nestedFixture.dmgPath, path.join(nestedFixture.releaseRoot, 'nested', DMG_NAME('arm64')));
  await assert.rejects(verifyFixture(nestedFixture), /exactly one.*DMG.*found 0/i);
});

test('rejects symlinked bundle contents and selected files', async (t) => {
  const cases = [
    { label: 'Contents', fixtureKey: 'contentsPath', pattern: /Contents.*symbolic link/i },
    { label: 'MacOS', fixtureKey: 'macosPath', pattern: /MacOS.*symbolic link/i },
    { label: 'Resources', fixtureKey: 'resourcesPath', pattern: /Resources.*symbolic link/i },
    { label: 'Info.plist', fixtureKey: 'plistPath', pattern: /Info\.plist.*symbolic link/i },
    { label: 'executable', fixtureKey: 'executablePath', pattern: /executable.*symbolic link/i },
    { label: 'icon', fixtureKey: 'iconPath', pattern: /icon.*symbolic link/i },
    { label: 'ASAR', fixtureKey: 'asarPath', pattern: /ASAR.*symbolic link/i },
  ];
  for (const { label, fixtureKey, pattern } of cases) {
    const fixture = await createFixture(t);
    if (fixtureKey === 'plistPath') {
      fixture.plistPath = path.join(fixture.contentsPath, 'Info.plist');
    }
    const selectedPath = fixture[fixtureKey];
    const externalPath = path.join(fixture.root, `external-${label.replaceAll('.', '-')}`);
    await rename(selectedPath, externalPath);
    await symlink(externalPath, selectedPath);
    await assert.rejects(verifyFixture(fixture), pattern);
  }
});

test('rejects symlinked unpacked directories, nested directories, and native files', async (t) => {
  const directoryFixture = await createFixture(t);
  const externalUnpacked = path.join(directoryFixture.root, 'external-unpacked');
  await rename(directoryFixture.unpackedPath, externalUnpacked);
  await symlink(externalUnpacked, directoryFixture.unpackedPath);
  await assert.rejects(verifyFixture(directoryFixture), /app\.asar\.unpacked.*symbolic link/i);

  const nestedFixture = await createFixture(t);
  const externalNativeDirectory = path.join(nestedFixture.root, 'external-native-directory');
  await rename(nestedFixture.nativeDirectory, externalNativeDirectory);
  await symlink(externalNativeDirectory, nestedFixture.nativeDirectory);
  await assert.rejects(verifyFixture(nestedFixture), /native.*directory.*symbolic link/i);

  const nativeFixture = await createFixture(t);
  const externalNative = path.join(nativeFixture.root, 'external.node');
  await writeFile(externalNative, 'external native');
  await rm(nativeFixture.nativePath);
  await symlink(externalNative, nativeFixture.nativePath);
  await assert.rejects(verifyFixture(nativeFixture), /native.*module.*symbolic link/i);
});

test('requires exact plist identity, version, display name, executable, and icon fields', async (t) => {
  const cases = [
    ['CFBundleIdentifier', { ...PLIST, CFBundleIdentifier: 'com.example.wrong' }, /CFBundleIdentifier/],
    ['CFBundleShortVersionString', { ...PLIST, CFBundleShortVersionString: '0.2.0' }, /CFBundleShortVersionString/],
    ['CFBundleVersion', { ...PLIST, CFBundleVersion: '2' }, /CFBundleVersion/],
    ['display name', { ...PLIST, CFBundleDisplayName: 'Wrong', CFBundleName: 'Wrong' }, /CFBundleDisplayName/],
    ['executable', { ...PLIST, CFBundleExecutable: 'Other' }, /CFBundleExecutable.*Ineed LinkLab/],
    ['icon', { ...PLIST, CFBundleIconFile: '' }, /CFBundleIconFile.*nonblank/],
    ['icon name', { ...PLIST, CFBundleIconFile: 'other.icns' }, /CFBundleIconFile.*icon\.icns/],
  ];
  for (const [, plist, pattern] of cases) {
    const fixture = await createFixture(t);
    await assert.rejects(verifyFixture(fixture, createRunner({ plist })), pattern);
  }

  const nameFallbackFixture = await createFixture(t);
  const { CFBundleDisplayName: ignored, ...nameOnlyPlist } = PLIST;
  assert.equal(ignored, 'Ineed LinkLab');
  await assert.rejects(
    verifyFixture(nameFallbackFixture, createRunner({ plist: nameOnlyPlist })),
    /CFBundleDisplayName.*nonblank/,
  );
});

test('rejects plist leaf traversal, missing icon, and non-executable app binary', async (t) => {
  const traversalFixture = await createFixture(t);
  await assert.rejects(
    verifyFixture(traversalFixture, createRunner({
      plist: { ...PLIST, CFBundleExecutable: '../Ineed LinkLab' },
    })),
    /CFBundleExecutable.*leaf filename/i,
  );
  await assert.rejects(
    verifyFixture(traversalFixture, createRunner({
      plist: { ...PLIST, CFBundleIconFile: '../icon.icns' },
    })),
    /CFBundleIconFile.*leaf filename/i,
  );

  const iconFixture = await createFixture(t);
  await rm(iconFixture.iconPath);
  await assert.rejects(verifyFixture(iconFixture), /icon.*missing/i);

  const modeFixture = await createFixture(t);
  await chmod(modeFixture.executablePath, 0o644);
  await assert.rejects(verifyFixture(modeFixture), /executable permission bit/i);
});

test('requires nonempty HTML plus referenced nonempty JS and CSS ASAR entries', async (t) => {
  const cases = [
    [{ ...ASAR_FILES, 'dist/index.html': '' }, /(?:nonempty.*\.html|\.html.*nonempty)/i],
    [{
      'dist/index.html': '<link rel="stylesheet" href="./assets/main.css">',
      'dist/assets/main.css': 'body {}',
    }, /nonempty.*\.js/i],
    [{
      'dist/index.html': '<script src="./assets/main.js"></script>',
      'dist/assets/main.js': 'export {};',
    }, /nonempty.*\.css/i],
    [{ ...ASAR_FILES, 'dist/assets/main.js': '' }, /(?:nonempty.*\.js|\.js.*nonempty)/i],
    [{ ...ASAR_FILES, 'dist/assets/main.css': '' }, /(?:nonempty.*\.css|\.css.*nonempty)/i],
  ];
  for (const [files, pattern] of cases) {
    const fixture = await createFixture(t);
    await assert.rejects(
      verifyFixture(fixture, createRunner(), createAsarReader(files)),
      pattern,
    );
  }
});

test('rejects traversal, remote, protocol-relative, and dev-server ASAR references', async (t) => {
  const references = [
    '../outside.js',
    'https://example.test/main.js',
    '//example.test/main.js',
    'http://127.0.0.1:5173/src/main.js',
    '/Users/example/main.js',
  ];
  for (const reference of references) {
    const fixture = await createFixture(t);
    const files = {
      ...ASAR_FILES,
      'dist/index.html': `<link rel="stylesheet" href="./assets/main.css"><script src="${reference}"></script>`,
    };
    await assert.rejects(
      verifyFixture(fixture, createRunner(), createAsarReader(files)),
      /renderer asset reference.*local.*dist/i,
    );
  }
});

test('rejects remote references after a quoted HTML tag delimiter', async (t) => {
  const fixture = await createFixture(t);
  const files = {
    ...ASAR_FILES,
    'dist/index.html': [
      '<link rel="stylesheet" href="./assets/main.css">',
      '<script data-note=">" src="https://example.test/hidden.js"></script>',
      '<script src="./assets/main.js"></script>',
    ].join(''),
  };

  await assert.rejects(
    verifyFixture(fixture, createRunner(), createAsarReader(files)),
    /renderer asset reference.*local.*dist/i,
  );
});

test('rejects duplicate renderer asset attributes case-insensitively', async (t) => {
  const cases = [
    {
      html: [
        '<link rel="stylesheet" href="./assets/main.css">',
        '<script src="http://127.0.0.1:5173/dev.js" SRC="./assets/main.js"></script>',
      ].join(''),
      pattern: /duplicate renderer attribute.*src/i,
    },
    {
      html: [
        '<link rel="stylesheet" href="https://example.test/dev.css" HREF="./assets/main.css">',
        '<script src="./assets/main.js"></script>',
      ].join(''),
      pattern: /duplicate renderer attribute.*href/i,
    },
  ];

  for (const { html, pattern } of cases) {
    const fixture = await createFixture(t);
    const files = { ...ASAR_FILES, 'dist/index.html': html };
    await assert.rejects(
      verifyFixture(fixture, createRunner(), createAsarReader(files)),
      pattern,
    );
  }
});

test('rejects scheme-relative semantics, active base URLs, and decoded remote URLs', async (t) => {
  const cases = [
    {
      html: '<link rel="stylesheet" href="./assets/main.css"><script src="https:evil.test/main.js"></script>',
      extraFiles: { 'dist/evil.test/main.js': 'remote semantics disguised as local' },
      pattern: /renderer asset reference.*local.*dist/i,
    },
    {
      html: '<base href="https://example.test/"><link rel="stylesheet" href="./assets/main.css"><script src="./assets/main.js"></script>',
      extraFiles: {},
      pattern: /base.*not allowed/i,
    },
    {
      html: '<link rel="stylesheet" href="./assets/main.css"><script src="https&colon;//example.test/entity.js"></script>',
      extraFiles: { 'dist/https&colon;/example.test/entity.js': 'encoded remote semantics' },
      pattern: /renderer asset reference.*local.*dist/i,
    },
  ];

  for (const { html, extraFiles, pattern } of cases) {
    const fixture = await createFixture(t);
    const files = { ...ASAR_FILES, ...extraFiles, 'dist/index.html': html };
    await assert.rejects(
      verifyFixture(fixture, createRunner(), createAsarReader(files)),
      pattern,
    );
  }
});

test('rejects percent-decoded traversal even when its canonical ASAR entry exists', async (t) => {
  const fixture = await createFixture(t);
  const files = {
    ...ASAR_FILES,
    'dist/index.html': '<link rel="stylesheet" href="./assets/main.css"><script src="./assets/%2e%2e/main.js"></script>',
    'dist/main.js': 'encoded traversal reached this entry',
  };

  await assert.rejects(
    verifyFixture(fixture, createRunner(), createAsarReader(files)),
    /renderer asset reference.*local.*dist/i,
  );
});

test('ignores script and stylesheet markup in comments and raw-text script contents', async (t) => {
  const fixture = await createFixture(t);
  const files = {
    ...ASAR_FILES,
    'dist/index.html': [
      '<!doctype html>',
      '<!-- <script src="https://example.test/comment.js"></script> -->',
      '<!-- <link rel="stylesheet" href="https://example.test/comment.css"> -->',
      '<script>const markup = \'<script src="https://example.test/raw.js"><\\/script>\';</script>',
      '<link rel="stylesheet" href="./assets/main.css">',
      '<script src="./assets/main.js"></script>',
    ].join(''),
  };

  const result = await verifyFixture(fixture, createRunner(), createAsarReader(files));
  assert.deepEqual(result.rendererAssets, ['.css', '.html', '.js']);
});

test('requires a runtime-selected serial binding with the requested slice', async (t) => {
  const missingFixture = await createFixture(t);
  await rm(missingFixture.nativePath);
  await assert.rejects(verifyFixture(missingFixture), /bindings-cpp.*\.node/i);

  for (const [architecture, nativeDescription, nativeArchitectures, pattern] of [
    ['arm64', 'Mach-O 64-bit bundle x86_64', 'x86_64', /native.*requested arm64/i],
    ['x64', 'Mach-O 64-bit bundle arm64', 'arm64', /native.*requested x64/i],
    ['arm64', 'ASCII text arm64 bundle', 'arm64', /native.*Mach-O bundle/i],
    ['arm64', 'Mach-O 64-bit bundle arm64e', 'arm64e', /native.*requested arm64/i],
  ]) {
    const fixture = await createFixture(t, { architecture });
    await assert.rejects(
      verifyFixture(fixture, createRunner({
        architecture,
        nativeDescription,
        nativeArchitectures,
      })),
      pattern,
    );
  }
});

test('accepts a compatible runtime-selected binding and ignores non-selected candidates', async (t) => {
  const fixture = await createFixture(t);
  const alternatePath = path.join(
    fixture.unpackedPath,
    'node_modules',
    '@serialport',
    'bindings-cpp',
    'prebuilds',
    'darwin-x64',
    'alternate.node',
  );
  await mkdir(path.dirname(alternatePath), { recursive: true });
  await writeFile(alternatePath, 'alternate native module');
  const runner = createRunner();
  const execute = async (file, args, options) => {
    if (file === 'file' && args.at(-1) === alternatePath) {
      return { stdout: 'Mach-O 64-bit bundle x86_64', stderr: '' };
    }
    if (file === 'lipo' && args.at(-1) === alternatePath) {
      return { stdout: 'x86_64', stderr: '' };
    }
    return runner.execute(file, args, options);
  };

  const result = await verifyElectronMacPackage({
    architecture: fixture.architecture,
    releaseRoot: fixture.releaseRoot,
    execute,
    readAsarFile: createAsarReader().readAsarFile,
    inspectDmgApp: async ({ inspect }) => inspect(fixture.appPath),
  });

  assert.deepEqual(result.nativeModules, [fixture.nativePath]);
});

test('rejects when tuple preference selects an incompatible Universal prebuild', async (t) => {
  const fixture = await createFixture(t);
  const decoyPath = path.join(
    fixture.unpackedPath,
    'node_modules',
    '@serialport',
    'bindings-cpp',
    'prebuilds',
    'darwin-x64',
    'decoy.node',
  );
  await mkdir(path.dirname(decoyPath), { recursive: true });
  await writeFile(decoyPath, 'decoy with misleading target slice');

  const runner = createRunner({
    nativeArchitectures: (candidatePath) => (
      candidatePath === decoyPath ? 'arm64' : 'x86_64'
    ),
  });
  await assert.rejects(
    verifyFixture(fixture, runner),
    /runtime-selected.*arm64/i,
  );
  assert.deepEqual(
    runner.calls.filter(({ args }) => args.at(-1).endsWith('.node')),
    [
      expectedCommand('file', ['-b', fixture.nativePath]),
      expectedCommand('lipo', ['-archs', fixture.nativePath]),
    ],
  );
});

test('rejects when build Release precedence selects an incompatible binding', async (t) => {
  const fixture = await createFixture(t);
  const buildPath = path.join(
    fixture.unpackedPath,
    'node_modules',
    '@serialport',
    'bindings-cpp',
    'build',
    'Release',
    'bindings.node',
  );
  await mkdir(path.dirname(buildPath), { recursive: true });
  await writeFile(buildPath, 'incompatible local build');

  const runner = createRunner({
    nativeArchitectures: (candidatePath) => (
      candidatePath === buildPath ? 'x86_64' : 'x86_64 arm64'
    ),
  });
  await assert.rejects(
    verifyFixture(fixture, runner),
    /runtime-selected.*arm64/i,
  );
  assert.deepEqual(
    runner.calls.filter(({ args }) => args.at(-1).endsWith('.node')),
    [
      expectedCommand('file', ['-b', buildPath]),
      expectedCommand('lipo', ['-archs', buildPath]),
    ],
  );
});

test('rejects when Electron ABI tags select an incompatible prebuild', async (t) => {
  const fixture = await createFixture(t);
  const selectedPath = path.join(fixture.nativeDirectory, 'bindings.electron.abi148.node');
  const nonSelectedPath = path.join(fixture.nativeDirectory, 'bindings.node.napi.node');
  await rename(fixture.nativePath, selectedPath);
  await writeFile(nonSelectedPath, 'compatible but non-selected N-API binding');

  const runner = createRunner({
    nativeArchitectures: (candidatePath) => (
      candidatePath === selectedPath ? 'x86_64' : 'arm64'
    ),
  });
  await assert.rejects(
    verifyFixture(fixture, runner),
    /runtime-selected.*arm64/i,
  );
  assert.deepEqual(
    runner.calls.filter(({ args }) => args.at(-1).endsWith('.node')),
    [
      expectedCommand('file', ['-b', selectedPath]),
      expectedCommand('lipo', ['-archs', selectedPath]),
    ],
  );
});

test('classifies signing and verifies supported Developer ID signatures', async (t) => {
  const unsignedFixture = await createFixture(t);
  const inspectSigningError = Object.assign(new Error('code object is not signed at all'), {
    stderr: `${unsignedFixture.appPath}: code object is not signed at all`,
  });
  const unsigned = await verifyFixture(
    unsignedFixture,
    createRunner({ inspectSigningError }),
  );
  assert.equal(unsigned.signing, 'unsigned');

  const signedFixture = await createFixture(t);
  const signedRunner = createRunner({
    authority: 'Developer ID Application: Example Corp (TEAMID)',
  });
  const signed = await verifyFixture(signedFixture, signedRunner);
  assert.equal(signed.signing, 'developer-id');
  assert.deepEqual(signedRunner.calls.at(-1), expectedCommand('codesign', [
    '--verify',
    '--deep',
    '--strict',
    signedFixture.appPath,
  ]));

  const unsupportedFixture = await createFixture(t);
  await assert.rejects(
    verifyFixture(unsupportedFixture, createRunner({
      authority: 'Apple Development: Example Corp (TEAMID)',
    })),
    /unsupported signing identity/i,
  );

  const invalidFixture = await createFixture(t);
  await assert.rejects(
    verifyFixture(invalidFixture, createRunner({
      authority: 'Developer ID Application: Example Corp (TEAMID)',
      verifyError: new Error('invalid signature'),
    })),
    /invalid signature/i,
  );
});

async function createRealAsar(fixture) {
  const sourceRoot = path.join(fixture.root, `asar-source-${fixture.architecture}`);
  await mkdir(path.join(sourceRoot, 'dist', 'assets'), { recursive: true });
  await Promise.all(Object.entries(ASAR_FILES).map(async ([entryPath, contents]) => {
    await writeFile(path.join(sourceRoot, entryPath), contents);
  }));
  await createPackage(sourceRoot, fixture.asarPath);
}

test('direct invocation is symlink-safe, transactional across architectures, and uses real ASAR reading', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'electron-macos-package-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'scripts', 'verify-electron-macos-package.mjs');
  const bindingHelperPath = path.join(root, 'scripts', 'macos-dmg-app-binding.mjs');
  const manifestHelperPath = path.join(root, 'scripts', 'macos-app-manifest.py');
  const invocationPath = path.join(root, 'run-electron-verifier.mjs');
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await Promise.all([
    copyFile(fileURLToPath(new URL('./verify-electron-macos-package.mjs', import.meta.url)), scriptPath),
    copyFile(fileURLToPath(new URL('./macos-dmg-app-binding.mjs', import.meta.url)), bindingHelperPath),
    copyFile(fileURLToPath(new URL('./macos-app-manifest.py', import.meta.url)), manifestHelperPath),
  ]);
  await symlink(scriptPath, invocationPath);
  await mkdir(path.join(root, 'node_modules', '@electron'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '@serialport'), { recursive: true });
  const asarPackageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@electron/asar'))));
  await symlink(
    asarPackageRoot,
    path.join(root, 'node_modules', '@electron', 'asar'),
  );
  const parse5PackageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('parse5'))));
  await symlink(parse5PackageRoot, path.join(root, 'node_modules', 'parse5'));
  const bindingsPackageRoot = path.dirname(
    fileURLToPath(import.meta.resolve('@serialport/bindings-cpp/package.json')),
  );
  await symlink(
    bindingsPackageRoot,
    path.join(root, 'node_modules', '@serialport', 'bindings-cpp'),
  );
  const sourceMigrationPath = path.join(
    root,
    'packages',
    'persistence-contract',
    'migrations',
    '001-initial.sql',
  );
  const sourceSettingsSchemaPath = path.join(
    root,
    'packages',
    'runtime-contract',
    'src',
    'settingsSchema.json',
  );
  await Promise.all([
    mkdir(path.dirname(sourceMigrationPath), { recursive: true }),
    mkdir(path.dirname(sourceSettingsSchemaPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(sourceMigrationPath, MIGRATION_SQL),
    writeFile(sourceSettingsSchemaPath, SETTINGS_SCHEMA),
  ]);

  const fixtures = [];
  for (const architecture of ['arm64', 'x64']) {
    const fixture = await createFixture(t, {
      architecture,
      root,
      cleanup: false,
      releaseRoot: path.join(root, 'apps', 'electron', 'release', architecture),
    });
    await createRealAsar(fixture);
    await writeFile(fixture.executablePath, `fixture executable ${architecture}`);
    await writeFile(fixture.dmgPath, fixture.appPath);
    fixtures.push(fixture);
  }

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
const target = process.argv.at(-1);
if (target.endsWith('.node')) {
  process.stdout.write('Mach-O universal binary with 2 architectures: [x86_64] [arm64] bundle\\n');
} else {
  const architecture = fs.readFileSync(target, 'utf8').includes('x64') ? 'x86_64' : 'arm64';
  process.stdout.write(\`Mach-O 64-bit executable \${architecture}\\n\`);
}
`,
    lipo: `#!/usr/bin/env node
const fs = require('node:fs');
const target = process.argv.at(-1);
if (target.endsWith('.node')) {
  process.stdout.write('x86_64 arm64\\n');
} else {
  process.stdout.write(fs.readFileSync(target, 'utf8').includes('x64') ? 'x86_64\\n' : 'arm64\\n');
}
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

  const success = await execFileAsync(process.execPath, [invocationPath], options);
  const lines = success.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ELECTRON_MAC_PACKAGE_RESULT=/);
  const expectedResults = await Promise.all(fixtures.map(async (fixture) => ({
    appPath: await realpath(fixture.appPath),
    dmgPath: await realpath(fixture.dmgPath),
    architecture: fixture.architecture,
    bundleIdentifier: 'com.ineedfull.dev-tool.electron',
    signing: 'unsigned',
    rendererAssets: ['.css', '.html', '.js'],
    nativeModules: [await realpath(fixture.nativePath)],
  })));
  assert.deepEqual(
    JSON.parse(lines[0].slice('ELECTRON_MAC_PACKAGE_RESULT='.length)),
    expectedResults,
  );

  await rm(fixtures[1].dmgPath);
  await assert.rejects(
    execFileAsync(process.execPath, [invocationPath], options),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.equal(error.stdout, '');
      assert.doesNotMatch(error.stdout, /ELECTRON_MAC_PACKAGE_RESULT=/);
      assert.match(error.stderr, /release\/x64/);
      assert.match(error.stderr, /exactly one.*DMG.*found 0/i);
      return true;
    },
  );
});
