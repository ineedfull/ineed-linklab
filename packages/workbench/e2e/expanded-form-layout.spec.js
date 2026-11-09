import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
const origin = info => `http://127.0.0.1:${info.project.metadata.runtime === 'electron' ? 4173 : 4174}`;

async function evidence(page, info, name, measurements) {
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

async function replaceEditorText(editor, value) {
  // CodeMirror virtualizes long documents. DOM-only fill can replace just the
  // rendered fragment; use its real document selection and paste path instead.
  await editor.press('ControlOrMeta+A');
  await editor.page().keyboard.insertText(value);
}

for (const width of [1440, 1120, 920]) for (const large of [false, true]) {
  test(`${width} large=${large} history filter alignment and reachability`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 720 });
    await page.addInitScript({ path: fixture });
    for (const kind of ['frames', 'logs']) for (const theme of ['light', 'dark']) {
      await page.goto(`${origin(info)}/?view=history&kind=${kind}&endpointId=tcp-server-local`);
      await expect(page.locator('.history-table tbody tr').first()).toBeVisible();
      await page.evaluate(({ large, theme }) => {
        globalThis.document.documentElement.classList.toggle('large-font', large);
        globalThis.document.documentElement.dataset.theme = theme;
      }, { large, theme });
      const controls = await page.locator('.history-filters').evaluate(root => {
        const box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        return { form: box(root), fields: [...root.querySelectorAll('input,select,button')].map(n => ({ ...box(n), name: n.getAttribute('aria-label') || n.name || n.textContent.trim() })) };
      });
      await evidence(page, info, `${kind}-${theme}`, controls);
      for (const field of controls.fields) {
        expect(field.x, `${field.name} left`).toBeGreaterThanOrEqual(controls.form.x);
        expect(field.x + field.w, `${field.name} right`).toBeLessThanOrEqual(controls.form.x + controls.form.w);
        expect(field.y + field.h, `${field.name} bottom`).toBeLessThanOrEqual(controls.form.y + controls.form.h);
        for (const peer of controls.fields.filter(peer => peer.y < field.y + field.h && peer.y + peer.h > field.y)) {
          expect(Math.abs(field.y - peer.y), `${field.name}/${peer.name} tops`).toBeLessThanOrEqual(1);
          expect(Math.abs(field.h - peer.h), `${field.name}/${peer.name} heights`).toBeLessThanOrEqual(1);
        }
      }
      const search = page.getByRole('button', { name: '搜索', exact: true });
      await search.focus();
      await expect(search).toBeInViewport({ ratio: 1 });
      await page.getByRole('searchbox').fill('不存在的排版回归记录');
      await search.click();
      await expect(page.getByRole('searchbox')).toHaveValue('不存在的排版回归记录');
      await expect(search).toBeEnabled();
    }
  });
}

test('mixed endpoint toggles align with adjacent numeric controls', async ({ page }, info) => {
  await page.addInitScript({ path: fixture });
  await page.goto(origin(info));
  await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  for (const large of [false, true]) for (const transport of ['tcp-client', 'tcp-server', 'modbus-tcp-master', 'modbus-rtu-master', 'dlt645-master']) {
    await page.evaluate(large => globalThis.document.documentElement.classList.toggle('large-font', large), large);
    await dialog.locator('[name=endpoint-transport]').selectOption(transport);
    const rows = await dialog.locator('.endpoint-parameter-section').evaluateAll(groups => groups.flatMap(group => {
      const box = n => { const r = n.getBoundingClientRect(); return { y: r.y, h: r.height, center: r.y + r.height / 2 }; };
      return [...group.querySelectorAll('.endpoint-parameter-section__toggle')].flatMap(label => {
        const toggleRect = label.getBoundingClientRect();
        const peer = [...group.querySelectorAll('.field-control')].find(n => { const r = n.getBoundingClientRect(); return r.y < toggleRect.bottom - 1 && r.bottom > toggleRect.y + 1; });
        return peer ? [{ toggle: box(label.querySelector('input')), control: box(peer.querySelector('input')), name: label.textContent.trim() }] : [];
      });
    }));
    expect(rows.length, `${transport} mixed row is measured`).toBeGreaterThan(0);
    await evidence(page, info, `${transport}-${large}`, rows);
    for (const row of rows) expect(Math.abs(row.toggle.center - row.control.center), `${transport} ${row.name} center`).toBeLessThanOrEqual(1);
    if (transport === 'tcp-client') {
      const toggle = dialog.locator('[name=tcp-keep-alive]');
      const delay = dialog.locator('[name=tcp-keep-alive-delay]');
      await toggle.check();
      await delay.fill('0');
      await dialog.getByRole('button', { name: '保存端点', exact: true }).click();
      await expect(delay).toHaveAttribute('aria-invalid', 'true');
      const checkboxBox = await toggle.boundingBox();
      const delayBox = await delay.boundingBox();
      await evidence(page, info, `invalid-delay-${large}`, { checkboxBox, delayBox });
      expect(Math.abs(checkboxBox.y + checkboxBox.height / 2 - delayBox.y - delayBox.height / 2), 'error text keeps mixed controls aligned').toBeLessThanOrEqual(1);
    }
  }
});

for (const width of [1440, 1120, 920]) test(`${width} send editor geometry and resizing`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 720 });
  await page.addInitScript({ path: fixture });
  await page.goto(origin(info));
  await page.getByRole('button', { name: '选择 本地调试服务', exact: true }).click();
  const server = page.locator('.endpoint-row').filter({ has: page.getByRole('button', { name: '选择 本地调试服务', exact: true }) });
  const open = server.getByRole('button', { name: '打开端点', exact: true });
  if (await open.count()) await open.click();
  await page.getByRole('tab', { name: '消息', exact: true }).click();
  const editor = page.locator('.send-panel [contenteditable=true]');
  await expect(editor).toBeVisible();
  for (const large of [false, true]) for (const theme of ['light', 'dark']) for (const collapsed of [false, true]) {
    await page.getByRole('button', { name: '打开设置' }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('大字体', { exact: true }).setChecked(large);
    await settings.getByLabel('主题', { exact: true }).selectOption(theme);
    const save = settings.getByRole('button', { name: '保存', exact: true });
    if (await save.isEnabled()) await save.click(); else await settings.getByRole('button', { name: '取消', exact: true }).click();
    const toggle = page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表', exact: true });
    if (await toggle.count()) await toggle.click();
    await page.getByRole('radio', { name: 'JSON', exact: true }).click();
    const draft = JSON.stringify({ message: '消息录入布局', values: [1, 2, 3], nested: { enabled: true } }, null, 2);
    await editor.fill(draft);
    await editor.press('ControlOrMeta+Home');
    const geometry = await page.locator('.send-panel').evaluate(root => {
      const box = n => { const r = n.getBoundingClientRect(); const s = globalThis.getComputedStyle(n); return { x: r.x, y: r.y, w: r.width, h: r.height, lineHeight: s.lineHeight, fontSize: s.fontSize }; };
      return Object.fromEntries(['.send-panel__toolbar', '.send-panel__editor', '.send-panel__footer', '.payload-editor', '.cm-editor', '.cm-scroller', '.cm-content', '.cm-line', '.cm-lineNumbers .cm-gutterElement:not([style*="hidden"])', '.cm-foldGutter .cm-gutterElement:not([style*="hidden"])', '.cm-cursor'].map(selector => [selector, [...root.querySelectorAll(selector)].map(box)]));
    });
    await evidence(page, info, `editor-${theme}-${large}-${collapsed}`, geometry);
    const host = geometry['.payload-editor'][0];
    const scroller = geometry['.cm-scroller'][0];
    const footer = geometry['.send-panel__footer'][0];
    expect(host.h, 'usable editing viewport').toBeGreaterThanOrEqual(40);
    expect(scroller.y + scroller.h, 'editor above footer').toBeLessThanOrEqual(footer.y + 1);
    expect(footer.y + footer.h, 'send action within viewport').toBeLessThanOrEqual(page.viewportSize().height + 1);
    expect(scroller.fontSize).toBe(large ? '16px' : '13px');
    for (const [index, line] of geometry['.cm-line'].entries()) {
      const number = geometry['.cm-lineNumbers .cm-gutterElement:not([style*="hidden"])'][index];
      expect(Math.abs(line.y - number.y), 'gutter top tracks text').toBeLessThanOrEqual(1);
      expect(Math.abs(line.h - number.h), 'gutter height tracks text').toBeLessThanOrEqual(1);
    }
    await editor.press('ControlOrMeta+End');
    await expect.poll(() => page.locator('.cm-scroller').evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    const handle = page.getByRole('button', { name: '调整发送面板大小' });
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 500, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.send-panel')).toHaveCSS('height', '180px');
    expect(await editor.locator('.cm-line').allTextContents()).toEqual(draft.split('\n'));
    expect(await page.locator('.cm-scroller').evaluate(n => n.clientHeight), 'minimum editor viewport').toBeGreaterThanOrEqual(40);
    const last = await page.locator('.send-panel__footer').boundingBox();
    expect(last.y + last.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
    await evidence(page, info, `editor-minimum-${theme}-${large}-${collapsed}`, { footer: last });
    await handle.focus();
    await handle.press('ArrowUp');
    await expect(page.locator('.send-panel')).toHaveCSS('height', '200px');
  }
});

for (const large of [false, true]) test(`large=${large} send editor typing newline scroll and composition`, async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1120, height: 720 });
  await page.addInitScript({ path: fixture });
  await page.goto(origin(info));
  if (large) {
    await page.getByRole('button', { name: '打开设置' }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('大字体', { exact: true }).check();
    await settings.getByLabel('主题', { exact: true }).selectOption('dark');
    await settings.getByRole('button', { name: '保存', exact: true }).click();
  }
  await page.getByRole('button', { name: '选择 本地调试服务', exact: true }).click();
  const server = page.locator('.endpoint-row').filter({ has: page.getByRole('button', { name: '选择 本地调试服务', exact: true }) });
  const open = server.getByRole('button', { name: '打开端点', exact: true });
  if (await open.count()) await open.click();
  await page.getByRole('tab', { name: '消息', exact: true }).click();
  const editor = page.locator('.send-panel [contenteditable=true]');
  await expect(editor).toBeVisible();
  const lines = Array.from({ length: 200 }, (_, index) => `line-${index.toString().padStart(3, '0')} 中文数据`);
  await page.locator('.send-panel [name=framing]').selectOption('none');
  let expected = lines.join('\n');
  await replaceEditorText(editor, expected);
  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await page.keyboard.type('tail-');
  expected += '\ntail-';
  if (info.project.use.browserName === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await session.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await session.send('Input.insertText', { text: '中文' });
    await session.detach();
  } else {
    await page.keyboard.insertText('中文');
  }
  expected += '中文';
  await editor.press('Enter');
  await page.keyboard.type('last');
  expected += '\nlast';
  const scroller = page.locator('.cm-scroller');
  await expect.poll(() => scroller.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
  const before = await scroller.evaluate(n => n.scrollTop);
  const scrollerBox = await scroller.boundingBox();
  await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2);
  await page.mouse.wheel(0, -250);
  await expect.poll(() => scroller.evaluate(n => n.scrollTop)).toBeLessThan(before);
  await editor.press('ControlOrMeta+End');
  await page.keyboard.type('-end');
  expected += '-end';
  const rapid = 'rapid'.repeat(64);
  await page.keyboard.type(rapid);
  expected += rapid;
  await expect.poll(() => scroller.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
  await evidence(page, info, 'typed-composed-scrolled', { expectedTail: expected.slice(-80), scrollTop: await scroller.evaluate(n => n.scrollTop) });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.length)).toBe(1);
  const bytes = await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__[0].bytes);
  expect(Buffer.from(bytes).toString('utf8')).toBe(expected);
  // Long lines keep their horizontal scroll inside CodeMirror. Enter returns
  // the caret to the new line; neither operation may replace the Vue draft.
  const longLine = 'a'.repeat(8000);
  await replaceEditorText(editor, longLine);
  await editor.press('ControlOrMeta+End');
  await expect.poll(() => scroller.evaluate(n => n.scrollLeft)).toBeGreaterThan(0);
  const endScroll = await scroller.evaluate(n => n.scrollLeft);
  await page.keyboard.type('-continued');
  await expect.poll(() => scroller.evaluate(n => n.scrollLeft)).toBeGreaterThanOrEqual(endScroll);
  await expect.poll(() => scroller.evaluate(n => n.scrollWidth - n.clientWidth - n.scrollLeft)).toBeLessThan(40);
  const continuedScroll = await scroller.evaluate(n => n.scrollLeft);
  const longScrollerBox = await scroller.boundingBox();
  await page.mouse.move(longScrollerBox.x + longScrollerBox.width / 2, longScrollerBox.y + longScrollerBox.height / 2);
  await page.mouse.wheel(-300, 0);
  await expect.poll(() => scroller.evaluate(n => n.scrollLeft)).toBeLessThan(continuedScroll);
  const manualScroll = await scroller.evaluate(n => n.scrollLeft);
  // Wait through editor measurements: merely browsing horizontally must not
  // trigger the active-caret scroll rule or jump all the way to the start.
  await page.waitForTimeout(150);
  expect(await scroller.evaluate(n => n.scrollLeft)).toBe(manualScroll);
  expect(manualScroll).toBeGreaterThan(0);
  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await page.keyboard.type('next');
  await expect.poll(() => scroller.evaluate(n => n.scrollLeft)).toBeLessThanOrEqual(1);
  await editor.press('ArrowUp');
  await editor.press('End');
  await expect.poll(() => scroller.evaluate(n => n.scrollLeft)).toBeGreaterThan(0);
  await editor.press('ArrowDown');
  await expect.poll(() => scroller.evaluate(n => n.scrollLeft)).toBeLessThanOrEqual(1);
  await evidence(page, info, 'long-line-newline-visible', { scrollLeft: await scroller.evaluate(n => n.scrollLeft), manualScroll });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.length)).toBe(2);
  const longBytes = await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__[1].bytes);
  expect(Buffer.from(longBytes).toString('utf8')).toBe(`${longLine}-continued\nnext`);
  await replaceEditorText(editor, 'alpha\nbeta\ngamma\ndelta');
  await editor.press('ControlOrMeta+Home');
  await editor.press('Shift+ArrowDown');
  await editor.press('Shift+ArrowDown');
  await editor.press('Backspace');
  await page.keyboard.insertText('中文\n换行\n');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.length)).toBe(3);
  const selectedBytes = await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__[2].bytes);
  expect(Buffer.from(selectedBytes).toString('utf8')).toBe('中文\n换行\ngamma\ndelta');
  const outerScroll = await page.evaluate(() => ({ x: globalThis.scrollX, y: globalThis.scrollY }));
  expect(outerScroll).toEqual({ x: 0, y: 0 });
  await evidence(page, info, 'selection-delete-multiline-paste', { outerScroll });
  expect(errors).toEqual([]);
});
