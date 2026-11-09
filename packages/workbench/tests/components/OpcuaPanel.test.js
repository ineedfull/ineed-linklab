import { mount, flushPromises } from '@vue/test-utils';
import { test, expect, vi } from 'vitest';
import OpcuaPanel from '../../src/components/OpcuaPanel.vue';
import { reactive } from 'vue';
import { createOpcuaWorkbench } from '../../src/model/opcuaWorkbench.js';
test('bound endpoint preserves controller ownership and removes global profile switching', async () => {
  const f = fixture(); const controller = createOpcuaWorkbench(f.runtime, { reactive });
  const dispose = vi.spyOn(controller, 'dispose');
  const w = mount(OpcuaPanel, { props: { runtime: f.runtime, controller, endpoint: { id: 'protocol:opcua:a', name: '节点 A', transport: 'opcua-client' } } });
  await flushPromises();
  expect(f.execute).not.toHaveBeenCalled();
  expect(w.text()).not.toContain('已保存连接');
  expect(w.text()).not.toContain('删除配置');
  expect(w.text()).toContain('节点 A');
  w.unmount(); expect(dispose).not.toHaveBeenCalled();
  await controller.dispose();
});
function fixture() {
  let listener;
  const execute = vi.fn(async r => {
    if (r.action === 'profiles') return { profiles: [] };
    if (r.action === 'connect') return { sessionId: 's1' };
    if (r.action === 'browse') return { nodes: [{ nodeId: 'ns=1;s=A', displayName: '温度', nodeClass: 'Variable' }] };
    if (r.action === 'read') return { values: [{ nodeId: 'ns=1;s=A', dataType: 'Int64', arrayType: 'Scalar', value: '9223372036854775807', statusCode: 'Good', sourceTimestamp: new Date(2026, 9, 21, 15, 0, 0, 7).toISOString(), serverTimestamp: null }] };
    if (r.action === 'write') return { statusCode: 'Good' };
    if (r.action === 'certificates') return { certificates: [{ fingerprint: 'abc', subject: 'Test server', validFrom: new Date(2026, 9, 21, 15, 0, 0, 7).toISOString(), validTo: null, trusted: false }] };
    return {};
  });
  return { execute, runtime: { opcua: { execute, onEvent: fn => { listener = fn; return vi.fn(); } } }, event: e => listener(e) };
}
async function click(w, text) { const b = w.findAll('button').find(b => b.text() === text); expect(b).toBeTruthy(); await b.trigger('click'); await flushPromises(); }
test('browsing or filtering away selected nodes never leaves invisible read or monitor targets', async () => {
  const f = fixture(); const controller = createOpcuaWorkbench(f.runtime, { reactive });
  const w = mount(OpcuaPanel, { props: { runtime: f.runtime, controller, endpoint: { name: '节点' } } });
  try {
    await click(w, '连接'); await click(w, '节点与监视'); await click(w, '浏览');
    await w.get('[aria-label="选择 温度"]').setValue(true);
    await w.get('input[type="search"]').setValue('没有匹配');
    expect(w.findAll('button').find(b => b.text().startsWith('监视所选')).element.disabled).toBe(true);
    await w.get('input[type="search"]').setValue('');
    expect(w.get('[aria-label="选择 温度"]').element.checked).toBe(false);
    await w.get('[aria-label="选择 温度"]').setValue(true);
    f.execute.mockImplementationOnce(async () => ({ nodes: [{ nodeId: 'ns=1;s=B', displayName: '压力', nodeClass: 'Variable' }] }));
    await click(w, '展开');
    expect(w.findAll('button').find(b => b.text().startsWith('监视所选')).element.disabled).toBe(true);
    await w.get('[aria-label="选择 压力"]').setValue(true);
    await click(w, '监视所选（1/100）');
    expect(f.execute.mock.calls.find(([r]) => r.action === 'subscribe')[0].nodeIds).toEqual(['ns=1;s=B']);
  } finally { w.unmount(); await controller.dispose(); }
});
test('opens without network, reads lossless values and requires explicit write confirmation', async () => {
  const f = fixture(); const w = mount(OpcuaPanel, { props: { runtime: f.runtime } }); await flushPromises();
  expect(f.execute.mock.calls.map(([r]) => r.action)).toEqual(['profiles']);
  await click(w, '连接'); await click(w, '节点与监视'); await click(w, '浏览'); await click(w, '读取');
  expect(w.text()).toContain('9223372036854775807');
  expect(w.findAll('time').map(t => t.text())).toEqual(['2026-10-21 15:00:00.007', '--']);
  await click(w, '准备写入');
  expect(w.find('[data-testid="opcua-write"]').attributes('disabled')).toBeDefined();
  await w.find('[name="write-confirm"]').setValue(true);
  await w.find('form').trigger('submit'); await flushPromises();
  expect(f.execute.mock.calls.find(([r]) => r.action === 'write')[0].value).toBe('9223372036854775807');
  w.unmount(); await flushPromises();
  expect(f.execute.mock.calls.at(-1)[0].action).toBe('disconnect');
});
test('certificate trust requires confirmation and discovery errors remain visible', async () => {
  const f = fixture(); const w = mount(OpcuaPanel, { props: { runtime: f.runtime } }); await flushPromises();
  await click(w, '证书'); await click(w, '刷新证书');
  expect(w.text()).toContain('有效期：2026-10-21 15:00:00.007 至 --');
  expect(w.find('[data-testid="opcua-trust"]').attributes('disabled')).toBeDefined();
  await w.find('[name="trust-abc"]').setValue(true); await click(w, '信任此证书');
  expect(f.execute.mock.calls.some(([r]) => r.action === 'trust' && r.fingerprint === 'abc')).toBe(true);
  await click(w, '连接与安全'); f.execute.mockRejectedValueOnce(new Error('连接超时'));
  await click(w, '发现端点'); expect(w.find('[role="alert"]').text()).toContain('连接超时');
  w.unmount();
});
test('reconnecting endpoint keeps its connection configuration locked and exposes cancellation', async () => {
  const f = fixture(); const controller = createOpcuaWorkbench(f.runtime, { reactive });
  controller.state.status = 'reconnecting';
  const disconnect = vi.spyOn(controller, 'disconnect');
  const w = mount(OpcuaPanel, { props: { runtime: f.runtime, controller, endpoint: { name: '恢复中节点' } } });
  expect(w.find('input[placeholder="opc.tcp://127.0.0.1:4840"]').element.disabled).toBe(true);
  await click(w, '取消连接'); expect(disconnect).toHaveBeenCalledOnce();
  w.unmount(); await controller.dispose();
});
