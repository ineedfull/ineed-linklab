#!/usr/bin/env node
// Run after desktop-soak has closed its application and native transports.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const out = process.argv[2];
assert.ok(out, 'Usage: node tooling/soak-test/verify-history.mjs <run-directory>');
const summary = JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8'));
assert.equal(summary.success, true);
let data = summary.data;
if (summary.runtime === 'tauri') data = JSON.parse(await readFile(path.join(out, 'isolation.json'), 'utf8')).dataPath;
const database = new DatabaseSync(path.join(data, 'ineed-dev-tool.db'), { readOnly: true });
try {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  assert.deepEqual(integrity.map((row) => row.integrity_check), ['ok']);
  const results = [];
  for (const [endpointId, sent] of Object.entries(summary.sent)) {
    const expected = new Map();
    for (let seq = 1; seq <= sent; seq++) {
      const key = (summary.payloadFormat === 'ascii-sequence-v1' ? Buffer.from(String(seq).padStart(16, '0')) : Buffer.from(Array.from({ length: 16 }, (_, i) => 32 + ((seq + i) % 95)))).toString('hex');
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const sequences = {};
    for (const direction of ['in', 'out']) {
      const rows = database.prepare('SELECT payload, byte_count FROM transfer_frames WHERE endpoint_id = ? AND direction = ? ORDER BY id').all(endpointId, direction);
      assert.equal(rows.length, sent, `${endpointId} ${direction}: history count`);
      const actual = new Map();
      sequences[direction] = rows.map(row => Buffer.from(row.payload).toString('hex'));
      for (const [index, row] of rows.entries()) {
        if (summary.payloadFormat === 'ascii-sequence-v1' && summary.sendMode === 'sequential') assert.equal(Buffer.from(row.payload).toString('ascii'), String(index + 1).padStart(16, '0'), `${endpointId} ${direction}: ordered sequence ${index + 1}`);
        assert.equal(row.byte_count, 16);
        const key = Buffer.from(row.payload).toString('hex');
        actual.set(key, (actual.get(key) ?? 0) + 1);
      }
      assert.deepEqual([...actual].sort(), [...expected].sort(), `${endpointId} ${direction}: payload multiset`);
      results.push({ endpointId, direction, frames: rows.length, payloadBytes: sent * 16, mismatches: 0, orderedSequence: summary.payloadFormat === 'ascii-sequence-v1' && summary.sendMode === 'sequential' });
    }
    // Concurrent IPC commands can arrive in a different order. The stream must
    // preserve the actual outgoing order; the unique multiset above detects gaps.
    if (summary.payloadFormat === 'ascii-sequence-v1') assert.deepEqual(sequences.in, sequences.out, `${endpointId}: incoming wire order differs from outgoing history`);
  }
  const unexpectedErrors = database.prepare("SELECT endpoint_id, code, message FROM runtime_logs WHERE level = 'error'").all();
  assert.deepEqual(unexpectedErrors, []);
  const result = { success: true, runtime: summary.runtime, elapsedMs: summary.elapsedMs, integrity: 'ok', results, unexpectedErrors };
  await writeFile(path.join(out, 'history-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { database.close(); }
