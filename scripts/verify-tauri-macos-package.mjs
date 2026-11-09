#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  assertAppManifestsEqual,
  createAppManifest,
  inspectMountedDmgApp,
} from './macos-dmg-app-binding.mjs';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_WEB_EXTENSIONS = ['.css', '.html', '.js'];

export const ARCHITECTURE_DESCRIPTORS = Object.freeze({
  arm64: Object.freeze({
    rustTarget: 'aarch64-apple-darwin',
    fileToken: 'arm64',
    fileTokenPattern: Object.freeze(/\barm64\b/),
    dmgPattern: Object.freeze(
      /^Ineed(?: LinkLab|[_-]LinkLab)[_-]0\.1\.0[_-](?:aarch64|arm64)\.dmg$/,
    ),
  }),
  x64: Object.freeze({
    rustTarget: 'x86_64-apple-darwin',
    fileToken: 'x86_64',
    fileTokenPattern: Object.freeze(/\bx86_64\b/),
    dmgPattern: Object.freeze(
      /^Ineed(?: LinkLab|[_-]LinkLab)[_-]0\.1\.0[_-](?:x64|x86_64|amd64)\.dmg$/,
    ),
  }),
});

function architectureDescriptorFor(architecture) {
  if (
    typeof architecture !== 'string'
    || !Object.hasOwn(ARCHITECTURE_DESCRIPTORS, architecture)
  ) {
    throw new Error('architecture must be arm64 or x64');
  }

  return ARCHITECTURE_DESCRIPTORS[architecture];
}

export function bundleRootFor(architecture) {
  const descriptor = architectureDescriptorFor(architecture);
  return path.resolve(
    scriptDirectory,
    '..',
    'apps',
    'tauri',
    'src-tauri',
    'target',
    descriptor.rustTarget,
    'release',
    'bundle',
  );
}

export const DEFAULT_BUNDLE_ROOT = bundleRootFor('arm64');

async function defaultExecute(file, args) {
  return execFileAsync(file, args, { encoding: 'utf8' });
}

async function findOnlyArtifact(directory, description, predicate) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to inspect ${description} directory ${directory}: ${error.message}`, {
      cause: error,
    });
  }

  const matches = entries.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${description} in ${directory}, found ${matches.length}`,
    );
  }

  return path.join(directory, matches[0].name);
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
    throw new Error(`${description} must be a directory: ${directoryPath}`);
  }

  return realpath(directoryPath);
}

function requireCanonicalContainment(canonicalPath, canonicalAppPath, description) {
  const relativePath = path.relative(canonicalAppPath, canonicalPath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`${description} must remain within ${canonicalAppPath}: ${canonicalPath}`);
  }
}

async function requireContainedRealDirectory(directoryPath, canonicalAppPath, description) {
  const canonicalDirectoryPath = await requireRealDirectory(directoryPath, description);
  requireCanonicalContainment(canonicalDirectoryPath, canonicalAppPath, description);
  return canonicalDirectoryPath;
}

async function requireContainedNonemptyFile(filePath, canonicalAppPath, description) {
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
    throw new Error(`${description} must be a nonempty file: ${filePath}`);
  }

  const canonicalFilePath = await realpath(filePath);
  requireCanonicalContainment(canonicalFilePath, canonicalAppPath, description);
  return metadata;
}

function requireNonblankString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Info.plist ${field} must be a nonblank string`);
  }

  return value;
}

function requireLeafFilename(value, field) {
  const filename = requireNonblankString(value, field);
  if (
    filename === '.'
    || filename.includes('..')
    || filename.includes('/')
    || filename.includes('\\')
    || path.basename(filename) !== filename
  ) {
    throw new Error(`Info.plist ${field} must be a leaf filename without traversal`);
  }

  return filename;
}

function requirePlistValue(plist, field, expected) {
  const value = requireNonblankString(plist[field], field);
  if (value !== expected) {
    throw new Error(`Info.plist ${field} must equal ${JSON.stringify(expected)}`);
  }
}

async function collectNonemptyFileExtensions(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectNonemptyFileExtensions(entryPath, extensions);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (extension && (await stat(entryPath)).size > 0) {
          extensions.add(extension);
        }
      }
    }),
  );
}

async function inspectEmbeddedAssets(bundleRoot) {
  const buildRoot = path.join(path.dirname(bundleRoot), 'build');
  let buildEntries;

  try {
    buildEntries = await readdir(buildRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to inspect Tauri build assets at ${buildRoot}: ${error.message}`, {
      cause: error,
    });
  }

  const assetDirectories = [];
  for (const entry of buildEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith('ineed-linklab-tauri-')) {
      continue;
    }

    const assetPath = path.join(buildRoot, entry.name, 'out', 'tauri-codegen-assets');
    try {
      const metadata = await lstat(assetPath);
      if (metadata.isDirectory()) {
        assetDirectories.push(assetPath);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (assetDirectories.length !== 1) {
    throw new Error(
      `Expected exactly one app-specific codegen assets directory under ${buildRoot}, `
      + `found ${assetDirectories.length}; remove stale build outputs and package again`,
    );
  }

  const extensions = new Set();
  await collectNonemptyFileExtensions(assetDirectories[0], extensions);

  for (const requiredExtension of REQUIRED_WEB_EXTENSIONS) {
    if (!extensions.has(requiredExtension)) {
      throw new Error(`Embedded Tauri assets must include nonempty ${requiredExtension}`);
    }
  }

  return [...extensions].sort();
}

async function rejectLooseWebAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`App Resources must not contain a symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await rejectLooseWebAssets(entryPath);
      continue;
    }

    if (REQUIRED_WEB_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      throw new Error(`App Resources must not contain a loose web asset: ${entryPath}`);
    }
  }
}

async function inspectSigning(appPath, execute) {
  let stdout;
  let stderr;
  try {
    ({ stdout = '', stderr = '' } = await execute(
      'codesign',
      ['-dv', '--verbose=4', appPath],
      { encoding: 'utf8' },
    ));
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message]
      .filter((value) => typeof value === 'string')
      .join('\n');

    if (/\b(?:code object is )?not signed\b/i.test(output)) {
      return 'unsigned';
    }

    throw error;
  }

  const authorityLines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Authority='));
  if (authorityLines.length === 0) {
    return 'unsigned';
  }
  if (!authorityLines[0].startsWith('Authority=Developer ID Application:')) {
    throw new Error(`Unsupported signing identity: ${authorityLines[0].slice('Authority='.length)}`);
  }

  await execute(
    'codesign',
    ['--verify', '--deep', '--strict', appPath],
    { encoding: 'utf8' },
  );
  return 'developer-id';
}

function relativeAppPath(appPath, targetPath) {
  return path.relative(appPath, targetPath).split(path.sep).join('/');
}

function runtimeMismatch(context, evidencePath, expected, actual) {
  throw new Error(
    `${context}: runtime mismatch at ${evidencePath}: `
    + `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
  );
}

function assertRuntimeEvidenceEqual(expected, actual, context, evidencePath = 'evidence') {
  if (Object.is(expected, actual)) {
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      runtimeMismatch(context, evidencePath, expected, actual);
    }
    if (expected.length !== actual.length) {
      runtimeMismatch(context, `${evidencePath}.length`, expected.length, actual.length);
    }
    for (let index = 0; index < expected.length; index += 1) {
      assertRuntimeEvidenceEqual(expected[index], actual[index], context, `${evidencePath}[${index}]`);
    }
    return;
  }
  if (
    expected === null
    || actual === null
    || typeof expected !== 'object'
    || typeof actual !== 'object'
  ) {
    runtimeMismatch(context, evidencePath, expected, actual);
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (
    expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    runtimeMismatch(context, `${evidencePath} fields`, expectedKeys, actualKeys);
  }
  for (const key of expectedKeys) {
    assertRuntimeEvidenceEqual(expected[key], actual[key], context, `${evidencePath}.${key}`);
  }
}

function inspectionErrorMessage(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '<unprintable error value>';
  }
}

function formatInspectionErrorDetail(error, seen = new Set(), depth = 0) {
  const detail = inspectionErrorMessage(error);
  if (!(error instanceof AggregateError)) {
    return detail;
  }
  if (seen.has(error)) {
    return `${detail} [cyclic AggregateError]`;
  }
  if (depth >= 8) {
    return `${detail} [nested errors truncated]`;
  }

  seen.add(error);
  try {
    const nestedErrors = Array.from(error.errors ?? []);
    if (nestedErrors.length === 0) {
      return detail;
    }
    const formattedErrors = nestedErrors.slice(0, 20).map((nestedError, index) => (
      `[${index + 1}] ${formatInspectionErrorDetail(nestedError, seen, depth + 1)}`
    ));
    if (nestedErrors.length > formattedErrors.length) {
      formattedErrors.push(`[${formattedErrors.length + 1}+] nested errors truncated`);
    }
    return `${detail}; nested errors: ${formattedErrors.join(' | ')}`;
  } catch (nestedError) {
    return `${detail}; nested errors unavailable: ${inspectionErrorMessage(nestedError)}`;
  } finally {
    seen.delete(error);
  }
}

function wrapDmgInspectionError(error, context, dmgPath) {
  const detail = formatInspectionErrorDetail(error);
  const sourceContext = `source DMG: ${dmgPath}`;
  const detailWithSource = detail.endsWith(sourceContext)
    ? detail
    : `${detail}; ${sourceContext}`;
  const message = detail.startsWith(`${context}:`)
    ? detailWithSource
    : `${context}: DMG inspection failed: ${detailWithSource}`;
  return new Error(message, { cause: error });
}

async function inspectTauriApp({ appPath, architecture, execute = defaultExecute } = {}) {
  const descriptor = architectureDescriptorFor(architecture);
  if (path.basename(appPath) !== 'Ineed LinkLab.app') {
    throw new Error(`App bundle name must be Ineed LinkLab.app: ${appPath}`);
  }
  const canonicalAppPath = await requireRealDirectory(appPath, 'App bundle');
  const contentsPath = path.join(appPath, 'Contents');
  const plistPath = path.join(contentsPath, 'Info.plist');
  const executableDirectory = path.join(contentsPath, 'MacOS');
  const resourcesDirectory = path.join(contentsPath, 'Resources');
  await requireContainedRealDirectory(contentsPath, canonicalAppPath, 'App Contents directory');
  await Promise.all([
    requireContainedRealDirectory(executableDirectory, canonicalAppPath, 'App MacOS directory'),
    requireContainedRealDirectory(resourcesDirectory, canonicalAppPath, 'App Resources directory'),
    requireContainedNonemptyFile(plistPath, canonicalAppPath, 'Info.plist'),
  ]);

  const { stdout: plistJson } = await execute(
    'plutil',
    ['-convert', 'json', '-o', '-', plistPath],
    { encoding: 'utf8' },
  );
  let plist;
  try {
    plist = JSON.parse(plistJson);
  } catch (error) {
    throw new Error(`plutil returned invalid JSON for ${plistPath}`, { cause: error });
  }
  if (plist === null || typeof plist !== 'object' || Array.isArray(plist)) {
    throw new Error(`plutil must return a JSON object for ${plistPath}`);
  }

  requirePlistValue(plist, 'CFBundleIdentifier', 'com.ineedfull.dev-tool');
  requirePlistValue(plist, 'CFBundleShortVersionString', '0.1.0');
  requirePlistValue(plist, 'CFBundleVersion', '0.1.0');
  const displayName = plist.CFBundleDisplayName ?? plist.CFBundleName;
  if (requireNonblankString(displayName, 'CFBundleDisplayName/CFBundleName') !== 'Ineed LinkLab') {
    throw new Error('Info.plist display/name must equal "Ineed LinkLab"');
  }

  const executableName = requireLeafFilename(plist.CFBundleExecutable, 'CFBundleExecutable');
  if (executableName !== 'ineed-linklab-tauri') {
    throw new Error('Info.plist CFBundleExecutable must equal "ineed-linklab-tauri"');
  }
  const iconName = requireLeafFilename(plist.CFBundleIconFile, 'CFBundleIconFile');
  const resolvedIconName = path.extname(iconName) ? iconName : `${iconName}.icns`;
  if (path.extname(resolvedIconName) !== '.icns') {
    throw new Error('Info.plist CFBundleIconFile must resolve to a .icns file');
  }
  const executablePath = path.join(executableDirectory, executableName);
  const iconPath = path.join(resourcesDirectory, resolvedIconName);
  const [executableMetadata] = await Promise.all([
    requireContainedNonemptyFile(executablePath, canonicalAppPath, 'App executable'),
    requireContainedNonemptyFile(iconPath, canonicalAppPath, 'App icon'),
  ]);
  if ((executableMetadata.mode & 0o111) === 0) {
    throw new Error(`App executable must have at least one executable permission bit: ${executablePath}`);
  }
  await rejectLooseWebAssets(resourcesDirectory);

  const { stdout: fileOutput = '', stderr: fileErrorOutput = '' } = await execute(
    'file',
    ['-b', executablePath],
    { encoding: 'utf8' },
  );
  const fileDescription = `${fileOutput}\n${fileErrorOutput}`;
  const otherArchitecture = architecture === 'arm64' ? 'x64' : 'arm64';
  const otherDescriptor = ARCHITECTURE_DESCRIPTORS[otherArchitecture];
  if (
    !/\bMach-O\b/i.test(fileDescription)
    || !descriptor.fileTokenPattern.test(fileDescription)
    || otherDescriptor.fileTokenPattern.test(fileDescription)
    || /\buniversal\b/i.test(fileDescription)
  ) {
    throw new Error(
      `App executable must be a Mach-O binary containing exactly ${architecture} architecture: `
      + `${executablePath}; `
      + `file -b reported ${JSON.stringify(fileDescription.trim())}`,
    );
  }

  const signing = await inspectSigning(appPath, execute);
  return {
    identity: {
      bundleIdentifier: 'com.ineedfull.dev-tool',
      bundleShortVersion: '0.1.0',
      bundleVersion: '0.1.0',
      displayName: 'Ineed LinkLab',
      executableName,
      iconName: resolvedIconName,
    },
    runtime: {
      executable: {
        path: relativeAppPath(appPath, executablePath),
        mode: executableMetadata.mode & 0o777,
        architecture,
      },
      iconPath: relativeAppPath(appPath, iconPath),
      signing,
    },
  };
}

export async function verifyTauriMacPackage({
  architecture = 'arm64',
  bundleRoot = bundleRootFor(architecture),
  execute = defaultExecute,
  inspectDmgApp = inspectMountedDmgApp,
} = {}) {
  const descriptor = architectureDescriptorFor(architecture);
  const macosRoot = path.join(bundleRoot, 'macos');
  const dmgRoot = path.join(bundleRoot, 'dmg');
  const [canonicalMacosRoot, canonicalDmgRoot] = await Promise.all([
    requireRealDirectory(macosRoot, 'Tauri macOS bundle directory'),
    requireRealDirectory(dmgRoot, 'Tauri DMG directory'),
  ]);
  const appPath = await findOnlyArtifact(
    macosRoot,
    'app bundle',
    (entry) => path.extname(entry.name) === '.app',
  );
  if (path.basename(appPath) !== 'Ineed LinkLab.app') {
    throw new Error(`App bundle name must be Ineed LinkLab.app: ${appPath}`);
  }
  const canonicalAppPath = await requireContainedRealDirectory(
    appPath,
    canonicalMacosRoot,
    'App bundle',
  );
  const dmgPath = await findOnlyArtifact(
    dmgRoot,
    'DMG artifact',
    (entry) => path.extname(entry.name) === '.dmg',
  );
  if (!descriptor.dmgPattern.test(path.basename(dmgPath))) {
    throw new Error(
      `DMG artifact name is not valid for Ineed LinkLab 0.1.0 ${architecture}: ${dmgPath}`,
    );
  }
  await requireContainedNonemptyFile(dmgPath, canonicalDmgRoot, 'DMG artifact');

  const sidecarEvidence = await inspectTauriApp({ appPath, architecture, execute });
  const sidecarManifest = await createAppManifest(canonicalAppPath);
  const embeddedAssetExtensions = await inspectEmbeddedAssets(bundleRoot);
  const context = `tauri:${architecture}`;
  const mountedContext = `${context}: mounted app`;
  try {
    await inspectDmgApp({
      dmgPath,
      execute,
      inspect: async (mountedAppPath) => {
        try {
          const mountedEvidence = await inspectTauriApp({
            appPath: mountedAppPath,
            architecture,
            execute,
          });
          assertRuntimeEvidenceEqual(sidecarEvidence, mountedEvidence, mountedContext);
          const mountedManifest = await createAppManifest(mountedAppPath);
          assertAppManifestsEqual(sidecarManifest, mountedManifest, mountedContext);
          return mountedEvidence;
        } catch (error) {
          if (error?.message?.startsWith(`${mountedContext}:`)) {
            throw error;
          }
          throw new Error(`${mountedContext}: validation failed: ${error.message}`, { cause: error });
        }
      },
    });
  } catch (error) {
    throw wrapDmgInspectionError(error, context, dmgPath);
  }

  const sidecarChangedContext = `${context}: sidecar changed during verification`;
  let finalSidecarEvidence;
  let finalSidecarManifest;
  try {
    finalSidecarEvidence = await inspectTauriApp({ appPath, architecture, execute });
    finalSidecarManifest = await createAppManifest(canonicalAppPath);
  } catch (error) {
    throw new Error(`${sidecarChangedContext}: validation failed: ${error.message}`, { cause: error });
  }
  assertRuntimeEvidenceEqual(sidecarEvidence, finalSidecarEvidence, sidecarChangedContext);
  assertAppManifestsEqual(sidecarManifest, finalSidecarManifest, sidecarChangedContext);

  return {
    appPath,
    dmgPath,
    architecture,
    signing: sidecarEvidence.runtime.signing,
    embeddedAssetExtensions,
  };
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
    const results = [];
    for (const architecture of ['arm64', 'x64']) {
      results.push(await verifyTauriMacPackage({ architecture }));
    }
    console.log(`TAURI_MAC_PACKAGE_RESULT=${JSON.stringify(results)}`);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
