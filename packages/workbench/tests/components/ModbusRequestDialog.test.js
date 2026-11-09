import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import { nextTick } from 'vue';

import ModbusRequestDialog from '../../src/components/ModbusRequestDialog.vue';

describe('ModbusRequestDialog', () => {
  test('focuses the request name on open and exposes a close action', async () => {
    const wrapper = mount(ModbusRequestDialog, {
      attachTo: document.body,
      props: {
        open: false,
        request: null,
        group: group(),
        masterConfig: {},
        existingRequests: [],
      },
    });

    await wrapper.setProps({ open: true });
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('input[name="modbus-request-name"]').element);
    await wrapper.get('[aria-label="关闭请求编辑器"]').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  test('edits a request range with multiple points and blocks out-of-range data', async () => {
    const wrapper = mountDialog(request());

    await wrapper.get('[aria-label="新增数据点"]').trigger('click');
    await wrapper.get('input[name="modbus-request-quantity"]').setValue('1');
    await wrapper.get('input[name="request-point-1-name"]').setValue('压力');
    await wrapper.get('input[name="request-point-1-key"]').setValue('pressure');
    await wrapper.get('select[name="request-point-1-type"]').setValue('float32');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.text()).toContain('数据点超出请求响应范围');
    expect(wrapper.emitted('save')).toBeUndefined();

    await wrapper.get('input[name="modbus-request-quantity"]').setValue('3');
    await wrapper.get('form').trigger('submit');
    const saved = wrapper.emitted('save')[0][0];
    expect(saved.quantity).toBe(3);
    expect(saved.dataPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '压力', key: 'pressure', dataType: 'float32', length: 2 }),
    ]));
  });

  test('supports point enable, ordering, and deletion controls', async () => {
    const wrapper = mountDialog(request({
      dataPoints: [point('temperature', '温度', 0), point('pressure', '压力', 1)],
    }));

    await wrapper.get('input[name="request-point-0-enabled"]').setValue(false);
    await wrapper.get('[aria-label="下移数据点 温度"]').trigger('click');
    expect(wrapper.findAll('input[name^="request-point-"][name$="-name"]')
      .map((input) => input.element.value)).toEqual(['压力', '温度']);
    await wrapper.get('[aria-label="删除数据点 压力"]').trigger('click');
    expect(wrapper.findAll('input[name^="request-point-"][name$="-name"]')).toHaveLength(1);
    expect(wrapper.get('input[name="request-point-0-enabled"]').element.checked).toBe(false);
  });

  test('copies a data point with fresh identities', async () => {
    const wrapper = mountDialog(request());

    await wrapper.get('[aria-label="复制数据点 温度"]').trigger('click');

    const names = wrapper.findAll('input[name^="request-point-"][name$="-name"]');
    const keys = wrapper.findAll('input[name^="request-point-"][name$="-key"]');
    expect(names.map((input) => input.element.value)).toEqual(['温度', '温度副本']);
    expect(keys.map((input) => input.element.value)).toEqual(['temperature', 'temperature_copy']);
  });

  test('saves independent request settings and nullable master overrides', async () => {
    const wrapper = mountDialog(null);

    await wrapper.get('input[name="modbus-request-name"]').setValue('状态线圈');
    await wrapper.get('select[name="modbus-request-function"]').setValue('1');
    await wrapper.get('input[name="modbus-request-address"]').setValue('20');
    await wrapper.get('input[name="modbus-request-quantity"]').setValue('8');
    await wrapper.get('input[name="modbus-request-interval"]').setValue('500');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')[0][0]).toEqual(expect.objectContaining({
      name: '状态线圈', enabled: true, functionCode: 1, startAddress: 20,
      quantity: 8, intervalMs: 500,
      timeoutMs: null, retryCount: null, retryIntervalMs: null,
    }));
  });

  test('new data points inherit the master byte and word order defaults', async () => {
    const wrapper = mountDialog(null, {
      byteOrder: 'little-endian', wordOrder: 'low-first',
    });

    await wrapper.get('[aria-label="新增数据点"]').trigger('click');
    await wrapper.get('input[name="modbus-request-name"]').setValue('设备标识');
    await wrapper.get('input[name="request-point-0-name"]').setValue('序列号');
    await wrapper.get('input[name="request-point-0-key"]').setValue('serial_number');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')[0][0].dataPoints[0]).toMatchObject({
      byteOrder: 'little-endian', wordOrder: 'low-first',
      saveHistory: false, historyMode: 'on-change',
    });
  });

  test('edits master point byte and word order through one width-aware data-order control', async () => {
    const wrapper = mountDialog(request({
      dataPoints: [{
        ...point('temperature', '温度', 0),
        dataType: 'float32', length: 2,
        byteOrder: 'big-endian', wordOrder: 'low-first',
      }],
    }));

    const order = wrapper.get('select[name="request-point-0-data-order"]');
    expect(order.element.value).toBe('CDAB');
    expect(order.findAll('option').map((option) => option.element.value))
      .toEqual(['ABCD', 'BADC', 'CDAB', 'DCBA']);
    await order.setValue('BADC');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')[0][0].dataPoints[0]).toMatchObject({
      byteOrder: 'little-endian', wordOrder: 'high-first',
    });
  });

  test('uses AB and BA for one-register master points and hides order for bit requests', async () => {
    const registerWrapper = mountDialog(request({
      dataPoints: [{
        ...point('speed', '速度', 0),
        byteOrder: 'little-endian', wordOrder: 'low-first',
      }],
    }));
    const registerOrder = registerWrapper.get('select[name="request-point-0-data-order"]');
    expect(registerOrder.element.value).toBe('BA');
    expect(registerOrder.findAll('option').map((option) => option.element.value))
      .toEqual(['AB', 'BA']);

    const bitWrapper = mountDialog(request({
      functionCode: 1,
      dataPoints: [{ ...point('running', '运行', 0), dataType: 'boolean' }],
    }));
    expect(bitWrapper.find('select[name="request-point-0-data-order"]').exists()).toBe(false);
  });

  test('history capture is off for new points and reveals a two-mode segmented control', async () => {
    const wrapper = mountDialog(null);

    await wrapper.get('[aria-label="新增数据点"]').trigger('click');
    const enabled = wrapper.get('input[name="request-point-0-save-history"]');
    expect(enabled.element.checked).toBe(false);
    expect(wrapper.find('[aria-label="历史采集模式"]').exists()).toBe(false);

    await enabled.setValue(true);
    const modes = wrapper.get('[aria-label="历史采集模式"]');
    expect(modes.findAll('button').map((button) => [
      button.attributes('data-mode'), button.text().trim(), button.attributes('aria-checked'),
    ])).toEqual([
      ['on-change', '变化时', 'true'],
      ['every-poll', '每次轮询', 'false'],
    ]);
    await modes.get('button[data-mode="every-poll"]').trigger('click');
    expect(modes.get('button[data-mode="every-poll"]').attributes('aria-checked')).toBe('true');
  });

  test('editing and saving a point round-trips enabled every-poll history', async () => {
    const wrapper = mountDialog(request({
      dataPoints: [{
        ...point('temperature', '温度', 0),
        saveHistory: true,
        historyMode: 'every-poll',
      }],
    }));

    expect(wrapper.get('input[name="request-point-0-save-history"]').element.checked).toBe(true);
    expect(wrapper.get('button[data-mode="every-poll"]').attributes('aria-checked')).toBe('true');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')[0][0].dataPoints[0]).toMatchObject({
      saveHistory: true,
      historyMode: 'every-poll',
    });
  });

  test('saves an unsafe UInt64 bound as an exact decimal string', async () => {
    const wrapper = mountDialog(request());

    await wrapper.get('select[name="request-point-0-type"]').setValue('uint64');
    const maximum = wrapper.findAll('label')
      .find((label) => label.text().includes('合理上限'))
      .get('input');
    await maximum.setValue('9007199254740995');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')[0][0].dataPoints[0].maximum)
      .toBe('9007199254740995');
  });
});

function mountDialog(source, masterOverrides = {}) {
  return mount(ModbusRequestDialog, {
    attachTo: document.body,
    props: {
      open: true,
      request: source,
      group: group(),
      masterConfig: {
        timeoutMs: 1000, retryCount: 2, retryIntervalMs: 200,
        ...masterOverrides,
      },
      existingRequests: source ? [source] : [],
    },
  });
}

function group() {
  return { id: 'group-1', name: '环境参数', description: '', enabled: true, order: 0, unitId: 1, requests: [] };
}

function request(overrides = {}) {
  return {
    id: 'holding', name: '保持寄存器', enabled: true, order: 0,
    functionCode: 3, startAddress: 100, quantity: 10, intervalMs: 1000,
    timeoutMs: null, retryCount: null, retryIntervalMs: null,
    dataPoints: [point('temperature', '温度', 0)],
    ...overrides,
  };
}

function point(id, name, offset) {
  return {
    id, key: id, name, enabled: true, offset, dataType: 'uint16', length: 1,
    byteOrder: 'big-endian', wordOrder: 'high-first', bitIndex: null,
    scale: 1, valueOffset: 0, unit: '', decimals: null,
    minimum: null, maximum: null, invalidPolicy: 'mark-bad', saveHistory: false,
    historyMode: 'on-change',
  };
}


test.each(['', '1.5', 'NaN'])('rejects a raw request address draft %j without saving and recovers when corrected', async (value) => {
  const wrapper = mount(ModbusRequestDialog, { props: {
    open: true, group: group(), masterConfig: {}, existingRequests: [],
  } });
  try {
    await wrapper.get('[name="modbus-request-name"]').setValue('测试读取');
    await wrapper.get('[name="modbus-request-address"]').setValue(value);
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')).toBeUndefined();
    expect(wrapper.text()).toContain('起始地址必须');
    await wrapper.get('[name="modbus-request-address"]').setValue('0');
    await wrapper.get('[name="modbus-request-quantity"]').setValue('2.5');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')).toBeUndefined();
    await wrapper.get('[name="modbus-request-quantity"]').setValue('125');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')[0][0]).toMatchObject({ startAddress: 0, quantity: 125 });
  } finally { wrapper.unmount(); }
});
