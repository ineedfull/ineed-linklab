import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');

test('contract assets resolve from repository packages in source mode', () => {
  const { contractRootFor } = require('../electron/contractAssets.cjs');

  assert.equal(
    contractRootFor(path.join(packageRoot, 'electron'), '/unused/resources'),
    path.join(repositoryRoot, 'packages'),
  );
});

test('contract assets resolve from Resources/contracts only inside app.asar', () => {
  const { contractRootFor } = require('../electron/contractAssets.cjs');
  const resourcesPath = path.join(
    path.parse(packageRoot).root,
    'Applications',
    'Ineed LinkLab.app',
    'Contents',
    'Resources',
  );

  assert.equal(
    contractRootFor(path.join(resourcesPath, 'app.asar', 'electron'), resourcesPath),
    path.join(resourcesPath, 'contracts'),
  );
});

test('packaged database and management modules load contracts and initialize all migrations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'electron-contract-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, 'Ineed LinkLab.app', 'Contents', 'Resources');
  const electronPath = path.join(resourcesPath, 'app.asar', 'electron');
  const migrationPath = path.join(
    resourcesPath,
    'contracts',
    'persistence-contract',
    'migrations',
    '001-initial.sql',
  );
  const modbusMigrationPath = path.join(
    resourcesPath,
    'contracts',
    'persistence-contract',
    'migrations',
    '002-modbus-endpoints.sql',
  );
  const modbusHistoryMigrationPath = path.join(
    resourcesPath,
    'contracts',
    'persistence-contract',
    'migrations',
    '003-modbus-point-history.sql',
  );
  const dlt645MigrationPath = path.join(
    resourcesPath,
    'contracts',
    'persistence-contract',
    'migrations',
    '004-dlt645-endpoints.sql',
  );
  const dlt645SimulatorMigrationPath = path.join(
    resourcesPath,
    'contracts',
    'persistence-contract',
    'migrations',
    '005-dlt645-simulator-endpoints.sql',
  );
  const settingsSchemaPath = path.join(
    resourcesPath,
    'contracts',
    'runtime-contract',
    'src',
    'settingsSchema.json',
  );
  await Promise.all([
    mkdir(electronPath, { recursive: true }),
    mkdir(path.dirname(migrationPath), { recursive: true }),
    mkdir(path.dirname(settingsSchemaPath), { recursive: true }),
  ]);
  await Promise.all([
    ...['contractAssets.cjs', 'database.cjs', 'management.cjs'].map((filename) => copyFile(
      path.join(packageRoot, 'electron', filename),
      path.join(electronPath, filename),
    )),
    copyFile(
      path.join(repositoryRoot, 'packages', 'persistence-contract', 'migrations', '001-initial.sql'),
      migrationPath,
    ),
    copyFile(
      path.join(repositoryRoot, 'packages', 'persistence-contract', 'migrations', '002-modbus-endpoints.sql'),
      modbusMigrationPath,
    ),
    copyFile(
      path.join(repositoryRoot, 'packages', 'persistence-contract', 'migrations', '003-modbus-point-history.sql'),
      modbusHistoryMigrationPath,
    ),
    copyFile(
      path.join(repositoryRoot, 'packages', 'persistence-contract', 'migrations', '004-dlt645-endpoints.sql'),
      dlt645MigrationPath,
    ),
    copyFile(
      path.join(repositoryRoot, 'packages', 'persistence-contract', 'migrations', '005-dlt645-simulator-endpoints.sql'),
      dlt645SimulatorMigrationPath,
    ),
    copyFile(
      path.join(repositoryRoot, 'packages', 'persistence-contract', 'migrations', '006-websocket-endpoints.sql'),
      path.join(path.dirname(migrationPath), '006-websocket-endpoints.sql'),
    ),
    copyFile(
      path.join(repositoryRoot, 'packages', 'runtime-contract', 'src', 'settingsSchema.json'),
      settingsSchemaPath,
    ),
  ]);

  const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath });
  try {
    const management = require(path.join(electronPath, 'management.cjs'));
    assert.equal(management.buildHistoryWindowTitle({ kind: 'frames' }), '历史消息');

    const { openConfigurationDatabase } = require(path.join(electronPath, 'database.cjs'));
    const databasePath = path.join(root, 'isolated-user-data', 'ineed-dev-tool.db');
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = openConfigurationDatabase(databasePath);
    try {
      assert.deepEqual(database.appliedMigrations(), [
        { version: 1, name: '001-initial' },
        { version: 2, name: '002-modbus-endpoints' },
        { version: 3, name: '003-modbus-point-history' },
        { version: 4, name: '004-dlt645-endpoints' },
        { version: 5, name: '005-dlt645-simulator-endpoints' },
    { version: 6, name: '006-websocket-endpoints' },
      ]);
    } finally {
      database.close();
    }
  } finally {
    if (previousResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', previousResourcesPath);
    } else {
      delete process.resourcesPath;
    }
  }
});
