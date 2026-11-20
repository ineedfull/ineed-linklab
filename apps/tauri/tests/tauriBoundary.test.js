import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REQUIRED_RUNTIME_METHODS } from '@ineed-linklab/runtime-contract';
import { createWorkbenchModel } from '../../../packages/workbench/src/model/createWorkbenchModel.js';
import { createFakeTimers } from '../../../packages/workbench/tests/helpers/fakeTimers.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(packageRoot, '..', '..');
const rustRoot = path.join(packageRoot, 'src-tauri');
const emptyPage = { rows: [], total: 0, page: 1, pageSize: 100 };
const emptyStats = {
  frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 0,
};
const eventMappings = new Map([
  ['transport.onFrames', 'transport:frames'],
  ['transport.onStatus', 'transport:status'],
  ['transport.onPeers', 'transport:peers'],
  ['modbus.onTransactions', 'modbus:transaction'],
  ['lifecycle.onBeforeShutdown', 'lifecycle:before-shutdown'],
]);
const commandMethods = REQUIRED_RUNTIME_METHODS.filter((method) => !eventMappings.has(method));
const commandFor = (method) => method.replace('.', '_').replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

test('package manifest defines the private ESM Tauri and fixed Vite workspace', async () => {
  const manifest = JSON.parse(await read('package.json'));

  assert.equal(manifest.name, '@ineed-linklab/tauri');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.scripts.build, 'vite build');
  assert.equal(manifest.scripts.dev, 'node ../../scripts/dev-tauri.mjs');
  assert.equal(manifest.scripts['tauri:build'], 'tauri build');
  assert.match(manifest.scripts['dev:renderer'], /vite --host 127\.0\.0\.1 --port 5174 --strictPort/);
  assert.equal(manifest.dependencies['@ineed-linklab/workbench'], '*');
  assert.equal(manifest.dependencies.vue, '^3.5.39');
  assert.match(manifest.dependencies['@tauri-apps/api'], /^\^2\./);
  assert.equal(manifest.dependencies['@tauri-apps/plugin-dialog'], undefined);
  assert.equal(manifest.dependencies['@tauri-apps/plugin-clipboard-manager'], undefined);
  assert.equal(manifest.devDependencies['@ineed-linklab/runtime-contract'], '*');
  assert.match(manifest.devDependencies.vite, /^\^8\./);
  assert.match(manifest.devDependencies['@vitejs/plugin-vue'], /^\^6\./);
  assert.match(manifest.devDependencies['@tauri-apps/cli'], /^\^2\.11\./);
});

test('both renderer documents prevent a white startup canvas before modules load', async () => {
  const electronHtml = await readFile(path.join(root, 'apps', 'electron', 'index.html'), 'utf8');
  const tauriHtml = await read('index.html');
  for (const html of [electronHtml, tauriHtml]) {
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /<style>[\s\S]*color-scheme:\s*light dark/);
    assert.match(html, /prefers-color-scheme:\s*dark/);
    assert.ok(html.indexOf('<style>') < html.indexOf('type="module"'));
    assert.doesNotMatch(html, /localStorage|sessionStorage/);
  }
});

test('Vite and Tauri config separate production CSP from loopback development sources', async () => {
  const viteSource = await read('vite.config.js');
  const config = JSON.parse(await read('src-tauri/tauri.conf.json'));
  const window = config.app.windows[0];

  assert.match(viteSource, /base:\s*['"]\.\/['"]/);
  assert.match(viteSource, /port:\s*5174/);
  assert.match(viteSource, /strictPort:\s*true/);
  assert.match(viteSource, /host:\s*['"]127\.0\.0\.1['"]/);
  assert.match(viteSource, /outDir:\s*['"]dist['"]/);
  assert.equal(config.productName, 'Ineed LinkLab');
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(config.version, rootManifest.version);
  assert.equal(config.identifier, 'com.ineedfull.dev-tool');
  assert.equal(config.build.beforeDevCommand, 'npm run dev:renderer');
  assert.equal(config.build.devUrl, 'http://127.0.0.1:5174');
  assert.equal(config.build.beforeBuildCommand, 'npm run build');
  assert.equal(config.build.frontendDist, '../dist');
  assert.deepEqual(window, {
    label: 'main', title: 'Ineed LinkLab', width: 1360, height: 860,
    minWidth: 1120, minHeight: 720,
    backgroundThrottling: 'disabled',
  });
  assert.equal(config.app.withGlobalTauri, false);
  assert.equal(typeof config.app.security.csp, 'string');
  assert.match(config.app.security.csp, /default-src 'self'/);
  assert.doesNotMatch(config.app.security.csp, /unsafe-eval|\*/);
  assert.doesNotMatch(config.app.security.csp, /127\.0\.0\.1:5174|\bws:/);
  assert.equal(typeof config.app.security.devCsp, 'string');
  assert.match(config.app.security.devCsp, /http:\/\/127\.0\.0\.1:5174/);
  assert.match(config.app.security.devCsp, /ws:\/\/127\.0\.0\.1:5174/);
  assert.doesNotMatch(config.app.security.devCsp, /unsafe-eval|\*/);
});

test('cross-platform defaults allow all bundles and macOS commands select app and DMG targets', async () => {
  const [config, rootManifest] = await Promise.all([
    read('src-tauri/tauri.conf.json').then(JSON.parse),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  assert.equal(config.bundle.active, true);
  assert.equal(config.bundle.targets, 'all');
  assert.equal(
    rootManifest.scripts['package:mac:tauri:arm64'],
    'npm run tauri:build -w @ineed-linklab/tauri -- --target aarch64-apple-darwin --bundles app,dmg --no-sign --ci',
  );
  assert.equal(
    rootManifest.scripts['package:mac:tauri:x64'],
    'npm run tauri:build -w @ineed-linklab/tauri -- --target x86_64-apple-darwin --bundles app,dmg --no-sign --ci',
  );
  assert.equal(
    rootManifest.scripts['package:mac:tauri'],
    'npm run package:mac:tauri:arm64 && npm run package:mac:tauri:x64',
  );
  assert.equal(
    rootManifest.scripts['package:mac'],
    'npm run package:mac:electron && npm run package:mac:tauri && node scripts/collect-macos-dmgs.mjs',
  );
  assert.equal(
    rootManifest.scripts['verify:package:mac:tauri'],
    'node scripts/verify-tauri-macos-package.mjs',
  );
  assert.equal(
    rootManifest.scripts['verify:package:mac'],
    'node scripts/verify-macos-packages.mjs',
  );
});

test('capabilities grant only event subscription and no renderer file dialogs', async () => {
  const capability = JSON.parse(await read('src-tauri/capabilities/default.json'));
  const historyCapability = JSON.parse(await read('src-tauri/capabilities/history.json'));

  assert.equal(capability.identifier, 'default');
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.permissions, [
    'core:event:allow-listen',
    'core:event:allow-unlisten',
  ]);
  assert.equal(capability.permissions.some((permission) => permission.startsWith('fs:')), false);
  assert.equal(historyCapability.identifier, 'history');
  assert.deepEqual(historyCapability.windows, ['history-*']);
  assert.deepEqual(historyCapability.permissions, [
    'core:event:allow-listen',
    'core:event:allow-unlisten',
  ]);
});

test('cross-platform icons are valid and build tracks the app icon without generated schemas', async () => {
  const [config, buildSource, gitignore] = await Promise.all([
    read('src-tauri/tauri.conf.json').then(JSON.parse),
    read('src-tauri/build.rs'),
    readFile(path.join(root, '.gitignore'), 'utf8'),
  ]);

  assert.deepEqual(config.bundle.icon, [
    'icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png',
    'icons/icon.icns', 'icons/icon.ico',
  ]);
  assert.match(buildSource, /cargo:rerun-if-changed=icons\/icon\.png/);
  assert.match(buildSource, /cargo:rerun-if-changed=icons\/icon\.icns/);
  assert.match(buildSource, /tauri_build::build\(\)/);
  assert.doesNotMatch(buildSource, /OUT_DIR|TAURI_CONFIG|rustc-env|PHASE_ONE_ICON/);
  assert.match(gitignore, /^\/apps\/tauri\/src-tauri\/gen\/schemas\/$/m);
  assert.match(gitignore, /^\/artifacts\/$/m);

  const icons = await Promise.all(config.bundle.icon.map(icon => readFile(path.join(rustRoot, icon))));
  for (const [index, size] of [32, 128, 256].entries()) {
    const pngIcon = icons[index];
    assert.ok(pngIcon.length > 32);
    assert.deepEqual([...pngIcon.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(pngIcon.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(pngIcon.readUInt32BE(16), size);
    assert.equal(pngIcon.readUInt32BE(20), size);
    assert.equal(pngIcon.subarray(-8, -4).toString('ascii'), 'IEND');
  }
  const macIcon = icons[3];
  assert.ok(macIcon.length > 32);
  assert.equal(macIcon.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(macIcon.readUInt32BE(4), macIcon.length);
  const windowsIcon = icons[4];
  assert.equal(windowsIcon.readUInt16LE(0), 0);
  assert.equal(windowsIcon.readUInt16LE(2), 1);
  assert.ok(windowsIcon.readUInt16LE(4) > 0);
  for (let entry = 0; entry < windowsIcon.readUInt16LE(4); entry += 1) {
    const offset = 6 + entry * 16;
    const length = windowsIcon.readUInt32LE(offset + 8);
    const imageOffset = windowsIcon.readUInt32LE(offset + 12);
    assert.ok(length > 0);
    assert.ok(imageOffset >= 6 + windowsIcon.readUInt16LE(4) * 16);
    assert.ok(imageOffset + length <= windowsIcon.length);
  }
  assert.equal(config.identifier, 'com.ineedfull.dev-tool');
  assert.equal(config.bundle.windows.nsis.installerIcon, 'icons/icon.ico');
  const [appPng, electronPng, electronMac, electronWindows] = await Promise.all([
    readFile(path.join(rustRoot, 'icons/icon.png')),
    readFile(path.join(root, 'apps/electron/electron/assets/icon.png')),
    readFile(path.join(root, 'apps/electron/build/icon.icns')),
    readFile(path.join(root, 'apps/electron/build/icon.ico')),
  ]);
  assert.deepEqual(appPng, electronPng);
  assert.deepEqual(macIcon, electronMac);
  assert.deepEqual(windowsIcon, electronWindows);
});

test('renderer is a tiny shared-workbench entry without legacy globals or native logic', async () => {
  const [html, mainSource, adapterSource] = await Promise.all([
    read('index.html'), read('renderer/main.js'), read('renderer/runtimeAdapter.js'),
  ]);

  assert.match(html, /<title>Ineed LinkLab<\/title>/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(mainSource, /@ineed-linklab\/workbench\/base\.css/);
  assert.match(mainSource, /createWorkbench\(createTauriRuntimeAdapter\(\), \{ presentationStorage \}\)\.mount\(['"]#app['"]\)/);
  assert.match(adapterSource, /@tauri-apps\/api\/core/);
  assert.match(adapterSource, /@tauri-apps\/api\/event/);
  assert.doesNotMatch(`${mainSource}\n${adapterSource}`, /window\.__TAURI__|localStorage|mqtt/i);
});

test('adapter exposes exactly the runtime contract and maps every command to snake_case', async () => {
  const invokes = [];
  const adapter = await createAdapter({
    invoke: async (command, payload) => {
      invokes.push([command, payload]);
      return { ok: true, value: { command, payload } };
    },
    listen: async () => () => {},
  });

  assert.equal(adapter.runtimeName, 'tauri');
  assert.deepEqual(collectMethods(adapter), [...REQUIRED_RUNTIME_METHODS]);

  for (const method of commandMethods) {
    const value = await call(adapter, method, 'argument', 7);
    assert.deepEqual(value, {
      command: commandFor(method),
      payload: { args: ['argument', 7] },
    });
  }
  assert.deepEqual(invokes.map(([command]) => command), commandMethods.map(commandFor));
  assert.deepEqual(
    invokes.find(([command]) => command === 'endpoint_clone'),
    ['endpoint_clone', { args: ['argument', 7] }],
  );
});

test('adapter unwraps cloned reads and reconstructs errors in the renderer realm', async () => {
  const readResults = new Map([
    ['endpoint_list', []],
    ['history_query_frames', emptyPage],
    ['history_query_logs', emptyPage],
    ['settings_get_all', {}],
    ['storage_stats', emptyStats],
  ]);
  const adapter = await createAdapter({
    invoke: async (command) => structuredClone(readResults.has(command)
      ? { ok: true, value: readResults.get(command) }
      : {
          ok: false,
          error: {
            name: 'RuntimeUnavailableError',
            method: 'endpoint.save',
            runtimeName: 'tauri',
            code: 'RUNTIME_UNAVAILABLE',
            message: 'unavailable',
          },
        }),
    listen: async () => () => {},
  });

  assert.deepEqual(await adapter.endpoint.list(), []);
  assert.deepEqual(await adapter.history.queryFrames(), emptyPage);
  assert.deepEqual(await adapter.history.queryLogs(), emptyPage);
  assert.deepEqual(await adapter.settings.getAll(), {});
  assert.deepEqual(await adapter.storage.stats(), emptyStats);

  await assert.rejects(adapter.endpoint.save({ id: 'one' }), (error) => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.name, 'RuntimeUnavailableError');
    assert.equal(error.method, 'endpoint.save');
    assert.equal(error.runtimeName, 'tauri');
    assert.equal(error.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(error.message, 'unavailable');
    return true;
  });
});

test('workspace paths are selected in Rust and renderer cannot supply arbitrary paths', async () => {
  const invokes = [];
  let rendererDialogs = 0;
  const api = {
    invoke: async (command, payload) => { invokes.push([command, payload]); return { ok: true, value: { canceled: false } }; },
    listen: async () => () => {},
    saveDialog: async () => { rendererDialogs += 1; return '/tmp/forged-export.json'; },
    openDialog: async () => { rendererDialogs += 1; return '/tmp/forged-import.json'; },
  };
  const adapter = await createAdapter(api);
  await adapter.workspace.export();
  await adapter.workspace.import();
  assert.deepEqual(invokes, [
    ['workspace_export', { args: [] }],
    ['workspace_import', { args: [] }],
  ]);
  assert.equal(rendererDialogs, 0);
});

test('adapter normalizes cloned string, object, and Error invoke rejections', async () => {
  const rejectionCases = [
    { reason: structuredClone('bridge unavailable'), name: 'TauriInvokeError', code: 'TAURI_INVOKE_FAILED' },
    {
      reason: structuredClone({ name: 'PermissionError', message: 'denied', code: 'PERMISSION_DENIED' }),
      name: 'PermissionError',
      code: 'PERMISSION_DENIED',
    },
    { reason: structuredClone(new TypeError('bad payload')), name: 'TypeError', code: 'TAURI_INVOKE_FAILED' },
  ];

  for (const { reason, name, code } of rejectionCases) {
    const adapter = await createAdapter({
      invoke: async () => { throw reason; },
      listen: async () => () => {},
    });

    await assert.rejects(adapter.endpoint.list(), (error) => {
      assert.equal(error instanceof Error, true);
      assert.notEqual(error, reason);
      assert.equal(error.name, name);
      assert.equal(error.method, 'endpoint.list');
      assert.equal(error.runtimeName, 'tauri');
      assert.equal(error.code, code);
      assert.equal(error.command, 'endpoint_list');
      assert.equal(error.cause, reason);
      return true;
    });
  }
});

test('event subscriptions forward payloads and asynchronously unlisten once', async () => {
  const listeners = new Map();
  const unlistened = [];
  const reports = [];
  const adapter = await createAdapter({
    invoke: async () => ({ ok: true, value: null }),
    listen: async (eventName, callback) => {
      listeners.set(eventName, callback);
      return () => unlistened.push(eventName);
    },
  }, (error) => reports.push(error));

  for (const [method, eventName] of eventMappings) {
    const payloads = [];
    const unsubscribe = call(adapter, method, (payload) => payloads.push(payload));
    assert.equal(typeof unsubscribe, 'function');
    await tick();
    const identity = {
      endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    };
    const payload = method === 'transport.onFrames'
      ? { ...identity, frames: [{ direction: 'in', bytes: [1], createdAt: 1 }] }
      : method === 'transport.onStatus'
        ? { ...identity, status: 'open', error: null, createdAt: 2, log: null }
        : { id: eventName };
    if (method === 'transport.onStatus') {
      listeners.get(eventName)({
        event: eventName,
        payload: { ...identity, status: 'open', error: null, createdAt: 2 },
      });
      assert.deepEqual(payloads, []);
    }
    listeners.get(eventName)({ event: eventName, payload });
    if (method === 'transport.onFrames') {
      assert.deepEqual(payloads[0].frames[0].bytes, Uint8Array.of(1));
    } else if (method === 'transport.onStatus') {
      assert.equal(payloads[0].log, null);
      const terminal = {
        ...identity, sessionId: null, status: 'closed',
        error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' },
        createdAt: 3, log: null,
      };
      listeners.get(eventName)({ event: eventName, payload: terminal });
      assert.deepEqual(payloads[1], terminal);
    } else {
      assert.deepEqual(payloads, [payload]);
    }
    assert.equal(await unsubscribe(), undefined);
    assert.equal(await unsubscribe(), undefined);
  }
  assert.deepEqual(unlistened, [...eventMappings.values()]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'INVALID_EVENT_PAYLOAD');
  assert.equal(reports[0].method, 'transport.onStatus');
  assert.equal(reports[0].eventName, 'transport:status');
});

test('Tauri adapter rejects serial lifecycle log semantic violations', async () => {
  let statusListener;
  const reports = [];
  const statuses = [];
  const adapter = await createAdapter({
    invoke: async () => ({ ok: true, value: null }),
    listen: async (eventName, callback) => {
      if (eventName === 'transport:status') statusListener = callback;
      return () => {};
    },
  }, (error) => reports.push(error));
  adapter.transport.onStatus((event) => statuses.push(event));
  await tick();
  const base = {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    status: 'error', error: { code: 'DEVICE_REMOVED', message: 'removed' }, createdAt: 10,
    log: {
      level: 'warn', source: 'serial', code: 'DEVICE_REMOVED',
      message: 'removed', details: null, createdAt: 10,
    },
  };

  for (const log of [
    { ...base.log, source: 'transport' },
    { ...base.log, createdAt: 11 },
    { ...base.log, level: 'error' },
    { ...base.log, code: 'IO_ERROR' },
  ]) {
    statusListener({ event: 'transport:status', payload: { ...base, log } });
  }

  assert.deepEqual(statuses, []);
  assert.equal(reports.length, 4);
  assert.equal(reports.every(({ code }) => code === 'INVALID_EVENT_PAYLOAD'), true);
});

test('early unsubscribe remains race-safe and idempotent', async () => {
  let resolveListen;
  let unlistenCount = 0;
  const pendingAdapter = await createAdapter({
    invoke: async () => ({ ok: true, value: null }),
    listen: () => new Promise((resolve) => { resolveListen = resolve; }),
  });
  const unsubscribe = pendingAdapter.transport.onFrames(() => {});
  const stopping = unsubscribe();
  await tick();
  resolveListen(() => { unlistenCount += 1; });
  await stopping;
  await unsubscribe();
  assert.equal(unlistenCount, 1);
});

test('listen rejection reports a structured error without an unhandled rejection', async () => {
  const reports = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const rejectingAdapter = await createAdapter({
    invoke: async () => ({ ok: true, value: null }),
    listen: async () => { throw new Error('listen failed'); },
  }, (error) => reports.push(error));
  const stopRejected = rejectingAdapter.transport.onStatus(() => {});
  try {
    await tick();
    await tick();
    assert.equal(await stopRejected(), undefined);
    assert.equal(reports.length, 1);
    assert.equal(reports[0] instanceof Error, true);
    assert.equal(reports[0].name, 'TauriListenError');
    assert.equal(reports[0].method, 'transport.onStatus');
    assert.equal(reports[0].runtimeName, 'tauri');
    assert.equal(reports[0].code, 'TAURI_LISTEN_FAILED');
    assert.equal(reports[0].eventName, 'transport:status');
    assert.equal(reports[0].cause.message, 'listen failed');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('Rust shell registers exact commands, authorized persistence, and no unused plugins', async () => {
  const [
    cargo,
    buildSource,
    libSource,
    mainSource,
    runtimeSource,
    databaseSource,
    serialSource,
    transportSource,
    modbusSource,
    rendererMainSource,
    rendererAdapterSource,
  ] = await Promise.all([
    read('src-tauri/Cargo.toml'),
    read('src-tauri/build.rs'),
    read('src-tauri/src/lib.rs'),
    read('src-tauri/src/main.rs'),
    read('src-tauri/src/runtime.rs'),
    read('src-tauri/src/database.rs'),
    read('src-tauri/src/serial.rs'),
    read('src-tauri/src/transport.rs'),
    read('src-tauri/src/modbus.rs'),
    read('renderer/main.js'),
    read('renderer/runtimeAdapter.js'),
  ]);
  const allNativeSource = `${libSource}\n${mainSource}\n${runtimeSource}\n${databaseSource}\n${serialSource}\n${transportSource}\n${modbusSource}`;
  const allRendererSource = `${rendererMainSource}\n${rendererAdapterSource}`;

  assert.match(cargo, /tauri\s*=\s*\{\s*version\s*=\s*"2"/);
  assert.match(cargo, /rusqlite\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"bundled"/);
  assert.match(cargo, /tauri-plugin-dialog\s*=\s*"2"/);
  assert.doesNotMatch(cargo, /tauri-plugin-clipboard-manager/);
  assert.match(cargo, /serde\s*=\s*\{[^}]*derive/);
  assert.match(cargo, /serde_json\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"raw_value"[^\]]*\][^}]*\}/);
  assert.match(cargo, /\[build-dependencies\][\s\S]*tauri-build\s*=\s*\{\s*version\s*=\s*"2"/);
  assert.match(buildSource, /tauri_build::build\(\)/);
  assert.match(mainSource, /ineed_linklab_tauri::run\(\)/);
  assert.match(libSource, /create_dir_all/);
  assert.match(libSource, /app_data_dir/);
  assert.match(libSource, /\.manage\(/);
  assert.doesNotMatch(libSource, /tauri_plugin_clipboard_manager/);
  assert.match(libSource, /\.plugin\(tauri_plugin_dialog::init\(\)\)/);
  assert.match(allNativeSource, /WebviewWindowBuilder/);
  assert.match(allNativeSource, /history-/);
  assert.match(databaseSource, /spawn_blocking/);
  assert.match(databaseSource, /read_to_string|write/);
  assert.match(databaseSource, /DialogExt/);
  assert.match(databaseSource, /blocking_save_file/);
  assert.match(databaseSource, /blocking_pick_file/);
  const exportCommand = databaseSource.slice(
    databaseSource.indexOf('pub(crate) async fn workspace_export'),
    databaseSource.indexOf('pub(crate) async fn workspace_import'),
  );
  const importCommand = databaseSource.slice(
    databaseSource.indexOf('pub(crate) async fn workspace_import'),
    databaseSource.indexOf('pub(crate) async fn history_query_frames'),
  );
  assert.ok(exportCommand.indexOf('spawn_blocking(move ||') < exportCommand.indexOf('blocking_save_file'));
  assert.ok(importCommand.indexOf('spawn_blocking(move ||') < importCommand.indexOf('blocking_pick_file'));
  assert.match(databaseSource, /atomic_write_workspace/);
  assert.doesNotMatch(`${cargo}\n${allNativeSource}`, /tauri-plugin-fs|tauri_plugin_fs/);
  assert.doesNotMatch(rendererAdapterSource, /@tauri-apps\/plugin-dialog|saveDialog|openDialog/);
  const menuRoles = [...libSource.matchAll(/PredefinedMenuItem::(\w+)\s*\(/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(menuRoles, ['copy', 'cut', 'paste', 'quit', 'redo', 'select_all', 'undo']);
  assert.match(libSource, /SubmenuBuilder::new\(app, "Ineed LinkLab"\)/);
  assert.match(libSource, /SubmenuBuilder::new\(app, "编辑"\)/);
  for (const label of ['退出 Ineed LinkLab', '撤销', '重做', '剪切', '复制', '粘贴', '全选']) {
    assert.match(libSource, new RegExp(`Some\\("${label}"\\)`));
  }
  for (const obsolete of ['Quit Ineed LinkLab', '"Edit"', 'Ineed LinkLab History', 'Export workspace', 'Import workspace']) {
    assert.doesNotMatch(`${libSource}\n${runtimeSource}\n${rendererAdapterSource}`, new RegExp(obsolete, 'i'));
  }
  assert.match(libSource, /^mod database;$/m);
  assert.match(libSource, /database::ConfigurationDatabase::open_in/);
  assert.match(databaseSource, /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/packages\/persistence-contract\/migrations\/001-initial\.sql"\)/);
  assert.doesNotMatch(allNativeSource, /sqlx|mqtt|window\.__TAURI__/i);
  assert.doesNotMatch(allRendererSource, /database|rusqlite|sqlx|mqtt|window\.__TAURI__/i);

  const generated = extractGenerateHandlerCommands(libSource);
  assert.deepEqual(generated, [...commandMethods.map(commandFor), 'window_open_website', 'opcua_execute', 'stomp_execute'].sort());
  const commandSource = `${runtimeSource}\n${databaseSource}\n${transportSource}\n${modbusSource}`;
  for (const command of commandMethods.map(commandFor)) {
    assert.match(commandSource, new RegExp(`fn\\s+${command}\\b`));
  }
  assert.match(runtimeSource, /rename_all\s*=\s*"camelCase"/);
  assert.match(runtimeSource, /RuntimeUnavailableError/);
  assert.match(runtimeSource, /RUNTIME_UNAVAILABLE/);
  assert.match(runtimeSource, /query_pairs_mut\(\)/);
  assert.match(runtimeSource, /open_history_window\(&mut TauriHistoryWindowHost/);
  assert.doesNotMatch(runtimeSource, /cfg\(test\)[\s\S]{0,120}fn window_open_history/);
});

test('local Vite build emits only local index and assets', async (t) => {
  const dist = path.join(packageRoot, 'dist');
  try {
    assert.equal((await stat(path.join(dist, 'index.html'))).isFile(), true);
  } catch (error) {
    if (error.code === 'ENOENT' && process.env.INEED_VERIFY_BUILD !== '1') {
      t.skip('Tauri dist is absent; run npm run test:artifacts to verify built output');
      return;
    }
    throw error;
  }
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  const entries = await readdir(path.join(dist, 'assets'));
  assert.match(html, /\.\/assets\//);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.equal(entries.some((entry) => entry.endsWith('.js')), true);
  assert.equal(entries.some((entry) => entry.endsWith('.css')), true);
});

async function read(relativePath) {
  return readFile(path.join(packageRoot, relativePath), 'utf8');
}

async function createAdapter(api, reporter) {
  const url = new URL('../renderer/runtimeAdapter.js', import.meta.url);
  const { createTauriRuntimeAdapter } = await import(`${pathToFileURL(fileURLToPath(url)).href}?test=${Math.random()}`);
  return createTauriRuntimeAdapter(api, reporter);
}

function collectMethods(adapter) {
  return REQUIRED_RUNTIME_METHODS.filter((dottedMethod) => {
    const [namespace, method] = dottedMethod.split('.');
    return typeof adapter?.[namespace]?.[method] === 'function';
  });
}

function call(adapter, dottedMethod, ...args) {
  const [namespace, method] = dottedMethod.split('.');
  return adapter[namespace][method](...args);
}

function extractGenerateHandlerCommands(source) {
  const match = source.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  assert.ok(match, 'generate_handler! command list is required');
  return match[1]
    .split(',')
    .map((entry) => entry.trim().split('::').at(-1))
    .filter(Boolean)
    .sort();
}

const tick = () => new Promise((resolve) => setImmediate(resolve));


test('shared manual, scheduled and history-resend requests match the strict native wire fixture', async () => {
  const nativeRequests = [];
  const records = [];
  const adapter = await createAdapter({
    invoke: async (command, payload) => {
      if (command === 'transport_send') nativeRequests.push(structuredClone(payload));
      if (command === 'send_history_record') records.push(structuredClone(payload.args[0]));
      return { ok: true, value: { sessionId: 's1' } };
    },
    listen: async () => () => {},
  });
  const timers = createFakeTimers();
  const model = createWorkbenchModel(adapter, { timers });
  const request = { endpointId: 'tcp-route', bytes: new TextEncoder().encode('ping'), format: 'text',
    framing: 'length-prefix', target: { endpointId: 'tcp-route' } };
  await model.commands.send(request);
  model.scheduledSender.start({ endpointId: 'tcp-route', sessionId: 's1', intervalMs: 100, count: 2, request });
  await new Promise((resolve) => setImmediate(resolve));
  await timers.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  const logical = records[0];
  await model.commands.send({ endpointId: logical.endpointId, target: logical.target, format: logical.format,
    framing: logical.framing, bytes: new Uint8Array(Buffer.from(logical.payloadBase64, 'base64')) });
  model.dispose();
  if (process.env.LINKLAB_CAPTURE_SEND_FIXTURE) {
    await writeFile(process.env.LINKLAB_CAPTURE_SEND_FIXTURE, JSON.stringify(nativeRequests, null, 2) + '\n');
  }
  assert.equal(nativeRequests.length, 4);
  for (const { args: [wire] } of nativeRequests) {
    assert.deepEqual(Object.keys(wire).sort(), ['bytes', 'endpointId', 'framing', 'target']);
    assert.equal(Buffer.from(wire.bytes).toString('hex'), '0000000470696e67');
  }
  assert.ok(records.every((record) => record.format === 'text' && record.framing === 'length-prefix'
    && record.payloadBase64 === 'cGluZw=='));
  const fixture = JSON.parse(await readFile(path.join(rustRoot, 'tests/fixtures/shared-send-wire.json'), 'utf8'));
  assert.deepEqual(nativeRequests, fixture);
});

 test('OPC UA uses the dedicated request envelope and native event channel', async () => {
 const calls = []; const listeners = [];
 const adapter = await createAdapter({invoke: async (...args) => { calls.push(args); return {ok:true,value:{sessionId:'ua-session'}}; },listen:async (...args)=>{listeners.push(args);return()=>{};}});
 const request={action:'connect',connectionId:'ua',config:{endpointUrl:'opc.tcp://127.0.0.1:4840'}};
 assert.deepEqual(await adapter.opcua.execute(request),{sessionId:'ua-session'});
 assert.deepEqual(calls,[['opcua_execute',{request}]]);
 const stop=adapter.opcua.onEvent(()=>{}); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(listeners[0][0],'opcua:event'); await stop();
 });

test('native CLI harness preserves the default desktop executable', async () => {
 const cargo = await read('src-tauri/Cargo.toml');
 assert.match(cargo, /default-run\s*=\s*"ineed-linklab-tauri"/);
});
