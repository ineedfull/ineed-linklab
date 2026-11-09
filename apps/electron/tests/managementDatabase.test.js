import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { normalizeModbusMasterConfig } from '../../../packages/workbench/src/model/modbusMasterConfig.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const databaseModule = path.join(root, 'apps', 'electron', 'electron', 'database.cjs');
const integralNumberFixture = JSON.parse(await readFile(path.join(
  root, 'packages', 'runtime-contract', 'src', 'integralJsonNumbers.json',
), 'utf8'));
const modbusPointHistoryCases = JSON.parse(await readFile(path.join(
  root, 'packages', 'test-contracts', 'fixtures', 'modbusPointHistoryCases.json',
), 'utf8'));

test('real SQLite history queries share filters and use created_at DESC, id DESC paging', async (t) => {
  const fixture = await openFixture(t);
  seedHistory(fixture.filename);

  const first = fixture.database.queryFrames({ endpointId: 'ep-1', page: 1, pageSize: 2 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.rows.map(({ id }) => id), [3, 2]);
  assert.equal(first.rows[0].payloadBase64, Buffer.from('third').toString('base64'));
  assert.equal(first.rows[0].createdAt, 2000);

  const second = fixture.database.queryFrames({ endpointId: 'ep-1', page: 2, pageSize: 2 });
  assert.deepEqual(second.rows.map(({ id }) => id), [1]);
  assert.equal(second.total, 3);

  const searched = fixture.database.queryFrames({
    endpointId: 'ep-1', search: 'second', direction: 'out', from: 1000, to: 2000,
    page: 1, pageSize: 50,
  });
  assert.deepEqual(searched.rows.map(({ id }) => id), [2]);
  assert.equal(searched.total, 1);

  const logs = fixture.database.queryLogs({
    endpointId: 'ep-1', search: 'socket', level: 'error', source: 'transport',
    page: 1, pageSize: 50,
  });
  assert.deepEqual(logs.rows.map(({ id }) => id), [2]);
  assert.deepEqual(logs.rows[0].details, { retry: false });
});

test('Electron history paging matches Rust bounds and rejects unsafe offsets', async (t) => {
  const fixture = await openFixture(t);
  for (const query of [
    { page: 0, pageSize: 50 },
    { page: 1_000_001, pageSize: 50 },
    { page: 1, pageSize: 201 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 200 },
  ]) {
    assert.throws(() => fixture.database.queryFrames(query), /page|offset/i);
    assert.throws(() => fixture.database.queryLogs(query), /page|offset/i);
  }
});

test('send templates can be deleted without affecting endpoint configuration', async (t) => {
  const fixture = await openFixture(t);

  assert.equal(fixture.database.deleteTemplate('template-1'), true);
  assert.deepEqual(fixture.database.listTemplates('ep-1'), []);
  assert.equal(fixture.database.deleteTemplate('template-1'), false);
  assert.equal(fixture.database.listEndpoints().length, 2);
});

test('reading and normalizing a version 2 Modbus master leaves its SQLite row unchanged', async (t) => {
  const fixture = await openFixture(t);
  const config = modbusMasterConfig();
  fixture.database.insertEndpoint({
    id: 'legacy-master', name: 'Legacy master', transport: 'modbus-tcp-master', config,
  });
  const sqlite = new DatabaseSync(fixture.filename);
  t.after(() => sqlite.close());
  const readRawRow = () => ({ ...sqlite.prepare(`
    SELECT config_json, updated_at FROM endpoint_profiles WHERE id = ?
  `).get('legacy-master') });
  const before = readRawRow();

  const loaded = fixture.database.listEndpoints().find(({ id }) => id === 'legacy-master');
  assert.equal(loaded.config.configVersion, 2);
  assert.equal(Object.hasOwn(loaded.config, 'writeCommands'), false);
  assert.deepEqual(readRawRow(), before);

  const normalized = normalizeModbusMasterConfig(loaded.config);
  assert.deepEqual(normalized.writeCommands, []);
  assert.equal(normalized.configVersion, 3);
  assert.deepEqual(readRawRow(), before);
});

test('version 2 Modbus master upgrades explicitly without changing existing history rows or bytes', async (t) => {
  const fixture = await openFixture(t);
  const config = modbusMasterConfig();

  fixture.database.insertEndpoint({
    id: 'modbus-master', name: 'Boiler master', transport: 'modbus-tcp-master', config,
  });
  fixture.database.insertFrameBatch([validFrameRow({
    endpointId: 'modbus-master', payload: Uint8Array.of(0, 128, 255), byteCount: 3,
  })]);
  fixture.database.insertLogBatch([validLogRow({
    endpointId: 'modbus-master', details: { requestGroupId: 'holding' },
  })]);
  fixture.database.recordSendHistory({
    endpointId: 'modbus-master', sessionId: 'session-1', peerId: null,
    target: { unitId: 1 }, format: 'hex', framing: 'none', payloadBase64: 'AID/',
    createdAt: 1_720_000_000_125,
  });
  const beforeHistory = fixture.database.storageStats();
  const beforeRows = {
    frames: fixture.database.queryFrames({ endpointId: 'modbus-master', page: 1, pageSize: 20 }),
    logs: fixture.database.queryLogs({ endpointId: 'modbus-master', page: 1, pageSize: 20 }),
    sends: fixture.database.querySendHistory({ endpointId: 'modbus-master', page: 1, pageSize: 20 }),
  };
  const upgraded = {
    ...config,
    ...normalizeModbusMasterConfig(config),
    description: 'updated without dropping nested configuration',
    writeCommands: modbusWriteCommands(),
  };
  fixture.database.updateEndpoint({
    id: 'modbus-master', name: 'Boiler master updated', transport: 'modbus-tcp-master',
    config: upgraded,
  });

  const saved = fixture.database.listEndpoints().find(({ id }) => id === 'modbus-master');
  const exported = fixture.database.exportWorkspace().endpointProfiles
    .find(({ id }) => id === 'modbus-master');
  assert.equal(saved.config.configVersion, 3);
  assert.equal(saved.config.marker, 'preserved');
  assert.equal(saved.config.requestGroups[0].requests[0].id, 'holding-request');
  assert.deepEqual(saved.config.writeCommands, modbusWriteCommands());
  assert.deepEqual(exported.config.requestGroups, upgraded.requestGroups);
  assert.equal(saved.config.description, 'updated without dropping nested configuration');
  assert.deepEqual({
    frames: fixture.database.queryFrames({ endpointId: 'modbus-master', page: 1, pageSize: 20 }),
    logs: fixture.database.queryLogs({ endpointId: 'modbus-master', page: 1, pageSize: 20 }),
    sends: fixture.database.querySendHistory({ endpointId: 'modbus-master', page: 1, pageSize: 20 }),
  }, beforeRows);
  const afterHistory = fixture.database.storageStats();
  assert.deepEqual({
    frameCount: afterHistory.frameCount,
    logCount: afterHistory.logCount,
    sendHistoryCount: afterHistory.sendHistoryCount,
    totalCount: afterHistory.totalCount,
  }, {
    frameCount: beforeHistory.frameCount,
    logCount: beforeHistory.logCount,
    sendHistoryCount: beforeHistory.sendHistoryCount,
    totalCount: beforeHistory.totalCount,
  });
});

test('workspace version 1 round-trip retains nested Modbus requests and unrelated config keys', async (t) => {
  const source = await openFixture(t);
  const target = await openFixture(t);
  const config = {
    ...modbusMasterConfig(),
    ...normalizeModbusMasterConfig(modbusMasterConfig()),
  };
  config.requestGroups[0].requests[0].enabled = false;
  config.requestGroups[0].requests[0].dataPoints[0].enabled = false;
  config.requestGroups[0].requests[0].dataPoints[0].saveHistory = true;
  config.writeCommands = modbusWriteCommands();
  source.database.insertEndpoint({
    id: 'nested-master', name: 'Nested master', transport: 'modbus-tcp-master', config,
  });

  const exported = source.database.exportWorkspace();
  assert.equal(exported.version, 1);
  const imported = target.database.importWorkspace(exported);
  const restored = imported.endpointProfiles.find(({ id }) => id === 'nested-master');

  assert.deepEqual(restored.config, config);
  assert.equal(restored.config.marker, 'preserved');
  assert.equal(restored.config.requestGroups[0].requests[0].enabled, false);
  assert.equal(restored.config.requestGroups[0].requests[0].dataPoints[0].saveHistory, true);
  assert.deepEqual(restored.config.writeCommands.map(({ id, values, enabled, order }) => ({
    id, values, enabled, order,
  })), [
    { id: 'reset-alarm', values: [true], enabled: false, order: 0 },
    { id: 'set-thresholds', values: [10, 20, 30], enabled: true, order: 1 },
  ]);
});

test('send history records successful payload snapshots and supports endpoint-scoped management', async (t) => {
  const fixture = await openFixture(t);
  const first = fixture.database.recordSendHistory({
    endpointId: 'ep-1', sessionId: 'session-1', peerId: 'peer-1',
    target: { peerId: 'peer-1' }, format: 'hex', framing: 'none',
    payloadBase64: 'AID/', createdAt: 1_720_000_000_111,
  });
  const second = fixture.database.recordSendHistory({
    endpointId: 'ep-1', sessionId: 'session-1', peerId: null,
    target: { broadcast: true }, format: 'text', framing: 'line',
    payloadBase64: 'cGluZw==', createdAt: 1_720_000_000_112,
  });
  fixture.database.recordSendHistory({
    endpointId: 'ep-2', sessionId: null, peerId: null, target: null,
    format: 'text', framing: 'none', payloadBase64: 'b3RoZXI=',
    createdAt: 1_720_000_000_113,
  });

  assert.equal(first.byteCount, 3);
  assert.equal(second.byteCount, 4);
  assert.deepEqual(fixture.database.querySendHistory({
    endpointId: 'ep-1', page: 1, pageSize: 20,
  }), {
    rows: [second, first], total: 2, page: 1, pageSize: 20,
  });
  assert.equal(fixture.database.deleteSendHistory(first.id), true);
  assert.equal(fixture.database.clearSendHistory('ep-1'), 1);
  assert.equal(fixture.database.querySendHistory({ endpointId: 'ep-1' }).total, 0);
  assert.equal(fixture.database.querySendHistory({ endpointId: 'ep-2' }).total, 1);
});

test('Modbus point history records atomic lossless batches and pages by composite identity', async (t) => {
  const fixture = await openFixture(t);
  const rows = [
    validModbusPointHistoryRow({ createdAt: 1_780_000_000_100, value: '18446744073709551615',
      numericValue: null, dataType: 'uint64', displayValue: '18446744073709551615' }),
    validModbusPointHistoryRow({ createdAt: 1_780_000_000_200, value: 25.5 }),
    validModbusPointHistoryRow({ requestGroupId: 'other-group', createdAt: 1_780_000_000_300,
      value: 99, numericValue: 99, displayValue: '99' }),
  ];

  assert.deepEqual(fixture.database.recordModbusPointHistory(rows), { recordedCount: 3 });
  rows[0].raw[0] = 0;
  rows[0].value = 'changed';

  const page = fixture.database.queryModbusPointHistoryRows({
    endpointId: 'ep-1',
    points: [{ requestGroupId: 'environment', requestId: 'holding', pointId: 'temperature' }],
    from: 1_780_000_000_000, to: 1_780_000_001_000, page: 1, pageSize: 50,
  });
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map(({ value }) => value), [25.5, '18446744073709551615']);
  assert.deepEqual(page.rows[1].raw, [0x41cc, 0]);
  assert.equal(page.rows[1].requestGroupId, 'environment');
  assert.equal(page.rows[1].requestId, 'holding');
  assert.equal(Number.isSafeInteger(page.rows[0].id), true);

  assert.throws(() => fixture.database.recordModbusPointHistory([
    validModbusPointHistoryRow({ pointId: 'rolled-back', createdAt: 1_780_000_000_400 }),
    validModbusPointHistoryRow({ endpointId: 'missing', createdAt: 1_780_000_000_500 }),
  ]), /foreign key/i);
  assert.equal(fixture.database.queryModbusPointHistoryRows({
    endpointId: 'ep-1', points: [], from: 0, to: Number.MAX_SAFE_INTEGER,
    page: 1, pageSize: 200,
  }).total, 3);

  assert.throws(() => fixture.database.recordModbusPointHistory([
    validModbusPointHistoryRow({ pointId: 'valid-before-invalid' }),
    validModbusPointHistoryRow({ pointId: 'invalid-json', raw: [Number.NaN] }),
  ]), /JSON|finite/i);
  assert.equal(fixture.database.queryModbusPointHistoryRows({
    endpointId: 'ep-1', points: [], from: 0, to: Number.MAX_SAFE_INTEGER,
    page: 1, pageSize: 200,
  }).total, 3);
});

test('Modbus point history uses row id as the stable same-timestamp paging tie-breaker', async (t) => {
  const fixture = await openFixture(t);
  const createdAt = 1_780_000_200_000;
  fixture.database.recordModbusPointHistory([
    validModbusPointHistoryRow({ createdAt, value: 1, numericValue: 1, displayValue: '1' }),
    validModbusPointHistoryRow({ createdAt, value: 2, numericValue: 2, displayValue: '2' }),
  ]);
  const page = fixture.database.queryModbusPointHistoryRows({
    endpointId: 'ep-1', points: [], from: createdAt, to: createdAt, page: 1, pageSize: 1,
  });
  assert.equal(page.total, 2);
  assert.equal(page.rows[0].value, 2);
});

test('Modbus point series preserves numeric extrema and emits Boolean/String changes', async (t) => {
  const fixture = await openFixture(t);
  const base = 1_780_000_100_000;
  fixture.database.recordModbusPointHistory([
    validModbusPointHistoryRow({ pointId: 'numeric', pointKey: 'numeric', dataType: 'float32',
      createdAt: base, value: 10, numericValue: 10, displayValue: '10' }),
    validModbusPointHistoryRow({ pointId: 'numeric', pointKey: 'numeric', dataType: 'float32',
      createdAt: base + 10, value: 30, numericValue: 30, displayValue: '30' }),
    validModbusPointHistoryRow({ pointId: 'numeric', pointKey: 'numeric', dataType: 'float32',
      createdAt: base + 20, value: null, numericValue: null, displayValue: '—',
      quality: 'bad-communication', reason: 'timeout' }),
    validModbusPointHistoryRow({ pointId: 'numeric', pointKey: 'numeric', dataType: 'float32',
      createdAt: base + 30, value: 20, numericValue: 20, displayValue: '20' }),
    validModbusPointHistoryRow({ pointId: 'switch', pointKey: 'switch', dataType: 'boolean',
      createdAt: base, raw: [false], value: false, numericValue: 0, displayValue: 'OFF' }),
    validModbusPointHistoryRow({ pointId: 'switch', pointKey: 'switch', dataType: 'boolean',
      createdAt: base + 10, raw: [false], value: false, numericValue: 0, displayValue: 'OFF' }),
    validModbusPointHistoryRow({ pointId: 'switch', pointKey: 'switch', dataType: 'boolean',
      createdAt: base + 20, raw: [true], value: true, numericValue: 1, displayValue: 'ON' }),
    validModbusPointHistoryRow({ pointId: 'label', pointKey: 'label', dataType: 'string',
      createdAt: base, raw: [0x4100], value: 'A', numericValue: null, displayValue: 'A' }),
    validModbusPointHistoryRow({ pointId: 'label', pointKey: 'label', dataType: 'string',
      createdAt: base + 10, raw: [0x4100], value: 'A', numericValue: null, displayValue: 'A' }),
    validModbusPointHistoryRow({ pointId: 'label', pointKey: 'label', dataType: 'string',
      createdAt: base + 20, raw: [0x4200], value: 'B', numericValue: null, displayValue: 'B' }),
  ]);

  const result = fixture.database.queryModbusPointSeries({
    endpointId: 'ep-1',
    points: ['numeric', 'switch', 'label'].map((pointId) => ({
      requestGroupId: 'environment', requestId: 'holding', pointId,
    })),
    from: base, to: base + 100, bucketCount: 1,
  });
  assert.deepEqual({ from: result.from, to: result.to }, { from: base, to: base + 100 });
  const numeric = result.series.find(({ pointId }) => pointId === 'numeric');
  assert.equal(numeric.kind, 'numeric');
  assert.deepEqual(numeric.samples, [{
    bucket: 0, firstAt: base, firstValue: 10, lastAt: base + 30, lastValue: 20,
    minAt: base, minValue: 10, maxAt: base + 10, maxValue: 30,
    goodCount: 3, abnormalCount: 1, worstQuality: 'bad-communication',
    marker: { createdAt: base + 20, quality: 'bad-communication', reason: 'timeout' },
  }]);
  assert.deepEqual(
    result.series.find(({ pointId }) => pointId === 'switch').samples
      .map(({ createdAt, value }) => ({ createdAt, value })),
    [{ createdAt: base, value: false }, { createdAt: base + 20, value: true }],
  );
  assert.deepEqual(
    result.series.find(({ pointId }) => pointId === 'label').samples
      .map(({ createdAt, value }) => ({ createdAt, value })),
    [{ createdAt: base, value: 'A' }, { createdAt: base + 20, value: 'B' }],
  );
});

test('Electron SQLite satisfies the shared Modbus point history acceptance fixture', async (t) => {
  const fixture = await openFixture(t, { now: () => modbusPointHistoryCases.retention.referenceTime });
  fixture.database.insertEndpoint({
    id: modbusPointHistoryCases.endpointId,
    name: 'Fixture master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502 },
  });

  assert.deepEqual(
    fixture.database.recordModbusPointHistory(modbusPointHistoryCases.validRows),
    { recordedCount: modbusPointHistoryCases.validRows.length },
  );
  const page = fixture.database.queryModbusPointHistoryRows({
    endpointId: modbusPointHistoryCases.endpointId,
    points: modbusPointHistoryCases.pointIdentities,
    from: modbusPointHistoryCases.range.from,
    to: modbusPointHistoryCases.range.to,
    page: 1,
    pageSize: 4,
  });
  assert.equal(page.total, modbusPointHistoryCases.validRows.length);
  assert.deepEqual(
    page.rows.map(({ displayValue }) => displayValue),
    modbusPointHistoryCases.expected.firstPageDisplayValues,
  );

  const result = fixture.database.queryModbusPointSeries({
    endpointId: modbusPointHistoryCases.endpointId,
    points: modbusPointHistoryCases.pointIdentities,
    ...modbusPointHistoryCases.range,
  });
  assert.deepEqual(
    result.series.find(({ pointId }) => pointId === 'numeric').samples,
    [modbusPointHistoryCases.expected.numericSample],
  );
  assert.deepEqual(
    result.series.find(({ pointId }) => pointId === 'switch').samples
      .map(({ createdAt, value }) => ({ createdAt, value })),
    modbusPointHistoryCases.expected.booleanChanges,
  );
  assert.deepEqual(
    result.series.find(({ pointId }) => pointId === 'label').samples
      .map(({ createdAt, value }) => ({ createdAt, value })),
    modbusPointHistoryCases.expected.stringChanges,
  );

  for (const { row } of modbusPointHistoryCases.invalidRows) {
    assert.throws(() => fixture.database.recordModbusPointHistory([
      validModbusPointHistoryRow({
        endpointId: modbusPointHistoryCases.endpointId,
        pointId: `rollback-${row.pointId}`,
        createdAt: 1060,
      }),
      row,
    ]));
  }
  assert.equal(fixture.database.queryModbusPointHistoryRows({
    endpointId: modbusPointHistoryCases.endpointId,
    points: [], from: 0, to: Number.MAX_SAFE_INTEGER,
  }).total, modbusPointHistoryCases.validRows.length);

  fixture.database.recordModbusPointHistory([modbusPointHistoryCases.csv.row]);
  const csvRow = fixture.database.queryModbusPointHistoryRows({
    endpointId: modbusPointHistoryCases.endpointId,
    points: [{ requestGroupId: 'environment', requestId: 'holding', pointId: 'csv' }],
    from: 0, to: Number.MAX_SAFE_INTEGER,
  }).rows[0];
  assert.equal(csvRow.pointName, modbusPointHistoryCases.csv.row.pointName);
  assert.equal(csvRow.displayValue, modbusPointHistoryCases.csv.row.displayValue);
  assert.equal(csvRow.reason, modbusPointHistoryCases.csv.row.reason);

  for (const retention of modbusPointHistoryCases.retention.values) {
    assert.doesNotThrow(() => fixture.database.cleanupModbusPointHistory(retention));
  }
});

test('Modbus point clear and retention cleanup are isolated from existing history', async (t) => {
  const now = 1_780_100_000_000;
  const fixture = await openFixture(t, { now: () => now });
  fixture.database.insertFrameBatch([validFrameRow()]);
  fixture.database.recordModbusPointHistory([
    validModbusPointHistoryRow({ endpointId: 'ep-1', pointId: 'old', pointKey: 'old',
      createdAt: now - (8 * 86_400_000) }),
    validModbusPointHistoryRow({ endpointId: 'ep-1', pointId: 'recent', pointKey: 'recent',
      createdAt: now - 86_400_000 }),
    validModbusPointHistoryRow({ endpointId: 'ep-2', pointId: 'other', pointKey: 'other',
      createdAt: now - 86_400_000 }),
  ]);

  const before = fixture.database.storageStats();
  assert.equal(before.modbusPointHistoryCount, 3);
  assert.ok(before.modbusPointHistoryEstimatedBytes > 0);
  assert.equal(before.modbusPointHistoryLastCleanupAt, null);
  assert.equal(before.totalCount, 1, 'legacy total retains its existing meaning');

  assert.deepEqual(fixture.database.cleanupModbusPointHistory('7-days'), {
    deletedCount: 1, completedAt: now,
  });
  assert.equal(fixture.database.storageStats().modbusPointHistoryLastCleanupAt, now);
  assert.equal(fixture.database.queryFrames({ endpointId: 'ep-1' }).total, 1);
  assert.equal(fixture.database.clearModbusPointHistory({
    endpointId: 'ep-1',
    points: [{ requestGroupId: 'environment', requestId: 'holding', pointId: 'recent' }],
    from: 0, to: Number.MAX_SAFE_INTEGER,
  }), 1);
  assert.equal(fixture.database.queryModbusPointHistoryRows({
    endpointId: 'ep-2', points: [], from: 0, to: Number.MAX_SAFE_INTEGER,
    page: 1, pageSize: 50,
  }).total, 1);
  assert.deepEqual(fixture.database.cleanupModbusPointHistory('forever'), {
    deletedCount: 0, completedAt: now,
  });
});

test('history batch inserts preserve BLOB bytes, milliseconds, JSON, nulls, and input snapshots', async (t) => {
  const fixture = await openFixture(t);
  assertHistoryBatchMethods(fixture.database);
  const payload = Uint8Array.of(0, 128, 255);
  const details = { path: '/dev/ttyUSB0', settings: [115200, true, null] };
  const frame = validFrameRow({ payload, byteCount: 3, createdAt: 1_720_000_000_123 });
  const log = validLogRow({ details, createdAt: 1_720_000_000_124 });

  fixture.database.insertFrameBatch([frame]);
  fixture.database.insertLogBatch([
    log,
    validLogRow({ sessionId: null, details: null, message: 'closed', createdAt: 1_720_000_000_125 }),
  ]);
  payload.fill(7);
  details.path = 'mutated';
  details.settings[0] = 9600;

  const sqlite = new DatabaseSync(fixture.filename);
  const storedFrame = sqlite.prepare(`
    SELECT typeof(payload) AS payload_type, hex(payload) AS payload_hex,
      byte_count, created_at
    FROM transfer_frames
  `).get();
  const storedLogs = sqlite.prepare(`
    SELECT session_id, details_json, created_at FROM runtime_logs ORDER BY id
  `).all();
  sqlite.close();

  assert.deepEqual({ ...storedFrame }, {
    payload_type: 'blob',
    payload_hex: '0080FF',
    byte_count: 3,
    created_at: 1_720_000_000_123,
  });
  assert.deepEqual(JSON.parse(storedLogs[0].details_json), {
    path: '/dev/ttyUSB0', settings: [115200, true, null],
  });
  assert.equal(storedLogs[0].created_at, 1_720_000_000_124);
  assert.equal(storedLogs[1].session_id, null);
  assert.equal(storedLogs[1].details_json, null);
  assert.equal(storedLogs[1].created_at, 1_720_000_000_125);
});

test('TCP server peer frames and logs preserve peer identity source and exact timestamps', async (t) => {
  const fixture = await openFixture(t);
  assertHistoryBatchMethods(fixture.database);
  const peerId = 'peer-127-0-0-1-51000';
  const frame = validFrameRow({
    endpointId: 'ep-1',
    sessionId: 'tcp-server-session',
    peerId,
    direction: 'in',
    payload: Uint8Array.of(0x41),
    byteCount: 1,
    createdAt: 1_720_000_000_111,
  });
  const log = validLogRow({
    endpointId: 'ep-1',
    sessionId: 'tcp-server-session',
    peerId,
    source: 'tcp',
    message: 'TCP peer connected',
    details: { remoteAddress: '127.0.0.1:51000' },
    createdAt: 1_720_000_000_111,
  });

  fixture.database.insertFrameBatch([frame]);
  fixture.database.insertLogBatch([log]);

  const frames = fixture.database.queryFrames({ endpointId: 'ep-1' }).rows;
  const logPage = fixture.database.queryLogs({ endpointId: 'ep-1', source: 'tcp' });
  const logs = logPage.rows;
  assert.equal(frames.length, 1);
  assert.equal(logPage.total, 1);
  assert.equal(logs.length, 1);
  assert.equal(frames[0].peerId, peerId);
  assert.equal(frames[0].sessionId, 'tcp-server-session');
  assert.equal(frames[0].payloadBase64, Buffer.from([0x41]).toString('base64'));
  assert.equal(frames[0].createdAt, 1_720_000_000_111);
  assert.equal(logs[0].peerId, peerId);
  assert.equal(logs[0].source, 'tcp');
  assert.deepEqual(logs[0].details, { remoteAddress: '127.0.0.1:51000' });
  assert.equal(logs[0].createdAt, 1_720_000_000_111);
});

test('empty history batches are no-ops', async (t) => {
  const fixture = await openFixture(t);
  assertHistoryBatchMethods(fixture.database);

  assert.equal(fixture.database.insertFrameBatch([]), undefined);
  assert.equal(fixture.database.insertLogBatch([]), undefined);
  assert.equal(fixture.database.storageStats().totalCount, 0);
});

test('history batch inserts reject seconds-level timestamps before writing', async (t) => {
  const fixture = await openFixture(t);
  assertHistoryBatchMethods(fixture.database);

  assert.throws(
    () => fixture.database.insertFrameBatch([validFrameRow({ createdAt: 1_720_000_000 })]),
    /createdAt.*millisecond/i,
  );
  assert.throws(
    () => fixture.database.insertLogBatch([validLogRow({ createdAt: 1_720_000_000 })]),
    /createdAt.*millisecond/i,
  );
  assert.equal(fixture.database.storageStats().totalCount, 0);
});

test('history batch inserts reject undefined timestamps before writing any row', async (t) => {
  const fixture = await openFixture(t);
  assertHistoryBatchMethods(fixture.database);

  assert.throws(
    () => fixture.database.insertFrameBatch([
      validFrameRow({ createdAt: 1_720_000_000_126 }),
      validFrameRow({ createdAt: undefined }),
    ]),
    /createdAt.*(timestamp|millisecond)/i,
  );
  assert.throws(
    () => fixture.database.insertLogBatch([
      validLogRow({ createdAt: 1_720_000_000_127 }),
      validLogRow({ createdAt: undefined }),
    ]),
    /createdAt.*(timestamp|millisecond)/i,
  );
  assert.equal(fixture.database.storageStats().totalCount, 0);
});

test('history batch inserts accept epoch millisecond lower bound and reject below it', async (t) => {
  const accepted = await openFixture(t);
  assertHistoryBatchMethods(accepted.database);

  accepted.database.insertFrameBatch([validFrameRow({ createdAt: 1_000_000_000_000 })]);
  accepted.database.insertLogBatch([validLogRow({ createdAt: 1_000_000_000_000 })]);
  assert.equal(accepted.database.storageStats().frameCount, 1);
  assert.equal(accepted.database.storageStats().logCount, 1);

  const rejected = await openFixture(t);
  assertHistoryBatchMethods(rejected.database);
  assert.throws(
    () => rejected.database.insertFrameBatch([validFrameRow({ createdAt: 999_999_999_999 })]),
    /createdAt.*millisecond/i,
  );
  assert.throws(
    () => rejected.database.insertLogBatch([validLogRow({ createdAt: 999_999_999_999 })]),
    /createdAt.*millisecond/i,
  );
  assert.equal(rejected.database.storageStats().totalCount, 0);
});

test('history batches validate and snapshot every row before writing any row', async (t) => {
  const fixture = await openFixture(t);
  assertHistoryBatchMethods(fixture.database);
  const frame = validFrameRow();
  const cyclicDetails = {};
  cyclicDetails.self = cyclicDetails;
  const nullPrototypeDetails = Object.create(null);
  nullPrototypeDetails.value = true;

  for (const invalid of [
    { ...frame, endpointId: '' },
    { ...frame, sessionId: null },
    { ...frame, peerId: 1 },
    { ...frame, direction: 'sideways' },
    { ...frame, format: '' },
    { ...frame, framing: null },
    { ...frame, payload: [0, 128, 255] },
    { ...frame, byteCount: -1 },
    { ...frame, byteCount: 2 },
    { ...frame, createdAt: -1 },
    { ...frame, createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...frame, extra: true },
  ]) {
    assert.throws(() => fixture.database.insertFrameBatch([frame, invalid]), /frame|batch|payload|byte|timestamp|property/i);
    assert.equal(fixture.database.storageStats().frameCount, 0);
  }

  const log = validLogRow();
  for (const invalid of [
    { ...log, endpointId: null },
    { ...log, sessionId: 1 },
    { ...log, peerId: '' },
    { ...log, level: 'trace' },
    { ...log, source: '' },
    { ...log, code: 1 },
    { ...log, message: '' },
    { ...log, details: true },
    { ...log, details: cyclicDetails },
    { ...log, details: nullPrototypeDetails },
    { ...log, details: { unsafe: Number.MAX_SAFE_INTEGER + 1 } },
    { ...log, createdAt: -0 },
    { ...log, extra: true },
  ]) {
    assert.throws(() => fixture.database.insertLogBatch([log, invalid]), /log|batch|details|level|timestamp|property/i);
    assert.equal(fixture.database.storageStats().logCount, 0);
  }

  assert.throws(() => fixture.database.insertFrameBatch(null), /batch|array/i);
  assert.throws(() => fixture.database.insertLogBatch({}), /batch|array/i);
});

test('history batch SQL failures roll back every earlier row in the transaction', async (t) => {
  const fixture = await openFixture(t);
  assertHistoryBatchMethods(fixture.database);
  const sqlite = new DatabaseSync(fixture.filename);
  sqlite.exec(`
    CREATE TRIGGER reject_second_frame
    BEFORE INSERT ON transfer_frames WHEN NEW.byte_count = 2
    BEGIN SELECT RAISE(ABORT, 'injected frame failure'); END;
    CREATE TRIGGER reject_second_log
    BEFORE INSERT ON runtime_logs WHEN NEW.message = 'reject'
    BEGIN SELECT RAISE(ABORT, 'injected log failure'); END;
  `);
  sqlite.close();

  assert.throws(() => fixture.database.insertFrameBatch([
    validFrameRow({ payload: Uint8Array.of(1), byteCount: 1 }),
    validFrameRow({ payload: Uint8Array.of(1, 2), byteCount: 2 }),
  ]), /injected frame failure/);
  assert.equal(fixture.database.storageStats().frameCount, 0);

  assert.throws(() => fixture.database.insertLogBatch([
    validLogRow({ message: 'first' }),
    validLogRow({ message: 'reject' }),
  ]), /injected log failure/);
  assert.equal(fixture.database.storageStats().logCount, 0);
});

test('storage stats include DB WAL SHM bytes and clear preserves configuration', async (t) => {
  const fixture = await openFixture(t);
  seedHistory(fixture.filename);
  const before = fixture.database.storageStats();
  assert.deepEqual({
    frameCount: before.frameCount,
    logCount: before.logCount,
    sendHistoryCount: before.sendHistoryCount,
    totalCount: before.totalCount,
  }, { frameCount: 4, logCount: 2, sendHistoryCount: 1, totalCount: 7 });
  assert.ok(before.diskBytes >= (await stat(fixture.filename)).size);

  const result = fixture.database.clearHistory();
  assert.deepEqual(result, {
    cleared: true, reclaimed: true,
    frameCount: 4, logCount: 2, sendHistoryCount: 1, totalCount: 7,
  });
  assert.deepEqual(fixture.database.storageStats(), {
    frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0,
    modbusPointHistoryCount: 0,
    modbusPointHistoryEstimatedBytes: 0,
    modbusPointHistoryLastCleanupAt: null,
    diskBytes: fixture.database.storageStats().diskBytes,
  });
  assert.deepEqual(fixture.database.listEndpoints().map(({ id }) => id), ['ep-1', 'ep-2']);
  assert.equal(fixture.database.listTemplates('ep-1').length, 1);
  assert.deepEqual(fixture.database.getSettings(), { ...validSettings(), theme: 'dark' });
});

test('clear history reports committed deletion when WAL checkpoint is busy', async (t) => {
  const fixture = await openFixture(t);
  seedHistory(fixture.filename);
  const reader = new DatabaseSync(fixture.filename);
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) FROM transfer_frames').get();
  t.after(() => { reader.exec('ROLLBACK'); reader.close(); });

  const result = fixture.database.clearHistory();
  assert.equal(result.cleared, true);
  assert.equal(result.reclaimed, false);
  assert.match(result.maintenanceError.message, /checkpoint|busy/i);
  assert.equal(fixture.database.storageStats().totalCount, 0);
});

test('clear history reports VACUUM failure after committed deletion without claiming reclaim', async (t) => {
  const fixture = await openFixture(t, {
    vacuum: () => { throw new Error('injected VACUUM failure'); },
  });
  seedHistory(fixture.filename);
  const result = fixture.database.clearHistory();
  assert.equal(result.cleared, true);
  assert.equal(result.reclaimed, false);
  assert.match(result.maintenanceError.message, /VACUUM failure/);
  assert.equal(fixture.database.storageStats().totalCount, 0);
});

test('settings saveAll is atomic when any value cannot be persisted', async (t) => {
  const fixture = await openFixture(t);
  assert.deepEqual(fixture.database.saveSettings({ theme: 'light', largeFont: true }), {
    ...validSettings(), theme: 'light', largeFont: true,
  });
  assert.throws(
    () => fixture.database.saveSettings({ ...validSettings(), previewByteLimit: 1n }),
    /serialize|BigInt/i,
  );
  assert.deepEqual(fixture.database.getSettings(), {
    ...validSettings(), theme: 'light', largeFont: true,
  });
});

test('native settings schema rejects invalid saves and workspace imports without mutation', async (t) => {
  const fixture = await openFixture(t);
  const before = fixture.database.exportWorkspace();
  for (const invalid of [
    { ...validSettings(), futureSetting: true },
    { ...validSettings(), autoScroll: 'yes' },
    { ...validSettings(), realtimeFrameLimit: 0 },
    { ...validSettings(), previewByteLimit: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => fixture.database.saveSettings(invalid), /setting|unknown|integer|boolean|finite/i);
    assert.deepEqual(fixture.database.exportWorkspace(), before);
    assert.throws(
      () => fixture.database.importWorkspace({ ...before, settings: invalid }),
      /setting|unknown|integer|boolean|finite/i,
    );
    assert.deepEqual(fixture.database.exportWorkspace(), before);
  }
  const imported = fixture.database.importWorkspace({
    ...before,
    settings: { theme: 'dark', timeDisplayMode: 'iso' },
  });
  assert.equal(imported.settings.theme, 'dark');
  assert.equal(Object.hasOwn(imported.settings, 'timeDisplayMode'), false);
  assert.equal(Object.hasOwn(fixture.database.exportWorkspace().settings, 'timeDisplayMode'), false);
});

test('settings reads ignore poisoned unknown rows and saveAll removes them', async (t) => {
  const fixture = await openFixture(t);
  const poison = new DatabaseSync(fixture.filename);
  poison.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
  ).run('futureSetting', 'true', Date.now());
  poison.prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at)
    VALUES ('timeDisplayMode', '"iso"', 1720000000123)
  `).run();
  poison.close();

  const recovered = fixture.database.getSettings();
  assert.equal(Object.hasOwn(recovered, 'futureSetting'), false);
  assert.equal(Object.hasOwn(recovered, 'timeDisplayMode'), false);
  assert.equal(recovered.theme, 'dark');
  fixture.database.saveSettings({ ...validSettings(), theme: 'light' });
  const inspect = new DatabaseSync(fixture.filename);
  const keys = inspect.prepare('SELECT key FROM settings ORDER BY key').all().map(({ key }) => key);
  const retiredRows = inspect.prepare("SELECT key FROM settings WHERE key = 'timeDisplayMode'").all();
  inspect.close();
  assert.deepEqual(retiredRows, []);
  assert.deepEqual(keys, Object.keys(validSettings()).sort());
});

test('Electron accepts integral JSON lexical forms and rejects invalid settings and timestamps', async (t) => {
  const fixture = await openFixture(t);
  for (const { lexeme, value } of integralNumberFixture.accepted) {
    const settings = JSON.parse(`{"realtimeFrameLimit":${lexeme}}`);
    if (value >= 1 && value <= 50_000) {
      assert.equal(fixture.database.saveSettings(settings).realtimeFrameLimit, value);
    } else {
      assert.throws(() => fixture.database.saveSettings(settings), /integer|range/i);
    }
    const workspace = JSON.parse(rawWorkspace(lexeme, lexeme));
    workspace.settings.realtimeFrameLimit = 2000;
    fixture.database.importWorkspace(workspace);
    assert.equal(
      fixture.database.listEndpoints().find(({ id }) => id === 'raw-number').createdAt,
      value,
    );
  }

  const before = fixture.database.exportWorkspace();
  for (const { lexeme } of integralNumberFixture.rejected) {
    assert.throws(
      () => fixture.database.saveSettings(JSON.parse(`{"realtimeFrameLimit":${lexeme}}`)),
      /integer|range|JSON|negative zero/i,
    );
    assert.deepEqual(fixture.database.exportWorkspace(), before);
    assert.throws(() => fixture.database.importWorkspace(JSON.parse(rawWorkspace(lexeme, '2000'))));
    assert.deepEqual(fixture.database.exportWorkspace(), before);
    const parsed = JSON.parse(lexeme);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || Object.is(parsed, -0)) {
      assert.throws(() => fixture.database.importWorkspace(JSON.parse(rawWorkspace('2000', lexeme))));
    }
    assert.deepEqual(fixture.database.exportWorkspace(), before);
  }
});

async function openFixture(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ineed-management-'));
  const filename = path.join(directory, 'ineed-dev-tool.db');
  const { openConfigurationDatabase } = await import(databaseModule);
  const database = openConfigurationDatabase(filename, options);
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });
  database.insertEndpoint({ id: 'ep-1', name: 'One', transport: 'tcp-client', config: { host: 'localhost', port: 1 } });
  database.insertEndpoint({ id: 'ep-2', name: 'Two', transport: 'udp-server', config: { port: 2 } });
  database.saveSetting('theme', 'dark');
  database.saveTemplate({
    id: 'template-1', endpointId: 'ep-1', name: 'One', format: 'text', framing: 'none',
    target: null, payloadBase64: Buffer.from('template').toString('base64'),
  });
  return { database, filename };
}

function seedHistory(filename) {
  const sqlite = new DatabaseSync(filename);
  const frame = sqlite.prepare(`
    INSERT INTO transfer_frames
      (endpoint_id, session_id, peer_id, direction, format, framing, payload, byte_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  frame.run('ep-1', 'session', null, 'in', 'text', 'none', Buffer.from('first'), 5, 1000);
  frame.run('ep-1', 'session', 'peer-1', 'out', 'text', 'line', Buffer.from('second'), 6, 2000);
  frame.run('ep-1', 'session', 'peer-1', 'in', 'text', 'none', Buffer.from('third'), 5, 2000);
  frame.run('ep-2', 'session', null, 'in', 'hex', 'none', Buffer.from([1]), 1, 3000);
  sqlite.prepare(`
    INSERT INTO runtime_logs
      (endpoint_id, session_id, peer_id, level, source, code, message, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ep-1', 'session', null, 'info', 'runtime', null, 'opened', null, 1000);
  sqlite.prepare(`
    INSERT INTO runtime_logs
      (endpoint_id, session_id, peer_id, level, source, code, message, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ep-1', 'session', 'peer-1', 'error', 'transport', 'E_SOCKET', 'socket closed', JSON.stringify({ retry: false }), 2000);
  sqlite.prepare(`
    INSERT INTO send_history
      (endpoint_id, session_id, peer_id, target_json, format, framing, payload, byte_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ep-1', 'session', null, null, 'text', 'none', Buffer.from('sent'), 4, 1000);
  sqlite.close();
}

function validSettings() {
  return {
    logLevel: 'info', realtimeFrameLimit: 2000, realtimeLogLimit: 1000,
    previewByteLimit: 4096, defaultFraming: 'none',
    autoScroll: true, theme: 'system', largeFont: false,
    modbusPointHistoryRetention: '30-days', stompProfiles: [], acceptanceWorkspace: '{"version":1,"plans":[],"reports":[]}',
  };
}

function validModbusPointHistoryRow(overrides = {}) {
  return {
    endpointId: 'ep-1', requestGroupId: 'environment', requestId: 'holding',
    pointId: 'temperature', pointKey: 'temperature', pointName: 'Temperature',
    dataType: 'float32', unit: 'C', raw: [0x41cc, 0], value: 25.5,
    numericValue: 25.5, displayValue: '25.5', quality: 'good', reason: null,
    createdAt: 1_780_000_000_000,
    ...overrides,
  };
}

function modbusMasterConfig() {
  return {
    configVersion: 2, marker: 'preserved', host: '192.168.1.20', port: 502, unitId: 1,
    timeoutMs: 1000, retryCount: 2, retryIntervalMs: 200, autoReconnect: true,
    enabled: true, scheduler: { autoStart: true, minGapMs: 50 },
    requestGroups: [{
      id: 'holding', name: 'Environment', enabled: true, order: 0,
      unitId: 1, functionCode: 3, startAddress: 100, quantity: 10,
      intervalMs: 1000, timeoutMs: null, retryCount: null, retryIntervalMs: null,
      dataPoints: [{
        id: 'temperature', key: 'temperature', name: 'Temperature', enabled: true,
        offset: 0, dataType: 'float32', length: 2, byteOrder: 'big-endian',
        wordOrder: 'high-first', bitIndex: null, scale: 0.1, valueOffset: 0,
        unit: 'C', decimals: 1, minimum: -40, maximum: 150,
        invalidPolicy: 'mark-bad', saveHistory: false,
      }],
    }],
  };
}

function modbusWriteCommands() {
  return [
    {
      id: 'reset-alarm', name: 'Reset alarm', description: 'Clear the alarm latch',
      enabled: false, order: 0, unitId: 1, functionCode: 5,
      address: 12, values: [true],
    },
    {
      id: 'set-thresholds', name: 'Set thresholds', description: 'Apply limits',
      enabled: true, order: 1, unitId: 1, functionCode: 16,
      address: 200, values: [10, 20, 30],
    },
  ];
}

function assertHistoryBatchMethods(database) {
  assert.equal(typeof database.insertFrameBatch, 'function');
  assert.equal(typeof database.insertLogBatch, 'function');
}

function validFrameRow(overrides = {}) {
  return {
    endpointId: 'ep-1',
    sessionId: 'session-1',
    peerId: null,
    direction: 'in',
    format: 'hex',
    framing: 'delimiter',
    payload: Uint8Array.of(0, 128, 255),
    byteCount: 3,
    createdAt: 1_720_000_000_123,
    ...overrides,
  };
}

function validLogRow(overrides = {}) {
  return {
    endpointId: 'ep-1',
    sessionId: 'session-1',
    peerId: null,
    level: 'info',
    source: 'serial',
    code: null,
    message: 'opened',
    details: { path: '/dev/ttyUSB0' },
    createdAt: 1_720_000_000_124,
    ...overrides,
  };
}

function rawWorkspace(settingToken, timestampToken) {
  return `{"version":1,"endpointProfiles":[{"id":"raw-number","name":"Raw","transport":"serial","config":{},"createdAt":${timestampToken},"updatedAt":${timestampToken}}],"settings":{"realtimeFrameLimit":${settingToken}},"sendTemplates":[]}`;
}
