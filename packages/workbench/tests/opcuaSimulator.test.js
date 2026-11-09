import assert from 'node:assert/strict';
import test from 'node:test';
import { OPCUA_SERVER_DEFAULT_CONFIG, opcuaExampleNodes, safeOpcuaServerConfig, safeOpcuaServerNodes, safeOpcuaServerProfiles, parseSimulatorValue } from '../src/model/opcuaSimulatorConfig.js';
import { createOpcuaSimulator } from '../src/model/opcuaSimulator.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const calls = [], timers = new Map(), listeners = new Set(); let tick = 0;
  const runtime = { opcua: {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async execute(request) {
      calls.push(structuredClone(request));
      if (request.action === 'serverProfiles') return { profiles: [] };
      if (request.action === 'startServer') return { sessionId: `s${++tick}`, namespaceIndex: 5, endpointUrl: 'opc.tcp://127.0.0.1:4840/LinkLab', nodes: request.nodes.map(n => ({ id: n.id, nodeId: `ns=5;s=${n.id}` })) };
      if (request.action === 'serverSnapshot') return { values: [{ nodeId: 'ns=5;s=Temperature', value: 80, dataType: 'Double', arrayType: 'Scalar', statusCode: 'Good', sourceTimestamp: '2026-10-22T00:00:00.000Z' }] };
      return {};
    },
  } };
  const api = createOpcuaSimulator(runtime, { schedule: fn => { const id = ++tick; timers.set(id, fn); return id; }, cancel: id => timers.delete(id) });
  async function next() { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); }
  return { api, runtime, calls, timers, listeners, next };
}

test('simulator validates config, bounded node values and profile whitelist', () => {
  assert.deepEqual(safeOpcuaServerConfig(OPCUA_SERVER_DEFAULT_CONFIG), OPCUA_SERVER_DEFAULT_CONFIG);
  for (const config of [{ listenPort: 0 }, { listenHost: 'example.com' }, { path: '/bad?' }, { namespaceUri: 'xxx' }, ...['http://opcfoundation.org/UA/', 'urn:ineedfull:linklab:simulator:server', 'urn:ineedfull:linklab:opcua:simulator'].map(namespaceUri => ({ namespaceUri }))]) assert.throws(() => safeOpcuaServerConfig({ ...OPCUA_SERVER_DEFAULT_CONFIG, ...config }));
  const nodes = opcuaExampleNodes(); assert.equal(safeOpcuaServerNodes(nodes).length, nodes.length);
  for (const bad of [[], [...nodes, nodes[0]], Array(101).fill(nodes[0]), [{ ...nodes[0], value: Infinity }], [{ ...nodes[0], dataType: 'UInt64', value: 42 }], [{ ...nodes[0], dataType: 'ByteString', value: 'bad!' }], [{ ...nodes[0], dataType: 'ByteString', value: 'Zh==' }], [{ ...nodes[0], dataType: 'DateTime', value: '1500-01-01T00:00:00Z' }], [{ ...nodes[0], dataType: 'DateTime', value: '2026-02-30T00:00:00Z' }], [{ ...nodes[0], arrayType: 'Array', value: Array(101).fill(0) }]]) assert.throws(() => safeOpcuaServerNodes(bad));
  assert.equal(parseSimulatorValue('UInt64', 'Scalar', '18446744073709551615'), '18446744073709551615');
  assert.throws(() => parseSimulatorValue('UInt64', 'Scalar', '18446744073709551616'));
  assert.throws(() => safeOpcuaServerNodes([{ ...nodes[0], simulation: { mode: 'increment', intervalMs: 100, min: 1, max: 0, step: 1 } }]));
  const profile = safeOpcuaServerProfiles([{ id: 'test', name: ' Test ', config: { ...OPCUA_SERVER_DEFAULT_CONFIG, secret: true }, nodes, unknown: true }])[0];
  assert.equal(profile.name, 'Test'); assert(!('unknown' in profile)); assert(!('secret' in profile.config));
});

test('simulator rejects malformed simulation objects while omitted configuration keeps defaults', () => {
  const node = { ...opcuaExampleNodes()[0] }; delete node.simulation;
  const expected = { mode: 'manual', intervalMs: 1000, min: 0, max: 100, step: 1 };
  assert.deepEqual(safeOpcuaServerNodes([node])[0].simulation, expected);
  assert.deepEqual(safeOpcuaServerNodes([{ ...node, simulation: {} }])[0].simulation, expected);
  for (const simulation of [null, [], 'manual', 0, false]) assert.throws(() => safeOpcuaServerNodes([{ ...node, simulation }]), /变化|simulation/);
});

test('manual and toggle simulation parameters must remain finite numbers in portable profiles', () => {
  for (const mode of ['manual', 'toggle']) {
    const node = { ...opcuaExampleNodes()[1], simulation: { mode } };
    for (const key of ['min', 'max', 'step']) {
      for (const value of ['bad', {}, [], null, false, Infinity, NaN]) {
        assert.throws(() => safeOpcuaServerNodes([{ ...node, simulation: { mode, [key]: value } }]), /变化|simulation/);
      }
    }
    const accepted = safeOpcuaServerNodes([{ ...node, simulation: { mode, min: -1.5, max: 9.5, step: 0 } }]);
    assert.equal(accepted[0].simulation.step, 0, 'unused finite parameters do not inherit increment constraints');
  }
});

test('runtime snapshots never mutate initial nodes; values use actual returned namespace', async () => {
  const f = fixture(); try {
    const initial = structuredClone(f.api.state.nodes);
    assert.equal(await f.api.connect(), true); assert.equal(f.api.state.status, 'listening');
    assert.equal(f.api.state.nodeIds.Temperature, 'ns=5;s=Temperature'); assert.equal(f.timers.size, 1);
    assert.equal(f.api.state.values['ns=5;s=Temperature'].value, 80); assert.deepEqual(f.api.state.nodes, initial);
    await f.api.setValue('Temperature', '27.5');
    assert.equal(f.calls.find(r => r.action === 'setServerValue').value, 27.5);
    assert.deepEqual(f.api.state.nodes, initial);
    await f.api.disconnect(); assert.equal(f.timers.size, 0);
  } finally { await f.api.dispose(); } assert.equal(f.listeners.size, 0);
});

test('snapshot polling is serial and ignores a late snapshot after stop', async () => {
  const f = fixture(); try {
    await f.api.connect(); const gate = deferred(), execute = f.runtime.opcua.execute;
    f.runtime.opcua.execute = request => request.action === 'serverSnapshot' ? gate.promise : execute(request);
    const pending = f.next(); assert.equal(f.timers.size, 0);
    await f.api.disconnect(); gate.resolve({ values: [{ nodeId: 'late', value: 1 }] }); await pending;
    assert.equal(f.api.state.values.late, undefined); assert.equal(f.timers.size, 0);
  } finally { await f.api.dispose(); }
});

test('cancelling a pending start closes its late session and cannot resurrect polling', async () => {
  const f = fixture(), gate = deferred(), execute = f.runtime.opcua.execute;
  f.runtime.opcua.execute = request => request.action === 'startServer' ? gate.promise : execute(request);
  try {
    const starting = f.api.connect(); assert.equal(f.api.state.status, 'connecting');
    await f.api.disconnect(); gate.resolve({ sessionId: 'late', endpointUrl: 'opc.tcp://127.0.0.1:4840', namespaceIndex: 2, nodes: [] });
    assert.equal(await starting, false); assert.equal(f.api.state.sessionId, null); assert.equal(f.timers.size, 0);
    assert(f.calls.some(row => row.action === 'stopServer' && row.sessionId === 'late'));
  } finally { await f.api.dispose(); }
});

test('running structure is locked, errors remain visible and profile import is validated before write', async () => {
  const f = fixture(); try {
    await f.api.connect(); const before = structuredClone(f.api.state.nodes);
    assert.equal(f.api.loadExamples(), false); assert.deepEqual(f.api.state.nodes, before);
    assert.equal(await f.api.importProfiles('[]'), false);
    await f.api.disconnect();
    assert.equal(await f.api.importProfiles('[{}]'), false);
    assert(!f.calls.some(r => r.action === 'saveServerProfiles'));
    const execute = f.runtime.opcua.execute;
    f.runtime.opcua.execute = request => request.action === 'startServer' ? Promise.reject(new Error('port in use')) : execute(request);
    assert.equal(await f.api.connect(), false); assert.match(f.api.state.error, /port in use/); assert.equal(f.api.state.status, 'error');
  } finally { await f.api.dispose(); }
});


test('tree start applies shared initial-value drafts and rejects invalid drafts before native start', async () => {
  const f = fixture(); try {
    f.api.state.nodes[0].initialText = 'bad';
    assert.equal(await f.api.connect(), false); assert(!f.calls.some(r => r.action === 'startServer'));
    f.api.state.nodes[0].initialText = '35.5';
    assert.equal(await f.api.connect(), true);
    const nodes = f.calls.find(r => r.action === 'startServer').nodes;
    assert.equal(nodes[0].value, 35.5); assert(!('initialText' in nodes[0]));
  } finally { await f.api.dispose(); }
});

test('failed native stop retains retry identity and running configuration lock', async () => {
  const f = fixture(); try {
    await f.api.connect(); const session = f.api.state.sessionId, execute = f.runtime.opcua.execute;
    f.runtime.opcua.execute = request => request.action === 'stopServer' ? Promise.reject(new Error('stop failed')) : execute(request);
    assert.equal(await f.api.disconnect(), false); assert.equal(f.api.state.sessionId, session);
    assert.equal(f.api.state.status, 'listening'); assert.equal(f.api.loadExamples(), false);
    f.runtime.opcua.execute = execute; assert.equal(await f.api.disconnect(), true); assert.equal(f.api.state.sessionId, null);
  } finally { await f.api.dispose(); }
});

test('abnormal server event keeps native identity until cleanup is confirmed', async () => {
  const f = fixture(), execute = f.runtime.opcua.execute; try {
    await f.api.connect(); const sessionId = f.api.state.sessionId, connectionId = f.api.state.connectionId;
    for (const listener of f.listeners) listener({ type: 'serverStatus', connectionId, sessionId, status: 'error', message: 'listener failure' });
    assert.equal(f.api.state.sessionId, sessionId); assert.equal(f.api.state.status, 'error'); assert.equal(f.timers.size, 0);
    f.runtime.opcua.execute = request => request.action === 'stopServer' ? Promise.reject(new Error('cleanup failed')) : execute(request);
    assert.equal(await f.api.disconnect(), false); assert.equal(f.api.state.sessionId, sessionId);
    f.runtime.opcua.execute = execute; assert.equal(await f.api.disconnect(), true);
    assert(f.calls.some(r => r.action === 'stopServer' && r.sessionId === sessionId));
    assert.equal(f.api.state.sessionId, null);
  } finally { f.runtime.opcua.execute = execute; await f.api.dispose(); }
});
