#!/usr/bin/env node

import { extractFile } from '@electron/asar';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ErrorCodes, parse } from 'parse5';

import {
  assertAppManifestsEqual,
  createAppManifest,
  inspectMountedDmgApp,
} from './macos-dmg-app-binding.mjs';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const REQUIRED_RENDERER_EXTENSIONS = ['.css', '.html', '.js'];
const BUNDLE_IDENTIFIER = 'com.ineedfull.dev-tool.electron';
const PRODUCT_NAME = 'Ineed LinkLab';
const PRODUCT_VERSION = '0.1.0';
const EXECUTABLE_NAME = PRODUCT_NAME;
const ELECTRON_VERSION = '43.1.0';
const ELECTRON_ABI = '148';
const NODE_GYP_BUILD_VERSION = '4.8.4';
const NODE_GYP_RESOLVER_SOURCE = `
const [resolverPath, bindingRoot] = process.argv.slice(1);
Object.defineProperty(process.versions, 'electron', { value: '${ELECTRON_VERSION}' });
Object.defineProperty(process.versions, 'modules', { value: '${ELECTRON_ABI}' });
const resolver = require(resolverPath);
process.stdout.write(resolver.path(bindingRoot));
`;

const ARCHITECTURES = Object.freeze({
  arm64: Object.freeze({
    lipoSlice: 'arm64',
  }),
  x64: Object.freeze({
    lipoSlice: 'x86_64',
  }),
});

function architectureDescriptorFor(architecture) {
  if (typeof architecture !== 'string' || !Object.hasOwn(ARCHITECTURES, architecture)) {
    throw new Error('architecture must be arm64 or x64');
  }
  return ARCHITECTURES[architecture];
}

export function releaseRootFor(architecture) {
  architectureDescriptorFor(architecture);
  return path.resolve(scriptDirectory, '..', 'apps', 'electron', 'release', architecture);
}

async function defaultExecute(file, args, options) {
  return execFileAsync(file, args, options);
}

async function defaultReadAsarFile(asarPath, entryPath) {
  return extractFile(asarPath, entryPath, false);
}

function nodeGypBuildResolverPath() {
  const moduleRequire = createRequire(import.meta.url);
  const bindingsPackagePath = moduleRequire.resolve('@serialport/bindings-cpp/package.json');
  const bindingsRequire = createRequire(bindingsPackagePath);
  const resolverPackagePath = bindingsRequire.resolve('node-gyp-build/package.json');
  const resolverPackage = bindingsRequire(resolverPackagePath);
  if (resolverPackage.version !== NODE_GYP_BUILD_VERSION) {
    throw new Error(
      `@serialport/bindings-cpp must resolve node-gyp-build ${NODE_GYP_BUILD_VERSION}, `
      + `found ${JSON.stringify(resolverPackage.version)}`,
    );
  }
  return path.join(path.dirname(resolverPackagePath), 'node-gyp-build.js');
}

async function defaultResolveNativeModule(bindingRoot, architecture) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PREBUILDS_ONLY: '',
    SERIALPORT_BINDINGS_CPP_PREBUILD: '',
    npm_config_arch: architecture,
    npm_config_platform: 'darwin',
  };
  const { stdout = '' } = await execFileAsync(
    process.execPath,
    ['-e', NODE_GYP_RESOLVER_SOURCE, nodeGypBuildResolverPath(), bindingRoot],
    { encoding: 'utf8', env },
  );
  const selectedPath = stdout.trim();
  if (selectedPath === '' || selectedPath.includes('\n') || selectedPath.includes('\r')) {
    throw new Error(`node-gyp-build returned an invalid binding path: ${JSON.stringify(stdout)}`);
  }
  return selectedPath;
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

async function requireContainedRealDirectory(directoryPath, canonicalRoot, description) {
  const canonicalPath = await requireRealDirectory(directoryPath, description);
  requireCanonicalContainment(canonicalPath, canonicalRoot, description);
  return canonicalPath;
}

async function requireContainedNonemptyFile(filePath, canonicalRoot, description) {
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
  const canonicalPath = await realpath(filePath);
  requireCanonicalContainment(canonicalPath, canonicalRoot, description);
  return metadata;
}

async function inspectRuntimeContractAssets(resourcesPath, canonicalAppPath) {
  const contractsRoot = path.join(resourcesPath, 'contracts');
  const migrationPath = path.join(
    contractsRoot,
    'persistence-contract',
    'migrations',
    '001-initial.sql',
  );
  const settingsSchemaPath = path.join(
    contractsRoot,
    'runtime-contract',
    'src',
    'settingsSchema.json',
  );
  const directories = [
    [contractsRoot, 'Runtime contracts directory'],
    [path.dirname(path.dirname(migrationPath)), 'Persistence contract directory'],
    [path.dirname(migrationPath), 'Persistence contract migrations directory'],
    [path.dirname(path.dirname(settingsSchemaPath)), 'Runtime contract directory'],
    [path.dirname(settingsSchemaPath), 'Runtime contract source directory'],
  ];
  for (const [directoryPath, description] of directories) {
    await requireContainedRealDirectory(directoryPath, canonicalAppPath, description);
  }

  await Promise.all([
    requireContainedNonemptyFile(
      migrationPath,
      canonicalAppPath,
      'Runtime contract migration SQL',
    ),
    requireContainedNonemptyFile(
      settingsSchemaPath,
      canonicalAppPath,
      'Runtime contract settings schema',
    ),
  ]);
  const sourceMigrationPath = path.join(
    repositoryRoot,
    'packages',
    'persistence-contract',
    'migrations',
    '001-initial.sql',
  );
  const sourceSettingsSchemaPath = path.join(
    repositoryRoot,
    'packages',
    'runtime-contract',
    'src',
    'settingsSchema.json',
  );
  const [migration, settingsSchema, sourceMigration, sourceSettingsSchema] = await Promise.all([
    readFile(migrationPath),
    readFile(settingsSchemaPath),
    readFile(sourceMigrationPath),
    readFile(sourceSettingsSchemaPath),
  ]);

  let parsedSettingsSchema;
  try {
    parsedSettingsSchema = JSON.parse(settingsSchema.toString('utf8'));
  } catch (error) {
    throw new Error('Runtime contract settings schema must contain valid JSON', { cause: error });
  }
  if (!migration.equals(sourceMigration)) {
    throw new Error(`Runtime contract migration SQL must match repository source ${sourceMigrationPath}`);
  }
  if (!settingsSchema.equals(sourceSettingsSchema)) {
    throw new Error(
      `Runtime contract settings schema must match repository source ${sourceSettingsSchemaPath}`,
    );
  }
  if (
    parsedSettingsSchema === null
    || typeof parsedSettingsSchema !== 'object'
    || Array.isArray(parsedSettingsSchema)
    || !Number.isSafeInteger(parsedSettingsSchema.schemaVersion)
    || parsedSettingsSchema.settings === null
    || typeof parsedSettingsSchema.settings !== 'object'
    || Array.isArray(parsedSettingsSchema.settings)
  ) {
    throw new Error('Runtime contract settings schema must contain schemaVersion and settings');
  }
  return [migrationPath, settingsSchemaPath];
}

async function discoverAppBundles(releaseRoot) {
  const matches = [];

  async function visit(directoryPath) {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to inspect Electron release directory ${directoryPath}: ${error.message}`, {
        cause: error,
      });
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        if (path.extname(entry.name) === '.app') {
          throw new Error(`App bundle must not be a symbolic link: ${entryPath}`);
        }
        if (directoryPath === releaseRoot && path.extname(entry.name) === '.dmg') {
          continue;
        }
        throw new Error(`Electron release discovery must not follow a symbolic link: ${entryPath}`);
      }
      if (!entry.isDirectory()) {
        continue;
      }
      if (path.extname(entry.name) === '.app') {
        matches.push(entryPath);
      } else {
        await visit(entryPath);
      }
    }
  }

  await visit(releaseRoot);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one app bundle under ${releaseRoot}, found ${matches.length}`);
  }
  return matches[0];
}

async function discoverDmg(releaseRoot) {
  let entries;
  try {
    entries = await readdir(releaseRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to inspect Electron release directory ${releaseRoot}: ${error.message}`, {
      cause: error,
    });
  }
  const matches = entries.filter((entry) => path.extname(entry.name) === '.dmg');
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one top-level DMG artifact in ${releaseRoot}, found ${matches.length}`);
  }
  const dmgPath = path.join(releaseRoot, matches[0].name);
  if (matches[0].isSymbolicLink()) {
    throw new Error(`DMG artifact must not be a symbolic link: ${dmgPath}`);
  }
  if (!matches[0].isFile()) {
    throw new Error(`DMG artifact must be a real file: ${dmgPath}`);
  }
  return dmgPath;
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
  if (requireNonblankString(plist[field], field) !== expected) {
    throw new Error(`Info.plist ${field} must equal ${JSON.stringify(expected)}`);
  }
}

function duplicateAttributeNameAt(html, offset) {
  let start = Math.max(0, offset - 1);
  while (start >= 0 && !/[\s"'<>/=]/.test(html[start])) {
    start -= 1;
  }
  return html.slice(start + 1, offset).toLowerCase() || 'unknown';
}

function localAsarAssetPath(reference) {
  if (
    typeof reference !== 'string'
    || reference.trim() === ''
    || reference.includes('\\')
    || reference.includes('\0')
    || reference.startsWith('/')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)
  ) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`);
  }

  let decodedReferencePath;
  try {
    [decodedReferencePath] = decodeURIComponent(reference).split(/[?#]/, 1);
  } catch (error) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`, {
      cause: error,
    });
  }
  if (decodedReferencePath.split('/').includes('..')) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`);
  }

  let url;
  try {
    url = new URL(reference, 'file:///dist/index.html');
  } catch (error) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`, {
      cause: error,
    });
  }
  if (
    url.protocol !== 'file:'
    || url.host !== ''
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`);
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`, {
      cause: error,
    });
  }
  if (pathname.includes('\\') || pathname.includes('\0')) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`);
  }
  const normalizedPath = path.posix.normalize(pathname);
  if (
    normalizedPath === '/dist'
    || !normalizedPath.startsWith('/dist/')
    || normalizedPath.split('/').includes('..')
  ) {
    throw new Error(`Renderer asset reference must be a local path within dist: ${reference}`);
  }
  return normalizedPath.slice(1);
}

function extractRendererReferences(html) {
  const parseErrors = [];
  const document = parse(html, { onParseError: (error) => parseErrors.push(error) });
  const duplicateAttribute = parseErrors.find(
    (error) => error.code === ErrorCodes.duplicateAttribute,
  );
  if (duplicateAttribute) {
    const attributeName = duplicateAttributeNameAt(html, duplicateAttribute.startOffset);
    throw new Error(`Duplicate renderer attribute is not allowed: ${attributeName}`);
  }

  const references = [];
  function visit(node) {
    if (node.tagName === 'base') {
      throw new Error('Renderer HTML base elements are not allowed');
    }
    if (node.tagName === 'script') {
      const src = node.attrs.find((attribute) => attribute.name === 'src')?.value;
      if (src !== undefined) {
        references.push(localAsarAssetPath(src));
      }
    } else if (node.tagName === 'link') {
      const relation = node.attrs.find((attribute) => attribute.name === 'rel')?.value ?? '';
      const relations = relation.toLowerCase().split(/\s+/);
      if (relations.includes('stylesheet')) {
        const href = node.attrs.find((attribute) => attribute.name === 'href')?.value;
        if (href === undefined) {
          throw new Error('Renderer stylesheet link must include a local href within dist');
        }
        references.push(localAsarAssetPath(href));
      }
    }
    for (const child of node.childNodes ?? []) {
      visit(child);
    }
  }
  visit(document);
  return [...new Set(references)].sort();
}

function nonemptyAsarBuffer(value, description) {
  const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value ?? []);
  if (buffer.length === 0) {
    throw new Error(`${description} must be nonempty`);
  }
  return buffer;
}

async function inspectRendererAssets(asarPath, readAsarFile) {
  let indexContents;
  try {
    indexContents = nonemptyAsarBuffer(
      await readAsarFile(asarPath, 'dist/index.html'),
      'Renderer ASAR .html entry dist/index.html',
    );
  } catch (error) {
    if (/must be nonempty/.test(error.message)) {
      throw error;
    }
    throw new Error('Renderer ASAR must include nonempty .html entry dist/index.html', {
      cause: error,
    });
  }
  const html = indexContents.toString('utf8');
  if (html.trim() === '') {
    throw new Error('Renderer ASAR .html entry dist/index.html must be nonempty');
  }

  const references = extractRendererReferences(html);
  const extensions = new Set(['.html']);
  for (const entryPath of references) {
    const extension = path.posix.extname(entryPath).toLowerCase();
    if (extension !== '.js' && extension !== '.css') {
      throw new Error(`Renderer asset reference must target a .js or .css entry: ${entryPath}`);
    }
    let contents;
    try {
      contents = await readAsarFile(asarPath, entryPath);
    } catch (error) {
      throw new Error(`Renderer ASAR must include nonempty ${extension} entry ${entryPath}`, {
        cause: error,
      });
    }
    nonemptyAsarBuffer(contents, `Renderer ASAR ${extension} entry ${entryPath}`);
    extensions.add(extension);
  }
  for (const requiredExtension of REQUIRED_RENDERER_EXTENSIONS) {
    if (!extensions.has(requiredExtension)) {
      throw new Error(`Renderer ASAR must include nonempty ${requiredExtension} entry`);
    }
  }
  return [...extensions].sort();
}

async function discoverNativeModules(bindingRoot, canonicalAppPath) {
  const modules = [];

  async function visit(directoryPath) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        const type = path.extname(entry.name) === '.node' ? 'module' : 'directory';
        throw new Error(`Native ${type} must not be a symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        await requireContainedRealDirectory(entryPath, canonicalAppPath, 'Native module directory');
        await visit(entryPath);
      } else if (entry.isFile()) {
        if (path.extname(entry.name).toLowerCase() === '.node') {
          await requireContainedNonemptyFile(entryPath, canonicalAppPath, 'Native serial module');
          modules.push(entryPath);
        }
      }
    }
  }

  await visit(bindingRoot);
  modules.sort();
  if (modules.length === 0) {
    throw new Error(`Expected @serialport/bindings-cpp .node module under ${bindingRoot}`);
  }
  return modules;
}

function requireMachOType(description, kind, filePath) {
  const typePattern = kind === 'native module'
    ? /(?:^|[^A-Za-z0-9_])bundle(?:$|[^A-Za-z0-9_])/i
    : /(?:^|[^A-Za-z0-9_])executable(?:$|[^A-Za-z0-9_])/i;
  if (
    !/(?:^|[^A-Za-z0-9_])Mach-O(?:$|[^A-Za-z0-9_])/i.test(description)
    || !typePattern.test(description)
  ) {
    throw new Error(
      `${kind} must be a Mach-O ${kind === 'native module' ? 'bundle' : 'executable'}: `
      + `${filePath}; file -b reported ${JSON.stringify(description.trim())}`,
    );
  }
}

async function inspectMachOSlices(filePath, kind, execute) {
  const { stdout: fileOutput = '', stderr: fileError = '' } = await execute(
    'file',
    ['-b', filePath],
    { encoding: 'utf8' },
  );
  requireMachOType(`${fileOutput}\n${fileError}`, kind, filePath);

  const { stdout: lipoOutput = '' } = await execute(
    'lipo',
    ['-archs', filePath],
    { encoding: 'utf8' },
  );
  const trimmedOutput = lipoOutput.trim();
  const slices = trimmedOutput === '' ? [] : trimmedOutput.split(/\s+/);
  if (
    slices.length === 0
    || new Set(slices).size !== slices.length
    || slices.some((slice) => !/^[A-Za-z0-9_]+$/.test(slice))
  ) {
    throw new Error(
      `lipo -archs returned an invalid architecture list for ${filePath}: `
      + JSON.stringify(trimmedOutput),
    );
  }
  return slices;
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

function relativeAppPath(canonicalAppPath, targetPath) {
  return path.relative(canonicalAppPath, targetPath).split(path.sep).join('/');
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

async function inspectElectronApp({
  appPath,
  architecture,
  execute = defaultExecute,
  readAsarFile = defaultReadAsarFile,
  resolveNativeModule = defaultResolveNativeModule,
} = {}) {
  architectureDescriptorFor(architecture);
  if (path.basename(appPath) !== `${PRODUCT_NAME}.app`) {
    throw new Error(`App bundle name must be ${PRODUCT_NAME}.app: ${appPath}`);
  }
  const canonicalAppPath = await requireRealDirectory(appPath, 'App bundle');
  const contentsPath = path.join(appPath, 'Contents');
  const plistPath = path.join(contentsPath, 'Info.plist');
  const macosPath = path.join(contentsPath, 'MacOS');
  const resourcesPath = path.join(contentsPath, 'Resources');
  await requireContainedRealDirectory(contentsPath, canonicalAppPath, 'App Contents directory');
  await Promise.all([
    requireContainedRealDirectory(macosPath, canonicalAppPath, 'App MacOS directory'),
    requireContainedRealDirectory(resourcesPath, canonicalAppPath, 'App Resources directory'),
    requireContainedNonemptyFile(plistPath, canonicalAppPath, 'Info.plist'),
  ]);
  const contractAssetPaths = await inspectRuntimeContractAssets(resourcesPath, canonicalAppPath);

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
  requirePlistValue(plist, 'CFBundleIdentifier', BUNDLE_IDENTIFIER);
  requirePlistValue(plist, 'CFBundleShortVersionString', PRODUCT_VERSION);
  requirePlistValue(plist, 'CFBundleVersion', PRODUCT_VERSION);
  requirePlistValue(plist, 'CFBundleDisplayName', PRODUCT_NAME);
  const executableName = requireLeafFilename(plist.CFBundleExecutable, 'CFBundleExecutable');
  if (executableName !== EXECUTABLE_NAME) {
    throw new Error(`Info.plist CFBundleExecutable must equal ${JSON.stringify(EXECUTABLE_NAME)}`);
  }
  const iconName = requireLeafFilename(plist.CFBundleIconFile, 'CFBundleIconFile');
  if (iconName !== 'icon.icns') {
    throw new Error('Info.plist CFBundleIconFile must equal "icon.icns"');
  }
  const executablePath = path.join(macosPath, executableName);
  const iconPath = path.join(resourcesPath, iconName);
  const asarPath = path.join(resourcesPath, 'app.asar');
  const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked');
  const [executableMetadata] = await Promise.all([
    requireContainedNonemptyFile(executablePath, canonicalAppPath, 'App executable'),
    requireContainedNonemptyFile(iconPath, canonicalAppPath, 'App icon'),
    requireContainedNonemptyFile(asarPath, canonicalAppPath, 'Renderer ASAR'),
    requireContainedRealDirectory(unpackedPath, canonicalAppPath, 'app.asar.unpacked directory'),
  ]);
  if ((executableMetadata.mode & 0o111) === 0) {
    throw new Error(`App executable must have at least one executable permission bit: ${executablePath}`);
  }

  const executableSlices = await inspectMachOSlices(executablePath, 'App executable', execute);
  const requiredSlice = architectureDescriptorFor(architecture).lipoSlice;
  if (executableSlices.length !== 1 || executableSlices[0] !== requiredSlice) {
    throw new Error(
      `App executable must contain exactly ${architecture} architecture: ${executablePath}; `
      + `lipo -archs reported ${JSON.stringify(executableSlices)}`,
    );
  }

  const rendererAssets = await inspectRendererAssets(asarPath, readAsarFile);
  const bindingRoot = path.join(
    unpackedPath,
    'node_modules',
    '@serialport',
    'bindings-cpp',
  );
  const canonicalBindingRoot = await requireContainedRealDirectory(
    bindingRoot,
    canonicalAppPath,
    '@serialport/bindings-cpp directory',
  );
  const discoveredNativeModules = await discoverNativeModules(bindingRoot, canonicalAppPath);
  const resolvedNativePath = await resolveNativeModule(bindingRoot, architecture);
  if (typeof resolvedNativePath !== 'string' || !path.isAbsolute(resolvedNativePath)) {
    throw new Error('node-gyp-build must return an absolute runtime-selected binding path');
  }
  await requireContainedNonemptyFile(
    resolvedNativePath,
    canonicalBindingRoot,
    'Runtime-selected native serial module',
  );
  const canonicalNativePath = await realpath(resolvedNativePath);
  const canonicalCandidates = await Promise.all(
    discoveredNativeModules.map((candidatePath) => realpath(candidatePath)),
  );
  if (!canonicalCandidates.includes(canonicalNativePath)) {
    throw new Error(`Runtime-selected native serial module was not discovered: ${resolvedNativePath}`);
  }
  const nativeSlices = await inspectMachOSlices(resolvedNativePath, 'native module', execute);
  if (!nativeSlices.includes(requiredSlice)) {
    throw new Error(
      `Runtime-selected native serial module must include requested ${architecture} architecture: `
      + `${resolvedNativePath}; lipo -archs reported ${JSON.stringify(nativeSlices)}`,
    );
  }
  const signing = await inspectSigning(appPath, execute);

  return {
    identity: {
      bundleIdentifier: BUNDLE_IDENTIFIER,
      bundleShortVersion: PRODUCT_VERSION,
      bundleVersion: PRODUCT_VERSION,
      displayName: PRODUCT_NAME,
      executableName,
      iconName,
    },
    runtime: {
      executable: {
        path: relativeAppPath(appPath, executablePath),
        mode: executableMetadata.mode & 0o777,
        slices: executableSlices,
      },
      contractAssets: contractAssetPaths.map((assetPath) => (
        relativeAppPath(appPath, assetPath)
      )),
      asar: {
        path: relativeAppPath(appPath, asarPath),
        rendererAssets,
      },
      nativeModules: [{
        path: relativeAppPath(canonicalAppPath, canonicalNativePath),
        slices: nativeSlices,
      }],
      signing,
    },
    selectedNativeModules: [resolvedNativePath],
  };
}

export async function verifyElectronMacPackage({
  architecture = 'arm64',
  releaseRoot = releaseRootFor(architecture),
  execute = defaultExecute,
  readAsarFile = defaultReadAsarFile,
  resolveNativeModule = defaultResolveNativeModule,
  inspectDmgApp = inspectMountedDmgApp,
} = {}) {
  architectureDescriptorFor(architecture);
  const canonicalReleaseRoot = await requireRealDirectory(releaseRoot, 'Electron release root');
  const appPath = await discoverAppBundles(releaseRoot);
  if (path.basename(appPath) !== `${PRODUCT_NAME}.app`) {
    throw new Error(`App bundle name must be ${PRODUCT_NAME}.app: ${appPath}`);
  }
  const canonicalAppPath = await requireContainedRealDirectory(
    appPath,
    canonicalReleaseRoot,
    'App bundle',
  );
  const dmgPath = await discoverDmg(releaseRoot);
  if (path.basename(dmgPath) !== `${PRODUCT_NAME}-Electron_${PRODUCT_VERSION}_${architecture}.dmg`) {
    throw new Error(
      `DMG artifact name must be ${PRODUCT_NAME}-Electron_${PRODUCT_VERSION}_${architecture}.dmg: ${dmgPath}`,
    );
  }
  await requireContainedNonemptyFile(dmgPath, canonicalReleaseRoot, 'DMG artifact');
  const sidecarEvidence = await inspectElectronApp({
    appPath,
    architecture,
    execute,
    readAsarFile,
    resolveNativeModule,
  });
  const sidecarManifest = await createAppManifest(canonicalAppPath);
  const context = `electron:${architecture}`;
  const mountedContext = `${context}: mounted app`;
  try {
    await inspectDmgApp({
      dmgPath,
      execute,
      inspect: async (mountedAppPath) => {
        try {
          const mountedEvidence = await inspectElectronApp({
            appPath: mountedAppPath,
            architecture,
            execute,
            readAsarFile,
            resolveNativeModule,
          });
          assertRuntimeEvidenceEqual(
            { identity: sidecarEvidence.identity, runtime: sidecarEvidence.runtime },
            { identity: mountedEvidence.identity, runtime: mountedEvidence.runtime },
            mountedContext,
          );
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
    finalSidecarEvidence = await inspectElectronApp({
      appPath,
      architecture,
      execute,
      readAsarFile,
      resolveNativeModule,
    });
    finalSidecarManifest = await createAppManifest(canonicalAppPath);
  } catch (error) {
    throw new Error(`${sidecarChangedContext}: validation failed: ${error.message}`, {
      cause: error,
    });
  }
  assertRuntimeEvidenceEqual(
    { identity: sidecarEvidence.identity, runtime: sidecarEvidence.runtime },
    { identity: finalSidecarEvidence.identity, runtime: finalSidecarEvidence.runtime },
    sidecarChangedContext,
  );
  assertAppManifestsEqual(sidecarManifest, finalSidecarManifest, sidecarChangedContext);

  return {
    appPath,
    dmgPath,
    architecture,
    bundleIdentifier: sidecarEvidence.identity.bundleIdentifier,
    signing: sidecarEvidence.runtime.signing,
    rendererAssets: sidecarEvidence.runtime.asar.rendererAssets,
    nativeModules: sidecarEvidence.selectedNativeModules,
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
      results.push(await verifyElectronMacPackage({ architecture }));
    }
    console.log(`ELECTRON_MAC_PACKAGE_RESULT=${JSON.stringify(results)}`);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
