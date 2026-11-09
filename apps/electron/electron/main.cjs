const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');

const { preserveLegacyUserData } = require('./legacyUserData.cjs');

preserveLegacyUserData(app);

const RUNTIME_NAME = 'electron';
const APP_ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const TRANSPORT_SHUTDOWN_TIMEOUT_MS = 2_000;
const IPC_METHODS = [
  'stomp.execute',
  'opcua.execute',
  'endpoint.list', 'endpoint.save', 'endpoint.clone', 'endpoint.delete',
  'transport.scanSerialPorts', 'transport.open', 'transport.cancelOpen',
  'transport.close', 'transport.send', 'transport.disconnectPeer',
  'modbus.execute', 'modbus.readMap', 'modbus.writeMap',
  'modbusHistory.recordBatch', 'modbusHistory.querySeries', 'modbusHistory.queryRows',
  'modbusHistory.exportCsv', 'modbusHistory.clear', 'modbusHistory.cleanup',
  'modbusHistory.flush',
  'history.queryFrames', 'history.queryLogs', 'history.delete', 'history.clear',
  'template.list', 'template.save', 'template.delete',
  'sendHistory.record', 'sendHistory.query', 'sendHistory.delete', 'sendHistory.clear',
  'settings.getAll', 'settings.save', 'settings.saveAll',
  'workspace.export', 'workspace.import',
  'storage.stats', 'storage.clearHistory', 'window.openHistory', 'window.openWebsite',
  'lifecycle.readyForShutdown',
];
// A recovered window can inspect saved data while the previous renderer's
// transports drain. Do not let late cleanup close connections it just opened.
const TRANSPORT_MUTATIONS = new Set([
  'endpoint.delete', 'transport.open', 'transport.send', 'transport.disconnectPeer',
  'modbus.execute', 'modbus.readMap', 'modbus.writeMap',
  'opcua.execute', 'stomp.execute', 'workspace.import',
]);
const READ_HANDLERS = {
  'endpoint.list': () => [],
  'modbusHistory.querySeries': () => ({ series: [], from: null, to: null }),
  'modbusHistory.queryRows': () => ({ rows: [], total: 0, page: 1, pageSize: 50 }),
  'modbusHistory.flush': () => ({ flushed: true }),
  'history.queryFrames': () => ({ rows: [], total: 0, page: 1, pageSize: 100 }),
  'history.queryLogs': () => ({ rows: [], total: 0, page: 1, pageSize: 100 }),
  'template.list': () => [],
  'sendHistory.query': () => ({ rows: [], total: 0, page: 1, pageSize: 20 }),
  'settings.getAll': () => ({}),
  'storage.stats': () => ({
    frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 0,
  }),
};

let mainWindow = null;
let historyPersistenceWarning = null;
let expectedRendererUrl = null;
let removeIpcHandlers = null;
let configurationDatabase = null;
let persistenceHandlers = null;
let transportCoordinator = null;
let opcuaService = null;
let stompService = null;
let transportShutdownPromise = null;
let transportShutdownComplete = false;
let rendererTransportClosePromise = null;
let rendererRestoreTimer = null;
let rendererShutdownHandshake = null;
const trustedRenderers = new Map();
const historyWindows = new Map();
let modbusHistoryExportSequence = 0;
const HISTORY_METHODS = new Set([
  'history.queryFrames',
  'history.queryLogs',
  'settings.getAll',
]);
const EVENT_AWARE_METHODS = new Set([
  'workspace.export', 'workspace.import', 'modbusHistory.exportCsv',
]);

function channelFor(method) {
  return method.replace('.', ':');
}

function failure(method, name, message, code) {
  return {
    ok: false,
    error: { name, message, method, runtimeName: RUNTIME_NAME, code },
  };
}

function handlerFailure(method, reason) {
  let name = 'PersistenceError';
  let message = `Runtime method "${method}" failed`;
  let code = 'PERSISTENCE_ERROR';
  if (reason && typeof reason === 'object') {
    if (typeof reason.name === 'string' && reason.name) name = reason.name;
    if (typeof reason.message === 'string' && reason.message) message = reason.message;
    if (typeof reason.code === 'string' && reason.code) code = reason.code;
  } else if (typeof reason === 'string' && reason) {
    message = reason;
  }
  return failure(method, name, message, code);
}

function authorizeSender(event, method) {
  const renderer = trustedRenderers.get(event?.sender);
  if (!renderer
    || event.senderFrame !== event.sender.mainFrame
    || event.senderFrame.url !== renderer.url) return 'UNTRUSTED_SENDER';
  if (renderer.kind === 'history' && !HISTORY_METHODS.has(method)) return 'UNAUTHORIZED_METHOD';
  return null;
}

function createPersistenceHandlers({
  database, transportCoordinator: coordinator, workspaceFiles, openHistory,
  modbusHistoryBoundary, shutdownHandshake,
}) {
  const flushModbusHistory = () => (
    modbusHistoryBoundary?.flush?.() ?? Promise.resolve({ flushed: true })
  );
  return {
    'endpoint.list': () => database.listEndpoints(),
    'endpoint.save': (profile) => database.saveEndpoint(profile),
    'endpoint.clone': (sourceId, overrides) => database.cloneEndpoint(sourceId, overrides),
    'endpoint.delete': async (id) => {
      await coordinator.closeEndpoint(id);
      return database.deleteEndpoint(id);
    },
    'transport.scanSerialPorts': () => coordinator.scanSerialPorts(),
    'transport.open': (endpointId, options) => coordinator.open(endpointId, options),
    'transport.cancelOpen': (endpointId, options) => coordinator.cancelOpen(endpointId, options),
    'transport.close': (endpointId) => coordinator.closeEndpoint(endpointId),
    'transport.send': (request) => coordinator.send(request),
    'transport.disconnectPeer': (request) => coordinator.disconnectPeer(request),
    'modbus.execute': (request) => coordinator.executeModbus(request),
    'modbus.readMap': (endpointId) => coordinator.readModbusMap(endpointId),
    'modbus.writeMap': (request) => coordinator.writeModbusMap(request),
    'modbusHistory.recordBatch': (rows) => database.recordModbusPointHistory(rows),
    'modbusHistory.querySeries': (query) => database.queryModbusPointSeries(query),
    'modbusHistory.queryRows': (query) => database.queryModbusPointHistoryRows(query),
    'modbusHistory.exportCsv': async (event, query) => {
      await flushModbusHistory();
      if (!modbusHistoryBoundary?.exportCsv) {
        throw new Error('Modbus point history CSV export is unavailable');
      }
      return modbusHistoryBoundary.exportCsv(event, query);
    },
    'modbusHistory.clear': async (query) => {
      await flushModbusHistory();
      return database.clearModbusPointHistory(query);
    },
    'modbusHistory.cleanup': (retention) => database.cleanupModbusPointHistory(retention),
    'modbusHistory.flush': flushModbusHistory,
    'settings.getAll': () => database.getSettings(),
    'settings.save': (key, value) => database.saveSetting(key, value),
    'settings.saveAll': (values) => database.saveSettings(values),
    'history.queryFrames': async (query) => {
      await coordinator.flushPersistence?.();
      return database.queryFrames(query);
    },
    'history.queryLogs': async (query) => {
      await coordinator.flushPersistence?.();
      return database.queryLogs(query);
    },
    'template.list': (endpointId) => database.listTemplates(endpointId),
    'template.save': (template) => database.saveTemplate(template),
    'template.delete': (id) => database.deleteTemplate(id),
    'sendHistory.record': (record) => database.recordSendHistory(record),
    'sendHistory.query': (query) => database.querySendHistory(query),
    'sendHistory.delete': (id) => database.deleteSendHistory(id),
    'sendHistory.clear': (endpointId) => database.clearSendHistory(endpointId),
    'workspace.export': (event) => workspaceFiles?.exportWorkspace(event) ?? database.exportWorkspace(),
    'workspace.import': async (event, workspace) => {
      const prepareImport = async () => {
        await coordinator.closeAll();
        await coordinator.flushPersistence?.();
        await flushModbusHistory();
      };
      if (workspaceFiles) return workspaceFiles.importWorkspace(event, prepareImport);
      const prepared = database.prepareWorkspaceImport(workspace);
      await prepareImport();
      return database.importWorkspace(prepared);
    },
    'storage.stats': () => database.storageStats(),
    'storage.clearHistory': async () => {
      await coordinator.flushPersistence?.();
      return database.clearHistory();
    },
    'window.openHistory': (request) => openHistory?.(request),
    'lifecycle.readyForShutdown': (requestId) => ({
      acknowledged: shutdownHandshake?.ready(requestId) ?? false,
    }),
  };
}

function createRendererShutdownHandshake({
  getMainWindow,
  timers = globalThis,
  createRequestId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  timeoutMs = 2_000,
}) {
  let pending = null;
  const ready = (requestId) => {
    if (!pending || requestId !== pending.requestId) return false;
    pending.finish(true);
    return true;
  };
  const request = () => {
    if (pending) return pending.promise;
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return Promise.resolve({ requestId: null, acknowledged: false });
    }
    const requestId = createRequestId();
    let timeout;
    let resolveRequest;
    const promise = new Promise((resolve) => { resolveRequest = resolve; });
    const finish = (acknowledged) => {
      if (!pending || pending.requestId !== requestId) return;
      timers.clearTimeout(timeout);
      pending = null;
      resolveRequest({ requestId, acknowledged });
    };
    pending = { requestId, promise, finish };
    timeout = timers.setTimeout(() => finish(false), timeoutMs);
    window.webContents.send('lifecycle:before-shutdown', { requestId });
    return promise;
  };
  return { ready, request };
}

function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function createModbusPointHistoryCsvExporter({ BrowserWindow: Window, dialog: nativeDialog, files, database }) {
  const showSaveDialog = (event, options) => {
    let parent = null;
    try {
      parent = Window?.fromWebContents?.(event?.sender) ?? null;
    } catch {
      // A detached sender falls back to the unparented save dialog.
    }
    return parent
      ? nativeDialog.showSaveDialog(parent, options)
      : nativeDialog.showSaveDialog(options);
  };
  const assertSafeTarget = async (filePath) => {
    try {
      const metadata = await files.lstat(filePath);
      if (metadata.isSymbolicLink()) throw new TypeError('CSV path must not be a symbolic link');
      if (!metadata.isFile()) throw new TypeError('CSV path must be a regular file');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
  const rowCsv = (row) => [
    row.createdAt,
    row.endpointId,
    row.requestGroupId,
    row.requestId,
    row.pointId,
    row.pointKey,
    row.pointName,
    JSON.stringify(row.raw),
    JSON.stringify(row.value),
    row.unit,
    row.quality,
    row.reason,
  ].map(csvField).join(',');

  return {
    async exportCsv(event, query) {
      const selected = await showSaveDialog(event, {
        title: '导出 Modbus 数据点历史',
        buttonLabel: '导出',
        defaultPath: 'modbus-point-history.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      await assertSafeTarget(selected.filePath);
      modbusHistoryExportSequence += 1;
      const temporary = path.join(
        path.dirname(selected.filePath),
        `.${path.basename(selected.filePath)}.${process.pid}.${modbusHistoryExportSequence}.tmp`,
      );
      let handle;
      let exportedCount = 0;
      try {
        handle = await files.open(temporary, 'wx', 0o600);
        await handle.writeFile(
          'timestamp,endpointId,requestGroupId,requestId,pointId,pointKey,pointName,rawValue,engineeringValue,unit,quality,reason\r\n',
          'utf8',
        );
        let page = 1;
        while (true) {
          const result = database.queryModbusPointHistoryRows({
            ...query,
            page,
            pageSize: 200,
          });
          for (const row of result.rows) {
            await handle.writeFile(`${rowCsv(row)}\r\n`, 'utf8');
            exportedCount += 1;
          }
          if (page * result.pageSize >= result.total || result.rows.length === 0) break;
          page += 1;
        }
        await handle.sync();
        await handle.close();
        handle = null;
        await files.rename(temporary, selected.filePath);
        const directory = await files.open(path.dirname(selected.filePath), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return { canceled: false, path: selected.filePath, exportedCount };
      } catch (error) {
        await handle?.close().catch(() => {});
        await files.unlink(temporary).catch((cleanupError) => {
          if (cleanupError?.code !== 'ENOENT') throw cleanupError;
        });
        throw error;
      }
    },
  };
}

function createTransportEventSink({ persistence, getMainWindow, reportError }) {
  return (channel, payload) => {
    if (!['transport:frames', 'transport:status', 'transport:peers'].includes(channel)) return;
    try {
      persistence.handle(channel, payload);
    } catch (error) {
      try {
        reportError(error, { channel });
      } catch {
        // Persistence reporting is isolated from renderer event delivery.
      }
    }
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
}

function disabledTransportPersistence() {
  return {
    handle() {},
    flush: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function reportTransportPersistenceError(error, context) {
  console.error('[Ineed LinkLab] transport persistence failed', error, context);
  const warning = historyPersistenceWarning = {
    message: String(error?.message ?? error).slice(0, 256),
    rowCount: context?.rowCount ?? context?.droppedCount ?? null,
  };
  // This event bypasses transport persistence to avoid recursive error logs.
  for (const window of [mainWindow, ...historyWindows.values()]) {
    if (window && !window.isDestroyed()) {
      try { window.webContents.send('persistence:warning', warning); } catch { /* Window closed. */ }
    }
  }
}

function registerIpcHandlers(handlers = persistenceHandlers ?? READ_HANDLERS) {
  if (removeIpcHandlers) return removeIpcHandlers;

  for (const method of IPC_METHODS) {
    ipcMain.handle(channelFor(method), async (event, ...args) => {
      const authorizationError = authorizeSender(event, method);
      if (authorizationError) {
        return failure(
          method,
          'SecurityError',
          authorizationError === 'UNTRUSTED_SENDER'
            ? `IPC sender is not trusted for ${method}`
            : `IPC sender is not authorized for ${method}`,
          authorizationError,
        );
      }

      if (rendererTransportClosePromise && TRANSPORT_MUTATIONS.has(method)) {
        // Saved OPC UA endpoints are files, independent of the retiring SDK.
        // Read them without calling a closed service so the recovered catalog
        // stays complete even when native transport cleanup never finishes.
        if (method === 'opcua.execute' && ['profiles', 'serverProfiles'].includes(args[0]?.action)) {
          try {
            const store = args[0].action === 'profiles'
              ? require('./opcuaStore.cjs') : require('./opcuaSimulatorStore.cjs');
            return { ok: true, value: { profiles: await store.readProfiles(path.join(app.getPath('userData'), 'opcua')) } };
          } catch (error) {
            return handlerFailure(method, error);
          }
        }
        return failure(method, 'TransportError', '上一窗口的连接仍在关闭，请稍后重试。配置与历史记录可正常查看。', 'PORT_BUSY');
      }

      // The fixed product site stays available even when local storage failed.
      const handler = method === 'stomp.execute' && stompService
        ? request => stompService.execute(request)
        : method === 'opcua.execute' && opcuaService
        ? (request) => {
          if (!opcuaService) throw new Error('OPC UA 服务未初始化');
          if (request?.action === 'export') {
            const { createOpcuaExporter } = require('./opcuaExport.cjs');
            return createOpcuaExporter({ dialog, files: require('node:fs/promises'), getWindow: () => mainWindow })(request);
          }
          return opcuaService.execute(request);
        }
        : method === 'window.openWebsite'
        ? async () => { await shell.openExternal('https://linklab.ineedfull.com/'); return null; }
        : handlers[method];
      if (!handler) {
        return failure(
          method,
          'RuntimeUnavailableError',
          `Runtime method "${method}" is unavailable in ${RUNTIME_NAME}`,
          'RUNTIME_UNAVAILABLE',
        );
      }
      try {
        const handlerArgs = EVENT_AWARE_METHODS.has(method) ? [event, ...args] : args;
        return { ok: true, value: await handler(...handlerArgs) };
      } catch (error) {
        return handlerFailure(method, error);
      }
    });
  }

  removeIpcHandlers = () => {
    for (const method of IPC_METHODS) ipcMain.removeHandler(channelFor(method));
    removeIpcHandlers = null;
  };
  return removeIpcHandlers;
}

function installApplicationMenu() {
  const menu = Menu.buildFromTemplate([
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
  ]);
  Menu.setApplicationMenu(menu);
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const createdWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    title: 'Ineed LinkLab',
    icon: APP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = createdWindow;
  if (rendererShutdownHandshake) {
    installMainWindowShutdownHandshake(createdWindow, rendererShutdownHandshake);
  }
  const createdWebContents = createdWindow.webContents;
  createdWebContents.on('did-finish-load', () => {
    if (historyPersistenceWarning && !createdWindow.isDestroyed()) {
      createdWebContents.send('persistence:warning', historyPersistenceWarning);
    }
  });

  const developmentUrl = getDevelopmentUrl();
  const productionPath = path.join(__dirname, '..', 'dist', 'index.html');
  expectedRendererUrl = developmentUrl ?? pathToFileURL(productionPath).href;
  trustedRenderers.set(createdWebContents, { url: expectedRendererUrl, kind: 'main' });

  const preventUnexpectedNavigation = (event, url) => {
    if (url !== expectedRendererUrl) event.preventDefault();
  };
  createdWebContents.on('will-navigate', preventUnexpectedNavigation);
  createdWebContents.on('will-redirect', preventUnexpectedNavigation);
  createdWebContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (developmentUrl) {
    createdWindow.loadURL(developmentUrl);
  } else {
    createdWindow.loadFile(productionPath);
  }

  createdWindow.once('closed', () => {
    trustedRenderers.delete(createdWebContents);
    if (mainWindow === createdWindow) {
      mainWindow = null;
      expectedRendererUrl = null;
      beginRendererTransportClose();
    }
  });
  return createdWindow;
}

function installMainWindowShutdownHandshake(window, shutdownHandshake) {
  let allowClose = false;
  let closing = null;
  window.on('close', (event) => {
    if (allowClose) {
      allowClose = false;
      return;
    }
    event.preventDefault();
    if (closing) return;
    let request;
    try {
      request = shutdownHandshake.request();
    } catch {
      request = undefined;
    }
    closing = Promise.resolve(request)
      .catch(() => {})
      .finally(() => {
        closing = null;
        allowClose = true;
        window.close();
      });
  });
}

function openHistoryWindow(request) {
  const { buildHistoryLocation, buildHistoryWindowTitle } = require('./management.cjs');
  const location = buildHistoryLocation(expectedRendererUrl, request);
  const existing = historyWindows.get(location);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { focused: true };
  }
  const historyWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: buildHistoryWindowTitle(request),
    icon: APP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'historyPreload.cjs'),
    },
  });
  historyWindows.set(location, historyWindow);
  const historyWebContents = historyWindow.webContents;
  trustedRenderers.set(historyWebContents, { url: location, kind: 'history' });
  const blockUnexpectedLocation = (event, url) => {
    if (url !== location) event.preventDefault();
  };
  historyWebContents.on('will-navigate', blockUnexpectedLocation);
  historyWebContents.on('will-redirect', blockUnexpectedLocation);
  historyWebContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  historyWindow.loadURL(location);
  historyWindow.once('closed', () => {
    historyWindows.delete(location);
    trustedRenderers.delete(historyWebContents);
  });
  return { focused: false };
}

function getDevelopmentUrl() {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return null;

  try {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    const loopbackHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const exactOrigin = url.protocol === 'http:'
      && loopbackHost
      && url.port === '5173'
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === '';
    return exactOrigin ? url.href : null;
  } catch {
    return null;
  }
}

function cleanupApplication() {
  if (rendererRestoreTimer !== null) clearTimeout(rendererRestoreTimer);
  rendererRestoreTimer = null;
  const removeHandlers = removeIpcHandlers;
  const database = configurationDatabase;
  const window = mainWindow;
  removeIpcHandlers = null;
  configurationDatabase = null;
  persistenceHandlers = null;
  mainWindow = null;
  expectedRendererUrl = null;
  trustedRenderers.clear();
  historyWindows.clear();
  rendererTransportClosePromise = null;
  rendererShutdownHandshake = null;
  runCleanupStep(() => Menu.setApplicationMenu(null));
  runCleanupStep(() => removeHandlers?.());
  runCleanupStep(() => database?.close());
  runCleanupStep(() => {
    if (window && !window.isDestroyed()) window.destroy();
  });
}

function runCleanupStep(step) {
  try {
    step();
  } catch {
    // Application cleanup continues so one native failure cannot block quit.
  }
}

function shutdownTransport(coordinator, attemptsRemaining = 2) {
  let attempt;
  try {
    attempt = coordinator?.shutdown();
  } catch (error) {
    if (attemptsRemaining > 1) return shutdownTransport(coordinator, attemptsRemaining - 1);
    return Promise.reject(error);
  }
  return Promise.resolve(attempt).catch((error) => {
    if (attemptsRemaining > 1) return shutdownTransport(coordinator, attemptsRemaining - 1);
    throw error;
  });
}

function shutdownTransportForExit(
  coordinator,
  timeoutMs = TRANSPORT_SHUTDOWN_TIMEOUT_MS,
  timers = globalThis,
) {
  let timeout = null;
  const graceful = shutdownTransport(coordinator).then(
    () => true,
    () => false,
  );
  const deadline = new Promise((resolve) => {
    timeout = timers.setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([graceful, deadline])
    .then((closedGracefully) => {
      if (!closedGracefully) return runCleanupStepAsync(() => coordinator?.forceShutdown?.());
      return undefined;
    })
    .finally(() => {
      if (timeout !== null) timers.clearTimeout(timeout);
    });
}

async function runCleanupStepAsync(step) {
  try {
    await step();
  } catch {
    // Forced transport cleanup continues so the application can still quit.
  }
}

function beginRendererTransportClose() {
  if (rendererTransportClosePromise || !transportCoordinator) {
    return rendererTransportClosePromise;
  }
  const coordinator = transportCoordinator;
  const tracked = Promise.allSettled([
    Promise.resolve().then(() => coordinator?.closeAll()),
    ...shutdownProtocolServices(),
  ]);
  const closing = tracked.finally(() => {
    if (rendererTransportClosePromise === closing) rendererTransportClosePromise = null;
  });
  rendererTransportClosePromise = closing;
  return rendererTransportClosePromise;
}

function shutdownProtocolServices() {
  const opcua = opcuaService;
  const stomp = stompService;
  return [
    shutdownTransport(opcua).then(() => { if (opcuaService === opcua) opcuaService = null; }),
    shutdownTransport(stomp).then(() => { if (stompService === stomp) stompService = null; }),
  ];
}

function beginTransportShutdown() {
  if (transportShutdownPromise) return transportShutdownPromise;
  const coordinator = transportCoordinator;
  transportCoordinator = null;
  let rendererRequest;
  try { rendererRequest = rendererShutdownHandshake?.request(); } catch { /* Continue native cleanup if the renderer is unavailable. */ }
  const shutdownResources = () => Promise.allSettled([shutdownTransportForExit(coordinator), ...shutdownProtocolServices()]);
  transportShutdownPromise = Promise.resolve(rendererRequest)
    .then(shutdownResources, shutdownResources)
    .finally(() => {
      transportShutdownComplete = true;
      cleanupApplication();
    });
  return transportShutdownPromise;
}

function restoreStompService() {
  if (stompService) return;
  const { StompTransport } = require('./stompTransport.cjs');
  stompService = new StompTransport({ emitEvent: payload => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stomp:event', payload);
  } });
}

app.whenReady().then(async () => {
  app.dock?.setIcon(APP_ICON_PATH);
  if (typeof app.getPath === 'function') {
    const { DATABASE_FILENAME, openConfigurationDatabase } = require('./database.cjs');
    const fs = require('node:fs/promises');
    const { createWorkspaceFileHandlers } = require('./management.cjs');
    const { SerialPort } = require('serialport');
    const { SerialService } = require('./serialService.cjs');
    const { TcpService } = require('./tcpService.cjs');
    const { WebSocketService } = require('./websocketService.cjs');
    const { UdpService } = require('./udpService.cjs');
    const ModbusRTU = require('modbus-serial');
    const { ModbusService } = require('./modbusService.cjs');
    const { TransportCoordinator } = require('./transportCoordinator.cjs');
    configurationDatabase = openConfigurationDatabase(path.join(app.getPath('userData'), DATABASE_FILENAME));
    const { OpcuaService } = require('./opcuaService.cjs');
    opcuaService = new OpcuaService({
      directory: path.join(app.getPath('userData'), 'opcua'),
      emitEvent: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('opcua:event', payload);
      },
    });
    const workspaceFiles = createWorkspaceFileHandlers({
      BrowserWindow, dialog, files: fs, database: configurationDatabase,
    });
    const modbusHistoryBoundary = {
      flush: async () => ({ flushed: true }),
      ...createModbusPointHistoryCsvExporter({
        BrowserWindow, dialog, files: fs, database: configurationDatabase,
      }),
    };
    rendererShutdownHandshake = createRendererShutdownHandshake({
      getMainWindow: () => mainWindow,
    });
    let transportPersistence = disabledTransportPersistence();
    try {
      const { createTransportPersistence } = require('./transportPersistence.cjs');
      transportPersistence = await createTransportPersistence({
        database: configurationDatabase,
        endpointReceiveMode(endpointId) {
          const endpoint = configurationDatabase.listEndpoints().find(({ id }) => id === endpointId);
          if (endpoint?.transport?.startsWith('websocket-')) return 'websocket';
          if (endpoint?.transport === 'udp-client' || endpoint?.transport === 'udp-server') {
            return 'datagram';
          }
          return endpoint?.config?.receiveFraming?.mode ?? 'raw';
        },
        reportError: reportTransportPersistenceError,
      });
    } catch (error) {
      reportTransportPersistenceError(error, { phase: 'initialization' });
    }
    const emitTransportEvent = createTransportEventSink({
      persistence: transportPersistence,
      getMainWindow: () => mainWindow,
      reportError: reportTransportPersistenceError,
    });
    const serialService = new SerialService({
      SerialPort,
      emitEvent: emitTransportEvent,
      reportEventError: reportTransportPersistenceError,
    });
    const tcpService = new TcpService({
      emitEvent: emitTransportEvent,
      reportEventError: reportTransportPersistenceError,
    });
    const websocketService = new WebSocketService({
      emitEvent: emitTransportEvent, reportEventError: reportTransportPersistenceError,
    });
    const udpService = new UdpService({
      emitEvent: emitTransportEvent,
      reportEventError: reportTransportPersistenceError,
    });
    const emitModbusEvent = (payload) => {
      const window = mainWindow;
      if (window && !window.isDestroyed()) window.webContents.send('modbus:transaction', payload);
    };
    const modbusService = new ModbusService({
      ModbusRTU,
      emitTransportEvent,
      emitModbusEvent,
    });
    transportCoordinator = new TransportCoordinator({
      serialService,
      tcpService,
      udpService,
      websocketService,
      modbusService,
      database: configurationDatabase,
      persistence: transportPersistence,
    });
    persistenceHandlers = createPersistenceHandlers({
      database: configurationDatabase,
      transportCoordinator,
      workspaceFiles,
      modbusHistoryBoundary,
      shutdownHandshake: rendererShutdownHandshake,
      openHistory: openHistoryWindow,
    });
  }
  restoreStompService();
  installApplicationMenu();
  registerIpcHandlers(persistenceHandlers ?? READ_HANDLERS);
  createMainWindow();
  app.on('activate', () => {
    if (transportShutdownPromise) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    const closing = rendererTransportClosePromise;
    const restoreOpcua = () => {
      restoreStompService();
      if (!opcuaService && typeof app.getPath === 'function') {
        const { OpcuaService } = require('./opcuaService.cjs');
        opcuaService = new OpcuaService({ directory: path.join(app.getPath('userData'), 'opcua'),
          emitEvent: payload => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('opcua:event', payload); } });
      }
    };
    if (!closing) {
      restoreOpcua();
      createMainWindow();
      return;
    }
    const recoverWindow = () => {
      if (rendererRestoreTimer !== null) clearTimeout(rendererRestoreTimer);
      rendererRestoreTimer = null;
      if (!transportShutdownPromise && (!mainWindow || mainWindow.isDestroyed())) createMainWindow();
    };
    // Native drivers may never acknowledge close. Restore the desktop shell
    // after a bounded wait, retaining the original owners and IPC reservation.
    if (rendererRestoreTimer === null) {
      rendererRestoreTimer = setTimeout(recoverWindow, TRANSPORT_SHUTDOWN_TIMEOUT_MS);
    }
    void closing.then(() => {
      if (!transportShutdownPromise) restoreOpcua();
      recoverWindow();
    }).catch(() => {});
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (transportShutdownPromise && !transportShutdownComplete) {
    event?.preventDefault?.();
    return;
  }
  if (transportCoordinator && typeof event?.preventDefault === 'function') {
    event.preventDefault();
    void beginTransportShutdown()
      .finally(() => app.quit())
      .catch(() => {});
    return;
  }
  if (transportCoordinator) void beginTransportShutdown();
  cleanupApplication();
});

module.exports = {
  createMainWindow,
  createModbusPointHistoryCsvExporter,
  installMainWindowShutdownHandshake,
  createPersistenceHandlers,
  createRendererShutdownHandshake,
  createTransportEventSink,
  openHistoryWindow,
  registerIpcHandlers,
};
