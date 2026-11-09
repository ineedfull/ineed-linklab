import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tauri persistence embeds migration 001 and uses rusqlite behind spawn_blocking', async () => {
  const [cargo, database, runtime, lib] = await Promise.all([
    read('src-tauri/Cargo.toml'),
    read('src-tauri/src/database.rs'),
    read('src-tauri/src/runtime.rs'),
    read('src-tauri/src/lib.rs'),
  ]);

  assert.match(cargo, /rusqlite\s*=\s*\{[^}]*bundled/);
  assert.match(database, /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/packages\/persistence-contract\/migrations\/001-initial\.sql"\)/);
  assert.match(
    database,
    /include_str!\(\s*"\.\.\/\.\.\/\.\.\/\.\.\/packages\/persistence-contract\/migrations\/003-modbus-point-history\.sql"\s*\)/,
  );
  assert.match(database, /ineed-dev-tool\.db/);
  assert.match(runtime, /spawn_blocking/);
  assert.match(lib, /mod database;/);
  assert.match(
    lib,
    /setup\([\s\S]*block_on\([\s\S]*spawn_blocking\([\s\S]*ConfigurationDatabase::open_in/,
  );
  assert.doesNotMatch(`${database}\n${runtime}\n${lib}`, /localStorage|sessionStorage/);
});

test('Tauri persistence declares the same versioned workspace fields and operations', async () => {
  const database = await read('src-tauri/src/database.rs');

  for (const operation of [
    'list_endpoints',
    'insert_endpoint',
    'update_endpoint',
    'clone_endpoint',
    'delete_endpoint',
    'save_setting',
    'get_settings',
    'save_template',
    'list_templates',
    'export_workspace',
    'import_workspace',
    'record_modbus_point_history',
    'query_modbus_point_history_rows',
    'query_modbus_point_series',
    'clear_modbus_point_history',
    'cleanup_modbus_point_history',
  ]) {
    assert.match(database, new RegExp(`fn\\s+${operation}\\b`), operation);
  }
  assert.match(database, /version/);
  assert.match(database, /endpoint_profiles/);
  assert.match(database, /send_templates/);
  assert.match(database, /transaction/);
  assert.match(database, /fn save_endpoint[\s\S]*save_endpoint_on\(&connection/);
  assert.match(database, /fn save_endpoint_on[\s\S]*ON CONFLICT\(id\)/);
  assert.match(database, /transaction\.commit\(\)\.map_err\(db_error\)\?;\s*export_on\(&connection\)/);
  assert.doesNotMatch(database, /transaction\.commit\(\)\.map_err\(db_error\)\?;\s*drop\(connection\)/);
  // Test fixtures deliberately exercise rejected credentials; inspect production code only.
  const productionDatabase = database.split(/#\[cfg\(test\)\]\s*mod tests\b/)[0];
  assert.ok(productionDatabase.includes('fn save_endpoint_on'));
  // URL.password() rejects embedded authentication; its presence is not persisted data.
  // Real SQLite save/import/export rejection is covered by the Rust STOMP profile tests.
  assert.doesNotMatch(productionDatabase.replaceAll('url.password().is_some()', ''), /password|passwd|passphrase|secret|credential|api[_-]?key|token/i);
});

function read(relativePath) {
  return readFile(path.join(packageRoot, relativePath), 'utf8');
}
