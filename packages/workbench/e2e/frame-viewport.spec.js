import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} resumes to the bottom after paused inspection and continued reception`, async ({ page }) => {
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    const server = page.getByRole('button', { name: '选择 本地调试服务', exact: true });
    await server.click();
    await page.locator('.endpoint-tree__entry').filter({ has: server }).getByRole('button', { name: '打开端点', exact: true }).click();
    const emit = (start, count) => page.evaluate(({ start, count }) => {
      for (let index = start; index < start + count; index++) globalThis.__INEED_PREVIEW_EMIT_FRAME__('tcp-server-local', new TextEncoder().encode(`inspection-${index}`));
    }, { start, count });
    const list = page.locator('.frame-list');
    const bottomGap = () => list.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
    for (let round = 0; round < 4; round++) {
      await emit(round * 1000, 600);
      await expect.poll(bottomGap).toBeLessThanOrEqual(1);
      await list.dispatchEvent('wheel', { deltaY: -100 });
      await list.evaluate(node => { node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2); node.dispatchEvent(new Event('scroll')); });
      const selected = page.locator('.frame-list__item').nth(6).locator('.frame-preview');
      const original = await selected.locator('pre').textContent();
      await selected.click();
      await expect(page.locator('.message-inspector pre')).toHaveText(original);
      await emit(round * 1000 + 600, 96);
      await expect(page.locator('.new-records')).toBeVisible();
      await expect(page.locator('.message-inspector pre')).toHaveText(original);
      await page.getByRole('button', { name: '关闭消息详情', exact: true }).click();
      await page.locator('.new-records').click();
      await expect(page.getByRole('button', { name: '跟随最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(bottomGap).toBeLessThanOrEqual(1);
      await expect(page.locator('.frame-list__item').last().locator('pre')).toHaveText(`inspection-${round * 1000 + 695}`);
    }
  });

  test(`${runtime} streams retain scrolling and row actions across the display matrix`, async ({ page, context }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    const server = page.getByRole('button', { name: '选择 本地调试服务', exact: true });
    await server.click();
    await page.locator('.endpoint-tree__entry').filter({ has: server }).getByRole('button', { name: '打开端点', exact: true }).click();
    await page.evaluate(() => {
      for (let index = 0; index < 600; index++) globalThis.__INEED_PREVIEW_EMIT_FRAME__('tcp-server-local', new TextEncoder().encode(`viewport-${index}`));
    });
    const rows = page.locator('.frame-list__item');
    await expect(rows.last().locator('pre')).toHaveText('viewport-599');
    for (const dark of [false, true]) for (const large of [false, true]) for (const compact of [false, true]) for (const collapsed of [false, true]) {
      // Apply real preferences so the editor's theme/font props change too.
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      await settings.getByLabel('主题', { exact: true }).selectOption(dark ? 'dark' : 'light');
      await settings.getByLabel('大字体', { exact: true }).setChecked(large);
      const save = settings.getByRole('button', { name: '保存', exact: true });
      await settings.getByRole('button', { name: await save.isEnabled() ? '保存' : '取消', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'dark' : 'light');
      await expect(page.locator('.cm-scroller')).toHaveCSS('font-size', large ? '16px' : '13px');
      const density = await page.locator('.linklab-shell').getAttribute('data-density');
      if ((density === 'compact') !== compact) await page.getByRole('button', { name: compact ? '紧凑' : '舒适', exact: true }).click();
      const isCollapsed = await page.locator('.linklab-shell').evaluate(node => node.classList.contains('tree-collapsed'));
      if (collapsed !== isCollapsed) await page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表', exact: true }).click();
      await expect(rows.last().locator('pre')).toHaveText('viewport-599');
      await expect.poll(() => rows.count()).toBeLessThan(50);
      const geometry = await page.locator('.frame-list').evaluate(node => {
        const container = node.getBoundingClientRect();
        const last = node.querySelector('.frame-list__item:last-of-type') ?? [...node.querySelectorAll('.frame-list__item')].at(-1);
        const rect = last.getBoundingClientRect();
        return { bottomGap: node.scrollHeight - node.clientHeight - node.scrollTop,
          visible: rect.top < container.bottom && rect.bottom <= container.bottom + 1,
          overflow: node.scrollWidth - node.clientWidth };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.visible).toBe(true);
      expect(geometry.bottomGap).toBeLessThanOrEqual(1);
      if (large && compact && collapsed) await page.screenshot({ path: info.outputPath(`${runtime}-${dark ? 'dark' : 'light'}-viewport.png`) });
    }
    const list = page.locator('.frame-list');
    await list.dispatchEvent('wheel', { deltaY: -100 });
    await list.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await expect(rows.first().locator('pre')).toHaveText('viewport-100');
    await rows.first().locator('.frame-preview').click();
    await expect(page.locator('.message-inspector pre')).toHaveText('viewport-100');
    await page.getByRole('button', { name: '复制原始文本', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('viewport-100');
    await page.keyboard.press('Escape');
    await page.evaluate(() => globalThis.__INEED_PREVIEW_EMIT_FRAME__('tcp-server-local', new TextEncoder().encode('viewport-600')));
    await expect(page.locator('.new-records')).toBeVisible();
    await page.locator('.new-records').click();
    await expect(rows.last().locator('pre')).toHaveText('viewport-600');
  });
}
