// Real native services without GUI. This adapter is confined to acceptance tests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

export function nativeBridge(runtimeName) {
  const listeners = new Set(), settings = {};
  const emit = event => { for (const listener of listeners) listener(event); };
  let child, service, database, databasePath, sequence = 0, stderr = '';
  const pending = new Map();
  let execute;
  if (runtimeName === 'electron') {
    const { StompTransport } = require('../../apps/electron/electron/stompTransport.cjs');
    service = new StompTransport({ emitEvent: emit });
    execute = request => service.execute(request);
    const directory = mkdtempSync(path.join(tmpdir(), 'linklab-stomp-settings-'));
    databasePath = path.join(directory, 'ineed-dev-tool.db');
    database = require('../../apps/electron/electron/database.cjs').openConfigurationDatabase(databasePath);
  } else {
    child = spawn(path.join(root, 'apps/tauri/src-tauri/target/debug/stomp-harness'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', bytes => { stderr += bytes; });
    createInterface({ input: child.stdout }).on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response.event) { emit(response.event); return; }
      const call = pending.get(response.id);
      if (!call) return;
      pending.delete(response.id); clearTimeout(call.timer);
      if (response.error) call.reject(Object.assign(new Error(response.error.message), response.error));
      else call.resolve(response.result);
    });
    child.on('exit', (code, signal) => {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(`Rust harness exited ${code}/${signal}: ${stderr}`)); }
      pending.clear();
    });
    execute = request => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native action timed out: ${request.action}`)); }, 25000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, request }) + '\n');
    });
  }
  return {
    runtimeName,
    settingsEvidence: databasePath ? { kind: 'real Electron SQLite boundary', databasePath } : { kind: 'in-memory protocol fixture; real Rust settings tested separately in Rust suite' },
    stomp: { execute, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    settings: {
      async getAll() { return database ? database.getSettings() : structuredClone(settings); },
      async save(key, value) { if (database) return database.saveSetting(key, value); settings[key] = structuredClone(value); return { key, value }; },
    },
    async shutdown() {
      listeners.clear();
      if (service) await service.shutdown();
      database?.close();
      if (child) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.stdin.end();
        let forceTimer, deadline;
        const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
        try {
          await Promise.race([exited, new Promise((_, reject) => {
            forceTimer = setTimeout(() => child.kill('SIGKILL'), 4500);
            deadline = setTimeout(() => reject(new Error('Rust harness cleanup deadline')), 6000);
          })]);
        } finally { clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(deadline); }
        assert.equal(pending.size, 0); assert.equal(stderr, '', stderr);
      }
    },
  };
}
