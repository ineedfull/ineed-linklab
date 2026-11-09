import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} uses consistent protocol fonts and scales all workbench surfaces`, async ({ page }, testInfo) => {
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    const samples = [];
    for (const large of [false, true]) {
      await page.getByRole('button', { name: '打开设置' }).click();
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      await settings.getByLabel('大字体', { exact: true }).setChecked(large);
      await settings.getByRole('button', { name: large ? '保存' : '取消', exact: true }).click();
      const sizes = {};
      async function collect(prefix, selectors) {
        for (const [role, selector] of Object.entries(selectors)) {
          const element = page.locator(selector).first();
          await expect(element).toBeVisible();
          sizes[`${prefix}.${role}`] = await element.evaluate(node => Number.parseFloat(globalThis.getComputedStyle(node).fontSize));
        }
      }

      for (const [name, prefix, tab, selectors] of [
        ['厂区电表', 'meter', null, { tab: '.dlt645-tabs button', data: '.dlt645-table td', value: '.dlt645-value', note: '.dlt645-live-group__address' }],
        ['锅炉主站', 'modbus', '实时数据', { tab: '.modbus-master-tabs button', data: '.modbus-result-table td', value: '.modbus-result-table td:nth-child(4)', note: '.modbus-master-live-group__summary' }],
        ['DL/T 645 模拟电表', 'meterSimulator', null, { data: '.simulator-data-row__identity strong', input: '.simulator-data-row input' }],
        ['锅炉模拟器', 'modbusSimulator', null, { data: '.modbus-result-table td', input: '.modbus-value-input' }],
      ]) {
        await page.getByRole('button', { name: `选择 ${name}`, exact: true }).click();
        if (tab) await page.getByRole('tab', { name: tab, exact: true }).click();
        await collect(prefix, selectors);
        if (prefix === 'meter' || prefix === 'modbus') {
          await page.screenshot({ path: testInfo.outputPath(`${prefix}-${large ? 'large' : 'normal'}.png`) });
        }
      }
      for (const role of ['tab', 'data', 'value', 'note']) expect(sizes[`meter.${role}`]).toBe(sizes[`modbus.${role}`]);
      for (const role of ['data', 'input']) expect(sizes[`meterSimulator.${role}`]).toBe(sizes[`modbusSimulator.${role}`]);

      await page.getByRole('button', { name: '选择 本地调试服务', exact: true }).click();
      const server = page.locator('.endpoint-row').filter({ has: page.getByRole('button', { name: '选择 本地调试服务', exact: true }) });
      const open = server.getByRole('button', { name: '打开端点', exact: true });
      if (await open.count()) await open.click();
      await page.getByRole('tab', { name: '消息', exact: true }).click();
      await collect('messages', { tab: '.workspace-tabs button', data: '.frame-preview pre', code: '.cm-scroller', sidebar: '.endpoint-row__primary', note: '.endpoint-row__secondary' });
      await page.getByRole('tab', { name: '日志', exact: true }).click();
      await collect('logs', { time: '.log-list__row time', level: '.log-list__level' });
      await page.getByRole('button', { name: '打开设置' }).click();
      await collect('settings', { title: '.settings-panel h2', label: '.settings-panel .field-control', input: '.settings-panel select', note: '.storage-stats dt' });
      await settings.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
      await collect('endpoint', { title: '.endpoint-dialog h2', label: '.endpoint-dialog .field-control', input: '.endpoint-dialog input' });
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '打开关于' }).click();
      await collect('about', { title: '.desktop-about h2', data: '.about-panel__details dd', button: '.about-panel__button' });
      await page.getByRole('dialog', { name: '关于', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
      expect(sizes['messages.tab']).toBe(sizes['meter.tab']);
      expect(sizes['settings.input']).toBe(sizes['endpoint.input']);
      samples.push(sizes);
    }
    for (const key of Object.keys(samples[0])) expect(samples[1][key], `${key} should grow in large-font mode`).toBeGreaterThan(samples[0][key]);
    for (const kind of ['frames', 'logs']) {
      await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/?view=history&kind=${kind}&endpointId=tcp-server-local`);
      await expect(page.locator('.history-table tbody tr').first()).toBeVisible();
      for (const [index, large] of [false, true].entries()) {
        // History windows render the same preference class without a settings dialog.
        await page.evaluate(enabled => globalThis.document.documentElement.classList.toggle('large-font', enabled), large);
        await expect(page.locator('.history-table th').first()).toHaveCSS('font-size', `${samples[index]['meter.tab']}px`);
        await expect(page.locator('.history-table td').first()).toHaveCSS('font-size', `${samples[index]['meter.data']}px`);
        await expect(page.locator('.history-filters select').first()).toHaveCSS('font-size', `${samples[index]['settings.input']}px`);
        await page.screenshot({ path: testInfo.outputPath(`history-${kind}-${large ? 'large' : 'normal'}.png`) });
      }
    }
  });
}
