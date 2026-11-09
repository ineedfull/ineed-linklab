import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { OpcuaService } = require('../electron/opcuaService.cjs');
const ua = require('node-opcua');
const node = (id, dataType = 'Double', value = 23.5, extra = {}) => ({ id, name: id, dataType, arrayType: 'Scalar', value, writable: true, simulation: { mode: 'manual', intervalMs: 1000, min: 0, max: 100, step: 1 }, ...extra });
async function freePort() { const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port; }
async function setup(t) { const directory = await mkdtemp(join(tmpdir(), 'linklab-simulator-')); const events = []; const service = new OpcuaService({ directory, emitEvent: event => events.push(event) }); t.after(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); }); return { directory, service, events }; }
async function start(service, id, nodes = [node('Temperature')], port) { return service.execute({ action: 'startServer', connectionId: id, config: { listenPort: port ?? await freePort() }, nodes }); }
const request = (service, action, id, sessionId, extra = {}) => service.execute({ action, connectionId: id, sessionId, ...extra });

test('simulator configuration persists separately and invalid imports preserve the previous file', async t => {
  const { service, directory } = await setup(t);
  await service.execute({ action: 'saveProfiles', profiles: [{ id: 'client', name: 'Client', config: { endpointUrl: 'opc.tcp://127.0.0.1:4840' } }] });
  const profile = { id: 'sim', name: 'Server', config: {}, nodes: [node('Temperature')], runtimeSecret: 'drop' };
  const saved = await service.execute({ action: 'saveServerProfiles', profiles: [profile] });
  assert.equal(saved.profiles[0].runtimeSecret, undefined); assert.equal(saved.profiles[0].config.listenHost, '127.0.0.1');
  assert.equal((await service.execute({ action: 'serverProfiles' })).profiles[0].nodes[0].value, 23.5);
  assert.equal(JSON.parse(await readFile(join(directory, 'server-profiles.json'), 'utf8'))[0].id, 'sim');
  assert.equal((await service.execute({ action: 'profiles' })).profiles[0].id, 'client');
  await assert.rejects(service.execute({ action: 'saveServerProfiles', profiles: [{ ...profile, nodes: [node('Bad', 'UInt16', -1)] }] }));
  assert.equal((await service.execute({ action: 'serverProfiles' })).profiles[0].id, 'sim');
  await assert.rejects(service.execute({ action: 'saveServerProfiles', profiles: Array.from({ length: 51 }, (_, i) => ({ ...profile, id: `p${i}` })) }));
  const large = Array.from({ length: 50 }, (_, i) => ({ ...profile, id: `p${i}`, nodes: Array.from({ length: 10 }, (_, j) => node(`n${j}`, 'String', 'x'.repeat(4096))) }));
  await assert.rejects(service.execute({ action: 'saveServerProfiles', profiles: large }), /1 MiB|过大/);
  assert.equal((await service.execute({ action: 'serverProfiles' })).profiles[0].id, 'sim');
  await writeFile(join(directory, 'server-profiles.json'), ' '.repeat(1048577));
  await assert.rejects(service.execute({ action: 'serverProfiles' }), /1 MiB|过大/);
});

test('native simulator rejects malformed structures, types and simulation bounds before listening', async t => {
  const { service } = await setup(t); const base = { action: 'startServer', connectionId: 'bad', config: {}, nodes: [node('Temperature')] };
  const bad = [
    { config: { listenHost: 'example.com' } }, { config: { listenPort: 0 } }, { config: { listenPort: 1.5 } }, { config: { path: '/../bad' } }, { config: { namespaceUri: 'bad' } },
    { nodes: [] }, { nodes: Array.from({ length: 101 }, (_, i) => node(`n${i}`)) }, { nodes: [node('same'), node('same')] }, { nodes: [node('../bad')] }, { nodes: [node('a', 'Double', 1, { arrayType: undefined })] },
    { nodes: [node('a', 'Int16', 32768)] }, { nodes: [node('a', 'Int64', 10)] }, { nodes: [node('a', 'UInt64', '18446744073709551616')] },
    { nodes: [node('a', 'Boolean', 'true')] }, { nodes: [node('a', 'String', 'x'.repeat(4097))] }, { nodes: [node('a', 'ByteString', '%%%')] }, { nodes: [node('a', 'DateTime', '2026-02-30T00:00:00Z')] },
    { nodes: [node('a', 'Double', Infinity)] }, { nodes: [node('a', 'Float', 1e39)] }, { nodes: [node('a', 'Double', Array(101).fill(1), { arrayType: 'Array' })] },
    { nodes: [node('a', 'Double', 1, { writable: 'true' })] }, { nodes: [node('a', 'String', 'x', { simulation: { mode: 'toggle' } })] },
    { nodes: [node('a', 'Double', 1, { simulation: { mode: 'increment', intervalMs: 99, min: 0, max: 2, step: 1 } })] },
    { nodes: [node('a', 'Int16', 1, { simulation: { mode: 'increment', intervalMs: 100, min: 0, max: 32768, step: 1 } })] },
    { nodes: [node('a', 'Double', 1, { simulation: { mode: 'increment', intervalMs: 100, min: 2, max: 1, step: 1 } })] },
    { nodes: [node('a', 'Double', 1, { simulation: { mode: 'increment', intervalMs: 100, min: 0, max: 1, step: 0 } })] },
    { nodes: Array.from({ length: 100 }, (_, i) => node(`n${i}`, 'String', 'x'.repeat(4096))) },
  ];
  for (const invalid of bad) await assert.rejects(service.execute({ ...base, ...invalid }), JSON.stringify(invalid).slice(0, 120));
});

test('native simulator simulation defaults and malformed parameters match portable profiles', () => {
  const { normalizeNodes } = require('../electron/opcuaSimulatorStore.cjs');
  const definition = node('Temperature'); delete definition.simulation;
  assert.deepEqual(normalizeNodes([definition])[0].simulation, { mode: 'manual', intervalMs: 1000, min: 0, max: 100, step: 1 });
  for (const simulation of [null, [], 'manual', 0, false]) assert.throws(() => normalizeNodes([{ ...definition, simulation }]));
  for (const mode of ['manual', 'toggle']) {
    for (const key of ['min', 'max', 'step']) {
      for (const value of ['bad', {}, [], null, false, Infinity, NaN]) assert.throws(() => normalizeNodes([node('Enabled', 'Boolean', true, { simulation: { mode, [key]: value } })]));
    }
    assert.equal(normalizeNodes([node('Enabled', 'Boolean', true, { simulation: { mode, min: -1.5, max: 9.5, step: 0 } })])[0].simulation.step, 0);
  }
});

test('slow simulator handshakes expire without interrupting a healthy SDK session', { timeout: 15000 }, async t => {
  const { service, directory } = await setup(t);
  const port = await freePort(); const running = await start(service, 'slow-hello', undefined, port);
  const manager = new ua.OPCUACertificateManager({ rootFolder: join(directory, 'slow-test-client') });
  const client = ua.OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 0 }, clientCertificateManager: manager });
  let session; const sockets = [];
  try {
    await client.connect(running.endpointUrl); session = await client.createSession();
    const observations = [];
    for (const packet of [null, Buffer.from('HEL')]) {
      const socket = createConnection({ host: '127.0.0.1', port }); sockets.push(socket);
      const observed = { closed: false }; observations.push(observed);
      socket.on('error', () => {}); socket.on('data', () => {}); socket.on('close', () => { observed.closed = true; });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      if (packet) socket.write(packet);
    }
    const deadline = Date.now() + 6500; let reads = 0;
    while (Date.now() < deadline && observations.some(value => !value.closed)) {
      const value = await session.read({ nodeId: running.nodes[0].nodeId, attributeId: ua.AttributeIds.Value });
      assert(value.statusCode.isGood()); assert.equal(value.value.value, 23.5); reads++;
      await delay(150);
    }
    assert(observations.every(value => value.closed), 'silent and partial HEL peers must expire within the 5s handshake window plus scheduling tolerance');
    assert(reads > 1, 'healthy SDK reads continued while incomplete peers were connected');
  } finally {
    for (const socket of sockets) socket.destroy();
    await session?.close(); await client.disconnect(); await manager.dispose();
  }
  await request(service, 'stopServer', 'slow-hello', running.sessionId);
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => listener.close(resolve));
});

test('native simulator rejects reserved namespace URIs and accepts custom namespaces', async t => {
  const { service } = await setup(t);
  const save = namespaceUri => service.execute({ action: 'saveServerProfiles', profiles: [{ id: 'sim', name: 'Server', config: { namespaceUri }, nodes: [node('Temperature')] }] });
  for (const uri of ['http://opcfoundation.org/UA/', 'urn:ineedfull:linklab:simulator:server', 'urn:ineedfull:linklab:opcua:simulator']) await assert.rejects(save(uri), /namespace|命名空间|保留/);
  assert.equal((await save('https://example.test/linklab/custom')).profiles[0].config.namespaceUri, 'https://example.test/linklab/custom');
});

test('real SDK discovers browses reads writes subscribes and snapshots all simulator wire types', { timeout: 60000 }, async t => {
  const { service } = await setup(t);
  const definitions = [node('Temperature'), node('Int16', 'Int16', -32768), node('UInt16', 'UInt16', 65535), node('Int32', 'Int32', -2147483648), node('UInt32', 'UInt32', 4294967295), node('Int64', 'Int64', '-9223372036854775808'), node('UInt64', 'UInt64', '18446744073709551615'), node('Float', 'Float', 1.5), node('String', 'String', '测试'), node('ByteString', 'ByteString', 'AP9B'), node('DateTime', 'DateTime', '2026-10-22T10:20:30.000Z'), node('Array', 'Int16', [1, -2, 3], { arrayType: 'Array' }), node('WideArray', 'Int64', ['-1', '9223372036854775807'], { arrayType: 'Array' }), node('ReadOnly', 'Double', 7, { writable: false }), node('Enabled', 'Boolean', true, { simulation: { mode: 'toggle', intervalMs: 100, min: 0, max: 100, step: 1 } }), node('Counter', 'Int32', 1, { simulation: { mode: 'increment', intervalMs: 100, min: 0, max: 2, step: 1 } })];
  const running = await start(service, 'wire', definitions); assert.ok(running.sessionId); assert.ok(running.namespaceIndex > 0);
  const ids = Object.fromEntries(running.nodes.map(n => [n.id, n.nodeId])); assert.equal(Object.keys(ids).length, definitions.length);
  const client = ua.OPCUAClient.create({ endpointMustExist: true, connectionStrategy: { maxRetry: 0 }, securityMode: ua.MessageSecurityMode.None, securityPolicy: ua.SecurityPolicy.None });
  t.after(async () => { await client.disconnect(); });
  await client.connect(running.endpointUrl); const endpoints = await client.getEndpoints(); assert.ok(endpoints.length); assert.ok(endpoints.every(e => e.securityMode === ua.MessageSecurityMode.None));
  assert.ok(endpoints.every(e => e.userIdentityTokens.length === 1 && e.userIdentityTokens[0].tokenType === ua.UserTokenType.Anonymous));
  const session = await client.createSession();
  const browsed = await session.browse('ObjectsFolder'); const folder = browsed.references.find(n => n.browseName.name === 'LinkLab'); assert.ok(folder);
  const children = await session.browse(folder.nodeId); assert.ok(children.references.some(n => n.nodeId.toString() === ids.Temperature));
  const snapshot = () => request(service, 'serverSnapshot', 'wire', running.sessionId);
  const values = (await snapshot()).values; for (const definition of definitions.filter(n => n.simulation.mode === 'manual')) assert.deepEqual(values.find(v => v.nodeId === ids[definition.id]).value, definition.value);
  const read = await session.read({ nodeId: ids.Int64, attributeId: ua.AttributeIds.Value }); assert.deepEqual(read.value.value, [0x80000000, 0]);
  const status = await session.write({ nodeId: ids.Temperature, attributeId: ua.AttributeIds.Value, value: { value: { dataType: ua.DataType.Double, value: 42 } } }); assert.ok(status.isGood());
  assert.equal((await snapshot()).values.find(v => v.nodeId === ids.Temperature).value, 42);
  const denied = await session.write({ nodeId: ids.ReadOnly, attributeId: ua.AttributeIds.Value, value: { value: { dataType: ua.DataType.Double, value: 9 } } }); assert.match(denied.toString(), /BadNotWritable|BadUserAccessDenied/);
  for (const [id, dataType, arrayType, value] of [
    ['String', 'String', 'Scalar', 'x'.repeat(4097)], ['Temperature', 'Double', 'Scalar', Infinity],
    ['Array', 'Int16', 'Array', new Int16Array(101).fill(1)], ['Array', 'Int16', 'Scalar', 1],
  ]) {
    const rejected = await session.write({ nodeId: ids[id], attributeId: ua.AttributeIds.Value, value: { value: { dataType: ua.DataType[dataType], arrayType: ua.VariantArrayType[arrayType], value } } });
    assert.ok(rejected.isNotGood(), `${id} rejects invalid remote values`);
  }
  await request(service, 'setServerValue', 'wire', running.sessionId, { nodeId: ids.ReadOnly, value: 12 });
  assert.equal((await session.read({ nodeId: ids.ReadOnly, attributeId: ua.AttributeIds.Value })).value.value, 12);
  await assert.rejects(request(service, 'setServerValue', 'wire', running.sessionId, { nodeId: ids.UInt16, value: -1 }));
  const subscription = await session.createSubscription2({ requestedPublishingInterval: 50, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10, maxNotificationsPerPublish: 100, publishingEnabled: true, priority: 1 });
  const counter = []; const toggles = [];
  const monitored = await subscription.monitorItems([{ nodeId: ids.Counter, attributeId: ua.AttributeIds.Value }, { nodeId: ids.Enabled, attributeId: ua.AttributeIds.Value }], { samplingInterval: 50, discardOldest: true, queueSize: 10 }, ua.TimestampsToReturn.Both);
  monitored.on('changed', (_item, value, index) => (index === 0 ? counter : toggles).push(value.value.value));
  for (let i = 0; i < 40 && (new Set(counter).size < 3 || new Set(toggles).size < 2); i++) await delay(100);
  assert.deepEqual([...new Set(counter)].sort(), [0, 1, 2]); assert.deepEqual([...new Set(toggles)].sort(), [false, true]);
  await request(service, 'setServerValue', 'wire', running.sessionId, { nodeId: ids.Counter, value: 20 });
  assert.equal((await snapshot()).values.find(v => v.nodeId === ids.Counter).value, 20);
  let wrapped = false;
  for (let i = 0; i < 50 && !wrapped; i++) { await delay(10); wrapped = (await snapshot()).values.find(v => v.nodeId === ids.Counter).value === 0; }
  assert.ok(wrapped, 'manual values outside simulation range wrap to min on the next increment');
  const after = (await snapshot()).values; assert.ok(after.every(v => v.statusCode.startsWith('Good') && v.sourceTimestamp && v.serverTimestamp));
  await subscription.terminate(); await session.close(); await client.disconnect();
  await request(service, 'stopServer', 'wire', running.sessionId);
  const again = await start(service, 'wire', definitions, Number(new URL(running.endpointUrl).port));
  assert.equal((await request(service, 'serverSnapshot', 'wire', again.sessionId)).values.find(v => v.nodeId.endsWith(';s=Temperature')).value, 23.5);
});

test('simulator pending starts count toward capacity and cancelled or stale sessions release safely', { timeout: 60000 }, async t => {
  const { service } = await setup(t);
  const serverRegistryCount = ua.OPCUAServer.registry.count();
  const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
  const pending = Array.from({ length: 4 }, (_, i) => start(service, `server${i}`, undefined, ports[i]));
  await assert.rejects(start(service, 'fifth', undefined, ports[4]), /4|最多/);
  const running = await Promise.all(pending);
  await request(service, 'setServerValue', 'server0', running[0].sessionId, { nodeId: running[0].nodes[0].nodeId, value: 99 });
  assert.equal((await request(service, 'serverSnapshot', 'server1', running[1].sessionId)).values[0].value, 23.5);
  await assert.rejects(start(service, 'conflict', undefined, ports[0]), /4|最多/);
  await request(service, 'stopServer', 'server3', running[3].sessionId);
  await assert.rejects(start(service, 'conflict', undefined, ports[0]), /EADDRINUSE|端口|address|listen/i);
  const reused = await start(service, 'server3', undefined, ports[3]);
  await request(service, 'stopServer', 'server3', running[3].sessionId);
  assert.equal((await request(service, 'serverSnapshot', 'server3', reused.sessionId)).values[0].value, 23.5);
  await assert.rejects(request(service, 'serverSnapshot', 'server3', running[3].sessionId), /session|会话/);
  await assert.rejects(request(service, 'setServerValue', 'server3', running[3].sessionId, { nodeId: reused.nodes[0].nodeId, value: 99 }), /session|会话/);
  await service.shutdown();
  await assert.rejects(request(service, 'serverSnapshot', 'server3', reused.sessionId));
  const listener = createServer(); await new Promise((resolve, reject) => listener.once('error', reject).listen(ports[3], '127.0.0.1', resolve)); await new Promise(resolve => listener.close(resolve));
  const { service: cancellation } = await setup(t); const port = await freePort();
  const opening = start(cancellation, 'cancel', undefined, port); const rejected = assert.rejects(opening, /取消|closed|结束/);
  await request(cancellation, 'stopServer', 'cancel'); await rejected;
  const next = await start(cancellation, 'cancel', undefined, port); assert.ok(next.sessionId);
  await cancellation.shutdown(); assert.equal(ua.OPCUAServer.registry.count(), serverRegistryCount);
});

test('a shutdown error still retires its simulator slot and permits restart', { timeout: 30000 }, async t => {
  const { service } = await setup(t); const running = await start(service, 'shutdown-failure');
  const server = service.simulator.records.get('shutdown-failure').server; const shutdown = server.shutdown.bind(server);
  server.shutdown = async (...args) => { await shutdown(...args); throw new Error('post-shutdown failure'); };
  await assert.rejects(request(service, 'stopServer', 'shutdown-failure', running.sessionId), /post-shutdown failure/);
  const next = await start(service, 'shutdown-failure', undefined, Number(new URL(running.endpointUrl).port)); assert.ok(next.sessionId);
});

test('a shutdown failure before socket close retains ownership until retry closes the listener, SDK channels and incomplete handshakes', { timeout: 30000 }, async t => {
  const { service } = await setup(t); const initialCount = ua.OPCUAServer.registry.count();
  const running = await start(service, 'pre-close-failure'); const port = Number(new URL(running.endpointUrl).port);
  const record = service.simulator.records.get('pre-close-failure'); const server = record.server; const shutdown = server.shutdown.bind(server);
  const endpoints = [...server.endpoints];
  // Preserve the real listening handles for test-only cleanup if the regression leaks them.
  const listeners = endpoints.map(endpoint => endpoint._server);
  t.after(async () => { server.shutdown = shutdown; await shutdown(0); for (const listener of listeners) listener.close(); });
  const client = ua.OPCUAClient.create({ connectionStrategy: { maxRetry: 0 }, endpointMustExist: true });
  t.after(() => client.disconnect()); await client.connect(running.endpointUrl); await client.createSession();
  const incomplete = createConnection({ host: '127.0.0.1', port });
  t.after(() => incomplete.destroy()); await new Promise(resolve => incomplete.once('connect', resolve));
  const incompleteClosed = new Promise(resolve => incomplete.once('close', resolve));
  server.shutdown = async () => { throw new Error('pre-close shutdown failure'); };
  try {
    await assert.rejects(request(service, 'stopServer', 'pre-close-failure', running.sessionId), /pre-close shutdown failure/);
    assert.equal(service.simulator.records.get('pre-close-failure'), record, 'the live SDK server must retain a cleanup owner');
    await assert.rejects(start(service, 'pre-close-failure', undefined, port), /已经启动|停止/);
    const others = await Promise.all(['occupied1', 'occupied2', 'occupied3'].map(id => start(service, id)));
    assert.equal(others.length, 3);
    await assert.rejects(start(service, 'over-capacity'), /4|最多/);
  } finally { server.shutdown = shutdown; }
  await request(service, 'stopServer', 'pre-close-failure', running.sessionId);
  const listener = createServer();
  t.after(() => listener.close());
  await new Promise((resolve, reject) => listener.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => listener.close(resolve));
  await incompleteClosed; assert.ok(endpoints.every(endpoint => endpoint.currentChannelCount === 0));
  assert.equal(ua.OPCUAServer.registry.count(), initialCount + 3);
  const replacement = await start(service, 'pre-close-failure', undefined, port); assert.ok(replacement.sessionId);
});

test('fresh connection IDs reuse bounded server certificate storage', { timeout: 30000 }, async t => {
  const { service, directory } = await setup(t);
  for (let i = 0; i < 6; i++) { const id = `fresh-${i}`; const running = await start(service, id); await request(service, 'stopServer', id, running.sessionId); }
  assert.ok((await readdir(join(directory, 'server-pki'))).length <= 4, 'restarts do not create certificate folders without a bound');
});

test('service shutdown retains a failed simulator and a later shutdown retries cleanup', { timeout: 30000 }, async t => {
  const { service } = await setup(t); const running = await start(service, 'exit-retry');
  const record = service.simulator.records.get('exit-retry'); const shutdown = record.server.shutdown.bind(record.server);
  record.server.shutdown = async () => { throw new Error('temporary shutdown failure'); };
  try {
    await assert.rejects(service.shutdown(), /关闭失败|重试/);
    assert.equal(service.simulator.records.get('exit-retry'), record);
  } finally { record.server.shutdown = shutdown; }
  await service.shutdown(); assert.equal(service.simulator.records.size, 0);
  const listener = createServer(); t.after(() => listener.close());
  await new Promise((resolve, reject) => listener.once('error', reject).listen(Number(new URL(running.endpointUrl).port), '127.0.0.1', resolve));
  await new Promise(resolve => listener.close(resolve));
});

test('simulator shutdown failure still cleans client, discovery and certificate resources before reporting errors', async t => {
  const { service } = await setup(t);
  let simulatorAttempts = 0; let subscriptionsClosed = 0; let sessionsClosed = 0; let clientsClosed = 0; let discoveriesClosed = 0; let certificatesClosed = 0;
  service.simulator.shutdown = async () => { if (++simulatorAttempts === 1) throw new Error('simulator cleanup failed'); };
  service.connections.set('client', { subscription: { async terminate() { subscriptionsClosed++; } }, session: { async close() { sessionsClosed++; } }, client: { async disconnect() { clientsClosed++; } } });
  const discovery = { canceled: false, client: { async disconnect() { discoveriesClosed++; throw new Error('discovery cleanup failed'); } } };
  service.discoveryClients.add(discovery);
  service.ready = Promise.resolve();
  service.certificateManager = { async dispose() { certificatesClosed++; } };
  await assert.rejects(service.shutdown(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(reason => reason.message).sort(), ['discovery cleanup failed', 'simulator cleanup failed']);
    return true;
  });
  assert.equal(service.connections.size, 0); assert.equal(subscriptionsClosed, 1); assert.equal(sessionsClosed, 1); assert.equal(clientsClosed, 1);
  assert.equal(discovery.canceled, true); assert.equal(discoveriesClosed, 1); assert.equal(certificatesClosed, 1);
  service.discoveryClients.clear();
  await service.shutdown(); assert.equal(simulatorAttempts, 2);
});

test('server errors retire only their own generation and release listeners', { timeout: 30000 }, async t => {
  const { service, events } = await setup(t);
  const first = await start(service, 'fault'); const second = await start(service, 'healthy');
  const oldServer = service.simulator.records.get('fault').server;
  const retiredErrorHandler = oldServer.listeners('error')[0];
  oldServer.emit('error', new Error('test local listener failure'));
  for (let i = 0; i < 100 && service.simulator.records.has('fault'); i++) await delay(10);
  assert.ok(events.some(e => e.type === 'serverStatus' && e.connectionId === 'fault' && e.sessionId === first.sessionId && e.status === 'error'));
  assert.equal((await request(service, 'serverSnapshot', 'healthy', second.sessionId)).values[0].value, 23.5);
  const replacement = await start(service, 'fault', undefined, Number(new URL(first.endpointUrl).port));
  retiredErrorHandler(new Error('late retired failure'));
  assert.equal((await request(service, 'serverSnapshot', 'fault', replacement.sessionId)).values[0].value, 23.5);
});

test('cancellation after SDK address-space initialization cleans resources before restart', { timeout: 30000 }, async t => {
  const { service } = await setup(t); const port = await freePort(); const initialCount = ua.OPCUAServer.registry.count();
  const initialize = ua.OPCUAServer.prototype.initialize;
  let initialized; const ready = new Promise(resolve => { initialized = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const override = t.mock.method(ua.OPCUAServer.prototype, 'initialize', async function (...args) { const result = await initialize.apply(this, args); initialized(); await gate; return result; });
  const opening = start(service, 'cancel-initialized', undefined, port); const rejected = assert.rejects(opening, /取消|closed|结束/);
  await ready; const stopping = request(service, 'stopServer', 'cancel-initialized'); release(); await stopping; await rejected;
  assert.equal(ua.OPCUAServer.registry.count(), initialCount);
  override.mock.restore();
  const replacement = await start(service, 'cancel-initialized', undefined, port); assert.ok(replacement.sessionId);
});
