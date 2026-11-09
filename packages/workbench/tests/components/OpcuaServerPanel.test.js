import { mount, flushPromises } from '@vue/test-utils';
import { test, expect, vi } from 'vitest';
import { reactive } from 'vue';
import OpcuaServerPanel from '../../src/components/OpcuaServerPanel.vue';
import { createOpcuaSimulator } from '../../src/model/opcuaSimulator.js';
async function click(w, text) { await w.findAll('button').find(b => b.text() === text).trigger('click'); await flushPromises(); }
function fixture() {
  const execute = vi.fn(async r => {
    if (r.action === 'serverProfiles') return { profiles: [] };
    if (r.action === 'startServer') return { sessionId: 's', namespaceIndex: 7, endpointUrl: 'opc.tcp://127.0.0.1:4840/LinkLab', nodes: r.nodes.map(n => ({ id: n.id, nodeId: `ns=7;s=${n.id}` })) };
    if (r.action === 'serverSnapshot') return { values: [{ nodeId: 'ns=7;s=Temperature', value: 77, dataType: 'Double', arrayType: 'Scalar', statusCode: 'Good', sourceTimestamp: new Date(2026, 9, 22, 14, 5, 6, 7).toISOString() }] };
    return {};
  });
  const runtime = { opcua: { execute, onEvent: () => () => {} } };
  const controller = createOpcuaSimulator(runtime, { reactive, schedule: () => 1, cancel: () => {} });
  const w = mount(OpcuaServerPanel, { props: { runtime, controller, endpoint: { name: '测试服务端' } } });
  return { w, controller, execute };
}
test('server edits initial values, locks running structure and uses actual NodeIds/full timestamps', async () => {
  const { w, controller, execute } = fixture();
  try {
    expect(w.text()).toContain('None / 匿名');
    await w.find('[name="node-initial"]').setValue('29.5');
    await click(w, '启动');
    expect(execute.mock.calls.find(([r]) => r.action === 'startServer')[0].nodes[0].value).toBe(29.5);
    expect(w.find('[name="node-id"]').element.matches(':disabled')).toBe(true);
    expect(w.text()).toContain('ns=7;s=Temperature');
    expect(w.text()).toContain('2026-10-22 14:05:06.007');
    await w.find('[name="node-current"]').setValue('30.5'); await click(w, '更新当前值');
    expect(execute.mock.calls.find(([r]) => r.action === 'setServerValue')[0].value).toBe(30.5);
    expect(controller.state.nodes[0].value).toBe(29.5);
    await click(w, '停止'); expect(w.find('[name="node-id"]').element.matches(':disabled')).toBe(false);
  } finally { w.unmount(); await controller.dispose(); }
});
test('invalid initial value prevents startup and node changes preserve selected editor', async () => {
  const { w, controller, execute } = fixture();
  try {
    await w.find('[name="node-initial"]').setValue('no'); await click(w, '启动');
    expect(w.find('[role="alert"]').exists()).toBe(true);
    expect(execute.mock.calls.some(([r]) => r.action === 'startServer')).toBe(false);
    await w.find('[name="node-initial"]').setValue('25'); await click(w, '添加节点');
    expect(controller.state.nodes).toHaveLength(5);
    await w.find('[name="node-name"]').setValue('新增传感器');
    await click(w, '删除节点'); expect(controller.state.nodes).toHaveLength(4);
    await click(w, '载入示例'); expect(controller.state.nodes[0].value).toBe(23.5);
  } finally { w.unmount(); await controller.dispose(); }
});
