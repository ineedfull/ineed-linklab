import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as echarts from '../../src/model/trendChart.js';

import ModbusPointTrends from '../../src/components/ModbusPointTrends.vue';
import { formatClockTime, formatTimestamp } from '../../src/model/dateTime.js';

const chart = vi.hoisted(() => ({
  dispose: vi.fn(),
  resize: vi.fn(),
  setOption: vi.fn(),
}));

vi.mock('../../src/model/trendChart.js', () => ({
  init: vi.fn(() => chart),
}));

describe('ModbusPointTrends', () => {
  let chartBounds;

  beforeEach(() => {
    chart.dispose.mockClear();
    chart.resize.mockClear();
    chart.setOption.mockClear();
    vi.mocked(echarts.init).mockClear();
    chartBounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 220, height: 220, left: 0, right: 800, top: 0, width: 800,
      x: 0, y: 0, toJSON: () => ({}),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  test('chart axes, crosshair, zoom and tooltip use the common millisecond clock', async () => {
    const wrapper = mountTrends(runtimeStub({
      querySeries: vi.fn(async ({ from, to }) => ({ from, to, series: [numericSeries()] })),
    }));
    try {
      await flushPromises();
      const option = chart.setOption.mock.calls.at(-1)[0];
      const value = new Date(2026, 9, 22, 0, 0, 0, 7).getTime();
      expect(option.xAxis[0].axisLabel.formatter(value)).toBe(formatClockTime(value));
      expect(option.xAxis[0].axisPointer.label.formatter({ value })).toBe(formatTimestamp(value));
      expect(option.dataZoom[1].labelFormatter(value)).toBe(formatTimestamp(value));
      const tooltip = option.tooltip.formatter([{ axisValue: value, seriesName: '<设备>', value: [value, 23.5] }]);
      expect(tooltip).toContain(formatTimestamp(value));
      expect(tooltip).toContain('&lt;设备&gt;: 23.5');
    } finally { wrapper.unmount(); }
  });

  test('theme changes repaint canvas axes, legends and tooltip using workbench colors', async () => {
    const wrapper = mountTrends(runtimeStub({
      querySeries: vi.fn(async ({ from, to }) => ({ from, to, series: [numericSeries()] })),
    }));
    const previousTheme = document.documentElement.dataset.theme;
    try {
      await flushPromises();
      const element = wrapper.get('.modbus-trends-chart').element;
      element.style.setProperty('--text', '#e1e8f5');
      element.style.setProperty('--text-muted', '#afbdd2');
      element.style.setProperty('--line', '#465873');
      element.style.setProperty('--line-soft', '#36445a');
      element.style.setProperty('--surface', '#1e2838');
      document.documentElement.dataset.theme = 'dark';
      await flushPromises();
      const option = chart.setOption.mock.calls.at(-1)[0];
      expect(option.legend.textStyle.color).toBe('#e1e8f5');
      expect(option.xAxis[0].axisLabel.color).toBe('#afbdd2');
      expect(option.yAxis[0].splitLine.lineStyle.color).toBe('#36445a');
      expect(option.tooltip.backgroundColor).toBe('#1e2838');
    } finally {
      wrapper.unmount();
      if (previousTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previousTheme;
    }
  });

  test('does not register observers or query history after an immediate unmount', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const runtime = runtimeStub();
    const wrapper = mountTrends(runtime);
    wrapper.unmount();
    await flushPromises();
    expect(observe).not.toHaveBeenCalled();
    expect(runtime.modbusHistory.querySeries).not.toHaveBeenCalled();
    expect(runtime.modbusHistory.queryRows).not.toHaveBeenCalled();
  });

  test('refreshes canvas labels when the workbench font preference changes', async () => {
    const wrapper = mountTrends(runtimeStub());
    const previousClass = document.documentElement.className;
    try {
      await flushPromises();
      const element = wrapper.get('.modbus-trends-chart').element;
      element.style.setProperty('--font-size-control', '13px');
      document.documentElement.classList.add('large-font');
      await flushPromises();
      const option = chart.setOption.mock.calls.at(-1)[0];
      expect(option.textStyle.fontSize).toBe(13);
      expect(option.legend.textStyle.fontSize).toBe(13);
      expect(option.tooltip.textStyle.fontSize).toBe(13);
    } finally {
      wrapper.unmount();
      document.documentElement.className = previousClass;
    }
  });

  test('waits for a measurable chart container before initializing ECharts', async () => {
    let resize;
    chartBounds.mockReturnValue({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0,
      x: 0, y: 0, toJSON: () => ({}),
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const wrapper = mountTrends(runtimeStub());
    await flushPromises();

    expect(echarts.init).not.toHaveBeenCalled();
    resize([{ contentRect: { width: 640, height: 220 } }]);
    await flushPromises();
    expect(echarts.init).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  test('groups the point selector by request group and request and plots each value kind', async () => {
    const runtime = runtimeStub({
      querySeries: vi.fn(async ({ from, to }) => ({
        from,
        to,
        series: [numericSeries(), booleanSeries(), stringSeries()],
      })),
      queryRows: vi.fn(async ({ page, pageSize }) => ({ rows: [], total: 0, page, pageSize })),
    });
    const wrapper = mountTrends(runtime);
    await flushPromises();

    const tree = wrapper.get('[aria-label="历史数据点选择"]');
    expect(tree.text()).toContain('环境参数');
    expect(tree.text()).toContain('保持寄存器');
    expect(tree.text()).toContain('温度');
    expect(tree.text()).toContain('运行状态');
    expect(tree.text()).toContain('批次名称');
    expect(wrapper.findAll('.modbus-trends-point input:checked')).toHaveLength(3);

    const option = chart.setOption.mock.calls.at(-1)[0];
    expect(option.series.find(({ name }) => name === '温度')).toMatchObject({ type: 'line' });
    expect(option.series.find(({ name }) => name === '运行状态')).toMatchObject({
      type: 'line', step: 'end',
    });
    expect(wrapper.get('.modbus-trends-events').text()).toContain('批次 A');
    expect(wrapper.get('.modbus-trends-events').text()).toContain('批次 B');

    wrapper.unmount();
    expect(chart.dispose).toHaveBeenCalledOnce();
  });

  test('keeps composite point identities distinct when individual IDs contain colons', async () => {
    const wrapper = mountTrends(runtimeStub(), null, collisionConfig());
    await flushPromises();

    const first = wrapper.get('[aria-label="选择数据点 点 A"]');
    const second = wrapper.get('[aria-label="选择数据点 点 B"]');
    expect(first.element.checked).toBe(true);
    expect(second.element.checked).toBe(false);
    await second.setValue(true);
    await flushPromises();
    expect(wrapper.findAll('.modbus-trends-point input:checked')).toHaveLength(2);
  });

  test('refreshes the point catalog after same-endpoint config edits and preserves valid selections', async () => {
    const runtime = runtimeStub();
    const wrapper = mountTrends(runtime);
    await flushPromises();
    const changed = structuredClone(masterConfig());
    changed.requestGroups[0].requests[0].dataPoints = [
      { ...changed.requestGroups[0].requests[0].dataPoints[0], name: '出水温度' },
      { ...changed.requestGroups[0].requests[0].dataPoints[2] },
      point('pressure', '压力', 'float32', 'kPa', false),
    ];

    await wrapper.setProps({ config: changed });
    await flushPromises();

    expect(wrapper.text()).toContain('出水温度');
    expect(wrapper.text()).toContain('压力');
    expect(wrapper.text()).not.toContain('运行状态');
    expect(wrapper.findAll('.modbus-trends-point input:checked')).toHaveLength(2);
    expect(runtime.modbusHistory.querySeries).toHaveBeenCalledTimes(2);
  });

  test('shares range controls and presents summaries, quality reasons, and paged detail', async () => {
    const querySeries = vi.fn(async ({ from, to }) => ({
      from, to, series: [numericSeries(), booleanSeries(), stringSeries()],
    }));
    const queryRows = vi.fn(async ({ page, pageSize }) => ({
      rows: [historyRow()], total: 75, page, pageSize,
    }));
    const wrapper = mountTrends(runtimeStub({ querySeries, queryRows }));
    await flushPromises();

    await wrapper.get('[aria-label="最近 1 小时"]').trigger('click');
    await flushPromises();
    expect(querySeries.mock.calls.at(-1)[0].to - querySeries.mock.calls.at(-1)[0].from)
      .toBe(3_600_000);
    expect(wrapper.get('.modbus-trends-summary').text()).toContain('25.6');
    expect(wrapper.get('.modbus-trends-summary').text()).toContain('1 次异常');
    expect(wrapper.get('[title="设备响应超时"]').text()).toContain('通信异常');
    expect(wrapper.get('.modbus-trends-detail').text()).toContain('41 CC 00 00');
    expect(wrapper.get('.modbus-trends-pagination').text()).toContain('第 1 / 2 页');

    await wrapper.get('[aria-label="下一页历史明细"]').trigger('click');
    await flushPromises();
    expect(queryRows.mock.calls.at(-1)[0]).toMatchObject({ page: 2, pageSize: 50 });
  });

  test('escapes persisted quality reasons before rendering ECharts HTML tooltips', async () => {
    const unsafeReason = `<img src=x onerror="alert(1)"> & 'timeout'`;
    const series = numericSeries();
    series.samples[0].marker.reason = unsafeReason;
    const runtime = runtimeStub({
      querySeries: vi.fn(async ({ from, to }) => ({ from, to, series: [series] })),
    });
    const wrapper = mountTrends(runtime);
    await flushPromises();

    const option = chart.setOption.mock.calls.at(-1)[0];
    const formatter = option.series[0].markPoint.tooltip.formatter;
    expect(formatter({ data: option.series[0].markPoint.data[0] })).toBe(
      `通信异常<br>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;timeout&#39;`,
    );

    wrapper.unmount();
  });

  test('keeps selection on query failure and offers a working retry', async () => {
    const querySeries = vi.fn()
      .mockRejectedValueOnce(new Error('历史查询失败'))
      .mockResolvedValueOnce({ series: [], from: 1, to: 2 });
    const wrapper = mountTrends(runtimeStub({ querySeries }));
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('历史查询失败');
    expect(wrapper.findAll('.modbus-trends-point input:checked')).toHaveLength(3);
    await wrapper.get('[aria-label="重试趋势查询"]').trigger('click');
    await flushPromises();
    expect(querySeries).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('所选时间范围内暂无历史数据');
  });

  test('exports the active scope and clears only the confirmed endpoint, points, and range', async () => {
    const exportCsv = vi.fn(async () => ({ canceled: false, path: '/tmp/modbus.csv' }));
    const clear = vi.fn(async () => 8);
    const runtime = runtimeStub({ exportCsv, clear });
    const wrapper = mountTrends(runtime);
    await flushPromises();

    await wrapper.get('[aria-label="导出当前趋势数据 CSV"]').trigger('click');
    await flushPromises();
    expect(exportCsv).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('已导出');

    await wrapper.get('[aria-label="清除当前趋势数据"]').trigger('click');
    const confirmation = wrapper.get('[aria-label="清除 Modbus 数据点历史确认"]');
    expect(confirmation.text()).toContain('锅炉主站');
    expect(confirmation.text()).toContain('3 个数据点');
    expect(confirmation.text()).toContain('当前时间范围');
    expect(confirmation.text()).toContain('主站配置和数据点配置都会保留');
    expect(clear).not.toHaveBeenCalled();

    await wrapper.get('[aria-label="确认清除当前趋势数据"]').trigger('click');
    await flushPromises();
    expect(clear).toHaveBeenCalledOnce();
    expect(clear.mock.calls[0][0]).toMatchObject({
      endpointId: 'master-1',
      points: expect.arrayContaining([
        { requestGroupId: 'group-1', requestId: 'holding', pointId: 'temperature' },
      ]),
    });
    expect(wrapper.text()).toContain('已清除 8 条历史数据');
  });

  test('closes clear confirmation when a config edit removes every selected point', async () => {
    const clear = vi.fn(async () => 0);
    const wrapper = mountTrends(runtimeStub({ clear }));
    await flushPromises();

    await wrapper.get('[aria-label="清除当前趋势数据"]').trigger('click');
    expect(wrapper.find('[aria-label="清除 Modbus 数据点历史确认"]').exists()).toBe(true);

    const changed = structuredClone(masterConfig());
    changed.requestGroups[0].requests[0].dataPoints = [];
    await wrapper.setProps({ config: changed });
    await flushPromises();

    expect(wrapper.find('[aria-label="清除 Modbus 数据点历史确认"]').exists()).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });

  test('surfaces bounded collector loss without changing connection language', async () => {
    const wrapper = mountTrends(runtimeStub(), {
      pendingCount: 12,
      droppedCount: 3,
      failedBatchCount: 1,
      lastError: '磁盘忙',
    });
    await flushPromises();

    const status = wrapper.get('.modbus-trends-collector-status');
    expect(status.text()).toContain('待写入 12 条');
    expect(status.text()).toContain('丢弃 3 条');
    expect(status.text()).toContain('失败批次 1');
    expect(status.text()).toContain('磁盘忙');
    expect(status.text()).not.toContain('连接失败');
  });
});

function mountTrends(runtime, collectorStatus = null, config = masterConfig()) {
  return mount(ModbusPointTrends, {
    props: {
      endpoint: { id: 'master-1', name: '锅炉主站' },
      runtime,
      config,
      collectorStatus,
    },
  });
}

function runtimeStub(overrides = {}) {
  return {
    modbusHistory: {
      querySeries: vi.fn(async ({ from, to }) => ({ series: [], from, to })),
      queryRows: vi.fn(async ({ page, pageSize }) => ({ rows: [], total: 0, page, pageSize })),
      exportCsv: vi.fn(async () => ({ canceled: true })),
      clear: vi.fn(async () => 0),
      ...overrides,
    },
  };
}

function masterConfig() {
  return {
    requestGroups: [{
      id: 'group-1', name: '环境参数', order: 0,
      requests: [{
        id: 'holding', name: '保持寄存器', order: 0,
        dataPoints: [
          point('temperature', '温度', 'float32', '℃'),
          point('running', '运行状态', 'boolean', ''),
          point('batch', '批次名称', 'string', ''),
        ],
      }],
    }],
  };
}

function point(id, name, dataType, unit, saveHistory = true) {
  return {
    id, key: id, name, dataType, unit, saveHistory,
  };
}

function collisionConfig() {
  return {
    requestGroups: [{
      id: 'g:r', name: '组 A', order: 0,
      requests: [{
        id: 'q', name: '请求 A', order: 0,
        dataPoints: [{ ...point('p', '点 A', 'uint16', ''), saveHistory: true }],
      }],
    }, {
      id: 'g', name: '组 B', order: 1,
      requests: [{
        id: 'r:q', name: '请求 B', order: 0,
        dataPoints: [{ ...point('p', '点 B', 'uint16', ''), saveHistory: false }],
      }],
    }],
  };
}

function numericSeries() {
  return {
    requestGroupId: 'group-1', requestId: 'holding', pointId: 'temperature',
    pointKey: 'temperature', pointName: '温度', dataType: 'float32', unit: '℃',
    kind: 'numeric',
    samples: [{
      bucket: 0, firstAt: 100, firstValue: 24.1, lastAt: 200, lastValue: 25.6,
      minAt: 100, minValue: 24.1, maxAt: 200, maxValue: 25.6,
      goodCount: 2, abnormalCount: 1, worstQuality: 'bad-communication',
      marker: { createdAt: 150, quality: 'bad-communication', reason: '设备响应超时' },
    }],
    summary: {
      lastDisplayValue: '25.6', minimum: 24.1, maximum: 25.6,
      changeCount: 1, abnormalCount: 1, latestQuality: 'bad-communication',
    },
  };
}

function booleanSeries() {
  return {
    requestGroupId: 'group-1', requestId: 'holding', pointId: 'running',
    pointKey: 'running', pointName: '运行状态', dataType: 'boolean', unit: '',
    kind: 'boolean',
    samples: [
      { createdAt: 100, value: false, displayValue: '停止', quality: 'good', reason: null },
      { createdAt: 200, value: true, displayValue: '运行', quality: 'good', reason: null },
    ],
    summary: {
      lastDisplayValue: '运行', minimum: 0, maximum: 1,
      changeCount: 1, abnormalCount: 0, latestQuality: 'good',
    },
  };
}

function stringSeries() {
  return {
    requestGroupId: 'group-1', requestId: 'holding', pointId: 'batch',
    pointKey: 'batch', pointName: '批次名称', dataType: 'string', unit: '',
    kind: 'string',
    samples: [
      { createdAt: 100, value: 'A', displayValue: '批次 A', quality: 'good', reason: null },
      { createdAt: 200, value: 'B', displayValue: '批次 B', quality: 'good', reason: null },
    ],
    summary: {
      lastDisplayValue: '批次 B', minimum: null, maximum: null,
      changeCount: 1, abnormalCount: 0, latestQuality: 'good',
    },
  };
}

function historyRow() {
  return {
    id: 1, endpointId: 'master-1', requestGroupId: 'group-1', requestId: 'holding',
    pointId: 'temperature', pointKey: 'temperature', pointName: '温度',
    dataType: 'float32', unit: '℃', raw: [0x41cc, 0], value: 25.6,
    numericValue: 25.6, displayValue: '25.6', quality: 'bad-communication',
    reason: '设备响应超时', createdAt: 1_800_000_000_000,
  };
}
