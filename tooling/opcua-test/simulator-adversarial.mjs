// Bounded native simulator adversarial checks; isolated data and loopback only.
// Usage: node tooling/opcua-test/simulator-adversarial.mjs OUTPUT_DIRECTORY [electron|tauri|both]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const manual = { mode: 'manual', intervalMs: 1000, min: 0, max: 100, step: 1 };
const node = (extra = {}) => ({ id: 'Counter', name: 'Counter', dataType: 'Int32', arrayType: 'Scalar', value: 1, writable: true, simulation: manual, ...extra });
const errorText = error => String(error?.stack ?? error);

if (process.argv[2] === '--electron-worker') {
  const { OpcuaService } = require('../../apps/electron/electron/opcuaService.cjs');
  const service = new OpcuaService({ directory: process.argv[3], emitEvent: event => process.stdout.write(JSON.stringify({ event }) + '\n') });
  const pending = new Set();
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const task = service.execute(message.request).then(result => ({ result }), error => ({ error: String(error?.message ?? error) }))
      .then(result => process.stdout.write(JSON.stringify({ id: message.id, ...result }) + '\n'));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.allSettled(pending);
  await service.shutdown();
} else {
  const ua = require('node-opcua');
  const output = resolve(process.argv[2] ?? join(root, 'scratch/opcua-simulator-adversarial'));
  const selected = process.argv[3] ?? 'both';
  assert(['electron', 'tauri', 'both'].includes(selected));
  await mkdir(output, { recursive: true });
  const report = { startedAt: new Date().toISOString(), runnerPid: process.pid, nodeVersion: process.version,
    parameters: { loopbackOnly: true, runtimeOrder: selected === 'both' ? ['electron', 'tauri'] : [selected], malformedConnections: 8, slowConnections: 8, maxHandshakeObservationMs: 34000, subscriptionAttempts: 105, sessionAttempts: 17, maxInstances: 4 }, runtimes: [] };
  const flush = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  async function port() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const result = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return result;
  }
  async function bindProbe(value) {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(value, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
  async function run(runtime) {
    const dataDirectory = await mkdtemp(join(tmpdir(), `linklab-${runtime}-simulator-adversarial-`));
    const result = { runtime, startedAt: new Date().toISOString(), dataDirectory, cases: [], processes: [], ports: [], events: [], cleanup: {} };
    report.runtimes.push(result);
    const log = createWriteStream(join(output, `${runtime}-native.log`));
    const child = runtime === 'electron'
      ? spawn(process.execPath, [self, '--electron-worker', join(dataDirectory, 'opcua')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(join(root, 'apps/tauri/src-tauri/target/debug/opcua-harness'), [dataDirectory], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    result.processes.push({ pid: child.pid, executable: child.spawnfile, arguments: child.spawnargs.slice(1) });
    child.stderr.pipe(log, { end: false });
    let sequence = 0;
    const pending = new Map(), clients = [], sockets = new Set(), servers = new Map();
    createInterface({ input: child.stdout }).on('line', line => {
      log.write(line + '\n');
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event) { result.events.push(message.event); return; }
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
    });
    child.once('exit', (code, signal) => {
      result.processes[0].exitCode = code; result.processes[0].exitSignal = signal;
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(`Native worker exited ${code}/${signal}`)); }
      pending.clear();
    });
    function request(request) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { reject(new Error('Native worker is no longer running')); return; }
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native request timeout: ${request.action}`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, request }) + '\n');
      });
    }
    async function check(name, parameters, execute) {
      const item = { name, parameters, startedAt: new Date().toISOString() };
      result.cases.push(item); const before = performance.now();
      try { item.observed = await execute(); item.passed = true; }
      catch (error) { item.passed = false; item.error = errorText(error); process.stderr.write(`${runtime} FAIL ${name}: ${error.message}\n`); }
      item.durationMs = Math.round(performance.now() - before);
      await flush();
      return item;
    }
    async function rejectRequest(input) {
      try { const accepted = await request(input); if (input.action === 'startServer') await request({ action: 'stopServer', connectionId: input.connectionId }); assert.fail(`Native API accepted invalid input: ${JSON.stringify(accepted).slice(0, 500)}`); }
      catch (error) { if (error.code === 'ERR_ASSERTION') throw error; assert(!/timeout|worker exited/i.test(error.message), error.message); return { rejected: true, error: error.message }; }
    }
    async function start(id, nodes = [node()], overrides = {}) {
      const config = { listenHost: '127.0.0.1', listenPort: await port(), path: '/LinkLab', namespaceUri: 'urn:linklab:adversarial', ...overrides };
      const input = { action: 'startServer', connectionId: id, config, nodes };
      const live = await request(input);
      const server = { ...live, input, id, port: config.listenPort };
      servers.set(id, server); result.ports.push(config.listenPort);
      return server;
    }
    async function stop(server) { await request({ action: 'stopServer', connectionId: server.id, sessionId: server.sessionId }); servers.delete(server.id); }
    const snapshot = server => request({ action: 'serverSnapshot', connectionId: server.id, sessionId: server.sessionId });
    const update = (server, nodeId, value) => request({ action: 'setServerValue', connectionId: server.id, sessionId: server.sessionId, nodeId, value });
    async function connect(server) {
      const certificateManager = new ua.OPCUACertificateManager({ rootFolder: join(dataDirectory, `sdk-${clients.length}`), automaticallyAcceptUnknownCertificate: false });
      const client = ua.OPCUAClient.create({ endpointMustExist: false, securityMode: ua.MessageSecurityMode.None, securityPolicy: ua.SecurityPolicy.None,
        requestedSessionTimeout: 30000, transportTimeout: 5000, defaultSecureTokenLifetime: 30000,
        connectionStrategy: { maxRetry: 0 }, clientCertificateManager: certificateManager });
      const entry = { client, certificateManager, sessions: [] }; clients.push(entry);
      await client.connect(server.endpointUrl);
      entry.session = await client.createSession(); entry.sessions.push(entry.session);
      return entry;
    }
    async function closeClient(entry) {
      for (const session of entry.sessions.splice(0)) { try { await session.close(); } catch { /* A server may already have stopped. */ } }
      await entry.client.disconnect();
      await entry.certificateManager.dispose();
      clients.splice(clients.indexOf(entry), 1);
    }
    try {
      const baseConfig = { listenHost: '127.0.0.1', listenPort: await port(), path: '/LinkLab', namespaceUri: 'urn:linklab:adversarial' };
      const invalidConfig = [
        ['null-config', null], ['array-config', []], ['remote-host', { ...baseConfig, listenHost: '192.0.2.1' }],
        ...[0, 65536, 1.5, '4840'].map(listenPort => [`port-${listenPort}`, { ...baseConfig, listenPort }]),
        ...['no-slash', '/space path', '/../x', '/' + 'x'.repeat(128)].map(path => [`path-${path.length}-${path.slice(0, 12)}`, { ...baseConfig, path }]),
        ...['file:///tmp', 'urn:', 'urn:a b', 'urn:a\u0000b', 'http://opcfoundation.org/UA/', 'urn:ineedfull:linklab:simulator:server', 'urn:ineedfull:linklab:opcua:simulator'].map(namespaceUri => [`namespace-${namespaceUri}`, { ...baseConfig, namespaceUri }]),
      ];
      for (const [name, config] of invalidConfig) await check(`invalid-config/${name}`, { config }, () => rejectRequest({ action: 'startServer', connectionId: 'invalid', config, nodes: [node()] }));
      const invalidNodes = [
        ['empty', []], ['not-array', {}], ['too-many', Array.from({ length: 101 }, (_, i) => node({ id: `n${i}` }))],
        ['duplicate', [node(), node()]], ['null-node', [null]],
        ...[['id', '../x'], ['name', ' '], ['dataType', 'NodeId'], ['arrayType', 'Matrix'], ['writable', 'true'], ['value', 2147483648], ['value', null], ['simulation', { mode: 'increment', intervalMs: 99 }], ['simulation', { mode: 'increment', step: 0 }], ['simulation', { mode: 'increment', min: 4, max: 2 }], ['simulation', { mode: 'toggle' }], ['simulation', null], ['simulation', []], ['simulation', 'manual'], ['simulation', { mode: 'manual', min: 'bad' }], ['simulation', { mode: 'manual', step: {} }]].map(([field, value], i) => [`field-${field}-${i}`, [node({ [field]: value })]]),
        ...[['String', 'x'.repeat(4097)], ['ByteString', '*'], ['DateTime', '2026-10-22T00:00:00'], ['Int64', 42], ['UInt64', '18446744073709551616']].map(([dataType, value]) => [`value-${dataType}`, [node({ dataType, value })]]),
        ['array-too-many', [node({ arrayType: 'Array', value: Array(101).fill(0) })]],
        ['nodes-json-too-large', [node({ dataType: 'String', arrayType: 'Array', value: Array(100).fill('x'.repeat(4096)) })]],
      ];
      for (const [name, nodes] of invalidNodes) await check(`invalid-nodes/${name}`, { count: Array.isArray(nodes) ? nodes.length : null, encodedBytes: Buffer.byteLength(JSON.stringify(nodes)), sample: JSON.stringify(nodes).slice(0, 350) }, () => rejectRequest({ action: 'startServer', connectionId: 'invalid', config: baseConfig, nodes }));
      const profile = { id: 'saved', name: 'Saved', config: baseConfig, nodes: [node()] };
      await request({ action: 'saveServerProfiles', profiles: [profile] });
      for (const [name, profiles] of [['null', null], ['not-array', {}], ['too-many', Array.from({ length: 51 }, (_, i) => ({ ...profile, id: `p${i}` }))], ['duplicate', [profile, profile]], ['bad-id', [{ ...profile, id: '../bad' }]], ['invalid-nodes', [{ ...profile, nodes: [node({ value: 'wrong' })] }]], ['over-1MiB', Array.from({ length: 5 }, (_, i) => ({ ...profile, id: `p${i}`, nodes: Array.from({ length: 55 }, (_, n) => node({ id: `n${n}`, dataType: 'String', value: 'x'.repeat(4096) })) }))]]) {
        await check(`invalid-profiles/${name}`, { count: Array.isArray(profiles) ? profiles.length : null, encodedBytes: Buffer.byteLength(JSON.stringify(profiles)) }, async () => {
          const rejected = await rejectRequest({ action: 'saveServerProfiles', profiles });
          const after = await request({ action: 'serverProfiles' }); assert.deepEqual(after.profiles, [profile]); return { ...rejected, previousProfilePreserved: true };
        });
      }
      await check('capacity-and-port-conflict', { maxInstances: 4, failedStartMustReleaseSlot: true }, async () => {
        const first = await start('one');
        const conflict = await rejectRequest({ ...first.input, connectionId: 'conflict' });
        const next = await Promise.all(['two', 'three', 'four'].map(id => start(id)));
        const overflow = await rejectRequest({ action: 'startServer', connectionId: 'five', config: { ...baseConfig, listenPort: await port() }, nodes: [node()] });
        const duplicate = await rejectRequest(first.input);
        assert.equal((await snapshot(first)).values[0].value, 1);
        for (const s of [first, ...next]) await stop(s);
        const replacement = await start('five'); await stop(replacement);
        return { conflict, overflow, duplicate, capacityRecovered: true };
      });
      await check('cancel-pending-start-and-stale-session', { staleStopMustPreserveReplacement: true }, async () => {
        const requestedPort = await port(); result.ports.push(requestedPort);
        const opening = request({ action: 'startServer', connectionId: 'cancel', config: { ...baseConfig, listenPort: requestedPort }, nodes: [node()] });
        const settled = opening.then(value => ({ fulfilled: true, value }), error => ({ fulfilled: false, error: error.message }));
        // Native dispatches may be scheduled concurrently; wait until the start
        // owns the listener before testing cancellation of a pending/running start.
        const reservationDeadline = performance.now() + 5000;
        while (performance.now() < reservationDeadline) {
          const listening = await new Promise(resolve => {
            const probe = createConnection({ host: '127.0.0.1', port: requestedPort });
            probe.once('connect', () => { probe.destroy(); resolve(true); });
            probe.once('error', () => resolve(false));
          });
          if (listening) break;
          await delay(5);
        }
        await request({ action: 'stopServer', connectionId: 'cancel' });
        const cancelled = await settled; await bindProbe(requestedPort);
        const old = await start('stale'); await stop(old);
        const live = await start('stale', [node()], { listenPort: old.port });
        await request({ action: 'stopServer', connectionId: old.id, sessionId: old.sessionId });
        const staleRead = await rejectRequest({ action: 'serverSnapshot', connectionId: old.id, sessionId: old.sessionId });
        const staleWrite = await rejectRequest({ action: 'setServerValue', connectionId: old.id, sessionId: old.sessionId, nodeId: old.nodes[0].nodeId, value: 7 });
        await request({ action: 'stopServer', connectionId: live.id, sessionId: 123 }).catch(() => {});
        assert.equal((await snapshot(live)).values[0].value, 1); await stop(live);
        return { cancelled, portReleased: true, staleRead, staleWrite, malformedFencePreservedServer: true };
      });
      const live = await start('attacked', [node(), node({ id: 'Readonly', name: 'Readonly', writable: false }), node({ id: 'Text', name: 'Text', dataType: 'String', value: 'ok' })]);
      const sdk = await connect(live); const session = sdk.session; const counter = live.nodes.find(n => n.id === 'Counter').nodeId;
      const readCounter = async () => { const actual = await session.read({ nodeId: counter, attributeId: ua.AttributeIds.Value }); assert(actual.statusCode.isGood()); return actual.value.value; };
      const writeCounter = async value => { const status = await session.write({ nodeId: counter, attributeId: ua.AttributeIds.Value, value: { value: new ua.Variant({ dataType: ua.DataType.Int32, value }) } }); assert(status.isGood(), status.name); };
      await check('native-value-and-node-rejection', { nativeCalls: 5, remoteCalls: 4 }, async () => {
        const rejected = [];
        for (const [nodeId, value] of [[counter, 'bad'], [counter, 2147483648], [counter, null], ['ns=65535;s=missing', 1], [live.nodes.find(n => n.id === 'Text').nodeId, 'x'.repeat(4097)]]) rejected.push(await rejectRequest({ action: 'setServerValue', connectionId: live.id, sessionId: live.sessionId, nodeId, value }));
        const readonly = await session.write({ nodeId: live.nodes.find(n => n.id === 'Readonly').nodeId, attributeId: ua.AttributeIds.Value, value: { value: new ua.Variant({ dataType: ua.DataType.Int32, value: 8 }) } });
        const wrongType = await session.write({ nodeId: counter, attributeId: ua.AttributeIds.Value, value: { value: new ua.Variant({ dataType: ua.DataType.String, value: 'bad' }) } });
        const missing = await session.read({ nodeId: 'ns=65535;s=missing', attributeId: ua.AttributeIds.Value });
        const textWrite = await session.write({ nodeId: live.nodes.find(n => n.id === 'Text').nodeId, attributeId: ua.AttributeIds.Value, value: { value: new ua.Variant({ dataType: ua.DataType.String, value: 'x'.repeat(4097) }) } });
        assert(!readonly.isGood()); assert(!wrongType.isGood()); assert(!missing.statusCode.isGood()); assert(!textWrite.isGood()); assert.equal(await readCounter(), 1);
        return { rejected, remoteStatuses: [readonly.name, wrongType.name, missing.statusCode.name, textWrite.name], originalValuePreserved: true };
      });
      await check('malformed-HEL-and-slow-connections', { malformed: 8, slow: 8, observationMs: 34000, maxAdvertisedBytes: 4294967295 }, async () => {
        const packets = [];
        function header(type, length, total = 8) { const b = Buffer.alloc(total); b.write(type, 0); b.writeUInt32LE(length, 4); return b; }
        packets.push(['unknown-message', header('BADF', 8)], ['invalid-final', header('HELC', 8)], ['zero-size', header('HELF', 0)], ['below-header', header('HELF', 7)], ['oversized-advertised', header('HELF', 0xffffffff)], ['bodyless-HEL', header('HELF', 8)]);
        const invalidProtocol = header('HELF', 32, 32); invalidProtocol.writeUInt32LE(0xffffffff, 8); invalidProtocol.writeUInt32LE(65536, 12); invalidProtocol.writeUInt32LE(65536, 16); packets.push(['invalid-protocol', invalidProtocol]);
        const invalidString = header('HELF', 32, 32); invalidString.writeUInt32LE(65536, 12); invalidString.writeUInt32LE(65536, 16); invalidString.writeInt32LE(0x7fffffff, 28); packets.push(['invalid-endpoint-length', invalidString]);
        const connections = [];
        async function socketProbe(name, packet) {
          const observation = { name, sentBytes: packet?.length ?? 0, closed: false, receivedBytes: 0 };
          const opened = performance.now();
          const socket = createConnection({ host: '127.0.0.1', port: live.port }); sockets.add(socket); connections.push({ socket, observation });
          socket.on('error', error => { observation.socketError = error.code ?? error.message; });
          socket.on('data', data => { observation.receivedBytes += data.length; if (!observation.firstResponseHex) observation.firstResponseHex = data.subarray(0, 48).toString('hex'); });
          socket.on('close', () => { observation.closed = true; observation.closedAfterMs = Math.round(performance.now() - opened); sockets.delete(socket); });
          await new Promise(resolve => { socket.once('connect', resolve); socket.once('error', resolve); });
          if (!socket.destroyed && packet) socket.write(packet);
        }
        for (const [name, packet] of packets) await socketProbe(name, packet);
        for (let i = 0; i < 8; i++) await socketProbe(`slow-${i}`, i % 2 ? Buffer.from('HEL') : null);
        const deadline = performance.now() + 34000; const healthy = [];
        while (performance.now() < deadline) {
          const before = performance.now(); await writeCounter(healthy.length + 10); assert.equal(await readCounter(), healthy.length + 10); healthy.push(Math.round(performance.now() - before));
          if (connections.every(({ observation }) => observation.closed)) break;
          await delay(250);
        }
        const observations = connections.map(({ observation }) => ({ ...observation }));
        for (const { socket } of connections) socket.destroy();
        await delay(30); assert.equal(await readCounter(), healthy.length + 9);
        assert(observations.every(observation => observation.closed), `Handshake sockets exceeded 34s bound: ${JSON.stringify(observations.filter(observation => !observation.closed))}`);
        return { observations, healthyReadWriteCycles: healthy.length, maxHealthyCycleMs: Math.max(...healthy), malformedClosedBeforeCleanup: observations.slice(0, 8).filter(s => s.closed).length, allAttackSocketsDestroyed: connections.every(({ socket }) => socket.destroyed), survivor: true };
      });
      await check('subscription-capacity-and-recovery', { attempts: 105, publishingIntervalMs: 1000, monitoredItemsDuringAttack: 0 }, async () => {
        const accepted = [], rejected = []; let afterDelete;
        try {
          for (let i = 0; i < 105; i++) {
            try {
              const subscription = await session.createSubscription({ requestedPublishingInterval: 1000, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10, maxNotificationsPerPublish: 100, publishingEnabled: false, priority: 1 });
              accepted.push(subscription.subscriptionId);
            } catch (error) { rejected.push(error.message); break; }
          }
          assert(rejected.length > 0, 'No bounded subscription rejection within 105 attempts');
          await writeCounter(123); assert.equal(await readCounter(), 123);
        } finally {
          if (accepted.length) await session.deleteSubscriptions({ subscriptionIds: accepted });
        }
        const subscription = await session.createSubscription2({ requestedPublishingInterval: 100, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10, maxNotificationsPerPublish: 100, publishingEnabled: true, priority: 1 });
        const changes = [];
        try {
          const item = await subscription.monitor({ nodeId: counter, attributeId: ua.AttributeIds.Value }, { samplingInterval: 50, queueSize: 10, discardOldest: true }, ua.TimestampsToReturn.Both);
          item.on('changed', value => changes.push(value.value.value));
          await delay(200); await writeCounter(456); await delay(250); await update(live, counter, 789); await delay(250);
          assert(changes.includes(456), `Missing remote-write notification: ${changes}`); assert(changes.includes(789), `Missing local-write notification: ${changes}`);
          afterDelete = { changes, current: await readCounter() };
        } finally { await subscription.terminate(); }
        return { accepted: accepted.length, rejected, healthyAfterDelete: afterDelete };
      });
      await check('session-capacity-and-recovery', { attempts: 17, configuredMaxSessions: 16, existingHealthySessions: 1 }, async () => {
        const added = [], errors = [];
        try {
          for (let i = 0; i < 17; i++) {
            try { added.push(await sdk.client.createSession()); } catch (error) { errors.push(error.message); break; }
          }
          assert(errors.length, 'Expected session capacity rejection'); assert.equal(await readCounter(), 789);
        } finally { for (const extra of added) await extra.close(); }
        const restored = await sdk.client.createSession(); await restored.close();
        return { acceptedAdditional: added.length, rejected: errors, capacityRecovered: true, originalSessionAlive: true };
      });
      await closeClient(sdk);
      await check('stop-releases-port-and-restart-restores-initial-value', { initialValue: 1 }, async () => {
        await stop(live); await bindProbe(live.port);
        const restarted = await start('attacked', [node()], { listenPort: live.port });
        const independent = await connect(restarted);
        const value = await independent.session.read({ nodeId: restarted.nodes[0].nodeId, attributeId: ua.AttributeIds.Value });
        assert.equal(value.value.value, 1); assert(value.statusCode.isGood());
        await closeClient(independent); await stop(restarted); await bindProbe(restarted.port);
        return { portReleased: true, independentSdkRead: value.value.value, initialConfigPreserved: true };
      });
    } catch (error) { result.fatal = errorText(error); }
    finally {
      for (const socket of sockets) socket.destroy();
      result.cleanup.clientErrors = [];
      for (const client of [...clients]) try { await closeClient(client); } catch (error) { result.cleanup.clientErrors.push(errorText(error)); }
      result.cleanup.stopErrors = [];
      for (const id of new Set([...servers.keys(), 'invalid', 'cancel', 'stale', 'one', 'two', 'three', 'four', 'five', 'conflict', 'attacked'])) {
        try { await request({ action: 'stopServer', connectionId: id }); } catch (error) { result.cleanup.stopErrors.push({ id, error: errorText(error) }); }
      }
      child.stdin.end();
      const graceful = await new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
        const timer = setTimeout(() => resolve(false), 8000);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      result.cleanup.gracefulWorkerExit = graceful;
      if (!graceful) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
      result.cleanup.portResults = [];
      for (const port of new Set(result.ports)) {
        try { await bindProbe(port); result.cleanup.portResults.push({ port, released: true }); }
        catch (error) { result.cleanup.portResults.push({ port, released: false, error: error.message }); }
      }
      await rm(dataDirectory, { recursive: true, force: true }); result.cleanup.isolatedDataRemoved = true;
      log.end(); result.finishedAt = new Date().toISOString();
      result.passed = !result.fatal && result.cases.every(item => item.passed) && graceful && result.processes[0].exitCode === 0 && result.cleanup.portResults.every(item => item.released) && !result.cleanup.clientErrors.length && !result.cleanup.stopErrors.length;
      await flush();
    }
    process.stdout.write(`${runtime}: ${result.cases.filter(item => item.passed).length}/${result.cases.length} cases passed; overall=${result.passed}; native PID=${child.pid}; report=${join(output, 'report.json')}\n`);
  }
  for (const runtime of report.parameters.runtimeOrder) await run(runtime);
  report.finishedAt = new Date().toISOString(); report.passed = report.runtimes.every(result => result.passed);
  await flush(); if (!report.passed) process.exitCode = 1;
}
