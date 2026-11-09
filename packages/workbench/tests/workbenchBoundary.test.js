import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertRuntimeAdapter,
  createUnavailableRuntimeAdapter,
} from '@ineed-linklab/runtime-contract';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { createApp as createVueApp, createSSRApp, inject } from 'vue';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'src');

const prohibitedGlobalNames = [
  'electron',
  'ineedLinkLab',
  '__TAURI__',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
];

const forbiddenBoundaryPatterns = [
  ...prohibitedGlobalNames.map((name) => [
    `${name} host global`,
    new RegExp(
      `\\b(?:window|globalThis)\\s*(?:\\.\\s*${name}\\b|\\[\\s*['"]${name}['"]\\s*\\])`,
      'i',
    ),
  ]),
  ['localStorage API', /(?<![.\w])localStorage\s*\./i],
  ['sessionStorage API', /(?<![.\w])sessionStorage\s*\./i],
  ['indexedDB API', /(?<![.\w])indexedDB\s*\./i],
  ['CacheStorage API', /\bCacheStorage\b/],
  ['caches API', /(?<![.\w])caches\s*\.\s*(?:open|match|has|delete|keys)\s*\(/i],
  ['electron import', moduleAccessPattern('electron')],
  ['Tauri import', moduleAccessPattern('@tauri-apps(?:/[^\'"]*)?')],
  ['node:net import', moduleAccessPattern('node:net')],
  ['node:dgram import', moduleAccessPattern('node:dgram')],
  ['serialport import', moduleAccessPattern('(?:serialport|@serialport/[^\'"]+)')],
  ['MQTT import', moduleAccessPattern('mqtt(?:/[^\'"]*)?')],
  ['ipcRenderer bridge', /\bipcRenderer\b/],
  ['native invoke bridge', /\b(?:nativeInvoke|invokeNative|tauriInvoke)\b/],
  ['MQTT bridge identifier', /\b(?:mqttClient|MqttClient|MQTTClient|mqttConnection|mqttTopic)\b/],
];

test('workbench package is private ESM with explicit shared exports and dependencies', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.name, '@ineed-linklab/workbench');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.exports, {
    '.': './src/createWorkbench.js',
    './App.vue': './src/App.vue',
    './base.css': './src/styles/base.css',
    './runtimeContext.js': './src/runtimeContext.js',
  });
  assert.equal(manifest.dependencies.vue, '^3.5.39');
  assert.equal(manifest.dependencies['@ineed-linklab/runtime-contract'], '*');
  assert.equal(manifest.devDependencies['@vue/compiler-sfc'], '^3.5.39');
  assert.equal(manifest.devDependencies['@vue/server-renderer'], '^3.5.39');
  assert.equal(manifest.devDependencies['@vue/test-utils'], '^2.4.11');
  assert.equal(manifest.devDependencies.jsdom, '^26.1.0');
  assert.equal(manifest.devDependencies.vitest, '^4.1.10');
  assert.equal(manifest.scripts['test:components'], 'vitest run --config vitest.config.js');
});

test('shared source reports forbidden boundary access by file and line', async () => {
  const files = await readTextFiles(sourceRoot);
  const matches = scanForbiddenBoundaries(files);

  assert.deepEqual(matches, [], formatBoundaryMatches(matches));
});

test('boundary checker detects static, computed, module, and bridge access precisely', () => {
  const fixtures = [
    ...prohibitedGlobalNames.flatMap((name) => [
      [`${name} host global`, `window.${name}`],
      [`${name} host global`, `globalThis["${name}"]`],
    ]),
    ['electron host global', 'globalThis[\n  "electron"\n]'],
    ['localStorage API', 'localStorage.getItem("endpoint")'],
    ['sessionStorage API', 'sessionStorage.setItem("endpoint", value)'],
    ['indexedDB API', 'indexedDB.open("workbench")'],
    ['CacheStorage API', '/** @type {CacheStorage} */'],
    ['caches API', 'await caches.open("workbench")'],
    ['electron import', 'import electron from "electron"'],
    ['electron import', 'const electron = require("electron")'],
    ['Tauri import', 'const core = await import("@tauri-apps/api/core")'],
    ['Tauri import', 'const core = require("@tauri-apps/api/core")'],
    ['node:net import', 'import net from "node:net"'],
    ['node:dgram import', 'const dgram = require("node:dgram")'],
    ['serialport import', 'import { SerialPort } from "serialport"'],
    ['serialport import', 'const parser = require("@serialport/parser-readline")'],
    ['MQTT import', 'import mqtt from "mqtt"'],
    ['MQTT import', 'const mqtt = require("mqtt/dist/mqtt")'],
    ['ipcRenderer bridge', 'bridge.ipcRenderer.send("open")'],
    ['native invoke bridge', 'nativeInvoke("open")'],
    ['MQTT bridge identifier', 'const mqttClient = bridge.client'],
  ];

  for (const [expectedLabel, source] of fixtures) {
    const matches = scanForbiddenBoundaries([{ path: 'fixture.js', contents: `safe();\n${source}` }]);
    assert.deepEqual(matches, [{ file: 'fixture.js', line: 2, label: expectedLabel }], source);
  }
});

test('boundary checker permits generic calls and ordinary cache or topic prose', () => {
  const benignSource = [
    'invoke(action);',
    'const caches = [];',
    'The renderer caches computed labels.',
    'Topic publishing and subscription concepts belong in documentation.',
  ].join('\n');

  assert.deepEqual(
    scanForbiddenBoundaries([{ path: 'notes.txt', contents: benignSource }]),
    [],
  );
});

test('App.vue parses and compiles as a Vue SFC', async () => {
  const compiled = await compileAppSfc();

  assert.equal(typeof compiled.script.content, 'string');
  assert.equal(typeof compiled.template.code, 'string');
});

test('createWorkbench validates runtimeName before creating a Vue app', async () => {
  const events = [];
  const factoryModule = await loadFactoryWithSpies({
    assertAdapter(adapter) {
      events.push(['assert', adapter]);
      return assertRuntimeAdapter(adapter);
    },
    createVueApp(component) {
      events.push(['createApp', component]);
      return createVueApp(component);
    },
  });

  for (const runtimeName of [undefined, '', '   ', 42]) {
    const adapter = createUnavailableRuntimeAdapter('valid-name');
    adapter.runtimeName = runtimeName;
    events.length = 0;

    assert.throws(
      () => factoryModule.createWorkbench(adapter),
      /runtimeName must be a nonblank string/,
    );
    assert.deepEqual(events.map(([event]) => event), ['assert']);
  }
});

test('createWorkbench keeps method validation before creating a Vue app', async () => {
  const events = [];
  const factoryModule = await loadFactoryWithSpies({
    assertAdapter(adapter) {
      events.push(['assert', adapter]);
      return assertRuntimeAdapter(adapter);
    },
    createVueApp(component) {
      events.push(['createApp', component]);
      return createVueApp(component);
    },
  });

  assert.throws(
    () => factoryModule.createWorkbench({ runtimeName: 'test-runtime' }),
    /missing required methods/i,
  );
  assert.deepEqual(events.map(([event]) => event), ['assert']);
});

test('valid adapter returns an unmounted app provided under the stable symbol', async () => {
  const events = [];
  const factoryModule = await loadFactoryWithSpies({
    assertAdapter(adapter) {
      events.push(['assert', adapter]);
      return assertRuntimeAdapter(adapter);
    },
    createVueApp(component) {
      events.push(['createApp', component]);
      const app = createVueApp(component);
      const mount = app.mount.bind(app);
      const provide = app.provide.bind(app);
      app.mount = (...args) => {
        events.push(['mount', ...args]);
        return mount(...args);
      };
      app.provide = (key, value) => {
        events.push(['provide', key, value]);
        return provide(key, value);
      };
      return app;
    },
  });
  const adapter = createUnavailableRuntimeAdapter('test-runtime');
  const app = factoryModule.createWorkbench(adapter);

  assert.equal(typeof app.mount, 'function');
  assert.equal(typeof app.use, 'function');
  assert.deepEqual(events.map(([event]) => event), ['assert', 'createApp', 'provide']);
  assert.equal(events[2][1], factoryModule.runtimeAdapterKey);
  assert.equal(events[2][2], adapter);
  assert.equal(
    app.runWithContext(() => inject(factoryModule.runtimeAdapterKey)),
    adapter,
  );
});

test('runtime context has a stable key and deterministic missing-provider error', async () => {
  const contextUrl = pathToFileURL(path.join(sourceRoot, 'runtimeContext.js')).href;
  const first = await import(`${contextUrl}?first`);
  const second = await import(`${contextUrl}?second`);
  const app = createSSRApp({ setup: first.useRuntimeAdapter, template: '<div />' });

  assert.equal(typeof first.runtimeAdapterKey, 'symbol');
  assert.equal(first.runtimeAdapterKey, second.runtimeAdapterKey);
  assert.equal(first.runtimeAdapterKey, Symbol.for('@ineed-linklab/workbench/runtime-adapter'));
  assert.throws(
    () => app.runWithContext(first.useRuntimeAdapter),
    new Error('Ineed LinkLab runtime adapter was not provided'),
  );
});

test('App.vue passes the provided runtimeName to the shared shell', async () => {
  const source = await readFile(path.join(sourceRoot, 'App.vue'), 'utf8');

  assert.match(source, /<LinkLabShell/);
  assert.match(source, /:runtime-name="runtimeAdapter\.runtimeName"/);
});

test('factory validates before createApp, stays unmounted, and avoids the App import cycle', async () => {
  const factorySource = await readFile(path.join(sourceRoot, 'createWorkbench.js'), 'utf8');
  const appSource = await readFile(path.join(sourceRoot, 'App.vue'), 'utf8');
  const validationIndex = factorySource.indexOf('assertRuntimeAdapter(runtimeAdapter)');
  const createIndex = factorySource.indexOf('createApp(');

  assert.notEqual(validationIndex, -1);
  assert.notEqual(createIndex, -1);
  assert.ok(validationIndex < createIndex);
  assert.doesNotMatch(factorySource, /\.mount\s*\(/);
  assert.doesNotMatch(factorySource, /document\.(querySelector|getElementById)/);
  assert.match(factorySource, /from ['"]\.\/runtimeContext\.js['"]/);
  assert.match(appSource, /from ['"]\.\/runtimeContext\.js['"]/);
  assert.doesNotMatch(appSource, /createWorkbench\.js/);
});

test('App.vue composes the runtime-neutral shared protocol workbench', async () => {
  const appSource = await readFile(path.join(sourceRoot, 'App.vue'), 'utf8');
  const shellSource = await readFile(path.join(sourceRoot, 'layouts/LinkLabShell.vue'), 'utf8');
  const combined = `${appSource}\n${shellSource}`;

  assert.match(appSource, /useRuntimeAdapter\s*\(\s*\)/);
  assert.match(appSource, /createWorkbenchModel\s*\(\s*runtimeAdapter/);
  assert.match(appSource, /<LinkLabShell/);
  assert.match(shellSource, /Ineed LinkLab/);
  assert.match(shellSource, /未选择端点/);
  assert.doesNotMatch(combined, /Electron|Tauri/);
});

test('runtime details live in About without consuming workspace header space', async () => {
  const shellSource = await readFile(path.join(sourceRoot, 'layouts/LinkLabShell.vue'), 'utf8');
  const aboutSource = await readFile(path.join(sourceRoot, 'components/AboutPanel.vue'), 'utf8');
  assert.doesNotMatch(shellSource, /class="workbench__runtime"/);
  assert.match(shellSource, /:runtime-name="runtimeName"/);
  assert.match(aboutSource, /运行环境/);
  assert.match(aboutSource, /\{\{ runtimeName \}\}/);
});

test('workbench styling is restrained and avoids landing-page decoration', async () => {
  const appSource = await readFile(path.join(sourceRoot, 'App.vue'), 'utf8');
  const css = `${await readFile(path.join(sourceRoot, 'styles/base.css'), 'utf8')}\n${await readFile(path.join(sourceRoot, 'styles/workbench.css'), 'utf8')}`;
  const combined = `${appSource}\n${css}`;

  assert.match(css, /min-width\s*:/);
  assert.match(css, /min-height\s*:/);
  assert.doesNotMatch(combined, /gradient|\bhero\b|\btagline\b|\bcard\b/i);
  assert.doesNotMatch(css, /font-size\s*:\s*(?:[4-9]\d|\d{3,})px/i);
});

function moduleAccessPattern(modulePattern) {
  return new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)['"]${modulePattern}['"]`,
    'i',
  );
}

async function readTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readTextFiles(entryPath));
    } else if (/\.(?:css|html|js|json|ts|vue)$/.test(entry.name)) {
      files.push({ path: entryPath, contents: await readFile(entryPath, 'utf8') });
    }
  }

  return files;
}

function scanForbiddenBoundaries(files) {
  const matches = [];

  for (const file of files) {
    for (const [label, pattern] of forbiddenBoundaryPatterns) {
      const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
      for (const match of file.contents.matchAll(globalPattern)) {
        const line = file.contents.slice(0, match.index).split(/\r?\n/).length;
        matches.push({ file: file.path, line, label });
      }
    }
  }

  return matches.sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.label.localeCompare(right.label)
  ));
}

function formatBoundaryMatches(matches) {
  return matches.map(({ file, line, label }) => `${file}:${line} ${label}`).join('\n');
}

async function compileAppSfc() {
  const filename = path.join(sourceRoot, 'App.vue');
  const source = await readFile(filename, 'utf8');
  const { descriptor, errors: parseErrors } = parse(source, { filename });

  assert.deepEqual(parseErrors, []);
  assert.ok(descriptor.template);

  const script = compileScript(descriptor, { id: 'workbench-app', genDefaultAs: '__sfc__' });
  const template = compileTemplate({
    id: 'workbench-app',
    filename,
    source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(template.errors, []);

  return { script, template };
}

async function loadFactoryWithSpies(overrides = {}) {
  const source = await readFile(path.join(sourceRoot, 'createWorkbench.js'), 'utf8');
  const token = Math.random().toString(36).slice(2);
  const assertKey = `__workbenchAssert_${token}`;
  const createKey = `__workbenchCreate_${token}`;
  const componentKey = `__workbenchComponent_${token}`;
  const contextKey = `__workbenchContext_${token}`;

  globalThis[assertKey] = overrides.assertAdapter ?? assertRuntimeAdapter;
  globalThis[createKey] = overrides.createVueApp ?? createVueApp;
  globalThis[componentKey] = Object.freeze({ name: 'TestWorkbenchRoot' });
  globalThis[contextKey] = {
    runtimeAdapterKey: Symbol.for('@ineed-linklab/workbench/runtime-adapter'),
    presentationStorageKey: Symbol.for('@ineed-linklab/workbench/presentation-storage'),
    useRuntimeAdapter() {},
  };

  const transformed = source
    .replace(
      /import\s+\{\s*assertRuntimeAdapter\s*\}\s+from\s+['"]@ineed-linklab\/runtime-contract['"];?/,
      `const assertRuntimeAdapter = globalThis.${assertKey};`,
    )
    .replace(
      /import\s+\{\s*createApp\s*\}\s+from\s+['"]vue['"];?/,
      `const createApp = globalThis.${createKey};`,
    )
    .replace(
      /import\s+App\s+from\s+['"]\.\/App\.vue['"];?/,
      `const App = globalThis.${componentKey};`,
    )
    .replace(
      /import\s+\{\s*runtimeAdapterKey\s*,\s*useRuntimeAdapter\s*,\s*presentationStorageKey\s*\}\s+from\s+['"]\.\/runtimeContext\.js['"];?/,
      `const { runtimeAdapterKey, useRuntimeAdapter, presentationStorageKey } = globalThis.${contextKey};`,
    );

  try {
    return await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transformed)}#${token}`);
  } finally {
    delete globalThis[assertKey];
    delete globalThis[createKey];
    delete globalThis[componentKey];
    delete globalThis[contextKey];
  }
}
