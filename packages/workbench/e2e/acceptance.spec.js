import { openWorkspaceTool } from './helpers/workspaceTools.js';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(
  new URL('./fixtures/previewBridge.js', import.meta.url),
);

for (const runtime of ['electron', 'tauri']) {
  async function start(page) {
    await page.addInitScript({ path: fixture });
    await page.goto(
      `http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`,
    );
  }
  test(`${runtime} acceptance executes edited draft, keeps snapshot and exports evidence`, async ({
    page,
  }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await start(page);
    await openWorkspaceTool(page, '验收检查');
    const panel = page.getByRole('dialog', { name: '验收检查', exact: true });
    await expect(
      panel.getByText('暂无可用目标', { exact: false }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '选择 锅炉主站' }).click();
    const entry = page
      .locator('.endpoint-tree__entry')
      .filter({ has: page.getByRole('button', { name: '选择 锅炉主站' }) });
    await entry.getByRole('button', { name: '打开端点' }).click();
    await expect(page.locator('.session-status-bar')).toContainText('已打开');
    await openWorkspaceTool(page, '验收检查');
    await panel.locator('[name="acceptance-plan-name"]').fill('现场寄存器验收');
    await panel
      .locator('[name="acceptance-target"]')
      .selectOption('modbus-master');
    await panel.locator('[name="acceptance-address"]').fill('10');
    await panel.locator('[name="acceptance-expected"]').fill('[256]');
    await panel.getByRole('button', { name: '执行检查', exact: true }).click();
    await expect(panel.locator('.acceptance-summary')).toContainText('通过');
    await panel
      .locator('[name="acceptance-plan-name"]')
      .fill('尚未再次执行的草稿');
    await expect(panel.locator('.acceptance-summary')).toContainText(
      '现场寄存器验收',
    );
    await panel.getByRole('button', { name: '导出 JSON', exact: true }).click();
    await panel
      .getByRole('button', { name: '导出 Markdown', exact: true })
      .click();
    const exports = await page.evaluate(
      () => globalThis.__INEED_PREVIEW_ACCEPTANCE_EXPORTS__,
    );
    expect(exports.map((row) => row.fileName)).toEqual([
      'linklab-acceptance-report.json',
      'linklab-acceptance-report.md',
    ]);
    expect(JSON.parse(exports[0].content).plan.name).toBe('现场寄存器验收');
    await panel.locator('[name="acceptance-expected"]').fill('[257]');
    await panel.getByRole('button', { name: '执行检查', exact: true }).click();
    await expect(panel.locator('.acceptance-summary')).toContainText('失败');
    await page.keyboard.press('Escape');
    await openWorkspaceTool(page, '验收检查');
    await expect(panel.locator('.acceptance-summary')).toContainText('失败');
    expect(errors).toEqual([]);
  });
  test(`${runtime} acceptance fits themes fonts sidebars and narrow window with keyboard access`, async ({
    page,
  }, testInfo) => {
    await start(page);
    if (testInfo.project.name === 'portrait-820x1180')
      await page.setViewportSize({ width: 680, height: 620 });
    for (const dark of [false, true])
      for (const large of [false, true])
        for (const collapsed of [false, true]) {
          await page.evaluate(
            ({ dark, large }) => {
              globalThis.document.documentElement.dataset.theme = dark
                ? 'dark'
                : 'light';
              globalThis.document.documentElement.classList.toggle(
                'large-font',
                large,
              );
            },
            { dark, large },
          );
          const isCollapsed = (
            await page.locator('.linklab-shell').getAttribute('class')
          ).includes('tree-collapsed');
          if (isCollapsed !== collapsed)
            await page
              .getByRole('button', {
                name: collapsed ? '折叠端点列表' : '展开端点列表',
              })
              .click();
          const trigger = page.getByRole('button', { name: '打开工具箱' });
          await expect(trigger).toBeInViewport();
          await openWorkspaceTool(page, '验收检查');
          const panel = page.getByRole('dialog', {
            name: '验收检查',
            exact: true,
          });
          const close = panel.getByRole('button', { name: '关闭验收检查' });
          await expect(close).toBeFocused();
          await panel
            .getByRole('button', { name: '添加检查', exact: true })
            .click();
          await expect(panel.locator('[name="acceptance-check"]')).toHaveValue(
            String(
              (await panel
                .locator('[name="acceptance-check"] option')
                .count()) - 1,
            ),
          );
          const layout = await panel.evaluate((element) => ({
            tooWide: element.scrollWidth > element.clientWidth + 1,
            controlsOutside: [
              ...element.querySelectorAll('input,select,textarea,button'),
            ].some(
              (item) =>
                item.getBoundingClientRect().right >
                element.getBoundingClientRect().right + 1,
            ),
            inView:
              element.getBoundingClientRect().bottom <= globalThis.innerHeight,
            font: globalThis.getComputedStyle(element.querySelector('input'))
              .fontSize,
          }));
          expect(layout).toEqual({
            tooWide: false,
            controlsOutside: false,
            inView: true,
            font: large ? '13px' : '12px',
          });
          await close.focus();
          await page.keyboard.press('Shift+Tab');
          expect(
            await panel.evaluate((element) =>
              element.contains(globalThis.document.activeElement),
            ),
          ).toBe(true);
          await page.keyboard.press('Tab');
          await expect(close).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(trigger).toBeFocused();
        }
  });
}
