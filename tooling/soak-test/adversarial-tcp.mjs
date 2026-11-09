#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { TcpService } = require('../../apps/electron/electron/tcpService.cjs');
const out = process.env.LINKLAB_SOAK_OUT ?? '/tmp/linklab-soak-20261012';
await mkdir(out, { recursive: true });
const results = [];
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Native adversarial TCP deadline'); await delay(10); }
}
const attack = Buffer.alloc(1_048_577, 1);
for (let cycle = 0; cycle < 30; cycle++) {
  const events = [];
  const service = new TcpService({ emitEvent: (channel, payload) => events.push({ channel, payload }) });
  let healthy;
  let malicious;
  try {
    const endpointId = 'adversarial-server';
    await service.open({ id: endpointId, name: endpointId, transport: 'tcp-server', config: { listenHost: '127.0.0.1', listenPort: 0, receiveFraming: { mode: 'delimiter', delimiterBytes: [0] } } }, { operationId: `attack-${cycle}` });
    const port = service.sessions.get(endpointId).server.address().port;
    healthy = net.createConnection({ host: '127.0.0.1', port }); await once(healthy, 'connect');
    malicious = net.createConnection({ host: '127.0.0.1', port }); await once(malicious, 'connect');
    healthy.on('error', () => {}); malicious.on('error', () => {});
    await until(() => events.some((event) => event.channel === 'transport:peers' && event.payload.peers.length === 2));
    const peers = events.filter((event) => event.channel === 'transport:peers').at(-1).payload.peers;
    const attackerId = peers.find((peer) => peer.port === malicious.localPort)?.id;
    malicious.write(attack);
    await until(() => events.some((event) => event.channel === 'transport:status' && /pending.*1048576.*bytes/i.test(event.payload.log?.message ?? '')));
    await until(() => events.filter((event) => event.channel === 'transport:peers').at(-1)?.payload.peers.length === 1);
    healthy.write(Buffer.from([cycle + 2])); await delay(2); healthy.write(Buffer.from([99, 0]));
    await until(() => events.some((event) => event.channel === 'transport:frames' && event.payload.frames.some((frame) => frame.direction === 'in' && JSON.stringify(frame.bytes) === JSON.stringify([cycle + 2, 99]))));
    const frames = events.filter((event) => event.channel === 'transport:frames').flatMap((event) => event.payload.frames);
    assert.ok(frames.every((frame) => frame.peerId !== attackerId));
    assert.equal(service.sessions.get(endpointId).server.listening, true);
    await service.shutdown();
    assert.equal(service.sessions.size, 0);
    results.push({ cycle, oversizedBytes: attack.length, healthyFragmentRecovered: true, truncatedAttackFrames: 0, sessionsAfterShutdown: 0, rss: process.memoryUsage().rss });
  } finally { healthy?.destroy(); malicious?.destroy(); await service.shutdown(); }
}
await writeFile(path.join(out, 'adversarial-electron.json'), JSON.stringify({ success: true, runtime: 'real Electron TCP service with native loopback sockets, no GUI', results }, null, 2));
for (let cycle = 0; cycle < 10; cycle++) {
  const child = spawn('cargo', ['test', '--manifest-path', 'apps/tauri/src-tauri/Cargo.toml', 'pending_frame_overflow_disconnects_only_the_affected_tcp_connection', '--', '--nocapture'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { output += bytes; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  clearTimeout(timeout);
  await writeFile(path.join(out, `adversarial-tauri-${cycle}.log`), output);
  assert.equal(code, 0, output);
  assert.match(output, /1 passed; 0 failed/);
}
console.log(JSON.stringify({ success: true, electronOversizedConnections: 30, electronOversizedBytes: attack.length * 30, tauriNativeOverflowTestRuns: 10, results }));
