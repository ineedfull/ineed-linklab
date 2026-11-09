import { openWorkspaceTool } from './helpers/workspaceTools.js';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(
  new URL('./fixtures/previewBridge.js', import.meta.url),
);
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} reusable model creates two sites and immutable fresh engineering reports`, async ({
    page,
  }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript({ path: fixture });
    await page.goto(
      `http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`,
    );
    await openWorkspaceTool(page, '设备模板');
    const panel = page.getByRole('dialog', { name: '设备模板', exact: true });
    await panel.locator('[name="model-source"]').selectOption('modbus-master');
    await panel.locator('[name="model-name"]').fill('T-100');
    await panel.getByRole('button', { name: '提取点表', exact: true }).click();
    await panel
      .getByRole('button', { name: '保存新版本', exact: true })
      .click();
    await expect(panel.getByRole('status')).toContainText('v1');
    for (const name of ['Site A', 'Site B']) {
      await panel.locator('[name="model-site-name"]').fill(name);
      await panel
        .getByRole('button', { name: '新建端点和验收方案', exact: true })
        .click();
      await expect(panel.getByRole('status')).toContainText(
        `已新建端点 ${name}`,
      );
    }
    await panel.getByRole('button', { name: '导出模板', exact: true }).click();
    const exported = await page.evaluate(() =>
      globalThis.__INEED_PREVIEW_ACCEPTANCE_EXPORTS__.at(-1),
    );
    expect(JSON.parse(exported.content).model).toBe('T-100');
    expect(exported.content).not.toContain('127.0.0.1');
    await panel.getByRole('button', { name: '关闭设备模板' }).click();
    const row = page.locator('.endpoint-tree__entry').filter({
      has: page.getByRole('button', { name: '选择 Site A', exact: true }),
    });
    await row.getByRole('button', { name: '打开端点' }).click();
    await expect(row.getByRole('button', { name: '关闭端点' })).toBeVisible();
    await openWorkspaceTool(page, '验收检查');
    const acceptance = page.getByRole('dialog', {
      name: '验收检查',
      exact: true,
    });
    await acceptance
      .locator('[name="acceptance-saved-plan"]')
      .selectOption({ label: 'Site A · T-100 v1' });
    await acceptance
      .locator('[name="acceptance-target"]')
      .selectOption({ label: 'Site A' });
    await acceptance
      .getByRole('button', { name: '执行检查', exact: true })
      .click();
    await expect(acceptance.locator('.acceptance-summary')).toContainText(
      '通过',
    );
    await acceptance
      .getByRole('button', { name: '导出 JSON', exact: true })
      .click();
    const report = JSON.parse(
      await page.evaluate(
        () => globalThis.__INEED_PREVIEW_ACCEPTANCE_EXPORTS__.at(-1).content,
      ),
    );
    expect(report.results[0].actual).toBe(25.6);
    expect(report.results[0].evidence.engineering.raw[0]).toBe(256);
    expect(report.plan.checks[0].engineering.template.version).toBe(1);
    await acceptance.getByRole('button', { name: '关闭验收检查' }).click();
    await openWorkspaceTool(page, '设备模板');
    await panel
      .getByRole('button', { name: '保存新版本', exact: true })
      .click();
    await expect(panel.getByRole('status')).toContainText('v2');
    await panel.locator('[name="model-import"]').evaluate((el) => {
      el.closest('details').open = true;
    });
    await panel.locator('[name="model-import"]').fill(exported.content);
    await panel.getByRole('button', { name: '预览导入' }).click();
    await expect(panel.getByRole('region', { name: '导入预览' })).toContainText(
      'T-100',
    );
    await panel.getByRole('button', { name: '确认导入为新模板' }).click();
    await expect(panel.locator('[name="model-version"] option')).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect(errors).toEqual([]);
  });
  test(`${runtime} model dialog fits theme font sidebar and narrow window`, async ({
    page,
  }) => {
    await page.addInitScript({ path: fixture });
    await page.goto(
      `http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`,
    );
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
          const current = (
            await page.locator('.linklab-shell').getAttribute('class')
          ).includes('tree-collapsed');
          if (current !== collapsed)
            await page
              .getByRole('button', {
                name: collapsed ? '折叠端点列表' : '展开端点列表',
              })
              .click();
          const trigger = page.getByRole('button', { name: '打开工具箱' });
          await openWorkspaceTool(page, '设备模板');
          const panel = page.getByRole('dialog', {
            name: '设备模板',
            exact: true,
          });
          await panel
            .locator('[name="model-source"]')
            .selectOption('modbus-master');
          await panel
            .getByRole('button', { name: '提取点表', exact: true })
            .click();
          const layout = await panel.evaluate((el) => ({
            width: el.scrollWidth <= el.clientWidth + 1,
            viewport:
              el.getBoundingClientRect().bottom <= globalThis.innerHeight,
            controls: [
              ...el.querySelectorAll('input,select,textarea,button'),
            ].every(
              (item) =>
                item.getBoundingClientRect().right <=
                el.getBoundingClientRect().right + 1,
            ),
          }));
          expect(layout).toEqual({
            width: true,
            viewport: true,
            controls: true,
          });
          await page.keyboard.press('Escape');
          await expect(panel).toBeHidden();
          await expect(trigger).toBeFocused();
        }
  });
}
