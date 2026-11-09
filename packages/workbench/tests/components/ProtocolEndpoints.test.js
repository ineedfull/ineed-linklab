import { flushPromises, shallowMount } from '@vue/test-utils';
import { reactive } from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import LinkLabShell from '../../src/layouts/LinkLabShell.vue';
import EndpointTree from '../../src/components/EndpointTree.vue';
import EndpointDialog from '../../src/components/EndpointDialog.vue';
import OpcuaPanel from '../../src/components/OpcuaPanel.vue';
import OpcuaServerPanel from '../../src/components/OpcuaServerPanel.vue';
import StompPanel from '../../src/components/StompPanel.vue';
import SettingsPanel from '../../src/components/SettingsPanel.vue';
import { createProtocolEndpointCatalog } from '../../src/model/protocolEndpointCatalog.js';
vi.mock('../../src/model/protocolEndpointCatalog.js', () => ({ createProtocolEndpointCatalog: vi.fn() }));
let wrapper, catalog, props;
beforeEach(() => {
  const endpoints = [
    { id: 'protocol:opcua:a', profileId: 'a', name: '节点 A', transport: 'opcua-client', config: { endpointUrl: 'opc.tcp://localhost:4840' } },
    { id: 'protocol:opcua:b', profileId: 'b', name: '节点 B', transport: 'opcua-client', config: { endpointUrl: 'opc.tcp://localhost:4841' } },
    { id: 'protocol:stomp:c', profileId: 'c', name: '消息 C', transport: 'stomp-server', config: { listenHost: '127.0.0.1', listenPort: 61614, path: '/stomp' } },
  ];
  const instances = reactive(new Map());
  catalog = { endpoints: reactive(endpoints), state: reactive({ loading: false, error: '', busy: '', instances }),
    initialize: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    has: id => endpoints.some(endpoint => endpoint.id === id),
    get: id => { if (!instances.has(id)) instances.set(id, { state: reactive({ status: 'disconnected', sessionId: null, busy: '', error: '', messages: [] }) }); return instances.get(id); },
    connect: vi.fn(async id => { catalog.get(id).state.status = 'connected'; return { ok: true }; }),
    disconnect: vi.fn(async () => ({ ok: true })),
    saveEndpoint: vi.fn(async () => ({ ok: true, value: endpoints[0] })),
    remove: vi.fn(async id => { endpoints.splice(endpoints.findIndex(endpoint => endpoint.id === id), 1); return { ok: true }; }),
  };
  createProtocolEndpointCatalog.mockReturnValue(catalog);
  const ordinary = { id: 'tcp', name: 'TCP', transport: 'tcp-client', config: { host: 'localhost', port: 9000 } };
  props = {
    model: { state: { endpoints: [ordinary], activeEndpointId: 'tcp', activePeerId: '', endpointFilter: 'all', frameFilters: { keyword: '' }, operations: new Map(), statuses: new Map(), reconnects: new Map(), peers: new Map(), endpointCounters: new Map() }, activeEndpoint: ordinary, filteredEndpoints: [ordinary], reconnectStateFor: () => null, peersForEndpoint: () => [], commandErrorForEndpoint: () => null, visibleFrames: [], visibleLogs: [], scheduledSender: {}, commands: { cancelReconnect: vi.fn() } },
    runtime: { settings: { getAll: async () => ({}), saveAll: async () => {} } }, preferences: { values: { autoScroll: true } }, savePreferences: vi.fn(), revision: 0, runtimeName: 'test', saveCommand: vi.fn(async () => ({ ok: true })), sendCommand: vi.fn(), workspaceImportedCommand: vi.fn(async () => {}),
  };
  wrapper = shallowMount(LinkLabShell, { props });
});
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks(); });
async function treeEvent(name, ...args) { wrapper.findComponent(EndpointTree).vm.$emit(name, ...args); await flushPromises(); }
test('merges all protocol profiles into the same tree and filters locally', async () => {
  await flushPromises(); expect(catalog.initialize).toHaveBeenCalledOnce();
  expect(wrapper.findComponent(EndpointTree).props('endpoints')).toHaveLength(4);
  expect(wrapper.find('[aria-label="打开 OPC UA 工作台"]').exists()).toBe(false);
  await treeEvent('filter', 'opcua');
  expect(wrapper.findComponent(EndpointTree).props('endpoints').map(row => row.id)).toEqual(['protocol:opcua:a', 'protocol:opcua:b']);
  expect(wrapper.emitted('endpoint-filter')).toBeUndefined();
});
test('switching independent endpoints preserves mounted panel instances and externally owned controllers', async () => {
  await treeEvent('select-endpoint', 'protocol:opcua:a');
  const first = wrapper.findComponent(OpcuaPanel); const instance = first.vm;
  expect(first.props('controller')).toBe(catalog.get('protocol:opcua:a'));
  await treeEvent('select-endpoint', 'protocol:stomp:c');
  expect(wrapper.findComponent(StompPanel).exists()).toBe(true);
  expect(wrapper.findComponent(StompPanel).props('visible')).toBe(true);
  expect(first.attributes('style')).toContain('display: none');
  await treeEvent('select-endpoint', 'protocol:opcua:a');
  expect(wrapper.findComponent(OpcuaPanel).vm).toBe(instance);
  expect(wrapper.findComponent(StompPanel).props('visible')).toBe(false);
  expect(catalog.disconnect).not.toHaveBeenCalled();
  expect(wrapper.emitted('select-endpoint')).toBeUndefined();
});
test('routes tree lifecycle and CRUD to catalog and retains ordinary routing', async () => {
  await treeEvent('open', 'protocol:opcua:a'); expect(catalog.connect).toHaveBeenCalledWith('protocol:opcua:a');
  await treeEvent('cancel', 'protocol:opcua:a'); expect(catalog.disconnect).toHaveBeenCalledWith('protocol:opcua:a');
  await treeEvent('edit', catalog.endpoints[0]); expect(props.model.commands.cancelReconnect).not.toHaveBeenCalled();
  expect(wrapper.findComponent(EndpointDialog).props('connectionLocked')).toBe(true);
  await wrapper.findComponent(EndpointDialog).props('saveCommand')(catalog.endpoints[0]);
  expect(catalog.saveEndpoint).toHaveBeenCalledOnce(); expect(props.saveCommand).not.toHaveBeenCalled();
  await treeEvent('delete', 'protocol:opcua:a'); expect(catalog.remove).toHaveBeenCalledWith('protocol:opcua:a');
  expect(wrapper.findAllComponents(OpcuaPanel)).toHaveLength(0);
  await treeEvent('open', 'tcp'); expect(wrapper.emitted('open-endpoint')).toEqual([['tcp']]);
});
test('failed protocol operations are visible and workspace import refreshes ownership', async () => {
  catalog.remove.mockResolvedValueOnce({ ok: false, error: { message: '无法删除' } });
  await treeEvent('delete', 'protocol:opcua:a'); expect(wrapper.text()).toContain('无法删除');
  await wrapper.findComponent(SettingsPanel).props('workspaceImportedCommand')();
  expect(props.workspaceImportedCommand).toHaveBeenCalledOnce();
  expect(catalog.dispose).toHaveBeenCalledOnce();
  expect(catalog.initialize).toHaveBeenCalledTimes(2);
});
test('tree connection failure remains visible before its panel has been visited', async () => {
  catalog.connect.mockImplementationOnce(async id => { catalog.get(id).state.error = '连接已被拒绝'; return false; });
  await treeEvent('open', 'protocol:opcua:a');
  expect(wrapper.text()).toContain('连接已被拒绝');
});
test('import unmounts owned panel views before the old catalog disposes its sessions', async () => {
  await treeEvent('select-endpoint', 'protocol:opcua:a');
  let finish;
  catalog.dispose.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const refresh = wrapper.findComponent(SettingsPanel).props('workspaceImportedCommand')();
  await flushPromises();
  expect(wrapper.findAllComponents(OpcuaPanel)).toHaveLength(0);
  finish(); await refresh;
});
test('import can recover its directory after an old native session fails to close', async () => {
  const failure = new Error('原生关闭失败');
  catalog.dispose.mockRejectedValueOnce(failure);
  const replacement = { ...catalog, initialize: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  createProtocolEndpointCatalog.mockReturnValueOnce(replacement);
  await expect(wrapper.findComponent(SettingsPanel).props('workspaceImportedCommand')()).rejects.toThrow('原生关闭失败');
  expect(replacement.initialize).toHaveBeenCalledOnce();
  expect(wrapper.text()).toContain('原生关闭失败');
});

test('ordinary imported IDs cannot collide with catalog keys or route into protocol lifecycle', async () => {
  const colliding = 'protocol:opcua:a';
  props.model.state.endpoints[0].id = colliding;
  await wrapper.setProps({ revision: 1 });
  const rows = wrapper.findComponent(EndpointTree).props('endpoints');
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  const ordinary = rows.find(row => row.transport === 'tcp-client');
  await treeEvent('open', ordinary.id);
  expect(catalog.connect).not.toHaveBeenCalled();
  expect(wrapper.emitted('open-endpoint')).toEqual([[colliding]]);
  await treeEvent('edit', ordinary);
  expect(wrapper.findComponent(EndpointDialog).props('endpoint').id).toBe(colliding);
  const draft = wrapper.findComponent(EndpointDialog).props('endpoint');
  await wrapper.findComponent(EndpointDialog).props('saveCommand')(draft);
  expect(props.saveCommand).toHaveBeenCalledWith(draft, undefined);
  expect(catalog.saveEndpoint).not.toHaveBeenCalled();
});


test('OPC UA server routes to its own retained simulator panel and uses protocol CRUD', async () => {
  const endpoint = { id: 'protocol:opcua-server:sim', profileId: 'sim', name: '模拟服务端', transport: 'opcua-server', config: { listenHost: '127.0.0.1', listenPort: 4840, path: '/LinkLab' } };
  catalog.endpoints.push(endpoint);
  await treeEvent('select-endpoint', endpoint.id);
  const panel = wrapper.findComponent(OpcuaServerPanel);
  expect(panel.exists()).toBe(true); expect(panel.props('controller')).toBe(catalog.get(endpoint.id));
  expect(wrapper.findComponent(StompPanel).exists()).toBe(false);
  await treeEvent('open', endpoint.id); await treeEvent('edit', endpoint);
  expect(wrapper.findComponent(EndpointDialog).props('connectionLocked')).toBe(true);
  await wrapper.findComponent(EndpointDialog).props('saveCommand')(endpoint);
  expect(catalog.saveEndpoint).toHaveBeenCalledWith(endpoint);
  await treeEvent('select-endpoint', 'protocol:opcua:a'); expect(panel.props('visible')).toBe(false);
});
