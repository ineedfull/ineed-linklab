import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, test } from 'vitest';
import AcceptancePanel from '../../src/components/AcceptancePanel.vue';
import { createAcceptanceWorkspace } from '../../src/model/acceptanceWorkspace.js';
import { createAcceptanceRunner } from '../../src/model/acceptanceRunner.js';

const wrappers = [];
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()));
async function fixture(
  read = async () => ({
    actual: [9],
    quality: 'Good',
    evidence: { source: 'fresh' },
  }),
  stubTeleport = true,
) {
  let settings = {};
  let fail = false;
  const exports = [];
  const runtime = {
    settings: {
      getAll: async () => settings,
      saveAll: async (value) => {
        if (fail) throw Error('disk full');
        settings = value;
      },
    },
    opcua: {
      execute: async (request) => {
        exports.push(request);
        return { saved: true };
      },
    },
  };
  const target = {
    endpointId: 'm',
    name: 'Master',
    protocol: 'modbus',
    identity: '127.0.0.1:502',
    sessionId: 's',
  };
  const targets = {
    list: () => [target],
    captureTarget: () => target,
    isCurrent: () => true,
    read,
  };
  const runner = createAcceptanceRunner(targets);
  const workspace = createAcceptanceWorkspace(runtime, { runner });
  await workspace.load();
  const wrapper = mount(AcceptancePanel, {
    attachTo: document.body,
    props: { open: true, workspace, targets, runtime },
    global: { stubs: { Teleport: stubTeleport } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  const click = async (text) => {
    await wrapper
      .findAll('button')
      .find((b) => b.text() === text)
      .trigger('click');
    await flushPromises();
  };
  return {
    wrapper,
    workspace,
    exports,
    click,
    failSave: () => {
      fail = true;
    },
  };
}
test('executes actual edited unsaved draft and exports immutable report and plan', async () => {
  const f = await fixture();
  await f.wrapper
    .get('[name="acceptance-plan-name"]')
    .setValue('Factory check');
  await f.wrapper.get('[name="acceptance-address"]').setValue('12');
  await f.wrapper.get('[name="acceptance-expected"]').setValue('[9]');
  await f.wrapper.get('[name="acceptance-target"]').setValue('m');
  await f.click('执行检查');
  expect(f.workspace.state.reports[0].plan.name).toBe('Factory check');
  expect(f.workspace.state.reports[0].plan.checks[0].query.address).toBe(12);
  expect(f.wrapper.text()).toContain('通过');
  await f.click('导出 JSON');
  expect(JSON.parse(f.exports[0].content).status).toBe('passed');
  expect(f.exports[0].fileName).toBe('linklab-acceptance-report.json');
  await f.click('导出 Markdown');
  expect(f.exports[1].content).toContain('Factory check');
  await f.click('导出方案');
  expect(JSON.parse(f.exports[2].content).checks[0].query.address).toBe(12);
});
test('save failure keeps draft and blank numeric field fails instead of becoming zero', async () => {
  const f = await fixture();
  await f.wrapper.get('[name="acceptance-plan-name"]').setValue('Keep draft');
  f.failSave();
  await f.click('保存方案');
  expect(f.wrapper.get('[role="alert"]').text()).toContain('disk full');
  expect(f.wrapper.get('[name="acceptance-plan-name"]').element.value).toBe(
    'Keep draft',
  );
  await f.wrapper.get('[name="acceptance-address"]').setValue('');
  await f.wrapper.get('[name="acceptance-target"]').setValue('m');
  await f.click('执行检查');
  expect(f.wrapper.get('[role="alert"]').text()).toMatch(/必填|请输入|无效/);
  expect(f.workspace.state.reports).toHaveLength(0);
});
test('invalid scheme import preserves current draft and existing saved schemes', async () => {
  const f = await fixture();
  await f.click('保存方案');
  await f.wrapper.get('[name="acceptance-plan-import"]').setValue('{"bad":1}');
  await f.click('导入方案');
  expect(f.wrapper.find('[role="alert"]').exists()).toBe(true);
  expect(f.workspace.state.plans).toHaveLength(1);
});
test('stop finalizes in flight report and closing/reopening keeps stopped result', async () => {
  let resolve;
  const f = await fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.wrapper.get('[name="acceptance-target"]').setValue('m');
  await f.click('执行检查');
  await f.click('停止检查');
  expect(f.wrapper.text()).toContain('已停止');
  await f.wrapper.setProps({ open: false });
  await f.wrapper.setProps({ open: true });
  expect(f.wrapper.text()).toContain('已停止');
  resolve({ actual: [9], quality: 'Good' });
  await flushPromises();
  expect(f.workspace.state.reports[0].status).toBe('stopped');
});

test('execution and export keep keyboard focus inside the panel when their buttons disable', async () => {
  let finish;
  // Real Teleport preserves native element identity; the slot stub recreates nodes on update.
  const f = await fixture(() => new Promise(resolve => { finish = resolve; }), false);
  const target = document.querySelector('[name="acceptance-target"]');
  target.value = 'm';
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
  const button = name => [...document.querySelectorAll('.acceptance-panel button')].find(element => element.textContent.trim() === name);
  const close = () => document.querySelector('[aria-label="关闭验收检查"]');
  const execute = button('执行检查');
  expect(execute.disabled).toBe(false);
  execute.focus();
  expect(document.activeElement).toBe(execute);
  execute.click();
  await flushPromises();
  expect(document.activeElement).toBe(close());
  finish({ actual: [9], quality: 'Good' });
  await flushPromises();
  const exportButton = button('导出 JSON');
  exportButton.focus();
  exportButton.click();
  await flushPromises();
  expect(document.activeElement).toBe(close());
  close().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(f.wrapper.emitted('close')).toHaveLength(1);
});
