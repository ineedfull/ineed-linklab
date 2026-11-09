import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { REQUIRED_RUNTIME_METHODS, OPCUA_RUNTIME_METHODS, STOMP_RUNTIME_METHODS } from '@ineed-linklab/runtime-contract';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const managementModule = require('../electron/management.cjs');
const { ModbusService } = require('../electron/modbusService.cjs');
const transportPersistenceModule = require('../electron/transportPersistence.cjs');
const { TransportCoordinator } = require('../electron/transportCoordinator.cjs');
const root = path.resolve(packageRoot, '..', '..');
const emptyPage = { rows: [], total: 0, page: 1, pageSize: 100 };
const emptyStats = {
  frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 0,
};
const eventMethods = new Map([
  ['transport.onPersistenceWarning', 'persistence:warning'],
  ['transport.onFrames', 'transport:frames'],
  ['transport.onStatus', 'transport:status'],
  ['transport.onPeers', 'transport:peers'],
  ['modbus.onTransactions', 'modbus:transaction'],
  ['stomp.onEvent', 'stomp:event'],
  ['opcua.onEvent', 'opcua:event'],
  ['lifecycle.onBeforeShutdown', 'lifecycle:before-shutdown'],
]);
const readResults = new Map([
  ['endpoint.list', []],
  ['modbusHistory.querySeries', { series: [], from: null, to: null }],
  ['modbusHistory.queryRows', { rows: [], total: 0, page: 1, pageSize: 50 }],
  ['modbusHistory.flush', { flushed: true }],
  ['history.queryFrames', emptyPage],
  ['history.queryLogs', emptyPage],
  ['template.list', []],
  ['sendHistory.query', { rows: [], total: 0, page: 1, pageSize: 20 }],
  ['settings.getAll', {}],
  ['storage.stats', emptyStats],
  ['window.openWebsite', null],
]);
const runtimeMethods = [...STOMP_RUNTIME_METHODS, ...OPCUA_RUNTIME_METHODS, ...REQUIRED_RUNTIME_METHODS];
runtimeMethods.splice(runtimeMethods.indexOf('window.openHistory') + 1, 0, 'window.openWebsite');
const invokeMethods = runtimeMethods.filter((method) => !eventMethods.has(method));
const channelFor = (method) => method.replace('.', ':');

test('package manifest defines a private ESM Electron and Vite workspace', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  assert.equal(manifest.name, '@ineed-linklab/electron');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, 'electron/main.cjs');
  assert.equal(manifest.scripts.build, 'vite build');
  assert.match(manifest.scripts.dev, /vite[^\n]*--port 5173[^\n]*--strictPort/);
  assert.match(manifest.scripts.dev, /wait-on tcp:127\.0\.0\.1:5173/);
  assert.match(manifest.scripts.dev, /VITE_DEV_SERVER_URL=http:\/\/127\.0\.0\.1:5173/);
  assert.match(manifest.scripts.dev, /node \.\.\/\.\.\/scripts\/dev-electron\.mjs \./);
  assert.equal(manifest.devDependencies['@ineed-linklab/workbench'], '*');
  assert.equal(manifest.dependencies['@ineed-linklab/workbench'], undefined);
  assert.equal(manifest.dependencies['@ineed-linklab/persistence-contract'], '*');
  assert.equal(manifest.dependencies['modbus-serial'], '8.0.25');
  assert.equal(manifest.devDependencies.vue, '^3.5.39');
  assert.equal(manifest.dependencies.vue, undefined);
  assert.match(manifest.dependencies.serialport, /^\^13\./);
  assert.equal(manifest.devDependencies['@ineed-linklab/runtime-contract'], '*');
  assert.match(manifest.devDependencies.electron, /^\^43\./);
  assert.match(manifest.devDependencies.vite, /^\^8\./);
  assert.match(manifest.devDependencies['@vitejs/plugin-vue'], /^\^6\./);
  assert.equal(manifest.devDependencies.concurrently, '^9.2.1');
  assert.equal(manifest.devDependencies['wait-on'], '^9.0.10');
  assert.equal(manifest.devDependencies['cross-env'], '^10.1.0');
  assert.equal(manifest.devDependencies['electron-builder'], '26.15.3');
  assert.equal(manifest.devDependencies['@electron/asar'], '4.2.0');
  assert.equal(rootManifest.engines.node, '>=22.13');
  assert.equal(rootManifest.devDependencies['cross-env'], '^10.1.0');
  assert.equal(
    rootManifest.scripts['test:artifacts'],
    'npm run build && cross-env INEED_VERIFY_BUILD=1 node --test apps/electron/tests/electronBoundary.test.js apps/tauri/tests/tauriBoundary.test.js',
  );
});

test('macOS packaging uses Electron Builder for both architectures', async () => {
  const [manifest, rootManifest, builderSource, icon] = await Promise.all([
    read('package.json').then(JSON.parse),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    read('electron-builder.yml'),
    readFile(path.join(packageRoot, 'build', 'icon.icns')),
  ]);
  const builderConfig = loadYaml(builderSource);

  assert.equal(
    manifest.scripts['package:mac:arm64'],
    'npm run build && cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dmg --arm64 --config.directories.output=release/arm64',
  );
  assert.equal(
    manifest.scripts['package:mac:x64'],
    'npm run build && cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dmg --x64 --config.directories.output=release/x64',
  );
  assert.equal(
    rootManifest.scripts['package:mac:electron:arm64'],
    'npm run package:mac:arm64 -w @ineed-linklab/electron',
  );
  assert.equal(
    rootManifest.scripts['package:mac:electron:x64'],
    'npm run package:mac:x64 -w @ineed-linklab/electron',
  );
  assert.equal(
    rootManifest.scripts['package:mac:electron'],
    'npm run package:mac:electron:arm64 && npm run package:mac:electron:x64',
  );
  assert.equal(
    rootManifest.scripts['verify:package:mac:electron'],
    'node scripts/verify-electron-macos-package.mjs',
  );

  assert.match(builderSource, /^appId: com\.ineedfull\.dev-tool\.electron$/m);
  assert.match(builderSource, /^productName: Ineed LinkLab$/m);
  assert.match(builderSource, /^asar: true$/m);
  assert.match(builderSource, /^asarUnpack:\n {2}- ['"]?node_modules\/\*\*\/\*\.node['"]?$/m);
  assert.match(builderSource, /^npmRebuild: true$/m);
  assert.match(builderSource, /^ {2}output: release$/m);
  assert.match(builderSource, /^ {2}buildResources: build$/m);
  for (const packagedFile of ['dist/**/*', 'electron/**/*', 'package.json']) {
    assert.match(builderSource, new RegExp(`^ {2}- ["']?${escapeRegExp(packagedFile)}["']?$`, 'm'));
  }
  assert.deepEqual(builderConfig.extraResources, [
    {
      from: '../../packages/persistence-contract/migrations/001-initial.sql',
      to: 'contracts/persistence-contract/migrations/001-initial.sql',
    },
    {
      from: '../../packages/persistence-contract/migrations/002-modbus-endpoints.sql',
      to: 'contracts/persistence-contract/migrations/002-modbus-endpoints.sql',
    },
    {
      from: '../../packages/persistence-contract/migrations/003-modbus-point-history.sql',
      to: 'contracts/persistence-contract/migrations/003-modbus-point-history.sql',
    },
    {
      from: '../../packages/persistence-contract/migrations/004-dlt645-endpoints.sql',
      to: 'contracts/persistence-contract/migrations/004-dlt645-endpoints.sql',
    },
    {
      from: '../../packages/persistence-contract/migrations/005-dlt645-simulator-endpoints.sql',
      to: 'contracts/persistence-contract/migrations/005-dlt645-simulator-endpoints.sql',
    },
    {
      from: '../../packages/persistence-contract/migrations/006-websocket-endpoints.sql',
      to: 'contracts/persistence-contract/migrations/006-websocket-endpoints.sql',
    },
    {
      from: '../../packages/runtime-contract/src/settingsSchema.json',
      to: 'contracts/runtime-contract/src/settingsSchema.json',
    },
  ]);
  assert.match(builderSource, /^ {2}category: public\.app-category\.developer-tools$/m);
  assert.match(builderSource, /^ {2}icon: build\/icon\.icns$/m);
  assert.match(builderSource, /^ {2}identity: null$/m);
  assert.match(builderSource, /^ {2}target: dmg$/m);
  assert.match(
    builderSource,
    /^ {2}artifactName: ['"]?\$\{productName\}-Electron_\$\{version\}_\$\{arch\}\.\$\{ext\}['"]?$/m,
  );
  assert.ok(icon.length > 0);
});

test('macOS packaging pins Electron Builder to the lockfile runtime version', async () => {
  const [manifest, lockfile, builderSource] = await Promise.all([
    read('package.json').then(JSON.parse),
    readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
    read('electron-builder.yml'),
  ]);
  const resolvedElectronVersion = lockfile.packages['node_modules/electron'].version;

  assert.match(resolvedElectronVersion, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.devDependencies.electron, /^\^\d+\.\d+\.\d+$/);
  assert.match(
    builderSource,
    new RegExp(`^electronVersion: ${escapeRegExp(resolvedElectronVersion)}$`, 'm'),
  );
});

test('preload exposes exactly one complete runtime bridge with exact IPC mappings', async () => {
  const preloadSource = await read('electron/preload.cjs');
  const invokes = [];
  const listeners = new Map();
  const removals = [];
  const exposures = [];
  const ipcRenderer = {
    invoke(channel, ...args) {
      invokes.push([channel, ...args]);
      return Promise.resolve({ ok: true, value: { channel, args } });
    },
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener(channel, listener) {
      removals.push([channel, listener]);
      listeners.get(channel)?.delete(listener);
    },
  };

  executeCommonJs(preloadSource, {
    electron: {
      contextBridge: { exposeInMainWorld: (...args) => exposures.push(args) },
      ipcRenderer,
    },
  });

  assert.equal(exposures.length, 1);
  assert.equal(exposures[0][0], 'ineedLinkLab');
  const bridge = exposures[0][1];
  assert.equal(bridge.runtimeName, 'electron');
  assert.deepEqual(collectMethods(bridge).filter((method) => method !== 'transport.onPersistenceWarning'), runtimeMethods);
  assert.deepEqual(Object.keys(bridge).sort(), [
    'endpoint', 'history', 'lifecycle', 'modbus', 'modbusHistory', 'opcua', 'runtimeName',
    'sendHistory', 'settings', 'stomp', 'storage', 'template', 'transport', 'window', 'workspace',
  ]);

  for (const method of invokeMethods) {
    const result = await call(bridge, method, 'argument', 7);
    assert.deepEqual(result, {
      ok: true,
      value: { channel: channelFor(method), args: ['argument', 7] },
    });
  }
  assert.deepEqual(invokes.map(([channel]) => channel), invokeMethods.map(channelFor));
  assert.deepEqual(
    invokes.find(([channel]) => channel === 'endpoint:clone'),
    ['endpoint:clone', 'argument', 7],
  );

  for (const [method, channel] of eventMethods) {
    const firstPayloads = [];
    const secondPayloads = [];
    const unsubscribeFirst = call(bridge, method, (payload) => firstPayloads.push(payload));
    const unsubscribeSecond = call(bridge, method, (payload) => secondPayloads.push(payload));
    assert.equal(listeners.get(channel).size, 2);
    emitRendererEvent(listeners, channel, { id: 1 });
    assert.deepEqual(firstPayloads, [{ id: 1 }]);
    assert.deepEqual(secondPayloads, [{ id: 1 }]);
    assert.equal(unsubscribeFirst(), undefined);
    assert.equal(listeners.get(channel).size, 1);
    emitRendererEvent(listeners, channel, { id: 2 });
    assert.deepEqual(firstPayloads, [{ id: 1 }]);
    assert.deepEqual(secondPayloads, [{ id: 1 }, { id: 2 }]);
    assert.equal(unsubscribeSecond(), undefined);
    assert.equal(listeners.get(channel).size, 0);
    assert.equal(removals.filter(([removedChannel]) => removedChannel === channel).length, 2);
  }

  assert.equal(findProperty(bridge, 'ipcRenderer'), false);
  assert.equal(findProperty(bridge, 'clipboard'), false);
  assert.doesNotMatch(preloadSource, /new Error|throw\s+/);

  const errorEnvelope = {
    ok: false,
    error: {
      name: 'RuntimeUnavailableError',
      message: 'unavailable',
      method: 'endpoint.save',
      runtimeName: 'electron',
      code: 'RUNTIME_UNAVAILABLE',
    },
  };
  const errorBridge = loadPreloadBridge({ invoke: async () => errorEnvelope });
  const returnedEnvelope = await errorBridge.endpoint.save({ id: 'endpoint-1' });
  assert.deepEqual(returnedEnvelope, errorEnvelope);
  assert.deepEqual(structuredClone(returnedEnvelope), errorEnvelope);
});

test('history preload exposes only history queries and settings reads', async () => {
  const preloadSource = await read('electron/historyPreload.cjs');
  const invokes = [];
  const exposures = [];

  executeCommonJs(preloadSource, {
    electron: {
      contextBridge: { exposeInMainWorld: (...args) => exposures.push(args) },
      ipcRenderer: {
        invoke(channel, ...args) {
          invokes.push([channel, ...args]);
          return Promise.resolve({ ok: true, value: { channel, args } });
        },
      },
    },
  });

  assert.equal(exposures.length, 1);
  assert.equal(exposures[0][0], 'ineedLinkLab');
  const bridge = exposures[0][1];
  assert.deepEqual(Object.keys(bridge).sort(), ['history', 'runtimeName', 'settings']);
  assert.deepEqual(collectMethods(bridge), [
    'history.queryFrames',
    'history.queryLogs',
    'settings.getAll',
  ]);
  assert.equal(bridge.runtimeName, 'electron');

  await bridge.history.queryFrames({ page: 1 });
  await bridge.history.queryLogs({ page: 2 });
  await bridge.settings.getAll();
  assert.deepEqual(invokes.map(([channel]) => channel), [
    'history:queryFrames',
    'history:queryLogs',
    'settings:getAll',
  ]);
  assert.equal(findProperty(bridge, 'save'), false);
  assert.equal(findProperty(bridge, 'workspace'), false);
  assert.equal(findProperty(bridge, 'storage'), false);
  assert.equal(findProperty(bridge, 'transport'), false);
});

test('restricted history bridge constructs a complete local adapter without adding IPC methods', async () => {
  const invokes = [];
  const bridge = loadHistoryPreloadBridge({
    invoke: async (channel, ...args) => {
      invokes.push([channel, ...args]);
      if (channel === 'settings:getAll') return { ok: true, value: { theme: 'dark' } };
      return { ok: true, value: { rows: [], total: 0, page: 1, pageSize: 50 } };
    },
  });
  assert.deepEqual(Object.keys(bridge).sort(), ['history', 'runtimeName', 'settings']);
  const adapterUrl = pathToFileURL(path.join(packageRoot, 'renderer', 'runtimeAdapter.js')).href;
  const { createElectronRuntimeAdapter } = await import(`${adapterUrl}?restricted=${Date.now()}`);
  const adapter = createElectronRuntimeAdapter(bridge);

  assert.deepEqual(await adapter.settings.getAll(), { theme: 'dark' });
  assert.deepEqual(await adapter.history.queryFrames({ page: 1 }), {
    rows: [], total: 0, page: 1, pageSize: 50,
  });
  assert.deepEqual(await adapter.endpoint.list(), []);
  await assert.rejects(adapter.workspace.import(), /unavailable/i);
  assert.deepEqual(invokes.map(([channel]) => channel), ['settings:getAll', 'history:queryFrames']);
});

test('main registers every invoke handler once with Phase-01 behavior and cleanup', async () => {
  const handlers = new Map();
  const handledChannels = [];
  const removedChannels = [];
  const electron = createElectronMock({ handlers, handledChannels, removedChannels });
  const exports = executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
  });

  const cleanup = exports.registerIpcHandlers();
  const mainWindow = exports.createMainWindow();
  const trustedEvent = trustedIpcEvent(mainWindow);
  assert.equal(typeof cleanup, 'function');
  assert.deepEqual(handledChannels, invokeMethods.map(channelFor));
  assert.equal(new Set(handledChannels).size, invokeMethods.length);

  for (const [method, expected] of readResults) {
    assert.deepEqual(
      normalize(await handlers.get(channelFor(method))(trustedEvent)),
      { ok: true, value: expected },
    );
  }

  for (const method of invokeMethods.filter((name) => !readResults.has(name))) {
    assert.deepEqual(normalize(await handlers.get(channelFor(method))(trustedEvent)), {
      ok: false,
      error: {
        name: 'RuntimeUnavailableError',
        message: `Runtime method "${method}" is unavailable in electron`,
        method,
        runtimeName: 'electron',
        code: 'RUNTIME_UNAVAILABLE',
      },
    });
  }

  assert.deepEqual(normalize(await handlers.get('endpoint:list')({
    sender: mainWindow.webContents,
    senderFrame: { id: 'subframe' },
  })), {
    ok: false,
    error: {
      name: 'SecurityError',
      message: 'IPC sender is not trusted for endpoint.list',
      method: 'endpoint.list',
      runtimeName: 'electron',
      code: 'UNTRUSTED_SENDER',
    },
  });

  const wrongOriginFrame = mainWindow.webContents.mainFrame;
  const expectedDocumentUrl = wrongOriginFrame.url;
  wrongOriginFrame.url = 'https://example.test/';
  assert.deepEqual(normalize(await handlers.get('endpoint:list')({
    sender: mainWindow.webContents,
    senderFrame: wrongOriginFrame,
  })), {
    ok: false,
    error: {
      name: 'SecurityError',
      message: 'IPC sender is not trusted for endpoint.list',
      method: 'endpoint.list',
      runtimeName: 'electron',
      code: 'UNTRUSTED_SENDER',
    },
  });
  wrongOriginFrame.url = expectedDocumentUrl;
  assert.deepEqual(normalize(await handlers.get('endpoint:list')({
    sender: mainWindow.webContents,
    senderFrame: wrongOriginFrame,
  })), { ok: true, value: [] });

  assert.equal(exports.registerIpcHandlers(), cleanup);
  assert.equal(handledChannels.length, invokeMethods.length);
  cleanup();
  assert.deepEqual(removedChannels, invokeMethods.map(channelFor));
  assert.equal(handlers.size, 0);
});

test('website opening uses the fixed product site, rejects other frames, and reports launcher errors', async () => {
  const { electron, exports, handlers, windows } = loadMain(await read('electron/main.cjs'));
  const opened = [];
  electron.shell.openExternal = async (url) => { opened.push(url); };
  exports.registerIpcHandlers();
  const main = exports.createMainWindow();
  const open = handlers.get('window:openWebsite');
  assert.deepEqual(normalize(await open(trustedIpcEvent(main), 'https://other.example/')), { ok: true, value: null });
  assert.deepEqual(opened, ['https://linklab.ineedfull.com/']);
  assert.equal((await open({ sender: {} })).error.code, 'UNTRUSTED_SENDER');
  exports.openHistoryWindow({ kind: 'frames' });
  assert.equal((await open(trustedIpcEvent(windows.at(-1)))).error.code, 'UNAUTHORIZED_METHOD');
  assert.equal(opened.length, 1);
  electron.shell.openExternal = async () => { throw new Error('browser unavailable'); };
  const failure = normalize(await open(trustedIpcEvent(main)));
  assert.equal(failure.ok, false);
  assert.equal(failure.error.message, 'browser unavailable');
});

test('main returns plain error envelopes for validation and coordinator failures', async () => {
  const handlers = new Map();
  const electron = createElectronMock({ handlers });
  const mainExports = executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
  });
  const coordinatorError = Object.assign(new Error('close failed'), { code: 'TRANSPORT_CLOSE_FAILED' });
  const persistenceHandlers = mainExports.createPersistenceHandlers({
    database: {
      saveEndpoint() { throw new TypeError('config must be a valid JSON object'); },
      deleteEndpoint() { throw new Error('delete must not run'); },
    },
    transportCoordinator: {
      async closeEndpoint() { throw coordinatorError; },
    },
  });
  mainExports.registerIpcHandlers(persistenceHandlers);
  const mainWindow = mainExports.createMainWindow();
  let invokeRejections = 0;
  const bridge = loadPreloadBridge({
    async invoke(channel, ...args) {
      try {
        return structuredClone(normalize(
          await handlers.get(channel)(trustedIpcEvent(mainWindow), ...args),
        ));
      } catch (error) {
        invokeRejections += 1;
        throw error;
      }
    },
  });

  assert.deepEqual(await bridge.endpoint.save({ id: 'invalid' }), {
    ok: false,
    error: {
      name: 'TypeError',
      message: 'config must be a valid JSON object',
      method: 'endpoint.save',
      runtimeName: 'electron',
      code: 'PERSISTENCE_ERROR',
    },
  });
  assert.deepEqual(await bridge.endpoint.delete('endpoint-1'), {
    ok: false,
    error: {
      name: 'Error',
      message: 'close failed',
      method: 'endpoint.delete',
      runtimeName: 'electron',
      code: 'TRANSPORT_CLOSE_FAILED',
    },
  });
  assert.equal(invokeRejections, 0);
});

test('Electron IPC executes saved Modbus writes and separates failure transactions from envelopes', async (t) => {
  const clientCalls = [];
  const transactions = [];
  class ContractClient {
    setID(unitId) { clientCalls.push(['unitId', unitId]); }
    setTimeout(timeoutMs) { clientCalls.push(['timeoutMs', timeoutMs]); }
    async connectTCP() {}
    async writeCoil(address, value) { clientCalls.push(['FC05', address, value]); }
    async writeRegisters(address, values) {
      clientCalls.push(['FC16', address, [...values]]);
      if (address === 20) throw new Error('saved command rejected');
    }
    close(callback) { callback(); }
  }
  const service = new ModbusService({
    ModbusRTU: ContractClient,
    emitModbusEvent: (transaction) => transactions.push(transaction),
  });
  t.after(() => service.forceShutdown());
  await service.open({
    id: 'master', transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1_000 },
  }, { operationId: 'open-master' });

  const handlers = new Map();
  const electron = createElectronMock({ handlers });
  const mainExports = executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    './management.cjs': managementModule,
  });
  const coordinator = new TransportCoordinator({
    serialService: {},
    modbusService: service,
    database: { listEndpoints: () => [] },
  });
  mainExports.registerIpcHandlers(mainExports.createPersistenceHandlers({
    database: {}, transportCoordinator: coordinator,
  }));
  const mainWindow = mainExports.createMainWindow();
  const event = trustedIpcEvent(mainWindow);
  const bridge = loadPreloadBridge({
    invoke: async (channel, ...args) => normalize(await handlers.get(channel)(event, ...args)),
  });
  const fc05Request = {
    endpointId: 'master', functionCode: 5, unitId: 1,
    address: 5, quantity: 1, values: [true],
  };
  const fc16Request = {
    endpointId: 'master', functionCode: 16, unitId: 7,
    address: 10, quantity: 2, values: [100, 200],
  };

  const fc05 = await bridge.modbus.execute(fc05Request);
  const fc16 = await bridge.modbus.execute(fc16Request);
  assert.deepEqual(writeTransactionContract(fc05.value), {
    requestGroupId: null, requestId: null, origin: 'master', unitId: 1,
    functionCode: 5, address: 5, quantity: 1,
    requestValues: [true], values: [true], success: true,
    exceptionCode: null, message: null,
  });
  assert.deepEqual(writeTransactionContract(fc16.value), {
    requestGroupId: null, requestId: null, origin: 'master', unitId: 7,
    functionCode: 16, address: 10, quantity: 2,
    requestValues: [100, 200], values: [100, 200], success: true,
    exceptionCode: null, message: null,
  });

  const failure = await bridge.modbus.execute({
    ...fc16Request, address: 20, values: [300, 400],
  });
  assert.deepEqual(failure, {
    ok: false,
    error: {
      name: 'ModbusError', message: 'saved command rejected',
      method: 'modbus.execute', runtimeName: 'electron', code: 'IO_ERROR',
    },
  });
  assert.deepEqual(writeTransactionContract(transactions.at(-1)), {
    requestGroupId: null, requestId: null, origin: 'master', unitId: 7,
    functionCode: 16, address: 20, quantity: 2,
    requestValues: [300, 400], values: [], success: false,
    exceptionCode: null, message: 'saved command rejected',
  });
  assert.deepEqual(clientCalls.filter(([kind]) => kind.startsWith('FC')), [
    ['FC05', 5, true],
    ['FC16', 10, [100, 200]],
    ['FC16', 20, [300, 400]],
  ]);
});

test('workspace IPC passes only an authorized sender event to native file handlers', async () => {
  const { exports, handlers, windows } = loadMain(await read('electron/main.cjs'));
  const workspaceEvents = [];
  const persistenceHandlers = exports.createPersistenceHandlers({
    database: {},
    transportCoordinator: {},
    workspaceFiles: {
      exportWorkspace: async (event) => { workspaceEvents.push(['export', event]); return { canceled: true }; },
      importWorkspace: async (event) => { workspaceEvents.push(['import', event]); return { canceled: true }; },
    },
  });
  exports.registerIpcHandlers(persistenceHandlers);
  const mainWindow = exports.createMainWindow();
  const mainEvent = trustedIpcEvent(mainWindow);

  assert.deepEqual(normalize(await handlers.get('workspace:export')(mainEvent)), {
    ok: true, value: { canceled: true },
  });
  assert.equal(workspaceEvents[0][0], 'export');
  assert.equal(workspaceEvents[0][1], mainEvent);

  exports.openHistoryWindow({ kind: 'frames' });
  const historyEvent = trustedIpcEvent(windows[1]);
  const denied = normalize(await handlers.get('workspace:import')(historyEvent));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'UNAUTHORIZED_METHOD');
  assert.equal(workspaceEvents.length, 1);
});

test('native history queries include frames and logs still waiting in the persistence queue', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'linklab-query-flush-'));
  const { openConfigurationDatabase } = require('../electron/database.cjs');
  const database = openConfigurationDatabase(path.join(directory, 'data.db'));
  const persistence = await transportPersistenceModule.createTransportPersistence({
    database, endpointReceiveMode: () => 'raw',
  });
  t.after(async () => { await persistence.dispose(); database.close(); await rm(directory, { recursive: true, force: true }); });
  database.insertEndpoint({ id: 'serial-1', name: 'Test', transport: 'serial', config: { path: '/dev/test' } });
  persistence.handle('transport:frames', {
    endpointId: 'serial-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [0, 128, 255], createdAt: 1_720_000_000_000 }],
  });
  persistence.handle('transport:status', {
    endpointId: 'serial-1', sessionId: 'session-1', status: 'open', error: null,
    createdAt: 1_720_000_000_000,
    log: { level: 'info', source: 'serial', peerId: null, code: null, message: 'Opened', details: null, createdAt: 1_720_000_000_000 },
  });
  const query = { endpointId: 'serial-1', page: 1, pageSize: 20 };
  assert.equal(database.queryFrames(query).total, 0);
  assert.equal(database.queryLogs(query).total, 0);
  const { exports } = loadMain(await read('electron/main.cjs'));
  const handlers = exports.createPersistenceHandlers({ database, transportCoordinator: { flushPersistence: () => persistence.flush() } });
  const frames = await handlers['history.queryFrames'](query);
  assert.equal(frames.total, 1);
  assert.equal(frames.rows[0].payloadBase64, 'AID/');
  persistence.handle('transport:status', {
    endpointId: 'serial-1', sessionId: 'session-1', status: 'open', error: null,
    createdAt: 1_720_000_000_001,
    log: { level: 'info', source: 'serial', peerId: null, code: null, message: 'Latest', details: null, createdAt: 1_720_000_000_001 },
  });
  const logs = await handlers['history.queryLogs'](query);
  assert.equal(logs.total, 2);
  assert.equal(logs.rows[0].message, 'Latest');
});

test('history clearing flushes, while workspace import closes transports and flushes before mutation', async () => {
  const { exports } = loadMain(await read('electron/main.cjs'));
  const calls = [];
  const handlers = exports.createPersistenceHandlers({
    database: {
      clearHistory: () => { calls.push('clear'); return { cleared: true }; },
      prepareWorkspaceImport: (workspace) => { calls.push('validate'); return workspace; },
      importWorkspace: () => { calls.push('database-import'); return { imported: true }; },
    },
    transportCoordinator: {
      closeAll: async () => { calls.push('close-all'); },
      flushPersistence: async () => { calls.push('flush'); },
    },
  });

  assert.deepEqual(await handlers['storage.clearHistory'](), { cleared: true });
  assert.deepEqual(calls, ['flush', 'clear']);
  calls.length = 0;
  assert.deepEqual(await handlers['workspace.import']({}, { version: 1 }), { imported: true });
  assert.deepEqual(calls, ['validate', 'close-all', 'flush', 'database-import']);
});

test('Modbus point history handlers delegate exact queries and flush before destructive or file operations', async () => {
  const { exports } = loadMain(await read('electron/main.cjs'));
  const calls = [];
  const query = { endpointId: 'master-1', from: 10, to: 20 };
  const rows = [{ endpointId: 'master-1', pointId: 'temperature' }];
  const handlers = exports.createPersistenceHandlers({
    database: {
      recordModbusPointHistory(value) { calls.push(['record', value]); return { recordedCount: value.length }; },
      queryModbusPointSeries(value) { calls.push(['series', value]); return { series: [], from: 10, to: 20 }; },
      queryModbusPointHistoryRows(value) { calls.push(['rows', value]); return { rows: [], total: 0, page: 1, pageSize: 50 }; },
      clearModbusPointHistory(value) { calls.push(['clear', value]); return 3; },
      cleanupModbusPointHistory(value) { calls.push(['cleanup', value]); return { deletedCount: 2, completedAt: 30 }; },
    },
    transportCoordinator: { closeAll: async () => {}, flushPersistence: async () => {} },
    modbusHistoryBoundary: {
      flush: async () => { calls.push(['flush']); return { flushed: true }; },
      exportCsv: async (event, value) => { calls.push(['export', event, value]); return { canceled: false, path: '/tmp/history.csv' }; },
    },
  });

  assert.deepEqual(await handlers['modbusHistory.recordBatch'](rows), { recordedCount: 1 });
  assert.deepEqual(await handlers['modbusHistory.querySeries'](query), { series: [], from: 10, to: 20 });
  assert.deepEqual(await handlers['modbusHistory.queryRows'](query), {
    rows: [], total: 0, page: 1, pageSize: 50,
  });
  assert.deepEqual(await handlers['modbusHistory.flush'](), { flushed: true });
  assert.equal(await handlers['modbusHistory.clear'](query), 3);
  assert.deepEqual(await handlers['modbusHistory.cleanup']('30-days'), {
    deletedCount: 2, completedAt: 30,
  });
  const event = { sender: 'main' };
  assert.deepEqual(await handlers['modbusHistory.exportCsv'](event, query), {
    canceled: false, path: '/tmp/history.csv',
  });
  assert.deepEqual(calls, [
    ['record', rows], ['series', query], ['rows', query], ['flush'],
    ['flush'], ['clear', query], ['cleanup', '30-days'],
    ['flush'], ['export', event, query],
  ]);
});

test('renderer shutdown handshake joins signals, ignores stale acknowledgements, and has a two-second deadline', async () => {
  const { exports } = loadMain(await read('electron/main.cjs'));
  const timers = createTestTimers();
  const sent = [];
  const handshake = exports.createRendererShutdownHandshake({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => sent.push(args) },
    }),
    timers,
    createRequestId: () => 'shutdown-1',
  });

  const first = handshake.request();
  const repeated = handshake.request();
  assert.equal(first, repeated);
  assert.deepEqual(normalize(sent), [['lifecycle:before-shutdown', { requestId: 'shutdown-1' }]]);
  assert.deepEqual(timers.delays(), [2_000]);
  assert.equal(handshake.ready('stale'), false);
  assert.equal(handshake.ready('shutdown-1'), true);
  assert.deepEqual(normalize(await first), { requestId: 'shutdown-1', acknowledged: true });
  assert.equal(timers.size, 0);

  const timed = handshake.request();
  assert.deepEqual(normalize(sent.at(-1)), ['lifecycle:before-shutdown', { requestId: 'shutdown-1' }]);
  timers.runAll();
  assert.deepEqual(normalize(await timed), { requestId: 'shutdown-1', acknowledged: false });
});

test('main window close waits for the renderer shutdown handshake and joins repeated close signals', async () => {
  const { exports } = loadMain(await read('electron/main.cjs'));
  let closeListener;
  let closeCalls = 0;
  let resolveHandshake;
  let handshakeCalls = 0;
  const window = {
    on(event, listener) { if (event === 'close') closeListener = listener; },
    close() { closeCalls += 1; closeListener({ preventDefault() { throw new Error('approved close was blocked'); } }); },
  };
  const handshake = {
    request() {
      handshakeCalls += 1;
      return new Promise((resolve) => { resolveHandshake = resolve; });
    },
  };
  exports.installMainWindowShutdownHandshake(window, handshake);
  const first = { prevented: 0, preventDefault() { this.prevented += 1; } };
  const repeated = { prevented: 0, preventDefault() { this.prevented += 1; } };

  closeListener(first);
  closeListener(repeated);
  assert.equal(first.prevented, 1);
  assert.equal(repeated.prevented, 1);
  assert.equal(handshakeCalls, 1);
  assert.equal(closeCalls, 0);
  resolveHandshake({ acknowledged: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
});

test('native Modbus history CSV export pages the active query and escapes unsafe fields', async () => {
  const { exports } = loadMain(await read('electron/main.cjs'));
  const writes = [];
  const queries = [];
  const files = {
    async lstat() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    async open(filename) {
      if (filename === '/tmp') return { async sync() {}, async close() {} };
      return {
        async writeFile(value) { writes.push(value); },
        async sync() {},
        async close() {},
      };
    },
    async rename(from, to) { writes.push(`rename:${from}:${to}`); },
    async unlink() {},
  };
  const database = {
    queryModbusPointHistoryRows(query) {
      queries.push(query);
      if (query.page > 1) return { rows: [], total: 1, page: query.page, pageSize: 200 };
      return {
        rows: [{
          createdAt: 1_720_000_000_123,
          endpointId: 'master-1', requestGroupId: 'environment', requestId: 'holding',
          pointId: 'temperature', pointKey: 'temp', pointName: 'Boiler, "A"\nTemp',
          raw: [16_384, 0], value: 2, unit: 'degC', quality: 'bad', reason: 'line 1\r\nline 2',
        }],
        total: 201, page: 1, pageSize: 200,
      };
    },
  };
  const exporter = exports.createModbusPointHistoryCsvExporter({
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/history.csv' }) },
    files,
    database,
  });
  const query = {
    endpointId: 'master-1',
    points: [{ requestGroupId: 'environment', requestId: 'holding', pointId: 'temperature' }],
    from: 1_700_000_000_000,
    to: 1_730_000_000_000,
  };

  assert.deepEqual(normalize(await exporter.exportCsv({ sender: 'main' }, query)), {
    canceled: false, path: '/tmp/history.csv', exportedCount: 1,
  });
  assert.deepEqual(normalize(queries), [
    { ...query, page: 1, pageSize: 200 },
    { ...query, page: 2, pageSize: 200 },
  ]);
  assert.equal(writes[0], 'timestamp,endpointId,requestGroupId,requestId,pointId,pointKey,pointName,rawValue,engineeringValue,unit,quality,reason\r\n');
  assert.equal(
    writes[1],
    '1720000000123,master-1,environment,holding,temperature,temp,"Boiler, ""A""\nTemp","[16384,0]",2,degC,bad,"line 1\r\nline 2"\r\n',
  );
  assert.match(writes.at(-1), /^rename:\/tmp\/\.history\.csv\./);
});

test('transport event sink queues persistence before renderer forwarding and isolates persistence errors', async () => {
  const { exports } = loadMain(await read('electron/main.cjs'));
  const calls = [];
  const reports = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (...args) => calls.push(['renderer', ...args]) },
  };
  const sink = exports.createTransportEventSink({
    persistence: { handle: (...args) => calls.push(['persistence', ...args]) },
    getMainWindow: () => window,
    reportError: (...args) => reports.push(args),
  });
  const payload = { endpointId: 'serial-1' };

  sink('transport:frames', payload);
  assert.deepEqual(calls, [
    ['persistence', 'transport:frames', payload],
    ['renderer', 'transport:frames', payload],
  ]);

  const persistenceError = new Error('queue failed');
  const failingSink = exports.createTransportEventSink({
    persistence: { handle: () => { throw persistenceError; } },
    getMainWindow: () => window,
    reportError: (...args) => reports.push(args),
  });
  assert.doesNotThrow(() => failingSink('transport:status', payload));
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], persistenceError);
  assert.deepEqual(calls.at(-1), ['renderer', 'transport:status', payload]);
});

test('native startup creates persistence before SerialService and wires the same instance into coordination', async () => {
  const diagnostics = [];
  const handlers = new Map();
  const windows = [];
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  const calls = [];
  const database = {
    listEndpoints: () => [{
      id: 'serial-1', transport: 'serial', config: { receiveFraming: { mode: 'delimiter' } },
    }, {
      id: 'udp-server-1', transport: 'udp-server', config: {
        bindHost: '127.0.0.1', bindPort: 41000,
        receiveFraming: { mode: 'delimiter', delimiterBytes: [10] },
      },
    }],
    close() {},
  };
  const persistence = {
    handle: (...args) => calls.push(['persist', ...args]),
    flush: async () => {},
  };
  let persistenceOptions;
  let serialOptions;
  class StubSerialService {
    constructor(options) {
      calls.push(['serial']);
      serialOptions = options;
    }
  }
  class StubTransportCoordinator {
    constructor(options) {
      calls.push(['coordinator']);
      assert.equal(options.persistence, persistence);
    }
  }
  executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => database,
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './transportPersistence.cjs': {
      async createTransportPersistence(options) {
        calls.push(['persistence']);
        persistenceOptions = options;
        assert.equal(options.endpointReceiveMode('serial-1'), 'delimiter');
        assert.equal(options.endpointReceiveMode('udp-server-1'), 'datagram');
        assert.equal(options.endpointReceiveMode('missing'), 'raw');
        return persistence;
      },
    },
    './serialService.cjs': { SerialService: StubSerialService },
    './transportCoordinator.cjs': { TransportCoordinator: StubTransportCoordinator },
  }, {
    dirname: path.join(packageRoot, 'electron'),
    consoleObject: { ...console, error: (...args) => diagnostics.push(args) },
  });

  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 3).map(([name]) => name), [
    'persistence', 'serial', 'coordinator',
  ]);

  const payload = { endpointId: 'serial-1' };
  serialOptions.emitEvent('transport:frames', payload);
  assert.deepEqual(calls.at(-1), ['persist', 'transport:frames', payload]);
  assert.deepEqual(windows[0].webContents.sent.at(-1), ['transport:frames', payload]);
  const persistedCalls = calls.filter(([name]) => name === 'persist').length;
  persistenceOptions.reportError(new Error('database is locked'), { rowCount: 2 });
  assert.equal(diagnostics.length, 1);
  assert.match(String(diagnostics[0][0]), /transport persistence failed/);
  assert.match(String(diagnostics[0][1]), /database is locked/);
  assert.deepEqual(structuredClone(windows[0].webContents.sent.at(-1)), ['persistence:warning', { message: 'database is locked', rowCount: 2 }]);
  assert.equal(calls.filter(([name]) => name === 'persist').length, persistedCalls);
});

test('persistence initialization failure is reported without blocking native startup', async () => {
  const handlers = new Map();
  const windows = [];
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  const reports = [];
  let serialConstructed = false;
  class StubSerialService {
    constructor() { serialConstructed = true; }
  }
  class StubTransportCoordinator {}
  executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => ({ listEndpoints: () => [], close() {} }),
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './transportPersistence.cjs': {
      async createTransportPersistence() { throw new Error('persistence import failed'); },
    },
    './serialService.cjs': { SerialService: StubSerialService },
    './transportCoordinator.cjs': { TransportCoordinator: StubTransportCoordinator },
  }, {
    dirname: path.join(packageRoot, 'electron'),
    consoleObject: { ...console, error: (...args) => reports.push(args) },
  });

  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serialConstructed, true);
  assert.equal(windows.length, 1);
  assert.equal(reports.length, 1);
  assert.match(String(reports[0][0]), /persistence/i);
  assert.match(String(reports[0][1]), /persistence import failed/i);
});

test('Electron transport handlers delegate raw values to the coordinator without nested envelopes', async () => {
  const handlers = new Map();
  const mainExports = executeCommonJs(await read('electron/main.cjs'), {
    electron: createElectronMock({ handlers }),
    'node:path': path,
    'node:url': { pathToFileURL },
    './management.cjs': managementModule,
  });
  const calls = [];
  const ports = [
    { path: '/dev/a', manufacturer: 'Maker', serialNumber: 'SN', vendorId: null, productId: null },
  ];
  const coordinator = {
    scanSerialPorts: async () => ports,
    open: async (...args) => { calls.push(['open', ...args]); return { sessionId: 'session-1' }; },
    cancelOpen: async (...args) => { calls.push(['cancelOpen', ...args]); return { cancelled: true }; },
    closeEndpoint: async (...args) => { calls.push(['closeEndpoint', ...args]); return { closed: true }; },
    send: async (...args) => { calls.push(['send', ...args]); return { byteCount: 3 }; },
  };
  const persistenceHandlers = mainExports.createPersistenceHandlers({
    database: {},
    transportCoordinator: coordinator,
  });
  assert.equal(await persistenceHandlers['transport.scanSerialPorts'](), ports);
  assert.deepEqual(await persistenceHandlers['transport.open']('serial-1', { operationId: 'open-1' }), {
    sessionId: 'session-1',
  });
  assert.deepEqual(await persistenceHandlers['transport.cancelOpen']('serial-1', { operationId: 'open-1' }), {
    cancelled: true,
  });
  assert.deepEqual(await persistenceHandlers['transport.close']('serial-1'), { closed: true });
  assert.deepEqual(await persistenceHandlers['transport.send']({ endpointId: 'serial-1', bytes: [1, 2, 3] }), {
    byteCount: 3,
  });
  assert.deepEqual(calls, [
    ['open', 'serial-1', { operationId: 'open-1' }],
    ['cancelOpen', 'serial-1', { operationId: 'open-1' }],
    ['closeEndpoint', 'serial-1'],
    ['send', { endpointId: 'serial-1', bytes: [1, 2, 3] }],
  ]);
  await assert.rejects(
    async () => mainExports.createPersistenceHandlers({
      database: {}, transportCoordinator: {},
    })['transport.scanSerialPorts'](),
    /scanSerialPorts/,
  );
});

test('endpoint deletion orders serial close, persistence flush, then database delete', async () => {
  const handlers = new Map();
  const mainExports = executeCommonJs(await read('electron/main.cjs'), {
    electron: createElectronMock({ handlers }),
    'node:path': path,
    'node:url': { pathToFileURL },
    './management.cjs': managementModule,
  });
  const calls = [];
  const coordinator = new TransportCoordinator({
    database: { listEndpoints: () => [] },
    serialService: {
      async close(endpointId) {
        calls.push(['close', endpointId]);
        return { closed: true };
      },
    },
    persistence: {
      async flush() {
        calls.push(['flush']);
      },
    },
  });
  const persistenceHandlers = mainExports.createPersistenceHandlers({
    database: {
      deleteEndpoint(endpointId) {
        calls.push(['delete', endpointId]);
        return true;
      },
    },
    transportCoordinator: coordinator,
  });

  assert.equal(await persistenceHandlers['endpoint.delete']('serial-a'), true);
  assert.deepEqual(calls, [
    ['close', 'serial-a'],
    ['flush'],
    ['delete', 'serial-a'],
  ]);
});

test('closeEndpoint reports flush failure after serial cleanup and remains retryable', async () => {
  const calls = [];
  const flushError = Object.assign(new Error('history flush failed'), { code: 'SQLITE_BUSY' });
  let flushAttempts = 0;
  const coordinator = new TransportCoordinator({
    database: { listEndpoints: () => [] },
    serialService: {
      async close(endpointId) {
        calls.push(['close', endpointId]);
        return { closed: true };
      },
    },
    persistence: {
      async flush() {
        flushAttempts += 1;
        calls.push(['flush', flushAttempts]);
        if (flushAttempts === 1) throw flushError;
      },
    },
  });

  await assert.rejects(coordinator.closeEndpoint('serial-a'), (error) => error === flushError);
  assert.deepEqual(await coordinator.closeEndpoint('serial-a'), { closed: true });
  assert.deepEqual(calls, [
    ['close', 'serial-a'],
    ['flush', 1],
    ['close', 'serial-a'],
    ['flush', 2],
  ]);
});

test('renderer adapter reconstructs cloned IPC errors and unwraps read values', async () => {
  const handlers = new Map();
  const windows = [];
  const listeners = new Map();
  const electron = createElectronMock({ handlers, windows });
  const mainExports = executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
  });
  mainExports.registerIpcHandlers();
  const mainWindow = mainExports.createMainWindow();
  const bridge = loadPreloadBridge({
    invoke: async (channel, ...args) => structuredClone(normalize(
      await handlers.get(channel)(trustedIpcEvent(mainWindow), ...args),
    )),
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  });
  const adapterUrl = pathToFileURL(path.join(packageRoot, 'renderer', 'runtimeAdapter.js')).href;
  const { createElectronRuntimeAdapter } = await import(`${adapterUrl}?boundary=${Date.now()}`);
  const adapter = createElectronRuntimeAdapter(bridge);

  assert.equal(adapter.runtimeName, 'electron');
  assert.deepEqual(collectMethods(adapter).filter((method) => method !== 'transport.onPersistenceWarning'), runtimeMethods);
  assert.deepEqual(await adapter.endpoint.list(), []);
  assert.deepEqual(await adapter.history.queryFrames(), emptyPage);
  await assert.rejects(adapter.endpoint.save({ id: 'endpoint-1' }), (error) => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.name, 'RuntimeUnavailableError');
    assert.equal(error.message, 'Runtime method "endpoint.save" is unavailable in electron');
    assert.equal(error.method, 'endpoint.save');
    assert.equal(error.runtimeName, 'electron');
    assert.equal(error.code, 'RUNTIME_UNAVAILABLE');
    return true;
  });

  const frames = [];
  const unsubscribe = adapter.transport.onFrames((payload) => frames.push(payload));
  emitRendererEvent(listeners, 'transport:frames', {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [1, 2], createdAt: 1 }],
  });
  assert.deepEqual(frames, [{
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
    frames: [{
      endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
      direction: 'in', bytes: Uint8Array.of(1, 2), createdAt: 1,
    }],
  }]);
  unsubscribe();
  emitRendererEvent(listeners, 'transport:frames', {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1', frames: [],
  });
  assert.equal(frames.length, 1);
  assert.notEqual(adapter.transport.onFrames, bridge.transport.onFrames);
  assert.notEqual(adapter.transport.onStatus, bridge.transport.onStatus);
  assert.equal(adapter.transport.onPeers, bridge.transport.onPeers);
});

test('runtime adapter isolates invalid frame and status events and reports contract errors', async () => {
  const listeners = new Map();
  const reports = [];
  const bridge = {
    runtimeName: 'electron',
    transport: {
      onFrames: subscribeBridgeEvent(listeners, 'transport:frames'),
      onStatus: subscribeBridgeEvent(listeners, 'transport:status'),
    },
  };
  const adapterUrl = pathToFileURL(path.join(packageRoot, 'renderer', 'runtimeAdapter.js')).href;
  const { createElectronRuntimeAdapter } = await import(`${adapterUrl}?invalid=${Date.now()}`);
  const adapter = createElectronRuntimeAdapter(bridge, (error) => {
    reports.push(error);
    throw new Error('reporter failed');
  });
  const frames = [];
  const statuses = [];
  const stopFrames = adapter.transport.onFrames((value) => frames.push(value));
  const stopStatus = adapter.transport.onStatus((value) => statuses.push(value));
  const identity = {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
  };

  assert.doesNotThrow(() => listeners.get('transport:frames')({
    ...identity, frames: [{ direction: 'in', bytes: [256], createdAt: 1 }],
  }));
  assert.doesNotThrow(() => listeners.get('transport:status')({
    ...identity, status: 'invalid', error: null, createdAt: 2, log: null,
  }));
  assert.doesNotThrow(() => listeners.get('transport:status')({
    ...identity, status: 'open', error: null, createdAt: 2,
  }));
  for (const log of [
    { level: 'info', source: 'transport', code: null, message: 'opened', details: null, createdAt: 2 },
    { level: 'info', source: 'serial', code: null, message: 'opened', details: null, createdAt: 3 },
    { level: 'debug', source: 'serial', code: null, message: 'opened', details: null, createdAt: 2 },
  ]) {
    assert.doesNotThrow(() => listeners.get('transport:status')({
      ...identity, status: 'open', error: null, createdAt: 2, log,
    }));
  }
  assert.deepEqual(frames, []);
  assert.deepEqual(statuses, []);
  assert.equal(reports.length, 6);
  for (const [index, [method, eventName]] of [
    ['transport.onFrames', 'transport:frames'],
    ['transport.onStatus', 'transport:status'],
    ['transport.onStatus', 'transport:status'],
    ['transport.onStatus', 'transport:status'],
    ['transport.onStatus', 'transport:status'],
    ['transport.onStatus', 'transport:status'],
  ].entries()) {
    assert.equal(reports[index] instanceof Error, true);
    assert.equal(reports[index].code, 'INVALID_EVENT_PAYLOAD');
    assert.equal(reports[index].method, method);
    assert.equal(reports[index].eventName, eventName);
    assert.equal(reports[index].runtimeName, 'electron');
    assert.equal(reports[index].cause instanceof TypeError, true);
  }

  listeners.get('transport:frames')({
    ...identity, frames: [{ direction: 'out', bytes: [1, 2], createdAt: 3 }],
  });
  listeners.get('transport:status')({
    ...identity, status: 'open', error: null, createdAt: 4, log: null,
  });
  listeners.get('transport:status')({
    ...identity, sessionId: null, status: 'closed',
    error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' }, createdAt: 5, log: null,
  });
  assert.deepEqual(frames[0].frames[0].bytes, Uint8Array.of(1, 2));
  assert.deepEqual(statuses.map(({ status, sessionId, error, log }) => ({
    status, sessionId, error, log,
  })), [
    { status: 'open', sessionId: 'session-1', error: null, log: null },
    {
      status: 'closed', sessionId: null,
      error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' }, log: null,
    },
  ]);

  stopFrames();
  stopStatus();
  assert.equal(listeners.size, 0);
});

test('main only loads exact unpackaged loopback development origins', async () => {
  const mainSource = await read('electron/main.cjs');
  assert.doesNotMatch(mainSource, /openDevTools|toggleDevTools/);
  assert.doesNotMatch(mainSource, /https?:\/\/(?:localhost|127\.0\.0\.1)/);
  assert.match(mainSource, /app\.whenReady\(\)/);
  assert.match(mainSource, /app\.on\(['"]activate['"]/);
  assert.match(mainSource, /app\.on\(['"]window-all-closed['"]/);
  assert.match(mainSource, /process\.platform\s*!==\s*['"]darwin['"]/);

  const { exports, windows } = loadMain(mainSource);
  const productionWindow = exports.createMainWindow();
  assertWindowOptions(windows[0].options);
  assert.deepEqual(productionWindow.loadedFiles, [path.join(packageRoot, 'dist', 'index.html')]);
  assert.deepEqual(productionWindow.loadedUrls, []);
  assert.equal(
    productionWindow.webContents.mainFrame.url,
    pathToFileURL(path.join(packageRoot, 'dist', 'index.html')).href,
  );

  for (const developmentUrl of ['http://localhost:5173', 'http://127.0.0.1:5173/']) {
    const dev = loadMain(mainSource, { env: { VITE_DEV_SERVER_URL: developmentUrl } });
    const developmentWindow = dev.exports.createMainWindow();
    assert.deepEqual(developmentWindow.loadedUrls, [new URL(developmentUrl).href]);
    assert.deepEqual(developmentWindow.loadedFiles, []);
    assert.equal(developmentWindow.webContents.mainFrame.url, new URL(developmentUrl).href);
  }

  for (const rejectedUrl of [
    'http://dev.example.test:5173',
    'http://user:password@localhost:5173',
    'http://localhost:5174',
    'https://localhost:5173',
    'http://localhost:5173/unexpected',
    'http://localhost:5173/?query=1',
  ]) {
    const rejected = loadMain(mainSource, { env: { VITE_DEV_SERVER_URL: rejectedUrl } });
    const rejectedWindow = rejected.exports.createMainWindow();
    assert.deepEqual(rejectedWindow.loadedUrls, [], rejectedUrl);
    assert.deepEqual(rejectedWindow.loadedFiles, [path.join(packageRoot, 'dist', 'index.html')], rejectedUrl);
  }

  const packaged = loadMain(mainSource, {
    env: { VITE_DEV_SERVER_URL: 'http://localhost:5173' },
    isPackaged: true,
  });
  const packagedWindow = packaged.exports.createMainWindow();
  assert.deepEqual(packagedWindow.loadedUrls, []);
  assert.deepEqual(packagedWindow.loadedFiles, [path.join(packageRoot, 'dist', 'index.html')]);
  packaged.exports.registerIpcHandlers();
  assert.deepEqual(
    normalize(await packaged.handlers.get('endpoint:list')(trustedIpcEvent(packagedWindow))),
    { ok: true, value: [] },
  );
});

test('main allows only its exact document and denies redirects and renderer-created windows', async () => {
  const { exports } = loadMain(await read('electron/main.cjs'), {
    env: { VITE_DEV_SERVER_URL: 'http://localhost:5173' },
  });
  const mainWindow = exports.createMainWindow();
  const navigationEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  const sameDocumentEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  const redirectEvent = { prevented: false, preventDefault() { this.prevented = true; } };

  mainWindow.webContents.emit('will-navigate', navigationEvent, 'https://example.test');
  assert.equal(navigationEvent.prevented, true);
  mainWindow.webContents.emit('will-navigate', sameDocumentEvent, 'http://localhost:5173/');
  assert.equal(sameDocumentEvent.prevented, false);
  mainWindow.webContents.emit('will-redirect', redirectEvent, 'https://example.test/redirected');
  assert.equal(redirectEvent.prevented, true);
  assert.deepEqual(
    normalize(mainWindow.webContents.openHandler({ url: 'https://example.test' })),
    { action: 'deny' },
  );
});

test('owned history windows use exact secure URLs, focus reuse, and trusted sender cleanup', async () => {
  const { exports, handlers, windows } = loadMain(await read('electron/main.cjs'));
  exports.registerIpcHandlers();
  exports.createMainWindow();
  assert.deepEqual(normalize(exports.openHistoryWindow({ kind: 'frames', endpointId: 'ep-1' })), { focused: false });
  const historyWindow = windows[1];
  assert.equal(historyWindow.options.title, '历史消息');
  assert.equal(historyWindow.options.width, 1180);
  assert.equal(historyWindow.options.height, 760);
  assert.deepEqual(normalize(historyWindow.options.webPreferences), {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(packageRoot, 'electron', 'historyPreload.cjs'),
  });
  assert.deepEqual(historyWindow.loadedUrls, [
    `${pathToFileURL(path.join(packageRoot, 'dist', 'index.html')).href}?view=history&kind=frames&endpointId=ep-1`,
  ]);
  assert.deepEqual(normalize(await handlers.get('history:queryFrames')(
    trustedIpcEvent(historyWindow),
    { page: 1 },
  )), { ok: true, value: emptyPage });
  assert.deepEqual(
    normalize(await handlers.get('settings:getAll')(trustedIpcEvent(historyWindow))),
    { ok: true, value: {} },
  );
  for (const channel of ['endpoint:list', 'settings:save', 'settings:saveAll', 'storage:stats', 'workspace:import', 'window:openHistory']) {
    const denied = normalize(await handlers.get(channel)(trustedIpcEvent(historyWindow)));
    assert.equal(denied.ok, false, channel);
    assert.equal(denied.error.name, 'SecurityError', channel);
    assert.equal(denied.error.code, 'UNAUTHORIZED_METHOD', channel);
  }
  assert.deepEqual(normalize(exports.openHistoryWindow({ kind: 'frames', endpointId: 'ep-1' })), { focused: true });
  assert.equal(historyWindow.focusCalls, 1);
  assert.deepEqual(normalize(exports.openHistoryWindow({ kind: 'logs' })), { focused: false });
  assert.equal(windows[2].options.title, '历史日志');
  historyWindow.emit('closed');
  const rejected = normalize(await handlers.get('storage:stats')(trustedIpcEvent(historyWindow)));
  assert.equal(rejected.error.code, 'UNTRUSTED_SENDER');
});

test('application-controlled Electron native labels contain no obsolete English copy', async () => {
  const source = `${await read('electron/main.cjs')}\n${await read('electron/management.cjs')}`;
  for (const obsolete of [
    'Export workspace', 'Import workspace', 'Ineed LinkLab History', 'Workspace JSON',
  ]) assert.doesNotMatch(source, new RegExp(obsolete, 'i'));
  assert.match(source, /const \{ app, BrowserWindow, dialog, ipcMain, Menu, shell \} = require\('electron'\)/);
});

test('ready installs a Chinese native-role menu and cleanup removes it', async () => {
  const { electron } = loadMain(await read('electron/main.cjs'));
  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(normalize(electron.menuTemplates), [[
    {
      label: 'Ineed LinkLab',
      submenu: [{ label: '退出 Ineed LinkLab', role: 'quit' }],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
  ]]);
  assert.equal(electron.applicationMenuCalls.length, 1);
  assert.equal(electron.applicationMenuCalls[0].template, electron.menuTemplates[0]);
  assert.equal(findProperty(electron.menuTemplates, 'accelerator'), false);

  electron.app.emit('before-quit');
  assert.equal(electron.applicationMenuCalls.at(-1), null);
});

test('app lifecycle creates after ready, recreates on activate, cleans up, and quits by platform', async () => {
  const mainSource = await read('electron/main.cjs');
  const linux = loadMain(mainSource, { platform: 'linux' });
  assert.equal(linux.windows.length, 0);
  linux.electron.app.triggerReady();
  await Promise.resolve();
  assert.equal(linux.windows.length, 1);
  assert.equal(linux.handlers.size, invokeMethods.length);
  linux.windows[0].emit('closed');
  linux.electron.app.emit('activate');
  assert.equal(linux.windows.length, 2);
  linux.electron.app.emit('window-all-closed');
  assert.equal(linux.electron.app.quitCalls, 1);
  linux.electron.app.emit('before-quit');
  assert.equal(linux.handlers.size, 0);
  assert.equal(linux.windows[1].destroyed, true);

  const darwin = loadMain(mainSource, { platform: 'darwin' });
  darwin.electron.app.triggerReady();
  await Promise.resolve();
  const originalMainWindow = darwin.windows[0];
  darwin.exports.openHistoryWindow({ kind: 'frames' });
  const historyWindow = darwin.windows[1];
  originalMainWindow.emit('closed');
  assert.equal(originalMainWindow.destroyed, true);
  assert.equal(historyWindow.destroyed, false);

  darwin.electron.app.emit('activate');
  assert.equal(darwin.windows.length, 3);
  assert.equal(darwin.windows[2].options.title, 'Ineed LinkLab');
  assert.equal(historyWindow.destroyed, false);
  const replacement = darwin.windows[2];
  replacement.minimized = true; replacement.visible = false;
  darwin.electron.app.emit('activate');
  assert.equal(darwin.windows.length, 3);
  assert.equal(replacement.minimized, false);
  assert.equal(replacement.visible, true);
  assert.equal(replacement.focusCalls, 1);

  darwin.electron.app.emit('window-all-closed');
  assert.equal(darwin.electron.app.quitCalls, 0);
});

test('closed window handlers do not read webContents after BrowserWindow destruction', async () => {
  const mainSource = await read('electron/main.cjs');
  const { electron, exports, windows } = loadMain(mainSource, {
    webContentsUnavailableAfterDestroy: true,
  });
  electron.app.triggerReady();
  await Promise.resolve();

  assert.doesNotThrow(() => windows[0].emit('closed'));

  exports.createMainWindow();
  exports.openHistoryWindow({ kind: 'frames' });
  assert.doesNotThrow(() => windows.at(-1).emit('closed'));
});

test('before-quit retries transport shutdown once before forced application cleanup', { timeout: 2_000 }, async () => {
  const handlers = new Map();
  const windows = [];
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  let resolveSecondShutdown;
  let shutdownCalls = 0;
  let databaseCloseCalls = 0;
  const database = {
    listEndpoints: () => [],
    insertFrameBatch: async () => {},
    insertLogBatch: async () => {},
    close: () => { databaseCloseCalls += 1; },
  };
  class StubTransportCoordinator {
    shutdown() {
      shutdownCalls += 1;
      if (shutdownCalls === 1) return Promise.reject(new Error('first shutdown failed'));
      return new Promise((resolve) => { resolveSecondShutdown = resolve; });
    }
  }
  const exports = executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => database,
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './serialService.cjs': { SerialService: class {} },
    './transportPersistence.cjs': transportPersistenceModule,
    './transportCoordinator.cjs': { TransportCoordinator: StubTransportCoordinator },
  }, { dirname: path.join(packageRoot, 'electron') });
  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const event = { prevented: false, preventDefault() { this.prevented = true; } };

  electron.app.emit('before-quit', event);
  await acknowledgeBeforeShutdown(handlers, windows[0]);

  assert.equal(event.prevented, true);
  assert.equal(shutdownCalls, 2);
  assert.equal(databaseCloseCalls, 0);
  assert.equal(windows[0].destroyed, false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(shutdownCalls, 2);
  assert.equal(databaseCloseCalls, 0);
  assert.equal(windows[0].destroyed, false);
  resolveSecondShutdown();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(databaseCloseCalls, 1);
  assert.equal(windows[0].destroyed, true);
  assert.equal(electron.app.quitCalls, 1);
  assert.equal(typeof exports.createPersistenceHandlers, 'function');
});

test('before-quit completes every cleanup step and quits when database close throws', { timeout: 2_000 }, async () => {
  const handlers = new Map();
  const windows = [];
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  let databaseCloseCalls = 0;
  const database = {
    listEndpoints: () => [],
    insertFrameBatch: async () => {},
    insertLogBatch: async () => {},
    close() {
      databaseCloseCalls += 1;
      throw new Error('database close failed');
    },
  };
  class StubTransportCoordinator {
    shutdown() { return Promise.resolve(); }
  }
  executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => database,
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './serialService.cjs': { SerialService: class {} },
    './transportPersistence.cjs': transportPersistenceModule,
    './transportCoordinator.cjs': { TransportCoordinator: StubTransportCoordinator },
  }, { dirname: path.join(packageRoot, 'electron') });
  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const event = { prevented: false, preventDefault() { this.prevented = true; } };

  electron.app.emit('before-quit', event);
  await acknowledgeBeforeShutdown(handlers, windows[0]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.prevented, true);
  assert.equal(databaseCloseCalls, 1);
  assert.equal(handlers.size, 0);
  assert.equal(windows[0].destroyed, true);
  assert.equal(electron.applicationMenuCalls.at(-1), null);
  assert.equal(electron.app.quitCalls, 1);
});

test('before-quit times out two graceful attempts, forces transport cleanup, and quits', { timeout: 2_000 }, async () => {
  const handlers = new Map();
  const windows = [];
  const timers = createTestTimers();
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  let shutdownCalls = 0;
  let forceShutdownCalls = 0;
  const calls = [];
  let databaseCloseCalls = 0;
  const database = {
    listEndpoints: () => [],
    insertFrameBatch: async () => {},
    insertLogBatch: async () => {},
    close() { databaseCloseCalls += 1; calls.push('database'); },
  };
  const realPersistence = {
    async createTransportPersistence(options) {
      const persistence = await transportPersistenceModule.createTransportPersistence(options);
      return {
        handle: persistence.handle,
        flush: async () => { calls.push('flush'); await persistence.flush(); },
        dispose: async () => { calls.push('dispose'); await persistence.dispose(); },
      };
    },
  };
  class StubSerialService {
    shutdown() {
      shutdownCalls += 1;
      calls.push('serial');
      if (shutdownCalls === 1) return Promise.reject(new Error('first shutdown failed'));
      return new Promise(() => {});
    }
    forceShutdown() {
      forceShutdownCalls += 1;
      calls.push('force-serial');
      return { forced: 1 };
    }
  }
  executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => database,
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './transportPersistence.cjs': realPersistence,
    './serialService.cjs': { SerialService: StubSerialService },
    './transportCoordinator.cjs': { TransportCoordinator },
  }, { dirname: path.join(packageRoot, 'electron'), timers });
  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const event = { prevented: false, preventDefault() { this.prevented = true; } };

  electron.app.emit('before-quit', event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.prevented, true);
  assert.equal(shutdownCalls, 0);
  assert.deepEqual(timers.delays(), [2_000]);
  timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(shutdownCalls, 2);
  assert.deepEqual(timers.delays(), [2_000]);
  assert.equal(forceShutdownCalls, 0);
  assert.equal(electron.app.quitCalls, 0);

  timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(forceShutdownCalls, 1);
  assert.equal(databaseCloseCalls, 1);
  assert.deepEqual(calls, [
    'serial', 'flush', 'dispose', 'serial', 'force-serial', 'flush', 'database',
  ]);
  assert.equal(windows[0].destroyed, true);
  assert.equal(electron.app.quitCalls, 1);
  assert.equal(timers.size, 0);
});

test('before-quit waits for force transport disposal before closing the database', { timeout: 2_000 }, async () => {
  const handlers = new Map();
  const windows = [];
  const timers = createTestTimers();
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  const calls = [];
  class StubTransportCoordinator {
    shutdown() { return new Promise(() => {}); }
    forceShutdown() {
      calls.push('force');
      return Promise.resolve().then(() => {
        calls.push('flush');
        calls.push('disposed');
      });
    }
  }
  const database = {
    listEndpoints: () => [],
    insertFrameBatch: async () => {},
    insertLogBatch: async () => {},
    close() { calls.push('database'); },
  };
  executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => database,
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './serialService.cjs': { SerialService: class {} },
    './transportPersistence.cjs': transportPersistenceModule,
    './transportCoordinator.cjs': { TransportCoordinator: StubTransportCoordinator },
  }, { dirname: path.join(packageRoot, 'electron'), timers });
  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  electron.app.emit('before-quit', { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  timers.runAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['force', 'flush', 'disposed', 'database']);
});

test('real Electron transport lifecycle drains persistence before database close', { timeout: 2_000 }, async () => {
  const handlers = new Map();
  const windows = [];
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  const calls = [];
  const persistedFrames = [];
  const reports = [];
  let serialOptions;
  const database = {
    listEndpoints: () => [],
    insertFrameBatch: async (rows) => persistedFrames.push(...rows),
    insertLogBatch: async () => {},
    close: () => calls.push('database'),
  };
  const realPersistence = {
    async createTransportPersistence(options) {
      const persistence = await transportPersistenceModule.createTransportPersistence(options);
      return {
        handle: persistence.handle,
        flush: async () => { calls.push('flush'); await persistence.flush(); },
        dispose: async () => { calls.push('dispose'); await persistence.dispose(); },
      };
    },
  };
  class StubSerialService {
    constructor(options) { serialOptions = options; }
    shutdown() { calls.push('serial'); return Promise.resolve(); }
    forceShutdown() { calls.push('force-serial'); return Promise.resolve(); }
  }
  executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => database,
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './transportPersistence.cjs': realPersistence,
    './serialService.cjs': { SerialService: StubSerialService },
    './transportCoordinator.cjs': { TransportCoordinator },
  }, {
    dirname: path.join(packageRoot, 'electron'),
    consoleObject: { ...console, error: (...args) => reports.push(args) },
  });
  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  serialOptions.emitEvent('transport:frames', {
    endpointId: 'serial-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [1, 2], createdAt: 1 }],
  });
  electron.app.emit('before-quit', { preventDefault() {} });
  electron.app.emit('before-quit', { preventDefault() {} });
  await acknowledgeBeforeShutdown(handlers, windows[0]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reports, []);
  assert.deepEqual(calls, ['serial', 'flush', 'dispose', 'database']);
  assert.equal(persistedFrames.length, 1);
  assert.equal(electron.app.quitCalls, 1);
});

test('macOS main window close drains transport before activate creates a renderer', { timeout: 2_000 }, async () => {
  const handlers = new Map();
  const windows = [];
  const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  let closeAllCalls = 0;
  let resolveCloseAll;
  let rejectCloseAll;
  class StubTransportCoordinator {
    closeAll() {
      closeAllCalls += 1;
      return new Promise((resolve, reject) => {
        resolveCloseAll = resolve;
        rejectCloseAll = reject;
      });
    }
    shutdown() { return Promise.resolve(); }
  }
  executeCommonJs(await read('electron/main.cjs'), {
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': {},
    serialport: { SerialPort: class {} },
    './database.cjs': {
      DATABASE_FILENAME: 'test.db',
      openConfigurationDatabase: () => ({
        listEndpoints: () => [], insertFrameBatch: async () => {}, insertLogBatch: async () => {}, close() {},
      }),
    },
    './management.cjs': {
      ...managementModule,
      createWorkspaceFileHandlers: () => ({}),
    },
    './serialService.cjs': { SerialService: class {} },
    './transportPersistence.cjs': transportPersistenceModule,
    './transportCoordinator.cjs': { TransportCoordinator: StubTransportCoordinator },
  }, { dirname: path.join(packageRoot, 'electron'), platform: 'darwin' });
  electron.app.triggerReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const originalWindow = windows[0];

  originalWindow.emit('closed');
  electron.app.emit('activate');
  await Promise.resolve();

  assert.equal(closeAllCalls, 1);
  assert.equal(windows.length, 1);

  rejectCloseAll(new Error('renderer transport close failed'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeAllCalls, 1);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].destroyed, false);

  const replacementWindow = windows[1];
  replacementWindow.emit('closed');
  electron.app.emit('activate');
  await Promise.resolve();

  assert.equal(closeAllCalls, 2);
  assert.equal(windows.length, 2);

  resolveCloseAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(windows.length, 3);
  assert.equal(windows[2].destroyed, false);
});

test('renderer close keeps failed protocol owners and retries the same instance before replacement', { timeout: 2_000 }, async () => {
  const opcuaInstances = []; const stompInstances = []; const attempts = [];
  class StubOpcuaService {
    constructor() { this.id = opcuaInstances.length + 1; opcuaInstances.push(this); }
    execute() { return Promise.resolve({ owner: this.id }); }
    async shutdown() { attempts.push(this.id); if (attempts.length <= 2) throw new Error('simulator listener still open'); }
  }
  class StubStompService {
    constructor() { stompInstances.push(this); }
    async shutdown() {}
  }
  class StubCoordinator { async closeAll() {} async shutdown() {} }
  const { electron, windows, handlers } = await createProtocolLifecycleHarness({ StubOpcuaService, StubStompService, StubCoordinator });
  windows[0].emit('closed'); electron.app.emit('activate');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 2);
  assert.equal(opcuaInstances.length, 1, 'failed OPC UA owner remains reachable');
  assert.equal(stompInstances.length, 2, 'successfully closed STOMP owner can be replaced');
  assert.deepEqual(attempts, [1, 1]);
  assert.deepEqual(normalize(await handlers.get('opcua:execute')(trustedIpcEvent(windows[1]), { action: 'serverProfiles' })), { ok: true, value: { owner: 1 } });
  windows[1].emit('closed'); electron.app.emit('activate');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(attempts, [1, 1, 1]);
  assert.equal(opcuaInstances.length, 2);
  assert.deepEqual(normalize(await handlers.get('opcua:execute')(trustedIpcEvent(windows[2]), { action: 'serverProfiles' })), { ok: true, value: { owner: 2 } });
});

test('macOS restores a usable window after a stalled close without admitting a replacement transport', async () => {
  const timers = createTestTimers(); let release; let opens = 0; let deletes = 0;
  class StubOpcuaService { async shutdown() {} execute() { return {}; } }
  class StubStompService { async shutdown() {} execute() { return {}; } }
  class StubCoordinator {
    closeAll() { return new Promise(resolve => { release = resolve; }); }
    open() { opens++; return { opened: true }; }
    async closeEndpoint() { deletes++; }
  }
  const profileReads = [];
  const readSavedProfiles = kind => async directory => {
    profileReads.push([kind, directory]);
    return [{ id: `saved-${kind}` }];
  };
  const { electron, windows, handlers } = await createProtocolLifecycleHarness({
    StubOpcuaService, StubStompService, StubCoordinator, timers,
    requireOverrides: {
      './opcuaStore.cjs': { readProfiles: readSavedProfiles('client') },
      './opcuaSimulatorStore.cjs': { readProfiles: readSavedProfiles('server') },
    },
  });
  windows[0].emit('closed'); electron.app.emit('activate'); electron.app.emit('activate');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 1);
  assert.deepEqual(timers.delays(), [2000]);
  timers.runAll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 2, 'stalled native cleanup must not hide the application indefinitely');
  const sender = trustedIpcEvent(windows[1]);
  const blocked = await handlers.get('transport:open')(sender, 'master', { operationId: 'replacement' });
  assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'PORT_BUSY'); assert.equal(opens, 0);
  assert.equal((await handlers.get('endpoint:list')(sender)).ok, true, 'saved configuration remains accessible');
  assert.equal((await handlers.get('endpoint:delete')(sender, 'master')).error.code, 'PORT_BUSY');
  assert.equal(deletes, 0, 'deletion must not enter a stalled native close from the recovered window');
  for (const [action, kind] of [['profiles', 'client'], ['serverProfiles', 'server']]) {
    const saved = await handlers.get('opcua:execute')(sender, { action });
    assert.deepEqual(normalize(saved), { ok: true, value: { profiles: [{ id: `saved-${kind}` }] } });
  }
  assert.deepEqual(profileReads, [['client', '/tmp/ineed-linklab-test/opcua'], ['server', '/tmp/ineed-linklab-test/opcua']]);
  assert.equal((await handlers.get('opcua:execute')(sender, { action: 'connect' })).error.code, 'PORT_BUSY');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 2, 'late completion must not create another window');
  assert.equal((await handlers.get('transport:open')(sender, 'master', { operationId: 'replacement' })).ok, true);
  assert.equal(opens, 1); assert.equal(timers.size, 0);
});

test('application exit waits for all resource groups after a protocol shutdown rejection', { timeout: 2_000 }, async () => {
  let opcuaAttempts = 0; let releaseCoordinator; let releaseStomp; let databaseCloses = 0;
  class StubOpcuaService { async shutdown() { opcuaAttempts++; throw new Error('simulator listener still open'); } }
  class StubStompService { shutdown() { return new Promise(resolve => { releaseStomp = resolve; }); } }
  class StubCoordinator { shutdown() { return new Promise(resolve => { releaseCoordinator = resolve; }); } }
  const { electron, windows, handlers } = await createProtocolLifecycleHarness({ StubOpcuaService, StubStompService, StubCoordinator, closeDatabase: () => { databaseCloses++; } });
  electron.app.emit('before-quit', { preventDefault() {} });
  await acknowledgeBeforeShutdown(handlers, windows[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opcuaAttempts, 2);
  assert.equal(databaseCloses, 0); assert.equal(electron.app.quitCalls, 0); assert.equal(windows[0].destroyed, false);
  releaseCoordinator(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(databaseCloses, 0); assert.equal(electron.app.quitCalls, 0);
  releaseStomp(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(databaseCloses, 1); assert.equal(electron.app.quitCalls, 1); assert.equal(windows[0].destroyed, true);
});

async function createProtocolLifecycleHarness({ StubOpcuaService, StubStompService, StubCoordinator, closeDatabase = () => {}, timers, requireOverrides = {} }) {
  const handlers = new Map(); const windows = []; const electron = createElectronMock({ handlers, windows });
  electron.app.getPath = () => '/tmp/ineed-linklab-test';
  executeCommonJs(await read('electron/main.cjs'), {
    electron, 'node:path': path, 'node:url': { pathToFileURL }, 'node:fs/promises': {}, serialport: { SerialPort: class {} },
    './database.cjs': { DATABASE_FILENAME: 'test.db', openConfigurationDatabase: () => ({ listEndpoints: () => [], insertFrameBatch: async () => {}, insertLogBatch: async () => {}, close: closeDatabase }) },
    './management.cjs': { ...managementModule, createWorkspaceFileHandlers: () => ({}) },
    './serialService.cjs': { SerialService: class {} }, './transportPersistence.cjs': transportPersistenceModule,
    './transportCoordinator.cjs': { TransportCoordinator: StubCoordinator },
    './opcuaService.cjs': { OpcuaService: StubOpcuaService }, './stompTransport.cjs': { StompTransport: StubStompService },
    ...requireOverrides,
  }, { dirname: path.join(packageRoot, 'electron'), platform: 'darwin', timers });
  electron.app.triggerReady(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  return { electron, windows, handlers };
}

test('renderer remains a tiny shared-workbench mount with no service or native access', async () => {
  const [source, adapterSource] = await Promise.all([
    read('renderer/main.js'),
    read('renderer/runtimeAdapter.js'),
  ]);
  const significantLines = source.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//'));

  assert.match(source, /from ['"]@ineed-linklab\/workbench['"]/);
  assert.match(source, /from ['"]\.\/runtimeAdapter\.js['"]/);
  assert.match(source, /@ineed-linklab\/workbench\/base\.css/);
  assert.match(source, /createWorkbench\(createElectronRuntimeAdapter\(window\.ineedLinkLab\), \{ presentationStorage \}\)\.mount\(['"]#app['"]\)/);
  assert.ok(significantLines.length <= 6, `renderer has ${significantLines.length} significant lines`);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|mqtt|ipcRenderer|node:|@tauri-apps|serialport/iu);
  assert.doesNotMatch(adapterSource, /localStorage|sessionStorage|indexedDB|mqtt|ipcRenderer|node:|@tauri-apps|(?<![.\w])window\./iu);
});

test('HTML and Vite config define a local renderer build', async () => {
  const [html, viteSource] = await Promise.all([read('index.html'), read('vite.config.js')]);

  assert.match(html, /<meta\s+name=['"]viewport['"]/i);
  assert.match(html, /<title>Ineed LinkLab<\/title>/i);
  assert.match(html, /<div\s+id=['"]app['"]><\/div>/i);
  assert.match(html, /renderer\/main\.js/);
  assert.match(viteSource, /plugins\s*:\s*\[vue\(\)\]/);
  assert.match(viteSource, /outDir\s*:\s*['"]dist['"]/);
  assert.doesNotMatch(viteSource, /https?:\/\//);
});

test('built renderer contains local index and assets when dist exists', async (t) => {
  const distRoot = path.join(packageRoot, 'dist');
  let entries;
  try {
    entries = await readdir(distRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' && process.env.INEED_VERIFY_BUILD !== '1') {
      t.skip('Electron dist is absent; run npm run test:artifacts to verify built output');
      return;
    }
    throw error;
  }

  assert.ok(entries.some((entry) => entry.name === 'index.html' && entry.isFile()));
  assert.ok(entries.some((entry) => entry.name === 'assets' && entry.isDirectory()));
  const builtHtml = await readFile(path.join(distRoot, 'index.html'), 'utf8');
  assert.match(builtHtml, /\.\/assets\//);
  assert.doesNotMatch(builtHtml, /https?:\/\/(?:localhost|127\.0\.0\.1)/);
});

function assertWindowOptions(options) {
  assert.equal(options.width, 1360);
  assert.equal(options.height, 860);
  assert.equal(options.minWidth, 1120);
  assert.equal(options.minHeight, 720);
  assert.equal(options.title, 'Ineed LinkLab');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.preload, path.join(packageRoot, 'electron', 'preload.cjs'));
}

function createElectronMock({
  handlers = new Map(),
  handledChannels = [],
  removedChannels = [],
  windows = [],
  isPackaged = false,
  menuTemplates = [],
  applicationMenuCalls = [],
  webContentsUnavailableAfterDestroy = false,
} = {}) {
  const appListeners = new Map();
  const readyCallbacks = [];
  class BrowserWindow {
    static getAllWindows() { return windows.filter((window) => !window.destroyed); }
    constructor(options) {
      this.options = options;
      this.loadedFiles = [];
      this.loadedUrls = [];
      this.listeners = new Map();
      this.destroyed = false;
      this.focusCalls = 0;
      const webListeners = new Map();
      const webContents = {
        mainFrame: { id: 'main-frame', url: '' },
        on(event, listener) {
          if (!webListeners.has(event)) webListeners.set(event, new Set());
          webListeners.get(event).add(listener);
        },
        emit(event, ...args) {
          for (const listener of webListeners.get(event) ?? []) listener(...args);
        },
        setWindowOpenHandler(handler) { this.openHandler = handler; },
        openHandler: null,
        sent: [],
        send(...args) { this.sent.push(args); },
      };
      Object.defineProperty(this, 'webContents', {
        get() {
          if (webContentsUnavailableAfterDestroy && this.destroyed) {
            throw new TypeError('Object has been destroyed');
          }
          return webContents;
        },
      });
      windows.push(this);
    }
    loadFile(file) {
      this.loadedFiles.push(file);
      this.webContents.mainFrame.url = pathToFileURL(file).href;
    }
    loadURL(url) {
      this.loadedUrls.push(url);
      this.webContents.mainFrame.url = new URL(url).href;
    }
    on(event, listener) { this.listeners.set(event, listener); }
    once(event, listener) { this.listeners.set(event, listener); }
    emit(event, ...args) {
      if (event === 'closed') this.destroyed = true;
      this.listeners.get(event)?.(...args);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', event);
      if (!event.prevented) this.emit('closed');
    }
    isMinimized() { return this.minimized === true; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    focus() { this.focusCalls += 1; }
  }
  const app = {
    isPackaged,
    quitCalls: 0,
    whenReady: () => ({ then(callback) { readyCallbacks.push(callback); } }),
    on(event, listener) {
      if (!appListeners.has(event)) appListeners.set(event, new Set());
      appListeners.get(event).add(listener);
    },
    emit(event, ...args) {
      for (const listener of appListeners.get(event) ?? []) listener(...args);
    },
    triggerReady() {
      for (const callback of readyCallbacks.splice(0)) callback();
    },
    quit() { this.quitCalls += 1; },
  };
  return {
    app,
    BrowserWindow,
    menuTemplates,
    applicationMenuCalls,
    shell: { async openExternal() {} },
    Menu: {
      buildFromTemplate(template) {
        menuTemplates.push(template);
        return { template };
      },
      setApplicationMenu(menu) { applicationMenuCalls.push(menu); },
    },
    ipcMain: {
      handle(channel, handler) {
        handledChannels.push(channel);
        assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        removedChannels.push(channel);
        handlers.delete(channel);
      },
    },
  };
}

function createTestTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    runAll() {
      for (const [id, task] of [...tasks]) {
        tasks.delete(id);
        task.callback();
      }
    },
    delays() { return [...tasks.values()].map(({ delay }) => delay); },
    get size() { return tasks.size; },
  };
}

function executeCommonJs(source, requireMap, {
  dirname = packageRoot,
  env = {},
  platform = 'linux',
  timers = { setTimeout, clearTimeout },
  consoleObject = console,
} = {}) {
  const module = { exports: {} };
  const context = vm.createContext({
    __dirname: dirname,
    __filename: path.join(dirname, 'fixture.cjs'),
    console: consoleObject,
    Error,
    module,
    exports: module.exports,
    process: { env, platform },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    URL,
    require(specifier) {
      if (specifier === './legacyUserData.cjs') return require('../electron/legacyUserData.cjs');
      if (specifier === './tcpService.cjs' && !(specifier in requireMap)) {
        return {
          TcpService: class {
            shutdown() { return Promise.resolve(); }
            forceShutdown() { return Promise.resolve(); }
          },
        };
      }
      if (specifier === './udpService.cjs' && !(specifier in requireMap)) {
        return {
          UdpService: class {
            shutdown() { return Promise.resolve(); }
            forceShutdown() { return Promise.resolve(); }
          },
        };
      }
      if (specifier === 'modbus-serial' && !(specifier in requireMap)) {
        return function ModbusRTU() {};
      }
      if (specifier === './modbusService.cjs' && !(specifier in requireMap)) {
        return {
          ModbusService: class {
            closeAll() { return Promise.resolve(); }
            shutdown() { return Promise.resolve(); }
            forceShutdown() { return Promise.resolve([]); }
          },
        };
      }
      if (specifier === './websocketService.cjs' && !(specifier in requireMap)) {
        return {
          WebSocketService: class {
            closeAll() { return Promise.resolve(); }
            shutdown() { return Promise.resolve(); }
            forceShutdown() { return Promise.resolve([]); }
          },
        };
      }
      if (specifier === './stompTransport.cjs' && !(specifier in requireMap)) return { StompTransport: class { execute() { return Promise.resolve({}); } shutdown() { return Promise.resolve(); } } };
      if (specifier === './opcuaService.cjs' && !(specifier in requireMap)) return { OpcuaService: class { execute() { return Promise.resolve({}); } shutdown() { return Promise.resolve(); } } };
      if (!(specifier in requireMap)) throw new Error(`Unexpected require: ${specifier}`);
      return requireMap[specifier];
    },
  });
  new vm.Script(source, { filename: context.__filename }).runInContext(context);
  return module.exports;
}

function loadMain(source, {
  env = {},
  isPackaged = false,
  platform = 'linux',
  webContentsUnavailableAfterDestroy = false,
} = {}) {
  const handlers = new Map();
  const windows = [];
  const electron = createElectronMock({
    handlers,
    windows,
    isPackaged,
    webContentsUnavailableAfterDestroy,
  });
  const exports = executeCommonJs(source, {
    electron,
    './management.cjs': managementModule,
    'node:path': path,
    'node:url': { pathToFileURL },
  }, {
    dirname: path.join(packageRoot, 'electron'),
    env,
    platform,
  });
  return { electron, exports, handlers, windows };
}

function loadPreloadBridge(ipcRendererOverrides = {}) {
  const exposures = [];
  const ipcRenderer = {
    invoke: async () => ({ ok: true }),
    on: () => {},
    removeListener: () => {},
    ...ipcRendererOverrides,
  };
  executeCommonJs(readFileSyncForVm('electron/preload.cjs'), {
    electron: {
      contextBridge: { exposeInMainWorld: (...args) => exposures.push(args) },
      ipcRenderer,
    },
  });
  return exposures[0][1];
}

function loadHistoryPreloadBridge(ipcRendererOverrides = {}) {
  const exposures = [];
  executeCommonJs(readFileSyncForVm('electron/historyPreload.cjs'), {
    electron: {
      contextBridge: { exposeInMainWorld: (...args) => exposures.push(args) },
      ipcRenderer: { invoke: async () => ({ ok: true }), ...ipcRendererOverrides },
    },
  });
  return exposures[0][1];
}

function readFileSyncForVm(relativePath) {
  return readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function trustedIpcEvent(mainWindow) {
  return {
    sender: mainWindow.webContents,
    senderFrame: mainWindow.webContents.mainFrame,
  };
}

function emitRendererEvent(listeners, channel, payload) {
  for (const listener of listeners.get(channel) ?? []) listener({ sender: 'ignored' }, payload);
}

async function acknowledgeBeforeShutdown(handlers, window) {
  const event = window.webContents.sent.find(([channel]) => channel === 'lifecycle:before-shutdown');
  assert.ok(event, 'native shutdown request must reach the main renderer');
  const response = await handlers.get('lifecycle:readyForShutdown')(
    trustedIpcEvent(window),
    event[1].requestId,
  );
  assert.deepEqual(normalize(response), { ok: true, value: { acknowledged: true } });
}

function subscribeBridgeEvent(listeners, eventName) {
  return (listener) => {
    listeners.set(eventName, listener);
    return () => listeners.delete(eventName);
  };
}

function collectMethods(bridge) {
  return Object.entries(bridge).flatMap(([namespace, methods]) => {
    if (namespace === 'runtimeName') return [];
    assert.equal(typeof methods, 'object', `${namespace} must be a namespace`);
    return Object.entries(methods).map(([method, implementation]) => {
      assert.equal(typeof implementation, 'function', `${namespace}.${method} must be a function`);
      return `${namespace}.${method}`;
    });
  });
}

function call(bridge, dottedMethod, ...args) {
  const [namespace, method] = dottedMethod.split('.');
  return bridge[namespace][method](...args);
}

function findProperty(value, property) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, property)) return true;
  return Object.values(value).some((nested) => findProperty(nested, property));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function read(relativePath) {
  return readFile(path.join(packageRoot, relativePath), 'utf8');
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeTransactionContract(transaction) {
  return {
    requestGroupId: transaction.requestGroupId,
    requestId: transaction.requestId,
    origin: transaction.origin,
    unitId: transaction.unitId,
    functionCode: transaction.functionCode,
    address: transaction.address,
    quantity: transaction.quantity,
    requestValues: transaction.requestValues,
    values: transaction.values,
    success: transaction.success,
    exceptionCode: transaction.exceptionCode,
    message: transaction.message,
  };
}
