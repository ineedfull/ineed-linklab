// Migration ledger and schema verification. The caller owns the connection.
const { plainRow } = require('./validation.cjs');
const { readFileSync } = require('node:fs');
const { contractAssetPath } = require('../contractAssets.cjs');

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

module.exports = { applyMigrations };
