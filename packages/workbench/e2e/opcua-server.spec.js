import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectStableOpcuaValueColumns } from './fixtures/opcuaTableGeometry.js';
const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} OPC UA simulator multiple endpoints and display matrix`, async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ path: fixture });
    await page.addInitScript(() => {
      const calls = []; globalThis.__SIM_CALLS__ = calls;
      let profiles = []; const sessions = new Map();
      const execute = async request => {
        calls.push(request);
        if (request.action === 'profiles') return { profiles: [] };
        if (request.action === 'serverProfiles') return { profiles };
        if (request.action === 'saveServerProfiles') { profiles = request.profiles; return {}; }
        if (request.action === 'startServer') {
          const nodes = request.nodes.map(n => ({ ...n, nodeId: `ns=6;s=${n.id}` }));
          sessions.set(request.connectionId, nodes);
          return { sessionId: request.connectionId, endpointUrl: `opc.tcp://127.0.0.1:${request.config.listenPort}${request.config.path}`, namespaceIndex: 6, nodes: nodes.map(n => ({ id: n.id, nodeId: n.nodeId })) };
        }
        if (request.action === 'serverSnapshot') return { values: sessions.get(request.connectionId).map(n => ({ nodeId: n.nodeId, value: n.value, dataType: n.dataType, arrayType: n.arrayType, statusCode: 'Good', sourceTimestamp: '2026-10-22T08:05:06.007Z', serverTimestamp: null })) };
        if (request.action === 'setServerValue') { sessions.get(request.connectionId).find(n => n.nodeId === request.nodeId).value = request.value; return { updated: true }; }
        if (request.action === 'stopServer') { sessions.delete(request.connectionId); return { stopped: true }; }
        if (request.action === 'export') return { saved: true };
        return {};
      };
      if (globalThis.ineedLinkLab) globalThis.ineedLinkLab.opcua = { execute: async r => ({ ok: true, value: await execute(r) }), onEvent: () => () => {} };
      if (globalThis.__TAURI_INTERNALS__) {
        const original = globalThis.__TAURI_INTERNALS__.invoke;
        globalThis.__TAURI_INTERNALS__.invoke = async (command, payload) => command === 'opcua_execute' ? { ok: true, value: await execute(payload.request) } : original(command, payload);
      }
    });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    async function add(name, port) {
      await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('传输类型').selectOption('opcua-server');
      await dialog.locator('[name="endpoint-name"]').fill(name);
      await dialog.locator('[name="opcua-server-port"]').fill(String(port));
      await dialog.getByRole('button', { name: '保存端点', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      return page.getByRole('region', { name: 'OPC UA 模拟服务端', exact: true }).filter({ has: page.getByRole('heading', { name: 'OPC UA 模拟服务端', exact: true }) }).filter({ hasText: name });
    }
    const first = await add('模拟 A', 4840);
    await first.locator('[name="node-initial"]').fill('not-a-number'); await first.getByRole('button', { name: '启动', exact: true }).click();
    await expect(first.getByRole('alert')).toBeVisible();
    expect(await page.evaluate(() => globalThis.__SIM_CALLS__.some(r => r.action === 'startServer'))).toBe(false);
    await first.locator('[name="node-initial"]').fill('28.5'); await first.getByRole('button', { name: '启动', exact: true }).click();
    await expect(first.locator('.opcua-status')).toHaveText('正在监听');
    await expect(first.locator('[name="node-id"]')).toBeDisabled();
    await first.locator('[name="node-current"]').fill('31.5'); await first.getByRole('button', { name: '更新当前值', exact: true }).click();
    await expect(first.locator('td code').filter({ hasText: /^31.5$/ })).toBeVisible();
    const second = await add('模拟 B', 4841); await second.getByRole('button', { name: '启动', exact: true }).click();
    await expect(second.locator('.opcua-status')).toHaveText('正在监听');
    await page.getByRole('button', { name: '选择 模拟 A', exact: true }).click();
    await expect(first.locator('.opcua-status')).toHaveText('正在监听');
    await expect(second).toBeHidden();
    for (const dark of [false, true]) for (const large of [false, true]) for (const collapsed of [false, true]) {
      await page.evaluate(({ dark, large }) => { globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light'; globalThis.document.documentElement.classList.toggle('large-font', large); }, { dark, large });
      const isCollapsed = (await page.locator('.linklab-shell').getAttribute('class')).includes('tree-collapsed');
      if (isCollapsed !== collapsed) await page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表', exact: true }).click();
      await expect(first.getByRole('button', { name: '停止', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
      await expect(first.locator('time').first()).toHaveText('2026-10-22 16:05:06.007');
      const table = first.locator('.opcua-table'); await table.scrollIntoViewIfNeeded();
      await expect(table).toBeVisible();
      await expectStableOpcuaValueColumns(table);
      if (dark && large && collapsed) await page.screenshot({ path: testInfo.outputPath(`${runtime}-simulator-dark-large.png`) });
    }
    await first.getByRole('button', { name: '停止', exact: true }).click();
    await expect(first.locator('[name="node-id"]')).toBeEnabled();
    await expect(first.locator('[name="node-initial"]')).toHaveValue('28.5');
    expect(await page.evaluate(() => globalThis.__SIM_CALLS__.filter(r => r.action === 'stopServer').length)).toBe(1);
    expect(errors).toEqual([]);
  });
}
