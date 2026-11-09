import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const migrationFile = new URL('../migrations/001-initial.sql', import.meta.url);
const modbusMigrationFile = new URL('../migrations/002-modbus-endpoints.sql', import.meta.url);
const modbusHistoryMigrationFile = new URL(
  '../migrations/003-modbus-point-history.sql',
  import.meta.url,
);
const dlt645MigrationFile = new URL('../migrations/004-dlt645-endpoints.sql', import.meta.url);
const dlt645SimulatorMigrationFile = new URL(
  '../migrations/005-dlt645-simulator-endpoints.sql',
  import.meta.url,
);
const expectedTables = [
  'endpoint_profiles',
  'runtime_logs',
  'schema_migrations',
  'send_history',
  'send_templates',
  'settings',
  'transfer_frames',
];

async function loadSchemaModule() {
  return import('../src/schema.js');
}

async function readMigrationSource() {
  return readFile(migrationFile, 'utf8');
}

async function withMigratedDatabase(assertions) {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    const beforeMigration = Date.now();
    database.exec(await readMigrationSource());
    const afterMigration = Date.now();
    await assertions(database, { beforeMigration, afterMigration });
  } finally {
    database.close();
  }
}

test('package is private ESM and publishes the schema loader with migrations', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(manifest.name, '@ineed-linklab/persistence-contract');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.exports['./schema.js'], './src/schema.js');
  assert.equal(manifest.exports['./migrations/*'], './migrations/*');
  assert.equal(manifest.files.includes('src/schema.js'), true);
  assert.equal(manifest.files.some((entry) => entry.startsWith('migrations')), true);
});

test('schema loader exposes version 6 without depending on cwd', async () => {
  const { SCHEMA_VERSION, migrationUrl, readMigration } = await loadSchemaModule();

  assert.equal(SCHEMA_VERSION, 6);
  assert.equal(migrationUrl(1).href, migrationFile.href);
  assert.equal(migrationUrl(2).href, modbusMigrationFile.href);
  assert.equal(migrationUrl(3).href, modbusHistoryMigrationFile.href);
  assert.equal(migrationUrl(4).href, dlt645MigrationFile.href);
  assert.equal(migrationUrl(5).href, dlt645SimulatorMigrationFile.href);
  assert.equal(await readMigration(1), await readMigrationSource());
  assert.equal(await readMigration(2), await readFile(modbusMigrationFile, 'utf8'));
  assert.equal(await readMigration(3), await readFile(modbusHistoryMigrationFile, 'utf8'));
  assert.equal(await readMigration(4), await readFile(dlt645MigrationFile, 'utf8'));
  assert.equal(await readMigration(5), await readFile(dlt645SimulatorMigrationFile, 'utf8'));
});

test('migrationUrl returns isolated URLs and reads from the canonical migration', async () => {
  const { migrationUrl, readMigration } = await loadSchemaModule();
  const mutableUrl = migrationUrl(1);

  mutableUrl.pathname = '/mutated-migration.sql';

  const laterUrl = migrationUrl(1);
  assert.notEqual(laterUrl, mutableUrl);
  assert.equal(laterUrl.href, migrationFile.href);
  assert.equal(await readMigration(1), await readMigrationSource());
});

test('migrationUrl clearly rejects invalid and unsupported versions', async () => {
  const { migrationUrl } = await loadSchemaModule();

  for (const version of [undefined, null, '1', 0, -1, 1.5, Number.NaN]) {
    assert.throws(() => migrationUrl(version), /invalid migration version/i);
  }
  assert.throws(() => migrationUrl(7), /unsupported migration version: 7/i);
});

test('all migrations add exact Modbus point history schema without changing existing rows', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(await readMigrationSource());
    database.exec(`
      INSERT INTO endpoint_profiles
        (id, name, transport, config_json, created_at, updated_at)
      VALUES ('master-1', 'Master', 'tcp-client', '{"marker":"unchanged"}', 10, 11)
    `);
    database.exec(await readFile(modbusMigrationFile, 'utf8'));
    database.exec(await readFile(modbusHistoryMigrationFile, 'utf8'));
    database.exec(await readFile(dlt645MigrationFile, 'utf8'));
    database.exec(await readFile(dlt645SimulatorMigrationFile, 'utf8'));

    assert.deepEqual(database.prepare('SELECT * FROM endpoint_profiles').all().map((row) => ({
      ...row,
    })), [{
      id: 'master-1', name: 'Master', transport: 'tcp-client',
      config_json: '{"marker":"unchanged"}', created_at: 10, updated_at: 11,
    }]);
    assertColumns(database, 'modbus_point_history', {
      id: ['INTEGER', 0], endpoint_id: ['TEXT', 1], request_group_id: ['TEXT', 1],
      request_id: ['TEXT', 1], point_id: ['TEXT', 1], point_key: ['TEXT', 1],
      point_name: ['TEXT', 1], data_type: ['TEXT', 1], unit: ['TEXT', 0],
      raw_json: ['TEXT', 1], value_json: ['TEXT', 1], numeric_value: ['REAL', 0],
      display_value: ['TEXT', 1], quality: ['TEXT', 1], reason: ['TEXT', 0],
      created_at: ['INTEGER', 1],
    });

    const foreignKey = database.prepare('PRAGMA foreign_key_list(modbus_point_history)')
      .all()
      .find(({ from }) => from === 'endpoint_id');
    assert.deepEqual(
      { table: foreignKey?.table, to: foreignKey?.to, onDelete: foreignKey?.on_delete },
      { table: 'endpoint_profiles', to: 'id', onDelete: 'CASCADE' },
    );

    const indexes = database.prepare('PRAGMA index_list(modbus_point_history)').all()
      .filter(({ origin }) => origin === 'c');
    assert.equal(indexes.length, 3);
    assert.deepEqual(indexes.map(({ name }) => name).sort(), [
      'modbus_point_history_by_point',
      'modbus_point_history_by_request',
      'modbus_point_history_by_retention',
    ]);
    assert.deepEqual(
      indexKeyColumns(database, 'modbus_point_history_by_point')
        .map(({ name, desc }) => [name, desc]),
      [
        ['endpoint_id', 0], ['request_group_id', 0], ['request_id', 0], ['point_id', 0],
        ['created_at', 1], ['id', 1],
      ],
    );
    assert.deepEqual(database.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all().map((row) => ({ ...row })), [
      { version: 1, name: '001-initial' },
      { version: 2, name: '002-modbus-endpoints' },
      { version: 3, name: '003-modbus-point-history' },
      { version: 4, name: '004-dlt645-endpoints' },
      { version: 5, name: '005-dlt645-simulator-endpoints' },
    ]);
    database.prepare(`
      INSERT INTO endpoint_profiles
        (id, name, transport, config_json, created_at, updated_at)
      VALUES (?, ?, 'dlt645-slave', ?, ?, ?)
    `).run('simulator-1', 'Simulator', '{"meters":[]}', 12, 13);
    assert.equal(
      database.prepare('SELECT transport FROM endpoint_profiles WHERE id = ?')
        .get('simulator-1').transport,
      'dlt645-slave',
    );
  } finally {
    database.close();
  }
});

test('migration source contains required constraints and excludes out-of-scope fields', async () => {
  const sql = await readMigrationSource();

  assert.match(sql, /config_json\s+TEXT\s+NOT\s+NULL/i);
  assert.match(sql, /transport\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*transport\s+IN\s*\(\s*'serial'\s*,\s*'tcp-client'\s*,\s*'tcp-server'\s*,\s*'udp-client'\s*,\s*'udp-server'\s*\)\s*\)/i);
  assert.match(sql, /direction\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*direction\s+IN\s*\(\s*'in'\s*,\s*'out'\s*\)\s*\)/i);
  assert.doesNotMatch(sql, /payload_hex/i);
  assert.doesNotMatch(sql, /mqtt/i);
});

test('migration executes on an empty database and creates exactly the seven contract tables', async () => {
  await withMigratedDatabase((database) => {
    const tables = database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name);

    assert.deepEqual(tables, expectedTables);
  });
});

test('migration defines the complete required column contracts', async () => {
  await withMigratedDatabase((database) => {
    assertColumns(database, 'endpoint_profiles', {
      id: ['TEXT', 1],
      name: ['TEXT', 1],
      transport: ['TEXT', 1],
      config_json: ['TEXT', 1],
      created_at: ['INTEGER', 1],
      updated_at: ['INTEGER', 1],
    });
    assertColumns(database, 'transfer_frames', {
      id: ['INTEGER', 0],
      endpoint_id: ['TEXT', 1],
      session_id: ['TEXT', 1],
      peer_id: ['TEXT', 0],
      direction: ['TEXT', 1],
      format: ['TEXT', 1],
      framing: ['TEXT', 1],
      payload: ['BLOB', 1],
      byte_count: ['INTEGER', 1],
      created_at: ['INTEGER', 1],
    });
    assertColumns(database, 'runtime_logs', {
      id: ['INTEGER', 0],
      endpoint_id: ['TEXT', 1],
      session_id: ['TEXT', 0],
      peer_id: ['TEXT', 0],
      level: ['TEXT', 1],
      source: ['TEXT', 1],
      code: ['TEXT', 0],
      message: ['TEXT', 1],
      details_json: ['TEXT', 0],
      created_at: ['INTEGER', 1],
    });
    assertColumns(database, 'send_templates', {
      id: ['TEXT', 1],
      endpoint_id: ['TEXT', 1],
      name: ['TEXT', 1],
      format: ['TEXT', 1],
      framing: ['TEXT', 1],
      target_json: ['TEXT', 0],
      payload: ['BLOB', 1],
      created_at: ['INTEGER', 1],
      updated_at: ['INTEGER', 1],
    });
    assertColumns(database, 'send_history', {
      id: ['INTEGER', 0],
      endpoint_id: ['TEXT', 1],
      session_id: ['TEXT', 0],
      peer_id: ['TEXT', 0],
      target_json: ['TEXT', 0],
      format: ['TEXT', 1],
      framing: ['TEXT', 1],
      payload: ['BLOB', 1],
      byte_count: ['INTEGER', 1],
      created_at: ['INTEGER', 1],
    });
    assertColumns(database, 'settings', {
      key: ['TEXT', 1],
      value: ['TEXT', 1],
      updated_at: ['INTEGER', 1],
    });
  });
});

test('endpoint profile identity rejects NULL inserts', async () => {
  await withMigratedDatabase((database) => {
    assert.throws(
      () => database.exec(`
        INSERT INTO endpoint_profiles
          (id, name, transport, config_json, created_at, updated_at)
        VALUES
          (NULL, 'Serial', 'serial', '{}', 1, 1)
      `),
      /NOT NULL constraint failed: endpoint_profiles\.id/,
    );
  });
});

test('send template identity rejects NULL inserts', async () => {
  await withMigratedDatabase((database) => {
    database.exec(`
      INSERT INTO endpoint_profiles
        (id, name, transport, config_json, created_at, updated_at)
      VALUES
        ('endpoint-1', 'Serial', 'serial', '{}', 1, 1)
    `);

    assert.throws(
      () => database.exec(`
        INSERT INTO send_templates
          (id, endpoint_id, name, format, framing, payload, created_at, updated_at)
        VALUES
          (NULL, 'endpoint-1', 'Ping', 'hex', 'none', X'01', 1, 1)
      `),
      /NOT NULL constraint failed: send_templates\.id/,
    );
  });
});

test('settings identity rejects NULL inserts', async () => {
  await withMigratedDatabase((database) => {
    assert.throws(
      () => database.exec(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (NULL, '{}', 1)
      `),
      /NOT NULL constraint failed: settings\.key/,
    );
  });
});

test('endpoint-owned history and template rows declare cascading foreign keys', async () => {
  await withMigratedDatabase((database) => {
    for (const table of ['transfer_frames', 'runtime_logs', 'send_templates', 'send_history']) {
      const endpointForeignKey = database.prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .find(({ from }) => from === 'endpoint_id');

      assert.ok(endpointForeignKey, `${table}.endpoint_id foreign key`);
      assert.equal(endpointForeignKey.table, 'endpoint_profiles');
      assert.equal(endpointForeignKey.to, 'id');
      assert.equal(endpointForeignKey.on_delete, 'CASCADE');
    }
  });
});

test('transfer history indexes preserve exact query column order and descending flags', async () => {
  await withMigratedDatabase((database) => {
    const indexes = database.prepare('PRAGMA index_list(transfer_frames)').all();
    assert.equal(indexes.length, 3, 'transfer_frames index count');
    assert.equal(
      indexes.filter(({ origin }) => origin === 'c').length,
      3,
      'all transfer_frames indexes are explicitly declared',
    );

    for (const firstColumn of ['endpoint_id', 'session_id', 'peer_id']) {
      const matchingIndex = indexes
        .map(({ name }) => ({ name, columns: indexKeyColumns(database, name) }))
        .find(({ columns }) => columns.map(({ name }) => name).join(',') === (
          `${firstColumn},created_at,id`
        ));

      assert.ok(matchingIndex, `index beginning with ${firstColumn}`);
      assert.deepEqual(
        matchingIndex.columns.map(({ desc }) => desc),
        [0, 1, 1],
        `${matchingIndex.name} sort directions`,
      );
    }
  });
});

test('migration records version 1 with an integer epoch-millisecond application time', async () => {
  await withMigratedDatabase((database, { beforeMigration, afterMigration }) => {
    const rows = database.prepare('SELECT * FROM schema_migrations').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].name, '001-initial');
    assert.equal(Number.isInteger(rows[0].applied_at), true);
    assert.ok(rows[0].applied_at >= beforeMigration - 1_000);
    assert.ok(rows[0].applied_at <= afterMigration + 1_000);
  });
});

function tableInfo(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all();
}

function assertColumns(database, table, expected) {
  const actual = tableInfo(database, table);
  assert.deepEqual(actual.map(({ name }) => name), Object.keys(expected), `${table} columns`);

  for (const column of actual) {
    const [type, notnull] = expected[column.name];
    assert.equal(column.type, type, `${table}.${column.name} type`);
    assert.equal(column.notnull, notnull, `${table}.${column.name} NOT NULL`);
  }
}

function indexKeyColumns(database, indexName) {
  return database.prepare(`PRAGMA index_xinfo(${JSON.stringify(indexName)})`)
    .all()
    .filter(({ key }) => key === 1)
    .sort((left, right) => left.seqno - right.seqno);
}
