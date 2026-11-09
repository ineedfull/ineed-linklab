import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';

import ModbusRequestGroupDialog from '../../src/components/ModbusRequestGroupDialog.vue';

describe('ModbusRequestGroupDialog', () => {
  test('edits only group metadata and preserves nested requests', async () => {
    const source = group();
    const wrapper = mount(ModbusRequestGroupDialog, {
      attachTo: document.body,
      props: {
        open: true,
        group: source,
        masterConfig: { unitId: 1 },
        existingGroups: [source],
      },
    });

    expect(wrapper.find('[name="request-group-function"]').exists()).toBe(false);
    expect(wrapper.find('[name="request-group-address"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="新增数据点"]').exists()).toBe(false);
    await wrapper.get('input[name="request-group-name"]').setValue('锅炉房设备');
    await wrapper.get('textarea[name="request-group-description"]').setValue('一号锅炉控制器');
    await wrapper.get('input[name="request-group-unit-id"]').setValue('7');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('save')[0][0]).toEqual({
      ...source,
      name: '锅炉房设备',
      description: '一号锅炉控制器',
      unitId: 7,
    });
  });

  test('blocks a blank name and invalid Slave ID without emitting save', async () => {
    const wrapper = mount(ModbusRequestGroupDialog, {
      props: {
        open: true,
        group: group(),
        masterConfig: { unitId: 1 },
        existingGroups: [],
      },
    });

    await wrapper.get('input[name="request-group-name"]').setValue('');
    await wrapper.get('input[name="request-group-unit-id"]').setValue('248');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.text()).toContain('请输入请求组名称');
    expect(wrapper.text()).toContain('从站 ID 必须为 1 到 247');
    expect(wrapper.emitted('save')).toBeUndefined();
  });
});

function group() {
  return {
    id: 'group-1', name: '环境参数', description: '', enabled: true, order: 0, unitId: 1,
    requests: [{
      id: 'holding', name: '保持寄存器', enabled: true, order: 0,
      functionCode: 3, startAddress: 100, quantity: 10, intervalMs: 1000,
      timeoutMs: null, retryCount: null, retryIntervalMs: null, dataPoints: [],
    }],
  };
}


test.each(['', '2.5', 'NaN'])('rejects raw Slave ID draft %j and accepts a corrected legal ID', async (value) => {
  const wrapper = mount(ModbusRequestGroupDialog, { props: {
    open: true, group: group(), masterConfig: {}, existingGroups: [],
  } });
  try {
    await wrapper.get('[name="request-group-unit-id"]').setValue(value);
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')).toBeUndefined();
    expect(wrapper.text()).toContain('从站 ID 必须');
    await wrapper.get('[name="request-group-unit-id"]').setValue('247');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('save')[0][0].unitId).toBe(247);
  } finally { wrapper.unmount(); }
});
