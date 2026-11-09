import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openConfigurationDatabase } from '../electron/database.cjs';
const empty = '{"version":1,"plans":[],"reports":[]}';
test('native acceptance opaque JSON envelope is bounded and defaults remain compatible', async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'linklab-acceptance-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openConfigurationDatabase(path.join(directory, 'test.db'));
  t.after(() => db.close());
  assert.equal(db.getSettings().acceptanceWorkspace, empty);
  db.saveSetting('acceptanceWorkspace', empty);
  for (const value of [
    { version: 1, plans: [], reports: [] },
    'invalid',
    '{"version":2,"plans":[],"reports":[]}',
    '{"version":1,"plans":[],"reports":[],"extra":true}',
    JSON.stringify({ version: 1, plans: Array(51).fill({}), reports: [] }),
    JSON.stringify({ version: 1, plans: [], reports: Array(21).fill({}) }),
    JSON.stringify({ version: 1, plans: ['x'.repeat(2097152)], reports: [] }),
  ]) {
    assert.throws(
      () => db.saveSetting('acceptanceWorkspace', value),
      /acceptanceWorkspace/,
    );
    assert.equal(db.getSettings().acceptanceWorkspace, empty);
    assert.throws(() => db.saveSettings({ acceptanceWorkspace: value }));
    assert.throws(() =>
      db.importWorkspace({
        ...db.exportWorkspace(),
        settings: { acceptanceWorkspace: value },
      }),
    );
  }
});
test('corrupt native acceptance rows are surfaced and never silently returned as defaults', async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'linklab-acceptance-corrupt-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'test.db'),
    db = openConfigurationDatabase(filename);
  t.after(() => db.close());
  const raw = new DatabaseSync(filename);
  t.after(() => raw.close());
  for (const encoded of [
    '{bad',
    JSON.stringify('invalid'),
    JSON.stringify({ version: 1, plans: [], reports: [] }),
  ]) {
    raw
      .prepare(
        'INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)',
      )
      .run('acceptanceWorkspace', encoded, 1);
    assert.throws(() => db.getSettings(), /acceptanceWorkspace/);
    assert.throws(() => db.exportWorkspace(), /acceptanceWorkspace/);
    assert.equal(
      raw
        .prepare('SELECT value FROM settings WHERE key=?')
        .get('acceptanceWorkspace').value,
      encoded,
    );
  }
});
test('native device template library survives workspace export/import and rejects invalid envelopes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linklab-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openConfigurationDatabase(path.join(directory, 'test.db')); t.after(() => db.close());
  const text = JSON.stringify({ version: 1, plans: [], reports: [], templates: [{ id: 'model', version: 1 }] });
  db.saveSetting('acceptanceWorkspace', text);
  const exported = db.exportWorkspace(); db.saveSetting('acceptanceWorkspace', empty); db.importWorkspace(exported);
  assert.equal(db.getSettings().acceptanceWorkspace, text);
  for (const templates of [null, {}, Array(51).fill({})]) assert.throws(() => db.saveSetting('acceptanceWorkspace', JSON.stringify({ version: 1, plans: [], reports: [], templates })));
});
