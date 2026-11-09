import { createPackage, getRawHeader } from '@electron/asar';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyProductionArchive } from '../apps/electron/scripts/verifyArchive.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'ineed-archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'app');
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(source, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const archive = path.join(root, 'app.asar');
  await createPackage(source, archive);
  return archive;
}

test('accepts a real production archive with verified file bytes', async t => {
  const archive = await fixture(t, {
    'dist/index.html': '<!doctype html><p>工具</p>',
    'electron/main.cjs': 'module.exports = {};',
  });
  assert.deepEqual(verifyProductionArchive(archive), { checkedFiles: 2 });
});

test('rejects workbench source and Playwright output in real archives', async t => {
  for (const entry of [
    'node_modules/@ineed-linklab/workbench/src/App.vue',
    'node_modules/example/test-results/session.trace',
    'playwright-report/index.html',
  ]) {
    const archive = await fixture(t, { [entry]: 'development output' });
    assert.throws(() => verifyProductionArchive(archive), /Development-only entry/);
  }
});

test('rejects corrupted content even when its archive entry has the expected size', async t => {
  const archive = await fixture(t, { 'index.html': '<!doctype html><p>original</p>' });
  const { headerSize } = getRawHeader(archive);
  const data = await readFile(archive);
  data[8 + headerSize] ^= 1;
  await writeFile(archive, data);
  assert.throws(() => verifyProductionArchive(archive), /Archive integrity mismatch/);
});
