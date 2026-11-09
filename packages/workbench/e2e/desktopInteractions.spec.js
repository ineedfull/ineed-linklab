import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} retains layout and supports pause, raw copy and keyboard settings`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    const server = page.getByRole('button', { name: '选择 本地调试服务' });
    await expect(server).toBeVisible();
    await server.click();
    await page.getByRole('button', { name: '紧凑', exact: true }).click();
    await page.getByRole('separator', { name: '调整资源栏宽度' }).press('ArrowRight');
    await page.reload();
    await expect(page.locator('.linklab-shell')).toHaveAttribute('data-density', 'compact');
    await expect(page.getByRole('separator', { name: '调整资源栏宽度' })).toHaveAttribute('aria-valuenow', '250');
    await page.locator('.endpoint-tree__entry').filter({ has: server }).getByRole('button', { name: '打开端点' }).click();
    await server.click();
    await expect(page.locator('[data-frame-key]')).toHaveCount(36);
    await page.locator('.frame-list').dispatchEvent('wheel', { deltaY: -80 });
    await expect(page.getByRole('button', { name: '已暂停跟随' })).toBeVisible();
    const payload = '原文 PING';
    await expect(page.locator('select[name="framing"]')).toHaveValue('line');
    const wireText = `${payload}\n`;
    await page.locator('.send-panel [contenteditable="true"]').fill(payload);
    await page.locator('.send-panel [contenteditable="true"]').press('Control+Enter');
    await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.length)).toBe(1);
    expect(await page.evaluate(() => Array.from(globalThis.__INEED_PREVIEW_SENDS__[0].bytes)))
      .toEqual(Array.from(new TextEncoder().encode(wireText)));
    await page.evaluate(() => {
      const request = globalThis.__INEED_PREVIEW_SENDS__[0];
      globalThis.__INEED_PREVIEW_EMIT_FRAME__(request.endpointId, request.bytes);
    });
    await expect(page.locator('.new-records')).toBeVisible();
    await page.locator('.new-records').click();
    await expect(page.getByRole('button', { name: '跟随最新' })).toBeVisible();
    await page.locator('.frame-preview').last().click();
    await page.getByRole('button', { name: '复制原始文本' }).click();
    // Raw copy preserves the received wire bytes, including the line delimiter.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(wireText);
    await page.keyboard.press('Escape');
    await expect(page.locator('.message-inspector')).toHaveCount(0);
    await page.getByRole('button', { name: '打开设置' }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('主题', { exact: true }).selectOption('dark');
    await page.keyboard.press('Escape');
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: '放弃修改' }).click();
    await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: '打开设置' }).click();
    await settings.getByLabel('主题', { exact: true }).selectOption('dark');
    await settings.getByRole('button', { name: '保存', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
}
