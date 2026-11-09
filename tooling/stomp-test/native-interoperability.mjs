import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Versions } from '@stomp/stompjs';
import { WebSocket } from 'ws';
import { createStompWorkbench } from '../../packages/workbench/src/model/stompWorkbench.js';
import { nativeBridge } from './native-bridge.mjs';

const out = process.env.LINKLAB_STOMP_OUT ?? path.join(tmpdir(), `linklab-stomp-native-${Date.now()}`);
const duration = Number(process.env.LINKLAB_STOMP_MS ?? 300000);
assert(Number.isSafeInteger(duration) && duration >= 0);
await mkdir(out, { recursive: true });
const bridges = ['electron', 'tauri'].map(nativeBridge);
const models = [], sdks = [], checks = [];
const report = { startedAt: new Date().toISOString(), kind: 'real Node and Rust native bridges, shared workbench and independent @stomp/stompjs clients; no GUI', checks };
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) { assert(Date.now() < deadline, label); await delay(20); }
}
async function port() {
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const value = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); return value;
}
function sdk(url, credentials, callbacks = {}) {
  let connections = 0;
  const received = [], errors = [];
  const client = new Client({
    webSocketFactory: () => new WebSocket(url, ['v12.stomp']),
    connectHeaders: { host: 'localhost', ...credentials }, stompVersions: new Versions([Versions.V1_2]),
    reconnectDelay: 500, connectionTimeout: 5000, heartbeatIncoming: 1000, heartbeatOutgoing: 1000,
    onConnect(frame) { connections++; callbacks.onConnect?.(frame); },
    onStompError(frame) { errors.push({ headers: frame.headers, body: frame.body }); callbacks.onError?.(frame); },
    debug() {},
  });
  const value = { client, received, errors, get connections() { return connections; } };
  sdks.push(value); client.activate(); return value;
}
async function subscribe(sdkClient, destination, ack = 'auto') {
  const receipt = `sub-${globalThis.crypto.randomUUID()}`;
  const ready = new Promise(resolve => sdkClient.client.watchForReceipt(receipt, resolve));
  sdkClient.client.subscribe(destination, message => { sdkClient.received.push(message); if (ack !== 'auto') message.ack(); }, { ack, receipt });
  await Promise.race([ready, delay(10000).then(() => { throw new Error('SDK SUBSCRIBE receipt deadline'); })]);
}
try {
  const pairs = [];
  for (const bridge of bridges) {
    const server = createStompWorkbench(bridge); models.push(server);
    server.state.mode = 'server';
    const listenPort = await port();
    Object.assign(server.state.config, { listenHost: '127.0.0.1', listenPort, path: '/stomp', host: 'localhost', heartbeatIncoming: 1000, heartbeatOutgoing: 1000 });
    Object.assign(server.state.credentials, { login: 'operator', passcode: 'interop-private-passcode', requireAuthentication: true });
    await server.connect(); await until(() => server.state.status === 'listening', `${bridge.runtimeName} server: ${server.state.error}`);
    console.log(JSON.stringify({ stage: 'server-listening', runtime: bridge.runtimeName, listenPort }));
    const otherBridge = bridges.find(candidate => candidate !== bridge);
    const client = createStompWorkbench(otherBridge); models.push(client);
    const url = `ws://127.0.0.1:${listenPort}/stomp`;
    Object.assign(client.state.config, { url, host: 'localhost', autoReconnect: true, heartbeatIncoming: 1000, heartbeatOutgoing: 1000 });
    Object.assign(client.state.credentials, { login: 'operator', passcode: 'interop-private-passcode' });
    await client.connect(); await until(() => client.state.status === 'connected', `${otherBridge.runtimeName} client: ${client.state.error}`);
    console.log(JSON.stringify({ stage: 'native-client-connected', runtime: otherBridge.runtimeName }));
    const external = [sdk(url, { login: 'operator', passcode: 'interop-private-passcode' }), sdk(url, { login: 'operator', passcode: 'interop-private-passcode' })];
    await until(() => external.every(value => value.client.connected), 'SDK CONNECTED');
    console.log(JSON.stringify({ stage: 'sdk-connected', server: bridge.runtimeName }));
    const topic = `/topic/${bridge.runtimeName}`;
    await client.subscribe({ destination: topic, ack: 'client-individual' });
    for (const value of external) await subscribe(value, topic);
    await delay(300);
    const body = 'Unicode 工控\u0000payload';
    external[0].client.publish({ destination: topic, body });
    await until(() => client.state.messages.some(message => message.body === body), 'Native client receives SDK Unicode/NULL');
    await until(() => external.every(value => value.received.some(message => message.body === body)), 'SDK topic broadcast');
    const nativeMessage = client.state.messages.find(message => message.body === body);
    await client.ack(nativeMessage.id);
    const manual = client.state.subscriptions.find(subscription => subscription.destination === topic);
    await client.unsubscribe(manual.id);
    await client.subscribe({ destination: topic, ack: 'auto' });
    const queue = `/queue/${bridge.runtimeName}`;
    for (const value of external) await subscribe(value, queue, 'client-individual');
    for (let index = 0; index < 6; index++) await client.send({ destination: queue, body: `queue-${index}`, receipt: true });
    await until(() => external.reduce((sum, value) => sum + value.received.filter(message => message.headers.destination === queue).length, 0) === 6, 'Queue delivery');
    assert.deepEqual(external.map(value => value.received.filter(message => message.headers.destination === queue).length), [3, 3]);
    checks.push({ server: bridge.runtimeName, client: otherBridge.runtimeName, topic: true, queueFair: true, unicodeNull: true, independentSdk: true });
    pairs.push({ bridge, server, client, external, topic, listenPort });
  }
  const started = Date.now(); let sequence = 0;
  const expected = new Map();
  do {
    for (const pair of pairs) {
      const body = `load-${++sequence}`;
      expected.set(body, pair);
      await pair.client.send({ destination: pair.topic, body, receipt: true });
    }
    await delay(50);
  } while (Date.now() - started < duration);
  for (const pair of pairs) {
    const bodies = [...expected].filter(([, value]) => value === pair).map(([body]) => body);
    for (const value of pair.external) {
      await until(() => value.received.filter(message => message.body.startsWith('load-')).length === bodies.length, 'SDK load complete');
      const actual = value.received.filter(message => message.body.startsWith('load-')).map(message => message.body);
      assert.deepEqual(actual, bodies);
    }
    assert(pair.client.state.messages.length <= 500); assert(pair.server.state.messages.length <= 500);
  }
  report.pressure = { elapsedMs: Date.now() - started, sends: expected.size, sdkDeliveries: expected.size * 2, ordered: true };
  for (const pair of pairs) {
    const before = pair.external.map(value => value.connections);
    await pair.server.disconnect(); await delay(900); await pair.server.connect();
    await until(() => pair.client.state.status === 'connected' && pair.external.every((value, index) => value.connections > before[index]), 'Native+SDK reconnect', 25000);
    const body = `restored-${pair.bridge.runtimeName}`;
    await pair.server.send({ destination: pair.topic, body, receipt: false });
    await until(() => pair.client.state.messages.some(message => message.body === body), 'Native subscription restored');
    await pair.client.disconnect(); await pair.server.disconnect();
    await pair.client.saveProfile(); await pair.server.saveProfile();
    assert(pair.client.state.profiles.length > 0); assert(pair.server.state.profiles.length > 0);
    for (const value of bridges) {
      const settings = JSON.stringify(await value.settings.getAll());
      assert(settings.includes('stompProfiles')); assert(!settings.includes('interop-private-passcode')); assert(!settings.includes('operator'));
    }
    checks.push({ server: pair.bridge.runtimeName, restartAndNativeSubscriptionRestore: true });
  }
  report.passed = true;
  report.settingsEvidence = Object.fromEntries(bridges.map(bridge => [bridge.runtimeName, bridge.settingsEvidence]));
} catch (error) { report.passed = false; report.error = error.stack; console.error(error.stack); process.exitCode = 1; }
finally {
  const cleanup = async (label, promises) => {
    let timer;
    try {
      const settled = await Promise.race([Promise.allSettled(promises), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} cleanup timeout`)), 5000); })]);
      const failures = settled.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), `${label} cleanup failed: ${failures.map(result => result.reason?.message ?? result.reason).join('; ')}`);
    }
    catch (error) { report.passed = false; report.cleanupError = error.message; process.exitCode = 1; }
    finally { clearTimeout(timer); }
  };
  await cleanup('SDK', sdks.map(value => value.client.deactivate({ force: true })));
  await cleanup('models', models.map(value => value.dispose()));
  await cleanup('native', bridges.map(value => value.shutdown()));
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, out }));
}
