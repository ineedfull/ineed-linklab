import { openWorkspaceTool } from './helpers/workspaceTools.js';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));

for (const runtime of ['electron', 'tauri']) {
  async function start(page) {
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    await openWorkspaceTool(page, '编码与校验');
    return page.getByRole('dialog', { name: '工具箱', exact: true });
  }
  test(`${runtime} toolbox converts all nine tools and preserves the communication draft`, async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    await page.getByRole('button', { name: '选择 本地调试服务' }).click();
    await page.locator('.endpoint-tree__entry').filter({ has: page.getByRole('button', { name: '选择 本地调试服务' }) }).getByRole('button', { name: '打开端点' }).click();
    await expect(page.locator('.session-status-bar')).toContainText('监听中');
    const composer = page.locator('.send-panel [contenteditable="true"]');
    await composer.fill('Keep this communication draft');
    const trigger = page.getByRole('button', { name: '打开工具箱' });
    await openWorkspaceTool(page, '编码与校验');
    const panel = page.getByRole('dialog', { name: '工具箱', exact: true });
    const input = panel.getByRole('textbox', { name: '输入数据', exact: true });
    const calculate = async () => panel.getByRole('button', { name: '计算', exact: true }).click();
    const choose = async (group, id) => {
      await panel.getByRole('button', { name: group, exact: true }).click();
      await panel.getByRole('combobox', { name: '当前工具', exact: true }).selectOption(id);
    };
    await panel.getByRole('button', { name: '载入示例' }).click(); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：发送字节', exact: true })).toHaveValue('C5 CD');
    await expect(panel.getByText('校验通过：', { exact: false })).toHaveCount(0);
    const expected = panel.getByLabel('待核对校验字节（HEX，可留空）');
    await expected.fill('C5 CD'); await calculate();
    await expect(panel.getByRole('status')).toContainText('校验通过');
    await expected.fill('CD C5'); await calculate();
    await expect(panel.getByRole('alert')).toContainText('校验不匹配');
    await input.fill('A'); await calculate();
    await expect(panel.getByRole('alert')).toContainText('HEX');
    await expect(panel.getByRole('textbox', { name: '结果：发送字节', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '载入示例' }).click(); await calculate();
    await panel.getByRole('button', { name: '复制 发送字节', exact: true }).click();
    await expect(panel.getByText('已复制。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('C5 CD');
    await choose('编码转换', 'ascii'); await input.fill('Hello'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：HEX 字节', exact: true })).toHaveValue('48 65 6C 6C 6F');
    await input.fill('中文'); await calculate(); await expect(panel.getByRole('alert')).toContainText('ASCII');
    await choose('编码转换', 'bcd');
    await input.fill('0012.34'); await panel.getByLabel('小数位', { exact: true }).fill('2'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：HEX 字节', exact: true })).toHaveValue('00 12 34');
    await choose('数值与字节', 'radix'); await input.fill('FF');
    await panel.getByRole('combobox', { name: '输入进制', exact: true }).selectOption('16');
    await panel.getByRole('combobox', { name: '位宽', exact: true }).selectOption('8');
    await panel.getByRole('combobox', { name: '符号', exact: true }).selectOption('signed'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：十进制', exact: true })).toHaveValue('-1');
    await choose('数值与字节', 'integer'); await input.fill('18446744073709551615');
    await panel.getByRole('combobox', { name: '位宽', exact: true }).selectOption('64'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：HEX 字节', exact: true })).toHaveValue('FF FF FF FF FF FF FF FF');
    await choose('数值与字节', 'float'); await input.fill('1');
    await panel.getByRole('combobox', { name: '字节 / 字顺序', exact: true }).selectOption('reverse'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：HEX 字节', exact: true })).toHaveValue('00 00 80 3F');
    await choose('数值与字节', 'order'); await input.fill('11 22 33 44');
    await panel.getByRole('combobox', { name: '字节 / 字顺序', exact: true }).selectOption('reverse-words'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：HEX 字节', exact: true })).toHaveValue('33 44 11 22');
    await choose('数值与字节', 'bits'); await input.fill('8001');
    await panel.getByRole('combobox', { name: '位宽', exact: true }).selectOption('16');
    await panel.getByRole('combobox', { name: '位操作', exact: true }).selectOption('xor');
    await panel.getByLabel('掩码（HEX 整数）').fill('0001'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：HEX 位模式', exact: true })).toHaveValue('8000');
    await choose('校验计算', 'checksum'); await input.fill('FF 02 03');
    await panel.getByRole('combobox', { name: '校验算法', exact: true }).selectOption('lrc8'); await calculate();
    await expect(panel.getByRole('textbox', { name: '结果：发送字节', exact: true })).toHaveValue('FC');
    await choose('校验计算', 'crc'); await expect(input).toHaveValue('01 03 00 00 00 0A');
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    await expect(composer).toHaveText('Keep this communication draft');
    expect(await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.length)).toBe(0);
    expect(errors).toEqual([]);
  });

  test(`${runtime} toolbox examples follow the selected conversion and checksum scenario`, async ({ page }) => {
    const panel = await start(page);
    const choose = async (group, id) => {
      await panel.getByRole('button', { name: group, exact: true }).click();
      await panel.locator('[name="toolbox-tool"]').selectOption(id);
    };
    const select = async (name, value) => panel.locator(`[name="${name}"]`).selectOption(value);
    const sample = async () => {
      await panel.getByRole('button', { name: '载入示例', exact: true }).click();
      await panel.getByRole('button', { name: '计算', exact: true }).click();
      await expect(panel.getByRole('alert')).toHaveCount(0);
    };
    await choose('编码转换', 'ascii'); await select('direction', 'decode'); await sample();
    await expect(panel.locator('[name="direction"]')).toHaveValue('decode');
    await expect(panel.getByLabel('结果：字符（转义展示）', { exact: true })).toHaveValue('Hello\\r\\n');
    await choose('编码转换', 'bcd'); await select('direction', 'decode');
    await select('order', 'little'); await panel.locator('[name="decimals"]').fill('2'); await sample();
    await expect(panel.getByLabel('结果：十进制数字', { exact: true })).toHaveValue('0012.34');
    await choose('数值与字节', 'radix'); await select('base', '16'); await select('width', '8');
    await select('signed', 'signed'); await sample();
    await expect(panel.getByLabel('结果：十进制', { exact: true })).toHaveValue('-123');
    await choose('数值与字节', 'integer'); await select('direction', 'decode'); await select('width', '64');
    await select('order', 'reverse-words'); await select('signed', 'signed'); await sample();
    await expect(panel.getByLabel('结果：有符号十进制', { exact: true })).toHaveValue('-12345');
    await choose('数值与字节', 'float'); await select('direction', 'decode'); await select('width', '64');
    await select('order', 'reverse'); await sample();
    await expect(panel.getByLabel('结果：浮点值', { exact: true })).toHaveValue('0.1');
    await choose('数值与字节', 'bits'); await select('width', '8'); await select('operation', 'xor'); await sample();
    await expect(panel.getByLabel('结果：HEX 位模式', { exact: true })).toHaveValue('8E');
    await choose('校验计算', 'crc'); await select('algorithm', 'crc32-isohdlc'); await select('wireOrder', 'big');
    await panel.locator('[name="expected"]').fill('00'); await sample();
    await expect(panel.locator('[name="algorithm"]')).toHaveValue('crc32-isohdlc');
    await expect(panel.locator('[name="wireOrder"]')).toHaveValue('big');
    await expect(panel.getByLabel('结果：发送字节', { exact: true })).toHaveValue('CB F4 39 26');
    await expect(panel.getByRole('status')).toContainText('校验通过');
  });

  test(`${runtime} toolbox fits themes, fonts and sidebar states with keyboard access`, async ({ page }, testInfo) => {
    const panel = await start(page);
    await page.keyboard.press('Escape');
    if (testInfo.project.name === 'portrait-820x1180') await page.setViewportSize({ width: 920, height: 620 });
    for (const dark of [false, true]) for (const large of [false, true]) for (const collapsed of [false, true]) {
      await page.evaluate(({ dark, large }) => {
        globalThis.document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        globalThis.document.documentElement.classList.toggle('large-font', large);
      }, { dark, large });
      const shell = page.locator('.linklab-shell');
      const isCollapsed = (await shell.getAttribute('class')).includes('tree-collapsed');
      if (isCollapsed !== collapsed) await page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表' }).click();
      const trigger = page.getByRole('button', { name: '打开工具箱' });
      await expect(trigger).toBeInViewport();
      await openWorkspaceTool(page, '编码与校验');
      await expect(panel.getByRole('button', { name: '关闭工具箱' })).toBeFocused();
      await panel.getByRole('button', { name: '载入示例' }).click();
      await panel.getByRole('button', { name: '计算', exact: true }).click();
      const layout = await panel.evaluate(element => ({
        overflowing: [...element.querySelectorAll('input,select,textarea,button')].some(item => item.getBoundingClientRect().right > element.getBoundingClientRect().right + 1),
        tooWide: element.scrollWidth > element.clientWidth + 1,
        inView: element.getBoundingClientRect().bottom <= globalThis.innerHeight,
        font: globalThis.getComputedStyle(element.querySelector('textarea')).fontSize,
      }));
      expect(layout.overflowing).toBe(false); expect(layout.tooWide).toBe(false); expect(layout.inView).toBe(true);
      expect(layout.font).toBe(large ? '16px' : '13px');
      const close = panel.getByRole('button', { name: '关闭工具箱' }); await close.focus();
      await page.keyboard.press('Shift+Tab');
      expect(await panel.evaluate(element => element.contains(globalThis.document.activeElement))).toBe(true);
      await page.keyboard.press('Tab'); await expect(close).toBeFocused();
      await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    }
  });
}
