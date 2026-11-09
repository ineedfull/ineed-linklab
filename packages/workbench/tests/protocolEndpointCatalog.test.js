import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtocolEndpointCatalog } from '../src/model/protocolEndpointCatalog.js';
import { OPCUA_SERVER_DEFAULT_CONFIG, opcuaExampleNodes } from '../src/model/opcuaSimulatorConfig.js';
import { STOMP_DEFAULT_CONFIG } from '../src/model/stompWorkbench.js';

function fixture() {
  const saved = { stompProfiles: [{ id: 's1', name: 'Existing STOMP', mode: 'client', config: { ...STOMP_DEFAULT_CONFIG }, subscriptions: [] }] };
  let ua = [{ id: 'u1', name: 'Existing UA', config: { endpointUrl: 'opc.tcp://127.0.0.1:4840', securityPolicy: 'None', securityMode: 'None', authentication: 'anonymous', username: '' }, favorites: [] }];
  let servers = [];
  const listeners = new Set(), calls = [];
  let rejectSave = false;
  const runtime = {
    settings: { async getAll() { return structuredClone(saved); }, async save(key, value) { if (rejectSave) throw new Error('disk full'); saved[key] = structuredClone(value); } },
    opcua: {
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async execute(request) {
        calls.push(structuredClone(request));
        if (request.action === 'serverProfiles') return { profiles: structuredClone(servers) };
        if (request.action === 'saveServerProfiles') { if (rejectSave) throw new Error('disk full'); servers = structuredClone(request.profiles); return { profiles: servers }; }
        if (request.action === 'startServer') return { sessionId: `server-${request.connectionId}`, endpointUrl: 'opc.tcp://127.0.0.1:4840/LinkLab', namespaceIndex: 3, nodes: request.nodes.map(n => ({ id: n.id, nodeId: `ns=3;s=${n.id}` })) };
        if (request.action === 'serverSnapshot') return { values: [] };
        if (request.action === 'profiles') return { profiles: structuredClone(ua) };
        if (request.action === 'saveProfiles') { if (rejectSave) throw new Error('disk full'); ua = structuredClone(request.profiles); return { profiles: structuredClone(ua) }; }
        if (request.action === 'connect') return { sessionId: `session-${request.connectionId}` };
        return {};
      },
    },
    stomp: { onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async execute(request) { calls.push(structuredClone(request)); return { sessionId: `session-${request.connectionId}` }; } },
  };
  return { runtime, saved, calls, listeners, failSave() { rejectSave = true; }, get ua() { return ua; } };
}

test('existing profiles project into independent lazy endpoint controllers without connecting', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize(); assert.equal(catalog.endpoints.length, 2); assert.equal(f.listeners.size, 0);
    const ua = catalog.get('protocol:opcua:u1'), stomp = catalog.get('protocol:stomp:s1');
    assert.equal(ua.state.name, 'Existing UA'); assert.equal(stomp.state.name, 'Existing STOMP');
    ua.state.config.password = 'ua-private'; stomp.state.credentials.passcode = 'stomp-private';
    assert.equal(catalog.get('protocol:opcua:u1'), ua);
    assert.equal(stomp.state.credentials.passcode, 'stomp-private');
    assert(!f.calls.some(call => call.action === 'connect' || call.action === 'open'));
    assert(!JSON.stringify(catalog.endpoints).includes('private'));
  } finally { await catalog.dispose(); }
  assert.equal(f.listeners.size, 0);
});

test('concurrent STOMP creates preserve both profiles and the existing profile', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize();
    const results = await Promise.all(['client', 'server'].map(mode => catalog.saveEndpoint({ name: `New ${mode}`, transport: `stomp-${mode}`, config: { ...STOMP_DEFAULT_CONFIG, subscriptions: [], password: 'never-save' } })));
    assert(results.every(result => result.ok)); assert.equal(f.saved.stompProfiles.length, 3);
    assert.deepEqual(new Set(f.saved.stompProfiles.map(row => row.name)), new Set(['Existing STOMP', 'New client', 'New server']));
    assert(!JSON.stringify(f.saved).includes('never-save'));
    assert(results.every(result => catalog.has(result.value.id)));
  } finally { await catalog.dispose(); }
});

test('bound saves merge independent controllers rather than overwriting stale whole lists', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize(); const created = await catalog.saveEndpoint({ name: 'Second', transport: 'stomp-client', config: STOMP_DEFAULT_CONFIG });
    const first = catalog.get('protocol:stomp:s1'), second = catalog.get(created.value.id);
    first.state.name = 'First renamed'; second.state.name = 'Second renamed';
    first.state.credentials.login = 'private-user'; second.state.credentials.passcode = 'private-pass';
    assert((await Promise.all([first.saveProfile(), second.saveProfile()])).every(Boolean));
    assert.deepEqual(new Set(f.saved.stompProfiles.map(row => row.name)), new Set(['First renamed', 'Second renamed']));
    assert(!JSON.stringify(f.saved).includes('private-'));
  } finally { await catalog.dispose(); }
});

test('opening an OPC UA endpoint twice keeps one session and renaming preserves that session', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize(); const id = 'protocol:opcua:u1', api = catalog.get(id);
    await Promise.all([catalog.connect(id), catalog.connect(id)]);
    const session = api.state.sessionId; assert(session);
    await api.connect();
    assert.equal(f.calls.filter(call => call.action === 'connect').length, 1);
    const row = catalog.endpoints.find(row => row.id === id);
    assert((await catalog.saveEndpoint({ ...row, name: 'Renamed while connected' })).ok);
    assert.equal(api.state.sessionId, session); assert.equal(api.state.name, 'Renamed while connected');
    const edited = await catalog.saveEndpoint({ ...row, name: 'Edited', config: { ...row.config, endpointUrl: 'opc.tcp://127.0.0.1:4841' } });
    assert.equal(edited.ok, false); assert.match(edited.error.message, /断开/);
    assert.equal(api.state.sessionId, session);
  } finally { await catalog.dispose(); }
});

test('deleting one connected endpoint closes only its session and preserves the other', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize(); const created = await catalog.saveEndpoint({ name: 'Second UA', transport: 'opcua-client', config: { endpointUrl: 'opc.tcp://127.0.0.1:4841' } });
    const first = catalog.get('protocol:opcua:u1'), second = catalog.get(created.value.id);
    await catalog.connect('protocol:opcua:u1'); await catalog.connect(created.value.id);
    const secondSession = second.state.sessionId;
    assert((await catalog.remove('protocol:opcua:u1')).ok);
    assert(!catalog.has('protocol:opcua:u1')); assert.equal(first.state.sessionId, null);
    assert.equal(second.state.sessionId, secondSession); assert.equal(f.ua.length, 1);
    assert.equal(f.calls.filter(call => call.action === 'disconnect').length, 1);
  } finally { await catalog.dispose(); }
});

test('failed deletion keeps the saved endpoint available with a visible persistence error', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize(); f.failSave();
    const result = await catalog.remove('protocol:opcua:u1'); assert.equal(result.ok, false);
    assert.match(result.error.message, /disk full/); assert(catalog.has('protocol:opcua:u1')); assert.equal(f.ua.length, 1);
    assert.match(catalog.state.error, /disk full/);
  } finally { await catalog.dispose(); }
});

test('OPC UA imports add endpoints, strip passwords and synchronize every bound profile list', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize(); const first = catalog.get('protocol:opcua:u1');
    await first.importProfiles(JSON.stringify([{ ...f.ua[0], id: 'u2', name: 'Imported', config: { ...f.ua[0].config, password: 'import-private' } }]));
    assert.equal(catalog.endpoints.filter(row => row.transport === 'opcua-client').length, 2);
    assert.equal(first.state.profiles.length, 2); assert(!JSON.stringify(f.ua).includes('import-private'));
  } finally { await catalog.dispose(); }
});

test('an edit queued behind deletion cannot resurrect the deleted endpoint', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  let entered, release;
  const saving = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    await catalog.initialize(); const before = catalog.endpoints.find(row => row.id === 'protocol:stomp:s1');
    const save = f.runtime.settings.save;
    f.runtime.settings.save = async (...args) => { entered(); await gate; return save(...args); };
    const deleting = catalog.remove(before.id); await saving;
    const editing = catalog.saveEndpoint({ ...before, name: 'Must not reappear' }); release();
    assert((await deleting).ok); assert.equal((await editing).ok, false);
    assert(!catalog.has(before.id)); assert.equal(f.saved.stompProfiles.length, 0);
  } finally { release(); await catalog.dispose(); }
});

test('an older initialization read cannot hide a concurrently created endpoint', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  let entered, release, first = true;
  const reading = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const getAll = f.runtime.settings.getAll;
  f.runtime.settings.getAll = async () => { const value = await getAll(); if (first) { first = false; entered(); await gate; } return value; };
  try {
    const initializing = catalog.initialize(); await reading;
    const creating = catalog.saveEndpoint({ name: 'Created during load', transport: 'stomp-client', config: STOMP_DEFAULT_CONFIG });
    await new Promise(resolve => setTimeout(resolve, 0)); release();
    await initializing; assert((await creating).ok);
    assert.equal(f.saved.stompProfiles.length, 2);
    assert.equal(catalog.endpoints.filter(row => row.transport.startsWith('stomp-')).length, 2);
  } finally { release(); await catalog.dispose(); }
});

test('a bound panel cannot reconnect while its endpoint deletion is saving', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  let entered, release;
  const saving = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    await catalog.initialize(); const api = catalog.get('protocol:opcua:u1'); await catalog.connect('protocol:opcua:u1');
    const execute = f.runtime.opcua.execute;
    f.runtime.opcua.execute = async request => { if (request.action === 'saveProfiles') { entered(); await gate; } return execute(request); };
    const deleting = catalog.remove('protocol:opcua:u1'); await saving;
    assert.equal(await api.connect(), false); release(); assert((await deleting).ok);
    assert.equal(f.calls.filter(row => row.action === 'connect').length, 1);
  } finally { release(); await catalog.dispose(); }
});

test('an address edit blocks bound and tree opens until the new configuration is applied', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  let entered, release;
  const saving = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    await catalog.initialize(); const id = 'protocol:opcua:u1', api = catalog.get(id), row = catalog.endpoints.find(row => row.id === id);
    const execute = f.runtime.opcua.execute;
    f.runtime.opcua.execute = async request => { if (request.action === 'saveProfiles') { entered(); await gate; } return execute(request); };
    const editing = catalog.saveEndpoint({ ...row, config: { ...row.config, endpointUrl: 'opc.tcp://127.0.0.1:4841' } });
    await saving; assert.equal(await catalog.connect(id), false); assert.equal(await api.connect(), false);
    release(); assert((await editing).ok); await catalog.connect(id);
    assert.equal(f.calls.find(row => row.action === 'connect').config.endpointUrl, 'opc.tcp://127.0.0.1:4841');
  } finally { release(); await catalog.dispose(); }
});

test('import cannot overwrite a busy peer controller and silently leave its configuration stale', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize(); const first = catalog.get('protocol:opcua:u1');
    const created = await catalog.saveEndpoint({ name: 'Importer', transport: 'opcua-client', config: { endpointUrl: 'opc.tcp://127.0.0.1:4842' } });
    const other = catalog.get(created.value.id); first.state.busy = 'discover';
    assert.equal(await other.importProfiles(JSON.stringify([{ ...f.ua[0], config: { ...f.ua[0].config, endpointUrl: 'opc.tcp://127.0.0.1:4850' } }])), false);
    assert.match(other.state.error, /断开|操作/); assert.equal(f.ua[0].config.endpointUrl, 'opc.tcp://127.0.0.1:4840');
    assert.equal(first.state.config.endpointUrl, 'opc.tcp://127.0.0.1:4840');
    first.state.busy = '';
  } finally { await catalog.dispose(); }
});

test('an endpoint first visited during an address save cannot open stale configuration', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  let entered, release;
  const saving = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    await catalog.initialize(); const id = 'protocol:opcua:u1', row = catalog.endpoints.find(row => row.id === id);
    const execute = f.runtime.opcua.execute;
    f.runtime.opcua.execute = async request => { if (request.action === 'saveProfiles') { entered(); await gate; } return execute(request); };
    const editing = catalog.saveEndpoint({ ...row, config: { ...row.config, endpointUrl: 'opc.tcp://127.0.0.1:4841' } });
    await saving; const api = catalog.get(id);
    const opened = await api.connect();
    release(); assert((await editing).ok); assert.equal(opened, false);
    assert.equal(api.state.config.endpointUrl, 'opc.tcp://127.0.0.1:4841');
    await catalog.connect(id);
    assert.equal(f.calls.find(row => row.action === 'connect').config.endpointUrl, 'opc.tcp://127.0.0.1:4841');
  } finally { release(); await catalog.dispose(); }
});

test('queued deletion retains its lock across an earlier edit and disposes a late first visit', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  let edited, deleting, finishEdit, finishDelete, writes = 0;
  const editEntered = new Promise(resolve => { edited = resolve; }), deleteEntered = new Promise(resolve => { deleting = resolve; });
  const editGate = new Promise(resolve => { finishEdit = resolve; }), deleteGate = new Promise(resolve => { finishDelete = resolve; });
  try {
    await catalog.initialize(); const id = 'protocol:opcua:u1', row = catalog.endpoints.find(row => row.id === id);
    const execute = f.runtime.opcua.execute;
    f.runtime.opcua.execute = async request => {
      if (request.action === 'saveProfiles') {
        if (++writes === 1) { edited(); await editGate; } else { deleting(); await deleteGate; }
      }
      return execute(request);
    };
    const editing = catalog.saveEndpoint({ ...row, name: 'Renamed' }); await editEntered;
    const removal = catalog.remove(id); finishEdit(); assert((await editing).ok); await deleteEntered;
    const api = catalog.get(id), opened = await api.connect();
    finishDelete(); assert((await removal).ok);
    assert.equal(opened, false); assert.equal(f.calls.filter(row => row.action === 'connect').length, 0);
    assert.equal(f.listeners.size, 0); assert.equal(catalog.state.instances.size, 0);
  } finally { finishEdit(); finishDelete(); await catalog.dispose(); }
});


test('OPC UA servers have separate profiles and deleting one running simulator preserves its peer and clients', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  try {
    await catalog.initialize();
    const created = await Promise.all([4840, 4841].map(port => catalog.saveEndpoint({ name: `Server ${port}`, transport: 'opcua-server', config: { ...OPCUA_SERVER_DEFAULT_CONFIG, listenPort: port, nodes: opcuaExampleNodes() } })));
    assert(created.every(row => row.ok));
    const [first, second] = created.map(row => catalog.get(row.value.id));
    assert(created.every(row => row.value.id.startsWith('protocol:opcua-server:')));
    assert.equal(await first.connect(), true); assert.equal(await second.connect(), true);
    const session = second.state.sessionId;
    assert((await catalog.remove(created[0].value.id)).ok);
    assert.equal(second.state.sessionId, session); assert.equal(f.ua.length, 1);
    assert.equal(f.calls.filter(r => r.action === 'stopServer').length, 1);
    assert.equal(f.calls.filter(r => r.action === 'disconnect').length, 0);
    assert.equal(catalog.endpoints.filter(r => r.transport === 'opcua-server').length, 1);
    assert.equal(await second.saveProfile(), false);
    await second.disconnect(); second.state.nodes[0].value = 99;
    assert.equal(await second.saveProfile(), true);
    const saved = f.calls.filter(r => r.action === 'saveServerProfiles').at(-1).profiles;
    assert.equal(saved[0].nodes[0].value, 99);
  } finally { await catalog.dispose(); }
});

test('failed native simulator stop aborts deletion without dropping saved profile or controller', async () => {
  const f = fixture(), catalog = createProtocolEndpointCatalog(f.runtime);
  const execute = f.runtime.opcua.execute;
  try {
    await catalog.initialize();
    const created = await catalog.saveEndpoint({ name: 'Server', transport: 'opcua-server', config: OPCUA_SERVER_DEFAULT_CONFIG });
    const id = created.value.id, api = catalog.get(id); await api.connect(); const session = api.state.sessionId;
    f.runtime.opcua.execute = request => request.action === 'stopServer' ? Promise.reject(new Error('native stop failed')) : execute(request);
    const removed = await catalog.remove(id); assert.equal(removed.ok, false); assert.match(removed.error.message, /native stop failed/);
    assert(catalog.has(id)); assert.equal(api.state.sessionId, session);
    f.runtime.opcua.execute = execute; assert((await catalog.remove(id)).ok);
  } finally { f.runtime.opcua.execute = execute; await catalog.dispose(); }
});
