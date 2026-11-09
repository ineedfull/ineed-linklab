import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const { preserveLegacyUserData } = createRequire(import.meta.url)('../electron/legacyUserData.cjs');

function fixture(t, name = 'Ineed LinkLab') {
  const directory = mkdtempSync(path.join(tmpdir(), 'ineed-linklab-rename-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = { appData: directory, userData: path.join(directory, name) };
  paths.sessionData = paths.userData;
  const changes = [];
  const app = { getPath: key => paths[key], setPath: (key, value) => { changes.push(key); paths[key] = value; } };
  function database(folder, content = 'existing workspace') {
    const dir = path.join(directory, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'ineed-dev-tool.db'), content);
    return dir;
  }
  return { directory, app, paths, changes, database };
}

for (const [name, oldName] of [['Ineed LinkLab', 'Ineed DevTool'], ['@ineed-linklab/electron', '@ineed-dev-tool/electron']]) {
  test(`renamed ${name} opens the existing workspace and session without changing files`, t => {
    const f = fixture(t, name);
    const legacy = f.database(oldName);
    writeFileSync(path.join(legacy, 'ineed-dev-tool.db-wal'), 'pending history');
    preserveLegacyUserData(f.app);
    assert.equal(f.paths.userData, legacy);
    assert.equal(f.paths.sessionData, legacy);
    assert.equal(readFileSync(path.join(f.paths.userData, 'ineed-dev-tool.db'), 'utf8'), 'existing workspace');
    assert.equal(readFileSync(path.join(legacy, 'ineed-dev-tool.db-wal'), 'utf8'), 'pending history');
  });
}

test('existing LinkLab database takes precedence over legacy data', t => {
  const f = fixture(t);
  f.database('Ineed DevTool');
  f.database('Ineed LinkLab', 'new workspace');
  preserveLegacyUserData(f.app);
  assert.deepEqual(f.changes, []);
  assert.equal(readFileSync(path.join(f.paths.userData, 'ineed-dev-tool.db'), 'utf8'), 'new workspace');
});

for (const name of ['@ineed-linklab/electron', '@ineed-dev-tool/electron']) {
  test(`packaged LinkLab retains the ${name} development workspace`, t => {
    const f = fixture(t);
    const legacy = f.database(name);
    preserveLegacyUserData(f.app);
    assert.equal(f.paths.userData, legacy);
    assert.equal(f.paths.sessionData, legacy);
  });
}

test('existing packaged DevTool workspace precedes development profiles', t => {
  const f = fixture(t);
  const legacy = f.database('Ineed DevTool');
  f.database('@ineed-linklab/electron');
  f.database('@ineed-dev-tool/electron');
  preserveLegacyUserData(f.app);
  assert.equal(f.paths.userData, legacy);
});

test('explicit custom data directory is preserved', t => {
  const f = fixture(t, 'acceptance-profile');
  f.database('Ineed DevTool');
  preserveLegacyUserData(f.app);
  assert.deepEqual(f.changes, []);
});

test('fresh installation keeps the new default', t => {
  const f = fixture(t);
  preserveLegacyUserData(f.app);
  assert.deepEqual(f.changes, []);
});

test('custom session directory is not overridden when reusing the legacy database', t => {
  const f = fixture(t);
  const legacy = f.database('Ineed DevTool');
  f.paths.sessionData = path.join(f.directory, 'custom-session');
  preserveLegacyUserData(f.app);
  assert.equal(f.paths.userData, legacy);
  assert.equal(f.paths.sessionData, path.join(f.directory, 'custom-session'));
});
