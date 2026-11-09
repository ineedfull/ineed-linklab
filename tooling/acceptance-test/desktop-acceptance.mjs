import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOpcuaTestServer } from '../opcua-test/server.mjs';
import { createAcceptanceModbusServer } from './modbusFixture.mjs';
import { runNativeAcceptance } from './nativeHost.mjs';
import { acceptanceDesktopWorkload } from './desktop-workload.mjs';

const runtime = process.argv[2] ?? 'electron';
assert(['electron', 'tauri'].includes(runtime), 'Use electron or tauri');
const out = await mkdtemp(path.join(tmpdir(), `linklab-acceptance-${runtime}-`));
let opcua, modbus;
try {
  opcua = await createOpcuaTestServer();
  modbus = await createAcceptanceModbusServer();
  const result = await runNativeAcceptance({ runtime, out,
    config: { modbusPort: modbus.port, endpointUrl: opcua.endpointUrl, nodes: opcua.nodes },
    workload: acceptanceDesktopWorkload,
  });
  await writeFile(path.join(out, 'native-result.json'), JSON.stringify(result, null, 2));
  assert.equal(result.passed, true, result.error);
  assert(modbus.requests.length >= 3, 'No actual Modbus native traffic');
  assert(modbus.requests.every(request => [1, 2, 3, 4].includes(request.code)), 'Acceptance sent a write');
  const isolation = JSON.parse(await readFile(path.join(out, 'isolation.json'), 'utf8'));
  const databasePath = path.join(isolation.dataPath, 'ineed-dev-tool.db');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM settings WHERE key = 'acceptanceWorkspace'").get();
    assert(row, 'Acceptance document missing from native SQLite');
    const saved = JSON.parse(JSON.parse(row.value));
    assert.deepEqual(saved, result.document, 'Native SQLite differs from reloaded renderer');
    await writeFile(path.join(out, 'sqlite-verification.json'), JSON.stringify({
      databasePath, plans: saved.plans.length, reports: saved.reports.length,
      statuses: saved.reports.map(report => report.status), matchesReloadedRenderer: true,
    }, null, 2));
  } finally { database.close(); }
  result.checks.push('independent read-only SQLite equality');
  if (runtime === 'electron') {
    const report = JSON.parse(await readFile(path.join(out, 'linklab-acceptance-report.json'), 'utf8'));
    assert.equal(report.status, 'stopped');
    const markdown = await readFile(path.join(out, 'linklab-acceptance-report.md'), 'utf8');
    assert(markdown.includes('停止中的原生验收'));
    result.checks.push('actual native JSON/Markdown export');
  }
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ ...result, requests: modbus.requests }, null, 2));
  console.log(JSON.stringify({ passed: true, runtime, out, checks: result.checks, modbusRequests: modbus.requests.length }));
} catch (error) {
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  console.error(`Evidence: ${out}`);
  throw error;
} finally {
  await modbus?.close();
  await opcua?.close();
}
