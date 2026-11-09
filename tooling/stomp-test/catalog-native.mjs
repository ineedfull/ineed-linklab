// Real STOMP transports and the unified catalog; no GUI or OPC UA network fixture.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProtocolEndpointCatalog } from '../../packages/workbench/src/model/protocolEndpointCatalog.js';
import { nativeBridge } from './native-bridge.mjs';

const out = process.env.LINKLAB_STOMP_CATALOG_OUT ?? path.join(tmpdir(), `linklab-stomp-catalog-${Date.now()}`);
await mkdir(out, { recursive: true });
const checks = [], owned = [];
let report;
async function bounded(label, operation) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 8000); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (!check()) { assert(Date.now() < deadline, message); await delay(20); }
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
try {
  for (const runtimeName of ['electron', 'tauri']) {
    const runtime = nativeBridge(runtimeName);
    // Catalog initialization reads both stores. This test exercises STOMP only.
    runtime.opcua = { async execute() { return { profiles: [] }; } };
    const catalog = createProtocolEndpointCatalog(runtime); owned.push({ runtime, catalog });
    await catalog.initialize(); assert.equal(catalog.state.error, '');
    const port = await freePort();
    async function create(role, name) {
      const result = await catalog.saveEndpoint({ transport: `stomp-${role}`, name,
        config: { url: `ws://127.0.0.1:${port}/stomp`, listenHost: '127.0.0.1', listenPort: port, path: '/stomp', host: 'localhost', autoReconnect: false } });
      assert(result.ok, result.error?.message); return { id: result.value.id, api: catalog.get(result.value.id) };
    }
    const server = await create('server', 'Broker'), clients = [];
    for (const name of ['Client A', 'Client B', 'Client C', 'Over limit']) clients.push(await create('client', name));
    Object.assign(server.api.state.credentials, { requireAuthentication: true, login: 'catalog-user', passcode: 'catalog-secret' });
    assert(await catalog.connect(server.id));
    await until(() => server.api.state.status === 'listening', 'Broker listening');
    for (const client of clients.slice(0, 3)) {
      assert.equal(client.api.state.credentials.passcode, '');
      Object.assign(client.api.state.credentials, { login: 'catalog-user', passcode: 'catalog-secret' });
      assert(await catalog.connect(client.id), client.api.state.error);
      await until(() => client.api.state.status === 'connected', client.api.state.error || 'Client CONNECTED');
      assert(await client.api.subscribe({ destination: '/topic/catalog', ack: 'auto' }), client.api.state.error);
    }
    assert.equal(new Set([server, ...clients.slice(0, 3)].map(row => row.api.state.sessionId)).size, 4);
    Object.assign(clients[3].api.state.credentials, { login: 'catalog-user', passcode: 'catalog-secret' });
    assert.equal(await catalog.connect(clients[3].id), false);
    assert(clients[3].api.state.error, 'Native cap must explain the rejection');
    await delay(200);
    const first = 'before-delete-\u0000-catalog';
    assert(await server.api.send({ destination: '/topic/catalog', body: first }));
    await until(() => clients.slice(0, 3).every(row => row.api.state.messages.some(message => message.body === first)), 'Independent native topic deliveries');
    const survivingSessions = clients.slice(1, 3).map(row => row.api.state.sessionId);
    assert((await catalog.remove(clients[0].id)).ok);
    assert.equal(clients[0].api.state.status, 'disconnected');
    assert.equal(clients[0].api.state.sessionId, null);
    const second = 'after-delete-catalog';
    assert(await server.api.send({ destination: '/topic/catalog', body: second }));
    await until(() => clients.slice(1, 3).every(row => row.api.state.messages.some(message => message.body === second)), 'Sibling deletion preserved both clients');
    assert.deepEqual(clients.slice(1, 3).map(row => row.api.state.sessionId), survivingSessions);
    assert(await catalog.connect(clients[3].id), clients[3].api.state.error);
    await until(() => clients[3].api.state.status === 'connected', 'Reused native slot CONNECTED');
    const persisted = JSON.stringify(await runtime.settings.getAll());
    assert(!persisted.includes('catalog-user')); assert(!persisted.includes('catalog-secret'));
    assert.equal(catalog.endpoints.length, 4);
    checks.push({ runtime: runtimeName, fourIndependentNativeSessions: true, fifthRejected: true,
      fullTopicDelivery: true, deleteIsolation: true, releasedSlotReusable: true, noSavedCredentials: true,
      settingsEvidence: runtime.settingsEvidence });
  }
  report = { passed: true, kind: 'real STOMP native transports + shared catalog; no GUI; OPC UA store fixture only', checks, out };
} catch (error) { report = { passed: false, error: error.stack, checks, out }; process.exitCode = 1; }
finally {
  for (const { catalog, runtime } of owned) {
    for (const cleanup of [() => catalog.dispose(), () => runtime.shutdown()]) {
      try { await bounded('Catalog/native cleanup', cleanup); }
      catch (error) { report.passed = false; (report.cleanupErrors ??= []).push(error.message); process.exitCode = 1; }
    }
  }
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.cleanupErrors?.length) process.exit(1);
}
