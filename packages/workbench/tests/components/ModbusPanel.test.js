import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';

import ModbusPanel from '../../src/components/ModbusPanel.vue';

describe('ModbusPanel', () => {
  test('master delegates to the multi-request workbench and releases its subscriptions', () => {
    const transactionUnsubscribe = vi.fn();
    const schedulerUnsubscribe = vi.fn();
    const runtime = modbusRuntime({ unsubscribe: transactionUnsubscribe });
    const scheduler = {
      getStatus: vi.fn(() => ({ active: false, groups: {}, records: [] })),
      subscribe: vi.fn(() => schedulerUnsubscribe),
      start: vi.fn(), stop: vi.fn(), runGroup: vi.fn(),
    };
    const wrapper = mount(ModbusPanel, {
      props: {
        endpoint: endpoint('master-1', 'modbus-tcp-master', { unitId: 2 }),
        runtime, running: true, sessionId: 'session-1', scheduler, saveCommand: vi.fn(),
      },
    });

    expect(wrapper.findAll('[aria-label="Modbus 主站视图"] button')).toHaveLength(6);
    expect(runtime.modbus.onTransactions).toHaveBeenCalledOnce();
    wrapper.unmount();
    expect(transactionUnsubscribe).toHaveBeenCalledOnce();
    expect(schedulerUnsubscribe).toHaveBeenCalledOnce();
  });

  test('slave presents configured business points first and writes encoded register values', async () => {
    let map = slaveMap();
    map.areas.holdingRegisters.values[10] = 256;
    const readMap = vi.fn(async () => structuredClone(map));
    const writeMap = vi.fn(async ({ address, values }) => {
      map.areas.holdingRegisters.values[address] = values[0];
      return structuredClone(map);
    });
    const wrapper = mount(ModbusPanel, {
      props: {
        endpoint: endpoint('slave-1', 'modbus-tcp-slave', {
          unitId: 1,
          dataAreas: map.areas,
          dataPoints: [{
            id: 'temperature', group: '温控', name: '出水温度', area: 'holdingRegisters',
            address: 10, dataType: 'int16', length: 1, byteOrder: 'big-endian',
            wordOrder: 'high-first', scale: 0.1, offset: 0, unit: '℃', access: 'read-write',
          }, {
            id: 'target', group: '诊断', name: '目标温度', area: 'inputRegisters',
            address: 11, dataType: 'uint16', length: 1, byteOrder: 'big-endian',
            wordOrder: 'high-first', scale: 1, offset: 0, unit: '℃', access: 'read-only',
          }],
        }),
        runtime: modbusRuntime({ readMap, writeMap }), running: true,
        saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });
    await flushPromises();

    expect(wrapper.findAll('.modbus-business-group')).toHaveLength(2);
    expect(wrapper.findAll('.modbus-business-group__header').map((item) => item.text()))
      .toEqual(expect.arrayContaining([expect.stringContaining('温控'), expect.stringContaining('诊断')]));
    expect(wrapper.get('.modbus-map-toolbar__title').text()).toContain('2 个分组 · 2 个数据点');
    expect(wrapper.get('.modbus-result-table--business').text()).toContain('出水温度');
    expect(wrapper.get('.modbus-point-context').text()).toContain('出水温度');
    expect(wrapper.get('.modbus-point-context').text()).toContain('地址 10');
    expect(wrapper.get('.modbus-point-context').text()).toContain('0x0100');
    expect(wrapper.get('.modbus-point-context').text()).toContain('01 00');
    expect(wrapper.get('.modbus-point-context').text()).toContain('AB · 标准字节序');
    await wrapper.findAll('.modbus-business-row')[1].trigger('click');
    expect(wrapper.get('.modbus-point-context').text()).toContain('目标温度');
    expect(wrapper.get('.modbus-point-context').text()).toContain('地址 11');

    const inputs = wrapper.findAll('.modbus-result-table--business .modbus-value-input');
    const input = inputs[0];
    expect(input.element.value).toBe('25.6');
    expect(inputs[1].attributes('disabled')).toBeDefined();
    const spaceEvent = new KeyboardEvent('keydown', {
      key: ' ', bubbles: true, cancelable: true,
    });
    input.element.dispatchEvent(spaceEvent);
    expect(spaceEvent.defaultPrevented).toBe(false);
    await input.setValue('30');
    await flushPromises();
    expect(writeMap).toHaveBeenCalledWith({
      endpointId: 'slave-1', area: 'holdingRegisters', address: 10, values: [300],
    });
  });

  test('slave shows every raw data area in one unpaged editable matrix', async () => {
    let map = slaveMap();
    const readMap = vi.fn(async () => structuredClone(map));
    const writeMap = vi.fn(async ({ address, values }) => {
      map.areas.holdingRegisters.values[address] = values[0];
      return structuredClone(map);
    });
    const saveCommand = vi.fn(async () => ({ ok: true }));
    const runtime = modbusRuntime({ readMap, writeMap });
    const wrapper = mount(ModbusPanel, {
      attachTo: document.body,
      props: {
        endpoint: endpoint('slave-1', 'modbus-tcp-slave', {
          unitId: 1,
          dataAreas: map.areas,
        }),
        runtime,
        running: true,
        saveCommand,
      },
    });
    await flushPromises();

    const drawerTrigger = wrapper.get('button[aria-label="查看完整数据区"]');
    drawerTrigger.element.focus();
    await drawerTrigger.trigger('click');
    await flushPromises();
    const drawer = wrapper.get('[aria-label="完整原始数据区"]');
    expect(drawer.attributes('aria-modal')).toBeUndefined();
    expect(document.activeElement).toBe(drawer.get('button[aria-label="关闭完整数据区"]').element);
    expect(drawer.findAll('.modbus-raw-area').map((area) => area.attributes('aria-label')))
      .toEqual(['线圈原始数据', '离散输入原始数据', '保持寄存器原始数据', '输入寄存器原始数据']);
    expect(drawer.findAll('.modbus-raw-cell')).toHaveLength(480);
    expect(drawer.find('.modbus-pagination').exists()).toBe(false);

    const holdingRegisters = drawer.get('[aria-label="保持寄存器原始数据"]');
    expect(holdingRegisters.text()).toContain('120 项');
    expect(holdingRegisters.text()).toContain('0x0077');
    await holdingRegisters.get('input[aria-label="保持寄存器 地址 50"]').setValue('77');
    await flushPromises();

    expect(writeMap).toHaveBeenCalledWith({
      endpointId: 'slave-1', area: 'holdingRegisters', address: 50, values: [77],
    });
    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      id: 'slave-1',
      config: expect.objectContaining({
        dataAreas: expect.objectContaining({
          holdingRegisters: expect.objectContaining({ values: expect.arrayContaining([77]) }),
        }),
      }),
    }));
    await drawer.trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('[aria-label="完整原始数据区"]').exists()).toBe(false);
    expect(document.activeElement).toBe(drawerTrigger.element);
    expect(wrapper.get('.modbus-result-table--business').isVisible()).toBe(true);
    wrapper.unmount();
  });

  test('slave monitor shows complete TCP ADUs and labels every frame segment', async () => {
    let receiveTransaction;
    const runtime = modbusRuntime({
      readMap: vi.fn(async () => slaveMap()),
      onTransactions: vi.fn((callback) => {
        receiveTransaction = callback;
        return () => {};
      }),
    });
    const wrapper = mount(ModbusPanel, {
      props: {
        endpoint: endpoint('slave-1', 'modbus-tcp-slave', { unitId: 1 }),
        runtime, running: true, saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });
    await flushPromises();

    receiveTransaction({
      endpointId: 'slave-1', sessionId: 'session-1', origin: 'slave',
      transport: 'modbus-tcp-slave', functionCode: 6, unitId: 1, address: 2, quantity: 1,
      requestValues: [22], values: [22], success: true, exceptionCode: null, message: null,
      requestFrame: [0x12, 0x34, 0, 0, 0, 6, 1, 6, 0, 2, 0, 0x16],
      responseFrame: [0x12, 0x34, 0, 0, 0, 6, 1, 6, 0, 2, 0, 0x16],
      createdAt: 1_700_000_000_000, durationMs: 1,
    });
    await flushPromises();

    const monitor = wrapper.get('.modbus-transactions');
    expect(monitor.text()).toContain('ADU HEX');
    expect(monitor.text()).toContain('TCP 无 CRC');
    expect(monitor.get('.modbus-command__wire code').text())
      .toBe('12 34 00 00 00 06 01 06 00 02 00 16');
    expect(monitor.findAll('.modbus-frame-segment').map((item) => item.text()))
      .toEqual(expect.arrayContaining([
        '事务 ID12 34', '协议 ID00 00', '长度00 06',
        '单元 ID01', '功能码06', '数据00 02 00 16',
      ]));
  });

  test('slave monitor keeps distinct transaction IDs and never exposes a fabricated fallback frame', async () => {
    let receiveTransaction;
    const wrapper = mount(ModbusPanel, {
      props: {
        endpoint: endpoint('slave-1', 'modbus-tcp-slave', { unitId: 1 }),
        runtime: modbusRuntime({
          readMap: vi.fn(async () => slaveMap()),
          onTransactions: vi.fn((callback) => {
            receiveTransaction = callback;
            return () => {};
          }),
        }),
        running: true,
        saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });
    await flushPromises();

    const base = {
      endpointId: 'slave-1', sessionId: 'session-1', origin: 'slave',
      transport: 'modbus-tcp-slave', functionCode: 6, unitId: 1, address: 2, quantity: 1,
      requestValues: [22], values: [22], success: true, exceptionCode: null, message: null,
      createdAt: 1_700_000_000_000, durationMs: 1,
    };
    receiveTransaction({
      ...base,
      requestFrame: [0, 1, 0, 0, 0, 6, 1, 6, 0, 2, 0, 22],
      responseFrame: [0, 1, 0, 0, 0, 6, 1, 6, 0, 2, 0, 22],
    });
    receiveTransaction({
      ...base,
      requestFrame: [0, 2, 0, 0, 0, 6, 1, 6, 0, 2, 0, 22],
      responseFrame: [0, 2, 0, 0, 0, 6, 1, 6, 0, 2, 0, 22],
    });
    receiveTransaction({ ...base, createdAt: base.createdAt + 1 });
    receiveTransaction({
      ...base,
      createdAt: base.createdAt + 2,
      success: false,
      message: '连接断开',
      requestFrame: [0, 3, 0, 0, 0, 6, 1, 6, 0, 2, 0, 22],
    });
    await flushPromises();

    expect(wrapper.findAll('.modbus-transactions article')).toHaveLength(4);
    expect(wrapper.text()).toContain('00 01 00 00 00 06 01 06 00 02 00 16');
    expect(wrapper.text()).toContain('00 02 00 00 00 06 01 06 00 02 00 16');
    expect(wrapper.text()).toContain('完整帧不可用');
    expect(wrapper.text()).toContain('TX 完整帧不可用');
    expect(wrapper.text()).not.toContain('RX06 00 02 00 16');
  });
});

function endpoint(id, transport, config) {
  return { id, name: id, transport, config };
}

function modbusRuntime(overrides = {}) {
  return {
    modbus: {
      execute: vi.fn(),
      readMap: vi.fn(),
      writeMap: vi.fn(),
      onTransactions: vi.fn(() => overrides.unsubscribe ?? (() => {})),
      ...overrides,
    },
  };
}

function slaveMap() {
  const words = Array.from({ length: 120 }, (_, index) => index);
  const bits = Array.from({ length: 120 }, () => false);
  return {
    endpointId: 'slave-1',
    unitId: 1,
    areas: {
      coils: { start: 0, count: 120, values: bits },
      discreteInputs: { start: 0, count: 120, values: [...bits] },
      holdingRegisters: { start: 0, count: 120, values: words },
      inputRegisters: { start: 0, count: 120, values: [...words] },
    },
  };
}
