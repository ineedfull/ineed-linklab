const { readFileSync, statSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { types: { isProxy } } = require('node:util');
const { contractAssetPath } = require('./contractAssets.cjs');

const DATABASE_FILENAME = 'ineed-dev-tool.db';
const WORKSPACE_VERSION = 1;
const FRAME_DIRECTIONS = new Set(['in', 'out']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const MODBUS_POINT_DATA_TYPES = new Set([
  'boolean', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
  'float32', 'float64', 'string',
]);
const MODBUS_POINT_QUALITIES = new Set([
  'good', 'uncertain-overflow', 'bad-value', 'bad-communication', 'disabled',
]);
const MODBUS_POINT_QUALITY_RANK = Object.freeze({
  good: 0, disabled: 1, 'uncertain-overflow': 2, 'bad-value': 3, 'bad-communication': 4,
});
const MODBUS_HISTORY_RETENTION_DAYS = Object.freeze({
  '7-days': 7, '30-days': 30, '90-days': 90,
});
const MIN_RUNTIME_HISTORY_TIMESTAMP = 1_000_000_000_000;
const SENSITIVE_KEY = /password|passwd|passphrase|secret|credential|api[_-]?key|token/i;
const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: '001-initial',
    sql: readFileSync(contractAssetPath(
      'persistence-contract', 'migrations', '001-initial.sql',
    ), 'utf8'),
  }),
  Object.freeze({
    version: 2,
    name: '002-modbus-endpoints',
    sql: readFileSync(contractAssetPath(
      'persistence-contract', 'migrations', '002-modbus-endpoints.sql',
    ), 'utf8'),
  }),
  Object.freeze({
    version: 3,
    name: '003-modbus-point-history',
    sql: readFileSync(contractAssetPath(
      'persistence-contract', 'migrations', '003-modbus-point-history.sql',
    ), 'utf8'),
  }),
  Object.freeze({
    version: 4,
    name: '004-dlt645-endpoints',
    sql: readFileSync(contractAssetPath(
      'persistence-contract', 'migrations', '004-dlt645-endpoints.sql',
    ), 'utf8'),
  }),
  Object.freeze({
    version: 5,
    name: '005-dlt645-simulator-endpoints',
    sql: readFileSync(contractAssetPath(
      'persistence-contract', 'migrations', '005-dlt645-simulator-endpoints.sql',
    ), 'utf8'),
  }),
  Object.freeze({version: 6, name: '006-websocket-endpoints', sql: readFileSync(contractAssetPath('persistence-contract', 'migrations', '006-websocket-endpoints.sql'), 'utf8')}),
]);
const REQUIRED_SCHEMA_TABLES = Object.freeze([
  'endpoint_profiles',
  'modbus_point_history',
  'runtime_logs',
  'schema_migrations',
  'send_history',
  'send_templates',
  'settings',
  'transfer_frames',
]);
const SETTINGS_SCHEMA = JSON.parse(readFileSync(contractAssetPath(
  'runtime-contract', 'src', 'settingsSchema.json',
), 'utf8'));
const SETTINGS_RULES = SETTINGS_SCHEMA.settings;
const RETIRED_IMPORT_SETTING_KEYS = new Set(['timeDisplayMode']);
const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS_RULES).map(([key, rule]) => [key, rule.default]),
));

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

function queryHistory(connection, kind, rawQuery) {
  const query = normalizeHistoryQuery(rawQuery);
  const isFrames = kind === 'frames';
  const table = isFrames ? 'transfer_frames' : 'runtime_logs';
  const conditions = [];
  const values = [];
  const add = (sql, value) => {
    conditions.push(sql);
    values.push(value);
  };
  if (query.endpointId) add('endpoint_id = ?', query.endpointId);
  if (query.from !== null) add('created_at >= ?', query.from);
  if (query.to !== null) add('created_at <= ?', query.to);
  if (isFrames && query.direction) add('direction = ?', query.direction);
  if (!isFrames && query.level) add('level = ?', query.level);
  if (!isFrames && query.source) add('source = ?', query.source);
  if (query.search) {
    const escaped = `%${query.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    add(
      isFrames
        ? "CAST(payload AS TEXT) LIKE ? ESCAPE '\\'"
        : "(message LIKE ? ESCAPE '\\' OR COALESCE(code, '') LIKE ? ESCAPE '\\' OR COALESCE(details_json, '') LIKE ? ESCAPE '\\')",
      escaped,
    );
    if (!isFrames) values.push(escaped, escaped);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(connection.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...values).count);
  const offset = (query.page - 1) * query.pageSize;
  const rows = connection.prepare(
    `SELECT * FROM ${table}${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...values, query.pageSize, offset).map(isFrames ? frameFromRow : logFromRow);
  return { rows, total, page: query.page, pageSize: query.pageSize };
}

function normalizeHistoryQuery(value) {
  if (!isPlainObject(value)) throw new TypeError('history query must be an object');
  const page = value.page ?? 1;
  const pageSize = value.pageSize ?? 50;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
    throw new TypeError('page must be an integer from 1 to 1000000');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new TypeError('pageSize must be an integer from 1 to 200');
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new TypeError('history page offset is too large');
  for (const key of ['endpointId', 'search', 'direction', 'level', 'source']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new TypeError(`${key} must be a string`);
  }
  for (const key of ['from', 'to']) {
    if (value[key] !== undefined && value[key] !== null
      && (!Number.isSafeInteger(value[key]) || value[key] < 0)) {
      throw new TypeError(`${key} must be a timestamp`);
    }
  }
  return {
    endpointId: value.endpointId?.trim() || '',
    search: value.search?.trim() || '',
    direction: value.direction?.trim() || '',
    level: value.level?.trim() || '',
    source: value.source?.trim() || '',
    from: value.from ?? null,
    to: value.to ?? null,
    page,
    pageSize,
  };
}

function frameFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    sessionId: row.session_id,
    peerId: row.peer_id,
    direction: row.direction,
    format: row.format,
    framing: row.framing,
    payloadBase64: Buffer.from(row.payload).toString('base64'),
    byteCount: Number(row.byte_count),
    createdAt: Number(row.created_at),
  };
}

function logFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    sessionId: row.session_id,
    peerId: row.peer_id,
    level: row.level,
    source: row.source,
    code: row.code,
    message: row.message,
    details: row.details_json === null ? null : JSON.parse(row.details_json),
    createdAt: Number(row.created_at),
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

function applyMigrations(connection) {
  const tables = listSchemaTables(connection);
  if (tables.length === 0) {
    for (const migration of MIGRATIONS) connection.exec(migration.sql);
    verifyMigrationSchema(connection);
    return;
  }
  if (!tables.includes('schema_migrations')) {
    throw migrationError('migration ledger is missing from an existing database');
  }

  const rows = connection.prepare(
    'SELECT version, name FROM schema_migrations ORDER BY version',
  ).all().map(plainRow);
  if (rows.length === 0) throw migrationError('migration ledger is empty');
  const unknownAhead = rows.find((row) => row.version > MIGRATIONS.at(-1).version);
  if (unknownAhead) {
    throw migrationError(`migration ledger contains unknown version ${unknownAhead.version}`);
  }
  if (rows.length > MIGRATIONS.length) {
    throw migrationError(`migration ledger contains unknown version ${rows.at(-1).version}`);
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = MIGRATIONS[index];
    if (row.version !== expected.version || row.name !== expected.name) {
      throw migrationError(
        `migration ledger entry ${index + 1} must be ${expected.version}:${expected.name}`,
      );
    }
  }
  for (const migration of MIGRATIONS.slice(rows.length)) {
    try {
      connection.exec(migration.sql);
    } catch (error) {
      throw migrationError(
        `migration schema update ${migration.version}:${migration.name} failed: ${error.message}`,
      );
    }
  }
  verifyMigrationSchema(connection);
}

function listSchemaTables(connection) {
  return connection.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => name);
}

function verifyMigrationSchema(connection) {
  const tables = new Set(listSchemaTables(connection));
  const missing = REQUIRED_SCHEMA_TABLES.filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw migrationError(`migration schema is incomplete; missing: ${missing.join(', ')}`);
  }
}

function migrationError(message) {
  const error = new Error(message);
  error.name = 'PersistenceMigrationError';
  error.code = 'MIGRATION_ERROR';
  return error;
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

function snapshotHistoryBatch(rows, kind, normalizeRow) {
  const label = `${kind} batch`;
  if (!Array.isArray(rows) || isProxy(rows) || Object.getPrototypeOf(rows) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const keys = Reflect.ownKeys(rows).filter((key) => key !== 'length');
  if (keys.length !== rows.length || keys.some((key, index) => key !== String(index))) {
    throw new TypeError(`${label} must be dense and contain no extra properties`);
  }

  return keys.map((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(rows, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}[${index}] must be an enumerable data value`);
    }
    return normalizeRow(descriptor.value, `${kind} row`);
  });
}

function writeHistoryBatch(connection, values, statement, parametersFor) {
  if (values.length === 0) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    for (const value of values) statement.run(...parametersFor(value));
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

function modbusPointHistoryForWrite(row, label) {
  const value = snapshotRecord(row, {
    label,
    requiredKeys: [
      'endpointId', 'requestGroupId', 'requestId', 'pointId', 'pointKey', 'pointName',
      'dataType', 'unit', 'raw', 'value', 'numericValue', 'displayValue', 'quality',
      'reason', 'createdAt',
    ],
  });
  for (const key of ['endpointId', 'requestGroupId', 'requestId', 'pointId', 'pointKey']) {
    requireBoundedId(value[key], `${label}.${key}`);
  }
  requireNonblankString(value.pointName, `${label}.pointName`);
  if (!MODBUS_POINT_DATA_TYPES.has(value.dataType)) {
    throw new TypeError(`${label}.dataType is invalid`);
  }
  requireNullableString(value.unit, `${label}.unit`);
  if (!Array.isArray(value.raw)) throw new TypeError(`${label}.raw must be an array`);
  const rawJson = snapshotJsonValue(value.raw, `${label}.raw`);
  const valueJson = snapshotJsonValue(value.value, `${label}.value`);
  if (value.numericValue !== null
    && (typeof value.numericValue !== 'number' || !Number.isFinite(value.numericValue))) {
    throw new TypeError(`${label}.numericValue must be a finite number or null`);
  }
  requireNonblankString(value.displayValue, `${label}.displayValue`);
  if (!MODBUS_POINT_QUALITIES.has(value.quality)) {
    throw new TypeError(`${label}.quality is invalid`);
  }
  requireNullableString(value.reason, `${label}.reason`);
  return {
    endpointId: value.endpointId,
    requestGroupId: value.requestGroupId,
    requestId: value.requestId,
    pointId: value.pointId,
    pointKey: value.pointKey,
    pointName: value.pointName,
    dataType: value.dataType,
    unit: value.unit,
    rawJson,
    valueJson,
    numericValue: value.numericValue === null || !Object.is(value.numericValue, -0)
      ? value.numericValue
      : 0,
    displayValue: value.displayValue,
    quality: value.quality,
    reason: value.reason,
    createdAt: integerTimestamp(value.createdAt, undefined, `${label}.createdAt`),
  };
}

function normalizeModbusPointHistoryQuery(value, { page }) {
  const query = snapshotRecord(value, {
    label: 'Modbus point history query',
    requiredKeys: ['endpointId'],
    optionalKeys: ['points', 'from', 'to', 'page', 'pageSize'],
  });
  requireBoundedId(query.endpointId, 'query.endpointId');
  const from = query.from === undefined ? 0 : integerTimestamp(query.from, undefined, 'query.from');
  const to = query.to === undefined
    ? Number.MAX_SAFE_INTEGER
    : integerTimestamp(query.to, undefined, 'query.to');
  if (from > to) throw new TypeError('query.from must be less than or equal to query.to');
  const result = {
    endpointId: query.endpointId,
    points: normalizeModbusPointIdentities(query.points, { required: false }),
    from,
    to,
  };
  if (page) {
    result.page = boundedInteger(query.page, 1, 1, Number.MAX_SAFE_INTEGER, 'query.page');
    result.pageSize = boundedInteger(query.pageSize, 50, 1, 200, 'query.pageSize');
  }
  return result;
}

function normalizeModbusPointSeriesQuery(value) {
  const query = snapshotRecord(value, {
    label: 'Modbus point series query',
    requiredKeys: ['endpointId', 'points', 'from', 'to', 'bucketCount'],
  });
  const normalized = normalizeModbusPointHistoryQuery({
    endpointId: query.endpointId,
    points: query.points,
    from: query.from,
    to: query.to,
  }, { page: false });
  normalized.points = normalizeModbusPointIdentities(query.points, { required: true });
  normalized.bucketCount = boundedInteger(
    query.bucketCount,
    undefined,
    1,
    2_000,
    'query.bucketCount',
  );
  return normalized;
}

function normalizeModbusPointIdentities(value, { required }) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('query.points must be an array');
  }
  const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new TypeError('query.points must be dense and contain no extra properties');
  }
  if ((required && value.length === 0) || value.length > 6) {
    throw new TypeError('query.points must contain one to six point identities');
  }
  const seen = new Set();
  return keys.map((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`query.points[${index}] must be an enumerable data value`);
    }
    const point = snapshotRecord(descriptor.value, {
      label: `query.points[${index}]`,
      requiredKeys: ['requestGroupId', 'requestId', 'pointId'],
    });
    for (const field of ['requestGroupId', 'requestId', 'pointId']) {
      requireBoundedId(point[field], `query.points[${index}].${field}`);
    }
    const identity = {
      requestGroupId: point.requestGroupId,
      requestId: point.requestId,
      pointId: point.pointId,
    };
    const identityKey = JSON.stringify(identity);
    if (seen.has(identityKey)) throw new TypeError('query.points contains duplicate identities');
    seen.add(identityKey);
    return identity;
  });
}

function modbusPointHistorySelection(query) {
  const conditions = ['endpoint_id = ?', 'created_at >= ?', 'created_at <= ?'];
  const parameters = [query.endpointId, query.from, query.to];
  if (query.points.length > 0) {
    conditions.push(`(${query.points.map(() => (
      '(request_group_id = ? AND request_id = ? AND point_id = ?)'
    )).join(' OR ')})`);
    for (const point of query.points) {
      parameters.push(point.requestGroupId, point.requestId, point.pointId);
    }
  }
  return { where: conditions.join(' AND '), parameters };
}

function foldModbusPointSeries(rows, query) {
  let latest = null;
  let previousGoodValue;
  let minimum = null;
  let maximum = null;
  let changeCount = 0;
  let abnormalCount = 0;
  const numericBuckets = new Map();
  const events = [];
  let previousEventSignature;
  const span = Math.max(1, query.to - query.from + 1);

  for (const rawRow of rows) {
    const row = modbusPointHistoryFromRow(rawRow);
    latest = row;
    if (row.quality === 'good') {
      const signature = JSON.stringify(row.value);
      if (previousGoodValue !== undefined && previousGoodValue !== signature) changeCount += 1;
      previousGoodValue = signature;
    } else {
      abnormalCount += 1;
    }
    if (row.numericValue !== null) {
      minimum = minimum === null ? row.numericValue : Math.min(minimum, row.numericValue);
      maximum = maximum === null ? row.numericValue : Math.max(maximum, row.numericValue);
    }

    if (row.dataType !== 'boolean' && row.dataType !== 'string') {
      const bucketNumber = Math.min(
        query.bucketCount - 1,
        Math.floor(((row.createdAt - query.from) * query.bucketCount) / span),
      );
      const bucket = numericBuckets.get(bucketNumber) ?? {
        bucket: bucketNumber,
        firstAt: null,
        firstValue: null,
        lastAt: null,
        lastValue: null,
        minAt: null,
        minValue: null,
        maxAt: null,
        maxValue: null,
        goodCount: 0,
        abnormalCount: 0,
        worstQuality: 'good',
        marker: null,
      };
      if (row.quality === 'good') bucket.goodCount += 1;
      else bucket.abnormalCount += 1;
      if (MODBUS_POINT_QUALITY_RANK[row.quality] > MODBUS_POINT_QUALITY_RANK[bucket.worstQuality]) {
        bucket.worstQuality = row.quality;
      }
      if (row.quality !== 'good'
        && (bucket.marker === null
          || MODBUS_POINT_QUALITY_RANK[row.quality]
            > MODBUS_POINT_QUALITY_RANK[bucket.marker.quality])) {
        bucket.marker = { createdAt: row.createdAt, quality: row.quality, reason: row.reason };
      }
      if (row.numericValue !== null) {
        if (bucket.firstAt === null) {
          bucket.firstAt = row.createdAt;
          bucket.firstValue = row.numericValue;
        }
        bucket.lastAt = row.createdAt;
        bucket.lastValue = row.numericValue;
        if (bucket.minValue === null || row.numericValue < bucket.minValue) {
          bucket.minAt = row.createdAt;
          bucket.minValue = row.numericValue;
        }
        if (bucket.maxValue === null || row.numericValue > bucket.maxValue) {
          bucket.maxAt = row.createdAt;
          bucket.maxValue = row.numericValue;
        }
      }
      numericBuckets.set(bucketNumber, bucket);
    } else {
      const signature = JSON.stringify([row.value, row.quality, row.reason]);
      if (signature !== previousEventSignature) {
        events.push({
          createdAt: row.createdAt,
          value: row.value,
          displayValue: row.displayValue,
          quality: row.quality,
          reason: row.reason,
        });
        previousEventSignature = signature;
      }
    }
  }

  if (latest === null) return null;
  const kind = latest.dataType === 'boolean'
    ? 'boolean'
    : latest.dataType === 'string' ? 'string' : 'numeric';
  return {
    requestGroupId: latest.requestGroupId,
    requestId: latest.requestId,
    pointId: latest.pointId,
    pointKey: latest.pointKey,
    pointName: latest.pointName,
    dataType: latest.dataType,
    unit: latest.unit,
    kind,
    samples: kind === 'numeric'
      ? [...numericBuckets.values()]
      : compactSeriesEvents(events, (query.bucketCount * 2) + 2),
    summary: {
      lastValue: latest.value,
      lastDisplayValue: latest.displayValue,
      lastCreatedAt: latest.createdAt,
      minimum,
      maximum,
      changeCount,
      abnormalCount,
      latestQuality: latest.quality,
    },
  };
}

function compactSeriesEvents(events, limit) {
  if (events.length <= limit) return events;
  const result = [events[0]];
  const interiorCount = limit - 2;
  for (let index = 1; index <= interiorCount; index += 1) {
    result.push(events[Math.floor((index * (events.length - 1)) / (interiorCount + 1))]);
  }
  result.push(events.at(-1));
  return result;
}

function modbusPointHistoryFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    requestGroupId: row.request_group_id,
    requestId: row.request_id,
    pointId: row.point_id,
    pointKey: row.point_key,
    pointName: row.point_name,
    dataType: row.data_type,
    unit: row.unit,
    raw: JSON.parse(row.raw_json),
    value: JSON.parse(row.value_json),
    numericValue: row.numeric_value === null ? null : Number(row.numeric_value),
    displayValue: row.display_value,
    quality: row.quality,
    reason: row.reason,
    createdAt: Number(row.created_at),
  };
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new TypeError(`${label} must be an integer`);
  }
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer`);
  return Math.min(maximum, Math.max(minimum, value));
}

function snapshotJsonValue(value, label) {
  try {
    assertJsonValue(value, new Set(), label);
    assertJsonSafeIntegers(value, label);
    return JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be lossless JSON data: ${error.message}`, { cause: error });
  }
}

function frameForWrite(row, label) {
  const value = snapshotRecord(row, {
    label,
    requiredKeys: [
      'endpointId', 'sessionId', 'peerId', 'direction', 'format', 'framing',
      'payload', 'byteCount', 'createdAt',
    ],
  });
  requireNonblankString(value.endpointId, `${label}.endpointId`);
  requireNonblankString(value.sessionId, `${label}.sessionId`);
  requireNullableNonblankString(value.peerId, `${label}.peerId`);
  if (!FRAME_DIRECTIONS.has(value.direction)) {
    throw new TypeError(`${label}.direction must be in or out`);
  }
  requireNonblankString(value.format, `${label}.format`);
  requireNonblankString(value.framing, `${label}.framing`);
  if (!(value.payload instanceof Uint8Array)) {
    throw new TypeError(`${label}.payload must be a Uint8Array`);
  }
  if (!Number.isSafeInteger(value.byteCount) || value.byteCount < 0
    || Object.is(value.byteCount, -0)) {
    throw new TypeError(`${label}.byteCount must be a nonnegative safe integer`);
  }
  const payload = Buffer.from(value.payload);
  if (payload.byteLength !== value.byteCount) {
    throw new TypeError(`${label}.payload length must equal byteCount`);
  }
  return {
    endpointId: value.endpointId,
    sessionId: value.sessionId,
    peerId: value.peerId,
    direction: value.direction,
    format: value.format,
    framing: value.framing,
    payload,
    byteCount: value.byteCount,
    createdAt: runtimeHistoryTimestamp(value.createdAt, `${label}.createdAt`),
  };
}

function logForWrite(row, label) {
  const value = snapshotRecord(row, {
    label,
    requiredKeys: [
      'endpointId', 'sessionId', 'peerId', 'level', 'source', 'code', 'message',
      'details', 'createdAt',
    ],
  });
  requireNonblankString(value.endpointId, `${label}.endpointId`);
  requireNullableNonblankString(value.sessionId, `${label}.sessionId`);
  requireNullableNonblankString(value.peerId, `${label}.peerId`);
  if (!LOG_LEVELS.has(value.level)) {
    throw new TypeError(`${label}.level must be debug, info, warn, or error`);
  }
  requireNonblankString(value.source, `${label}.source`);
  requireNullableNonblankString(value.code, `${label}.code`);
  requireNonblankString(value.message, `${label}.message`);
  return {
    endpointId: value.endpointId,
    sessionId: value.sessionId,
    peerId: value.peerId,
    level: value.level,
    source: value.source,
    code: value.code,
    message: value.message,
    detailsJson: snapshotDetailsJson(value.details, `${label}.details`),
    createdAt: runtimeHistoryTimestamp(value.createdAt, `${label}.createdAt`),
  };
}

function snapshotDetailsJson(value, label) {
  if (value === null) return null;
  if (typeof value !== 'object' || isProxy(value)) {
    throw new TypeError(`${label} must be a plain JSON object, array, or null`);
  }
  const prototype = Object.getPrototypeOf(value);
  if ((Array.isArray(value) && prototype !== Array.prototype)
    || (!Array.isArray(value) && prototype !== Object.prototype)) {
    throw new TypeError(`${label} must be a plain JSON object, array, or null`);
  }
  try {
    assertJsonValue(value, new Set(), label);
    assertJsonSafeIntegers(value, label);
  } catch (error) {
    throw new TypeError(`${label} must be plain JSON data: ${error.message}`, { cause: error });
  }
  return JSON.stringify(value);
}

function assertJsonSafeIntegers(value, label) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${label} contains an unsafe integer`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) assertJsonSafeIntegers(child, label);
    return;
  }
  for (const child of Object.values(value)) assertJsonSafeIntegers(child, label);
}

function endpointForWrite(profile, { requireTimestamps = false } = {}) {
  const snapshot = snapshotRecord(profile, {
    label: 'endpoint profile',
    requiredKeys: ['id', 'name', 'transport', 'config'],
    optionalKeys: ['createdAt', 'updatedAt'],
  });
  assertJsonObject(snapshot.config, 'config');
  requireNonblankString(snapshot.id, 'id');
  requireNonblankString(snapshot.name, 'name');
  requireNonblankString(snapshot.transport, 'transport');
  if (!['serial', 'tcp-client', 'tcp-server', 'udp-client', 'udp-server', 'websocket-client', 'websocket-server', 'dlt645-master', 'dlt645-slave', 'modbus-tcp-master', 'modbus-tcp-slave', 'modbus-rtu-master', 'modbus-rtu-slave'].includes(snapshot.transport)) throw new TypeError('Unsupported transport');
  if (snapshot.transport.startsWith('websocket-')) {
    if (Object.hasOwn(snapshot.config, 'headers') || Object.hasOwn(snapshot.config, 'websocketHeaders')) {
      throw new TypeError('WebSocket headers are session-only and cannot be saved');
    }
  }
  if (requireTimestamps) requireWorkspaceTimestamps(snapshot, 'endpoint profile');
  validateOptionalTimestamps(snapshot, 'endpoint profile');
  assertNoSensitiveKeys(snapshot);
  const value = cloneSerializable({
    id: snapshot.id,
    name: snapshot.name,
    transport: snapshot.transport,
    config: snapshot.config,
  });
  if (Object.hasOwn(snapshot, 'createdAt')) value.createdAt = snapshot.createdAt;
  if (Object.hasOwn(snapshot, 'updatedAt')) value.updatedAt = snapshot.updatedAt;
  return value;
}

function templateForWrite(template, { requireTimestamps = false } = {}) {
  const snapshot = snapshotRecord(template, {
    label: 'send template',
    requiredKeys: ['id', 'endpointId', 'name', 'format', 'framing', 'target', 'payloadBase64'],
    optionalKeys: ['createdAt', 'updatedAt'],
  });
  assertJsonObjectOrNull(snapshot.target, 'target');
  for (const key of ['id', 'endpointId', 'name', 'format', 'framing', 'payloadBase64']) {
    requireNonblankString(snapshot[key], key);
  }
  const payload = Buffer.from(snapshot.payloadBase64, 'base64');
  if (payload.toString('base64') !== snapshot.payloadBase64) {
    throw new TypeError('payloadBase64 must be canonical base64');
  }
  if (requireTimestamps) requireWorkspaceTimestamps(snapshot, 'send template');
  validateOptionalTimestamps(snapshot, 'send template');
  assertNoSensitiveKeys(snapshot);
  const value = cloneSerializable({
    id: snapshot.id,
    endpointId: snapshot.endpointId,
    name: snapshot.name,
    format: snapshot.format,
    framing: snapshot.framing,
    target: snapshot.target,
    payloadBase64: snapshot.payloadBase64,
  });
  if (Object.hasOwn(snapshot, 'createdAt')) value.createdAt = snapshot.createdAt;
  if (Object.hasOwn(snapshot, 'updatedAt')) value.updatedAt = snapshot.updatedAt;
  return value;
}

function sendHistoryForWrite(record) {
  const snapshot = snapshotRecord(record, {
    label: 'send history',
    requiredKeys: [
      'endpointId', 'sessionId', 'peerId', 'target', 'format', 'framing',
      'payloadBase64', 'createdAt',
    ],
  });
  requireNonblankString(snapshot.endpointId, 'endpointId');
  requireNullableNonblankString(snapshot.sessionId, 'sessionId');
  requireNullableNonblankString(snapshot.peerId, 'peerId');
  requireNonblankString(snapshot.format, 'format');
  requireNonblankString(snapshot.framing, 'framing');
  requireNonblankString(snapshot.payloadBase64, 'payloadBase64');
  assertJsonObjectOrNull(snapshot.target, 'target');
  const payload = Buffer.from(snapshot.payloadBase64, 'base64');
  if (payload.toString('base64') !== snapshot.payloadBase64) {
    throw new TypeError('payloadBase64 must be canonical base64');
  }
  return {
    endpointId: snapshot.endpointId,
    sessionId: snapshot.sessionId,
    peerId: snapshot.peerId,
    target: cloneSerializable(snapshot.target),
    format: snapshot.format,
    framing: snapshot.framing,
    payload,
    byteCount: payload.byteLength,
    createdAt: runtimeHistoryTimestamp(snapshot.createdAt, 'createdAt'),
  };
}

function normalizeSendHistoryQuery(query) {
  const snapshot = snapshotRecord(query, {
    label: 'send history query',
    requiredKeys: ['endpointId'],
    optionalKeys: ['page', 'pageSize'],
  });
  requireNonblankString(snapshot.endpointId, 'endpointId');
  const page = snapshot.page ?? 1;
  const pageSize = snapshot.pageSize ?? 20;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
    throw new TypeError('page must be an integer from 1 to 1000000');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('pageSize must be an integer from 1 to 100');
  }
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw new TypeError('send history page offset is too large');
  }
  return { endpointId: snapshot.endpointId, page, pageSize };
}

function workspaceForImport(workspace) {
  const snapshot = snapshotRecord(workspace, {
    label: 'workspace',
    requiredKeys: ['version', 'endpointProfiles', 'settings', 'sendTemplates'],
  });
  assertJsonValue(snapshot, new Set(), 'workspace');
  if (snapshot.version !== WORKSPACE_VERSION) {
    throw new TypeError(`workspace version must be ${WORKSPACE_VERSION}`);
  }
  if (!Array.isArray(snapshot.endpointProfiles)
    || !isPlainObject(snapshot.settings)
    || !Array.isArray(snapshot.sendTemplates)) {
    throw new TypeError('workspace has an invalid shape');
  }
  assertNoSensitiveKeys(snapshot);
  return cloneSerializable({ ...snapshot, settings: normalizeImportedSettings(snapshot.settings) });
}

function normalizeImportedSettings(values) {
  if (!isPlainObject(values)) throw new TypeError('settings must be an object');
  const currentValues = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (!RETIRED_IMPORT_SETTING_KEYS.has(key)) currentValues[key] = value;
  }
  return normalizeSettings(currentValues);
}

function normalizeSettings(values) {
  if (!isPlainObject(values)) throw new TypeError('settings must be an object');
  const normalized = cloneSerializable(DEFAULT_SETTINGS);
  for (const [key, value] of Object.entries(values)) {
    validateSetting(key, value);
    normalized[key] = value;
  }
  return normalized;
}

function validateSetting(key, value) {
  const rule = SETTINGS_RULES[key];
  if (!rule) throw new TypeError(`unknown setting: ${key}`);
  assertJsonValue(value);
  if (rule.type === 'stomp-profiles') validateStompProfiles(value);
  if (rule.type === 'acceptance-document') validateAcceptanceDocument(value);
  if (rule.type === 'integer' && (
    !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum
  )) throw new TypeError(`${key} must be an integer from ${rule.minimum} to ${rule.maximum}`);
  if (rule.type === 'boolean' && typeof value !== 'boolean') {
    throw new TypeError(`${key} must be boolean`);
  }
  if (rule.type === 'string' && typeof value !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }
  if (rule.enum && !rule.enum.includes(value)) throw new TypeError(`${key} is invalid`);
}

// Opaque JSON storage: native hosts validate only envelope/counts/UTF-8 bounds.
// Shared acceptanceWorkspace performs strict plan and report validation before use.
function validateAcceptanceDocument(value) {
  const invalid = () => { throw new TypeError('acceptanceWorkspace must be a bounded version 1 JSON document'); };
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024) invalid();
  let doc;
  try { doc = JSON.parse(value); } catch { invalid(); }
  if (!isPlainObject(doc) || Object.keys(doc).length !== (Object.hasOwn(doc, 'templates') ? 4 : 3) || doc.version !== 1
    || (Object.hasOwn(doc, 'templates') && (!Array.isArray(doc.templates) || doc.templates.length > 50))
    || !Array.isArray(doc.plans) || doc.plans.length > 50
    || !Array.isArray(doc.reports) || doc.reports.length > 20) invalid();
}

// This native boundary also protects direct IPC callers and workspace imports.
function validateStompProfiles(profiles) {
  const invalid = () => { throw new TypeError('stompProfiles must contain bounded safe STOMP profiles'); };
  const object = (value, keys) => {
    if (!isPlainObject(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) invalid();
  };
  const text = (value, maximum) => typeof value === 'string' && value.length > 0
    && value.length <= maximum && !/[\0\r\n]/.test(value);
  if (!Array.isArray(profiles) || profiles.length > 50) invalid();
  const ids = new Set();
  for (const profile of profiles) {
    object(profile, ['id', 'name', 'mode', 'config', 'subscriptions']);
    if (typeof profile.id !== 'string' || !/^[\w-]{1,80}$/.test(profile.id) || ids.has(profile.id)
      || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 100
      || !['client', 'server'].includes(profile.mode)) invalid();
    ids.add(profile.id);
    const c = profile.config;
    object(c, ['url', 'host', 'autoReconnect', 'heartbeatOutgoing', 'heartbeatIncoming', 'listenHost', 'listenPort', 'path']);
    if (!text(c.url, 4096) || !text(c.host, 255) || !text(c.listenHost, 255)
      || !text(c.path, 1024) || !c.path.startsWith('/') || /[?#]/.test(c.path)
      || typeof c.autoReconnect !== 'boolean' || !Number.isInteger(c.listenPort) || c.listenPort < 1 || c.listenPort > 65535
      || ['heartbeatOutgoing', 'heartbeatIncoming'].some(key => !Number.isInteger(c[key]) || c[key] !== 0 && (c[key] < 1000 || c[key] > 60000))) invalid();
    let url; try { url = new URL(c.url); } catch { invalid(); }
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#]/.test(c.url)) invalid();
    if (!Array.isArray(profile.subscriptions) || profile.subscriptions.length > 100) invalid();
    const subscriptions = new Set();
    for (const subscription of profile.subscriptions) {
      object(subscription, ['id', 'destination', 'ack']);
      if (!text(subscription.id, 128) || subscriptions.has(subscription.id) || !text(subscription.destination, 1024)
        || !['auto', 'client', 'client-individual'].includes(subscription.ack)) invalid();
      subscriptions.add(subscription.id);
    }
  }
}

function endpointFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    config: JSON.parse(row.config_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function templateFromRow(row) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    name: row.name,
    format: row.format,
    framing: row.framing,
    target: row.target_json === null ? null : JSON.parse(row.target_json),
    payloadBase64: Buffer.from(row.payload).toString('base64'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function sendHistoryFromRow(row) {
  return {
    id: Number(row.id),
    endpointId: row.endpoint_id,
    sessionId: row.session_id,
    peerId: row.peer_id,
    target: row.target_json === null ? null : JSON.parse(row.target_json),
    format: row.format,
    framing: row.framing,
    payloadBase64: Buffer.from(row.payload).toString('base64'),
    byteCount: Number(row.byte_count),
    createdAt: Number(row.created_at),
  };
}

function plainRow(row) {
  return Object.fromEntries(Object.entries(row));
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertJsonValue(value, ancestors = new Set(), pathName = 'setting value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidJsonValue(pathName, 'numbers must be finite');
    if (Object.is(value, -0)) throw invalidJsonValue(pathName, 'negative zero cannot round-trip exactly');
    return;
  }
  if (typeof value !== 'object') {
    throw invalidJsonValue(pathName, `${typeof value} is unsupported`);
  }
  if (isProxy(value)) throw invalidJsonValue(pathName, 'proxies are unsupported');
  if (ancestors.has(value)) throw invalidJsonValue(pathName, 'cycles are unsupported');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw invalidJsonValue(pathName, 'arrays must use the standard prototype');
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (keys.length !== value.length
        || keys.some((key, index) => key !== String(index))) {
        throw invalidJsonValue(pathName, 'arrays must be dense and contain no extra properties');
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw invalidJsonValue(`${pathName}[${index}]`, 'array entries must be data values');
        }
        assertJsonValue(descriptor.value, ancestors, `${pathName}[${index}]`);
      }
      return;
    }

    if (!isPlainObject(value)) {
      throw invalidJsonValue(pathName, 'objects must use a plain prototype');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw invalidJsonValue(pathName, 'symbol properties are unsupported');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw invalidJsonValue(`${pathName}.${key}`, 'properties must be enumerable data values');
      }
      assertJsonValue(descriptor.value, ancestors, `${pathName}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertJsonObject(value, pathName) {
  try {
    assertJsonValue(value, new Set(), pathName);
  } catch (error) {
    throw new TypeError(`${pathName} must be a valid JSON object: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${pathName} must be a valid JSON object: must be a plain object`);
  }
}

function assertJsonObjectOrNull(value, pathName) {
  if (value === null) return;
  try {
    assertJsonObject(value, pathName);
  } catch (error) {
    throw new TypeError(`${pathName} must be a valid JSON object or null: ${error.message}`, {
      cause: error,
    });
  }
}

function cloneOverrides(overrides) {
  const snapshot = snapshotRecord(overrides, {
    label: 'clone overrides',
    requiredKeys: ['id'],
    optionalKeys: ['name'],
  });
  requireNonblankString(snapshot.id, 'clone overrides.id');
  if (Object.hasOwn(snapshot, 'name')) {
    requireNonblankString(snapshot.name, 'clone overrides.name');
  }
  return snapshot;
}

function snapshotRecord(value, { label, requiredKeys, optionalKeys = [] }) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (isProxy(value)) throw new TypeError(`${label} must not be a proxy`);
  if (Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol properties`);
    if (!allowedKeys.has(key)) throw new TypeError(`${label} contains unknown property: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(snapshot, key)) throw new TypeError(`${label}.${key} is required`);
  }
  return snapshot;
}

function invalidJsonValue(pathName, reason) {
  return new TypeError(`${pathName} must be a valid JSON value: ${reason}`);
}

function assertNoSensitiveKeys(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertNoSensitiveKeys(child);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new TypeError(`password-like field is not allowed: ${key}`);
    assertNoSensitiveKeys(child);
  }
}

function integerTimestamp(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${name} must be a timestamp`);
  }
  return value;
}

function runtimeHistoryTimestamp(value, name) {
  const timestamp = integerTimestamp(value, undefined, name);
  if (timestamp === undefined || timestamp < MIN_RUNTIME_HISTORY_TIMESTAMP) {
    throw new TypeError(`${name} must be an epoch-millisecond timestamp`);
  }
  return timestamp;
}

function requireWorkspaceTimestamps(value, label) {
  for (const key of ['createdAt', 'updatedAt']) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label}.${key} must be a required workspace timestamp`);
    }
  }
}

function validateOptionalTimestamps(value, label) {
  for (const key of ['createdAt', 'updatedAt']) {
    if (Object.hasOwn(value, key)) integerTimestamp(value[key], undefined, `${label}.${key}`);
  }
}

function requireNonblankString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonblank string`);
  }
}

function requireBoundedId(value, name) {
  requireNonblankString(value, name);
  if (Buffer.byteLength(value, 'utf8') > 128) {
    throw new TypeError(`${name} must be at most 128 bytes`);
  }
}

function requireNullableString(value, name) {
  if (value !== null && typeof value !== 'string') {
    throw new TypeError(`${name} must be a string or null`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function requireNullableNonblankString(value, name) {
  if (value === null) return;
  requireNonblankString(value, name);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = { DATABASE_FILENAME, WORKSPACE_VERSION, openConfigurationDatabase };
