import { expect, test } from '@playwright/test';
import { fileURLToPath, URL } from 'node:url';

import { comparePngBuffers } from './support/visualParity.js';

const previewBridge = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
const origins = {
  electron: 'http://127.0.0.1:4173',
  tauri: 'http://127.0.0.1:4174',
};

test.beforeEach(async ({ context }) => {
  await context.addInitScript({ path: previewBridge });
});

async function assertMeterToggleAlignment(page, header) {
  const wasLarge = await page.locator('html').evaluate(node => node.classList.contains('large-font'));
  const viewport = page.viewportSize();
  try {
    for (const width of [viewport.width, 680]) {
      await page.setViewportSize({ ...viewport, width });
      for (const large of [false, true]) {
        await page.locator('html').evaluate((node, value) => node.classList.toggle('large-font', value), large);
        const geometry = await header.evaluate(node => {
          const name = node.querySelector('label:first-child input').getBoundingClientRect();
          const input = node.querySelector('label:nth-child(2) input').getBoundingClientRect();
          const checkbox = node.querySelector('input[type=checkbox]').getBoundingClientRect();
          return { delta: Math.abs(input.y + input.height / 2 - checkbox.y - checkbox.height / 2),
            checkboxWidth: checkbox.width, checkboxHeight: checkbox.height, nameBottom: name.bottom, addressTop: input.top };
        });
        expect(geometry.delta, `meter toggle alignment, width=${width}, large=${large}`).toBeLessThanOrEqual(1);
        expect(geometry.checkboxWidth).toBeLessThanOrEqual(18);
        expect(geometry.checkboxHeight).toBeLessThanOrEqual(18);
        if (width === 680) expect(geometry.addressTop).toBeGreaterThan(geometry.nameBottom);
      }
    }
  } finally {
    await page.setViewportSize(viewport);
    await page.locator('html').evaluate((node, value) => node.classList.toggle('large-font', value), wasLarge);
  }
}

test('runs with the Playwright 1.61.1 bundled Chromium', async ({ browser }) => {
  expect(browser.version()).toBe('149.0.7827.55');
});

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} preview injects only its own runtime bridge`, async ({ page }) => {
    await openPreview(page, runtime);

    const globals = await page.evaluate(() => ({
      electron: Boolean(globalThis.ineedLinkLab),
      tauri: Boolean(globalThis.__TAURI_INTERNALS__),
      tauriEvent: Boolean(globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__),
    }));
    expect(globals).toEqual(runtime === 'electron'
      ? { electron: true, tauri: false, tauriEvent: false }
      : { electron: false, tauri: true, tauriEvent: true });
  });
}

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} completes a DL/T 645 meter read with full frame diagnostics`, async ({ page }) => {
    await openPreview(page, runtime);
    const endpoint = page.locator('.endpoint-row').filter({ hasText: '厂区电表' });
    await endpoint.getByRole('button', { name: '选择 厂区电表' }).click();
    await endpoint.getByRole('button', { name: '打开端点' }).click();
    await expect(page.locator('.dlt645-panel')).toBeVisible();
    await expect(page.locator('.dlt645-live-group')).toHaveCount(1);
    await expect(page.locator('.dlt645-live-group__address')).toHaveCount(1);
    await expect(page.locator('.dlt645-live-group__address')).toContainText('123456789012');
    await expect(page.locator('.dlt645-live-table tbody tr')).toHaveCount(1);
    await page.locator('button[title="单次抄读"]').click();
    await expect(page.locator('.dlt645-value')).toContainText('230.1 V');
    await expect(page.locator('.dlt645-table tbody')).toContainText('01 23');
    await expect(page.locator('.dlt645-live-group__summary')).toContainText('正常 1');
    await assertNoPageOverflow(page);

    await page.getByRole('button', { name: '电表与抄读项', exact: true }).click();
    await assertMeterToggleAlignment(page, page.locator('.dlt645-meter > header').first());
    const taskToggle = await page.locator('.dlt645-task-table input[type="checkbox"]').first().boundingBox();
    expect(taskToggle.width).toBe(16);
    expect(taskToggle.height).toBe(16);

    await page.getByRole('button', { name: '报文诊断', exact: true }).click();
    await expect(page.locator('.dlt645-transaction-list > button')).toHaveCount(1);
    await expect(page.locator('.dlt645-transaction-frame')).toHaveCount(2);
    await expect(page.locator('.dlt645-transaction-list__frames')).toContainText('TX');
    await expect(page.locator('.dlt645-transaction-list__frames')).toContainText('RX');
    await expect(page.locator('.dlt645-transaction-frame__hex').first())
      .toContainText('68 12 90 78 56 34 12 68');
    await expect(page.locator('.dlt645-transaction-segments').last()).toContainText('数据域（+33H）');
    await expect(page.locator('.dlt645-transaction-segments').first()).toContainText('校验和');
    await assertNoPageOverflow(page);
  });

  test(`${runtime} simulates a DL/T 645 meter and returns complete response frames`, async ({ page }) => {
    await openPreview(page, runtime);
    const endpoint = page.locator('.endpoint-row').filter({ hasText: 'DL/T 645 模拟电表' });
    await endpoint.getByRole('button', { name: '选择 DL/T 645 模拟电表' }).click();
    await endpoint.getByRole('button', { name: '打开端点' }).click();
    await expect(page.locator('.dlt645-simulator')).toBeVisible();
    await expect(page.locator('.simulator-state')).toContainText('监听中');
    await expect(page.locator('.simulator-data-group')).toHaveCount(1);
    await expect(page.locator('.simulator-data-group__address')).toHaveCount(1);
    await expect(page.locator('.simulator-data-group__address')).toContainText('123456789012');
    await expect(page.locator('.simulator-data-row')).toHaveCount(5);
    await page.evaluate(() => globalThis.__INEED_PREVIEW_EMIT_DLT645_REQUEST__('02010100'));
    await expect(page.locator('.dlt645-simulator__summary')).toContainText('请求 1');
    await expect(page.locator('.dlt645-simulator__summary')).toContainText('响应 1');
    await expect(page.locator('.simulator-data-row').filter({ hasText: 'A 相电压' }))
      .toContainText('读取 1 次');
    const sent = await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.at(-1));
    expect(sent.endpointId).toBe('dlt645-meter-simulator');
    expect(Array.from(sent.bytes).slice(8, 16))
      .toEqual([0x91, 0x06, 0x33, 0x34, 0x34, 0x35, 0x34, 0x56]);

    await page.getByRole('button', { name: '电表配置', exact: true }).click();
    await assertMeterToggleAlignment(page, page.locator('.simulator-meter > header').first());

    await page.getByRole('button', { name: '报文诊断', exact: true }).click();
    await expect(page.locator('.dlt645-transaction-list > button')).toHaveCount(1);
    await expect(page.locator('.dlt645-transaction-frame')).toHaveCount(2);
    await expect(page.locator('.dlt645-transaction-list__frames')).toContainText('RX');
    await expect(page.locator('.dlt645-transaction-list__frames')).toContainText('TX');
    await expect(page.locator('.dlt645-transaction-frame__hex').last()).toContainText('91 06');
    await expect(page.locator('.dlt645-transaction-segments').last()).toContainText('校验和');
    await page.getByRole('button', { name: '选择 串口传感器', exact: true }).click();
    await expect(page.locator('.dlt645-simulator')).toHaveCount(0);
    // The connection keeps serving even when another endpoint owns the view.
    await page.evaluate(() => globalThis.__INEED_PREVIEW_EMIT_DLT645_REQUEST__('02010100'));
    await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__
      .filter(({ endpointId }) => endpointId === 'dlt645-meter-simulator').length)).toBe(2);
    await endpoint.getByRole('button', { name: '选择 DL/T 645 模拟电表' }).click();
    await expect(page.locator('.dlt645-simulator__summary')).toContainText('响应 2');
    await page.getByRole('button', { name: '报文诊断', exact: true }).click();
    await expect(page.locator('.dlt645-transaction-list > button')).toHaveCount(2);
    expect(await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__
      .filter(({ endpointId }) => endpointId === 'dlt645-meter-simulator').length)).toBe(2);
    await assertNoPageOverflow(page);
  });
}

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} completes the Modbus point history workflow`, async ({ page }) => {
    await openModbusMaster(page, runtime);
    await page.getByRole('tab', { name: '请求组', exact: true }).click();
    await enableRequestPointHistory(page, '保持寄存器');
    await enableRequestPointHistory(page, '诊断输入');

    await page.getByRole('button', { name: '单次执行请求 保持寄存器' }).click();
    await expect.poll(() => page.evaluate(() => (
      globalThis.__INEED_PREVIEW_MODBUS_REQUESTS__.filter(({ requestId }) => (
        requestId === 'holding-read'
      )).length
    ))).toBe(1);
    await page.evaluate(() => globalThis.__INEED_PREVIEW_SET_MODBUS_REGISTER__(10, 270));
    await page.getByRole('button', { name: '单次执行请求 保持寄存器' }).click();
    await page.getByRole('button', { name: '单次执行请求 诊断输入' }).click();
    await expect.poll(() => page.evaluate(() => (
      globalThis.__INEED_PREVIEW_MODBUS_HISTORY_ROWS__?.length ?? 0
    )), { timeout: 5_000 }).toBe(3);

    await page.getByRole('tab', { name: '数据趋势', exact: true }).click();
    await expect(page.getByLabel('历史数据点选择')).toContainText('出水温度');
    await expect(page.getByLabel('历史数据点选择')).toContainText('设备状态');
    await expect(page.locator('.modbus-trends-summary')).toContainText('27.0');
    await expect(page.locator('.modbus-trends-summary')).toContainText('通信异常');
    await expect(page.locator('.modbus-trends-detail')).toContainText('共 3 条');
    await page.getByRole('button', { name: '最近 1 小时' }).click();
    await page.getByRole('button', { name: '导出当前趋势数据 CSV' }).click();
    await expect.poll(() => page.evaluate(() => (
      globalThis.__INEED_PREVIEW_MODBUS_HISTORY_EXPORTS__?.length ?? 0
    ))).toBe(1);
    expect(await page.evaluate(() => (
      globalThis.__INEED_PREVIEW_MODBUS_HISTORY_EXPORTS__.at(-1).points.length
    ))).toBe(2);
    await assertNoPageOverflow(page);
  });

  test(`${runtime} manages and confirms saved Modbus write commands`, async ({ page }) => {
    await openModbusMaster(page, runtime);
    await page.getByRole('tab', { name: '写入操作', exact: true }).click();
    const commands = page.locator('.modbus-write-command');
    const pump = commands.filter({ hasText: '启动水泵' });
    const target = commands.filter({ hasText: '设定目标' });
    await expect(commands).toHaveCount(2);
    await expect(pump).toContainText('FC05');
    await expect(target).toContainText('FC16');
    await expect(target).toContainText('地址 20–21');
    await assertSavedCommandLayout(page);
    expect(await previewWrites(page)).toEqual([]);

    await page.getByRole('button', { name: '执行写入指令 启动水泵', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: '写入确认' })).toContainText('Slave 1 · FC05 · 地址 5 · 1 个值');
    expect(await previewWrites(page)).toEqual([]);
    await page.getByRole('button', { name: '取消执行写入指令 启动水泵', exact: true }).click();
    expect(await previewWrites(page)).toEqual([]);
    await executeSavedCommand(page, '启动水泵');
    await expect(pump).toContainText('写入成功');
    await expect(target).toContainText('尚未执行');
    await executeSavedCommand(page, '设定目标');
    await expect(target).toContainText('Preview write rejected');
    await expect(pump).toContainText('写入成功');
    expect(await previewWrites(page)).toEqual([
      { endpointId: 'modbus-master', expectedSessionId: 'session-preview', functionCode: 5, unitId: 1, address: 5, quantity: 1, values: [true] },
      { endpointId: 'modbus-master', expectedSessionId: 'session-preview', functionCode: 16, unitId: 7, address: 20, quantity: 2, values: [100, 200] },
    ]);
    await page.getByRole('tab', { name: '报文诊断', exact: true }).click();
    const records = page.locator('.modbus-diagnostic-list > button');
    await expect(records).toHaveCount(2);
    await expect(records.filter({ hasText: 'FC05' })).toContainText('站号 1 · 地址 5 · 数量 1');
    await expect(records.filter({ hasText: 'FC05' }).locator('.modbus-diagnostic-list__frames code').first())
      .toHaveText('00 00 00 00 00 06 01 05 00 05 FF 00');
    await expect(records.filter({ hasText: 'FC05' })).not.toHaveClass(/failed/);
    await expect(records.filter({ hasText: 'FC16' })).toContainText('站号 7 · 地址 20 · 数量 2');
    await expect(records.filter({ hasText: 'FC16' }).locator('.modbus-diagnostic-list__frames code').first())
      .toHaveText('00 00 00 00 00 0B 07 10 00 14 00 02 04 00 64 00 C8');
    await expect(records.filter({ hasText: 'FC16' })).toHaveClass(/failed/);
    await expect(records.filter({ hasText: 'FC16' })).toContainText('Preview write rejected');

    await page.getByRole('tab', { name: '写入操作', exact: true }).click();
    await page.getByRole('button', { name: '停用写入指令 启动水泵', exact: true }).click();
    await expect(page.getByRole('button', { name: '执行写入指令 启动水泵', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '启用写入指令 启动水泵', exact: true }).click();
    await expect(page.getByRole('button', { name: '执行写入指令 启动水泵', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '新增写入指令', exact: true }).click();
    await fillSavedCommand(page, '备用目标', '16', '30', '300, 400');
    await expect(commands).toHaveCount(3);
    await page.getByRole('button', { name: '编辑写入指令 备用目标', exact: true }).click();
    await fillSavedCommand(page, '备用目标已编辑', '16', '32', '500, 600');
    await expect(commands.filter({ hasText: '备用目标已编辑' })).toContainText('地址 32–33');
    await expect(commands.filter({ hasText: '备用目标已编辑' })).toContainText('500, 600');
    await page.getByRole('button', { name: '复制写入指令 备用目标已编辑', exact: true }).click();
    await expect(commands).toHaveCount(4);
    const ids = await commands.evaluateAll((rows) => rows.map((row) => row.dataset.writeCommandId));
    expect(new Set(ids).size).toBe(4);
    await page.getByRole('button', { name: '上移写入指令 备用目标已编辑副本', exact: true }).click();
    await expect(commands.nth(2)).toContainText('备用目标已编辑副本');
    await page.getByRole('button', { name: '删除写入指令 备用目标已编辑副本', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: '删除确认' })).toBeVisible();
    await expect(commands).toHaveCount(4);
    await page.getByRole('button', { name: '取消删除写入指令 备用目标已编辑副本', exact: true }).click();
    await expect(commands).toHaveCount(4);
    await page.getByRole('button', { name: '删除写入指令 备用目标已编辑副本', exact: true }).click();
    await page.getByRole('button', { name: '确认删除写入指令 备用目标已编辑副本', exact: true }).click();
    await expect(commands).toHaveCount(3);
    expect(await previewWrites(page)).toHaveLength(2);

    await page.getByRole('tab', { name: '请求组', exact: true }).click();
    const removeGroup = page.getByRole('button', { name: '删除请求组 锅炉采集', exact: true });
    await assertActionsInsideContent(page, removeGroup, { rightInset: 16 });
    await removeGroup.click();
    const confirmation = page.getByRole('alertdialog', { name: '删除确认' });
    await expect(confirmation).toContainText('锅炉采集');
    await expect(confirmation).toContainText('3 个请求');
    await expect(confirmation).toContainText('3 个数据点');
    await page.getByRole('button', { name: '取消删除请求组 锅炉采集', exact: true }).click();
    await expect(page.locator('.modbus-request-group')).toHaveCount(1);
    await removeGroup.click();
    await page.getByRole('button', { name: '确认删除请求组 锅炉采集', exact: true }).click();
    await expect(page.locator('.modbus-request-group')).toHaveCount(0);
    await page.getByRole('tab', { name: '写入操作', exact: true }).click();
    await expect(commands).toHaveCount(3);
    expect(await previewWrites(page)).toHaveLength(2);

    expect(await previewFailedModbusEnvelope(page, runtime)).toEqual({
      ok: false,
      error: {
        name: runtime === 'electron' ? 'ModbusError' : 'SerialError',
        message: 'Preview write rejected',
        code: 'IO_ERROR',
        method: 'modbus.execute',
        runtimeName: runtime,
      },
    });
  });

  test(`${runtime} runs nested Modbus master requests and slave business points`, async ({ page }) => {
    await openPreview(page, runtime);

    const master = page.getByRole('button', { name: '选择 锅炉主站' });
    const masterEntry = page.locator('.endpoint-tree__entry').filter({ has: master });
    await master.click();
    await masterEntry.getByRole('button', { name: '打开端点' }).click();
    await expect(page.locator('.session-status-bar')).toContainText('已打开');
    await expect(master).toContainText('请求组 1/1');
    await masterEntry.getByRole('button', { name: '端点操作' }).click();
    await masterEntry.getByRole('menuitem', { name: '编辑' }).click();
    const masterDialog = page.getByRole('dialog', { name: '编辑端点' });
    await expect(masterDialog.getByRole('combobox', { name: '默认数据顺序' })).toHaveValue('ABCD');
    await expect(masterDialog.getByRole('combobox', { name: '字节序' })).toHaveCount(0);
    await expect(masterDialog.getByRole('combobox', { name: '字序' })).toHaveCount(0);
    await masterDialog.getByRole('button', { name: '取消' }).click();
    await page.getByRole('tab', { name: '请求组', exact: true }).click();
    await expect(page.locator('.modbus-request-group')).toHaveCount(1);
    await expect(page.locator('.modbus-request-group')).toContainText('锅炉采集');
    await expect(page.locator('.modbus-request-group')).toContainText('3 个请求');
    await expect(page.getByRole('button', { name: '展开请求组 锅炉采集' })).toHaveCount(0);
    const requests = page.locator('.modbus-request-table tbody > tr:not(.modbus-request-points-preview)');
    await expect(requests).toHaveCount(3);
    await expect(page.locator('.modbus-request-table')).toContainText('FC01 读取线圈');
    await expect(page.locator('.modbus-request-table')).toContainText('FC03 读取保持寄存器');
    await expect(page.locator('.modbus-request-table')).toContainText('700 ms');
    await expect(page.locator('.modbus-request-table')).toContainText('1000 ms');
    await expect(page.locator('[data-request-id="holding-read"] .modbus-request-command'))
      .toHaveText('00 00 00 00 00 06 01 03 00 0A 00 04');
    await assertNestedModbusLayout(page);

    await page.getByRole('button', { name: '启动轮询' }).click();
    await expect(page.getByRole('button', { name: '停止轮询' })).toBeVisible();
    await expect(page.locator('.modbus-request-table')).toContainText('Preview device timeout');
    await page.getByRole('button', { name: '停止轮询' }).click();

    await page.getByRole('button', { name: '单次执行请求 运行线圈' }).click();
    await page.getByRole('button', { name: '单次执行请求组 锅炉采集' }).click();
    await expect(page.locator('.modbus-request-group__header')).toContainText('部分失败');

    await page.getByRole('tab', { name: '实时数据', exact: true }).click();
    await expect(page.locator('.modbus-master-live')).toContainText('25.6');
    await expect(page.locator('.modbus-master-live')).toContainText('运行线圈');
    await expect(page.locator('.modbus-master-live')).toContainText('ON');
    await expect(page.locator('.modbus-master-live')).toContainText('正常');
    await expect(page.locator('.modbus-master-live')).toContainText('通信异常');
    await page.getByRole('tab', { name: '报文诊断', exact: true }).click();
    await expect(page.locator('.modbus-master-records')).toContainText('锅炉采集');
    await expect(page.locator('.modbus-master-records')).toContainText('保持寄存器');
    await expect(page.locator('.modbus-master-records')).toContainText('运行线圈');
    await expect(page.locator('.modbus-master-records')).toContainText('诊断输入');
    await expect(page.locator('.modbus-master-records')).toContainText('失败');

    await page.getByRole('tab', { name: '写入操作', exact: true }).click();
    await page.getByRole('button', { name: '新增写入指令', exact: true }).click();
    await fillSavedCommand(page, '临时验收目标', '16', '30', '100, 200');
    await executeSavedCommand(page, '临时验收目标');
    await expect(page.getByRole('alertdialog', { name: '写入确认' })).toHaveCount(0);
    await page.getByRole('tab', { name: '报文诊断', exact: true }).click();
    await expect(page.locator('.modbus-diagnostic-list')).toContainText('FC16 写多个寄存器');

    const slave = page.getByRole('button', { name: '选择 锅炉模拟器' });
    const slaveEntry = page.locator('.endpoint-tree__entry').filter({ has: slave });
    await slave.click();
    await slaveEntry.getByRole('button', { name: '打开端点' }).click();
    await expect(page.locator('.session-status-bar')).toContainText('监听中');
    await expect(page.locator('.modbus-result-table--business')).toContainText('出水温度');
    const businessValue = page.locator('.modbus-result-table--business .modbus-value-input');
    await expect(businessValue).toHaveValue('25.6');
    await expect(page.locator('.modbus-transactions')).toContainText('FC03 读取保持寄存器');
    await expect(page.locator('.modbus-transactions')).toContainText('RX');
    await expect(page.locator('.modbus-transactions')).toContainText('ADU HEX · TCP 无 CRC');
    await expect(page.locator('.modbus-transactions')).toContainText(
      '12 34 00 00 00 06 01 03 00 0A 00 01',
    );
    for (const label of ['事务 ID', '协议 ID', '长度', '单元 ID', '功能码', '数据']) {
      await expect(page.locator('.modbus-transactions')).toContainText(label);
    }
    await businessValue.fill('30');
    await businessValue.press('Tab');
    await expect(businessValue).toHaveValue('30');
    const pointContext = page.getByLabel('业务数据原始地址');
    await expect(pointContext).toBeVisible();
    await expect(pointContext).toContainText('出水温度');
    await expect(pointContext).toContainText('组合原始字节');
    await expect(pointContext).toContainText('AB · 标准字节序');
    await page.screenshot({
      path: test.info().outputPath(`${runtime}-slave-business-context.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '查看完整数据区' }).click();
    const rawDrawer = page.getByRole('dialog', { name: '完整原始数据区' });
    await expect(rawDrawer).toBeVisible();
    await expect(rawDrawer.locator('.modbus-raw-matrix')).toBeVisible();
    await expect(rawDrawer.locator('.modbus-raw-area')).toHaveCount(4);
    for (const label of ['线圈', '离散输入', '保持寄存器', '输入寄存器']) {
      await expect(rawDrawer.getByRole('region', { name: `${label}原始数据` })).toBeVisible();
    }
    await expect(rawDrawer.locator('.modbus-pagination')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`${runtime}-slave-raw-drawer.png`),
      animations: 'disabled',
    });
    await rawDrawer.getByRole('button', { name: '关闭完整数据区' }).click();
    await expect(rawDrawer).toHaveCount(0);
    await expect(page.locator('.modbus-result-table--business')).toBeVisible();
    await assertNoPageOverflow(page);
    await assertControlTextFits(page);
  });

  test(`${runtime} shows a deterministic active protocol workbench and sends data`, async ({ page }) => {
    await openActiveServer(page, runtime);

    await expect(page.getByRole('button', { name: '选择 串口传感器' })).toContainText('/dev/tty.usbserial-DEV');
    await expect(page.getByRole('button', { name: '选择 云端TCP客户端' })).toContainText('192.0.2.20:9100');
    await expect(page.getByRole('button', { name: '选择 UDP遥测发送' })).toContainText('0.0.0.0:9201');
    await expect(page.getByRole('button', { name: '选择 UDP事件监听' })).toContainText('0.0.0.0:9300');

    const activeEndpoint = page.getByRole('button', { name: '选择 本地调试服务' });
    await expect(activeEndpoint).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.session-status-bar')).toContainText('监听中');
    await expect(page.locator('.session-status-bar')).toContainText('连接 2');

    const activeEndpointEntry = page.locator('.endpoint-tree__entry').filter({ has: activeEndpoint });
    const peerTree = activeEndpointEntry.getByRole('list', { name: 'TCP 服务端连接' });
    await expect(peerTree).toBeVisible();
    const activePeer = peerTree.getByRole('button', { name: '127.0.0.1:53101' });
    await activePeer.click();
    await expect(activePeer).toHaveClass(/active/);
    await expect(page.getByLabel('TCP 发送模式')).toHaveValue('selected');
    const selectedPeerTarget = page.locator(
      'input[name="tcp-peer-target"][value="peer-console"]',
    );
    await page.locator('.send-panel__peer-picker > summary').click();
    await expect(selectedPeerTarget).toBeVisible();
    await expect(selectedPeerTarget).toBeChecked();
    await page.locator('.send-panel__peer-picker > summary').click();

    const frames = page.locator('[data-frame-key]');
    await expect(frames).toHaveCount(36);
    await expect(frames.last()).toBeVisible();
    await expectTimestampNoWrap(page.locator('.frame-list__item > time').first());
    await expectInternalScroll(page.locator('.frame-list'));

    await page.getByRole('tab', { name: '日志' }).click();
    await expect(page.getByRole('tab', { name: '日志' })).toHaveAttribute('aria-selected', 'true');
    const realtimeLogRow = page.locator('.log-list__row').first();
    await expect(realtimeLogRow).toBeVisible();
    await expectTimestampNoWrap(realtimeLogRow.locator('time'));
    await page.getByRole('tab', { name: '消息' }).click();

    const editor = page.locator('.send-panel [contenteditable="true"]');
    await expect(editor).toBeVisible();
    await expect(page.locator('.payload-editor')).toHaveAttribute('aria-disabled', 'false');
    await editor.fill('PING');
    await expect(page.locator('.send-panel__footer')).toContainText('4 字节');
    const sendButton = page.locator('.send-panel__footer')
      .getByRole('button', { name: '发送', exact: true });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__.at(-1)?.target))
      .toEqual({ type: 'peer', peerIds: ['peer-console'] });

    await assertWorkbenchLayout(page);
    await assertControlTextFits(page);
    await assertNonblankWorkbench(page);
  });

  test(`${runtime} keeps send editor resize bounds inside the layout`, async ({ page }) => {
    await openActiveServer(page, runtime);
    const panel = page.locator('.send-panel');
    const handle = page.getByRole('button', { name: '调整发送面板大小' });
    const main = page.locator('.linklab-shell__main');

    await expect(page.locator('.send-panel [contenteditable="true"]')).toBeVisible();
    await expectHeight(panel, 220, 1);
    await resizeSendPanel(page, handle, 400, 1000);
    await expectHeight(panel, 180, 1);
    await assertWorkbenchLayout(page);

    const mainHeight = await main.evaluate((element) => element.clientHeight);
    await resizeSendPanel(page, handle, 400, -1000);
    await expectHeight(panel, Math.min(500, Math.round(mainHeight * 0.5)), 1);
    await assertWorkbenchLayout(page);
  });

  test(`${runtime} saves templates and restores successful send history without auto-send`, async ({ page }) => {
    await openActiveServer(page, runtime);
    const editor = page.locator('.send-panel [contenteditable="true"]');
    await editor.fill('PING');

    await page.getByRole('button', { name: '发送模板' }).click();
    const library = page.getByRole('complementary', { name: '发送资料库' });
    await expect(library).toBeVisible();
    await library.getByRole('textbox', { name: '模板名称' }).fill('健康检查');
    await library.getByRole('button', { name: '保存当前内容为模板' }).click();
    await expect(library.getByRole('button', { name: '载入模板 健康检查' })).toBeVisible();

    await library.getByRole('button', { name: '关闭发送资料库' }).click();
    await editor.fill('CHANGED');
    await page.getByRole('button', { name: '发送模板' }).click();
    await library.getByRole('button', { name: '载入模板 健康检查' }).click();
    await expect(editor).toHaveText('PING');
    expect(await page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__?.length ?? 0)).toBe(0);

    await page.locator('.send-panel__footer').getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__?.length ?? 0))
      .toBe(1);
    await page.getByRole('button', { name: '发送历史' }).click();
    await expect(library).toContainText('1 条记录');
    await expect(library.getByRole('button', { name: '载入历史记录 1' })).toBeVisible();
    await assertNoPageOverflow(page);
    await assertControlTextFits(page);
  });

  test(`${runtime} uses stable collapsed endpoint controls`, async ({ page }) => {
    await openActiveServer(page, runtime);
    await page.getByRole('button', { name: '折叠端点列表' }).click();

    for (const [name, initial] of [
      ['串口传感器', '串'],
      ['云端TCP客户端', '云'],
      ['本地调试服务', '本'],
      ['UDP遥测发送', 'U'],
      ['UDP事件监听', 'U'],
    ]) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toHaveText(initial);
      await expect(button).toHaveAttribute('title', name);
    }

    await expect(page.getByRole('button', { name: '本地调试服务', exact: true })).toHaveClass(/active/);
    for (const name of ['打开设置', '打开关于']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(page.locator('.linklab-shell__runtime').getByRole('button', { name: /历史/ }))
      .toHaveCount(0);
    const footerButtons = await page.locator('.linklab-shell__runtime').evaluate((footer) => {
      const footerRect = footer.getBoundingClientRect();
      return [...footer.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          inside: rect.top >= footerRect.top && rect.bottom <= footerRect.bottom,
        };
      });
    });
    expect(footerButtons.every(({ inside }) => inside)).toBe(true);
    for (let index = 1; index < footerButtons.length; index += 1) {
      expect(footerButtons[index].top).toBeGreaterThanOrEqual(footerButtons[index - 1].bottom);
    }
    await assertWorkbenchLayout(page);
    await assertControlTextFits(page);
  });

  test(`${runtime} opens endpoint-scoped history from the active stream toolbar`, async ({ page }) => {
    await openActiveServer(page, runtime);

    const footer = page.locator('.linklab-shell__runtime');
    const toolbar = page.locator('.stream-controls');
    const clear = toolbar.getByRole('button', { name: '清空实时视图' });
    await expect(footer.getByRole('button', { name: /历史/ })).toHaveCount(0);

    for (const view of [
      { tab: '消息', history: '打开消息历史', kind: 'frames' },
      { tab: '日志', history: '打开日志历史', kind: 'logs' },
    ]) {
      await page.getByRole('tab', { name: view.tab, exact: true }).click();
      const history = toolbar.getByRole('button', { name: view.history, exact: true });
      await expect(history).toBeVisible();
      await expect(toolbar.getByRole('button', {
        name: view.kind === 'frames' ? '打开日志历史' : '打开消息历史',
        exact: true,
      })).toHaveCount(0);
      expect(await history.evaluate((button, clearButton) => (
        button.nextElementSibling === clearButton
      ), await clear.elementHandle())).toBe(true);

      await history.click();
      const expectedUrl = runtime === 'electron'
        ? `${origins.electron}/?view=history&kind=${view.kind}&endpointId=tcp-server-local`
        : `index.html?view=history&kind=${view.kind}&endpointId=tcp-server-local`;
      await expect.poll(() => page.evaluate(() => (
        globalThis.__INEED_PREVIEW_HISTORY_WINDOWS__?.at(-1)?.url
      ))).toBe(expectedUrl);
    }
  });

  test(`${runtime} shows active settings and deterministic storage state`, async ({ page }) => {
    await openActiveServer(page, runtime);
    await page.getByRole('button', { name: '打开设置' }).click();

    const settings = page.getByRole('dialog', { name: '设置' });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('combobox', { name: '日志级别' })).toHaveValue('info');
    await expect(settings.getByRole('combobox', { name: '默认分帧方式' })).toHaveValue('line');
    await expect(settings.getByRole('checkbox', { name: '自动滚动' })).toBeChecked();
    await settings.getByRole('button', { name: '刷新存储统计' }).click();
    await expect(settings).toContainText('36');
    await expect(settings).toContainText('48');
    await expect(settings).toContainText('256 KB');
    await expect(settings.getByRole('button', { name: '导出', exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: '导入', exact: true })).toBeVisible();
    await assertNoPageOverflow(page);
    await assertControlTextFits(page);
  });

  test(`${runtime} edits serial receive framing and runs the shared scheduled sender`, async ({ page }, testInfo) => {
    await openActiveServer(page, runtime);
    const serialEndpoint = page.getByRole('button', { name: '选择 串口传感器' });
    const serialEntry = page.locator('.endpoint-tree__entry').filter({ has: serialEndpoint });
    await serialEntry.getByRole('button', { name: '端点操作' }).click();
    await serialEntry.getByRole('menuitem', { name: '编辑' }).click();

    const dialog = page.getByRole('dialog', { name: '编辑端点' });
    await dialog.getByRole('combobox', { name: '接收分帧' }).selectOption('delimiter');
    await dialog.getByRole('textbox', { name: 'HEX 分隔符' }).fill('0D 0A');
    await dialog.getByRole('button', { name: '保存端点' }).click();
    await expect(dialog).toBeHidden();

    await serialEntry.getByRole('button', { name: '端点操作' }).click();
    await serialEntry.getByRole('menuitem', { name: '编辑' }).click();
    await expect(dialog.getByRole('combobox', { name: '接收分帧' })).toHaveValue('delimiter');
    await expect(dialog.getByRole('textbox', { name: 'HEX 分隔符' })).toHaveValue('0D 0A');
    await page.screenshot({
      path: testInfo.outputPath(`${runtime}-serial-framing-dialog.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: '取消' }).click();

    const serverEndpoint = page.getByRole('button', { name: '选择 本地调试服务' });
    await serverEndpoint.click();
    await expect(page.locator('[data-frame-key]')).toHaveCount(36);
    await page.locator('.send-panel [contenteditable="true"]').fill('PING');
    await page.getByRole('checkbox', { name: '定时发送' }).check();
    await page.getByRole('spinbutton', { name: '定时发送间隔（毫秒）' }).fill('250');
    await page.getByRole('button', { name: '开始定时发送' }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_SENDS__?.length ?? 0))
      .toBe(1);
    await expect(page.getByRole('button', { name: '停止定时发送' })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${runtime}-scheduled-send-active.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '停止定时发送' }).click();
    await expect(page.getByRole('button', { name: '开始定时发送' })).toBeVisible();
    await assertWorkbenchLayout(page);
    await assertControlTextFits(page);
  });
}

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} configures TCP resilience and cancels a pending retry`, async ({ page }) => {
    await openPreview(page, runtime);
    const endpoint = page.getByRole('button', { name: '选择 云端TCP客户端' });
    const entry = page.locator('.endpoint-tree__entry').filter({ has: endpoint });

    await entry.getByRole('button', { name: '端点操作' }).click();
    await entry.getByRole('menuitem', { name: '编辑' }).click();
    const dialog = page.getByRole('dialog', { name: '编辑端点' });
    await expect(dialog.getByRole('checkbox', { name: 'TCP Keepalive' })).toBeChecked();
    await expect(dialog.getByRole('spinbutton', { name: '首次探测延迟（秒）' })).toHaveValue('30');
    await expect(dialog.getByRole('checkbox', { name: '自动重连' })).toBeChecked();
    await dialog.getByRole('button', { name: '取消' }).click();

    await entry.getByRole('button', { name: '打开端点' }).click();
    await expect(entry).toContainText('等待重连（第 1 次）');
    await entry.getByRole('button', { name: '取消自动重连' }).click();
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => globalThis.__INEED_PREVIEW_TCP_OPEN_ATTEMPTS__.length)).toBe(1);
    await expect(entry.getByRole('button', { name: '打开端点' })).toBeVisible();
  });
}

test('shows selected frame and log history rows in both renderer previews', async ({ page }) => {
  for (const runtime of ['electron', 'tauri']) {
    await openPreview(page, runtime, '/?view=history&kind=frames&endpointId=tcp-server-local');
    await expect(page.getByRole('heading', { name: '消息历史' })).toBeVisible();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(36);
    await expect(page.locator('.history-table tbody tr').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.history-detail')).toContainText('peer-console');
    await expect(page.locator('.history-pager')).toContainText('共 36 条');
    await assertNoPageOverflow(page);
    await assertCompactHistoryTableScroll(page);
    await expectTimestampNoWrap(page.locator('.history-table tbody tr').first().locator('td').first());
    await expectTimestampNoWrap(page.locator('.history-detail__identity time'));
    await assertHistoryLayout(page);

    await openPreview(page, runtime, '/?view=history&kind=logs&endpointId=tcp-server-local');
    await expect(page.getByRole('heading', { name: '日志历史' })).toBeVisible();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(48);
    await expect(page.locator('.history-table tbody tr').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.history-detail')).toContainText('固定日志 01');
    await expect(page.locator('.history-pager')).toContainText('共 48 条');
    await assertNoPageOverflow(page);
    await assertCompactHistoryTableScroll(page);
    await expectTimestampNoWrap(page.locator('.history-table tbody tr').first().locator('td').first());
    await expectTimestampNoWrap(page.locator('.history-detail__identity time'));
    await assertHistoryLayout(page);
  }
});

test('matches Electron and Tauri active workbench visuals excluding the runtime footer', async ({ context }, testInfo) => {
  const screenshots = {};
  let expectedContract = null;
  for (const runtime of ['electron', 'tauri']) {
    const runtimePage = await context.newPage();
    await openActiveServer(runtimePage, runtime);
    await runtimePage.getByRole('list', { name: 'TCP 服务端连接' })
      .getByRole('button', { name: '127.0.0.1:53101' }).click();
    await runtimePage.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
      `,
    });
    await expect(runtimePage.locator('[data-frame-key]').last()).toBeVisible();
    await expect(runtimePage.locator('.send-panel [contenteditable="true"]')).toBeVisible();
    await runtimePage.evaluate(async () => {
      await globalThis.document.fonts.ready;
      globalThis.document.activeElement?.blur();
      for (const selector of ['.endpoint-tree', '.frame-list']) {
        const element = globalThis.document.querySelector(selector);
        if (element) element.scrollTop = selector === '.frame-list' ? element.scrollHeight : 0;
      }
      await new Promise((resolve) => globalThis.requestAnimationFrame(
        () => globalThis.requestAnimationFrame(resolve),
      ));
    });
    const contract = await captureParityContract(runtimePage);
    if (expectedContract === null) expectedContract = contract;
    else expect(contract).toEqual(expectedContract);
    const screenshotPath = testInfo.outputPath(`${runtime}-runtime-footer-masked.png`);
    screenshots[runtime] = await runtimePage.screenshot({
      animations: 'disabled',
      mask: [runtimePage.locator('.linklab-shell__runtime')],
      maskColor: '#e7edef',
      path: screenshotPath,
    });
    await testInfo.attach(`${runtime}-${testInfo.project.name}-runtime-footer-masked.png`, {
      body: screenshots[runtime], contentType: 'image/png',
    });
    expect(screenshots[runtime].byteLength).toBeGreaterThan(50_000);
    await assertNonblankWorkbench(runtimePage);
    await runtimePage.close();
  }

  const parity = comparePngBuffers(screenshots.electron, screenshots.tauri);
  console.log(`[visual parity] ${testInfo.project.name}: ${parity.summary}`);
  expect(parity.matches, parity.summary).toBe(true);
});

test('matches Electron and Tauri nested Modbus master visuals excluding the runtime footer', async ({ context }, testInfo) => {
  const screenshots = {};
  for (const runtime of ['electron', 'tauri']) {
    const runtimePage = await context.newPage();
    await openPreview(runtimePage, runtime);
    const master = runtimePage.getByRole('button', { name: '选择 锅炉主站' });
    const entry = runtimePage.locator('.endpoint-tree__entry').filter({ has: master });
    await master.click();
    await entry.getByRole('button', { name: '打开端点' }).click();
    await runtimePage.getByRole('tab', { name: '请求组', exact: true }).click();
    await assertNestedModbusLayout(runtimePage);
    await runtimePage.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }',
    });
    await runtimePage.evaluate(async () => {
      await globalThis.document.fonts.ready;
      globalThis.document.activeElement?.blur();
      await new Promise((resolve) => globalThis.requestAnimationFrame(
        () => globalThis.requestAnimationFrame(resolve),
      ));
    });
    screenshots[runtime] = await runtimePage.screenshot({
      animations: 'disabled',
      mask: [runtimePage.locator('.linklab-shell__runtime')],
      maskColor: '#e7edef',
      path: testInfo.outputPath(`${runtime}-nested-modbus-footer-masked.png`),
    });
    await runtimePage.close();
  }

  const parity = comparePngBuffers(screenshots.electron, screenshots.tauri);
  console.log(`[nested Modbus visual parity] ${testInfo.project.name}: ${parity.summary}`);
  expect(parity.matches, parity.summary).toBe(true);
});

test('matches saved Modbus write commands across Electron and Tauri with only runtime footer masked', async ({ context }, testInfo) => {
  const screenshots = { groups: {}, writes: {} };
  for (const runtime of ['electron', 'tauri']) {
    const page = await context.newPage();
    await openModbusMaster(page, runtime);
    for (const [state, tab] of [['groups', '请求组'], ['writes', '写入操作']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      if (state === 'groups') {
        await assertActionsInsideContent(
          page,
          page.getByRole('button', { name: '删除请求组 锅炉采集', exact: true }),
          { rightInset: 16 },
        );
      } else {
        await expect(page.locator('.modbus-write-command')).toHaveCount(2);
        await assertSavedCommandLayout(page);
      }
      await assertNoPageOverflow(page);
      await assertControlTextFits(page);
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        globalThis.document.activeElement?.blur();
      });
      await page.mouse.move(0, 0);
      screenshots[state][runtime] = await page.screenshot({
        animations: 'disabled', mask: [page.locator('.linklab-shell__runtime')],
        maskColor: '#e7edef', path: testInfo.outputPath(`${runtime}-saved-${state}.png`),
      });
    }
    await page.close();
  }
  for (const [state, captures] of Object.entries(screenshots)) {
    const parity = comparePngBuffers(captures.electron, captures.tauri);
    console.log(`[saved Modbus ${state} visual parity] ${testInfo.project.name}: ${parity.summary}`);
    expect(parity.diffPixels, parity.summary).toBe(0);
  }
});

async function openModbusMaster(page, runtime) {
  await openPreview(page, runtime);
  const master = page.getByRole('button', { name: '选择 锅炉主站' });
  await master.click();
  await page.locator('.endpoint-tree__entry').filter({ has: master })
    .getByRole('button', { name: '打开端点' }).click();
  await expect(page.locator('.session-status-bar')).toContainText('已打开');
}

async function previewWrites(page) {
  return page.evaluate(() => globalThis.__INEED_PREVIEW_MODBUS_REQUESTS__
    .filter(({ functionCode }) => functionCode > 4));
}

async function previewFailedModbusEnvelope(page, runtime) {
  return page.evaluate(async (activeRuntime) => {
    const request = {
      endpointId: 'modbus-master',
      functionCode: 16,
      unitId: 7,
      address: 20,
      quantity: 2,
      values: [100, 200],
    };
    if (activeRuntime === 'electron') {
      return globalThis.ineedLinkLab.modbus.execute(request);
    }
    return globalThis.__TAURI_INTERNALS__.invoke('modbus_execute', { args: [request] });
  }, runtime);
}

async function executeSavedCommand(page, name) {
  await page.getByRole('button', { name: `执行写入指令 ${name}`, exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '写入确认' })).toBeVisible();
  await page.getByRole('button', { name: `确认执行写入指令 ${name}`, exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '写入确认' })).toHaveCount(0);
}

async function fillSavedCommand(page, name, functionCode, address, values) {
  const dialog = page.getByRole('dialog');
  await dialog.locator('[name="modbus-write-command-name"]').fill(name);
  await dialog.locator('[name="modbus-write-command-function"]').selectOption(functionCode);
  await dialog.locator('[name="modbus-write-command-address"]').fill(address);
  await dialog.locator('[name="modbus-write-command-values"]').fill(values);
  await dialog.getByRole('button', { name: '保存指令', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function enableRequestPointHistory(page, requestName) {
  await page.getByRole('button', { name: `编辑请求 ${requestName}` }).click();
  const dialog = page.getByRole('dialog', { name: '编辑请求' });
  await dialog.locator('[name="request-point-0-save-history"]').check();
  await dialog.getByRole('radio', { name: '变化时' }).click();
  await dialog.getByRole('button', { name: '保存请求' }).click();
  await expect(dialog).toHaveCount(0);
}

async function assertActionsInsideContent(page, actions, { rightInset = 0 } = {}) {
  const content = page.locator('.modbus-master-panel__content');
  const bounds = await content.boundingBox();
  const viewport = page.viewportSize();
  for (const action of await actions.all()) {
    await expect(action).toBeVisible();
    const rect = await action.boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x - 1);
    expect(rect.x + rect.width).toBeLessThanOrEqual(
      Math.min(bounds.x + bounds.width, viewport.width) - rightInset + 1,
    );
    expect(rect.y).toBeGreaterThanOrEqual(bounds.y - 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(Math.min(bounds.y + bounds.height, viewport.height) + 1);
  }
}

async function assertSavedCommandLayout(page) {
  await assertActionsInsideContent(page, page.locator('.modbus-master-write button'));
  await assertNoPageOverflow(page);
  await assertControlTextFits(page);
  const clipped = await page.locator('.modbus-master-write button').evaluateAll((buttons) => buttons
    .filter((button) => button.scrollWidth > button.clientWidth + 1)
    .map((button) => button.ariaLabel));
  expect(clipped).toEqual([]);
  const overflow = await page.evaluate(() => ({
    viewport: globalThis.innerHeight,
    document: globalThis.document.documentElement.scrollHeight,
    body: globalThis.document.body.scrollHeight,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
}

async function captureParityContract(page) {
  return page.locator('body').evaluate((body) => {
    const normalizedBody = body.cloneNode(true);
    const normalizedRuntime = normalizedBody.querySelector('.linklab-shell__runtime');
    const normalizedLabel = normalizedRuntime?.querySelector('.workbench__runtime');
    if (normalizedRuntime) normalizedRuntime.title = 'runtime';
    if (normalizedLabel) normalizedLabel.textContent = 'runtime';

    const selectors = [
      '.linklab-shell', '.linklab-shell__tree', '.endpoint-tree',
      '.linklab-shell__runtime', '.linklab-shell__main', '.session-status-bar',
      '.frame-toolbar', '.linklab-shell__stream', '.frame-list', '.send-panel',
      '.send-panel__toolbar', '.send-panel__editor', '.send-panel__footer',
    ];
    const layout = Object.fromEntries(selectors.map((selector) => {
      const rect = body.querySelector(selector)?.getBoundingClientRect();
      return [selector, rect && {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      }];
    }));
    return { markup: normalizedBody.innerHTML, layout };
  });
}

async function openPreview(page, runtime, path = '/') {
  await page.goto(`${origins[runtime]}${path}`);
  await expect.poll(() => page.evaluate(() => globalThis.__INEED_PREVIEW_READY__)).toBe(true);
}

async function openActiveServer(page, runtime) {
  await openPreview(page, runtime);
  const endpoint = page.getByRole('button', { name: '选择 本地调试服务' });
  await expect(endpoint).toBeVisible();
  const endpointEntry = page.locator('.endpoint-tree__entry').filter({ has: endpoint });
  await endpointEntry.getByRole('button', { name: '打开端点' }).click();
  await expect(endpointEntry.getByRole('button', { name: '关闭端点' })).toBeVisible();
  await endpoint.click();
  await expect(page.locator('.session-status-bar')).toContainText('监听中');
  await expect(page.locator('[data-frame-key]')).toHaveCount(36);
}

async function expectInternalScroll(locator) {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const scroll = await locator.evaluate((element) => {
    const rootBefore = globalThis.document.documentElement.scrollTop;
    element.scrollTop = element.scrollHeight;
    return {
      container: element.scrollTop,
      rootBefore,
      rootAfter: globalThis.document.documentElement.scrollTop,
    };
  });
  expect(scroll.container).toBeGreaterThan(0);
  expect(scroll.rootAfter).toBe(scroll.rootBefore);
}

async function expectTimestampNoWrap(locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toHaveText(/\d{2}:\d{2}:\d{2}\.\d{3}/);
  if (await locator.getAttribute('title')) {
    await expect(locator).toHaveAttribute('title', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/);
  }
  const timestampLayout = await locator.evaluate((element) => {
    const range = globalThis.document.createRange();
    range.selectNodeContents(element);
    const layout = {
      whiteSpace: globalThis.getComputedStyle(element).whiteSpace,
      wraps: range.getClientRects().length > 1,
    };
    range.detach();
    return layout;
  });
  expect(timestampLayout).toEqual({ whiteSpace: 'nowrap', wraps: false });
}

async function assertCompactHistoryTableScroll(page) {
  const viewportWidth = await page.evaluate(() => globalThis.document.documentElement.clientWidth);
  if (viewportWidth > 1200) return;
  expect(await page.evaluate(() => (
    globalThis.document.documentElement.scrollWidth
      <= globalThis.document.documentElement.clientWidth
  ))).toBe(true);
  expect(await page.locator('.history-table-wrap').evaluate((el) => ({
    overflowX: globalThis.getComputedStyle(el).overflowX,
    hasHorizontalScroll: el.scrollWidth > el.clientWidth,
  }))).toEqual({ overflowX: 'auto', hasHorizontalScroll: true });
}

async function resizeSendPanel(page, handle, startY, endY) {
  await handle.dispatchEvent('pointerdown', { clientY: startY, buttons: 1, pointerId: 1 });
  await page.evaluate((clientY) => {
    globalThis.dispatchEvent(new globalThis.PointerEvent('pointermove', { clientY, buttons: 1, pointerId: 1 }));
    globalThis.dispatchEvent(new globalThis.PointerEvent('pointerup', { clientY, pointerId: 1 }));
  }, endY);
}

async function expectHeight(locator, expected, tolerance) {
  const height = await locator.evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(height - expected)).toBeLessThanOrEqual(tolerance);
}

async function assertWorkbenchLayout(page) {
  await assertNoPageOverflow(page);
  const result = await page.evaluate(() => {
    const rect = (selector) => {
      const bounds = globalThis.document.querySelector(selector)?.getBoundingClientRect();
      return bounds && {
        selector, left: bounds.left, right: bounds.right,
        top: bounds.top, bottom: bounds.bottom,
      };
    };
    const vertical = (selectors) => selectors.map(rect).filter(Boolean);
    const mainRows = vertical([
      '.session-status-bar', '.frame-toolbar', '.linklab-shell__stream', '.send-panel',
    ]);
    const sendRows = vertical([
      '.send-panel__toolbar', '.send-panel__editor', '.send-panel__footer',
    ]);
    const overlaps = [];
    for (const rows of [mainRows, sendRows]) {
      for (let index = 1; index < rows.length; index += 1) {
        if (rows[index - 1].bottom > rows[index].top + 1) {
          overlaps.push([rows[index - 1].selector, rows[index].selector]);
        }
      }
    }
    const tree = rect('.linklab-shell__tree');
    const main = rect('.linklab-shell__main');
    if (tree && main && tree.right > main.left + 1) overlaps.push([tree.selector, main.selector]);
    return overlaps;
  });
  expect(result).toEqual([]);
}

async function assertHistoryLayout(page) {
  const layout = await page.evaluate(() => {
    const selectors = [
      '.history-window__header', '.history-filters',
      '.history-window__state', '.history-window__content', '.history-pager',
    ];
    const rows = selectors.map((selector) => ({
      selector,
      rect: globalThis.document.querySelector(selector)?.getBoundingClientRect(),
    })).filter(({ rect }) => rect);
    const shell = globalThis.document.querySelector('.history-window')?.getBoundingClientRect();
    const pager = globalThis.document.querySelector('.history-pager')?.getBoundingClientRect();
    return {
      overlaps: rows.slice(1)
        .filter(({ rect }, index) => rows[index].rect.bottom > rect.top + 1)
        .map(({ selector }, index) => [rows[index].selector, selector]),
      pagerBottom: pager?.bottom ?? 0,
      shellBottom: shell?.bottom ?? 0,
    };
  });
  expect(layout.overlaps).toEqual([]);
  expect(Math.abs(layout.pagerBottom - layout.shellBottom)).toBeLessThanOrEqual(1);
}

async function assertNoPageOverflow(page) {
  const overflow = await page.evaluate(() => ({
    viewport: globalThis.innerWidth,
    document: globalThis.document.documentElement.scrollWidth,
    body: globalThis.document.body.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
}

async function assertNestedModbusLayout(page) {
  await assertNoPageOverflow(page);
  const layout = await page.locator('.modbus-request-groups').evaluate((container) => {
    const intersects = (left, right) => (
      left.right > right.left + 1
      && left.left < right.right - 1
      && left.bottom > right.top + 1
      && left.top < right.bottom - 1
    );
    const overlaps = [];
    for (const actions of container.querySelectorAll('.table-actions')) {
      const buttons = [...actions.querySelectorAll('button')]
        .filter((button) => button.getClientRects().length > 0);
      for (let index = 1; index < buttons.length; index += 1) {
        if (intersects(buttons[index - 1].getBoundingClientRect(), buttons[index].getBoundingClientRect())) {
          overlaps.push([buttons[index - 1].ariaLabel, buttons[index].ariaLabel]);
        }
      }
    }
    const clipped = [...container.querySelectorAll('button')]
      .filter((button) => button.getClientRects().length > 0)
      .filter((button) => button.scrollWidth > button.clientWidth + 1)
      .map((button) => button.ariaLabel || button.textContent.trim());
    const groupBody = container.querySelector('.modbus-request-group__body');
    const bodyRect = groupBody?.getBoundingClientRect();
    const hiddenDeleteButtons = [...container.querySelectorAll('[aria-label^="删除请求 "]')]
      .filter((button) => button.getClientRects().length > 0)
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return !bodyRect || rect.left < bodyRect.left - 1 || rect.right > bodyRect.right + 1;
      })
      .map((button) => button.ariaLabel);
    const narrowActionLayoutErrors = container.clientWidth > 650 ? [] : [...container.querySelectorAll(
      '.modbus-request-table tbody > tr:not(.modbus-request-points-preview)',
    )].filter((row) => {
      const cells = row.querySelectorAll(':scope > td');
      const scope = cells[2]?.getBoundingClientRect();
      const pdu = cells[3]?.getBoundingClientRect();
      const actions = cells[5]?.getBoundingClientRect();
      return !scope || !pdu || !actions || actions.top < Math.max(scope.bottom, pdu.bottom) - 1;
    }).map((row) => row.dataset.requestId);
    return {
      overlaps,
      clipped,
      hasHorizontalScroll: Boolean(groupBody && groupBody.scrollWidth > groupBody.clientWidth + 1),
      hiddenDeleteButtons,
      narrowActionLayoutErrors,
    };
  });
  expect(layout).toEqual({
    overlaps: [],
    clipped: [],
    hasHorizontalScroll: false,
    hiddenDeleteButtons: [],
    narrowActionLayoutErrors: [],
  });
}

async function assertControlTextFits(page) {
  const clipped = await page.evaluate(() => {
    const selectors = [
      '.command-button', '.segmented-control button', '.endpoint-tree__filter-select select',
      '.history-filters button', '.history-pager button',
    ];
    return [...globalThis.document.querySelectorAll(selectors.join(','))]
      .filter((element) => element.getClientRects().length > 0 && element.textContent.trim())
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent.trim());
  });
  expect(clipped).toEqual([]);
}

async function assertNonblankWorkbench(page) {
  const coverage = await page.evaluate(() => {
    const shell = globalThis.document.querySelector('.linklab-shell, .history-window');
    const rect = shell?.getBoundingClientRect();
    return {
      textLength: globalThis.document.body.innerText.trim().length,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      viewportWidth: globalThis.innerWidth,
      viewportHeight: globalThis.innerHeight,
      hasVisibleFrameOrHistory: Boolean(globalThis.document.querySelector(
        '[data-frame-key], .log-list__row, .history-table tbody tr',
      )),
    };
  });
  expect(coverage.textLength).toBeGreaterThan(300);
  expect(coverage.width).toBe(coverage.viewportWidth);
  expect(coverage.height).toBe(coverage.viewportHeight);
  expect(coverage.hasVisibleFrameOrHistory).toBe(true);
}
