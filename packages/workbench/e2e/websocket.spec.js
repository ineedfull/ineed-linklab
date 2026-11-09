import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} WebSocket form, typed send, peers and display matrix`, async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    async function createEndpoint(transport, name) {
      await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
      const form = page.getByRole('dialog', { name: '新建端点' });
      await form.locator('[name="endpoint-transport"]').selectOption(transport);
      await form.locator('[name="endpoint-name"]').fill(name);
      expect(await form.locator('[name="receive-framing-mode"]').count()).toBe(0);
      if (transport.endsWith('client')) {
        await form.locator('[name="websocket-url"]').fill('ws://127.0.0.1:9000/socket?token=querysecret');
        await form.locator('[name="websocket-subprotocols"]').fill('telemetry, chat');
        await form.locator('[name="websocket-header-name-0"]').fill('Authorization');
        await form.locator('[name="websocket-header-value-0"]').fill('Bearer sessionsecret');
      } else {
        await expect(form.locator('[name="websocket-listen-host"]')).toHaveValue('127.0.0.1');
      }
      await form.getByRole('button', { name: '保存端点', exact: true }).click();
      await expect(form).toHaveCount(0);
      const row = page.locator('.endpoint-row').filter({ hasText: name });
      await row.getByRole('button', { name: `选择 ${name}` }).click();
      await row.getByRole('button', { name: '打开端点' }).click();
      await expect(page.locator('.session-state')).toHaveText(transport.endsWith('server') ? '监听中' : '已打开');
      return row;
    }
    const client = await createEndpoint('websocket-client', 'WebSocket 本地客户端');
    await expect(client).not.toContainText('querysecret');
    await client.getByRole('button', { name: '端点操作' }).click();
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    const editClient = page.getByRole('dialog', { name: '编辑端点' });
    await expect(editClient.locator('[name="websocket-header-value-0"]')).toHaveValue('Bearer sessionsecret');
    await editClient.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.frame-direction small').first()).toHaveText('TXT');
    await expect(page.locator('.send-panel')).not.toContainText('追加 CRLF');
    await page.getByRole('radio', { name: 'HEX', exact: true }).click();
    await page.getByRole('textbox', { name: '发送内容' }).fill('00 FF');
    await page.locator('.send-panel__footer').getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.at(-1)?.messageType)).toBe('binary');
    expect(await page.evaluate(() => Array.from(globalThis.__INEED_PREVIEW_SENDS__.at(-1).bytes))).toEqual([0, 255]);
    const server = await createEndpoint('websocket-server', 'WebSocket 本地服务端');
    await page.getByLabel('WebSocket 发送模式').selectOption('selected');
    await page.locator('.send-panel__peer-picker summary').click();
    await page.locator('[name="tcp-peer-target"]').nth(0).check();
    await page.locator('[name="tcp-peer-target"]').nth(1).check();
    await page.getByRole('textbox', { name: '发送内容' }).fill('hello');
    await page.locator('.send-panel__footer').getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.at(-1)?.target.peerIds?.length)).toBe(2);
    await expect(page.locator('.endpoint-tree__peers[aria-label="WebSocket 服务端连接"]')).toBeVisible();
    for (const dark of [false, true]) for (const large of [false, true]) for (const collapsed of [false, true]) {
      await page.evaluate(({ dark, large }) => { globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light'; globalThis.document.documentElement.classList.toggle('large-font', large); }, { dark, large });
      const current = (await page.locator('.linklab-shell').getAttribute('class')).includes('tree-collapsed');
      if (current !== collapsed) await page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表' }).click();
      expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
      await expect(page.getByLabel('WebSocket 消息类型')).toBeInViewport();
      if (!collapsed) for (const [kind, row] of [['client', client], ['server', server]]) {
        await row.getByRole('button', { name: '端点操作' }).click();
        await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
        const form = page.getByRole('dialog', { name: '编辑端点' });
        await expect(form.locator(`[name="${kind === 'client' ? 'websocket-url' : 'websocket-listen-host'}"]`)).toBeVisible();
        await expect(form.getByRole('button', { name: '保存端点', exact: true })).toBeInViewport();
        expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
        if (dark && large) await page.screenshot({ path: testInfo.outputPath(`${runtime}-websocket-${kind}-dark-large.png`) });
        await form.getByRole('button', { name: '取消', exact: true }).click();
      }
    }
    expect(errors).toEqual([]);
  });
}
