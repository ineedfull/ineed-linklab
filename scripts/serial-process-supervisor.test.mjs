import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readFirstLine } from '../tooling/serial-test/processSupervisor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = path.join(root, 'tooling/serial-test/pty-loopback.mjs');

test('first-line reader cancels its timeout and listeners after success', async () => {
  const stream = new PassThrough();
  const timers = createTestTimers();
  const line = readFirstLine(stream, 2_000, timers);

  stream.write('4217\nignored');

  assert.equal(await line, '4217');
  assert.equal(timers.size, 0);
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('error'), 0);
});

test('PTY supervisor self-test kills timed-out and TERM-resistant process groups', {
  skip: process.platform === 'win32',
  timeout: 20_000,
}, async () => {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [
    probe,
    '--self-test-process-supervisor',
    '--runtime', 'invalid',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const result = await waitForChildExit(child, 10_000);

    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    assert.ok(Date.now() - startedAt < 9_000, 'successful child timeout timer kept Node alive');
    const match = stdout.match(/^PROCESS_SUPERVISOR_SELF_TEST=(.+)$/m);
    assert.ok(match, stdout);
    assert.deepEqual(JSON.parse(match[1]), {
      timeout: { escalated: true, leaderGone: true, descendantGone: true },
      signal: { escalated: true, leaderGone: true, descendantGone: true },
      naturalExit: true,
      trackedChildren: 0,
    });
  } finally {
    await stopProbe(child);
  }
});

for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`PTY supervisor ${signal} handler kills its managed process group`, {
    skip: process.platform === 'win32',
    timeout: 15_000,
  }, async () => {
    const child = spawn(process.execPath, [
      probe,
      '--self-test-process-supervisor-signal',
      '--runtime', 'invalid',
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      const ready = await waitForMatch(() => stdout,
        /^PROCESS_SUPERVISOR_SIGNAL_READY=(.+)$/m, 8_000);
      const managed = JSON.parse(ready[1]);

      child.kill(signal);
      const result = await waitForChildExit(child);

      assert.deepEqual(result, { code: expectedCode, signal: null }, stderr);
      assert.equal(processExists(managed.leaderPid), false);
      assert.equal(processExists(managed.descendantPid), false);
    } finally {
      await stopProbe(child);
    }
  });
}

test('probe fallback kills detached managed groups when the probe is unresponsive', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const child = spawn(process.execPath, [
    probe,
    '--self-test-process-supervisor-signal',
    '--runtime', 'invalid',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  try {
    const ready = await waitForMatch(() => stdout,
      /^PROCESS_SUPERVISOR_SIGNAL_READY=(.+)$/m, 8_000);
    const managed = JSON.parse(ready[1]);
    child.kill('SIGSTOP');
    const startedAt = Date.now();

    await stopProbe(child, 100);

    assert.ok(Date.now() - startedAt < 2_000, 'fallback ignored its cleanup deadline');
    assert.equal(processExists(managed.leaderPid), false);
    assert.equal(processExists(managed.descendantPid), false);
  } finally {
    await stopProbe(child);
  }
});

async function waitForMatch(read, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = read().match(pattern);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${pattern}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for probe ${child.pid} to exit`));
      }, timeoutMs);
    }
  });
}

async function stopProbe(child, gracefulTimeoutMs = 6_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timeout;
  const stopped = await Promise.race([
    waitForChildExit(child).then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), gracefulTimeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  if (stopped) return;
  for (const processGroup of descendantProcessGroups(child.pid)) {
    try {
      process.kill(-processGroup, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

function descendantProcessGroups(rootPid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parentPid, processGroup]) => [pid, parentPid, processGroup].every(Number.isSafeInteger));
  const rootGroup = rows.find(([pid]) => pid === rootPid)?.[2];
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of rows) {
      if (!descendants.has(parentPid) || descendants.has(pid)) continue;
      descendants.add(pid);
      changed = true;
    }
  }
  return [...new Set(rows
    .filter(([pid, , processGroup]) => descendants.has(pid) && processGroup !== rootGroup)
    .map(([, , processGroup]) => processGroup))];
}

function createTestTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    get size() { return tasks.size; },
  };
}
