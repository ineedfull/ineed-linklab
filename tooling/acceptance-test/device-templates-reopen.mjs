/* global window, document */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runNativeAcceptance } from './nativeHost.mjs';

// A second OS process opens the exact isolated SQLite used by the soak.
async function reopen(config) {
  const pause = ms => config.runtime === 'tauri'
    ? fetch(`/pause?ms=${ms}`).then(r => r.text())
    : new Promise(resolve => window.setTimeout(resolve, ms));
  const ensure = (value, message) => { if (!value) throw Error(message); };
  async function openWorkspaceTool(name) {
    document.querySelector('[aria-label="打开工具箱"]').click();
    const entry = await wait(() => document.querySelector(`[aria-label="打开${name}"]`), 'workspace tool');
    entry.click();
  }
  async function wait(check, label) {
    const deadline = performance.now() + 120000;
    do { const value = await check(); if (value) return value; await pause(80); }
    while (performance.now() < deadline);
    throw Error(label);
  }
  async function click(text) {
    const button = await wait(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled && b.getClientRects().length), text);
    button.click(); await pause(80);
  }
  async function persisted() {
    const result = config.runtime === 'electron' ? await window.ineedLinkLab.settings.getAll()
      : await window.__TAURI_INTERNALS__.invoke('settings_get_all', { args: [] });
    ensure(result.ok, 'settings read failed'); return JSON.parse(result.value.acceptanceWorkspace);
  }
  await wait(() => document.querySelector('[aria-label="打开工具箱"]'), 'ready');
  const doc = await persisted();
  ensure(JSON.stringify(doc) === JSON.stringify(config.document), 'Restart changed SQLite evidence');
  await openWorkspaceTool('设备模板'); await pause(80);
  ensure(document.querySelector('[name="model-version"]').options.length === 5, 'Models not reopened');
  const version = document.querySelector('[name="model-version"]');
  version.value = `${doc.templates.at(-1).id}:${doc.templates.at(-1).version}`;
  version.dispatchEvent(new Event('change', { bubbles: true })); await pause(80);
  const exports = [];
  async function exportFile(button, filename) {
    if (config.runtime === 'tauri') await fetch('/progress', { method: 'POST', body: JSON.stringify({ stage: 'native-save-dialog', filename }) });
    await click(button);
    await wait(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('已导出')), 'native export completion');
    exports.push(filename);
  }
  if (config.exports) await exportFile('导出模板', 'linklab-device-template.json');
  document.querySelector('[aria-label="关闭设备模板"]').click(); await pause(80);
  await openWorkspaceTool('验收检查'); await pause(80);
  ensure(document.querySelector('[name="acceptance-report"]').options.length === 21, '20 retained reports not visible');
  if (config.exports) {
    await exportFile('导出 JSON', 'linklab-acceptance-report.json');
    await exportFile('导出 Markdown', 'linklab-acceptance-report.md');
  }
  return { passed: true, runtime: config.runtime, restartMatched: true, reports: doc.reports.length, revisions: doc.templates.length, exports };
}
const runtime = process.argv[2] ?? 'electron';
const source = path.resolve(process.env.LINKLAB_TEMPLATE_OUT);
const out = path.join(source, process.env.LINKLAB_REOPEN_EXPORT === '1' ? 'native-export' : 'reopen');
await mkdir(out, { recursive: true });
const previous = JSON.parse(await readFile(path.join(source, process.env.LINKLAB_REOPEN_BASELINE ?? 'result.json'), 'utf8'));
const isolation = JSON.parse(await readFile(path.join(source, 'isolation.json'), 'utf8'));
const result = await runNativeAcceptance({ runtime, out, profilePath: isolation.dataPath, identifier: isolation.identifier,
  config: { document: previous.document, exports: process.env.LINKLAB_REOPEN_EXPORT === '1' }, workload: reopen });
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
assert.equal(result.passed, true, result.error);
if (process.env.LINKLAB_REOPEN_EXPORT === '1') {
  const template = JSON.parse(await readFile(path.join(out, 'linklab-device-template.json'), 'utf8'));
  assert.deepEqual(template, previous.document.templates.at(-1));
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'linklab-acceptance-report.json'), 'utf8')), previous.document.reports.at(-1));
  assert((await readFile(path.join(out, 'linklab-acceptance-report.md'), 'utf8')).includes(previous.document.reports.at(-1).id));
}
console.log(JSON.stringify({ ...result, out }));
