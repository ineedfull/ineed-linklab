// Real service/CLI soak; intentionally does not launch either desktop GUI.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createOpcuaTestServer } from './server.mjs';

const { OpcuaService } = createRequire(import.meta.url)('../../apps/electron/electron/opcuaService.cjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(process.argv[2] ?? `scratch/opcua-soak-${Date.now()}`);
const durationMs = Number(process.argv[3] ?? 300) * 1000;
const idleMs = Number(process.argv[4] ?? 0) * 1000;
assert(Number.isFinite(durationMs) && durationMs >= 300000, 'Soak requires at least five minutes');
assert(Number.isFinite(idleMs) && idleMs >= 0 && idleMs <= 600000, 'Idle observation must be between zero and ten minutes');
await mkdir(output, { recursive: true });
const eventsLog = createWriteStream(join(output, 'events.ndjson'));
const nativeLog = createWriteStream(join(output, 'native-stderr.log'));
const started = Date.now();
const metrics = { startedAt: new Date(started).toISOString(), requestedDurationMs: durationMs, requestedIdleMs: idleMs, restarts: [], resources: [], checks: [], clients: {} };
let fixture;
let native;
let electron;
let exitPromise;
let exitResult;
let serial = 0;
const pending = new Map();
const clients = [];
let failed;
let workloadStarted;
let lastSample = 0;

function record(client, event) {
  const at = Date.now();
  if (event.type === 'data') { client.dataEvents++; client.dataValues += event.values?.length ?? 0; client.lastDataAt = at; }
  if (event.type === 'status') client.statuses.push({ at, status: event.status });
  eventsLog.write(JSON.stringify({ at, client: client.name, event }) + '\n');
}
function nativeRequest(request) {
  return new Promise((resolveRequest, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native ${request.action} timeout`)); }, 25000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    native.stdin.write(JSON.stringify({ id, request }) + '\n');
  });
}
function makeClient(name, execute, node, dataType) {
  const client = { name, execute, node, dataType, dataEvents: 0, dataValues: 0, lastDataAt: 0, statuses: [], operations: {}, expectedRejections: 0, roundtrips: 0, browseReleases: 0, completedPages: 0 };
  client.call = async (action, body = {}) => {
    const counter = client.operations[action] ??= { success: 0, rejected: 0 };
    try {
      const result = await execute({ action, connectionId: name, ...(client.sessionId ? { sessionId: client.sessionId } : {}), ...body });
      counter.success++; return result;
    } catch (error) { counter.rejected++; throw error; }
  };
  client.reject = async (action, body, pattern = /./) => { await assert.rejects(client.call(action, body), pattern); client.expectedRejections++; };
  clients.push(client); return client;
}
async function until(check, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(100); }
  assert.fail(label);
}
async function sample(phase = 'load') {
  const processes = execFileSync('ps', ['-o', 'pid=,rss=,%cpu=', '-p', String(process.pid), '-p', String(native.pid)], { encoding: 'utf8' })
    .trim().split('\n').map(line => {
      const [pid, rssKiB, cpuPercent] = line.trim().split(/\s+/).map(Number);
      return { pid, rssKiB, cpuPercent };
    });
  metrics.resources.push({ at: Date.now(), phase, node: process.memoryUsage(), nodeCpu: process.cpuUsage(), nativePid: native.pid, processes, pendingNativeRequests: pending.size });
  console.log(JSON.stringify({ phase, elapsedSeconds: (Date.now() - workloadStarted) / 1000, clients: clients.map(c => ({ name: c.name, roundtrips: c.roundtrips, dataEvents: c.dataEvents, browseReleases: c.browseReleases })), restarts: metrics.restarts.length, processes }));
}

async function startFixture(options) {
  const server = await createOpcuaTestServer(options);
  const namespace = server.server.engine.addressSpace.getNamespace(2);
  for (let index = 0; index < 205; index++) {
    namespace.addObject({ componentOf: server.nodes.Folder, nodeId: `ns=2;s=SoakPage${index}`, browseName: `SoakPage${index}` });
  }
  server.server.engine.serverCapabilities.maxBrowseContinuationPoints = 2;
  return server;
}

try {
  fixture = await startFixture({ directory: join(output, 'server') });
  const electronClient = makeClient('electron', request => electron.execute(request), fixture.nodes.Temperature, 'Double');
  electron = new OpcuaService({ directory: join(output, 'electron'), emitEvent: event => record(electronClient, event) });
  const nativeClient = makeClient('native', nativeRequest, fixture.nodes.Counter, 'Int32');
  native = spawn(join(root, 'apps/tauri/src-tauri/target/debug/opcua-harness'), [join(output, 'native')], { stdio: ['pipe', 'pipe', 'pipe'] });
  native.stderr.pipe(nativeLog);
  exitPromise = new Promise(resolveExit => {
    native.on('exit', (code, signal) => {
      exitResult = { code, signal };
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Native exited ${code}/${signal}`)); }
      pending.clear(); resolveExit(exitResult);
    });
  });
  createInterface({ input: native.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.event) { record(nativeClient, message.event); return; }
    const p = pending.get(message.id);
    if (p) { clearTimeout(p.timer); pending.delete(message.id); if (message.error) p.reject(new Error(message.error)); else p.resolve(message.result); }
  });
  const config = { endpointUrl: fixture.endpointUrl, securityPolicy: 'Basic256Sha256', securityMode: 'SignAndEncrypt', authentication: 'username', username: 'tester', password: 'test-only-password' };
  for (const client of clients) {
    const discovered = await client.call('discover', { endpointUrl: fixture.endpointUrl });
    const fingerprint = discovered.endpoints.find(e => e.securityPolicy === 'Basic256Sha256').serverCertificate.fingerprint;
    await client.reject('connect', { config }, /certificate|证书/i);
    await client.call('trust', { fingerprint });
    await client.reject('connect', { config: { ...config, password: 'incorrect' } }, /identity|user|password|session/i);
    client.sessionId = (await client.call('connect', { config })).sessionId;
    await client.call('saveProfiles', { profiles: [{ id: 'soak', name: 'Soak', config, favorites: [] }] });
    const profileFile = join(output, client.name, ...(client.name === 'native' ? ['opcua'] : []), 'profiles.json');
    const profile = await readFile(profileFile, 'utf8');
    assert(!profile.includes(config.password)); assert(!profile.includes('"password"'));
    await client.call('subscribe', { nodeIds: [fixture.nodes.Changing], intervalMs: 100 });
  }
  await until(() => clients.every(c => c.dataEvents > 0), 'Initial subscription data missing');
  metrics.checks.push('explicit trust, wrong-password rejection, secure username connection, credential-free profiles, initial subscription');
  workloadStarted = Date.now();
  metrics.workloadStartedAt = new Date(workloadStarted).toISOString();
  let iteration = 0;
  const restartSeconds = [60, 150, 240];
  while (Date.now() - workloadStarted < durationMs) {
    const tickStarted = Date.now();
    const elapsed = tickStarted - workloadStarted;
    if (metrics.restarts.length < restartSeconds.length && elapsed >= restartSeconds[metrics.restarts.length] * 1000) {
      const restart = { startedAt: Date.now(), clients: {} };
      const cuts = new Map(clients.map(c => [c.name, c.statuses.length]));
      const port = Number(new URL(fixture.endpointUrl).port);
      await fixture.close(); fixture = undefined;
      await delay(1500);
      fixture = await startFixture({ port, directory: join(output, 'server') });
      const availableAt = Date.now();
      await until(() => clients.every(c => c.lastDataAt > availableAt && c.statuses.slice(cuts.get(c.name)).some(e => e.status === 'reconnecting')), 'Subscription did not recover after restart');
      for (const c of clients) restart.clients[c.name] = { recoveredDataAt: c.lastDataAt, statuses: c.statuses.slice(cuts.get(c.name)) };
      restart.recoveredAt = Date.now(); metrics.restarts.push(restart);
      console.log(JSON.stringify({ restart: metrics.restarts.length, recoveryMs: restart.recoveredAt - restart.startedAt }));
    }
    await Promise.all(clients.map(async client => {
      const value = client.dataType === 'Double' ? iteration + 0.25 : iteration;
      await client.call('write', { nodeId: client.node, dataType: client.dataType, arrayType: 'Scalar', value });
      assert.equal((await client.call('read', { nodeIds: [client.node] })).values[0].value, value);
      client.roundtrips++;
      const page = await client.call('browse', { nodeId: fixture.nodes.Folder });
      assert(page.continuationPoint, `${client.name}: paged fixture must return a continuation point`);
      assert.deepEqual(await client.call('releaseBrowse', { continuationPoint: page.continuationPoint }), { released: true });
      client.browseReleases++;
      if (iteration % 25 === 0) {
        let next = await client.call('browse', { nodeId: fixture.nodes.Folder });
        const nodes = [...next.nodes];
        while (next.continuationPoint) {
          next = await client.call('browse', { nodeId: fixture.nodes.Folder, continuationPoint: next.continuationPoint });
          nodes.push(...next.nodes); client.completedPages++;
        }
        assert(nodes.length >= 215 && nodes.some(n => n.nodeId === client.node));
        const typed = await client.call('read', { nodeIds: [fixture.nodes.Wide, fixture.nodes.UnsignedWide, fixture.nodes.Bytes, fixture.nodes.Array] });
        assert.deepEqual(typed.values.map(v => v.value), ['9223372036854775807', '18446744073709551615', 'AP9B', [1, -2, 3]]);
        await client.reject('write', { nodeId: fixture.nodes.Wide, dataType: 'Int64', arrayType: 'Scalar', value: 123 });
        await client.reject('write', { nodeId: fixture.nodes.ReadOnly, dataType: 'Double', arrayType: 'Scalar', value: 8 });
        const before = client.dataEvents;
        await client.reject('subscribe', { nodeIds: [fixture.nodes.Changing], intervalMs: 99 });
        await until(() => client.dataEvents > before, `${client.name}: rejected subscription removed live monitor`, 3000);
      }
    }));
    iteration++;
    if (Date.now() - lastSample >= 30000) { await sample(); lastSample = Date.now(); }
    await delay(Math.max(0, 400 - (Date.now() - tickStarted)));
  }
  metrics.workloadElapsedMs = Date.now() - workloadStarted;
  assert.equal(metrics.restarts.length, 3);
  for (const client of clients) {
    assert(client.roundtrips >= 500);
    assert(client.dataEvents >= 1500);
    assert(client.dataEvents <= metrics.workloadElapsedMs / 1000 * 15 + 100, 'Unexpected duplicate monitor event rate');
    await client.call('unsubscribe');
    const count = client.dataEvents; await delay(600); assert.equal(client.dataEvents, count, 'Events persisted after unsubscribe');
    await client.call('disconnect');
    await client.reject('read', { nodeIds: [client.node] }, /session|会话|stale/i);
    assert.equal(client.browseReleases, client.roundtrips);
    metrics.clients[client.name] = { roundtrips: client.roundtrips, dataEvents: client.dataEvents, dataValues: client.dataValues, statuses: client.statuses, operations: client.operations, expectedRejections: client.expectedRejections, browseReleases: client.browseReleases, completedPages: client.completedPages };
  }
  metrics.checks.push('bounded two-cursor quota, repeated BrowseNext release, full pagination, typed reads, malformed writes/subscriptions, three restart recoveries, bounded data rate, unsubscribe silence, stale session rejection');
  const idleStarted = Date.now();
  const idleCounts = clients.map(client => client.dataEvents);
  await sample('idle-start');
  while (Date.now() - idleStarted < idleMs) {
    await delay(Math.min(10000, idleMs - (Date.now() - idleStarted)));
    assert.deepEqual(clients.map(client => client.dataEvents), idleCounts, 'Disconnected sessions emitted data during idle');
    assert.equal(pending.size, 0, 'Native requests remained pending during idle');
    await sample('idle');
  }
  metrics.idleElapsedMs = Date.now() - idleStarted;
} catch (error) {
  failed = error; metrics.error = { message: error.message, stack: error.stack }; console.error(error);
} finally {
  await electron?.shutdown();
  if (native && !exitResult) {
    native.stdin.end();
    const exited = await Promise.race([exitPromise, delay(10000).then(() => false)]);
    if (!exited) { native.kill('SIGTERM'); metrics.forcedNativeTermination = true; await exitPromise; }
  }
  await fixture?.close();
  metrics.nativeExit = exitResult;
  metrics.pendingNativeRequestsAtExit = pending.size;
  metrics.totalElapsedMs = Date.now() - started;
  metrics.finalNodeResources = process.memoryUsage();
  metrics.passed = !failed && exitResult?.code === 0 && !metrics.forcedNativeTermination && pending.size === 0;
  eventsLog.end(); nativeLog.end();
  await writeFile(join(output, 'summary.json'), JSON.stringify(metrics, null, 2) + '\n');
  console.log(JSON.stringify({ passed: metrics.passed, output, totalElapsedMs: metrics.totalElapsedMs }));
  if (!metrics.passed) process.exitCode = 1;
}
