import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
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
  collectMacDmgs,
  defaultSources,
} from './collect-macos-dmgs.mjs';

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
const OWNED_ARTIFACT_PATTERN = /^\.ineed-dmg-collection-.+-(?:stage|backup)$/;

async function createCollectionFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mac-dmg-collection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts', 'macos');
  const sources = [];
  const sourcePaths = [];

  for (const [index, [runtime, architecture]] of MATRIX.entries()) {
    const sourceDirectory = path.join(root, 'sources', runtime, architecture);
    const sourcePath = path.join(sourceDirectory, `framework-${index}.dmg`);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, `${runtime}:${architecture}:fixture`);
    sources.push({ runtime, architecture, sourceDirectory });
    sourcePaths.push(sourcePath);
  }

  return {
    root,
    artifactRoot,
    sources,
    sourcePaths,
    options: { artifactRoot, sources },
  };
}

async function expectedRecords(fixture) {
  const canonicalArtifactRoot = await realpath(fixture.artifactRoot);
  return MATRIX.map(([runtime, architecture], index) => ({
    runtime,
    architecture,
    sourcePath: fixture.sourcePaths[index],
    destinationPath: path.join(canonicalArtifactRoot, EXPECTED_NAMES[index]),
  }));
}

async function seedPreviousDestinations(fixture) {
  await mkdir(fixture.artifactRoot, { recursive: true });
  const previousContents = EXPECTED_NAMES.map((name, index) => `previous:${index}:${name}`);
  await Promise.all(EXPECTED_NAMES.map((name, index) => (
    writeFile(path.join(fixture.artifactRoot, name), previousContents[index])
  )));
  return previousContents;
}

async function readDestinationContents(artifactRoot) {
  return Promise.all(EXPECTED_NAMES.map((name) => (
    readFile(path.join(artifactRoot, name), 'utf8')
  )));
}

async function assertNoOwnedResidue(artifactRoot) {
  const names = await readdir(artifactRoot);
  assert.deepEqual(names.filter((name) => OWNED_ARTIFACT_PATTERN.test(name)), []);
}

test('exports the repository artifact root and exact default source matrix', () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

  assert.equal(DEFAULT_ARTIFACT_ROOT, path.join(repositoryRoot, 'artifacts', 'macos'));
  assert.deepEqual(defaultSources(), [
    {
      runtime: 'electron',
      architecture: 'arm64',
      sourceDirectory: path.join(repositoryRoot, 'apps', 'electron', 'release', 'arm64'),
    },
    {
      runtime: 'electron',
      architecture: 'x64',
      sourceDirectory: path.join(repositoryRoot, 'apps', 'electron', 'release', 'x64'),
    },
    {
      runtime: 'tauri',
      architecture: 'arm64',
      sourceDirectory: path.join(
        repositoryRoot,
        'apps',
        'tauri',
        'src-tauri',
        'target',
        'aarch64-apple-darwin',
        'release',
        'bundle',
        'dmg',
      ),
    },
    {
      runtime: 'tauri',
      architecture: 'x64',
      sourceDirectory: path.join(
        repositoryRoot,
        'apps',
        'tauri',
        'src-tauri',
        'target',
        'x86_64-apple-darwin',
        'release',
        'bundle',
        'dmg',
      ),
    },
  ]);
});

test('collects exactly four nonempty DMGs in stable matrix order', async (t) => {
  const fixture = await createCollectionFixture(t);

  const result = await collectMacDmgs(fixture.options);

  assert.deepEqual(result, await expectedRecords(fixture));
  assert.deepEqual((await readdir(fixture.artifactRoot)).sort(), [...EXPECTED_NAMES]);
  for (const [index, name] of EXPECTED_NAMES.entries()) {
    const destinationPath = path.join(fixture.artifactRoot, name);
    assert.equal(await readFile(destinationPath, 'utf8'), `${MATRIX[index].join(':')}:fixture`);
    const metadata = await lstat(destinationPath);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.ok(metadata.size > 0);
  }
});

test('replaces all four known destinations as one successful generation', async (t) => {
  const fixture = await createCollectionFixture(t);
  await mkdir(fixture.artifactRoot, { recursive: true });
  await Promise.all(EXPECTED_NAMES.map((name, index) => (
    writeFile(path.join(fixture.artifactRoot, name), index === 0 ? '' : 'stale known artifact')
  )));
  await writeFile(path.join(fixture.artifactRoot, 'release-notes.txt'), 'preserve me');

  await collectMacDmgs(fixture.options);

  assert.equal(
    await readFile(path.join(fixture.artifactRoot, 'release-notes.txt'), 'utf8'),
    'preserve me',
  );
  for (const [index, name] of EXPECTED_NAMES.entries()) {
    assert.equal(
      await readFile(path.join(fixture.artifactRoot, name), 'utf8'),
      `${MATRIX[index].join(':')}:fixture`,
    );
  }
});

test('removes a staged copy when validation fails after file creation', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  let rejectedStage = false;
  const fileSystem = {
    ...fsPromises,
    async lstat(targetPath) {
      const metadata = await fsPromises.lstat(targetPath);
      if (!rejectedStage && OWNED_ARTIFACT_PATTERN.test(path.basename(targetPath))) {
        rejectedStage = true;
        return {
          isFile: () => false,
          isSymbolicLink: () => false,
          size: metadata.size,
        };
      }
      return metadata;
    },
  };

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    /staged DMG.*real regular file/i,
  );
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('rolls back every backup and install rename failure without mixing generations', async (t) => {
  for (let failAt = 1; failAt <= 8; failAt += 1) {
    await t.test(`transaction rename ${failAt}`, async (t) => {
      const fixture = await createCollectionFixture(t);
      const previousContents = await seedPreviousDestinations(fixture);
      const injectedError = new Error(`injected transaction rename ${failAt}`);
      let transactionRenameCount = 0;
      const fileSystem = {
        ...fsPromises,
        async rename(sourcePath, destinationPath) {
          if (
            OWNED_ARTIFACT_PATTERN.test(path.basename(sourcePath))
            || OWNED_ARTIFACT_PATTERN.test(path.basename(destinationPath))
          ) {
            transactionRenameCount += 1;
            if (transactionRenameCount === failAt) {
              throw injectedError;
            }
          }
          return fsPromises.rename(sourcePath, destinationPath);
        },
      };

      await assert.rejects(
        collectMacDmgs({ ...fixture.options, fileSystem }),
        (error) => error === injectedError,
      );
      assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
      await assertNoOwnedResidue(fixture.artifactRoot);
    });
  }
});

test('commits a validated generation and reports backup cleanup errors without rejecting', async (t) => {
  const fixture = await createCollectionFixture(t);
  await seedPreviousDestinations(fixture);
  const cleanupError = new Error('injected backup cleanup failure');
  let injected = false;
  const fileSystem = {
    ...fsPromises,
    async rm(targetPath, options) {
      if (
        !injected
        && path.basename(targetPath).endsWith('-backup')
      ) {
        injected = true;
        throw cleanupError;
      }
      return fsPromises.rm(targetPath, options);
    },
  };
  const reportedCleanupErrors = [];

  const result = await collectMacDmgs({
    ...fixture.options,
    fileSystem,
    onCleanupError: (error) => reportedCleanupErrors.push(error),
  });

  assert.deepEqual(
    await readDestinationContents(fixture.artifactRoot),
    MATRIX.map(([runtime, architecture]) => `${runtime}:${architecture}:fixture`),
  );
  assert.deepEqual(reportedCleanupErrors, [cleanupError]);
  assert.equal(Object.hasOwn(result, 'cleanupErrors'), false);
  assert.equal(
    (await readdir(fixture.artifactRoot)).filter((name) => name.endsWith('-backup')).length,
    1,
  );
});

test('contains synchronous and asynchronous cleanup diagnostic failures after commit', async (t) => {
  for (const callbackKind of ['synchronous', 'asynchronous']) {
    await t.test(callbackKind, async (t) => {
      const fixture = await createCollectionFixture(t);
      await seedPreviousDestinations(fixture);
      const cleanupError = new Error(`injected ${callbackKind} cleanup failure`);
      const callbackError = new Error(`injected ${callbackKind} callback failure`);
      const reportedCleanupErrors = [];
      const fallbackDiagnostics = [];
      const originalConsoleError = console.error;
      console.error = (...args) => fallbackDiagnostics.push(args.join(' '));
      t.after(() => {
        console.error = originalConsoleError;
      });
      let injected = false;
      const fileSystem = {
        ...fsPromises,
        async rm(targetPath, options) {
          if (!injected && path.basename(targetPath).endsWith('-backup')) {
            injected = true;
            throw cleanupError;
          }
          return fsPromises.rm(targetPath, options);
        },
      };
      const onCleanupError = callbackKind === 'synchronous'
        ? (error) => {
            reportedCleanupErrors.push(error);
            throw callbackError;
          }
        : async (error) => {
            reportedCleanupErrors.push(error);
            throw callbackError;
          };

      const result = await collectMacDmgs({
        ...fixture.options,
        fileSystem,
        onCleanupError,
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(result.length, 4);
      assert.deepEqual(reportedCleanupErrors, [cleanupError]);
      assert.match(fallbackDiagnostics.join('\n'), new RegExp(cleanupError.message));
      assert.match(fallbackDiagnostics.join('\n'), new RegExp(callbackError.message));
      assert.deepEqual(
        await readDestinationContents(fixture.artifactRoot),
        MATRIX.map(([runtime, architecture]) => `${runtime}:${architecture}:fixture`),
      );
    });
  }
});

test('rolls back installed destinations when final validation fails', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  const canonicalArtifactRoot = await realpath(fixture.artifactRoot);
  const validationError = new Error('injected final artifact validation failure');
  let artifactReads = 0;
  const fileSystem = {
    ...fsPromises,
    async readdir(targetPath, options) {
      if (await realpath(targetPath) === canonicalArtifactRoot) {
        artifactReads += 1;
        if (artifactReads === 2) {
          throw validationError;
        }
      }
      return fsPromises.readdir(targetPath, options);
    },
  };

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    (error) => error === validationError,
  );
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

function injectHardlinkAfterFinalInstallRename(replaceInstalledDestination) {
  let installRenames = 0;
  return {
    ...fsPromises,
    async rename(sourcePath, destinationPath) {
      await fsPromises.rename(sourcePath, destinationPath);
      if (path.basename(sourcePath).endsWith('-stage')) {
        installRenames += 1;
        if (installRenames === MATRIX.length) {
          await replaceInstalledDestination();
        }
      }
    },
  };
}

test('rolls back when a final destination is hard-linked to a source', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  const originalSourceContents = await readFile(fixture.sourcePaths[0], 'utf8');
  const destinationPath = path.join(fixture.artifactRoot, EXPECTED_NAMES[0]);
  const fileSystem = injectHardlinkAfterFinalInstallRename(async () => {
    await rm(destinationPath);
    await link(fixture.sourcePaths[0], destinationPath);
  });

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    /matrix.*identity|identity.*source.*destination/i,
  );

  assert.equal(await readFile(fixture.sourcePaths[0], 'utf8'), originalSourceContents);
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('rolls back when final destinations are hard-linked to each other', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  const firstDestinationPath = path.join(fixture.artifactRoot, EXPECTED_NAMES[0]);
  const secondDestinationPath = path.join(fixture.artifactRoot, EXPECTED_NAMES[1]);
  const fileSystem = injectHardlinkAfterFinalInstallRename(async () => {
    await rm(secondDestinationPath);
    await link(firstDestinationPath, secondDestinationPath);
  });

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    /matrix.*identity|identity.*destinations/i,
  );

  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('rejects in-place source mutation between validation and copy', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  let mutated = false;
  const fileSystem = {
    ...fsPromises,
    async copyFile(sourcePath, destinationPath, mode) {
      if (!mutated) {
        mutated = true;
        await writeFile(sourcePath, 'mutated in place before delegated copy');
      }
      return fsPromises.copyFile(sourcePath, destinationPath, mode);
    },
  };

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    /source DMG content changed during copy/i,
  );
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('rejects an earlier source mutation while later sources are staged', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  let copies = 0;
  const fileSystem = {
    ...fsPromises,
    async copyFile(sourcePath, destinationPath, mode) {
      copies += 1;
      if (copies === 2) {
        await writeFile(fixture.sourcePaths[0], 'mutated after its stage was validated');
      }
      return fsPromises.copyFile(sourcePath, destinationPath, mode);
    },
  };

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    /source DMG changed before transaction/i,
  );
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

function mutateDuringSecondPreTransactionOpen(fixture, mutate) {
  const sourceOpenCounts = new Map();
  return {
    ...fsPromises,
    async open(targetPath, flags) {
      const count = (sourceOpenCounts.get(targetPath) ?? 0) + 1;
      sourceOpenCounts.set(targetPath, count);
      if (targetPath === fixture.sourcePaths[1] && count === 2) {
        await mutate();
      }
      return fsPromises.open(targetPath, flags);
    },
  };
}

test('rolls back when an earlier source changes during later pre-transaction validation', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  const fileSystem = mutateDuringSecondPreTransactionOpen(fixture, async () => {
    await writeFile(fixture.sourcePaths[0], 'source zero changed after its validation');
  });

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    /matrix.*source|source.*before commit/i,
  );
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('rolls back when an earlier stage changes during later pre-transaction validation', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  const fileSystem = mutateDuringSecondPreTransactionOpen(fixture, async () => {
    const stageName = (await readdir(fixture.artifactRoot))
      .find((name) => name.endsWith('-0-stage'));
    assert.equal(typeof stageName, 'string');
    await writeFile(path.join(fixture.artifactRoot, stageName), 'stage zero changed after validation');
  });

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    /matrix.*destination|stage.*before commit/i,
  );
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('preserves a source operation error when closing its handle also fails', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  const operationError = new Error('injected source copy failure');
  const closeError = new Error('injected source handle close failure');
  let closeCalls = 0;
  const fileSystem = {
    ...fsPromises,
    async open(targetPath, flags) {
      const handle = await fsPromises.open(targetPath, flags);
      return {
        stat: (...args) => handle.stat(...args),
        createReadStream: (...args) => handle.createReadStream(...args),
        async close() {
          closeCalls += 1;
          await handle.close();
          throw closeError;
        },
      };
    },
    async copyFile() {
      throw operationError;
    },
  };

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    (error) => (
      error === operationError
      && Array.isArray(error.rollbackErrors)
      && error.rollbackErrors.includes(closeError)
    ),
  );
  assert.equal(closeCalls, 1);
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('uses a source handle close error as primary only after successful body work', async (t) => {
  const fixture = await createCollectionFixture(t);
  const previousContents = await seedPreviousDestinations(fixture);
  const closeError = new Error('injected close-only failure');
  let injected = false;
  const fileSystem = {
    ...fsPromises,
    async open(targetPath, flags) {
      const handle = await fsPromises.open(targetPath, flags);
      return {
        stat: (...args) => handle.stat(...args),
        createReadStream: (...args) => handle.createReadStream(...args),
        async close() {
          await handle.close();
          if (!injected) {
            injected = true;
            throw closeError;
          }
        },
      };
    },
  };

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, fileSystem }),
    (error) => error === closeError,
  );
  assert.deepEqual(await readDestinationContents(fixture.artifactRoot), previousContents);
  await assertNoOwnedResidue(fixture.artifactRoot);
});

test('closes every source and installed destination handle on success', async (t) => {
  const fixture = await createCollectionFixture(t);
  let openedHandles = 0;
  let closedHandles = 0;
  const fileSystem = {
    ...fsPromises,
    async open(targetPath, flags) {
      const handle = await fsPromises.open(targetPath, flags);
      openedHandles += 1;
      return {
        stat: (...args) => handle.stat(...args),
        createReadStream: (...args) => handle.createReadStream(...args),
        async close() {
          closedHandles += 1;
          return handle.close();
        },
      };
    },
  };

  const result = await collectMacDmgs({ ...fixture.options, fileSystem });

  assert.equal(result.length, 4);
  assert.ok(openedHandles > 0);
  assert.equal(closedHandles, openedHandles);
});

test('rejects a missing source DMG', async (t) => {
  const fixture = await createCollectionFixture(t);
  await rm(fixture.sourcePaths[1]);

  await assert.rejects(collectMacDmgs(fixture.options), /exactly one.*\.dmg.*found 0/i);
});

test('rejects duplicate source DMGs', async (t) => {
  const fixture = await createCollectionFixture(t);
  await writeFile(path.join(fixture.sources[2].sourceDirectory, 'second.dmg'), 'duplicate');

  await assert.rejects(collectMacDmgs(fixture.options), /exactly one.*\.dmg.*found 2/i);
});

test('rejects an empty source DMG', async (t) => {
  const fixture = await createCollectionFixture(t);
  await writeFile(fixture.sourcePaths[0], '');

  await assert.rejects(collectMacDmgs(fixture.options), /nonempty.*DMG|DMG.*nonempty/i);
});

test('rejects a source DMG symlink', async (t) => {
  const fixture = await createCollectionFixture(t);
  const targetPath = path.join(fixture.root, 'target.dmg');
  await writeFile(targetPath, 'target');
  await rm(fixture.sourcePaths[0]);
  await symlink(targetPath, fixture.sourcePaths[0]);

  await assert.rejects(collectMacDmgs(fixture.options), /DMG.*symbolic link/i);
});

test('rejects a source directory symlink', async (t) => {
  const fixture = await createCollectionFixture(t);
  const realDirectory = fixture.sources[0].sourceDirectory;
  const linkDirectory = path.join(fixture.root, 'linked-source');
  await symlink(realDirectory, linkDirectory);
  fixture.sources[0] = { ...fixture.sources[0], sourceDirectory: linkDirectory };

  await assert.rejects(collectMacDmgs(fixture.options), /source directory.*symbolic link/i);
});

test('rejects hard-linked source DMGs by device and inode identity', async (t) => {
  const fixture = await createCollectionFixture(t);
  await rm(fixture.sourcePaths[1]);
  await link(fixture.sourcePaths[0], fixture.sourcePaths[1]);

  await assert.rejects(collectMacDmgs(fixture.options), /duplicate source DMG/i);
});

test('rejects unsupported, duplicate, and incomplete matrix keys before copying', async (t) => {
  const fixture = await createCollectionFixture(t);
  const unsupported = fixture.sources.map((source) => ({ ...source }));
  unsupported[0].runtime = 'web';
  await assert.rejects(
    collectMacDmgs({ ...fixture.options, sources: unsupported }),
    /unsupported.*runtime.*architecture|unsupported.*matrix/i,
  );

  const duplicate = fixture.sources.map((source) => ({ ...source }));
  duplicate[1].architecture = 'arm64';
  await assert.rejects(
    collectMacDmgs({ ...fixture.options, sources: duplicate }),
    /duplicate.*electron:arm64/i,
  );
  await assert.rejects(
    collectMacDmgs({
      ...fixture.options,
      sources: [...fixture.sources, { ...fixture.sources[0] }],
    }),
    /duplicate.*electron:arm64/i,
  );

  await assert.rejects(
    collectMacDmgs({ ...fixture.options, sources: fixture.sources.slice(0, 3) }),
    /exactly four|missing.*tauri:x64/i,
  );
  await assert.rejects(lstat(fixture.artifactRoot), { code: 'ENOENT' });
});

test('rejects an artifact root symlink', async (t) => {
  const fixture = await createCollectionFixture(t);
  const realArtifactRoot = path.join(fixture.root, 'real-artifacts');
  await mkdir(realArtifactRoot);
  await mkdir(path.dirname(fixture.artifactRoot), { recursive: true });
  await symlink(realArtifactRoot, fixture.artifactRoot);

  await assert.rejects(collectMacDmgs(fixture.options), /artifact root.*symbolic link/i);
});

test('canonicalizes a symlinked artifact ancestor before creating the root', async (t) => {
  const fixture = await createCollectionFixture(t);
  const controlledDirectory = path.join(fixture.root, 'controlled-artifacts');
  const lexicalAncestor = path.join(fixture.root, 'artifact-link');
  await mkdir(controlledDirectory);
  await symlink(controlledDirectory, lexicalAncestor);
  fixture.options.artifactRoot = path.join(lexicalAncestor, 'nested', 'macos');
  const canonicalArtifactRoot = path.join(
    await realpath(controlledDirectory),
    'nested',
    'macos',
  );

  const result = await collectMacDmgs(fixture.options);

  assert.deepEqual(
    result.map(({ destinationPath }) => destinationPath),
    EXPECTED_NAMES.map((name) => path.join(canonicalArtifactRoot, name)),
  );
  assert.deepEqual((await readdir(canonicalArtifactRoot)).sort(), [...EXPECTED_NAMES]);
});

test('rejects an unexpected fifth stale DMG before replacing known artifacts', async (t) => {
  const fixture = await createCollectionFixture(t);
  await mkdir(fixture.artifactRoot, { recursive: true });
  await writeFile(path.join(fixture.artifactRoot, EXPECTED_NAMES[0]), 'known old value');
  await writeFile(path.join(fixture.artifactRoot, 'stale-fifth.dmg'), 'stale');

  await assert.rejects(collectMacDmgs(fixture.options), /unexpected.*stale-fifth\.dmg/i);
  assert.equal(
    await readFile(path.join(fixture.artifactRoot, EXPECTED_NAMES[0]), 'utf8'),
    'known old value',
  );
});

test('rejects stale collector-owned stage and backup files', async (t) => {
  const fixture = await createCollectionFixture(t);
  await mkdir(fixture.artifactRoot, { recursive: true });
  for (const suffix of ['stage', 'backup']) {
    const stalePath = path.join(
      fixture.artifactRoot,
      `.ineed-dmg-collection-stale-0-${suffix}`,
    );
    await writeFile(stalePath, 'stale transaction artifact');
    await assert.rejects(
      collectMacDmgs(fixture.options),
      /stale collector-owned.*(?:stage|backup)/i,
    );
    await rm(stalePath);
  }
});

test('rejects a known destination symlink without touching its target', async (t) => {
  const fixture = await createCollectionFixture(t);
  const targetPath = path.join(fixture.root, 'outside-target.dmg');
  await writeFile(targetPath, 'outside target');
  await mkdir(fixture.artifactRoot, { recursive: true });
  await symlink(targetPath, path.join(fixture.artifactRoot, EXPECTED_NAMES[0]));

  await assert.rejects(collectMacDmgs(fixture.options), /destination.*symbolic link/i);
  assert.equal(await readFile(targetPath, 'utf8'), 'outside target');
});

async function createCliRepository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mac-dmg-collection-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptsDirectory = path.join(root, 'scripts');
  const scriptPath = path.join(scriptsDirectory, 'collect-macos-dmgs.mjs');
  const invocationPath = path.join(root, 'collect-link.mjs');
  await mkdir(scriptsDirectory, { recursive: true });
  await Promise.all([
    copyFile(fileURLToPath(new URL('./collect-macos-dmgs.mjs', import.meta.url)), scriptPath),
    copyFile(
      fileURLToPath(new URL('./macos-package-matrix.mjs', import.meta.url)),
      path.join(scriptsDirectory, 'macos-package-matrix.mjs'),
    ),
  ]);
  await symlink(scriptPath, invocationPath);

  const sourcePaths = [];
  const relativeDirectories = [
    ['apps', 'electron', 'release', 'arm64'],
    ['apps', 'electron', 'release', 'x64'],
    ['apps', 'tauri', 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'dmg'],
    ['apps', 'tauri', 'src-tauri', 'target', 'x86_64-apple-darwin', 'release', 'bundle', 'dmg'],
  ];
  for (const [index, segments] of relativeDirectories.entries()) {
    const sourceDirectory = path.join(root, ...segments);
    const sourcePath = path.join(sourceDirectory, `framework-${index}.dmg`);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, `cli:${index}`);
    sourcePaths.push(sourcePath);
  }
  return { invocationPath, root, sourcePaths };
}

test('direct symlink invocation prints one result only after full success', async (t) => {
  const fixture = await createCliRepository(t);

  const success = await execFileAsync(process.execPath, [fixture.invocationPath], {
    encoding: 'utf8',
  });

  const lines = success.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^MAC_DMG_COLLECTION_RESULT=/);
  assert.deepEqual(
    JSON.parse(lines[0].slice('MAC_DMG_COLLECTION_RESULT='.length))
      .map(({ runtime, architecture, destinationPath }) => ({
        runtime,
        architecture,
        destinationName: path.basename(destinationPath),
      })),
    MATRIX.map(([runtime, architecture], index) => ({
      runtime,
      architecture,
      destinationName: EXPECTED_NAMES[index],
    })),
  );

  const artifactRoot = path.join(fixture.root, 'artifacts', 'macos');
  const previousContents = await readDestinationContents(artifactRoot);
  await rm(fixture.sourcePaths[1]);
  await assert.rejects(
    execFileAsync(process.execPath, [fixture.invocationPath], { encoding: 'utf8' }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.equal(error.stdout, '');
      assert.doesNotMatch(error.stdout, /MAC_DMG_COLLECTION_RESULT=/);
      return true;
    },
  );
  assert.deepEqual(await readDestinationContents(artifactRoot), previousContents);
  await assertNoOwnedResidue(artifactRoot);
});
