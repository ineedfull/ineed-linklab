import { openWorkspaceTool } from './helpers/workspaceTools.js';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));

async function paired(panel, first, second) {
  const a = await panel.locator(`[name="${first}"]`).boundingBox();
  const b = await panel.locator(`[name="${second}"]`).boundingBox();
  expect(Math.abs(a.y - b.y), `${first}/${second} input tops`).toBeLessThanOrEqual(1);
  expect(Math.abs(a.height - b.height), `${first}/${second} heights`).toBeLessThanOrEqual(1);
  expect(a.x + a.width, `${first}/${second} do not overlap`).toBeLessThan(b.x);
}

async function fullRow(panel, name, container) {
  const field = await panel.locator(`[name="${name}"]`).boundingBox();
  const content = await panel.locator(container).evaluate(node => {
    const r = node.getBoundingClientRect();
    const s = globalThis.getComputedStyle(node);
    return { x: r.x + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
      width: node.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) };
  });
  expect(Math.abs(field.x - content.x), `${name} left edge`).toBeLessThanOrEqual(1);
  expect(Math.abs(field.width - content.width), `${name} full row`).toBeLessThanOrEqual(1);
}

async function screenshot(panel, info, name) {
  expect(await panel.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  const bounds = await panel.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(panel.page().viewportSize().height + 1);
  await panel.page().screenshot({ path: info.outputPath(`${name}.png`) });
}

for (const large of [false, true]) {
  test(`large=${large} dialog field order, paired parameters and group edges`, async ({ page }, info) => {
    await page.setViewportSize(large ? { width: 920, height: 620 } : { width: 1440, height: 900 });
    await page.addInitScript({ path: fixture });
    const runtime = info.project.metadata.runtime ?? 'electron';
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    await page.evaluate(large => {
      globalThis.document.documentElement.classList.toggle('large-font', large);
      globalThis.document.documentElement.dataset.theme = large ? 'dark' : 'light';
    }, large);
    if (large) await page.getByRole('button', { name: '折叠端点列表' }).click();

    await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
    let panel = page.getByRole('dialog');
    let initial;
    for (const type of ['tcp-client', 'tcp-server', 'websocket-client', 'websocket-server', 'modbus-rtu-master']) {
      await panel.locator('[name=endpoint-transport]').selectOption(type);
      const bounds = await panel.boundingBox();
      if (initial) expect(bounds).toEqual(initial);
      initial = bounds;
      await fullRow(panel, 'endpoint-name', '.endpoint-dialog__body');
      if (type.startsWith('tcp-')) {
        await panel.locator('[name=tcp-receive-framing]').selectOption('raw');
        await fullRow(panel, 'tcp-receive-framing', 'fieldset');
        await panel.locator('[name=tcp-receive-framing]').selectOption('delimiter');
        await paired(panel, 'tcp-receive-framing', 'tcp-receive-delimiter');
      }
      if (type === 'modbus-rtu-master') {
        await paired(panel, 'modbus-unit-id', 'modbus-timeout');
        await paired(panel, 'modbus-address-notation', 'modbus-data-order');
        const flow = await panel.locator('[name=serial-flow-control]').boundingBox();
        const unit = await panel.locator('[name=modbus-unit-id]').boundingBox();
        expect(unit.y, 'Modbus starts after the serial parameters').toBeGreaterThan(flow.y + flow.height);
      }
      await screenshot(panel, info, type);
    }
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    if (large) await page.getByRole('button', { name: '展开端点列表' }).click();
    await page.getByRole('button', { name: '选择 锅炉主站', exact: true }).click();
    await page.getByRole('tab', { name: '请求组', exact: true }).click();
    await page.getByRole('button', { name: '编辑请求组 锅炉采集', exact: true }).click();
    panel = page.getByRole('dialog');
    await fullRow(panel, 'request-group-name', '.modbus-group-fields');
    expect((await panel.boundingBox()).height, 'small metadata form fits its content').toBeLessThan(500);
    await screenshot(panel, info, 'request-group');
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '编辑请求 保持寄存器', exact: true }).click();
    panel = page.getByRole('dialog');
    await paired(panel, 'modbus-request-address', 'modbus-request-quantity');
    await paired(panel, 'modbus-request-interval', 'modbus-request-timeout');
    await paired(panel, 'modbus-request-retries', 'modbus-request-retry-interval');
    await screenshot(panel, info, 'request');
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('tab', { name: '写入操作', exact: true }).click();
    await page.getByRole('button', { name: '新增写入指令', exact: true }).click();
    panel = page.getByRole('dialog');
    await paired(panel, 'modbus-write-command-unit-id', 'modbus-write-command-address');
    await screenshot(panel, info, 'write-command');
    await panel.getByRole('button', { name: '取消', exact: true }).click();

    await openWorkspaceTool(page, '设备模板');
    panel = page.getByRole('dialog', { name: '设备模板', exact: true });
    await panel.locator('[name=model-source]').selectOption('modbus-master');
    await panel.getByRole('button', { name: '提取点表', exact: true }).click();
    await fullRow(panel, 'model-site-name', 'fieldset:has([name=model-site-name]) .acceptance-fields');
    await paired(panel, 'model-site-transport', 'model-site-unit');
    await paired(panel, 'model-site-host', 'model-site-port');
    await panel.locator('[name=model-site-transport]').selectOption('modbus-rtu-master');
    await paired(panel, 'model-site-baud', 'model-site-parity');
    await screenshot(panel, info, 'device-template');
    await panel.getByRole('button', { name: '关闭设备模板' }).click();
    await openWorkspaceTool(page, '验收检查');
    panel = page.getByRole('dialog', { name: '验收检查', exact: true });
    await fullRow(panel, 'acceptance-plan-name', 'div.acceptance-fields');
    await paired(panel, 'acceptance-address', 'acceptance-quantity');
    await panel.locator('[name=acceptance-assertion]').selectOption('range');
    await paired(panel, 'acceptance-minimum', 'acceptance-maximum');
    await screenshot(panel, info, 'acceptance');
    await panel.getByRole('button', { name: '关闭验收检查' }).click();
  });
}
