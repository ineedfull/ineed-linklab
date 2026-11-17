import assert from 'node:assert/strict';
import { constants as fsConstants, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpointIdCases = JSON.parse(readFileSync(path.join(
  root, '..', '..', 'packages', 'runtime-contract', 'tests', 'historyEndpointIdCases.json',
), 'utf8'));
const integralNumberCases = JSON.parse(readFileSync(path.join(
  root, '..', '..', 'packages', 'runtime-contract', 'src', 'integralJsonNumbers.json',
), 'utf8'));
const {
  buildHistoryLocation,
  buildHistoryWindowTitle,
  createWorkspaceFileHandlers,
  MAX_WORKSPACE_BYTES,
  validateHistoryRequest,
} = require(path.join(root, 'electron', 'management.cjs'));
const { openConfigurationDatabase } = require(path.join(root, 'electron', 'database.cjs'));

test('invalid workspace contents leave active connections and stored data untouched', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linklab-invalid-import-'));
  const database = openConfigurationDatabase(path.join(directory, 'data.db'));
  t.after(async () => { database.close(); await fs.rm(directory, { recursive: true, force: true }); });
  database.insertEndpoint({ id: 'stable', name: 'Stable', transport: 'tcp-client', config: { host: '127.0.0.1', port: 12345 } });
  const before = database.exportWorkspace();
  const selected = path.join(directory, 'workspace.json');
  const handlers = createWorkspaceFileHandlers({
    database, files: fs,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
  });
  let closed = 0;
  const invalidCases = [
    (value) => { value.endpointProfiles[0].transport = 'unsupported'; },
    (value) => { value.endpointProfiles[0].name = ''; },
    (value) => { value.settings.theme = 'invalid-theme'; },
    (value) => { value.sendTemplates = [{
      id: 'template-1', endpointId: 'stable', name: 'Broken', format: 'hex', framing: 'none',
      target: null, payloadBase64: 'invalid base64', createdAt: 100, updatedAt: 100,
    }]; },
    (value) => { value.sendTemplates = [{
      id: 'template-1', endpointId: 'missing-endpoint', name: 'Orphan', format: 'hex', framing: 'none',
      target: null, payloadBase64: 'AA==', createdAt: 100, updatedAt: 100,
    }]; },
  ];
  for (const invalidate of invalidCases) {
    const document = structuredClone(before);
    document.schemaVersion = document.version;
    delete document.version;
    invalidate(document);
    await fs.writeFile(selected, JSON.stringify(document));
    await assert.rejects(handlers.importWorkspace(undefined, async () => { closed += 1; }));
    assert.equal(closed, 0, 'input validation must precede connection shutdown');
    assert.deepEqual(database.exportWorkspace(), before);
  }
  const valid = { ...before, schemaVersion: 1, settings: { ...before.settings, theme: 'dark' } };
  delete valid.version;
  await fs.writeFile(selected, JSON.stringify(valid));
  await handlers.importWorkspace(undefined, async () => { closed += 1; });
  assert.equal(closed, 1);
  assert.equal(database.getSettings().theme, 'dark');
});

test('history request accepts exact kind and optional safe endpoint ID only', () => {
  assert.deepEqual(validateHistoryRequest({ kind: 'frames' }), { kind: 'frames', endpointId: null });
  assert.deepEqual(validateHistoryRequest({ kind: 'logs', endpointId: 'ep-1_TCP' }), {
    kind: 'logs', endpointId: 'ep-1_TCP',
  });
  for (const request of [
    null,
    { kind: 'settings' },
    { kind: 'frames', endpointId: '../settings' },
    { kind: 'logs', endpointId: 'x/y' },
    { kind: 'frames', extra: true },
  ]) {
    assert.throws(() => validateHistoryRequest(request), /history|endpoint|property/i);
  }
});

test('Electron history endpoint validation matches the shared cross-runtime cases', () => {
  for (const endpointId of endpointIdCases.accepted) {
    assert.deepEqual(validateHistoryRequest({ kind: 'frames', endpointId }), {
      kind: 'frames', endpointId,
    });
  }
  for (const endpointId of endpointIdCases.rejected) {
    assert.throws(() => validateHistoryRequest({ kind: 'frames', endpointId }), /endpoint/i);
  }
});

test('history location keeps the exact renderer path and encoded query only', () => {
  assert.equal(
    buildHistoryLocation('file:///app/dist/index.html', { kind: 'logs', endpointId: 'ep:1' }),
    'file:///app/dist/index.html?view=history&kind=logs&endpointId=ep%3A1',
  );
  assert.equal(
    buildHistoryLocation('http://127.0.0.1:5173/', { kind: 'frames' }),
    'http://127.0.0.1:5173/?view=history&kind=frames',
  );
});

test('history native titles are Chinese and depend on kind', () => {
  assert.equal(buildHistoryWindowTitle({ kind: 'frames' }), '历史消息');
  assert.equal(buildHistoryWindowTitle({ kind: 'logs', endpointId: '中文 端点' }), '历史日志');
});

test('workspace export uses save dialog and writes versioned JSON outside renderer', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ineed-workspace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'workspace.json');
  const dialogOptions = [];
  const handlers = createWorkspaceFileHandlers({
    dialog: {
      showSaveDialog: async (options) => {
        dialogOptions.push(options);
        return { canceled: false, filePath: destination };
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    files: fs,
    database: {
      exportWorkspace: () => ({ version: 1, endpointProfiles: [], settings: {}, sendTemplates: [] }),
      importWorkspace: () => { throw new Error('not used'); },
    },
  });

  assert.deepEqual(await handlers.exportWorkspace(), { canceled: false, path: destination });
  assert.deepEqual(dialogOptions, [{
    title: '导出工作区',
    buttonLabel: '导出',
    defaultPath: 'ineed-workspace.json',
    filters: [{ name: '工作区 JSON', extensions: ['json'] }],
  }]);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), {
    schemaVersion: 1, endpointProfiles: [], settings: {}, sendTemplates: [],
  });
});

test('workspace dialogs use the sender parent window with a safe fallback', async () => {
  const sender = { id: 'renderer' };
  const parent = { id: 'main-window' };
  const parentLookups = [];
  const saveCalls = [];
  const openCalls = [];
  const handlers = createWorkspaceFileHandlers({
    BrowserWindow: {
      fromWebContents(webContents) {
        parentLookups.push(webContents);
        return webContents === sender ? parent : null;
      },
    },
    dialog: {
      showSaveDialog: async (...args) => { saveCalls.push(args); return { canceled: true }; },
      showOpenDialog: async (...args) => { openCalls.push(args); return { canceled: true }; },
    },
    files: fs,
    database: { exportWorkspace: () => ({}), importWorkspace: () => {} },
  });

  await handlers.exportWorkspace({ sender });
  await handlers.importWorkspace({ sender });
  await handlers.exportWorkspace({ sender: { id: 'orphan' } });
  await handlers.importWorkspace();

  assert.equal(saveCalls[0][0], parent);
  assert.equal(saveCalls[0][1].title, '导出工作区');
  assert.equal(openCalls[0][0], parent);
  assert.equal(openCalls[0][1].title, '导入工作区');
  assert.equal(saveCalls[1].length, 1);
  assert.equal(saveCalls[1][0].title, '导出工作区');
  assert.equal(openCalls[1].length, 1);
  assert.equal(openCalls[1][0].title, '导入工作区');
  assert.deepEqual(parentLookups, [sender, sender, { id: 'orphan' }]);
});

test('workspace dialog cancel is quiet and import checks schema before mutation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ineed-workspace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const badPath = path.join(directory, 'bad.json');
  await fs.writeFile(badPath, JSON.stringify({ schemaVersion: 2 }));
  let mutations = 0;
  let preparations = 0;
  const openOptions = [];
  const dialog = {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async (options) => {
      openOptions.push(options);
      return { canceled: true, filePaths: [] };
    },
  };
  const database = {
    exportWorkspace: () => ({ version: 1 }),
    importWorkspace: () => { mutations += 1; },
  };
  let handlers = createWorkspaceFileHandlers({ dialog, files: fs, database });
  assert.deepEqual(await handlers.exportWorkspace(), { canceled: true });
  assert.deepEqual(await handlers.importWorkspace(undefined, async () => { preparations += 1; }), { canceled: true });
  assert.deepEqual(openOptions, [{
    title: '导入工作区',
    buttonLabel: '导入',
    properties: ['openFile'],
    filters: [{ name: '工作区 JSON', extensions: ['json'] }],
  }]);
  assert.equal(mutations, 0);
  assert.equal(preparations, 0);

  handlers = createWorkspaceFileHandlers({
    dialog: { ...dialog, showOpenDialog: async () => ({ canceled: false, filePaths: [badPath] }) },
    files: fs,
    database,
  });
  await assert.rejects(
    handlers.importWorkspace(undefined, async () => { preparations += 1; }),
    /schema version must be 1/i,
  );
  assert.equal(mutations, 0);
  assert.equal(preparations, 0);
});

test('workspace file handlers bound imports and reject symlinks and non-regular files', async (t) => {
  assert.equal(MAX_WORKSPACE_BYTES, 10 * 1024 * 1024);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ineed-workspace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const validPath = path.join(directory, 'valid.json');
  const largePath = path.join(directory, 'large.json');
  const linkedPath = path.join(directory, 'linked.json');
  await fs.writeFile(validPath, JSON.stringify({ schemaVersion: 1, endpointProfiles: [] }));
  await fs.writeFile(largePath, Buffer.alloc(10 * 1024 * 1024 + 1));
  await fs.symlink(validPath, linkedPath);
  let selectedPath = validPath;
  const order = [];
  const handlers = createWorkspaceFileHandlers({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    files: fs,
    database: {
      importWorkspace: () => { order.push('import'); },
      prepareWorkspaceImport: (workspace) => workspace,
      exportWorkspace: () => ({ version: 1 }),
    },
  });

  assert.deepEqual(await handlers.importWorkspace(undefined, async () => { order.push('prepare'); }), {
    canceled: false, path: validPath,
  });
  assert.deepEqual(order, ['prepare', 'import']);
  selectedPath = largePath;
  await assert.rejects(handlers.importWorkspace(), /10 MiB|too large/i);
  selectedPath = linkedPath;
  await assert.rejects(handlers.importWorkspace(), (error) => {
    assert.match(error.message, /symbolic link/i);
    assert.equal(error.cause?.code, 'ELOOP');
    return true;
  });
  selectedPath = directory;
  await assert.rejects(handlers.importWorkspace(), /regular file/i);
  assert.deepEqual(order, ['prepare', 'import']);
});

test('workspace import validates exact integer lexemes before database mutation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ineed-workspace-numbers-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const selectedPath = path.join(directory, 'workspace.json');
  const imported = [];
  const handlers = createWorkspaceFileHandlers({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    files: fs,
    database: {
      importWorkspace: (workspace) => imported.push(workspace),
      prepareWorkspaceImport: (workspace) => workspace,
      exportWorkspace: () => ({ version: 1 }),
    },
  });

  for (const { lexeme, value } of integralNumberCases.accepted) {
    await fs.writeFile(selectedPath, rawNativeWorkspace('2000', lexeme));
    await handlers.importWorkspace();
    assert.equal(imported.at(-1).endpointProfiles[0].createdAt, value);

    await fs.writeFile(selectedPath, rawNativeWorkspace(lexeme, '2000'));
    if (value >= 1 && value <= 50_000) {
      await handlers.importWorkspace();
      assert.equal(imported.at(-1).settings.realtimeFrameLimit, value);
    } else {
      const before = imported.length;
      await assert.rejects(handlers.importWorkspace(), /integer|range/i);
      assert.equal(imported.length, before);
    }
  }

  for (const { lexeme } of integralNumberCases.rejected) {
    for (const source of [
      rawNativeWorkspace('2000', lexeme),
      rawNativeWorkspace(lexeme, '2000'),
    ]) {
      await fs.writeFile(selectedPath, source);
      const before = imported.length;
      await assert.rejects(handlers.importWorkspace(), /integer|safe|range|negative/i);
      assert.equal(imported.length, before);
    }
  }
});

test('workspace import reads only MAX plus one from a no-follow descriptor and closes it', async () => {
  const bytes = Buffer.alloc(MAX_WORKSPACE_BYTES + 1, 0x61);
  let position = 0;
  let closed = 0;
  let openFlags = 0;
  let lstatCalls = 0;
  const handle = {
    stat: async () => ({ isFile: () => true, size: 1 }),
    async read(buffer, offset, length) {
      const count = Math.min(length, 64 * 1024, bytes.length - position);
      bytes.copy(buffer, offset, position, position + count);
      position += count;
      return { bytesRead: count, buffer };
    },
    close: async () => { closed += 1; },
  };
  const handlers = createWorkspaceFileHandlers({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/growing.json'] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    files: {
      lstat: async () => { lstatCalls += 1; throw new Error('must not lstat import path'); },
      open: async (_path, flags) => { openFlags = flags; return handle; },
    },
    database: { importWorkspace: () => { throw new Error('must not mutate'); }, exportWorkspace: () => ({}) },
  });

  await assert.rejects(handlers.importWorkspace(), /10 MiB/);
  assert.notEqual(openFlags & fsConstants.O_NOFOLLOW, 0);
  assert.equal(position, MAX_WORKSPACE_BYTES + 1);
  assert.equal(lstatCalls, 0);
  assert.equal(closed, 1);
});

function rawNativeWorkspace(settingLexeme, timestampLexeme) {
  return `{"schemaVersion":1,"endpointProfiles":[{"id":"raw","name":"Raw","transport":"serial","config":{},"createdAt":${timestampLexeme},"updatedAt":${timestampLexeme}}],"settings":{"realtimeFrameLimit":${settingLexeme}},"sendTemplates":[]}`;
}

test('workspace export replaces atomically and cleans temporary files after write failure', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ineed-workspace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'workspace.json');
  await fs.writeFile(destination, 'old contents');
  const dialog = {
    showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    showOpenDialog: async () => ({ canceled: true }),
  };
  const database = {
    exportWorkspace: () => ({ version: 1, endpointProfiles: [{ id: 'stable' }] }),
    importWorkspace: () => {},
  };
  let handlers = createWorkspaceFileHandlers({ dialog, files: fs, database });
  await handlers.exportWorkspace();
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), {
    schemaVersion: 1,
    endpointProfiles: [{ id: 'stable' }],
  });

  const failingFiles = Object.create(fs);
  failingFiles.rename = async () => { throw new Error('injected rename failure'); };
  handlers = createWorkspaceFileHandlers({ dialog, files: failingFiles, database });
  await assert.rejects(handlers.exportWorkspace(), /injected rename failure/);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')).endpointProfiles, [{ id: 'stable' }]);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);

  await fs.rm(destination);
  await fs.symlink(path.join(directory, 'other.json'), destination);
  await assert.rejects(handlers.exportWorkspace(), /导出位置不安全/);
});


test('unsupported import preserves a real active TCP listener and its database', async (t) => {
  const { TcpService } = require('../electron/tcpService.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linklab-import-listener-'));
  const database = openConfigurationDatabase(path.join(directory, 'data.db'));
  const tcp = new TcpService({ emitEvent: () => {} });
  t.after(async () => { await tcp.shutdown(); database.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const endpoint = { id: 'live', name: 'Live', transport: 'tcp-server', config: {
    listenHost: '127.0.0.1', listenPort: 0,
  } };
  database.insertEndpoint(endpoint);
  await tcp.open(endpoint, { operationId: 'open' });
  const session = tcp.sessions.get('live');
  const before = database.exportWorkspace();
  const invalid = { ...structuredClone(before), schemaVersion: before.version };
  delete invalid.version;
  invalid.endpointProfiles[0].transport = 'unsupported';
  const file = path.join(directory, 'workspace.json');
  await fs.writeFile(file, JSON.stringify(invalid));
  const handlers = createWorkspaceFileHandlers({ database, files: fs,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) } });
  let closes = 0;
  await assert.rejects(handlers.importWorkspace(undefined, async () => { closes += 1; await tcp.shutdown(); }), /transport/i);
  assert.equal(closes, 0);
  assert.equal(tcp.sessions.get('live'), session);
  assert.deepEqual(database.exportWorkspace(), before);
  const socket = net.createConnection({ host: '127.0.0.1', port: session.server.address().port });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.destroy();
});
