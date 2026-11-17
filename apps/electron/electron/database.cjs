const { DATABASE_FILENAME, WORKSPACE_VERSION } = require('./database/contracts.cjs');
const {
  plainRow,
  cloneSerializable,
  integerTimestamp,
  requireNonblankString,
  requirePositiveInteger,
} = require('./database/validation.cjs');
const {
  SETTINGS_RULES,
  DEFAULT_SETTINGS,
  normalizeSettings,
  validateSetting,
} = require('./database/settings.cjs');
const { applyMigrations } = require('./database/migrations.cjs');
const {
  queryHistory,
  snapshotHistoryBatch,
  writeHistoryBatch,
  frameForWrite,
  logForWrite,
} = require('./database/history.cjs');
const {
  modbusPointHistoryForWrite,
  normalizeModbusPointHistoryQuery,
  normalizeModbusPointSeriesQuery,
  modbusPointHistorySelection,
  foldModbusPointSeries,
  modbusPointHistoryFromRow,
} = require('./database/pointHistory.cjs');
const {
  endpointForWrite,
  templateForWrite,
  sendHistoryForWrite,
  normalizeSendHistoryQuery,
  workspaceForImport,
  endpointFromRow,
  templateFromRow,
  sendHistoryFromRow,
  cloneOverrides,
} = require('./database/configuration.cjs');
const { statSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const MODBUS_HISTORY_RETENTION_DAYS = Object.freeze({
  '7-days': 7, '30-days': 30, '90-days': 90,
});

function openConfigurationDatabase(filename, maintenance = {}) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new TypeError('filename must be a nonblank string');
  }

  const connection = new DatabaseSync(filename);
  connection.exec('PRAGMA journal_mode=WAL');
  connection.exec('PRAGMA synchronous=NORMAL');
  connection.exec('PRAGMA foreign_keys=ON');
  try {
    applyMigrations(connection);
  } catch (error) {
    connection.close();
    throw error;
  }

  const statements = prepareStatements(connection);
  let modbusPointHistoryLastCleanupAt = null;

  function listEndpoints() {
    return statements.listEndpoints.all().map(endpointFromRow);
  }

  function insertEndpoint(profile) {
    const value = endpointForWrite(profile);
    const now = Date.now();
    statements.insertEndpoint.run(
      value.id,
      value.name,
      value.transport,
      JSON.stringify(value.config),
      now,
      now,
    );
    return endpointById(value.id);
  }

  function updateEndpoint(profile) {
    const value = endpointForWrite(profile);
    const result = statements.updateEndpoint.run(
      value.name,
      value.transport,
      JSON.stringify(value.config),
      Date.now(),
      value.id,
    );
    if (result.changes === 0) throw new RangeError(`Unknown endpoint: ${value.id}`);
    return endpointById(value.id);
  }

  function saveEndpoint(profile) {
    const value = endpointForWrite(profile);
    return statements.endpointById.get(value.id)
      ? updateEndpoint(value)
      : insertEndpoint(value);
  }

  function cloneEndpoint(sourceId, overrides) {
    requireNonblankString(sourceId, 'sourceId');
    const clone = cloneOverrides(overrides);
    const source = endpointById(sourceId);
    if (!source) throw new RangeError(`Unknown endpoint: ${sourceId}`);
    const next = endpointForWrite({
      id: clone.id,
      name: clone.name ?? source.name,
      transport: source.transport,
      config: source.config,
    });
    return insertEndpoint(next);
  }

  function deleteEndpoint(id) {
    requireNonblankString(id, 'id');
    return statements.deleteEndpoint.run(id).changes > 0;
  }

  function saveSetting(key, value) {
    validateSetting(key, value);
    const encoded = JSON.stringify(value);
    statements.saveSetting.run(key, encoded, Date.now());
    return cloneSerializable(value);
  }

  function saveSettings(values) {
    const normalized = normalizeSettings(values);
    const encoded = Object.entries(normalized).map(([key, value]) => [key, JSON.stringify(value)]);
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec('DELETE FROM settings');
      const now = Date.now();
      for (const [key, value] of encoded) statements.saveSetting.run(key, value, now);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
    return getSettings();
  }

  function getSettings() {
    const settings = cloneSerializable(DEFAULT_SETTINGS);
    for (const row of statements.listSettings.all()) {
      if (!SETTINGS_RULES[row.key]) continue;
      try {
        const value = JSON.parse(row.value);
        validateSetting(row.key, value);
        settings[row.key] = value;
      } catch (error) {
        if (row.key === 'acceptanceWorkspace') throw new TypeError('acceptanceWorkspace is corrupt', { cause: error });
        // Invalid legacy values fall back to the shared default and are repaired by saveAll.
      }
    }
    return settings;
  }

  function saveTemplate(template) {
    const value = templateForWrite(template);
    const existing = statements.templateById.get(value.id);
    const now = Date.now();
    statements.saveTemplate.run(
      value.id,
      value.endpointId,
      value.name,
      value.format,
      value.framing,
      value.target === null ? null : JSON.stringify(value.target),
      Buffer.from(value.payloadBase64, 'base64'),
      existing?.created_at ?? now,
      now,
    );
    return templateById(value.id);
  }

  function listTemplates(endpointId) {
    requireNonblankString(endpointId, 'endpointId');
    return statements.listTemplates.all(endpointId).map(templateFromRow);
  }

  function deleteTemplate(id) {
    requireNonblankString(id, 'id');
    return statements.deleteTemplate.run(id).changes > 0;
  }

  function recordSendHistory(record) {
    const value = sendHistoryForWrite(record);
    const result = statements.insertSendHistory.run(
      value.endpointId,
      value.sessionId,
      value.peerId,
      value.target === null ? null : JSON.stringify(value.target),
      value.format,
      value.framing,
      value.payload,
      value.byteCount,
      value.createdAt,
    );
    return sendHistoryById(Number(result.lastInsertRowid));
  }

  function querySendHistory(query = {}) {
    const value = normalizeSendHistoryQuery(query);
    const total = Number(statements.countSendHistory.get(value.endpointId).count);
    const offset = (value.page - 1) * value.pageSize;
    const rows = statements.querySendHistory
      .all(value.endpointId, value.pageSize, offset)
      .map(sendHistoryFromRow);
    return { rows, total, page: value.page, pageSize: value.pageSize };
  }

  function deleteSendHistory(id) {
    requirePositiveInteger(id, 'id');
    return statements.deleteSendHistory.run(id).changes > 0;
  }

  function clearSendHistory(endpointId) {
    requireNonblankString(endpointId, 'endpointId');
    return Number(statements.clearSendHistory.run(endpointId).changes);
  }

  function exportWorkspace() {
    return {
      version: WORKSPACE_VERSION,
      endpointProfiles: listEndpoints(),
      settings: getSettings(),
      sendTemplates: statements.listAllTemplates.all().map(templateFromRow),
    };
  }

  function prepareWorkspaceImport(workspace) {
    const value = workspaceForImport(workspace);
    value.endpointProfiles = value.endpointProfiles.map((profile) => (
      endpointForWrite(profile, { requireTimestamps: true })
    ));
    value.sendTemplates = value.sendTemplates.map((template) => (
      templateForWrite(template, { requireTimestamps: true })
    ));
    const endpointIds = new Set([
      ...listEndpoints().map(({ id }) => id),
      ...value.endpointProfiles.map(({ id }) => id),
    ]);
    for (const template of value.sendTemplates) {
      if (!endpointIds.has(template.endpointId)) {
        throw new TypeError(`send template refers to a missing endpoint: ${template.endpointId}`);
      }
    }
    return value;
  }

  function importWorkspace(workspace) {
    const value = prepareWorkspaceImport(workspace);
    connection.exec('BEGIN IMMEDIATE');
    try {
      for (const profile of value.endpointProfiles) upsertImportedEndpoint(profile);
      connection.exec('DELETE FROM settings');
      for (const [key, setting] of Object.entries(value.settings)) saveSetting(key, setting);
      for (const template of value.sendTemplates) upsertImportedTemplate(template);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
    return exportWorkspace();
  }

  function queryFrames(query = {}) {
    return queryHistory(connection, 'frames', query);
  }

  function queryLogs(query = {}) {
    return queryHistory(connection, 'logs', query);
  }

  function insertFrameBatch(rows) {
    const values = snapshotHistoryBatch(rows, 'frame', frameForWrite);
    writeHistoryBatch(connection, values, statements.insertFrame, (value) => [
      value.endpointId,
      value.sessionId,
      value.peerId,
      value.direction,
      value.format,
      value.framing,
      value.payload,
      value.byteCount,
      value.createdAt,
    ]);
  }

  function insertLogBatch(rows) {
    const values = snapshotHistoryBatch(rows, 'log', logForWrite);
    writeHistoryBatch(connection, values, statements.insertLog, (value) => [
      value.endpointId,
      value.sessionId,
      value.peerId,
      value.level,
      value.source,
      value.code,
      value.message,
      value.detailsJson,
      value.createdAt,
    ]);
  }

  function recordModbusPointHistory(rows) {
    const values = snapshotHistoryBatch(
      rows,
      'Modbus point history',
      modbusPointHistoryForWrite,
    );
    if (values.length > 2_000) {
      throw new TypeError('Modbus point history batch must contain at most 2000 rows');
    }
    writeHistoryBatch(connection, values, statements.insertModbusPointHistory, (value) => [
      value.endpointId,
      value.requestGroupId,
      value.requestId,
      value.pointId,
      value.pointKey,
      value.pointName,
      value.dataType,
      value.unit,
      value.rawJson,
      value.valueJson,
      value.numericValue,
      value.displayValue,
      value.quality,
      value.reason,
      value.createdAt,
    ]);
    return { recordedCount: values.length };
  }

  function queryModbusPointHistoryRows(query) {
    const value = normalizeModbusPointHistoryQuery(query, { page: true });
    const selection = modbusPointHistorySelection(value);
    const offset = (value.page - 1) * value.pageSize;
    if (!Number.isSafeInteger(offset)) throw new TypeError('Modbus point history page offset is too large');
    const total = Number(connection.prepare(
      `SELECT COUNT(*) AS count FROM modbus_point_history WHERE ${selection.where}`,
    ).get(...selection.parameters).count);
    const rows = connection.prepare(`
      SELECT * FROM modbus_point_history
      WHERE ${selection.where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...selection.parameters, value.pageSize, offset).map(modbusPointHistoryFromRow);
    return { rows, total, page: value.page, pageSize: value.pageSize };
  }

  function queryModbusPointSeries(query) {
    const value = normalizeModbusPointSeriesQuery(query);
    const series = [];
    for (const point of value.points) {
      const iterator = connection.prepare(`
        SELECT * FROM modbus_point_history
        WHERE endpoint_id = ? AND request_group_id = ? AND request_id = ? AND point_id = ?
          AND created_at >= ? AND created_at <= ?
        ORDER BY created_at, id
      `).iterate(
        value.endpointId,
        point.requestGroupId,
        point.requestId,
        point.pointId,
        value.from,
        value.to,
      );
      const folded = foldModbusPointSeries(iterator, value);
      if (folded !== null) series.push(folded);
    }
    return { series, from: value.from, to: value.to };
  }

  function clearModbusPointHistory(query) {
    const value = normalizeModbusPointHistoryQuery(query, { page: false });
    const selection = modbusPointHistorySelection(value);
    return Number(connection.prepare(
      `DELETE FROM modbus_point_history WHERE ${selection.where}`,
    ).run(...selection.parameters).changes);
  }

  function cleanupModbusPointHistory(retention) {
    if (retention !== 'forever' && !Object.hasOwn(MODBUS_HISTORY_RETENTION_DAYS, retention)) {
      throw new TypeError('retention must be 7-days, 30-days, 90-days, or forever');
    }
    const completedAt = integerTimestamp(maintenance.now?.() ?? Date.now(), undefined, 'completedAt');
    const deletedCount = retention === 'forever'
      ? 0
      : Number(connection.prepare(
        'DELETE FROM modbus_point_history WHERE created_at < ?',
      ).run(completedAt - (MODBUS_HISTORY_RETENTION_DAYS[retention] * 86_400_000)).changes);
    modbusPointHistoryLastCleanupAt = completedAt;
    return { deletedCount, completedAt };
  }

  function storageStats() {
    const frameCount = Number(connection.prepare('SELECT COUNT(*) AS count FROM transfer_frames').get().count);
    const logCount = Number(connection.prepare('SELECT COUNT(*) AS count FROM runtime_logs').get().count);
    const sendHistoryCount = Number(connection.prepare('SELECT COUNT(*) AS count FROM send_history').get().count);
    const pointHistory = connection.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(
          length(CAST(endpoint_id AS BLOB))
          + length(CAST(request_group_id AS BLOB))
          + length(CAST(request_id AS BLOB))
          + length(CAST(point_id AS BLOB))
          + length(CAST(point_key AS BLOB))
          + length(CAST(point_name AS BLOB))
          + length(CAST(data_type AS BLOB))
          + COALESCE(length(CAST(unit AS BLOB)), 0)
          + length(CAST(raw_json AS BLOB))
          + length(CAST(value_json AS BLOB))
          + length(CAST(display_value AS BLOB))
          + length(CAST(quality AS BLOB))
          + COALESCE(length(CAST(reason AS BLOB)), 0)
          + 16 + CASE WHEN numeric_value IS NULL THEN 0 ELSE 8 END
        ), 0) AS estimated_bytes
      FROM modbus_point_history
    `).get();
    return {
      frameCount,
      logCount,
      sendHistoryCount,
      modbusPointHistoryCount: Number(pointHistory.count),
      modbusPointHistoryEstimatedBytes: Number(pointHistory.estimated_bytes),
      modbusPointHistoryLastCleanupAt,
      totalCount: frameCount + logCount + sendHistoryCount,
      diskBytes: [filename, `${filename}-wal`, `${filename}-shm`]
        .reduce((total, candidate) => total + fileSize(candidate), 0),
    };
  }

  function clearHistory() {
    const before = storageStats();
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec('DELETE FROM transfer_frames; DELETE FROM runtime_logs; DELETE FROM send_history;');
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
    const cleared = {
      cleared: true,
      frameCount: before.frameCount,
      logCount: before.logCount,
      sendHistoryCount: before.sendHistoryCount,
      totalCount: before.totalCount,
    };
    try {
      const checkpoint = maintenance.checkpoint
        ? maintenance.checkpoint(connection)
        : connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      const values = Object.values(checkpoint ?? {});
      const busy = Number(checkpoint?.busy ?? values[0] ?? 0);
      const log = Number(checkpoint?.log ?? values[1] ?? 0);
      const checkpointed = Number(checkpoint?.checkpointed ?? values[2] ?? 0);
      if (busy !== 0 || log !== checkpointed) {
        throw new Error(`WAL checkpoint was busy or incomplete (${busy}, ${log}, ${checkpointed})`);
      }
      if (maintenance.vacuum) maintenance.vacuum(connection);
      else connection.exec('VACUUM');
      return { ...cleared, reclaimed: true };
    } catch (error) {
      return {
        ...cleared,
        reclaimed: false,
        maintenanceError: {
          name: 'MaintenanceError',
          code: 'PARTIAL_MAINTENANCE',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  function upsertImportedEndpoint(profile) {
    const value = endpointForWrite(profile, { requireTimestamps: true });
    const now = Date.now();
    const createdAt = integerTimestamp(value.createdAt, now, 'createdAt');
    const updatedAt = integerTimestamp(value.updatedAt, createdAt, 'updatedAt');
    statements.upsertImportedEndpoint.run(
      value.id,
      value.name,
      value.transport,
      JSON.stringify(value.config),
      createdAt,
      updatedAt,
    );
  }

  function upsertImportedTemplate(template) {
    const value = templateForWrite(template, { requireTimestamps: true });
    const now = Date.now();
    const createdAt = integerTimestamp(value.createdAt, now, 'createdAt');
    const updatedAt = integerTimestamp(value.updatedAt, createdAt, 'updatedAt');
    statements.upsertImportedTemplate.run(
      value.id,
      value.endpointId,
      value.name,
      value.format,
      value.framing,
      value.target === null ? null : JSON.stringify(value.target),
      Buffer.from(value.payloadBase64, 'base64'),
      createdAt,
      updatedAt,
    );
  }

  function endpointById(id) {
    const row = statements.endpointById.get(id);
    return row ? endpointFromRow(row) : null;
  }

  function templateById(id) {
    const row = statements.templateById.get(id);
    return row ? templateFromRow(row) : null;
  }

  function sendHistoryById(id) {
    const row = statements.sendHistoryById.get(id);
    return row ? sendHistoryFromRow(row) : null;
  }

  return {
    appliedMigrations: () => statements.appliedMigrations.all().map(plainRow),
    close: () => connection.close(),
    cloneEndpoint,
    clearHistory,
    clearSendHistory,
    clearModbusPointHistory,
    cleanupModbusPointHistory,
    deleteEndpoint,
    deleteSendHistory,
    deleteTemplate,
    exportWorkspace,
    getSettings,
    importWorkspace,
    prepareWorkspaceImport,
    insertEndpoint,
    insertFrameBatch,
    insertLogBatch,
    listEndpoints,
    listTemplates,
    queryFrames,
    queryLogs,
    queryModbusPointHistoryRows,
    queryModbusPointSeries,
    querySendHistory,
    recordSendHistory,
    recordModbusPointHistory,
    saveSettings,
    pragma(name) {
      if (!['journal_mode', 'synchronous', 'foreign_keys'].includes(name)) {
        throw new RangeError(`Unsupported pragma: ${name}`);
      }
      return connection.prepare(`PRAGMA ${name}`).get()[name];
    },
    saveEndpoint,
    saveSetting,
    saveTemplate,
    storageStats,
    updateEndpoint,
  };
}

function fileSize(filename) {
  try {
    return statSync(filename).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function prepareStatements(connection) {
  return {
    appliedMigrations: connection.prepare('SELECT version, name FROM schema_migrations ORDER BY version'),
    deleteEndpoint: connection.prepare('DELETE FROM endpoint_profiles WHERE id = ?'),
    deleteSendHistory: connection.prepare('DELETE FROM send_history WHERE id = ?'),
    deleteTemplate: connection.prepare('DELETE FROM send_templates WHERE id = ?'),
    endpointById: connection.prepare('SELECT * FROM endpoint_profiles WHERE id = ?'),
    insertEndpoint: connection.prepare(`
      INSERT INTO endpoint_profiles (id, name, transport, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertFrame: connection.prepare(`
      INSERT INTO transfer_frames
        (endpoint_id, session_id, peer_id, direction, format, framing, payload, byte_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertLog: connection.prepare(`
      INSERT INTO runtime_logs
        (endpoint_id, session_id, peer_id, level, source, code, message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertModbusPointHistory: connection.prepare(`
      INSERT INTO modbus_point_history
        (endpoint_id, request_group_id, request_id, point_id, point_key, point_name,
         data_type, unit, raw_json, value_json, numeric_value, display_value, quality,
         reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertSendHistory: connection.prepare(`
      INSERT INTO send_history
        (endpoint_id, session_id, peer_id, target_json, format, framing, payload, byte_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    countSendHistory: connection.prepare(
      'SELECT COUNT(*) AS count FROM send_history WHERE endpoint_id = ?',
    ),
    querySendHistory: connection.prepare(`
      SELECT * FROM send_history WHERE endpoint_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `),
    sendHistoryById: connection.prepare('SELECT * FROM send_history WHERE id = ?'),
    clearSendHistory: connection.prepare('DELETE FROM send_history WHERE endpoint_id = ?'),
    listAllTemplates: connection.prepare('SELECT * FROM send_templates ORDER BY created_at, id'),
    listEndpoints: connection.prepare('SELECT * FROM endpoint_profiles ORDER BY created_at, id'),
    listSettings: connection.prepare('SELECT key, value FROM settings ORDER BY key'),
    listTemplates: connection.prepare(`
      SELECT * FROM send_templates WHERE endpoint_id = ? ORDER BY created_at, id
    `),
    saveSetting: connection.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    saveTemplate: connection.prepare(`
      INSERT INTO send_templates
        (id, endpoint_id, name, format, framing, target_json, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        endpoint_id = excluded.endpoint_id,
        name = excluded.name,
        format = excluded.format,
        framing = excluded.framing,
        target_json = excluded.target_json,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `),
    templateById: connection.prepare('SELECT * FROM send_templates WHERE id = ?'),
    updateEndpoint: connection.prepare(`
      UPDATE endpoint_profiles
      SET name = ?, transport = ?, config_json = ?, updated_at = ?
      WHERE id = ?
    `),
    upsertImportedEndpoint: connection.prepare(`
      INSERT INTO endpoint_profiles (id, name, transport, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        transport = excluded.transport,
        config_json = excluded.config_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `),
    upsertImportedTemplate: connection.prepare(`
      INSERT INTO send_templates
        (id, endpoint_id, name, format, framing, target_json, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        endpoint_id = excluded.endpoint_id,
        name = excluded.name,
        format = excluded.format,
        framing = excluded.framing,
        target_json = excluded.target_json,
        payload = excluded.payload,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `),
  };
}

// Opaque JSON storage: native hosts validate only envelope/counts/UTF-8 bounds.
// Shared acceptanceWorkspace performs strict plan and report validation before use.

// This native boundary also protects direct IPC callers and workspace imports.

module.exports = { DATABASE_FILENAME, WORKSPACE_VERSION, openConfigurationDatabase };
