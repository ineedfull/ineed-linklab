#!/usr/bin/env node
// Use slow local readers to exercise concurrent large sends on both runtimes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { TcpService } = require('../../apps/electron/electron/tcpService.cjs');
const out = process.env.LINKLAB_SOAK_OUT ?? '/tmp/linklab-concurrent-tcp';
await mkdir(out, { recursive: true });
const payloadBytes = 512 * 1024;
const writers = 4;
const results = [];
for (const transport of ['tcp-client', 'tcp-server']) {
  const service = new TcpService({ emitEvent: () => {} });
  let listener;
  let remote;
  try {
    const id = `concurrent-${transport}`;
    if (transport === 'tcp-client') {
      listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
      const accepted = once(listener, 'connection');
      await service.open({ id, transport, config: { host: '127.0.0.1', port: listener.address().port } }, { operationId: id });
      [remote] = await accepted;
    } else {
      await service.open({ id, transport, config: { listenHost: '127.0.0.1', listenPort: 0 } }, { operationId: id });
      remote = net.createConnection({ host: '127.0.0.1', port: service.sessions.get(id).server.address().port });
      await once(remote, 'connect');
      for (let n = 0; service.sessions.get(id).peers.size === 0; n++) { assert.ok(n < 1000); await delay(5); }
    }
    const chunks = [];
    let receivedBytes = 0;
    remote.on('data', chunk => { chunks.push(chunk); receivedBytes += chunk.length; });
    remote.pause();
    const resume = setTimeout(() => remote.resume(), 100);
    try {
      const acks = await Promise.all(Array.from({ length: writers }, (_, n) => service.send({ endpointId: id, bytes: Array(payloadBytes).fill(n + 1), target: { type: 'broadcast' } })));
      assert.ok(acks.every(ack => !ack.failureCount));
      const deadline = Date.now() + 10_000;
      while (receivedBytes < payloadBytes * writers) { assert.ok(Date.now() < deadline, 'Concurrent TCP receive deadline'); await delay(5); }
    } finally { clearTimeout(resume); }
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, payloadBytes * writers);
    const markers = [];
    for (let start = 0; start < bytes.length; start += payloadBytes) {
      const chunk = bytes.subarray(start, start + payloadBytes);
      assert.ok(chunk.every(byte => byte === chunk[0]), `${transport}: interleaved concurrent payloads`);
      markers.push(chunk[0]);
    }
    assert.deepEqual(markers.sort(), [1, 2, 3, 4]);
    await service.shutdown();
    assert.equal(service.sessions.size, 0);
    results.push({ runtime: 'electron-service', transport, payloadBytes, writers, receivedBytes, interleavedPayloads: 0, sessionsAfterShutdown: 0 });
  } finally {
    remote?.destroy();
    await service.shutdown();
    if (listener) await new Promise(resolve => listener.close(resolve));
  }
}
for (const filter of ['concurrent_tcp_', 'accepted_tcp_stream_completes_a_large_send_under_backpressure']) {
  const child = spawn('cargo', ['test', '--manifest-path', 'apps/tauri/src-tauri/Cargo.toml', filter, '--', '--nocapture'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  await writeFile(path.join(out, `${filter}.log`), output);
  assert.equal(code, 0, output);
  assert.match(output, filter === 'concurrent_tcp_' ? /2 passed; 0 failed/ : /1 passed; 0 failed/);
  results.push({ runtime: 'tauri-service', filter, success: true });
}
const summary = { success: true, results };
await writeFile(path.join(out, 'concurrent-summary.json'), JSON.stringify(summary, null, 2));
console.log(`CONCURRENT_TCP_RESULT=${JSON.stringify(summary)}`);
