import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Electron database applies all migrations exactly once to the application filename', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ineed-electron-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'ineed-dev-tool.db');
  const { openConfigurationDatabase } = await import(path.join(packageRoot, 'electron', 'database.cjs'));

  const first = openConfigurationDatabase(filename);
  first.close();
  const second = openConfigurationDatabase(filename);
  t.after(() => second.close());

  assert.deepEqual(second.appliedMigrations(), [
    { version: 1, name: '001-initial' },
    { version: 2, name: '002-modbus-endpoints' },
    { version: 3, name: '003-modbus-point-history' },
    { version: 4, name: '004-dlt645-endpoints' },
    { version: 5, name: '005-dlt645-simulator-endpoints' },
    { version: 6, name: '006-websocket-endpoints' },
  ]);
});

test('Electron rejects malformed migration ledgers before preparing repositories', async (t) => {
  const { openConfigurationDatabase } = await import(path.join(packageRoot, 'electron', 'database.cjs'));
  const cases = [
    { name: 'empty', rows: [] },
    { name: 'wrong-name', rows: [[1, 'wrong-name']] },
    { name: 'unknown-ahead', rows: [[5, '005-unknown']] },
    {
      name: 'incomplete-schema',
      rows: [[1, '001-initial'], [2, '002-modbus-endpoints']],
    },
  ];

  for (const fixture of cases) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `ineed-electron-ledger-${fixture.name}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'ineed-dev-tool.db');
    const raw = new DatabaseSync(filename);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const insert = raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 1)');
    for (const [version, name] of fixture.rows) insert.run(version, name);
    raw.close();

    assert.throws(() => openConfigurationDatabase(filename), /migration (ledger|schema)/i, fixture.name);
  }
});

test('Electron upgrades a version 2 database without changing existing rows', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ineed-electron-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'ineed-dev-tool.db');
  const raw = new DatabaseSync(filename);
  raw.exec(await readFile(path.join(
    packageRoot, '..', '..', 'packages', 'persistence-contract', 'migrations', '001-initial.sql',
  ), 'utf8'));
  raw.exec(`
    INSERT INTO endpoint_profiles
      (id, name, transport, config_json, created_at, updated_at)
    VALUES ('legacy', 'Legacy', 'tcp-client', '{"preserve":true}', 10, 11)
  `);
  raw.exec(await readFile(path.join(
    packageRoot, '..', '..', 'packages', 'persistence-contract', 'migrations',
    '002-modbus-endpoints.sql',
  ), 'utf8'));
  raw.close();

  const { openConfigurationDatabase } = await import(path.join(packageRoot, 'electron', 'database.cjs'));
  const database = openConfigurationDatabase(filename);
  t.after(() => database.close());

  assert.deepEqual(database.appliedMigrations(), [
    { version: 1, name: '001-initial' },
    { version: 2, name: '002-modbus-endpoints' },
    { version: 3, name: '003-modbus-point-history' },
    { version: 4, name: '004-dlt645-endpoints' },
    { version: 5, name: '005-dlt645-simulator-endpoints' },
    { version: 6, name: '006-websocket-endpoints' },
  ]);
  assert.deepEqual(database.listEndpoints(), [{
    id: 'legacy', name: 'Legacy', transport: 'tcp-client', config: { preserve: true },
    createdAt: 10, updatedAt: 11,
  }]);
});

test('Electron endpoint deletion closes transport before cascading persistence', async () => {
  const mainSource = await readFile(path.join(packageRoot, 'electron', 'main.cjs'), 'utf8');
  const mainExports = executeCommonJs(mainSource);
  assert.equal(typeof mainExports.createPersistenceHandlers, 'function');

  const calls = [];
  const handlers = mainExports.createPersistenceHandlers({
    database: {
      cloneEndpoint(sourceId, overrides) {
        calls.push(['clone', sourceId, overrides]);
        return { id: overrides.id, name: overrides.name };
      },
      deleteEndpoint(id) {
        calls.push(['delete', id]);
        return true;
      },
    },
    transportCoordinator: {
      async closeEndpoint(id) {
        calls.push(['close', id]);
      },
    },
  });

  assert.deepEqual(
    handlers['endpoint.clone']('endpoint-1', { id: 'endpoint-2', name: 'Clone' }),
    { id: 'endpoint-2', name: 'Clone' },
  );
  assert.equal(await handlers['endpoint.delete']('endpoint-1'), true);
  assert.deepEqual(calls, [
    ['clone', 'endpoint-1', { id: 'endpoint-2', name: 'Clone' }],
    ['close', 'endpoint-1'],
    ['delete', 'endpoint-1'],
  ]);
});

function executeCommonJs(source) {
  const module = { exports: {} };
  const sandbox = {
    URL,
    module,
    exports: module.exports,
    process: { env: {}, platform: 'darwin' },
    require(specifier) {
      if (specifier === './legacyUserData.cjs') return createRequire(import.meta.url)('../electron/legacyUserData.cjs');
      if (specifier === 'electron') {
        return {
          app: { isPackaged: true, on() {}, whenReady: () => new Promise(() => {}) },
          BrowserWindow: class {},
          ipcMain: { handle() {}, removeHandler() {} },
        };
      }
      if (specifier === 'node:path') return path;
      if (specifier === 'node:url') return { pathToFileURL: (value) => new URL(`file://${value}`) };
      if (specifier === './database.cjs') return {};
      throw new Error(`Unexpected require: ${specifier}`);
    },
    __dirname: path.join(packageRoot, 'electron'),
    __filename: path.join(packageRoot, 'electron', 'main.cjs'),
  };
  vm.runInNewContext(`(function (exports, require, module, __filename, __dirname) {${source}\n})`)(
    sandbox.exports,
    sandbox.require,
    sandbox.module,
    sandbox.__filename,
    sandbox.__dirname,
  );
  return module.exports;
}

test('STOMP safe profiles roundtrip SQLite and reject native credential injection atomically', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linklab-stomp-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'ineed-dev-tool.db');
  const { openConfigurationDatabase } = await import(path.join(packageRoot, 'electron', 'database.cjs'));
  const profiles = JSON.parse(await readFile(path.join(packageRoot, '../../packages/runtime-contract/tests/stompProfileFixture.json'), 'utf8'));
  let database = openConfigurationDatabase(filename);
  database.saveSetting('theme', 'dark');
  assert.deepEqual(database.getSettings().stompProfiles, []);
  database.getSettings().stompProfiles.push({ injected: true });
  assert.deepEqual(database.getSettings().stompProfiles, []);
  assert.deepEqual(database.saveSetting('stompProfiles', profiles), profiles);
  const before = database.exportWorkspace();
  const invalid = [null, {}, new Array(51).fill(profiles[0]), [profiles[0], profiles[0]],
    [{ ...profiles[0], subscriptions: new Array(101).fill(profiles[0].subscriptions[0]) }],
    [{ ...profiles[0], subscriptions: [profiles[0].subscriptions[0], profiles[0].subscriptions[0]] }],
    [{ ...profiles[0], config: {} }], [{ ...profiles[0], mode: 'broker' }]];
  for (const [location, key, value] of [
    [[], 'login', 'private-login'], [[], 'credentials', { passcode: 'private-password' }],
    [['config'], 'headers', [{ name: 'Authorization', value: 'private-header' }]],
    [['config'], 'passcode', 'private-password'], [['config'], 'futureOption', true],
    [['config'], 'url', 'ws://user:private-password@localhost/'], [['config'], 'url', 'ws://localhost/?token=private-password'],
    [['config'], 'url', 'ws://localhost/#private-password'], [['config'], 'url', `ws://localhost/${'a'.repeat(4096)}`],
    [['config'], 'heartbeatOutgoing', 999], [['config'], 'listenPort', 0], [['config'], 'autoReconnect', 'true'],
    [['subscriptions', 0], 'headers', []], [['subscriptions', 0], 'ack', 'invalid'], [['subscriptions', 0], 'destination', 'bad\0destination'],
  ]) { const profile = structuredClone(profiles[0]); let object = profile; for (const part of location) object = object[part]; object[key] = value; invalid.push([profile]); }
  for (const value of invalid) {
    assert.throws(() => database.saveSetting('stompProfiles', value), /stomp|profile/i);
    assert.throws(() => database.saveSettings({ theme: 'light', stompProfiles: value }), /stomp|profile/i);
    assert.throws(() => database.importWorkspace({ ...before, settings: { ...before.settings, stompProfiles: value } }));
    assert.deepEqual(database.exportWorkspace(), before);
  }
  database.close(); database = openConfigurationDatabase(filename);
  assert.deepEqual(database.getSettings().stompProfiles, profiles); assert.equal(database.getSettings().theme, 'dark');
  assert.deepEqual(database.exportWorkspace().settings.stompProfiles, profiles);
  database.close();
  const raw = new DatabaseSync(filename);
  assert(!JSON.stringify(raw.prepare('SELECT key, value FROM settings').all()).includes('private-'));
  raw.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify([{ login: 'private-legacy' }]), 'stompProfiles'); raw.close();
  database = openConfigurationDatabase(filename);
  assert.deepEqual(database.getSettings().stompProfiles, []);
  assert.deepEqual(database.exportWorkspace().settings.stompProfiles, []);
  database.saveSettings({ theme: 'dark' }); database.close();
  const repaired = new DatabaseSync(filename);
  assert(!JSON.stringify(repaired.prepare('SELECT key, value FROM settings').all()).includes('private-'));
  repaired.prepare('DELETE FROM settings WHERE key = ?').run('stompProfiles'); repaired.close();
  database = openConfigurationDatabase(filename);
  assert.deepEqual(database.getSettings().stompProfiles, []); assert.equal(database.getSettings().theme, 'dark');
  database.close();
});
