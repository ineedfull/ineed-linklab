import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOpcuaExporter } = require('../electron/opcuaExport.cjs');
const { openConfigurationDatabase } = require('../electron/database.cjs');

test('native document exports preserve existing databases and reject unsafe destinations', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'linklab-export-'));
  const directory = join(root, 'data'); await fs.mkdir(directory);
  const database = join(directory, 'ineed-dev-tool.db');
  openConfigurationDatabase(database).close();
  const db = openConfigurationDatabase(database);
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const before = await fs.readFile(database);
  await fs.symlink(database, join(root, 'linked.json'));
  await fs.link(database, join(root, 'hardlinked.json'));
  await fs.symlink(directory, join(root, 'alias'));
  let selected;
  const exporter = createOpcuaExporter({ files: fs, protectedDirectories: [directory],
    getWindow: () => ({ isDestroyed: () => false }),
    dialog: { showSaveDialog: async () => ({ filePath: selected }) } });
  for (const fileName of ['opcua-values.csv', 'opcua-profiles.json', 'linklab-device-template.json',
    'linklab-acceptance-plan.json', 'linklab-acceptance-report.json', 'linklab-acceptance-report.md']) {
    for (selected of [join(root, 'linked.json'), join(root, 'hardlinked.json'), database,
      join(directory, 'new.json'), join(root, 'alias', 'report.json'), directory]) {
      await assert.rejects(exporter({ fileName, content: 'evidence' }));
      assert.deepEqual(await fs.readFile(database), before);
    }
    selected = join(root, fileName); await fs.writeFile(selected, 'old');
    assert.deepEqual(await exporter({ fileName, content: 'evidence' }), { saved: true });
    assert.equal(await fs.readFile(selected, 'utf8'), 'evidence');
  }
});
