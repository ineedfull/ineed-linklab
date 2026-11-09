import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openWorkspaceTool } from './helpers/workspaceTools.js';

const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
test.beforeEach(async ({ page }, info) => {
  await page.addInitScript({ path: fixture });
  const port = info.project.metadata.runtime === 'tauri' ? 4174 : 4173;
  await page.goto(`http://127.0.0.1:${port}/`);
});

test('workspace tools preserve the communication draft and return focus to their launcher', async ({ page }) => {
  const trigger = page.getByRole('button', { name: '打开工具箱', exact: true });
  const menu = page.getByRole('region', { name: '工具箱菜单' });
  await expect(page.getByRole('button', { name: '打开设备模板' })).toHaveCount(0);
  await page.getByRole('button', { name: '选择 本地调试服务', exact: true }).click();
  const endpoint = page.locator('.endpoint-tree__entry').filter({ has: page.getByRole('button', { name: '选择 本地调试服务', exact: true }) });
  await endpoint.getByRole('button', { name: '打开端点', exact: true }).click();
  await expect(page.locator('.session-status-bar')).toContainText('监听中');
  const editor = page.locator('.send-panel [contenteditable=true]');
  await editor.fill('未发送的通信草稿\n第二行');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('button', { name: '打开编码与校验' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('button', { name: '打开设备模板' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('button', { name: '打开验收检查' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('button', { name: '打开编码与校验' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: '打开设置', exact: true })).toBeFocused();

  for (const [entry, title] of [['编码与校验', '工具箱'], ['设备模板', '设备模板'], ['验收检查', '验收检查']]) {
    await openWorkspaceTool(page, entry);
    await expect(menu).toBeHidden();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect.poll(() => editor.locator('.cm-line').allTextContents()).toEqual(['未发送的通信草稿', '第二行']);
  }
  expect(await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.length)).toBe(0);
});

test('workspace tool menu fits themes fonts and collapsed sidebar without clipping', async ({ page }, info) => {
  await page.setViewportSize({ width: 920, height: 620 });
  const trigger = page.getByRole('button', { name: '打开工具箱', exact: true });
  const menu = page.getByRole('region', { name: '工具箱菜单' });
  for (const dark of [false, true]) for (const large of [false, true]) for (const collapsed of [false, true]) {
    await page.evaluate(({ dark, large }) => {
      globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      globalThis.document.documentElement.classList.toggle('large-font', large);
    }, { dark, large });
    const isCollapsed = await page.locator('.linklab-shell').evaluate(node => node.classList.contains('tree-collapsed'));
    if (collapsed !== isCollapsed) await page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表' }).click();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('button')).toHaveCount(3);
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(920);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(620);
    expect(await menu.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    // The menu is teleported, so hit testing also checks sidebar overflow clipping.
    expect(await menu.getByRole('button', { name: '打开验收检查' }).evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(globalThis.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    if (dark === large && large === collapsed) await page.screenshot({ path: info.outputPath(`tools-${dark ? 'dark-large-collapsed' : 'light-normal-expanded'}.png`) });
    await page.getByRole('button', { name: collapsed ? '展开端点列表' : '折叠端点列表' }).click();
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
});
