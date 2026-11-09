import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} clears JSON markers across themes, font sizes and sidebar states`, async ({ page }) => {
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    const server = page.getByRole('button', { name: '选择 本地调试服务', exact: true });
    await server.click();
    await page.locator('.endpoint-row').filter({ has: server })
      .getByRole('button', { name: '打开端点', exact: true }).click();
    const panel = page.locator('.send-panel');
    const editor = panel.locator('[contenteditable="true"]');
    const markers = panel.locator('.cm-lint-marker-error');
    for (const theme of ['light', 'dark']) {
      for (const large of [false, true]) {
        await page.getByRole('button', { name: '打开设置', exact: true }).click();
        const settings = page.getByRole('dialog', { name: '设置', exact: true });
        await settings.getByLabel('主题', { exact: true }).selectOption(theme);
        await settings.getByLabel('大字体', { exact: true }).setChecked(large);
        const save = settings.getByRole('button', { name: '保存', exact: true });
        await (await save.isEnabled() ? save : settings.getByRole('button', { name: '取消', exact: true })).click();
        for (const collapsed of [false, true]) {
          const toggle = page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表', exact: true });
          if (await toggle.count()) await toggle.click();
          await panel.getByRole('radio', { name: 'JSON', exact: true }).click();
          await editor.fill('{ invalid');
          await expect(markers).toHaveCount(1);
          await panel.getByRole('radio', { name: 'Text', exact: true }).click();
          await expect(markers).toHaveCount(0);
          await expect(panel.locator('.cm-lintRange-error')).toHaveCount(0);
          await panel.getByRole('radio', { name: 'JSON', exact: true }).click();
          await expect(markers).toHaveCount(1);
          await panel.getByRole('radio', { name: 'HEX', exact: true }).click();
          await expect(markers).toHaveCount(0);
          await expect(panel.locator('.cm-lintRange-error')).toHaveCount(0);
          await expect(editor).toHaveText('{ invalid');
        }
      }
    }
  });
}
