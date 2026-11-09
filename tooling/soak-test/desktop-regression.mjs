/* global window, document, innerWidth, innerHeight */
// Localhost/PTY native Electron regression. Isolated database and file-dialog paths.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

const root = new URL('../../', import.meta.url).pathname;
const {prepareElectronExecutable} = await import(root + '/scripts/dev-electron.mjs');
const brandedExecutable = await prepareElectronExecutable();
const out = process.env.LINKLAB_REGRESSION_OUT ?? await mkdtemp(path.join(tmpdir(), 'linklab-desktop-regression-'));
await mkdir(out, { recursive: true });
const require = createRequire(root + '/package.json');
const { _electron, expect } = require('@playwright/test');
const { SerialPort } = require('serialport');
const { openConfigurationDatabase } = require(root + '/apps/electron/electron/database.cjs');
const { buildDlt645Frame, extractDlt645Frames } = await import(root + '/packages/codecs/src/dlt645.js');
const { normalizeDlt645Config } = await import(root + '/packages/workbench/src/model/dlt645Config.js');
const fixture = await mkdtemp(path.join(tmpdir(), 'linklab-existing-gui-'));
const data = path.join(fixture, 'data');
await mkdir(data);
const pty = spawn('socat', ['-d', '-d', `pty,raw,echo=0,link=${fixture}/service`, `pty,raw,echo=0,link=${fixture}/peer`]);
pty.stderr.resume();
let peer;
let app;
const checks = [];
const errors = [];
let success = false;
try {
  for (let n = 0; n < 100; n++) { try { await realpath(`${fixture}/service`); break; } catch { await delay(20); } }
  const servicePath = await realpath(`${fixture}/service`);
  const peerPath = await realpath(`${fixture}/peer`);
  peer = new SerialPort({ path: peerPath, baudRate: 2400 });
  await once(peer, 'open');
  let received = new Uint8Array();
  let requests = 0;
  let answer = true;
  peer.on('data', (bytes) => {
    const extracted = extractDlt645Frames(Uint8Array.of(...received, ...bytes));
    received = new Uint8Array(extracted.remainder);
    for (const request of extracted.frames) {
      if (request.response) continue;
      requests++;
      if (answer) peer.write(Buffer.from(buildDlt645Frame({ address: request.address, control: 0x91, data: [0, 1, 1, 2, 0x34, 0x22] })));
    }
  });
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const db = openConfigurationDatabase(path.join(data, 'ineed-dev-tool.db'));
  db.insertEndpoint({ id: 'local-server', name: '本机服务', transport: 'tcp-server', config: { listenHost: '127.0.0.1', listenPort: port, receiveFraming: { mode: 'raw' } } });
  db.insertEndpoint({ id: 'local-client', name: '本机客户端', transport: 'tcp-client', config: { host: '127.0.0.1', port, receiveFraming: { mode: 'raw' } } });
  db.insertEndpoint({ id: 'meter-master', name: 'PTY 电表主站', transport: 'dlt645-master', config: normalizeDlt645Config({
    path: servicePath, timeoutMs: 800, wakeUpBytes: 0, meters: [{ id: 'meter-1', name: '测试电表', address: '123456789012', tasks: [{ id: 'voltage', name: 'A 相电压', identifier: '02010100' }] }],
  }) });
  db.saveSetting('theme', 'light'); db.close();
  const bootstrap = path.join(fixture, 'main.cjs');
  await writeFile(bootstrap, `const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(data)});app.setPath('sessionData',${JSON.stringify(data)});require(${JSON.stringify(root + '/apps/electron/electron/main.cjs')});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  app = await _electron.launch({ executablePath: brandedExecutable, args: [bootstrap], env, timeout: 30000 });
  app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('dialog', (dialog) => dialog.accept());
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(data);
  const row = (name) => page.locator('.endpoint-row').filter({ has: page.getByRole('button', { name: '选择 ' + name, exact: true }) });
  const select = (name) => page.getByRole('button', { name: '选择 ' + name, exact: true }).click();
  const open = async (name) => { await row(name).getByRole('button', { name: '打开端点', exact: true }).click(); await expect(row(name).getByRole('button', { name: '关闭端点', exact: true })).toBeVisible(); };
  const close = async (name) => { await row(name).getByRole('button', { name: '关闭端点', exact: true }).click(); await expect(row(name).getByRole('button', { name: '打开端点', exact: true })).toBeVisible(); };
  const native = async (method, args = []) => page.evaluate(async ({ method, args }) => {
    const [group, name] = method.split('.'); const result = await window.ineedLinkLab[group][name](...args);
    if (!result.ok) throw new Error(result.error.message); return result.value;
  }, { method, args });
  await open('本机服务'); await open('本机客户端'); await select('本机客户端');
  await page.getByRole('textbox', { name: '发送内容' }).fill('PING-existing-features');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await select('本机服务'); await expect(page.locator('.frame-list')).toContainText('PING-existing-features');
  checks.push('real native TCP send/receive');
  await select('本机客户端'); await page.getByRole('button', { name: '发送模板', exact: true }).click();
  const library = page.locator('.send-library');
  await library.getByRole('textbox', { name: '模板名称' }).fill('健康检查');
  await library.getByRole('button', { name: '保存当前内容为模板' }).click();
  await expect(library.getByRole('button', { name: '载入模板 健康检查' })).toBeVisible();
  await library.getByRole('button', { name: '重命名模板 健康检查' }).click();
  await library.getByRole('textbox', { name: '新的模板名称' }).fill('健康检查已修改');
  await library.locator('.send-library__rename').getByRole('button').click();
  await expect(library.getByRole('button', { name: '载入模板 健康检查已修改' })).toBeVisible();
  await page.getByRole('textbox', { name: '发送内容' }).fill('overwritten');
  await library.getByRole('button', { name: '载入模板 健康检查已修改' }).click();
  await expect(page.getByRole('textbox', { name: '发送内容' })).toContainText('PING-existing-features');
  expect((await native('template.list', ['local-client'])).length).toBe(1);
  checks.push('template save/rename/load persisted by SQLite without automatic send');
  if (await library.count()) await library.getByRole('button', { name: '关闭发送资料库' }).click();
  await page.getByRole('checkbox', { name: '定时发送', exact: true }).check();
  await page.getByRole('spinbutton', { name: '定时发送间隔（毫秒）' }).fill('150');
  await page.getByRole('combobox', { name: '定时发送次数模式' }).selectOption('finite');
  await page.getByRole('spinbutton', { name: '定时发送次数', exact: true }).fill('3');
  await page.getByRole('button', { name: '开始定时发送' }).click();
  await expect.poll(async () => (await native('sendHistory.query', [{ endpointId: 'local-client', page: 1, pageSize: 20 }])).total).toBe(4);
  await expect(page.getByRole('button', { name: '开始定时发送' })).toBeVisible();
  checks.push('finite scheduled sending sends exactly three native messages');
  await page.getByRole('button', { name: '发送历史', exact: true }).click();
  await expect(library.locator('.send-library__item')).toHaveCount(4);
  await library.locator('.send-library__load').first().click();
  await expect(page.getByRole('textbox', { name: '发送内容' })).toContainText('PING-existing-features');
  await page.getByRole('button', { name: '发送历史', exact: true }).click();
  await library.locator('.send-library__item-actions button').first().click();
  await expect(library.locator('.send-library__item')).toHaveCount(3);
  await library.getByRole('button', { name: '关闭发送资料库' }).click();
  checks.push('send-history load/delete updates actual database and UI');
  const historyWindow = app.waitForEvent('window');
  await page.getByRole('button', { name: '打开消息历史', exact: true }).click();
  const history = await historyWindow; history.setDefaultTimeout(10000);
  await expect(history.locator('.history-table tbody tr')).toHaveCount(4);
  await history.getByRole('searchbox', { name: '搜索历史记录' }).fill('no-match');
  await history.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(history.locator('.history-table tbody tr')).toHaveCount(0);
  await history.getByRole('searchbox', { name: '搜索历史记录' }).fill('PING');
  await history.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(history.locator('.history-table tbody tr')).toHaveCount(4);
  await history.close(); checks.push('native history window search/empty/retry rendering');
  await open('PTY 电表主站'); await select('PTY 电表主站');
  await page.getByRole('button', { name: '单次抄读', exact: true }).click();
  await expect(page.locator('.dlt645-value')).toContainText('223.4');
  expect(requests).toBe(1); checks.push('DL/T 645 master native PTY read and BCD decoding');
  answer = false;
  await page.getByRole('button', { name: '单次抄读', exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await close('PTY 电表主站'); await open('PTY 电表主站');
  execFileSync('stty', ['-f', peerPath, 'raw', '-echo']);
  await expect(page.locator('.dlt645-value')).toContainText('--');
  await expect(page.getByRole('button', { name: '单次抄读', exact: true })).toBeEnabled();
  await delay(900); await expect(page.locator('.dlt645-live-group__error')).toBeEmpty();
  answer = true;
  await page.getByRole('button', { name: '单次抄读', exact: true }).click();
  await expect(page.locator('.dlt645-value')).toContainText('223.4');
  checks.push('DL/T pending read cancelled by GUI reconnect, old timeout inert, new read succeeds');
  for (const theme of ['light', 'dark']) for (const large of [false, true]) for (const collapsed of [false, true]) {
    await page.getByRole('button', { name: '打开设置' }).click();
    await page.getByLabel('主题', { exact: true }).selectOption(theme);
    await page.getByRole('checkbox', { name: '大字体', exact: true }).setChecked(large);
    const save = page.getByRole('button', { name: '保存', exact: true });
    if (await save.isEnabled()) await save.click(); else await page.keyboard.press('Escape');
    const toggle = page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表', exact: true });
    if (await toggle.count()) await toggle.click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 720));
    const bounds = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
    expect(bounds.sw).toBeLessThanOrEqual(bounds.w); expect(bounds.sh).toBeLessThanOrEqual(bounds.h);
    await page.screenshot({ path: path.join(out, `dlt-master-${theme}-${large ? 'large' : 'normal'}-${collapsed ? 'collapsed' : 'expanded'}.png`) });
  }
  checks.push('DL/T master eight native light/dark font/sidebar states at 1120x720');
  const expand = page.getByRole('button', { name: '展开端点列表' }); if (await expand.count()) await expand.click();
  const exported = path.join(fixture, 'exported.json'); const imported = path.join(fixture, 'imported.json');
  await app.evaluate(({ dialog }, { exported, imported }) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imported] });
  }, { exported, imported });
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '工作区已导出' })).toBeVisible();
  const workspace = JSON.parse(await readFile(exported, 'utf8'));
  expect(workspace.endpointProfiles.length).toBe(3); expect(workspace.sendTemplates.length).toBe(1);
  const invalid = structuredClone(workspace); invalid.settings.theme = 'broken';
  await writeFile(imported, JSON.stringify(invalid));
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.locator('.workspace-actions [role="alert"]')).toBeVisible();
  await expect(row('本机客户端').getByRole('button', { name: '关闭端点' })).toBeVisible();
  expect((await native('settings.getAll')).theme).toBe('dark');
  checks.push('invalid file import retains native TCP connection and stored preferences');
  const invalidTransport = structuredClone(workspace);
  invalidTransport.endpointProfiles.find(({ id }) => id === 'local-client').transport = 'unsupported';
  await writeFile(imported, JSON.stringify(invalidTransport));
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.locator('.workspace-actions [role="alert"]')).toBeVisible();
  await expect(row('本机客户端').getByRole('button', { name: '关闭端点' })).toBeVisible();
  expect((await native('endpoint.list')).find(({ id }) => id === 'local-client').transport).toBe('tcp-client');
  checks.push('unsupported transport rejected before closing actual TCP sessions or mutating SQLite');
  workspace.settings.theme = 'light'; workspace.settings.largeFont = false;
  workspace.endpointProfiles.find(({ id }) => id === 'local-client').name = '已导入客户端';
  await writeFile(imported, JSON.stringify(workspace));
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.locator('.workspace-actions [role="status"]')).toContainText('已从以下文件导入');
  await expect(page.getByLabel('主题', { exact: true })).toHaveValue('light');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(row('已导入客户端')).toBeVisible();
  await expect(row('已导入客户端').getByRole('button', { name: '打开端点' })).toBeVisible();
  checks.push('native JSON round-trip preserves templates, closes sessions, reloads endpoints/preferences');
  await open('本机服务'); await open('已导入客户端'); await select('已导入客户端');
  await page.getByRole('textbox', { name: '发送内容' }).fill('after-import');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await select('本机服务'); await expect(page.locator('.frame-list')).toContainText('after-import');
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('button', { name: '清除历史记录', exact: true }).click();
  await expect.poll(async () => (await native('storage.stats')).totalCount).toBe(0);
  expect((await native('endpoint.list')).length).toBe(3);
  expect((await native('template.list', ['local-client'])).length).toBe(1);
  expect((await native('settings.getAll')).theme).toBe('light');
  checks.push('storage cleanup flushes and clears histories while keeping endpoints/templates/settings');
  await page.getByRole('button', { name: '关闭设置' }).click();
  // Recheck the repaired shared command through the production renderer and
  // real native TCP stream, then inspect the isolated receiver's SQLite bytes.
  await select('已导入客户端');
  await page.getByRole('textbox', { name: '发送内容' }).fill('ping');
  for (const [framing, expected] of [
    ['none', [112, 105, 110, 103]],
    ['line', [112, 105, 110, 103, 10]],
    ['length-prefix', [0, 0, 0, 4, 112, 105, 110, 103]],
  ]) {
    await page.locator('select[name="framing"]').selectOption(framing);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => {
      const result = await native('history.queryFrames', [{ endpointId: 'local-server', page: 1, pageSize: 100 }]);
      return result.rows.some((frame) => Buffer.from(frame.payloadBase64, 'base64').equals(Buffer.from(expected)));
    }).toBe(true);
  }
  const sends = await native('sendHistory.query', [{ endpointId: 'local-client', page: 1, pageSize: 20 }]);
  expect(sends.total).toBe(3);
  expect(sends.rows.every((entry) => Buffer.from(entry.payloadBase64, 'base64').equals(Buffer.from('ping')))).toBe(true);
  await select('本机服务');
  await page.getByRole('searchbox', { name: '搜索实时内容' }).fill('ping');
  await expect(page.locator('.frame-list')).toContainText('ping');
  await page.getByRole('searchbox', { name: '搜索实时内容' }).fill('does-not-exist');
  await expect(page.locator('.frame-list__item')).toHaveCount(0);
  await page.getByRole('searchbox', { name: '搜索实时内容' }).fill('');
  checks.push('three send framing modes reach native TCP history as wire bytes while send history retains logical bytes; live UTF-8 search');
  const { DatabaseSync } = require('node:sqlite');
  const historyLock = new DatabaseSync(path.join(data, 'ineed-dev-tool.db'));
  const externalPeer = net.connect({ host: '127.0.0.1', port });
  await once(externalPeer, 'connect');
  try {
    historyLock.exec('BEGIN IMMEDIATE');
    externalPeer.write('locked-history');
    await expect(page.getByRole('alert').filter({ hasText: '历史记录保存失败' })).toBeVisible({ timeout: 30000 });
    const incomplete = await page.evaluate(() => window.ineedLinkLab.history.queryFrames({ endpointId: 'local-server', page: 1, pageSize: 100 }));
    expect(incomplete.ok).toBe(false);
    expect(incomplete.error.code).toBe('HISTORY_INCOMPLETE');
    historyLock.exec('ROLLBACK');
    externalPeer.write('recovered-history');
    await expect.poll(async () => {
      const result = await native('history.queryFrames', [{ endpointId: 'local-server', page: 1, pageSize: 100 }]);
      return result.rows.some((frame) => Buffer.from(frame.payloadBase64, 'base64').toString() === 'recovered-history');
    }).toBe(true);
    checks.push('real SQLite lock produces application-visible incomplete-history warning and explicit query failure; later frames persist after unlock');
  } finally {
    try { historyLock.exec('ROLLBACK'); } catch { /* Already rolled back. */ }
    historyLock.close();
    externalPeer.destroy();
  }
  await select('已导入客户端');
  for (const theme of ['light', 'dark']) for (const large of [false, true]) for (const collapsed of [false, true]) {
    await page.getByRole('button', { name: '打开设置' }).click();
    await page.getByLabel('主题', { exact: true }).selectOption(theme);
    await page.getByRole('checkbox', { name: '大字体', exact: true }).setChecked(large);
    const save = page.getByRole('button', { name: '保存', exact: true });
    if (await save.isEnabled()) await save.click(); else await page.keyboard.press('Escape');
    const toggle = page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表', exact: true });
    if (await toggle.count()) await toggle.click();
    const bounds = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
    expect(bounds.sw).toBeLessThanOrEqual(bounds.w);
    expect(bounds.sh).toBeLessThanOrEqual(bounds.h);
    await expect(page.getByRole('alert').filter({ hasText: '历史记录保存失败' })).toBeVisible();
    await expect(page.locator('select[name="framing"]')).toHaveValue('length-prefix');
    await page.screenshot({ path: path.join(out, `send-warning-${theme}-${large ? 'large' : 'normal'}-${collapsed ? 'collapsed' : 'expanded'}.png`) });
  }
  checks.push('send framing and persistent warning eight light/dark font/sidebar desktop layouts at 1120x720');
  expect(errors).toEqual([]);
  success = true;
} finally {
  await writeFile(path.join(out, 'electron-existing-features.json'), JSON.stringify({ success, checks, errors, fixture, runtime: 'real Electron production renderer/native IPC; file dialogs supplied isolated paths', sourceDirty: true }, null, 2));
  if (app) await app.close();
  if (peer?.isOpen) await new Promise((resolve) => peer.close(resolve));
  pty.kill('SIGTERM');
  console.log(JSON.stringify({ success, checks, errors, fixture }));
}
