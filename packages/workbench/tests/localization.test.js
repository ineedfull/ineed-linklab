import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'src');

test('all visible workbench SFCs use Chinese UI copy and accessible labels', async () => {
  const componentNames = await readdir(path.join(sourceRoot, 'components'), { recursive: true });
  const sources = await Promise.all([
    readFile(path.join(sourceRoot, 'App.vue'), 'utf8'),
    readFile(path.join(sourceRoot, 'layouts', 'LinkLabShell.vue'), 'utf8'),
    readFile(path.join(sourceRoot, 'layouts', 'HistoryWindow.vue'), 'utf8'),
    ...componentNames.filter((name) => name.endsWith('.vue'))
      .map((name) => readFile(path.join(sourceRoot, 'components', name), 'utf8')),
  ]);
  const source = sources.join('\n');

  for (const required of [
    '端点', '消息', '日志', '设置', '关于', '串口', '波特率', '数据位', '校验位',
    '停止位', '流控', 'TCP 客户端', 'TCP 服务端', 'UDP 客户端', 'UDP 服务端',
    '本地绑定地址', '本地绑定端口', '默认目标地址', '默认目标端口', '数据存储',
  ]) assert.match(source, new RegExp(required), required);

  for (const obsolete of [
    'Add endpoint', 'No endpoint selected', 'Search endpoints', 'Loading endpoints',
    'No messages', 'No logs', 'Send unavailable', 'Open settings', 'Frame History',
    'Log History', 'Data Storage', 'Clear history', 'Export workspace', 'Import workspace',
    'New endpoint', 'Edit endpoint', 'Save endpoint', 'Refresh serial ports',
    'Copyright',
  ]) assert.doesNotMatch(source, new RegExp(`${obsolete}\\b`, 'i'), obsolete);
});

test('product version comes from one shared workbench constant', async () => {
  const source = await readFile(path.join(sourceRoot, 'product.js'), 'utf8');
  const { APP_VERSION, PRODUCT_NAME } = await import('../src/product.js');
  assert.equal(PRODUCT_NAME, 'Ineed LinkLab');
  assert.equal(APP_VERSION, '0.1.0');
  assert.match(source, /package\.json/);
  assert.doesNotMatch(source, /APP_VERSION\s*=\s*['"]0\.1\.0/);
});
