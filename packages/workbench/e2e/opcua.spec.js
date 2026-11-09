import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectStableOpcuaValueColumns } from './fixtures/opcuaTableGeometry.js';
const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} OPC UA workflow and display matrix`, async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ path: fixture });
    await page.addInitScript(() => {
      const calls = []; globalThis.__OPCUA_CALLS__ = calls; let profiles = [];
      const execute = async request => {
        calls.push(request);
        if (request.action === 'profiles') return { profiles };
        if (request.action === 'saveProfiles') { profiles = request.profiles; return {}; }
        if (request.action === 'connect') return { sessionId: 'ua-current' };
        if (request.action === 'browse') return { nodes: [{ nodeId: 'ns=1;s=Temperature', displayName: '温度', nodeClass: 'Variable' }] };
        if (request.action === 'read') return { values: [{ nodeId: 'ns=1;s=Temperature', dataType: 'Double', arrayType: 'Scalar', value: 23.5, statusCode: 'Good', sourceTimestamp: '2026-10-21T01:00:00Z', serverTimestamp: '2026-10-21T01:00:00Z' }] };
        if (request.action === 'write') return { statusCode: 'Good' };
        if (request.action === 'subscribe') return { subscriptionId: 'sub1' };
        if (request.action === 'certificates') return { certificates: [{ fingerprint: 'abcdef0123456789'.repeat(4), subject: 'CN=Local Test Server', validFrom: '2026-10-21', validTo: '2027-10-21', trusted: false }] };
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
    await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('传输类型').selectOption('opcua-client');
    await dialog.locator('[name="endpoint-name"]').fill('OPC UA 验证');
    await dialog.getByRole('button', { name: '保存端点' }).click();
    const panel = page.getByRole('region', { name: 'OPC UA 工作台' });
    await expect(panel.getByRole('heading', {name:'OPC UA',exact:true})).toBeVisible();
    expect(await page.evaluate(() => globalThis.__OPCUA_CALLS__.some(r => r.action === 'connect'))).toBe(false);
    await expect(panel.getByText('已保存连接', { exact: true })).toHaveCount(0);
    await panel.getByRole('button',{name:'连接',exact:true}).click();
    await panel.getByRole('button',{name:'节点与监视',exact:true}).click();
    await panel.getByRole('button',{name:'浏览',exact:true}).click();
    await panel.getByRole('button',{name:'读取',exact:true}).click();
    await expect(panel.getByText('23.5',{exact:true})).toBeVisible();
    await panel.getByLabel('选择 温度').check();
    await panel.getByRole('button',{name:'监视所选',exact:false}).click();
    await expect(panel.getByText('当前监视 1 个节点', {exact:false})).toBeVisible();
    await panel.getByRole('button',{name:'准备写入',exact:true}).click();
    await panel.getByLabel('新值',{exact:true}).fill('24.5');
    await expect(panel.getByRole('button',{name:'确认写入',exact:true})).toBeDisabled();
    await panel.getByLabel('我已核对目标节点及新值，确认写入设备').check();
    await panel.getByRole('button',{name:'确认写入',exact:true}).click();
    await expect(panel.getByRole('status')).toContainText('写入成功');
    await panel.getByRole('button',{name:'导出 CSV',exact:true}).click();
    await expect(panel.getByRole('status')).toContainText('已导出');
    await page.getByRole('button',{name:'选择 串口传感器',exact:true}).click();
    await expect(panel).toBeHidden();
    await page.getByRole('button',{name:'选择 OPC UA 验证',exact:true}).click();
    await expect(panel.getByText('当前监视 1 个节点', {exact:false})).toBeVisible();
    for (const dark of [false,true]) for (const large of [false,true]) for (const collapsed of [false,true]) {
      await page.evaluate(({dark,large})=> { globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light'; globalThis.document.documentElement.classList.toggle('large-font',large); },{dark,large});
      const current = (await page.locator('.linklab-shell').getAttribute('class')).includes('tree-collapsed');
      if (current !== collapsed) await page.getByRole('button',{name:collapsed ? '折叠端点列表' : '展开端点列表'}).click();
      for (const tab of ['连接与安全','节点与监视','证书']) {
        await panel.getByRole('button',{name:tab,exact:true}).click();
        if (tab === '证书') await panel.getByRole('button',{name:'刷新证书'}).click();
        if (tab === '节点与监视') {
          await expectStableOpcuaValueColumns(panel.locator('.opcua-table').last());
          const fonts = await panel.locator('.opcua-table').first().evaluate(element => {
            const style = globalThis.getComputedStyle(element);
            return { body: globalThis.getComputedStyle(element.querySelector('td')).fontSize, heading: globalThis.getComputedStyle(element.querySelector('th')).fontSize, expectedBody: style.getPropertyValue('--font-size').trim(), expectedHeading: style.getPropertyValue('--font-size-control').trim() };
          });
          expect(fonts.body).toBe(fonts.expectedBody);
          expect(fonts.heading).toBe(fonts.expectedHeading);
        }
        expect(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
        const box = await panel.boundingBox(); expect(box.width).toBeGreaterThan(450);
        await expect(page.getByRole('button', { name: collapsed ? 'OPC UA 验证' : '选择 OPC UA 验证', exact: true })).toBeVisible();
        await expect(panel.getByRole('button',{name:'断开',exact:true})).toBeInViewport();
        if (dark && large && collapsed && tab === '节点与监视') await page.screenshot({path:testInfo.outputPath(`${runtime}-dark-large.png`)});
      }
    }
    expect(errors).toEqual([]);
  });
}
