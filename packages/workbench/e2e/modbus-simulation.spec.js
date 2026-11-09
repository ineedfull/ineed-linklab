import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} slave automatic switch, page lifecycle and settings layout`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.metadata.runtime && testInfo.project.metadata.runtime !== runtime);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    const selectSlave = page.getByRole('button', { name: '选择 锅炉模拟器', exact: true });
    await selectSlave.click();
    const row = page.locator('.endpoint-row').filter({ has: selectSlave });
    await row.getByRole('button', { name: '打开端点', exact: true }).click();
    const toggle = page.getByRole('switch', { name: '自动变化', exact: true });
    await expect(toggle).not.toBeChecked();
    await page.getByRole('button', { name: '自动变化设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '自动变化设置', exact: true });
    await dialog.getByRole('checkbox', { name: '模拟 出水温度', exact: true }).check();
    for (const [name, value] of [['出水温度下限', '20'], ['出水温度上限', '22'], ['出水温度步长', '1'], ['变化间隔（毫秒）', '200']]) {
      await dialog.getByRole('spinbutton', { name, exact: true }).fill(value);
    }
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
    await toggle.check();
    const input = page.locator('.modbus-business-value input');
    await expect(input).toBeDisabled();
    await expect.poll(() => input.inputValue()).not.toBe('25.6');
    await page.getByRole('button', { name: '选择 串口传感器', exact: true }).click();
    await selectSlave.click();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(input).toBeEnabled();
    const held = await input.inputValue();
    await page.waitForTimeout(500);
    await expect(input).toHaveValue(held);
    await row.getByRole('button', { name: '关闭端点', exact: true }).click();
    await row.getByRole('button', { name: '打开端点', exact: true }).click();
    await expect(toggle).not.toBeChecked();

    await page.setViewportSize({ width: 680, height: 620 });
    for (const dark of [false, true]) for (const large of [false, true]) for (const collapsed of [false, true]) {
      await page.evaluate(({ dark, large }) => {
        globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        globalThis.document.documentElement.classList.toggle('large-font', large);
      }, { dark, large });
      const current = (await page.locator('.linklab-shell').getAttribute('class')).includes('tree-collapsed');
      if (current !== collapsed) await page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表', exact: true }).click();
      await page.getByRole('button', { name: '自动变化设置', exact: true }).click();
      await expect(dialog).toBeVisible();
      const geometry = await dialog.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const controls = [...node.querySelectorAll('input,button')].filter(el => el.getClientRects().length);
        return { width: node.scrollWidth <= node.clientWidth + 1,
          inside: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= globalThis.innerWidth && bounds.bottom <= globalThis.innerHeight,
          controls: controls.every(el => { const rect = el.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right + 1; }) };
      });
      expect(geometry).toEqual({ width: true, inside: true, controls: true });
      await page.screenshot({ path: testInfo.outputPath(`${runtime}-${dark}-${large}-${collapsed}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: '自动变化设置', exact: true })).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
}
