#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as defaultFileSystem from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAC_DMG_EXPECTED_NAMES,
  MAC_DMG_MATRIX,
  collectionBackupName,
  collectionStageName,
  matrixKey,
  ownedCollectionArtifactKind,
} from './macos-package-matrix.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const descriptorsByKey = new Map(MAC_DMG_MATRIX.map((descriptor) => [
  matrixKey(descriptor.runtime, descriptor.architecture),
  descriptor,
]));
const expectedNames = new Set(MAC_DMG_EXPECTED_NAMES);

export const DEFAULT_ARTIFACT_ROOT = path.join(repositoryRoot, 'artifacts', 'macos');

export function defaultSources() {
  return MAC_DMG_MATRIX.map(({ runtime, architecture, relativeSource }) => ({
    runtime,
    architecture,
    sourceDirectory: path.join(repositoryRoot, ...relativeSource),
  }));
}

function requireNonblankString(value, description) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${description} must be a nonblank string`);
  }
  return value;
}

function normalizeSources(sources) {
  if (!Array.isArray(sources)) {
    throw new Error('sources must be an array containing exactly four matrix entries');
  }
  const byKey = new Map();
  for (const source of sources) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('Each source must be an object');
    }
    const runtime = source.runtime;
    const architecture = source.architecture;
    const key = matrixKey(String(runtime), String(architecture));
    if (
      typeof runtime !== 'string'
      || typeof architecture !== 'string'
      || !descriptorsByKey.has(key)
    ) {
      throw new Error(`Unsupported runtime/architecture matrix key: ${key}`);
    }
    if (byKey.has(key)) {
      throw new Error(`Duplicate runtime/architecture matrix key: ${key}`);
    }
    const sourceDirectory = path.resolve(requireNonblankString(
      source.sourceDirectory,
      `Source directory for ${key}`,
    ));
    byKey.set(key, { runtime, architecture, sourceDirectory });
  }

  const missingKeys = [...descriptorsByKey.keys()].filter((key) => !byKey.has(key));
  if (missingKeys.length > 0) {
    throw new Error(`Missing runtime/architecture matrix keys: ${missingKeys.join(', ')}`);
  }
  if (sources.length !== MAC_DMG_MATRIX.length) {
    throw new Error(
      `sources must contain exactly four matrix entries, found ${sources.length}`,
    );
  }
  return MAC_DMG_MATRIX.map(({ runtime, architecture }) => (
    byKey.get(matrixKey(runtime, architecture))
  ));
}

async function requireRealDirectory(fileSystem, directoryPath, description) {
  let metadata;
  try {
    metadata = await fileSystem.lstat(directoryPath);
  } catch (error) {
    throw new Error(`${description} is missing at ${directoryPath}`, { cause: error });
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${description} must not be a symbolic link: ${directoryPath}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${description} must be a real directory: ${directoryPath}`);
  }
  return fileSystem.realpath(directoryPath);
}

function requireCanonicalContainment(canonicalPath, canonicalRoot, description) {
  const relativePath = path.relative(canonicalRoot, canonicalPath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`${description} must remain within ${canonicalRoot}: ${canonicalPath}`);
  }
}

async function discoverSourceDmg(fileSystem, source) {
  const key = matrixKey(source.runtime, source.architecture);
  const canonicalDirectory = await requireRealDirectory(
    fileSystem,
    source.sourceDirectory,
    `Source directory for ${key}`,
  );
  const entries = await fileSystem.readdir(source.sourceDirectory, { withFileTypes: true });
  const matches = entries.filter((entry) => path.extname(entry.name) === '.dmg');
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one top-level .dmg in source directory for ${key}, found ${matches.length}`,
    );
  }

  const sourcePath = path.join(source.sourceDirectory, matches[0].name);
  const metadata = await fileSystem.lstat(sourcePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Source DMG must not be a symbolic link: ${sourcePath}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`Source DMG must be a real regular file: ${sourcePath}`);
  }
  if (metadata.size === 0) {
    throw new Error(`Source DMG must be a nonempty file: ${sourcePath}`);
  }
  const canonicalSourcePath = await fileSystem.realpath(sourcePath);
  requireCanonicalContainment(canonicalSourcePath, canonicalDirectory, 'Source DMG');
  return {
    ...source,
    sourcePath,
    canonicalSourcePath,
    sourceIdentity: `${metadata.dev}:${metadata.ino}`,
  };
}

async function nearestExistingAncestor(fileSystem, targetPath) {
  let candidate = path.dirname(targetPath);
  while (true) {
    try {
      return { ancestorPath: candidate, metadata: await fileSystem.lstat(candidate) };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      const parentPath = path.dirname(candidate);
      if (parentPath === candidate) {
        throw error;
      }
      candidate = parentPath;
    }
  }
}

async function prepareArtifactRoot(fileSystem, artifactRoot) {
  const resolvedRoot = path.resolve(requireNonblankString(artifactRoot, 'Artifact root'));
  try {
    const metadata = await fileSystem.lstat(resolvedRoot);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Artifact root must not be a symbolic link: ${resolvedRoot}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Artifact root must be a real directory: ${resolvedRoot}`);
    }
    return fileSystem.realpath(resolvedRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const { ancestorPath, metadata } = await nearestExistingAncestor(fileSystem, resolvedRoot);
  const canonicalAncestor = await fileSystem.realpath(ancestorPath);
  const canonicalMetadata = metadata.isSymbolicLink()
    ? await fileSystem.lstat(canonicalAncestor)
    : metadata;
  if (!canonicalMetadata.isDirectory()) {
    throw new Error(`Artifact root ancestor must be a real directory: ${ancestorPath}`);
  }
  const relativeRoot = path.relative(ancestorPath, resolvedRoot);
  const canonicalRoot = path.join(canonicalAncestor, relativeRoot);
  requireCanonicalContainment(canonicalRoot, canonicalAncestor, 'Artifact root');
  await fileSystem.mkdir(canonicalRoot, { recursive: true });
  const createdMetadata = await fileSystem.lstat(canonicalRoot);
  if (createdMetadata.isSymbolicLink() || !createdMetadata.isDirectory()) {
    throw new Error(`Artifact root must be a real directory: ${canonicalRoot}`);
  }
  return fileSystem.realpath(canonicalRoot);
}

async function inspectArtifactRoot(fileSystem, artifactRoot, {
  requireComplete,
  allowedOwnedNames = new Set(),
}) {
  const entries = await fileSystem.readdir(artifactRoot, { withFileTypes: true });
  const seenNames = new Set();

  for (const entry of entries) {
    const entryPath = path.join(artifactRoot, entry.name);
    const ownedKind = ownedCollectionArtifactKind(entry.name);
    if (ownedKind !== null) {
      if (allowedOwnedNames.has(entry.name)) {
        const metadata = await fileSystem.lstat(entryPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(`Active transaction ${ownedKind} must be a real file: ${entryPath}`);
        }
        continue;
      }
      throw new Error(`Stale collector-owned ${ownedKind} file in artifact root: ${entryPath}`);
    }
    if (entry.isSymbolicLink()) {
      if (expectedNames.has(entry.name)) {
        throw new Error(`Known destination must not be a symbolic link: ${entryPath}`);
      }
      throw new Error(`Artifact root must not contain a symbolic link: ${entryPath}`);
    }
    if (path.extname(entry.name) !== '.dmg') {
      continue;
    }
    if (!expectedNames.has(entry.name)) {
      throw new Error(`Unexpected DMG in artifact root: ${entryPath}`);
    }
    if (!entry.isFile()) {
      throw new Error(`Known destination must be a real regular file: ${entryPath}`);
    }
    const metadata = await fileSystem.lstat(entryPath);
    if (!metadata.isFile() || (requireComplete && metadata.size === 0)) {
      throw new Error(`Collected DMG must be a nonempty real regular file: ${entryPath}`);
    }
    seenNames.add(entry.name);
  }

  if (requireComplete) {
    const missingNames = MAC_DMG_EXPECTED_NAMES.filter((name) => !seenNames.has(name));
    if (seenNames.size !== expectedNames.size || missingNames.length > 0) {
      throw new Error(`Artifact root is missing expected DMGs: ${missingNames.join(', ')}`);
    }
  }
}

async function inspectDestination(fileSystem, destinationPath) {
  try {
    const metadata = await fileSystem.lstat(destinationPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Known destination must not be a symbolic link: ${destinationPath}`);
    }
    if (!metadata.isFile()) {
      throw new Error(`Known destination must be a real regular file: ${destinationPath}`);
    }
    return { exists: true, identity: `${metadata.dev}:${metadata.ino}` };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, identity: null };
    }
    throw error;
  }
}

function attachRollbackErrors(primaryError, rollbackErrors) {
  if (rollbackErrors.length === 0) {
    return;
  }
  const existingErrors = Array.isArray(primaryError?.rollbackErrors)
    ? primaryError.rollbackErrors
    : [];
  const combinedErrors = [...existingErrors, ...rollbackErrors];
  try {
    Object.defineProperty(primaryError, 'rollbackErrors', {
      configurable: true,
      enumerable: false,
      value: combinedErrors,
    });
  } catch {
    // The original error still takes precedence if it is non-extensible.
  }
  try {
    const details = rollbackErrors.map((error) => (
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    ));
    primaryError.stack = `${primaryError.stack ?? primaryError.message}\nRollback errors:\n${details.join('\n')}`;
  } catch {
    // Preserve the original error even when its stack is read-only.
  }
}

async function removeTrackedPaths(fileSystem, paths, errors) {
  for (const trackedPath of [...paths]) {
    try {
      await fileSystem.rm(trackedPath, { force: true });
      paths.delete(trackedPath);
    } catch (error) {
      errors.push(error);
    }
  }
}

async function rollbackTransaction(fileSystem, entries, stagePaths, backupPaths) {
  const rollbackErrors = [];
  for (const entry of [...entries].reverse()) {
    if (!entry.installed) {
      continue;
    }
    try {
      await fileSystem.rm(entry.destinationPath, { force: true });
      entry.installed = false;
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  for (const entry of [...entries].reverse()) {
    if (!entry.backupAvailable) {
      continue;
    }
    try {
      await fileSystem.rename(entry.backupPath, entry.destinationPath);
      entry.backupAvailable = false;
      backupPaths.delete(entry.backupPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  await removeTrackedPaths(fileSystem, stagePaths, rollbackErrors);
  const unavailableBackups = new Set(entries
    .filter((entry) => !entry.backupAvailable)
    .map(({ backupPath }) => backupPath)
    .filter((backupPath) => backupPaths.has(backupPath)));
  const unavailableBackupPaths = [...unavailableBackups];
  await removeTrackedPaths(fileSystem, unavailableBackups, rollbackErrors);
  for (const backupPath of unavailableBackupPaths) {
    if (!unavailableBackups.has(backupPath)) {
      backupPaths.delete(backupPath);
    }
  }
  return rollbackErrors;
}

function sourceUnchanged(metadata, source) {
  return (
    !metadata.isSymbolicLink()
    && metadata.isFile()
    && metadata.size > 0
    && `${metadata.dev}:${metadata.ino}` === source.sourceIdentity
  );
}

async function hashReadable(readable) {
  const hash = createHash('sha256');
  for await (const chunk of readable) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function hashFileHandle(fileHandle) {
  return hashReadable(fileHandle.createReadStream({ autoClose: false, start: 0 }));
}

async function hashFilePath(filePath) {
  return hashReadable(createReadStream(filePath));
}

async function closeHandles(fileHandles, primaryError) {
  const closeErrors = [];
  for (const fileHandle of [...fileHandles].reverse()) {
    try {
      await fileHandle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (primaryError !== undefined) {
    attachRollbackErrors(primaryError, closeErrors);
    return;
  }
  if (closeErrors.length > 0) {
    const closeError = closeErrors.shift();
    attachRollbackErrors(closeError, closeErrors);
    throw closeError;
  }
}

async function withSourceHandle(fileSystem, sourcePath, operation) {
  const sourceHandle = await fileSystem.open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let primaryError;
  try {
    return await operation(sourceHandle);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeHandles([sourceHandle], primaryError);
  }
}

function regularFileIdentity(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    return null;
  }
  return `${metadata.dev}:${metadata.ino}`;
}

async function validateInstalledMatrix(fileSystem, entries) {
  const openedHandles = [];
  const handlePairs = [];
  let primaryError;
  try {
    for (const entry of entries) {
      const sourceHandle = await fileSystem.open(
        entry.sourcePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      openedHandles.push(sourceHandle);
      const destinationHandle = await fileSystem.open(
        entry.destinationPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      openedHandles.push(destinationHandle);
      handlePairs.push({ destinationHandle, entry, sourceHandle });
    }

    for (const pair of handlePairs) {
      const [sourceMetadata, destinationMetadata] = await Promise.all([
        pair.sourceHandle.stat(),
        pair.destinationHandle.stat(),
      ]);
      if (!sourceUnchanged(sourceMetadata, pair.entry)) {
        throw new Error(`Matrix source digest changed before commit: ${pair.entry.sourcePath}`);
      }
      const destinationIdentity = regularFileIdentity(destinationMetadata);
      if (destinationIdentity === null) {
        throw new Error(
          `Matrix destination digest changed before commit: ${pair.entry.destinationPath}`,
        );
      }
      pair.destinationIdentity = destinationIdentity;
      pair.sourceMetadata = sourceMetadata;
    }

    const sourcesByIdentity = new Map(handlePairs.map(({ entry }) => [
      entry.sourceIdentity,
      entry.sourcePath,
    ]));
    const destinationsByIdentity = new Map();
    for (const { destinationIdentity, entry } of handlePairs) {
      const matchingSourcePath = sourcesByIdentity.get(destinationIdentity);
      if (matchingSourcePath !== undefined) {
        throw new Error(
          'Matrix identity collision between source and destination DMGs: '
          + `${matchingSourcePath} and ${entry.destinationPath}`,
        );
      }
      const matchingDestinationPath = destinationsByIdentity.get(destinationIdentity);
      if (matchingDestinationPath !== undefined) {
        throw new Error(
          'Matrix identity collision between destinations: '
          + `${matchingDestinationPath} and ${entry.destinationPath}`,
        );
      }
      destinationsByIdentity.set(destinationIdentity, entry.destinationPath);
    }

    const validationResults = await Promise.allSettled(handlePairs.map(async ({
      destinationHandle,
      destinationIdentity,
      entry,
      sourceHandle,
      sourceMetadata,
    }) => {
      const [sourceSha256, destinationSha256] = await Promise.all([
        hashFileHandle(sourceHandle),
        hashFileHandle(destinationHandle),
      ]);
      const [
        sourceMetadataAfterHash,
        destinationMetadataAfterHash,
        sourcePathMetadata,
        destinationPathMetadata,
      ] = await Promise.all([
        sourceHandle.stat(),
        destinationHandle.stat(),
        fileSystem.lstat(entry.sourcePath),
        fileSystem.lstat(entry.destinationPath),
      ]);
      if (
        !sourceUnchanged(sourceMetadata, entry)
        || !sourceUnchanged(sourceMetadataAfterHash, entry)
        || !sourceUnchanged(sourcePathMetadata, entry)
        || sourceSha256 !== entry.stageSha256
      ) {
        throw new Error(`Matrix source digest changed before commit: ${entry.sourcePath}`);
      }
      if (
        regularFileIdentity(destinationMetadataAfterHash) !== destinationIdentity
        || regularFileIdentity(destinationPathMetadata) !== destinationIdentity
        || destinationSha256 !== entry.stageSha256
      ) {
        throw new Error(
          `Matrix destination digest changed before commit: ${entry.destinationPath}`,
        );
      }
    }));
    const failedValidation = validationResults.find(({ status }) => status === 'rejected');
    if (failedValidation !== undefined) {
      throw failedValidation.reason;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeHandles(openedHandles, primaryError);
  }
}

function defaultReportCleanupError(error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    console.error(`[Ineed LinkLab] committed DMG collection cleanup failed: ${detail}`);
  } catch {
    // Diagnostics must never turn a committed collection into a rejected transaction.
  }
}

export async function collectMacDmgs({
  sources = defaultSources(),
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
  fileSystem = defaultFileSystem,
  onCleanupError = defaultReportCleanupError,
} = {}) {
  if (typeof onCleanupError !== 'function') {
    throw new Error('onCleanupError must be a function');
  }
  const normalizedSources = normalizeSources(sources);
  const discoveredSources = [];
  const sourceIdentities = new Set();
  const canonicalSourcePaths = new Set();
  for (const source of normalizedSources) {
    const discovered = await discoverSourceDmg(fileSystem, source);
    if (
      sourceIdentities.has(discovered.sourceIdentity)
      || canonicalSourcePaths.has(discovered.canonicalSourcePath)
    ) {
      throw new Error(`Duplicate source DMG: ${discovered.sourcePath}`);
    }
    sourceIdentities.add(discovered.sourceIdentity);
    canonicalSourcePaths.add(discovered.canonicalSourcePath);
    discoveredSources.push(discovered);
  }

  const canonicalArtifactRoot = await prepareArtifactRoot(fileSystem, artifactRoot);
  await inspectArtifactRoot(fileSystem, canonicalArtifactRoot, { requireComplete: false });
  const transactionId = randomUUID();
  const entries = [];
  for (const [index, source] of discoveredSources.entries()) {
    const destinationPath = path.join(
      canonicalArtifactRoot,
      MAC_DMG_MATRIX[index].destinationName,
    );
    entries.push({
      runtime: source.runtime,
      architecture: source.architecture,
      sourcePath: source.sourcePath,
      sourceIdentity: source.sourceIdentity,
      destinationPath,
      destinationState: await inspectDestination(fileSystem, destinationPath),
      stagePath: path.join(
        canonicalArtifactRoot,
        collectionStageName(transactionId, index),
      ),
      backupPath: path.join(
        canonicalArtifactRoot,
        collectionBackupName(transactionId, index),
      ),
      backupAvailable: false,
      installed: false,
    });
  }

  const stagePaths = new Set();
  try {
    for (const entry of entries) {
      stagePaths.add(entry.stagePath);
      await withSourceHandle(fileSystem, entry.sourcePath, async (sourceHandle) => {
        const sourceMetadata = await sourceHandle.stat();
        if (!sourceUnchanged(sourceMetadata, entry)) {
          throw new Error(`Source DMG changed before copying: ${entry.sourcePath}`);
        }
        const sourceSha256BeforeCopy = await hashFileHandle(sourceHandle);
        await fileSystem.copyFile(
          entry.sourcePath,
          entry.stagePath,
          constants.COPYFILE_FICLONE,
        );
        const stagedMetadata = await fileSystem.lstat(entry.stagePath);
        if (
          stagedMetadata.isSymbolicLink()
          || !stagedMetadata.isFile()
          || stagedMetadata.size === 0
        ) {
          throw new Error(`Staged DMG must be a nonempty real regular file: ${entry.stagePath}`);
        }
        const [sourceMetadataAfterCopy, sourcePathMetadata, sourceSha256AfterCopy, stageSha256] = (
          await Promise.all([
            sourceHandle.stat(),
            fileSystem.lstat(entry.sourcePath),
            hashFileHandle(sourceHandle),
            hashFilePath(entry.stagePath),
          ])
        );
        if (
          !sourceUnchanged(sourceMetadataAfterCopy, entry)
          || !sourceUnchanged(sourcePathMetadata, entry)
          || sourceSha256AfterCopy !== sourceSha256BeforeCopy
          || stageSha256 !== sourceSha256BeforeCopy
        ) {
          throw new Error(`Source DMG content changed during copy: ${entry.sourcePath}`);
        }
        entry.stageSha256 = stageSha256;
      });
    }
  } catch (primaryError) {
    const cleanupErrors = [];
    await removeTrackedPaths(fileSystem, stagePaths, cleanupErrors);
    attachRollbackErrors(primaryError, cleanupErrors);
    throw primaryError;
  }

  const backupPaths = new Set();
  try {
    for (const entry of entries) {
      const stagedMetadata = await fileSystem.lstat(entry.stagePath);
      if (
        stagedMetadata.isSymbolicLink()
        || !stagedMetadata.isFile()
        || stagedMetadata.size === 0
        || await hashFilePath(entry.stagePath) !== entry.stageSha256
      ) {
        throw new Error(`Staged DMG changed before installation: ${entry.stagePath}`);
      }
      await withSourceHandle(fileSystem, entry.sourcePath, async (sourceHandle) => {
        const sourceMetadata = await sourceHandle.stat();
        const sourceSha256 = await hashFileHandle(sourceHandle);
        const [sourceMetadataAfterHash, sourcePathMetadata] = await Promise.all([
          sourceHandle.stat(),
          fileSystem.lstat(entry.sourcePath),
        ]);
        if (
          !sourceUnchanged(sourceMetadata, entry)
          || !sourceUnchanged(sourceMetadataAfterHash, entry)
          || !sourceUnchanged(sourcePathMetadata, entry)
          || sourceSha256 !== entry.stageSha256
        ) {
          throw new Error(`Source DMG changed before transaction: ${entry.sourcePath}`);
        }
      });
    }
    for (const entry of entries) {
      const currentState = await inspectDestination(fileSystem, entry.destinationPath);
      if (
        currentState.exists !== entry.destinationState.exists
        || currentState.identity !== entry.destinationState.identity
      ) {
        throw new Error(`Known destination changed during collection: ${entry.destinationPath}`);
      }
      if (!currentState.exists) {
        continue;
      }
      backupPaths.add(entry.backupPath);
      await fileSystem.rename(entry.destinationPath, entry.backupPath);
      entry.backupAvailable = true;
    }

    for (const entry of entries) {
      await fileSystem.rename(entry.stagePath, entry.destinationPath);
      stagePaths.delete(entry.stagePath);
      entry.installed = true;
    }
    await inspectArtifactRoot(fileSystem, canonicalArtifactRoot, {
      requireComplete: true,
      allowedOwnedNames: new Set(
        entries.filter(({ backupAvailable }) => backupAvailable)
          .map(({ backupPath }) => path.basename(backupPath)),
      ),
    });
    await validateInstalledMatrix(fileSystem, entries);
  } catch (primaryError) {
    const rollbackErrors = await rollbackTransaction(
      fileSystem,
      entries,
      stagePaths,
      backupPaths,
    );
    attachRollbackErrors(primaryError, rollbackErrors);
    throw primaryError;
  }

  const cleanupErrors = [];
  await removeTrackedPaths(fileSystem, backupPaths, cleanupErrors);
  const result = entries.map(({ runtime, architecture, sourcePath, destinationPath }) => ({
    runtime,
    architecture,
    sourcePath,
    destinationPath,
  }));
  for (const cleanupError of cleanupErrors) {
    try {
      await onCleanupError(cleanupError);
    } catch (reportingError) {
      defaultReportCleanupError(cleanupError);
      defaultReportCleanupError(reportingError);
    }
  }
  return result;
}

async function isDirectInvocation() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const [invokedPath, modulePath] = await Promise.all([
      defaultFileSystem.realpath(path.resolve(process.argv[1])),
      defaultFileSystem.realpath(fileURLToPath(import.meta.url)),
    ]);
    return pathToFileURL(invokedPath).href === pathToFileURL(modulePath).href;
  } catch {
    return false;
  }
}

if (await isDirectInvocation()) {
  try {
    const result = await collectMacDmgs();
    console.log(`MAC_DMG_COLLECTION_RESULT=${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
