import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createOpcuaExporter } = createRequire(import.meta.url)(
  '../electron/opcuaExport.cjs',
);
test('OPC UA export accepts only bounded names/content and uses a native selected path', async () => {
  let dialogs = 0;
  const writes = [];
  let canceled = true;
  const exporter = createOpcuaExporter({
    getWindow: () => ({ isDestroyed: () => false }),
    dialog: {
      showSaveDialog: async () => {
        dialogs++;
        return { canceled, filePath: '/selected/values.csv' };
      },
    },
    files: { writeFile: async (...args) => writes.push(args) },
  });
  await assert.rejects(
    exporter({ fileName: '../../outside.csv', content: 'bad' }),
    /无效/,
  );
  await assert.rejects(
    exporter({ fileName: 'opcua-values.csv', content: '中'.repeat(400000) }),
    /1 MiB/,
  );
  assert.equal(dialogs, 0);
  assert.deepEqual(
    await exporter({ fileName: 'opcua-values.csv', content: 'CSV' }),
    { saved: false },
  );
  assert.equal(writes.length, 0);
  canceled = false;
  assert.deepEqual(
    await exporter({ fileName: 'opcua-values.csv', content: 'CSV' }),
    { saved: true },
  );
  assert.equal(writes[0][0], '/selected/values.csv');
  assert.equal(writes[0][1], 'CSV');
});

for (const fileName of [
  'linklab-device-template.json',
  'linklab-acceptance-plan.json',
  'linklab-acceptance-report.json',
  'linklab-acceptance-report.md',
]) {
  test(`acceptance native export ${fileName} uses fixed filename, filter and cancel`, async () => {
    const dialogs = [];
    const writes = [];
    let cancel = true;
    const exporter = createOpcuaExporter({
      getWindow: () => ({ isDestroyed: () => false }),
      dialog: {
        showSaveDialog: async (_window, options) => {
          dialogs.push(options);
          return { canceled: cancel, filePath: '/selected/report' };
        },
      },
      files: { writeFile: async (...args) => writes.push(args) },
    });
    for (const field of ['path', 'filePath'])
      await assert.rejects(
        exporter({ fileName, content: 'evidence', [field]: '/forged' }),
        /路径|paths/,
      );
    assert.equal(dialogs.length, 0);
    assert.deepEqual(await exporter({ fileName, content: 'evidence' }), {
      saved: false,
    });
    assert.equal(writes.length, 0);
    cancel = false;
    assert.deepEqual(await exporter({ fileName, content: 'evidence' }), {
      saved: true,
    });
    assert.equal(dialogs[0].defaultPath, fileName);
    assert.deepEqual(dialogs[0].filters, [
      {
        name: fileName.endsWith('.md') ? 'Markdown' : 'JSON',
        extensions: [fileName.split('.').at(-1)],
      },
    ]);
    assert.equal(writes[0][0], '/selected/report');
  });
}
