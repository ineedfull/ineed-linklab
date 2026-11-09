import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = path.join(root, 'tooling/serial-test/pty-loopback.mjs');
const missingSocatPath = path.join(root, '.missing-socat-path');
const crossEnv = path.join(root, 'node_modules/cross-env/dist/bin/cross-env.js');

for (const ci of [false, true]) {
  test(`PTY probe fails without socat when CI=${ci ? '1' : 'unset'}`, {
    skip: process.platform === 'win32',
    timeout: 10_000,
  }, async () => {
    const result = await runProbeWithoutSocat({ ci });

    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /socat is not installed/);
    assert.doesNotMatch(result.stdout, /^PHASE03_PTY_SKIPPED=/m);
  });
}

test('PTY probe skips without socat only when explicitly allowed', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const result = await runProbeWithoutSocat({ ci: true, allowSkip: '1' });

  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null },
    result.stderr);
  const match = result.stdout.match(/^PHASE03_PTY_SKIPPED=(.+)$/m);
  assert.ok(match, result.stdout);
  assert.deepEqual(JSON.parse(match[1]), { reason: 'socat-not-installed' });
});

test('PTY probe does not treat a truthy skip value as explicit opt-in', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const result = await runProbeWithoutSocat({ ci: true, allowSkip: 'true' });

  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /socat is not installed/);
  assert.doesNotMatch(result.stdout, /^PHASE03_PTY_SKIPPED=/m);
});

test('Phase 03 verification gate overrides an inherited missing-socat skip', {
  timeout: 10_000,
}, async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const command = manifest.scripts['verify:phase-03'];

  assert.match(command,
    /cross-env INEED_ALLOW_PTY_SKIP=0 node tooling\/serial-test\/pty-loopback\.mjs/);

  if (process.platform === 'win32') return;
  const result = await runGateProbeWithoutSocat();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /socat is not installed/);
  assert.doesNotMatch(result.stdout, /^PHASE03_PTY_SKIPPED=/m);
});

async function runProbeWithoutSocat({ ci, allowSkip }) {
  const env = { ...process.env, PATH: missingSocatPath };
  if (ci) env.CI = '1';
  else delete env.CI;
  if (allowSkip === undefined) delete env.INEED_ALLOW_PTY_SKIP;
  else env.INEED_ALLOW_PTY_SKIP = allowSkip;

  return runChild(process.execPath, [probe], env);
}

function runGateProbeWithoutSocat() {
  return runChild(process.execPath, [
    crossEnv,
    'INEED_ALLOW_PTY_SKIP=0',
    process.execPath,
    probe,
  ], {
    ...process.env,
    CI: '1',
    INEED_ALLOW_PTY_SKIP: '1',
    PATH: missingSocatPath,
  });
}

function runChild(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
