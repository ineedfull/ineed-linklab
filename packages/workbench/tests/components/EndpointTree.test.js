import { mount } from '@vue/test-utils';
import { afterEach, expect, test } from 'vitest';

import EndpointTree from '../../src/components/EndpointTree.vue';

let wrapper;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

test('uses a scalable protocol selector and emits the selected filter', async () => {
  wrapper = mount(EndpointTree, {
    props: {
      endpoints: [],
      statuses: new Map(),
      operations: new Map(),
      reconnects: new Map(),
      peers: new Map(),
      counters: new Map(),
    },
  });

  const selector = wrapper.get('select[name="endpoint-filter"]');
  expect(selector.findAll('option').map((option) => [
    option.element.value,
    option.text(),
  ])).toEqual([
    ['all', '全部协议'],
    ['serial', '串口'],
    ['tcp', 'TCP'],
    ['websocket', 'WebSocket'],
    ['udp', 'UDP'],
    ['modbus', 'Modbus'],
    ['dlt645', 'DL/T 645'],
    ['opcua', 'OPC UA'],
    ['stomp', 'STOMP'],
  ]);
  expect(wrapper.find('.endpoint-tree__filters').exists()).toBe(false);

  await selector.setValue('modbus');
  expect(wrapper.emitted('filter')).toEqual([['modbus']]);
});

test('includes independent protocol endpoints in the existing searchable tree', async () => {
  wrapper = mount(EndpointTree, { props: {
    endpoints: [
      { id: 'protocol:opcua:a', name: '生产节点', transport: 'opcua-client', config: { endpointUrl: 'opc.tcp://localhost:4840' } },
      { id: 'protocol:stomp:b', name: '测试消息', transport: 'stomp-server', config: { listenHost: '127.0.0.1', listenPort: 61614, path: '/stomp' } },
    ], statuses: new Map(), operations: new Map(), reconnects: new Map(), peers: new Map(), counters: new Map(),
  } });
  expect(wrapper.findAll('h2').map(node => node.text())).toEqual(['OPC UA', 'STOMP']);
  await wrapper.get('[aria-label="搜索端点"]').setValue('生产');
  expect(wrapper.findAll('.endpoint-row')).toHaveLength(1);
  await wrapper.get('[aria-label="选择 生产节点"]').trigger('click');
  expect(wrapper.emitted('select-endpoint')).toEqual([['protocol:opcua:a']]);
});
