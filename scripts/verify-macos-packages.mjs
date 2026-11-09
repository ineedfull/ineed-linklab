#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyElectronMacPackage } from './verify-electron-macos-package.mjs';
import { verifyTauriMacPackage } from './verify-tauri-macos-package.mjs';
import {
  MAC_DMG_EXPECTED_NAMES,
  MAC_DMG_MATRIX,
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
const signingValues = new Set(['unsigned', 'developer-id']);

export const DEFAULT_ARTIFACT_ROOT = path.join(repositoryRoot, 'artifacts', 'macos');

function requireAbsolutePath(value, field, key) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw new Error(`Verifier result ${field} for ${key} must be a nonblank absolute path`);
  }
  return value;
}

async function requireRealDirectory(directoryPath, description) {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch (error) {
    throw new Error(`${description} is missing at ${directoryPath}`, { cause: error });
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${description} must not be a symbolic link: ${directoryPath}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${description} must be a real directory: ${directoryPath}`);
  }
  return realpath(directoryPath);
}

async function requireNonemptyRealFile(filePath, description) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    throw new Error(`${description} is missing at ${filePath}`, { cause: error });
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${description} must not be a symbolic link: ${filePath}`);
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`${description} must be a nonempty real regular file: ${filePath}`);
  }
  return metadata;
}

function validateResultShape(runtime, result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${runtime} verifier results must contain objects`);
  }
  const architecture = result.architecture;
  const key = matrixKey(runtime, String(architecture));
  if (typeof architecture !== 'string' || !descriptorsByKey.has(key)) {
    throw new Error(`Unsupported runtime/architecture matrix key: ${key}`);
  }
  if (!signingValues.has(result.signing)) {
    throw new Error(
      `Verifier result signing for ${key} must be unsigned or developer-id`,
    );
  }
  return {
    runtime,
    architecture,
    appPath: requireAbsolutePath(result.appPath, 'appPath', key),
    sourceDmgPath: requireAbsolutePath(result.dmgPath, 'dmgPath', key),
    signing: result.signing,
  };
}

function normalizeResults(electronResults, tauriResults) {
  if (!Array.isArray(electronResults)) {
    throw new Error('electronResults must be an array');
  }
  if (!Array.isArray(tauriResults)) {
    throw new Error('tauriResults must be an array');
  }

  const supplied = [
    ...electronResults.map((result) => ['electron', result]),
    ...tauriResults.map((result) => ['tauri', result]),
  ];
  const byKey = new Map();
  for (const [runtime, result] of supplied) {
    const normalized = validateResultShape(runtime, result);
    const key = matrixKey(normalized.runtime, normalized.architecture);
    if (byKey.has(key)) {
      throw new Error(`Duplicate runtime/architecture matrix key: ${key}`);
    }
    byKey.set(key, normalized);
  }
  const missingKeys = [...descriptorsByKey.keys()].filter((key) => !byKey.has(key));
  if (missingKeys.length > 0) {
    throw new Error(`Missing runtime/architecture matrix keys: ${missingKeys.join(', ')}`);
  }
  if (supplied.length !== MAC_DMG_MATRIX.length) {
    throw new Error(`Verifier results must contain exactly four matrix entries, found ${supplied.length}`);
  }
  return MAC_DMG_MATRIX.map(({ runtime, architecture }) => (
    byKey.get(matrixKey(runtime, architecture))
  ));
}

async function inspectArtifactRoot(artifactRoot) {
  const resolvedRoot = path.resolve(artifactRoot);
  const canonicalRoot = await requireRealDirectory(resolvedRoot, 'Artifact root');
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const seenNames = new Set();

  for (const entry of entries) {
    const entryPath = path.join(canonicalRoot, entry.name);
    const ownedKind = ownedCollectionArtifactKind(entry.name);
    if (ownedKind !== null) {
      throw new Error(`Stale collector-owned ${ownedKind} file in artifact root: ${entryPath}`);
    }
    if (entry.isSymbolicLink()) {
      if (expectedNames.has(entry.name)) {
        throw new Error(`Collected DMG must not be a symbolic link: ${entryPath}`);
      }
      throw new Error(`Artifact root must not contain a symbolic link: ${entryPath}`);
    }
    if (path.extname(entry.name) !== '.dmg') {
      continue;
    }
    if (!expectedNames.has(entry.name)) {
      throw new Error(`Unexpected DMG in artifact root: ${entryPath}`);
    }
    await requireNonemptyRealFile(entryPath, 'Collected DMG');
    seenNames.add(entry.name);
  }

  const missingNames = MAC_DMG_EXPECTED_NAMES.filter((name) => !seenNames.has(name));
  if (seenNames.size !== expectedNames.size || missingNames.length > 0) {
    throw new Error(`Artifact root is missing expected DMGs: ${missingNames.join(', ')}`);
  }
  return canonicalRoot;
}

function regularFileIdentity(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    return null;
  }
  return `${metadata.dev}:${metadata.ino}`;
}

function attachCloseErrors(primaryError, closeErrors) {
  if (closeErrors.length === 0) {
    return;
  }
  const existingErrors = Array.isArray(primaryError?.closeErrors)
    ? primaryError.closeErrors
    : [];
  try {
    Object.defineProperty(primaryError, 'closeErrors', {
      configurable: true,
      enumerable: false,
      value: [...existingErrors, ...closeErrors],
    });
  } catch {
    // The primary error still takes precedence if it cannot be extended.
  }
  try {
    const details = closeErrors.map((error) => (
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    ));
    primaryError.stack = `${primaryError.stack ?? primaryError.message}\nClose errors:\n${details.join('\n')}`;
  } catch {
    // Preserve the primary error even when its stack is read-only.
  }
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
    attachCloseErrors(primaryError, closeErrors);
    return;
  }
  if (closeErrors.length > 0) {
    const closeError = closeErrors.shift();
    attachCloseErrors(closeError, closeErrors);
    throw closeError;
  }
}

async function hashFileHandle(fileHandle) {
  const hash = createHash('sha256');
  for await (const chunk of fileHandle.createReadStream({ autoClose: false, start: 0 })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function openDmg(filePath, description) {
  let fileHandle;
  try {
    fileHandle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`${description} must not be a symbolic link: ${filePath}`, { cause: error });
    }
    throw new Error(`${description} is missing or unreadable at ${filePath}`, { cause: error });
  }

  try {
    const metadata = await fileHandle.stat();
    const identity = regularFileIdentity(metadata);
    if (identity === null) {
      throw new Error(`${description} must be a nonempty real regular file: ${filePath}`);
    }
    const canonicalPath = await realpath(filePath);
    const [pathMetadata, canonicalPathMetadata] = await Promise.all([
      lstat(filePath),
      lstat(canonicalPath),
    ]);
    if (
      regularFileIdentity(pathMetadata) !== identity
      || regularFileIdentity(canonicalPathMetadata) !== identity
    ) {
      throw new Error(`${description} path identity changed during verification: ${filePath}`);
    }
    return { canonicalPath, description, fileHandle, filePath, identity };
  } catch (error) {
    await closeHandles([fileHandle], error);
    throw error;
  }
}

async function requireStableDmg(openedDmg) {
  const [metadata, canonicalPath, pathMetadata, canonicalPathMetadata] = await Promise.all([
    openedDmg.fileHandle.stat(),
    realpath(openedDmg.filePath),
    lstat(openedDmg.filePath),
    lstat(openedDmg.canonicalPath),
  ]);
  if (
    canonicalPath !== openedDmg.canonicalPath
    || regularFileIdentity(metadata) !== openedDmg.identity
    || regularFileIdentity(pathMetadata) !== openedDmg.identity
    || regularFileIdentity(canonicalPathMetadata) !== openedDmg.identity
  ) {
    throw new Error(
      `${openedDmg.description} path identity changed during verification: ${openedDmg.filePath}`,
    );
  }
}

async function runDefaultVerifier(verifyPackage) {
  const results = [];
  for (const architecture of ['arm64', 'x64']) {
    results.push(await verifyPackage({ architecture }));
  }
  return results;
}

export async function verifyMacPackages({
  electronResults,
  tauriResults,
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
} = {}) {
  const resolvedElectronResults = electronResults === undefined
    ? await runDefaultVerifier(verifyElectronMacPackage)
    : electronResults;
  const resolvedTauriResults = tauriResults === undefined
    ? await runDefaultVerifier(verifyTauriMacPackage)
    : tauriResults;
  const normalizedResults = normalizeResults(resolvedElectronResults, resolvedTauriResults);
  const resolvedArtifactRoot = await inspectArtifactRoot(artifactRoot);
  await Promise.all(normalizedResults.map((result) => {
    const key = matrixKey(result.runtime, result.architecture);
    return requireRealDirectory(result.appPath, `Verifier result appPath for ${key}`);
  }));
  const openedHandles = [];
  const openedPairs = [];
  let primaryError;
  try {
    for (const [index, result] of normalizedResults.entries()) {
      const key = matrixKey(result.runtime, result.architecture);
      const collectedDmgPath = path.join(
        resolvedArtifactRoot,
        MAC_DMG_MATRIX[index].destinationName,
      );
      const source = await openDmg(result.sourceDmgPath, `Source DMG for ${key}`);
      openedHandles.push(source.fileHandle);
      const collected = await openDmg(collectedDmgPath, `Collected DMG for ${key}`);
      openedHandles.push(collected.fileHandle);
      openedPairs.push({ collected, key, result, source });
    }

    const artifactsByIdentity = new Map();
    for (const { collected, source } of openedPairs) {
      for (const artifact of [source, collected]) {
        const matchingArtifact = artifactsByIdentity.get(artifact.identity);
        if (matchingArtifact !== undefined) {
          throw new Error(
            'DMG matrix identity collision between '
            + `${matchingArtifact.description} and ${artifact.description}`,
          );
        }
        artifactsByIdentity.set(artifact.identity, artifact);
      }
    }

    const records = [];
    for (const { collected, key, result, source } of openedPairs) {
      const [sourceSha256, collectedSha256] = await Promise.all([
        hashFileHandle(source.fileHandle),
        hashFileHandle(collected.fileHandle),
      ]);
      await Promise.all([requireStableDmg(source), requireStableDmg(collected)]);
      if (sourceSha256 !== collectedSha256) {
        throw new Error(`SHA-256 checksum mismatch for ${key}`);
      }
      records.push({
        runtime: result.runtime,
        architecture: result.architecture,
        appPath: result.appPath,
        sourceDmgPath: result.sourceDmgPath,
        collectedDmgPath: collected.filePath,
        sha256: sourceSha256,
        signing: result.signing,
      });
    }
    return records;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeHandles(openedHandles, primaryError);
  }
}

async function isDirectInvocation() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const [invokedPath, modulePath] = await Promise.all([
      realpath(path.resolve(process.argv[1])),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return pathToFileURL(invokedPath).href === pathToFileURL(modulePath).href;
  } catch {
    return false;
  }
}

if (await isDirectInvocation()) {
  try {
    const result = await verifyMacPackages();
    console.log(`MAC_PACKAGE_MATRIX_RESULT=${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
