import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} About preserves the workbench and restores keyboard focus`, async ({ page }) => {
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    await page.getByRole('button', { name: '选择 本地调试服务' }).click();
    await page.getByRole('tab', { name: '日志', exact: true }).click();
    const trigger = page.getByRole('button', { name: '打开关于' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '关于', exact: true });
    await expect(dialog).toContainText('Ineed LinkLab');
    await expect(dialog).toContainText('多协议通信调试助手');
    await expect(dialog.locator('.about-panel__runtime')).toHaveText(new RegExp(runtime, 'i'));
    const close = dialog.getByRole('button', { name: '关闭关于' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    // Explicit tab stops also keep WebKit's default keyboard mode inside About.
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press(key);
        expect(await dialog.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
      }
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('tab', { name: '日志', exact: true })).toHaveAttribute('aria-selected', 'true');
    await trigger.click();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(trigger).toBeFocused();
  });
}
