import { mount, flushPromises } from '@vue/test-utils';
import { test, expect } from 'vitest';
import DeviceTemplatesPanel from '../../src/components/DeviceTemplatesPanel.vue';
import { createAcceptanceWorkspace } from '../../src/model/acceptanceWorkspace.js';
import { createAcceptanceRunner } from '../../src/model/acceptanceRunner.js';

const endpoint = {
  id: 'original',
  name: 'Boiler',
  transport: 'modbus-tcp-master',
  config: {
    host: 'private',
    unitId: 1,
    requestGroups: [
      {
        id: 'g',
        name: 'G',
        unitId: 1,
        requests: [
          {
            id: 'r',
            name: 'R',
            functionCode: 3,
            startAddress: 10,
            quantity: 1,
            dataPoints: [
              {
                id: 'p',
                key: 't',
                name: 'Temperature',
                dataType: 'uint16',
                scale: 0.1,
                unit: '℃',
                minimum: 20,
                maximum: 30,
              },
            ],
          },
        ],
      },
    ],
  },
};
test('extract, revision, export/import preview and new site instance with saved engineering scheme', async () => {
  let stored = {};
  const created = [],
    exports = [];
  const runtime = {
    settings: {
      getAll: async () => stored,
      saveAll: async (v) => {
        stored = v;
      },
    },
    opcua: {
      execute: async (q) => {
        exports.push(q);
        return { saved: true };
      },
    },
  };
  const workspace = createAcceptanceWorkspace(runtime, {
    runner: createAcceptanceRunner({}),
  });
  await workspace.load();
  const wrapper = mount(DeviceTemplatesPanel, {
    props: {
      open: true,
      endpoints: [endpoint],
      workspace,
      runtime,
      createEndpoint: async (draft) => {
        created.push(draft);
        return { ok: true, value: draft };
      },
    },
    global: { stubs: { Teleport: true } },
  });
  const click = async (text) => {
    await wrapper
      .findAll('button')
      .find((b) => b.text() === text)
      .trigger('click');
    await flushPromises();
  };
  await wrapper.get('[name="model-source"]').setValue('original');
  await wrapper.get('[name="model-name"]').setValue('T-100');
  await click('提取点表');
  await click('保存新版本');
  expect(workspace.state.templates).toHaveLength(1);
  await click('导出模板');
  expect(exports[0].content).not.toContain('private');
  await wrapper.get('[name="model-site-name"]').setValue('Site A');
  await wrapper.get('[name="model-site-host"]').setValue('127.0.0.1');
  await wrapper.get('[name="model-site-port"]').setValue('1502');
  await click('新建端点和验收方案');
  expect(created[0].id).not.toBe('original');
  expect(workspace.state.plans[0].checks[0].engineering.point.scale).toBe(0.1);
  await wrapper.get('[name="model-import"]').setValue(exports[0].content);
  await click('预览导入');
  expect(workspace.state.templates).toHaveLength(1);
  expect(wrapper.text()).toContain('导入预览');
  await click('确认导入为新模板');
  expect(workspace.state.templates).toHaveLength(2);
  wrapper.unmount();
});
test('failed scheme persistence retains one created endpoint and retries only its scheme', async () => {
  let stored = {},
    fail = false;
  const created = [];
  const runtime = {
    settings: {
      getAll: async () => stored,
      saveAll: async (value) => {
        if (fail) throw Error('disk full');
        stored = value;
      },
    },
  };
  const workspace = createAcceptanceWorkspace(runtime, {
    runner: createAcceptanceRunner({}),
  });
  await workspace.load();
  const wrapper = mount(DeviceTemplatesPanel, {
    props: {
      open: true,
      endpoints: [endpoint],
      workspace,
      runtime,
      createEndpoint: async (draft) => {
        created.push(draft);
        return { ok: true, value: draft };
      },
    },
    global: { stubs: { Teleport: true } },
  });
  const click = async (text) => {
    await wrapper
      .findAll('button')
      .find((b) => b.text() === text)
      .trigger('click');
    await flushPromises();
  };
  await wrapper.get('[name="model-source"]').setValue('original');
  await click('提取点表');
  await click('保存新版本');
  fail = true;
  await click('新建端点和验收方案');
  expect(created).toHaveLength(1);
  expect(wrapper.text()).toContain('disk full');
  expect(
    wrapper
      .findAll('button')
      .find((b) => b.text() === '新建端点和验收方案')
      .attributes('disabled'),
  ).toBeDefined();
  fail = false;
  await click('重试保存验收方案');
  expect(created).toHaveLength(1);
  expect(JSON.parse(stored.acceptanceWorkspace).plans).toHaveLength(1);
  wrapper.unmount();
});
