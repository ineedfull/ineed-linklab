import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MANIFEST_HELPER_PATH = fileURLToPath(
  new URL('./macos-app-manifest.py', import.meta.url),
);
const MANIFEST_MAX_BUFFER = 64 * 1024 * 1024;
const MANIFEST_TIMEOUT_MILLISECONDS = 120_000;
const MANIFEST_ENVIRONMENT_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR'];

function comparePaths(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function requireExactFields(entry, fields, label, relativePath) {
  const actualFields = Object.keys(entry).sort(comparePaths);
  const expectedFields = [...fields].sort(comparePaths);
  if (
    actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new TypeError(
      `${label} entry ${relativePath} must contain exact fields: ${expectedFields.join(', ')}`,
    );
  }
}

function requirePermissionMode(entry, label, relativePath) {
  if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
    throw new TypeError(
      `${label} entry ${relativePath} mode must be an integer between 0 and 0o7777`,
    );
  }
}

function validateManifest(manifest, label) {
  if (!Array.isArray(manifest)) {
    throw new TypeError(`${label} must be an array`);
  }
  const seenPaths = new Set();

  for (const entry of manifest) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${label} entries must be objects`);
    }
    const relativePath = entry.path;
    if (
      typeof relativePath !== 'string'
      || relativePath === ''
      || relativePath.includes('\0')
      || relativePath.includes('\\')
      || path.posix.isAbsolute(relativePath)
      || path.posix.normalize(relativePath) !== relativePath
      || relativePath === '..'
      || relativePath.startsWith('../')
    ) {
      throw new TypeError(`${label} entry path must be a safe relative POSIX path`);
    }
    if (seenPaths.has(relativePath)) {
      throw new TypeError(`${label} contains duplicate path: ${relativePath}`);
    }
    seenPaths.add(relativePath);

    if (entry.type === 'directory') {
      requireExactFields(entry, ['mode', 'path', 'type'], label, relativePath);
      requirePermissionMode(entry, label, relativePath);
      continue;
    }
    if (relativePath === '.') {
      throw new TypeError(`${label} root entry must be a directory`);
    }
    if (entry.type === 'symlink') {
      requireExactFields(entry, ['path', 'target', 'type'], label, relativePath);
      if (typeof entry.target !== 'string') {
        throw new TypeError(`${label} symlink ${relativePath} target must be a string`);
      }
      continue;
    }
    if (entry.type === 'file') {
      requireExactFields(entry, ['bytes', 'mode', 'path', 'sha256', 'type'], label, relativePath);
      requirePermissionMode(entry, label, relativePath);
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new TypeError(`${label} file ${relativePath} bytes must be a nonnegative safe integer`);
      }
      if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new TypeError(`${label} file ${relativePath} SHA-256 must be 64 lowercase hex characters`);
      }
      continue;
    }
    throw new TypeError(`${label} entry ${relativePath} has an unsupported type`);
  }
  const rootEntry = manifest.find((entry) => entry.path === '.');
  if (rootEntry === undefined) {
    throw new TypeError(`${label} must contain one app root directory entry at .`);
  }
  return manifest;
}

function manifestPythonExecutable() {
  if (process.platform === 'darwin') {
    return '/usr/bin/python3';
  }
  if (process.env.PYTHON !== undefined) {
    if (process.env.PYTHON.trim() === '' || process.env.PYTHON.includes('\0')) {
      throw new TypeError('PYTHON must name a nonblank executable');
    }
    return process.env.PYTHON;
  }
  return 'python3';
}

function manifestEnvironment() {
  const environment = {};
  for (const key of MANIFEST_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== '' && !value.includes('\0')) {
      environment[key] = value;
    }
  }
  return environment;
}

export async function createAppManifest(appPath) {
  if (typeof appPath !== 'string' || appPath.trim() === '') {
    throw new TypeError('App root path must be a nonblank string');
  }
  const resolvedAppPath = path.resolve(appPath);
  const pythonExecutable = manifestPythonExecutable();
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      pythonExecutable,
      ['-I', MANIFEST_HELPER_PATH, resolvedAppPath],
      {
        encoding: 'utf8',
        env: manifestEnvironment(),
        maxBuffer: MANIFEST_MAX_BUFFER,
        timeout: MANIFEST_TIMEOUT_MILLISECONDS,
      },
    ));
  } catch (error) {
    const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT';
    const helperDetail = timedOut
      ? `timed out after ${MANIFEST_TIMEOUT_MILLISECONDS}ms`
      : typeof error?.stderr === 'string' && error.stderr.trim() !== ''
        ? error.stderr.trim()
        : error?.message ?? String(error);
    throw new Error(
      `App manifest helper failed for ${resolvedAppPath}: ${helperDetail}`,
      { cause: error },
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(stdout);
  } catch (error) {
    throw new Error('App manifest helper returned malformed JSON', { cause: error });
  }
  return validateManifest(manifest, 'helper manifest');
}

function mismatch(context, relativePath, kind) {
  throw new Error(`${context}: manifest mismatch at ${relativePath}: ${kind}`);
}

export function assertAppManifestsEqual(expected, actual, context) {
  validateManifest(expected, 'expected manifest');
  validateManifest(actual, 'actual manifest');
  const expectedEntries = [...expected].sort((left, right) => comparePaths(left.path, right.path));
  const actualEntries = [...actual].sort((left, right) => comparePaths(left.path, right.path));
  let expectedIndex = 0;
  let actualIndex = 0;

  while (expectedIndex < expectedEntries.length || actualIndex < actualEntries.length) {
    const expectedEntry = expectedEntries[expectedIndex];
    const actualEntry = actualEntries[actualIndex];

    if (!actualEntry || (expectedEntry && expectedEntry.path < actualEntry.path)) {
      mismatch(context, expectedEntry.path, 'missing entry');
    }
    if (!expectedEntry || actualEntry.path < expectedEntry.path) {
      mismatch(context, actualEntry.path, 'unexpected entry');
    }
    if (expectedEntry.type !== actualEntry.type) {
      mismatch(context, expectedEntry.path, 'type difference');
    }
    if (
      (expectedEntry.type === 'directory' || expectedEntry.type === 'file')
      && expectedEntry.mode !== actualEntry.mode
    ) {
      mismatch(context, expectedEntry.path, 'mode difference');
    }
    if (expectedEntry.type === 'symlink' && expectedEntry.target !== actualEntry.target) {
      mismatch(context, expectedEntry.path, 'link target difference');
    }
    if (expectedEntry.type === 'file' && expectedEntry.bytes !== actualEntry.bytes) {
      mismatch(context, expectedEntry.path, 'byte size difference');
    }
    if (expectedEntry.type === 'file' && expectedEntry.sha256 !== actualEntry.sha256) {
      mismatch(context, expectedEntry.path, 'SHA-256 difference');
    }

    expectedIndex += 1;
    actualIndex += 1;
  }
}

function defaultExecute(file, args, options) {
  return execFileAsync(file, args, options);
}

function commandStdout(result, commandName) {
  const stdout = typeof result === 'string' ? result : result?.stdout;
  if (typeof stdout !== 'string') {
    throw new Error(`${commandName} did not return text output`);
  }
  return stdout;
}

function validateExpectedAppName(expectedAppName) {
  if (
    typeof expectedAppName !== 'string'
    || expectedAppName.trim() === ''
    || expectedAppName !== path.basename(expectedAppName)
    || expectedAppName === '.'
    || expectedAppName === '..'
  ) {
    throw new TypeError('Expected app name must be a safe leaf name');
  }
}

function isContainedBy(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath !== ''
    && !path.isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
  );
}

function wrapDetachError(error, mountPoint, detachTarget) {
  return new Error(
    `Failed to detach disk image target ${detachTarget}; mount point preserved at ${mountPoint}`,
    { cause: error },
  );
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSourceMetadata(left, right) {
  return (
    sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function sourceChanged(detail, cause) {
  return new Error(`Source DMG changed during inspection: ${detail}`, cause ? { cause } : undefined);
}

async function inspectSourcePath(resolvedDmgPath) {
  let metadata;
  try {
    metadata = await fs.promises.lstat(resolvedDmgPath, { bigint: true });
  } catch (error) {
    throw sourceChanged(`cannot inspect ${resolvedDmgPath}`, error);
  }
  if (metadata.isSymbolicLink()) {
    throw sourceChanged(`public path became a symbolic link: ${resolvedDmgPath}`);
  }
  if (!metadata.isFile()) {
    throw sourceChanged(`public path is not a regular file: ${resolvedDmgPath}`);
  }
  let canonicalPath;
  try {
    canonicalPath = await fs.promises.realpath(resolvedDmgPath);
  } catch (error) {
    throw sourceChanged(`cannot resolve ${resolvedDmgPath}`, error);
  }
  return { canonicalPath, metadata };
}

async function assertPinnedSourceStable({
  canonicalSourcePath,
  resolvedDmgPath,
  sourceHandle,
  sourceSnapshot,
}) {
  let descriptorMetadata;
  try {
    descriptorMetadata = await sourceHandle.stat({ bigint: true });
  } catch (error) {
    throw sourceChanged('cannot inspect the pinned source descriptor', error);
  }
  if (!descriptorMetadata.isFile() || descriptorMetadata.size === 0n) {
    throw sourceChanged('pinned descriptor is no longer a nonempty regular file');
  }
  if (!sameSourceMetadata(sourceSnapshot, descriptorMetadata)) {
    throw sourceChanged('pinned descriptor metadata no longer matches its original snapshot');
  }

  const currentPath = await inspectSourcePath(resolvedDmgPath);
  if (
    currentPath.canonicalPath !== canonicalSourcePath
    || !sameSourceMetadata(sourceSnapshot, currentPath.metadata)
  ) {
    throw sourceChanged(`public path identity no longer matches ${resolvedDmgPath}`);
  }
}

async function hashFileHandle(fileHandle, byteLength) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < byteLength) {
    const length = Math.min(buffer.length, byteLength - position);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
    if (bytesRead === 0) {
      break;
    }
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { bytes: position, sha256: digest.digest('hex') };
}

async function stagePinnedSource(sourceHandle, sourceSnapshot, stageHandle, stagePath) {
  if (sourceSnapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Source DMG is too large to stage safely');
  }
  const expectedBytes = Number(sourceSnapshot.size);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const sourceDigest = createHash('sha256');
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
    if (bytesRead === 0) {
      break;
    }
    sourceDigest.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await stageHandle.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (result.bytesWritten === 0) {
        throw new Error(`Unable to stage source DMG bytes at ${stagePath}`);
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  if (position !== expectedBytes) {
    throw sourceChanged('pinned descriptor ended before its original byte size');
  }
  await stageHandle.sync();

  const [stageDescriptorMetadata, stagePathMetadata] = await Promise.all([
    stageHandle.stat({ bigint: true }),
    fs.promises.lstat(stagePath, { bigint: true }),
  ]);
  if (
    !stageDescriptorMetadata.isFile()
    || !stagePathMetadata.isFile()
    || stagePathMetadata.isSymbolicLink()
    || !sameFileIdentity(stageDescriptorMetadata, stagePathMetadata)
  ) {
    throw new Error(`Staged DMG must remain a real non-symlink file: ${stagePath}`);
  }
  const stagedDigest = await hashFileHandle(stageHandle, expectedBytes);
  const expectedDigest = sourceDigest.digest('hex');
  if (
    stageDescriptorMetadata.size !== sourceSnapshot.size
    || stagedDigest.bytes !== expectedBytes
    || stagedDigest.sha256 !== expectedDigest
  ) {
    throw new Error(`Staged DMG bytes must equal the pinned source snapshot: ${stagePath}`);
  }
}

export async function inspectMountedDmgApp({
  dmgPath,
  execute = defaultExecute,
  inspect,
  expectedAppName = 'Ineed LinkLab.app',
  temporaryRoot = tmpdir(),
} = {}) {
  if (typeof dmgPath !== 'string' || dmgPath.trim() === '') {
    throw new TypeError('DMG path must be a nonblank string');
  }
  if (typeof execute !== 'function') {
    throw new TypeError('execute must be a function');
  }
  if (typeof inspect !== 'function') {
    throw new TypeError('inspect must be a function');
  }
  validateExpectedAppName(expectedAppName);

  const resolvedDmgPath = path.resolve(dmgPath);
  let sessionRoot;
  let mountPoint;
  let sourceHandle;
  let stageHandle;
  let sourceSnapshot;
  let canonicalSourcePath;
  let sourceStabilityFailed = false;
  let preAttachMountIdentity;
  let attachAttempted = false;
  let attachResolved = false;
  let detachTarget;
  let result;
  let primaryError;
  let reconciliationError;
  let detachError;
  let sourceVerificationError;
  let stageCloseError;
  let sourceCloseError;
  let cleanupError;
  const verifyPinnedSource = async () => {
    try {
      await assertPinnedSourceStable({
        canonicalSourcePath,
        resolvedDmgPath,
        sourceHandle,
        sourceSnapshot,
      });
    } catch (error) {
      sourceStabilityFailed = true;
      throw error;
    }
  };
  try {
    if (fs.constants.O_NOFOLLOW === undefined) {
      throw new Error('Source DMG inspection requires O_NOFOLLOW support');
    }
    try {
      sourceHandle = await fs.promises.open(
        resolvedDmgPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw new Error(`Source DMG must be an existing non-symlink regular file: ${resolvedDmgPath}`, {
        cause: error,
      });
    }
    sourceSnapshot = await sourceHandle.stat({ bigint: true });
    if (!sourceSnapshot.isFile() || sourceSnapshot.size === 0n) {
      throw new Error(`Source DMG must be a nonempty regular file: ${resolvedDmgPath}`);
    }
    const initialSourcePath = await inspectSourcePath(resolvedDmgPath);
    canonicalSourcePath = initialSourcePath.canonicalPath;
    if (!sameSourceMetadata(sourceSnapshot, initialSourcePath.metadata)) {
      throw sourceChanged(`public path identity does not match the opened file: ${resolvedDmgPath}`);
    }

    sessionRoot = await fs.promises.mkdtemp(
      path.join(path.resolve(temporaryRoot), 'macos-dmg-app-binding-'),
    );
    await fs.promises.chmod(sessionRoot, 0o700);
    const stagePath = path.join(sessionRoot, 'source.dmg');
    stageHandle = await fs.promises.open(
      stagePath,
      fs.constants.O_RDWR
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    await stageHandle.chmod(0o600);
    await stagePinnedSource(sourceHandle, sourceSnapshot, stageHandle, stagePath);
    await verifyPinnedSource();

    mountPoint = path.join(sessionRoot, 'mount');
    await fs.promises.mkdir(mountPoint);
    preAttachMountIdentity = await fs.promises.lstat(mountPoint, { bigint: true });
    attachAttempted = true;
    const attachResult = await execute('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-plist',
      '-mountpoint',
      mountPoint,
      stagePath,
    ], { encoding: 'utf8' });
    attachResolved = true;
    detachTarget = mountPoint;

    const attachPlistPath = path.join(sessionRoot, 'attach.plist');
    await fs.promises.writeFile(
      attachPlistPath,
      commandStdout(attachResult, 'hdiutil attach'),
    );
    const conversionResult = await execute('plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      attachPlistPath,
    ], { encoding: 'utf8' });

    let attachData;
    try {
      attachData = JSON.parse(commandStdout(conversionResult, 'plutil'));
    } catch (error) {
      throw new Error('Malformed attach JSON returned by plutil', { cause: error });
    }
    if (typeof attachData !== 'object' || attachData === null || Array.isArray(attachData)) {
      throw new Error('Attach JSON must contain an object');
    }

    const entities = attachData['system-entities'];
    if (!Array.isArray(entities)) {
      throw new Error('Attach JSON system-entities must be an array');
    }
    const canonicalMountPoint = await fs.promises.realpath(mountPoint);
    const entitiesWithMountPoints = entities.filter((entity) => (
      typeof entity === 'object'
      && entity !== null
      && !Array.isArray(entity)
      && typeof entity['mount-point'] === 'string'
      && entity['mount-point'].trim() !== ''
    ));
    const matchingEntities = [];
    for (const entity of entitiesWithMountPoints) {
      const canonicalReturnedMountPoint = await fs.promises.realpath(entity['mount-point']);
      if (canonicalReturnedMountPoint === canonicalMountPoint) {
        matchingEntities.push(entity);
      }
    }
    if (matchingEntities.length !== 1) {
      if (entitiesWithMountPoints.length === 1) {
        const [entity] = entitiesWithMountPoints;
        const canonicalReturnedMountPoint = await fs.promises.realpath(entity['mount-point']);
        throw new Error(
          `Attach mount-point mismatch: expected ${canonicalMountPoint}, received ${canonicalReturnedMountPoint}`,
        );
      }
      throw new Error(
        `Attach JSON must contain exactly one entity for mount-point ${canonicalMountPoint}`,
      );
    }

    const [entity] = matchingEntities;
    const returnedDevice = entity['dev-entry'];
    if (
      typeof returnedDevice !== 'string'
      || !/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(returnedDevice)
    ) {
      throw new Error(
        'Attach system entity dev-entry must be a nonblank /dev/... safe device path',
      );
    }
    detachTarget = returnedDevice;

    const topLevelNames = await fs.promises.readdir(mountPoint);
    const appNames = topLevelNames.filter((name) => name.endsWith('.app')).sort(comparePaths);
    if (appNames.length !== 1) {
      throw new Error(
        `Mounted image must contain exactly one top-level .app; found ${appNames.length}`,
      );
    }
    if (appNames[0] !== expectedAppName) {
      throw new Error(
        `Expected mounted app ${expectedAppName}, found ${appNames[0]}`,
      );
    }

    const mountedAppPath = path.join(mountPoint, appNames[0]);
    const appMetadata = await fs.promises.lstat(mountedAppPath);
    if (appMetadata.isSymbolicLink()) {
      throw new Error(`Mounted app must not be a symbolic link: ${mountedAppPath}`);
    }
    if (!appMetadata.isDirectory()) {
      throw new Error(`Mounted app must be a directory: ${mountedAppPath}`);
    }
    const canonicalMountedAppPath = await fs.promises.realpath(mountedAppPath);
    if (!isContainedBy(canonicalMountPoint, canonicalMountedAppPath)) {
      throw new Error(`Mounted app escapes its mount point: ${canonicalMountedAppPath}`);
    }

    result = await inspect(canonicalMountedAppPath);
  } catch (error) {
    primaryError = error;
  } finally {
    if (attachAttempted && !attachResolved && preAttachMountIdentity) {
      try {
        const postAttachMountIdentity = await fs.promises.lstat(
          mountPoint,
          { bigint: true },
        );
        if (!sameFileIdentity(preAttachMountIdentity, postAttachMountIdentity)) {
          detachTarget = mountPoint;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          reconciliationError = error;
        }
      }
    }

    let detachSucceeded = false;
    if (detachTarget) {
      try {
        await execute('hdiutil', ['detach', detachTarget], { encoding: 'utf8' });
        detachSucceeded = true;
      } catch (error) {
        detachError = wrapDetachError(error, mountPoint, detachTarget);
      }
    }

    if (sourceHandle && sourceSnapshot && canonicalSourcePath && !sourceStabilityFailed) {
      try {
        await verifyPinnedSource();
      } catch (error) {
        sourceVerificationError = error;
      }
    }

    if (stageHandle) {
      try {
        await stageHandle.close();
      } catch (error) {
        stageCloseError = error;
      }
    }
    if (sourceHandle) {
      try {
        await sourceHandle.close();
      } catch (error) {
        sourceCloseError = error;
      }
    }

    if (sessionRoot && (!detachTarget || detachSucceeded)) {
      try {
        await fs.promises.rm(sessionRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  const lifecycleErrors = [
    ['primary', primaryError],
    ['reconciliation', reconciliationError],
    ['detach', detachError],
    ['source verification', sourceVerificationError],
    ['stage close', stageCloseError],
    ['source close', sourceCloseError],
    ['cleanup', cleanupError],
  ].filter(([, error]) => error);
  if (lifecycleErrors.length === 1) {
    throw lifecycleErrors[0][1];
  }
  if (lifecycleErrors.length > 1) {
    throw new AggregateError(
      lifecycleErrors.map(([, error]) => error),
      `Disk image inspection failed with lifecycle errors: ${lifecycleErrors.map(([label]) => label).join(', ')}`,
    );
  }
  return result;
}
