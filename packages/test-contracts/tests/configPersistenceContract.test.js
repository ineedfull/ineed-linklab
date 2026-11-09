import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const databaseModule = path.join(root, 'apps', 'electron', 'electron', 'database.cjs');
const defaultSettings = {
  logLevel: 'info',
  realtimeFrameLimit: 2000,
  realtimeLogLimit: 1000,
  previewByteLimit: 4096,
  defaultFraming: 'none',
  autoScroll: true,
  theme: 'system',
  largeFont: false,
  modbusPointHistoryRetention: '30-days', stompProfiles: [],
  acceptanceWorkspace: '{"version":1,"plans":[],"reports":[]}',
};

const endpoint = {
  id: 'endpoint-stable',
  name: 'Development TCP',
  transport: 'tcp-client',
  config: { host: '127.0.0.1', port: 9000 },
};
const template = {
  id: 'template-stable',
  endpointId: endpoint.id,
  name: 'Ping',
  format: 'hex',
  framing: 'none',
  target: { peerId: 'peer-1' },
  payloadBase64: Buffer.from([0x01, 0xa2]).toString('base64'),
};

test('configuration persistence contract uses real SQLite and preserves typed rows', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database, filename } = await openTemporaryDatabase(t, openConfigurationDatabase);

  assert.equal(path.basename(filename), 'ineed-dev-tool.db');
  assert.equal(database.pragma('journal_mode').toLowerCase(), 'wal');
  assert.equal(database.pragma('synchronous'), 1);
  assert.equal(database.pragma('foreign_keys'), 1);
  assert.deepEqual(database.listEndpoints(), []);

  const inserted = database.insertEndpoint(endpoint);
  assert.equal(inserted.id, endpoint.id);
  assert.equal(Number.isInteger(inserted.createdAt), true);
  assert.deepEqual(database.listEndpoints(), [inserted]);

  const updated = database.updateEndpoint({ ...endpoint, name: 'Updated TCP' });
  assert.equal(updated.id, endpoint.id);
  assert.equal(updated.name, 'Updated TCP');
  assert.equal(updated.createdAt, inserted.createdAt);

  const cloned = database.cloneEndpoint(endpoint.id, {
    id: 'endpoint-clone',
    name: 'Cloned TCP',
  });
  assert.deepEqual(cloned, {
    ...updated,
    id: 'endpoint-clone',
    name: 'Cloned TCP',
    createdAt: cloned.createdAt,
    updatedAt: cloned.updatedAt,
  });
  const clonedWithSourceName = database.cloneEndpoint(endpoint.id, { id: 'endpoint-clone-default' });
  assert.equal(clonedWithSourceName.name, updated.name);
  assert.equal(clonedWithSourceName.transport, updated.transport);
  assert.deepEqual(clonedWithSourceName.config, updated.config);
  for (const overrides of [
    { id: 'bad-transport', transport: 'udp-client' },
    { id: 'bad-config', config: { port: 1 } },
    { id: 'bad-extra', unknown: true },
  ]) {
    assert.throws(() => database.cloneEndpoint(endpoint.id, overrides), /clone overrides/i);
  }

  database.saveSetting('theme', 'dark');
  database.saveSetting('realtimeFrameLimit', 3000);
  database.saveSetting('autoScroll', false);
  assert.deepEqual(database.getSettings(), {
    ...defaultSettings,
    autoScroll: false,
    realtimeFrameLimit: 3000,
    theme: 'dark',
  });

  const savedTemplate = database.saveTemplate(template);
  assert.equal(savedTemplate.id, template.id);
  assert.deepEqual(database.listTemplates(endpoint.id), [savedTemplate]);

  database.deleteEndpoint(endpoint.id);
  assert.deepEqual(database.listTemplates(endpoint.id), []);
  assert.deepEqual(
    database.listEndpoints().map(({ id }) => id),
    ['endpoint-clone', 'endpoint-clone-default'],
  );
});

test('normal saves accept listed rows but validate optional timestamps without trusting them', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  const inserted = database.insertEndpoint(endpoint);
  const savedTemplate = database.saveTemplate(template);

  const endpointRoundTrip = database.saveEndpoint({
    ...database.listEndpoints()[0],
    name: 'Round-trip endpoint',
  });
  assert.equal(endpointRoundTrip.name, 'Round-trip endpoint');
  assert.equal(endpointRoundTrip.createdAt, inserted.createdAt);

  const templateRoundTrip = database.saveTemplate({
    ...database.listTemplates(endpoint.id)[0],
    name: 'Round-trip template',
  });
  assert.equal(templateRoundTrip.name, 'Round-trip template');
  assert.equal(templateRoundTrip.createdAt, savedTemplate.createdAt);

  const endpointWithValidTimestamps = database.saveEndpoint({
    ...endpoint,
    name: 'Valid timestamps',
    createdAt: 0,
    updatedAt: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(endpointWithValidTimestamps.createdAt, inserted.createdAt);
  assert.notEqual(endpointWithValidTimestamps.updatedAt, Number.MAX_SAFE_INTEGER);
  const templateWithValidTimestamps = database.saveTemplate({
    ...template,
    name: 'Valid timestamps',
    createdAt: 0,
    updatedAt: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(templateWithValidTimestamps.createdAt, savedTemplate.createdAt);
  assert.notEqual(templateWithValidTimestamps.updatedAt, Number.MAX_SAFE_INTEGER);

  const beforeInvalid = database.exportWorkspace();
  for (const invalidTimestamp of [null, -0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    for (const field of ['createdAt', 'updatedAt']) {
      assert.throws(
        () => database.saveEndpoint({ ...endpoint, [field]: invalidTimestamp }),
        /timestamp/i,
      );
      assert.throws(
        () => database.saveTemplate({ ...template, [field]: invalidTimestamp }),
        /timestamp/i,
      );
      assert.deepEqual(database.exportWorkspace(), beforeInvalid);
    }
  }

  let timestampProxyTraps = 0;
  const timestampProxy = new Proxy({}, {
    get() { timestampProxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { timestampProxyTraps += 1; return undefined; },
    getPrototypeOf() { timestampProxyTraps += 1; return Object.prototype; },
    ownKeys() { timestampProxyTraps += 1; return []; },
  });
  assert.throws(
    () => database.saveEndpoint({ ...endpoint, createdAt: timestampProxy }),
    /timestamp/i,
  );
  assert.throws(
    () => database.saveTemplate({ ...template, updatedAt: timestampProxy }),
    /timestamp/i,
  );
  assert.equal(timestampProxyTraps, 0);
  assert.deepEqual(database.exportWorkspace(), beforeInvalid);
});

test('workspace export and import share a versioned JSON shape and stable IDs', async (t) => {
  const { openConfigurationDatabase, WORKSPACE_VERSION } = await import(databaseModule);
  const first = await openTemporaryDatabase(t, openConfigurationDatabase, 'first');
  const second = await openTemporaryDatabase(t, openConfigurationDatabase, 'second');

  first.database.insertEndpoint(endpoint);
  first.database.saveSetting('theme', 'dark');
  first.database.saveTemplate(template);

  const exported = first.database.exportWorkspace();
  assert.equal(exported.version, WORKSPACE_VERSION);
  assert.deepEqual(Object.keys(exported), ['version', 'endpointProfiles', 'settings', 'sendTemplates']);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported);
  assert.deepEqual(exported.endpointProfiles.map(({ id }) => id), [endpoint.id]);
  assert.deepEqual(exported.sendTemplates.map(({ id }) => id), [template.id]);
  assert.equal(exported.settings.theme, 'dark');
  assert.equal(Object.hasOwn(exported.settings, 'timeDisplayMode'), false);
  assertNoPasswordLikeKeys(exported);

  second.database.insertEndpoint({
    id: endpoint.id,
    name: 'Old name',
    transport: 'serial',
    config: { path: '/dev/null' },
  });
  second.database.insertEndpoint({
    id: 'unrelated',
    name: 'Unrelated',
    transport: 'udp-server',
    config: { port: 7000 },
  });
  second.database.importWorkspace(exported);

  assert.deepEqual(second.database.exportWorkspace(), {
    ...exported,
    endpointProfiles: [
      exported.endpointProfiles[0],
      second.database.listEndpoints().find(({ id }) => id === 'unrelated'),
    ],
  });
});

test('workspace import drops retired settings while preserving current settings', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  const workspace = database.exportWorkspace();
  workspace.settings = { theme: 'dark', timeDisplayMode: 'iso' };

  const imported = database.importWorkspace(workspace);

  assert.equal(imported.settings.theme, 'dark');
  assert.equal(Object.hasOwn(imported.settings, 'timeDisplayMode'), false);
  assert.deepEqual(database.exportWorkspace().settings, imported.settings);
});

test('failed workspace import rolls back every mutation', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  database.insertEndpoint(endpoint);
  database.saveSetting('theme', 'light');
  const before = database.exportWorkspace();

  const invalidWorkspace = structuredClone(before);
  invalidWorkspace.endpointProfiles[0].name = 'Must roll back';
  invalidWorkspace.settings.theme = 'dark';
  invalidWorkspace.sendTemplates.push({
    ...template,
    id: 'invalid-template',
    endpointId: 'missing-endpoint',
  });

  assert.throws(() => database.importWorkspace(invalidWorkspace));
  assert.deepEqual(database.exportWorkspace(), before);
});

test('workspace import replaces existing template metadata by stable ID', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  database.insertEndpoint(endpoint);
  database.saveTemplate(template);

  const workspace = database.exportWorkspace();
  workspace.sendTemplates[0].name = 'Imported Ping';
  workspace.sendTemplates[0].createdAt = 100;
  workspace.sendTemplates[0].updatedAt = 200;
  database.importWorkspace(workspace);

  assert.deepEqual(database.listTemplates(endpoint.id), workspace.sendTemplates);
});

test('configuration persistence rejects password-like data', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);

  assert.throws(
    () => database.insertEndpoint({ ...endpoint, config: { password: 'unsafe' } }),
    /password-like/i,
  );
  assert.throws(() => database.saveSetting('apiToken', 'unsafe'), /unknown setting/i);

  const migration = await readFile(path.join(
    root,
    'packages',
    'persistence-contract',
    'migrations',
    '001-initial.sql',
  ), 'utf8');
  assert.doesNotMatch(migration, /password|passwd|passphrase|secret|credential|api[_-]?key|token/i);
});

test('settings preserve exact schema value types without coercion', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  database.saveSettings({
    ...defaultSettings,
    logLevel: 'debug',
    realtimeFrameLimit: 12,
    autoScroll: false,
    largeFont: true,
  });

  assert.deepEqual(database.getSettings(), {
    ...defaultSettings,
    logLevel: 'debug',
    realtimeFrameLimit: 12,
    autoScroll: false,
    largeFont: true,
  });
});

test('JSON configuration rejects values that cannot round-trip exactly', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  const sparse = [];
  sparse[1] = 'value';
  const cyclic = {};
  cyclic.self = cyclic;
  const invalidValues = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    1n,
    Symbol('value'),
    () => {},
    new Date(0),
    new (class CustomValue {})(),
    Object.create({ inherited: true }),
    cyclic,
    sparse,
    [undefined],
    { nested: undefined },
    { nested: Number.NaN },
    { nested: 1n },
    { nested: new Date(0) },
  ];

  for (const [index, value] of invalidValues.entries()) {
    assert.throws(
      () => database.insertEndpoint({
        ...endpoint,
        id: `invalid-json-${index}`,
        config: { value },
      }),
      /valid JSON/i,
    );
  }
  assert.deepEqual(database.listEndpoints(), []);
});

test('all JSON fields reject proxies, accessors, and unsupported nested values without execution', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  database.insertEndpoint(endpoint);

  let accessorReads = 0;
  const accessorArray = [];
  Object.defineProperty(accessorArray, 0, {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'unsafe';
    },
  });
  accessorArray.length = 1;
  assert.throws(
    () => database.insertEndpoint({ ...endpoint, id: 'accessor-json', config: { value: accessorArray } }),
    /valid JSON/i,
  );
  assert.equal(accessorReads, 0);

  let proxyTraps = 0;
  const proxy = new Proxy({}, {
    get() { proxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });
  assert.throws(
    () => database.insertEndpoint({ ...endpoint, id: 'proxy-endpoint', config: proxy }),
    /valid JSON object/i,
  );
  assert.equal(proxyTraps, 0);

  for (const config of [null, [], 'serial', 4, true]) {
    assert.throws(
      () => database.insertEndpoint({ ...endpoint, id: 'invalid-config-shape', config }),
      /config must be a valid JSON object/i,
    );
  }

  const invalidNestedValues = [
    undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, Symbol('x'), () => {},
    new Date(0), new (class CustomValue {})(), accessorArray,
  ];
  for (const value of invalidNestedValues) {
    assert.throws(
      () => database.insertEndpoint({ ...endpoint, id: 'invalid-config', config: { value } }),
      /valid JSON/i,
    );
    assert.throws(
      () => database.saveTemplate({ ...template, id: 'invalid-target', target: { value } }),
      /valid JSON/i,
    );
  }
  for (const target of [undefined, [], 'peer', 4, true]) {
    assert.throws(
      () => database.saveTemplate({ ...template, id: 'invalid-target-shape', target }),
      /target must be a valid JSON object or null/i,
    );
  }
  assert.throws(
    () => database.saveTemplate({ ...template, id: 'proxy-target', target: proxy }),
    /valid JSON object or null/i,
  );
  assert.equal(proxyTraps, 0);
});

test('database input wrappers are snapshotted without invoking proxies or accessors', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);

  let endpointProxyTraps = 0;
  const endpointProxy = new Proxy(endpoint, {
    get() { endpointProxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { endpointProxyTraps += 1; return undefined; },
    getPrototypeOf() { endpointProxyTraps += 1; return Object.prototype; },
    ownKeys() { endpointProxyTraps += 1; return []; },
  });
  assert.throws(() => database.insertEndpoint(endpointProxy), /endpoint profile.*proxy/i);
  assert.equal(endpointProxyTraps, 0);

  let configReads = 0;
  const accessorEndpoint = { id: 'accessor-endpoint', name: 'Accessor', transport: 'tcp-client' };
  Object.defineProperty(accessorEndpoint, 'config', {
    enumerable: true,
    get() { configReads += 1; return {}; },
  });
  assert.throws(() => database.saveEndpoint(accessorEndpoint), /endpoint profile.*data propert/i);
  assert.equal(configReads, 0);

  let stringFieldProxyTraps = 0;
  const stringFieldProxy = new Proxy({}, {
    get() { stringFieldProxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { stringFieldProxyTraps += 1; return undefined; },
    getPrototypeOf() { stringFieldProxyTraps += 1; return Object.prototype; },
    ownKeys() { stringFieldProxyTraps += 1; return []; },
  });
  assert.throws(
    () => database.insertEndpoint({ ...endpoint, id: stringFieldProxy }),
    /id must be a nonblank string/i,
  );
  assert.equal(stringFieldProxyTraps, 0);

  database.insertEndpoint(endpoint);
  let targetReads = 0;
  const accessorTemplate = { ...template };
  Object.defineProperty(accessorTemplate, 'target', {
    enumerable: true,
    get() { targetReads += 1; return null; },
  });
  assert.throws(() => database.saveTemplate(accessorTemplate), /send template.*data propert/i);
  assert.equal(targetReads, 0);

  let cloneProxyTraps = 0;
  const cloneProxy = new Proxy({ id: 'proxy-clone' }, {
    get() { cloneProxyTraps += 1; return undefined; },
    getOwnPropertyDescriptor() { cloneProxyTraps += 1; return undefined; },
    getPrototypeOf() { cloneProxyTraps += 1; return Object.prototype; },
    ownKeys() { cloneProxyTraps += 1; return []; },
  });
  assert.throws(() => database.cloneEndpoint(endpoint.id, cloneProxy), /clone overrides.*proxy/i);
  assert.equal(cloneProxyTraps, 0);

  let cloneNameReads = 0;
  const cloneAccessor = { id: 'accessor-clone' };
  Object.defineProperty(cloneAccessor, 'name', {
    enumerable: true,
    get() { cloneNameReads += 1; return 'Unsafe'; },
  });
  assert.throws(() => database.cloneEndpoint(endpoint.id, cloneAccessor), /clone overrides.*data propert/i);
  assert.equal(cloneNameReads, 0);

  const workspace = database.exportWorkspace();
  let workspaceReads = 0;
  Object.defineProperty(workspace, 'endpointProfiles', {
    enumerable: true,
    get() { workspaceReads += 1; return []; },
  });
  assert.throws(() => database.importWorkspace(workspace), /workspace.*data propert/i);
  assert.equal(workspaceReads, 0);
});

test('database input wrappers reject unknown keys and clone null names', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  database.insertEndpoint(endpoint);

  assert.throws(
    () => database.insertEndpoint({ ...endpoint, unexpected: true }),
    /endpoint profile.*unknown.*unexpected/i,
  );
  assert.throws(
    () => database.saveTemplate({ ...template, unexpected: true }),
    /send template.*unknown.*unexpected/i,
  );
  assert.throws(
    () => database.importWorkspace({ ...database.exportWorkspace(), unexpected: true }),
    /workspace.*unknown.*unexpected/i,
  );
  assert.throws(
    () => database.cloneEndpoint(endpoint.id, { id: 'null-name-clone', name: null }),
    /clone overrides\.name.*nonblank string/i,
  );
  assert.equal(
    database.cloneEndpoint(endpoint.id, { id: 'omitted-name-clone' }).name,
    endpoint.name,
  );
});

test('workspace import rejects unsafe endpoint and template timestamps without mutation', async (t) => {
  const { openConfigurationDatabase } = await import(databaseModule);
  const { database } = await openTemporaryDatabase(t, openConfigurationDatabase);
  database.insertEndpoint(endpoint);
  database.saveTemplate(template);
  database.saveSetting('theme', 'light');
  const before = database.exportWorkspace();
  const timestampFields = [
    ['endpointProfiles', 'createdAt'],
    ['endpointProfiles', 'updatedAt'],
    ['sendTemplates', 'createdAt'],
    ['sendTemplates', 'updatedAt'],
  ];

  for (const invalidTimestamp of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    for (const [collection, field] of timestampFields) {
      const invalid = structuredClone(before);
      invalid.settings.theme = 'dark';
      invalid[collection][0][field] = invalidTimestamp;
      assert.throws(() => database.importWorkspace(invalid), /timestamp/i);
      assert.deepEqual(database.exportWorkspace(), before);
    }
  }

  for (const [collection, field] of timestampFields) {
    const invalid = structuredClone(before);
    invalid.settings.theme = 'dark';
    delete invalid[collection][0][field];
    assert.throws(() => database.importWorkspace(invalid), /timestamp/i);
    assert.deepEqual(database.exportWorkspace(), before);
  }

  const boundaryWorkspace = structuredClone(before);
  boundaryWorkspace.endpointProfiles[0].createdAt = 0;
  boundaryWorkspace.endpointProfiles[0].updatedAt = Number.MAX_SAFE_INTEGER;
  boundaryWorkspace.sendTemplates[0].createdAt = 0;
  boundaryWorkspace.sendTemplates[0].updatedAt = Number.MAX_SAFE_INTEGER;
  database.importWorkspace(boundaryWorkspace);
  assert.deepEqual(database.exportWorkspace(), boundaryWorkspace);
});

async function openTemporaryDatabase(t, openConfigurationDatabase, suffix = '') {
  const directory = await mkdtemp(path.join(os.tmpdir(), `ineed-config-${suffix}`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'ineed-dev-tool.db');
  const database = openConfigurationDatabase(filename);
  t.after(() => database.close());
  return { database, filename };
}

function assertNoPasswordLikeKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPasswordLikeKeys(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /password|passwd|passphrase|secret|credential|api[_-]?key|token/i);
    assertNoPasswordLikeKeys(child);
  }
}
