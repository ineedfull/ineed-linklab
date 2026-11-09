import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@stomp/stompjs';
import { WebSocket } from 'ws';

/** Uses the same native hosts and UI driver as desktop-duel, without retaining payloads. */
export async function runMemoryCycles({ command, sample, freePort, runtimes, until, batchSize, pauseMs, options, capture, onSdk }) {
  const stages = [];
  for (let cycle = 1; cycle <= options.cycles; cycle++) for (const server of runtimes) {
    const client = runtimes.find(name => name !== server), port = await freePort();
    const destination = `/topic/memory-${server}`, extraName = `Memory ${client} extra`;
    for (const runtime of runtimes) await command(runtime, 'clear-observer');
    await command(server, 'configure', { mode: 'server', port });
    await command(server, 'messages');
    await command(client, 'configure', { mode: 'client', port });
    await command(client, 'subscribe', { destination });
    await command(client, 'configure', { mode: 'client', port, name: extraName });
    await command(client, 'subscribe', { destination });
    await command(client, 'select', { name: `Desktop ${client} client` });
    let sdkCount = 0, sdkError = '';
    const sdk = new Client({ webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${port}/stomp`, ['v12.stomp']), connectHeaders: { host: 'localhost', login: 'operator', passcode: 'desktop-private-passcode' }, reconnectDelay: 0, heartbeatIncoming: 1000, heartbeatOutgoing: 1000, debug() {} });
    onSdk(sdk);
    sdk.onStompError = frame => { sdkError = frame.body; };
    sdk.onConnect = () => sdk.subscribe(destination, message => {
      sdkCount++;
      const expected = `load-${server}-${String(sdkCount).padStart(8, '0')}`;
      if (message.body !== expected) sdkError ||= `SDK order mismatch at ${sdkCount}`;
    });
    sdk.activate(); await until(() => sdk.connected, 'Memory SDK connected'); await delay(300);
    const label = `cycle-${cycle}-${server}`;
    await sample(`${label}-start`);
    let sent = 0; const started = Date.now(); let lastSample = started;
    while (sent < options.messages) {
      const bodies = Array.from({ length: Math.min(batchSize, options.messages - sent) }, () => `load-${server}-${String(++sent).padStart(8, '0')}`);
      await command(client, 'raw', { destination, bodies }); await delay(pauseMs);
      if (Date.now() - lastSample >= 30000) { await sample(`${label}-load`); lastSample = Date.now(); }
    }
    await until(() => sdkCount >= sent || sdkError, 'Memory SDK catches up');
    assert.equal(sdkError, ''); assert.equal(sdkCount, sent);
    const loadMs = Date.now() - started;
    const streams = [];
    for (const [runtime, name] of [[server, `Desktop ${server} server`], [client, `Desktop ${client} client`], [client, extraName]]) {
      await command(runtime, 'select', { name });
      await until(async () => {
        const value = await command(runtime, 'metrics');
        return options.observer === 'off' ? value.bodies.includes(`load-${server}-${String(sent).padStart(8, '0')}`) : options.observer === 'bounded' ? value.stream.count >= sent : value.selectedWireCount >= sent;
      }, 'Memory native consumers catch up');
      const value = await command(runtime, 'metrics', { fullWire: options.observer === 'full' });
      if (options.observer === 'bounded') {
        assert.equal(value.stream.error, ''); assert.equal(value.stream.count, sent); assert.equal(value.stream.lastSequence, sent); assert.equal(value.retainedObserverBodies, 0);
      } else if (options.observer === 'full') {
        assert.equal(value.wire.length, sent);
        value.wire.forEach(([body, count], index) => { assert.equal(body, `load-${server}-${String(index + 1).padStart(8, '0')}`); assert.equal(count, 1); });
      }
      streams.push({ runtime, name, stream: value.stream, rows: value.rows, observerBodies: value.retainedObserverBodies });
    }
    await command(client, 'select', { name: `Desktop ${client} client` });
    await sample(`${label}-loaded`);
    if (capture) await capture(`${label}-loaded`);
    await sdk.deactivate({ force: true }); onSdk(null);
    for (const name of [`Desktop ${client} client`, extraName]) { await command(client, 'select', { name }); await command(client, 'disconnect'); }
    await command(server, 'disconnect');
    await sample(`${label}-disconnected`);
    for (const [runtime, names] of [[server, [`Desktop ${server} server`]], [client, [`Desktop ${client} client`, extraName]]]) {
      for (const name of names) { await command(runtime, 'select', { name }); await command(runtime, 'clear'); }
      await command(runtime, 'clear-observer');
    }
    await sample(`${label}-cleared`); await delay(options.idleMs); await sample(`${label}-idle`);
    for (const [runtime, names] of [[client, [extraName, `Desktop ${client} client`]], [server, [`Desktop ${server} server`]]]) for (const name of names) await command(runtime, 'delete', { name });
    const retained = {};
    for (const runtime of runtimes) retained[runtime] = await command(runtime, 'memory-metrics');
    for (const value of Object.values(retained)) { assert.equal(value.rows, 0); assert.equal(value.retainedObserverBodies, 0); assert.equal(value.observerConnections, 0); }
    await sample(`${label}-deleted`);
    stages.push({ cycle, server, messages: sent, loadMs, sdkOrder: true, nativeFullOrder: options.observer !== 'off', streams, afterDelete: retained });
  }
  return { kind: 'repeated visible memory diagnostic; not the 20-minute pressure acceptance', stages, options, batchSize, pauseMs };
}
