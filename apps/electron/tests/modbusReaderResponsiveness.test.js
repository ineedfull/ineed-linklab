import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';

test('Darwin RTU input stays responsive while background operations occupy the worker pool', {
  skip: process.platform !== 'darwin', timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linklab-reader-pool-'));
  const slave = path.join(directory, 'slave.pty'), peer = path.join(directory, 'peer.pty');
  const pair = spawn('socat', [`pty,raw,echo=0,link=${slave}`, `pty,raw,echo=0,link=${peer}`], { stdio: 'ignore' });
  let spawnError;
  pair.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (!spawnError && pair.exitCode === null) {
      const exited = new Promise(resolve => pair.once('exit', resolve));
      pair.kill('SIGTERM'); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 3000;
  while (true) {
    if (spawnError) throw spawnError;
    try { await access(slave); await access(peer); break; } catch {
      assert.ok(Date.now() < deadline, 'PTY pair must become available'); await pause(10);
    }
  }
  const fixture = new URL('./fixtures/modbus-reader-responsiveness.cjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [fixture.pathname, slave, peer], {
    timeout: 25_000, env: { ...process.env, UV_THREADPOOL_SIZE: '4' },
  });
  const report = JSON.parse(stdout.trim());
  assert.equal(report.received, 'input-ready', `Serial read waited for unrelated worker jobs: ${report.elapsedMs}ms`);
});
