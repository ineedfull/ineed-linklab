#!/usr/bin/env node
// Repeats the existing real Electron/Rust loopback gates in isolated processes.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const durationMs = Number(process.env.LINKLAB_SOAK_MS ?? 1_200_000);
const out = process.env.LINKLAB_SOAK_OUT ?? '/tmp/linklab-soak-20261012';
await mkdir(out, { recursive: true });
const started = Date.now();
const results = [];
let cycle = 0;
async function run(script) {
  const child = spawn(process.execPath, [script], {
    cwd: root, env: { ...process.env, INEED_ALLOW_PTY_SKIP: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  clearTimeout(timer);
  await writeFile(path.join(out, `native-${cycle}-${path.basename(path.dirname(script))}.log`), output);
  if (code !== 0) throw new Error(`${script} failed (${code}): ${output.slice(-4000)}`);
  results.push({ cycle, script, elapsedMs: Date.now() - started, summaries: output.split('\n').filter((line) => line.includes('_RESULT=')) });
}
try {
  do {
    cycle++;
    for (const script of ['tooling/tcp-test/localhost-loopback.mjs', 'tooling/udp-test/localhost-loopback.mjs', 'tooling/serial-test/pty-loopback.mjs', 'tooling/soak-test/serial-latency.mjs']) await run(script);
    console.log(JSON.stringify({ type: 'heartbeat', cycle, elapsedMs: Date.now() - started, completedGates: results.length }));
    await writeFile(path.join(out, 'native-progress.json'), JSON.stringify({ started, cycle, results }, null, 2));
  } while (Date.now() - started < durationMs);
  await writeFile(path.join(out, 'native-summary.json'), JSON.stringify({ success: true, runtime: 'real Electron services and Rust Tauri services, without GUI', started, elapsedMs: Date.now() - started, cycle, results }, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'native-summary.json'), JSON.stringify({ success: false, started, elapsedMs: Date.now() - started, cycle, results, error: error.stack }, null, 2));
  throw error;
}
