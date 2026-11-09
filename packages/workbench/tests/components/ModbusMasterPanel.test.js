import { existsSync, readFileSync } from 'node:fs';

import { chromium } from '@playwright/test';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import { isProxy } from 'vue';

import ModbusMasterPanel from '../../src/components/ModbusMasterPanel.vue';

const masterChart = vi.hoisted(() => ({
  dispose: vi.fn(), resize: vi.fn(), setOption: vi.fn(),
}));

vi.mock('../../src/model/trendChart.js', () => ({
  init: vi.fn(() => masterChart),
}));

const panelStyles = [
  '../../src/styles/base.css',
  '../../src/styles/workbench.css',
  '../../src/styles/desktop.css',
].map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')).join('\n');

describe('ModbusMasterPanel', () => {
  test('editor saves show busy state and retryable persistence errors inside the active modal', async () => {
    const pending = deferred();
    const wrapper = mountPanel(masterEndpoint(), { saveCommand: () => pending.promise });
    try {
      await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
      await wrapper.get('[aria-label="编辑请求组 环境参数"]').trigger('click');
      await wrapper.get('[aria-labelledby="modbus-group-dialog-title"]').trigger('submit');
      expect(wrapper.get('[aria-labelledby="modbus-group-dialog-title"]').attributes('aria-busy')).toBe('true');
      pending.resolve({ ok: false, error: new Error('保存被拒绝，请重试') }); await flushPromises();
      const dialog = wrapper.get('[aria-labelledby="modbus-group-dialog-title"]');
      expect(dialog.get('[role="alert"]').text()).toContain('保存被拒绝，请重试');
      expect(dialog.get('button[type="submit"]').element.disabled).toBe(false);
    } finally { pending.resolve({ ok: true }); wrapper.unmount(); }
  });

  test('an old editor save cannot replace another endpoint config or close its new editor', async () => {
    const pending = deferred();
    const wrapper = mountPanel(masterEndpoint(), { saveCommand: () => pending.promise });
    try {
      await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
      await wrapper.get('[aria-label="编辑请求组 环境参数"]').trigger('click');
      await wrapper.get('[aria-labelledby="modbus-group-dialog-title"]').trigger('submit');
      const next = masterEndpoint(); next.id = 'master-2'; next.config.requestGroups = [];
      await wrapper.setProps({ endpoint: next });
      await wrapper.get('[aria-label="新增请求组"]').trigger('click');
      await wrapper.get('[name="request-group-name"]').setValue('新端点草稿');
      pending.resolve({ ok: true }); await flushPromises();
      expect(wrapper.get('[name="request-group-name"]').element.value).toBe('新端点草稿');
      expect(wrapper.find('[aria-label="编辑请求组 环境参数"]').exists()).toBe(false);
    } finally { pending.resolve({ ok: true }); wrapper.unmount(); }
  });

  test('renders transport-specific master settings as grouped details instead of a parameter grid', async () => {
    const tcpWrapper = mountPanel(masterEndpoint());
    await tcpWrapper.findAll('[role="tab"]').find(tab => tab.text() === '基础配置').trigger('click');

    expect(tcpWrapper.get('.modbus-master-overview h2').text()).toBe('锅炉主站');
    expect(tcpWrapper.find('.modbus-master-summary > dl').exists()).toBe(false);
    expect(tcpWrapper.findAll('.modbus-master-detail-section').map((section) => section.get('h3').text())).toEqual([
      '连接信息', '执行策略',
    ]);
    expect(tcpWrapper.get('.modbus-master-detail-section--connection').text()).toContain('主机地址');
    expect(tcpWrapper.get('.modbus-master-detail-section--connection').text()).toContain('192.168.1.10');
    expect(tcpWrapper.get('.modbus-master-detail-section--connection').text()).toContain('502');
    expect(tcpWrapper.get('.modbus-master-detail-section--strategy').text()).toContain('请求超时');
    expect(tcpWrapper.get('.modbus-master-detail-section--strategy').text()).toContain('断线重连');

    const rtuWrapper = mountPanel({
      ...masterEndpoint(),
      transport: 'modbus-rtu-master',
      config: {
        ...masterEndpoint().config,
        path: '/dev/ttyUSB0', baudRate: 19_200, dataBits: 8, stopBits: 1, parity: 'even',
      },
    });
    await rtuWrapper.findAll('[role="tab"]').find(tab => tab.text() === '基础配置').trigger('click');
    const rtuDetails = rtuWrapper.get('.modbus-master-detail-section--connection').text();
    expect(rtuDetails).toContain('/dev/ttyUSB0');
    expect(rtuDetails).toContain('19200 baud');
    expect(rtuDetails).toContain('8 数据位 · 1 停止位 · 偶校验');
  });

  test('shows the data trends tab and persists request-group CRUD without losing endpoint config', async () => {
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const scheduler = schedulerStub();
    const wrapper = mount(ModbusMasterPanel, {
      props: {
        endpoint: masterEndpoint(), runtime: runtimeStub(), running: true,
        sessionId: 'session-1', scheduler, saveCommand,
      },
    });

    expect(wrapper.findAll('[aria-label="Modbus 主站视图"] button').map((item) => item.text())).toEqual([
      '实时数据', '请求组', '基础配置', '报文诊断', '写入操作', '数据趋势',
    ]);
    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    expect(wrapper.text()).toContain('环境参数');
    expect(wrapper.text()).toContain('2 个请求');
    expect(wrapper.text()).toContain('2 个数据点');
    expect(wrapper.find('[aria-label="展开请求组 环境参数"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('FC01 读取线圈');
    expect(wrapper.text()).toContain('FC03 读取保持寄存器');
    await wrapper.get('[aria-label="复制请求组 环境参数"]').trigger('click');
    await flushPromises();
    expect(saveCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'master-1',
      config: expect.objectContaining({
        marker: 'preserved',
        requestGroups: expect.arrayContaining([
          expect.objectContaining({ name: '环境参数' }),
          expect.objectContaining({ name: '环境参数副本' }),
        ]),
      }),
    }));

    await wrapper.get('[aria-label="单次执行请求组 环境参数"]').trigger('click');
    await flushPromises();
    expect(scheduler.runGroup).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: 'master-1', sessionId: 'session-1', groupId: 'group-1',
    }));
  });

  test('passes endpoint config and collector state into the data trends view', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 220, height: 220, left: 0, right: 800, top: 0, width: 800,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const endpoint = masterEndpoint();
    endpoint.config.requestGroups[0].requests[0].dataPoints[0].saveHistory = true;
    const runtime = runtimeStub();
    runtime.modbusHistory = {
      querySeries: vi.fn(async ({ from, to }) => ({ series: [], from, to })),
      queryRows: vi.fn(async ({ page, pageSize }) => ({ rows: [], total: 0, page, pageSize })),
      exportCsv: vi.fn(async () => ({ canceled: true })),
      clear: vi.fn(async () => 0),
    };
    const wrapper = mountPanel(endpoint, {
      runtime,
      collectorStatus: { pendingCount: 4, droppedCount: 0, failedBatchCount: 0 },
    });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(6)').trigger('click');
    await flushPromises();
    expect(wrapper.get('[aria-label="Modbus 数据趋势"]').text()).toContain('温度');
    expect(wrapper.get('.modbus-trends-collector-status').text()).toContain('待写入 4 条');
    expect(runtime.modbusHistory.querySeries).toHaveBeenCalledOnce();
  });

  test('runs one nested request and opens the request editor from its group', async () => {
    const scheduler = schedulerStub();
    const wrapper = mountPanel(masterEndpoint(), { scheduler });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    await wrapper.get('[aria-label="单次执行请求 保持寄存器"]').trigger('click');
    await flushPromises();
    expect(scheduler.runRequest).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: 'master-1', sessionId: 'session-1',
      groupId: 'group-1', requestId: 'holding',
    }));

    await wrapper.get('[aria-label="新增请求到 环境参数"]').trigger('click');
    expect(wrapper.get('[aria-labelledby="modbus-request-dialog-title"]').text()).toContain('新增请求');
  });

  test('shows a complete request frame in HEX beside every configured read request', async () => {
    const wrapper = mountPanel(masterEndpoint());

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');

    expect(wrapper.get('[data-request-id="holding"] .modbus-request-command').text())
      .toBe('00 00 00 00 00 06 01 03 00 64 00 0A');
    expect(wrapper.get('[data-request-id="coils"] .modbus-request-command').text())
      .toBe('00 00 00 00 00 06 01 01 00 14 00 0A');
    expect(wrapper.get('.modbus-request-table thead').text()).toContain('请求帧模板（HEX）');

    const rtuEndpoint = {
      ...masterEndpoint(),
      transport: 'modbus-rtu-master',
      config: { ...masterEndpoint().config, path: '/dev/ttyUSB0' },
    };
    const rtuWrapper = mountPanel(rtuEndpoint);
    await rtuWrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    expect(rtuWrapper.get('[data-request-id="holding"] .modbus-request-command').text())
      .toBe('01 03 00 64 00 0A 84 12');
  });

  test('uses configured reference notation when displaying request addresses', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.addressNotation = 'reference';
    const wrapper = mountPanel(endpoint);

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');

    expect(wrapper.get('[data-request-id="holding"] td:nth-child(3)').text()).toContain('40101');
    expect(wrapper.get('[data-request-id="coils"] td:nth-child(3)').text()).toContain('00021');
  });

  test('disables group execution when every request in the group is disabled', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.requestGroups[0].requests.forEach((request) => { request.enabled = false; });
    const wrapper = mountPanel(endpoint);

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');

    expect(wrapper.get('[aria-label="单次执行请求组 环境参数"]').attributes('disabled')).toBeDefined();
  });

  test('keeps status read-only and synchronizes request states through explicit action buttons', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.requestGroups[0].requests[1].enabled = false;
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(endpoint, { saveCommand });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    const group = wrapper.get('[data-request-group-id="group-1"]');
    expect(group.get('.modbus-request-group__status').text()).toBe('部分启用');
    expect(group.get('.modbus-request-group__status').element.tagName).toBe('SPAN');

    const requestStatuses = wrapper.findAll('.modbus-request-status');
    expect(requestStatuses.map((status) => status.element.tagName)).toEqual(['SPAN', 'SPAN']);
    expect(wrapper.find('.modbus-request-table td:first-child button').exists()).toBe(false);

    await wrapper.get('[aria-label="启用请求组 环境参数"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0]).toMatchObject({
      enabled: true,
      requests: [expect.objectContaining({ enabled: true }), expect.objectContaining({ enabled: true })],
    });

    await wrapper.get('[aria-label="停用请求组 环境参数"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0]).toMatchObject({
      enabled: false,
      requests: [expect.objectContaining({ enabled: false }), expect.objectContaining({ enabled: false })],
    });

    await wrapper.get('[aria-label="启用请求 保持寄存器"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0]).toMatchObject({
      enabled: true,
      requests: [expect.objectContaining({ id: 'holding', enabled: true }), expect.objectContaining({ id: 'coils', enabled: false })],
    });
    expect(group.get('.modbus-request-group__status').text()).toBe('部分启用');
  });

  test('persists nested request CRUD while retaining unrelated endpoint configuration', async () => {
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(masterEndpoint(), { saveCommand });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    await wrapper.get('[aria-label="停用请求 保持寄存器"]').trigger('click');
    await flushPromises();
    expect(saveCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        marker: 'preserved',
        requestGroups: [expect.objectContaining({
          requests: expect.arrayContaining([expect.objectContaining({ id: 'holding', enabled: false })]),
        })],
      }),
    }));

    await wrapper.get('[aria-label="复制请求 保持寄存器"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0].requests).toHaveLength(3);
    await wrapper.get('[aria-label="删除请求 保持寄存器副本"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0].requests).toHaveLength(2);

    await wrapper.get('[aria-label="下移请求 保持寄存器"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0].requests.map(({ id }) => id)).toEqual([
      'coils', 'holding',
    ]);

    await wrapper.get('[aria-label="编辑请求 保持寄存器"]').trigger('click');
    await wrapper.get('input[name="modbus-request-name"]').setValue('锅炉寄存器');
    await wrapper.get('[aria-labelledby="modbus-request-dialog-title"]').trigger('submit');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0].requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'holding', name: '锅炉寄存器' }),
    ]));

    await wrapper.get('[aria-label="新增请求到 环境参数"]').trigger('click');
    await wrapper.get('input[name="modbus-request-name"]').setValue('输入寄存器');
    await wrapper.get('[aria-labelledby="modbus-request-dialog-title"]').trigger('submit');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0].requests).toHaveLength(3);
  });

  test('copying the same request repeatedly persists unique point keys', async () => {
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(masterEndpoint(), { saveCommand });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    const copyOriginal = () => wrapper.get('[aria-label="复制请求 保持寄存器"]');
    await copyOriginal().trigger('click');
    await flushPromises();
    await copyOriginal().trigger('click');
    await flushPromises();

    const requests = saveCommand.mock.lastCall[0].config.requestGroups[0].requests;
    const keys = requests.flatMap(({ dataPoints }) => dataPoints.map(({ key }) => key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('persists request-group edit, copy, reorder, toggle, and delete operations', async () => {
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(masterEndpoint(), { saveCommand });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    await wrapper.get('[aria-label="编辑请求组 环境参数"]').trigger('click');
    await wrapper.get('input[name="request-group-name"]').setValue('锅炉环境');
    await wrapper.get('[aria-labelledby="modbus-group-dialog-title"]').trigger('submit');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[0]).toMatchObject({
      id: 'group-1', name: '锅炉环境', unitId: 1,
    });

    await wrapper.get('[aria-label="复制请求组 锅炉环境"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups).toHaveLength(2);
    await wrapper.get('[aria-label="下移请求组 锅炉环境"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[1].id).toBe('group-1');
    await wrapper.get('[aria-label="停用请求组 锅炉环境"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups[1].enabled).toBe(false);
    await wrapper.get('[aria-label="删除请求组 锅炉环境副本"]').trigger('click');
    await wrapper.get('[aria-label="确认删除请求组 锅炉环境副本"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.requestGroups.map(({ id }) => id)).toEqual(['group-1']);
  });

  test('keeps request-group deletion visible and requires a count-aware confirmation', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.requestGroups[0].name = '锅炉环境';
    endpoint.config.writeCommands = [writeCommand('target', '设定目标', 0)];
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(endpoint, { saveCommand });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    expect(wrapper.find('[aria-label="展开请求组 锅炉环境"]').exists()).toBe(false);
    expect(wrapper.get('[data-request-group-id="group-1"] .modbus-request-table').exists()).toBe(true);
    await wrapper.get('[aria-label="删除请求组 锅炉环境"]').trigger('click');

    const confirmation = wrapper.get('[role="alertdialog"]');
    expect(confirmation.text()).toContain('锅炉环境');
    expect(confirmation.text()).toContain('2 个请求');
    expect(confirmation.text()).toContain('2 个数据点');
    expect(saveCommand).not.toHaveBeenCalled();

    await wrapper.get('[aria-label="取消删除请求组 锅炉环境"]').trigger('click');
    expect(saveCommand).not.toHaveBeenCalled();
    await wrapper.get('[aria-label="删除请求组 锅炉环境"]').trigger('click');
    await wrapper.get('[aria-label="确认删除请求组 锅炉环境"]').trigger('click');
    await flushPromises();

    expect(saveCommand.mock.lastCall[0].config.requestGroups).toHaveLength(0);
    expect(saveCommand.mock.lastCall[0].config.writeCommands).toEqual(endpoint.config.writeCommands);
  });

  test('shows an empty write workspace and adds a complete saved command', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [];
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(endpoint, { saveCommand });

    await openWriteTab(wrapper);
    expect(wrapper.text()).toContain('还没有写入指令');
    await wrapper.get('[aria-label="新增写入指令"]').trigger('click');
    await wrapper.get('input[name="modbus-write-command-name"]').setValue('设定目标');
    await wrapper.get('textarea[name="modbus-write-command-description"]').setValue('锅炉目标值');
    await wrapper.get('select[name="modbus-write-command-function"]').setValue('16');
    await wrapper.get('input[name="modbus-write-command-address"]').setValue('20');
    await wrapper.get('input[name="modbus-write-command-values"]').setValue('100, 200');
    await wrapper.get('[aria-labelledby="modbus-write-command-dialog-title"]').trigger('submit');
    await flushPromises();

    expect(saveCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'master-1',
      config: expect.objectContaining({
        marker: 'preserved',
        requestGroups: endpoint.config.requestGroups,
        writeCommands: [expect.objectContaining({
          name: '设定目标', description: '锅炉目标值', enabled: true, order: 0,
          unitId: 1, functionCode: 16, address: 20, values: [100, 200],
        })],
      }),
    }));
    const row = wrapper.get('[data-write-command-id]');
    expect(row.get('.modbus-write-command__summary').exists()).toBe(true);
    expect(row.get('.modbus-write-command__frame').exists()).toBe(true);
    expect(row.get('.modbus-write-command__footer').exists()).toBe(true);
    expect(row.get('.modbus-write-command__status').element.tagName).toBe('SPAN');
    expect(row.get('[aria-label="停用写入指令 设定目标"]')).toBeTruthy();
    expect(row.text()).toContain('设定目标');
    expect(row.text()).toContain('锅炉目标值');
    expect(row.text()).toContain('Slave 1');
    expect(row.text()).toContain('FC16 写入多个寄存器');
    expect(row.text()).toContain('地址 20–21');
    expect(row.text()).toContain('100, 200');
    expect(row.get('.modbus-write-command__pdu code').text())
      .toBe('00 00 00 00 00 0B 01 10 00 14 00 02 04 00 64 00 C8');
    expect(row.get('.modbus-write-command__pdu span').text()).toBe('请求帧模板（HEX）');
    expect(row.text()).toContain('尚未执行');
  });

  test('edits, copies, reorders, toggles, and confirms deletion of saved commands', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [
      writeCommand('target', '设定目标', 0),
      writeCommand('pump', '启动水泵', 1, { functionCode: 5, address: 10, values: [true] }),
    ];
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(endpoint, { saveCommand });

    await openWriteTab(wrapper);
    await wrapper.get('[aria-label="编辑写入指令 设定目标"]').trigger('click');
    await wrapper.get('input[name="modbus-write-command-name"]').setValue('设定运行目标');
    await wrapper.get('[aria-labelledby="modbus-write-command-dialog-title"]').trigger('submit');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.writeCommands[0]).toMatchObject({
      id: 'target', name: '设定运行目标', values: [100, 200],
    });
    expect(saveCommand.mock.lastCall[0].config.requestGroups).toEqual(endpoint.config.requestGroups);

    await wrapper.get('[aria-label="复制写入指令 设定运行目标"]').trigger('click');
    await flushPromises();
    const copied = saveCommand.mock.lastCall[0].config.writeCommands[2];
    expect(copied).toMatchObject({ name: '设定运行目标副本', order: 2, values: [100, 200] });
    expect(copied.id).not.toBe('target');

    await wrapper.get('[aria-label="上移写入指令 设定运行目标副本"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.writeCommands.map(({ id }) => id)).toEqual([
      'target', copied.id, 'pump',
    ]);

    await wrapper.get('[aria-label="停用写入指令 设定运行目标"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.writeCommands[0].enabled).toBe(false);

    const savesBeforeDelete = saveCommand.mock.calls.length;
    await wrapper.get('[aria-label="删除写入指令 设定运行目标副本"]').trigger('click');
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('设定运行目标副本');
    expect(saveCommand).toHaveBeenCalledTimes(savesBeforeDelete);
    await wrapper.get('[aria-label="取消删除写入指令 设定运行目标副本"]').trigger('click');
    expect(saveCommand).toHaveBeenCalledTimes(savesBeforeDelete);
    await wrapper.get('[aria-label="删除写入指令 设定运行目标副本"]').trigger('click');
    await wrapper.get('[aria-label="确认删除写入指令 设定运行目标副本"]').trigger('click');
    await flushPromises();
    expect(saveCommand.mock.lastCall[0].config.writeCommands.map(({ id }) => id)).toEqual(['target', 'pump']);
  });

  test('keeps the saved command list unchanged when persistence fails', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [writeCommand('target', '设定目标', 0)];
    const saveCommand = vi.fn(async () => ({ ok: false, error: new Error('磁盘已满') }));
    const wrapper = mountPanel(endpoint, { saveCommand });

    await openWriteTab(wrapper);
    await wrapper.get('[aria-label="停用写入指令 设定目标"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[aria-label="停用写入指令 设定目标"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toContain('磁盘已满');
    expect(endpoint.config.writeCommands[0].enabled).toBe(true);
  });

  test('renders decoded live quality, group statistics, and run records', async () => {
    const scheduler = schedulerStub({
      active: true,
      groups: {
        'group-1': {
          lastResult: 'success',
          requests: {
            holding: {
              successCount: 9, failureCount: 1, consecutiveFailures: 0, durationMs: 12,
              lastSuccessAt: 1_700_000_000_000, lastFailureAt: null, lastError: null,
              points: { temperature: { display: '25.6', quality: 'good', reason: null, raw: [256] } },
            },
            coils: {
              successCount: 1, failureCount: 0, consecutiveFailures: 0, durationMs: 5,
              lastSuccessAt: 1_700_000_000_000, lastFailureAt: null, lastError: null,
              points: { running: { display: 'true', quality: 'good', reason: null, raw: [true] } },
            },
          },
        },
      },
      records: [{
        id: 'record-1', groupId: 'group-1', groupName: '环境参数',
        requestId: 'holding', requestName: '保持寄存器', success: true,
        attempt: 1, durationMs: 12, error: null, createdAt: 1_700_000_000_000,
      }],
    });
    const wrapper = mount(ModbusMasterPanel, {
      props: {
        endpoint: masterEndpoint(), runtime: runtimeStub(), running: true,
        sessionId: 'session-1', scheduler, saveCommand: vi.fn(),
      },
    });

    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === '实时数据').trigger('click');
    const liveGroup = wrapper.get('.modbus-master-live-group');
    expect(liveGroup.get('.modbus-master-live-group__header').text()).toContain('环境参数');
    expect(liveGroup.get('.modbus-master-live-group__header').text()).toContain('从站地址 1');
    expect(liveGroup.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('25.6℃');
    expect(wrapper.text()).toContain('保持寄存器');
    expect(wrapper.text()).toContain('正常');
    expect(wrapper.text()).toContain('90.0%');
    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');
    expect(wrapper.text()).toContain('环境参数');
    expect(wrapper.text()).toContain('保持寄存器');
    expect(wrapper.text()).toContain('12 ms');
  });

  test('keeps sibling request values visible for partial groups and marks disabled requests', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.requestGroups[0].requests[1].enabled = false;
    const scheduler = schedulerStub({
      groups: {
        'group-1': {
          lastResult: 'partial',
          requests: {
            holding: {
              successCount: 0, failureCount: 1, lastError: '设备超时',
              points: { temperature: { display: '—', quality: 'bad-communication', reason: '设备超时', raw: [] } },
            },
          },
        },
      },
    });
    const wrapper = mountPanel(endpoint, { scheduler });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    expect(wrapper.text()).toContain('部分失败');
    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === '实时数据').trigger('click');
    expect(wrapper.get('.modbus-master-live-group__error').text()).toContain('设备超时');
    const rows = wrapper.findAll('.modbus-master-live tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('保持寄存器');
    expect(rows[0].text()).toContain('通信异常');
    expect(rows[1].text()).toContain('运行线圈');
    expect(rows[1].text()).toContain('已停用');
  });

  test('runs only enabled saved commands after confirmation with a fresh request', async () => {
    const pending = deferred();
    const executeImmediate = vi.fn(() => pending.promise);
    const scheduler = schedulerStub();
    scheduler.executeImmediate = executeImmediate;
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [
      writeCommand('target', '设定目标', 0),
      writeCommand('disabled', '停机指令', 1, { enabled: false, values: [0] }),
    ];
    const wrapper = mountPanel(endpoint, { scheduler });

    await openWriteTab(wrapper);
    expect(wrapper.get('[aria-label="执行写入指令 停机指令"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[aria-label="执行写入指令 设定目标"]').trigger('click');
    expect(executeImmediate).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('设定目标');
    await wrapper.get('[aria-label="确认执行写入指令 设定目标"]').trigger('click');

    const request = executeImmediate.mock.lastCall[0].request;
    expect(isProxy(request)).toBe(false);
    expect(isProxy(request.values)).toBe(false);
    expect(request.values).not.toBe(endpoint.config.writeCommands[0].values);
    await flushPromises();
    expect(executeImmediate).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: 'master-1', sessionId: 'session-1',
      request: expect.objectContaining({
        functionCode: 16, unitId: 1, address: 20, quantity: 2, values: [100, 200],
      }),
    }));
    expect(wrapper.get('[aria-label="确认执行写入指令 设定目标"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[aria-label="执行写入指令 设定目标"]').attributes('disabled')).toBeDefined();

    pending.resolve(transaction(request));
    await flushPromises();
    const rows = wrapper.findAll('[data-write-command-id]');
    expect(rows[0].text()).toContain('写入成功');
    expect(rows[1].text()).toContain('尚未执行');
    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');
    expect(wrapper.get('.modbus-diagnostic-list').text()).toContain('FC16 写多个寄存器');
    expect(wrapper.get('.modbus-diagnostic-frame:first-child .modbus-diagnostic-frame__hex').text())
      .toBe('00 00 00 00 00 0B 01 10 00 14 00 02 04 00 64 00 C8');
  });

  test('marks malformed persisted commands invalid and never offers device execution', async () => {
    const executeImmediate = vi.fn();
    const scheduler = schedulerStub();
    scheduler.executeImmediate = executeImmediate;
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [
      writeCommand('bad-fc05', '非法单线圈', 0, { functionCode: 5, values: ['enabled'] }),
      writeCommand('bad-fc06', '非法单寄存器', 1, { functionCode: 6, values: ['1'] }),
      writeCommand('bad-fc15', '非法多线圈', 2, { functionCode: 15, values: [true, 1] }),
      writeCommand('bad-fc16', '非法多寄存器', 3, { functionCode: 16, values: [1, '2'] }),
    ];
    const wrapper = mountPanel(endpoint, { scheduler });

    await openWriteTab(wrapper);
    for (const name of ['非法单线圈', '非法单寄存器', '非法多线圈', '非法多寄存器']) {
      const row = wrapper.findAll('[data-write-command-id]').find((item) => item.text().includes(name));
      expect(row.text()).toContain('配置错误');
      expect(row.get(`[aria-label="执行写入指令 ${name}"]`).attributes('disabled')).toBeDefined();
      await row.get(`[aria-label="执行写入指令 ${name}"]`).trigger('click');
    }
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(executeImmediate).not.toHaveBeenCalled();
  });

  test('preserves a malformed non-array write value during an unrelated group save', async () => {
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [
      writeCommand('bad-value-shape', '待修复指令', 0, { functionCode: 5, values: 'true' }),
    ];
    const saveCommand = vi.fn(async (value) => ({ ok: true, value }));
    const wrapper = mountPanel(endpoint, { saveCommand });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    await wrapper.get('[aria-label="停用请求组 环境参数"]').trigger('click');
    await flushPromises();

    expect(saveCommand).toHaveBeenCalledTimes(1);
    expect(saveCommand.mock.lastCall[0].config.writeCommands[0].values).toBe('true');
    await openWriteTab(wrapper);
    const invalidRow = wrapper.get('[data-write-command-id="bad-value-shape"]');
    expect(invalidRow.text()).toContain('配置错误');
    expect(invalidRow.get('.modbus-write-command__pdu code').text()).toBe('配置无效，无法生成指令');
    expect(wrapper.get('[aria-label="执行写入指令 待修复指令"]').attributes('disabled')).toBeDefined();
  });

  test('records a failed native transaction only on the selected command', async () => {
    const failedTransaction = {
      ...transaction({ functionCode: 16, unitId: 1, address: 20, quantity: 2, values: [100, 200] }),
      success: false, message: '设备拒绝写入', exceptionCode: 3,
    };
    const error = Object.assign(new Error('设备拒绝写入'), { transaction: failedTransaction });
    const scheduler = schedulerStub();
    scheduler.executeImmediate = vi.fn(async () => { throw error; });
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [
      writeCommand('target', '设定目标', 0),
      writeCommand('pump', '启动水泵', 1, { functionCode: 5, address: 10, values: [true] }),
    ];
    const wrapper = mountPanel(endpoint, { scheduler });

    await openWriteTab(wrapper);
    await wrapper.get('[aria-label="执行写入指令 设定目标"]').trigger('click');
    await wrapper.get('[aria-label="确认执行写入指令 设定目标"]').trigger('click');
    await flushPromises();

    const rows = wrapper.findAll('[data-write-command-id]');
    expect(rows[0].text()).toContain('设备拒绝写入');
    expect(rows[1].text()).toContain('尚未执行');
    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');
    expect(wrapper.get('.modbus-master-records').text()).toContain('设备拒绝写入');
  });

  test('keeps distinct same-timestamp transactions from different requests', async () => {
    let emitTransaction;
    const runtime = runtimeStub({
      onTransactions: vi.fn((listener) => {
        emitTransaction = listener;
        return () => {};
      }),
    });
    const wrapper = mountPanel(masterEndpoint(), { runtime });
    const createdAt = 1_700_000_000_000;

    emitTransaction({
      ...transaction({ functionCode: 3, unitId: 1, address: 100, quantity: 10 }),
      createdAt, requestGroupId: 'group-1', requestId: 'holding',
    });
    emitTransaction({
      ...transaction({ functionCode: 3, unitId: 1, address: 100, quantity: 10 }),
      createdAt, requestGroupId: 'group-2', requestId: 'holding',
    });
    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');

    expect(wrapper.findAll('.modbus-diagnostic-list > button')).toHaveLength(2);
  });

  test('renders TCP and RTU diagnostics as separate protocol-specific views', async () => {
    let emitTcp;
    const tcp = mountPanel(masterEndpoint(), {
      runtime: runtimeStub({
        onTransactions: vi.fn((listener) => {
          emitTcp = listener;
          return () => {};
        }),
      }),
    });
    emitTcp(transaction({
      transport: 'modbus-tcp-master', transactionId: 0x1234,
      functionCode: 3, unitId: 1, address: 100, quantity: 1, values: [25],
      requestFrame: [0x12, 0x34, 0, 0, 0, 6, 1, 3, 0, 100, 0, 1],
      responseFrame: [0x12, 0x34, 0, 0, 0, 5, 1, 3, 2, 0, 25],
    }));
    await tcp.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');
    const tcpDetail = tcp.get('.modbus-diagnostic-detail--tcp');
    expect(tcpDetail.text()).toContain('Modbus TCP 报文 · TCP ADU · MBAP + PDU · 不包含 CRC');
    expect(tcpDetail.text()).toContain('TCP TX 请求 ADU');
    expect(tcpDetail.text()).toContain('事务 ID');
    expect(tcpDetail.text()).toContain('12 34');
    expect(tcpDetail.text()).not.toContain('请求 CRC16');

    let emitRtu;
    const rtuEndpoint = {
      ...masterEndpoint(),
      transport: 'modbus-rtu-master',
      config: { ...masterEndpoint().config, path: '/dev/ttyUSB0' },
    };
    const rtu = mountPanel(rtuEndpoint, {
      runtime: runtimeStub({
        onTransactions: vi.fn((listener) => {
          emitRtu = listener;
          return () => {};
        }),
      }),
    });
    emitRtu(transaction({
      transport: 'modbus-rtu-master', functionCode: 6, unitId: 1,
      address: 2, quantity: 1, requestValues: [22], values: [22],
      requestFrame: [1, 6, 0, 2, 0, 22, 0xa9, 0xc4],
      responseFrame: [1, 6, 0, 2, 0, 22, 0xa9, 0xc4],
    }));
    await rtu.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');
    const rtuDetail = rtu.get('.modbus-diagnostic-detail--rtu');
    expect(rtuDetail.text()).toContain('Modbus RTU 报文 · RTU 帧 · 从站地址 + PDU + CRC16');
    expect(rtuDetail.text()).toContain('RTU TX 请求帧');
    expect(rtuDetail.text()).toContain('请求 CRC16');
    expect(rtuDetail.text()).toContain('A9 C4');
    expect(rtuDetail.text()).not.toContain('事务 ID');
  });

  test('treats a null immediate result as cancellation without result or transaction state', async () => {
    const scheduler = schedulerStub();
    scheduler.executeImmediate = vi.fn(async () => null);
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [writeCommand('target', '设定目标', 0)];
    const wrapper = mountPanel(endpoint, { scheduler });

    await openWriteTab(wrapper);
    await wrapper.get('[aria-label="执行写入指令 设定目标"]').trigger('click');
    await wrapper.get('[aria-label="确认执行写入指令 设定目标"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-write-command-id="target"]').text()).toContain('尚未执行');
    expect(wrapper.find('.modbus-panel__error').exists()).toBe(false);
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="执行写入指令 设定目标"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');
    expect(wrapper.get('.modbus-diagnostic-list').text()).toContain('暂无收发指令');
  });

  test('keeps group, request, and command Delete actions inside their layout boundaries', async () => {
    const bundledChromium = chromium.executablePath();
    const browser = await chromium.launch(existsSync(bundledChromium)
      ? { executablePath: bundledChromium, headless: true }
      : { channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(responsiveLayoutProbe());

      for (const width of [1024, 950]) {
        await page.setViewportSize({ width, height: 700 });
        const boxes = await page.evaluate(() => Object.fromEntries(
          ['panel', 'group-delete', 'request-cell', 'request-delete', 'command-delete'].map((id) => {
            const box = document.querySelector(`[data-probe="${id}"]`).getBoundingClientRect();
            return [id, { left: box.left, right: box.right }];
          }),
        ));

        expect(boxes.panel.left).toBe(240);
        expect(boxes['group-delete'].right).toBeLessThanOrEqual(boxes.panel.right);
        expect(boxes['request-delete'].right).toBeLessThanOrEqual(boxes['request-cell'].right);
        expect(boxes['command-delete'].right).toBeLessThanOrEqual(boxes.panel.right);
      }
    } finally {
      await browser.close();
    }
  });

  test('clears stale write confirmation when the session or endpoint changes', async () => {
    const executeImmediate = vi.fn();
    const scheduler = schedulerStub();
    scheduler.executeImmediate = executeImmediate;
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [writeCommand('target', '设定目标', 0)];
    const wrapper = mountPanel(endpoint, { scheduler });

    await openWriteTab(wrapper);
    await wrapper.get('[aria-label="执行写入指令 设定目标"]').trigger('click');
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    await wrapper.setProps({ sessionId: 'session-2' });
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);

    await wrapper.get('[aria-label="执行写入指令 设定目标"]').trigger('click');
    await wrapper.setProps({ endpoint: { ...endpoint, id: 'master-2' } });
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(executeImmediate).not.toHaveBeenCalled();
  });

  test.each([
    ['session', 'success'], ['session', 'failure'],
    ['endpoint', 'success'], ['endpoint', 'failure'],
  ])('ignores late write %s changes with a %s result and releases the write gate', async (change, outcome) => {
    const pending = deferred();
    const scheduler = schedulerStub();
    scheduler.executeImmediate = vi.fn(() => pending.promise);
    const endpoint = masterEndpoint();
    endpoint.config.writeCommands = [writeCommand('target', '设定目标', 0)];
    const wrapper = mountPanel(endpoint, { scheduler });

    await openWriteTab(wrapper);
    await wrapper.get('[aria-label="执行写入指令 设定目标"]').trigger('click');
    await wrapper.get('[aria-label="确认执行写入指令 设定目标"]').trigger('click');
    const request = scheduler.executeImmediate.mock.lastCall[0].request;
    await wrapper.setProps(change === 'session'
      ? { sessionId: 'session-2' }
      : { endpoint: { ...endpoint, id: 'master-2' } });
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);

    if (outcome === 'success') pending.resolve(transaction(request));
    else pending.reject(Object.assign(new Error('旧会话写入失败'), {
      transaction: { ...transaction(request), success: false, message: '旧会话写入失败' },
    }));
    await flushPromises();

    expect(wrapper.get('[data-write-command-id="target"]').text()).toContain('尚未执行');
    expect(wrapper.find('.modbus-panel__error').exists()).toBe(false);
    expect(wrapper.get('[aria-label="执行写入指令 设定目标"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(4)').trigger('click');
    expect(wrapper.get('.modbus-diagnostic-list').text()).toContain('暂无收发指令');
  });

  test('shows the response values beside the immediate read form', async () => {
    const executeImmediate = vi.fn(async ({ request }) => ({
      ...transaction(request), values: [321, 654],
    }));
    const scheduler = schedulerStub();
    scheduler.executeImmediate = executeImmediate;
    const wrapper = mount(ModbusMasterPanel, {
      props: {
        endpoint: masterEndpoint(), runtime: runtimeStub(), running: true,
        sessionId: 'session-1', scheduler, saveCommand: vi.fn(),
      },
    });

    await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(2)').trigger('click');
    await wrapper.get('.modbus-quick-read').trigger('submit');
    await flushPromises();

    expect(wrapper.get('.modbus-quick-read-result').text()).toContain('读取成功');
    expect(wrapper.get('.modbus-quick-read-result').text()).toContain('321, 654');
  });
});

function mountPanel(endpoint, overrides = {}) {
  return mount(ModbusMasterPanel, {
    props: {
      endpoint, runtime: runtimeStub(), running: true,
      sessionId: 'session-1', scheduler: schedulerStub(), saveCommand: vi.fn(),
      ...overrides,
    },
    global: { stubs: { Teleport: true } },
  });
}

async function openWriteTab(wrapper) {
  await wrapper.get('[aria-label="Modbus 主站视图"] button:nth-child(5)').trigger('click');
}

function masterEndpoint() {
  return {
    id: 'master-1', name: '锅炉主站', transport: 'modbus-tcp-master',
    config: {
      marker: 'preserved', host: '192.168.1.10', port: 502, unitId: 1,
      timeoutMs: 1000, retryCount: 2, retryIntervalMs: 200, autoReconnect: true,
      enabled: true, scheduler: { autoStart: false, minGapMs: 50 },
      requestGroups: [{
        id: 'group-1', name: '环境参数', description: '锅炉运行参数',
        enabled: true, order: 0, unitId: 1,
        requests: [
          request('holding', '保持寄存器', 0, 3, 100, [point('temperature', '温度', 0)]),
          request('coils', '运行线圈', 1, 1, 20, [point('running', '运行状态', 0, 'boolean')]),
        ],
      }],
    },
  };
}

function schedulerStub(status = {}) {
  return {
    getStatus: vi.fn(() => ({ active: false, groups: {}, records: [], ...status })),
    subscribe: vi.fn(() => () => {}), start: vi.fn(), stop: vi.fn(),
    runGroup: vi.fn(async () => ({ result: 'success', results: [] })),
    runRequest: vi.fn(async () => transaction({ functionCode: 3, address: 100, quantity: 10 })),
    executeImmediate: vi.fn(),
  };
}

function writeCommand(id, name, order, overrides = {}) {
  return {
    id, name, description: `${name}说明`, enabled: true, order,
    unitId: 1, functionCode: 16, address: 20, values: [100, 200],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function responsiveLayoutProbe() {
  const actionButtons = (kind, count) => `
    <div class="table-actions">
      ${Array.from({ length: count }, () => '<button class="icon-button"></button>').join('')}
      <button class="icon-button" data-probe="${kind}-delete"></button>
    </div>`;
  return `
    <style>${panelStyles}</style>
    <div class="linklab-shell">
      <aside class="linklab-shell__tree"></aside>
      <main style="min-width: 0">
        <section class="modbus-master-panel" data-probe="panel">
          <div class="modbus-request-groups">
            <section class="modbus-request-group">
              <header class="modbus-request-group__header">
                <span class="status-indicator status-indicator--enabled"><i></i>启用</span>
                <div class="modbus-request-group__identity"><strong>锅炉环境</strong><small>Slave 1</small></div>
                <div class="modbus-request-group__counts"><span>2 个请求</span><span>2 个数据点</span><span>尚未执行</span></div>
                ${actionButtons('group', 7)}
              </header>
              <div class="modbus-request-group__body">
                <div class="modbus-result-table modbus-request-table">
                  <table><thead><tr><th>状态</th><th>请求</th><th>功能与范围</th><th>请求帧模板（HEX）</th><th>运行信息</th><th>操作</th></tr></thead>
                    <tbody><tr><td>启用</td><td>保持寄存器</td><td>FC03</td><td>00 00</td><td>尚未执行</td><td data-probe="request-cell">${actionButtons('request', 6)}</td></tr></tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>
          <div class="modbus-write-command-list">
            <article class="modbus-write-command">
              <div class="modbus-write-command__summary">
                <span class="status-indicator status-indicator--enabled"><i></i>启用</span>
                <div class="modbus-write-command__identity"><strong>设定目标</strong><small>锅炉目标值</small></div>
                <div class="modbus-write-command__metadata"><span>Slave 1</span><span>FC16 写入多个寄存器</span><span>地址 20–21</span></div>
                <div class="modbus-write-command__value"><span>写入值</span><code class="modbus-write-command__values">100, 200</code></div>
                ${actionButtons('command', 6)}
              </div>
              <div class="modbus-write-command__pdu"><span>请求帧模板（HEX）</span><code>00 00</code></div>
              <footer class="modbus-write-command__footer"><span class="modbus-write-command__result">尚未执行</span></footer>
            </article>
          </div>
        </section>
      </main>
    </div>`;
}

function request(id, name, order, functionCode, startAddress, dataPoints) {
  return {
    id, name, enabled: true, order, functionCode, startAddress,
    quantity: 10, intervalMs: order === 0 ? 1000 : 500,
    timeoutMs: null, retryCount: null, retryIntervalMs: null, dataPoints,
  };
}

function point(id, name, offset, dataType = 'uint16') {
  return {
    id, key: id, name, enabled: true, offset, dataType,
    length: 1, byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 0.1, valueOffset: 0, unit: id === 'temperature' ? '℃' : '', decimals: null,
    minimum: null, maximum: null, invalidPolicy: 'mark-bad', saveHistory: false,
    historyMode: 'on-change',
  };
}

function runtimeStub(overrides = {}) {
  return {
    modbus: {
      execute: vi.fn(), readMap: vi.fn(), writeMap: vi.fn(),
      onTransactions: vi.fn(() => () => {}), ...overrides,
    },
  };
}

function transaction(request) {
  return {
    ...request, endpointId: request.endpointId ?? 'master-1', sessionId: 'session-1',
    origin: 'master', requestValues: request.values ?? [], values: request.values ?? [],
    success: true, exceptionCode: null, message: null, createdAt: Date.now(), durationMs: 3,
  };
}
