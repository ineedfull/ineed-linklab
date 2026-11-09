#!/usr/bin/env node
// Exercise the real serial backend while its receive loop has no incoming data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.LINKLAB_SOAK_OUT ?? '/tmp/linklab-serial-latency';
const out = path.join(base, `serial-latency-${Date.now()}`);
await mkdir(out, { recursive: true });
const socat = spawn('socat', ['-d', '-d', `pty,raw,echo=0,link=${out}/service`, `pty,raw,echo=0,link=${out}/peer`], { stdio: ['ignore', 'ignore', 'pipe'] });
socat.stderr.resume();
let cargo;
let timer;
let output = '';
try {
  let servicePath;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { servicePath = await realpath(path.join(out, 'service')); break; }
    catch { await delay(20); }
  }
  assert.ok(servicePath, 'socat did not create the isolated serial port');
  cargo = spawn('cargo', ['test', '--manifest-path', 'apps/tauri/src-tauri/Cargo.toml', 'idle_native_serial_reads_do_not_starve_outbound_writes', '--', '--ignored', '--nocapture'], {
    cwd: root, env: { ...process.env, INEED_PHASE03_SERVICE_PTY: servicePath }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [cargo.stdout, cargo.stderr]) stream.on('data', chunk => { output += chunk; });
  timer = setTimeout(() => cargo.kill('SIGTERM'), 60_000);
  const [code] = await once(cargo, 'exit');
  await writeFile(path.join(out, 'result.log'), output);
  assert.equal(code, 0, output);
  assert.match(output, /1 passed; 0 failed/);
  const durationsMs = JSON.parse(output.match(/IDLE_SERIAL_WRITE_LATENCIES_MS=(\[[^\]]+\])/)[1]);
  assert.equal(durationsMs.length, 20);
  const result = { success: true, durationsMs, maxMs: Math.max(...durationsMs), out };
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(`SERIAL_LATENCY_RESULT=${JSON.stringify(result)}`);
} finally {
  clearTimeout(timer);
  cargo?.kill('SIGTERM');
  socat.kill('SIGTERM');
  await Promise.race([once(socat, 'exit'), delay(3000)]);
}
