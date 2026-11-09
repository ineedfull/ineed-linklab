import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { describe, expect, test, vi } from 'vitest';

import SendPanel from '../../src/components/SendPanel.vue';
import { createUnavailableRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import { createWorkbenchModel } from '../../src/model/createWorkbenchModel.js';

const PayloadEditorStub = defineComponent({
  props: {
    modelValue: { type: String, required: true },
    mode: { type: String, required: true },
    disabled: Boolean,
  },
  emits: ['update:modelValue'],
  template: '<textarea class="payload-stub" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

describe('SendPanel async behavior', () => {
  test.each([
    ['templates', 'length-prefix', 'cGluZw==', '0000000470696e67'],
    ['history', 'length-prefix', 'cGluZw==', '0000000470696e67'],
    ['templates', 'line', 'cGluZw0K', '70696e670d0a'],
    ['history', 'line', 'cGluZw0K', '70696e670d0a'],
  ])('actual %s load and resend preserves logical %s bytes', async (tab, framing, payloadBase64, hex) => {
    const library = createLibraryRuntime();
    const item = { id: 'item', endpointId: 'serial-1', name: 'Saved', format: 'text', framing,
      payloadBase64, target: { endpointId: 'serial-1' }, createdAt: 1, byteCount: 4 };
    library.template.list.mockResolvedValue([item]);
    library.sendHistory.query.mockResolvedValue({ rows: [item], total: 1, page: 1, pageSize: 20 });
    const runtime = Object.assign(createUnavailableRuntimeAdapter('test'), library);
    const wires = [];
    const records = [];
    runtime.transport.send = async (request) => { wires.push(request); return { sessionId: 's1' }; };
    runtime.sendHistory.record = async (record) => { records.push(record); return record; };
    const model = createWorkbenchModel(runtime);
    const wrapper = mount(SendPanel, { props: { ...sendProps('serial-1', model.commands.send, model.scheduledSender), runtime },
      global: { stubs: { PayloadEditor: PayloadEditorStub } } });
    await flushPromises();
    await wrapper.get('.send-panel__toolbar input[type="checkbox"]').setValue(true);
    await wrapper.get(`button[aria-label="${tab === 'templates' ? '发送模板' : '发送历史'}"]`).trigger('click');
    await flushPromises();
    await wrapper.get(`button[aria-label="${tab === 'templates' ? '载入模板 Saved' : '载入历史记录 item'}"]`).trigger('click');
    await flushPromises();
    expect(wires).toHaveLength(0);
    expect(wrapper.get('.send-panel__toolbar input[type="checkbox"]').element.checked).toBe(false);
    for (let index = 0; index < 2; index += 1) {
      await wrapper.get('.send-panel__footer .command-button').trigger('click');
      await flushPromises();
    }
    expect(wires.map(({ bytes }) => Buffer.from(bytes).toString('hex'))).toEqual([hex, hex]);
    expect(records.map((record) => record.payloadBase64)).toEqual([payloadBase64, payloadBase64]);
    expect(records.every((record) => record.format === 'text' && record.framing === framing)).toBe(true);
    wrapper.unmount();
    model.dispose();
  });

  test('prevents duplicate sends while pending and shows stable pending state', async () => {
    const gate = deferred();
    const sendCommand = vi.fn(() => gate.promise);
    const wrapper = await mountPanel(sendCommand);
    await wrapper.get('.payload-stub').setValue('ping');

    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(wrapper.get('.send-panel__footer .command-button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.send-panel__footer .command-button').text()).toContain('正在发送');

    gate.resolve({ ok: true, value: null });
    await flushPromises();
    expect(wrapper.get('.send-panel__footer .command-button').text()).toContain('发送');
  });

  test.each([
    ['result error', () => Promise.resolve({ ok: false, error: new Error('send rejected') })],
    ['thrown error', () => Promise.reject(new Error('send threw'))],
  ])('surfaces local %s', async (_label, command) => {
    const wrapper = await mountPanel(vi.fn(command));
    await wrapper.get('.payload-stub').setValue('ping');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toMatch(/send rejected|send threw/);
  });

  test('stale completion after payload change cannot overwrite current state', async () => {
    const gate = deferred();
    const wrapper = await mountPanel(vi.fn(() => gate.promise));
    await wrapper.get('.payload-stub').setValue('first');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await wrapper.get('.payload-stub').setValue('second');

    gate.resolve({ ok: false, error: new Error('old failure') });
    await flushPromises();

    expect(wrapper.text()).not.toContain('old failure');
    expect(wrapper.get('.send-panel__footer .command-button').attributes('disabled')).toBeUndefined();
  });

  test('completion after unmount is inert', async () => {
    const gate = deferred();
    const wrapper = await mountPanel(vi.fn(() => gate.promise));
    await wrapper.get('.payload-stub').setValue('pending');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    wrapper.unmount();

    gate.resolve({ ok: false, error: new Error('late failure') });
    await expect(gate.promise).resolves.toEqual({ ok: false, error: expect.any(Error) });
  });

  test('endpoint switch retires an unresolved send and late failure stays inert', async () => {
    const first = deferred();
    const sendCommand = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ok: true, value: null });
    const wrapper = await mountPanel(sendCommand);
    await wrapper.get('.payload-stub').setValue('endpoint-a');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');

    await wrapper.setProps(sendProps('serial-2', sendCommand));
    await wrapper.get('.payload-stub').setValue('endpoint-b');

    expect(wrapper.get('.send-panel__footer .command-button').attributes('disabled')).toBeUndefined();
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls[1][0].endpointId).toBe('serial-2');

    first.reject(new Error('late endpoint-a failure'));
    await flushPromises();
    expect(wrapper.text()).not.toContain('late endpoint-a failure');
    expect(wrapper.get('.send-panel__footer .command-button').attributes('disabled')).toBeUndefined();
  });

  test('default framing initializes the control and is included in send requests', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true, value: null }));
    const wrapper = mount(SendPanel, {
      props: { ...sendProps('serial-1', sendCommand), defaultFraming: 'length-prefix' },
      global: { stubs: { PayloadEditor: PayloadEditorStub } },
    });
    await flushPromises();
    expect(wrapper.get('select[name="framing"]').element.value).toBe('length-prefix');
    await wrapper.get('.payload-stub').setValue('ping');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ framing: 'length-prefix' }));
  });

  test('includes the editor format in send requests and shows a nonfatal history warning', async () => {
    const sendCommand = vi.fn(async () => ({
      ok: true,
      value: { historyPersisted: false, historyError: 'history unavailable' },
    }));
    const wrapper = await mountPanel(sendCommand);
    await wrapper.get('button[role="radio"]:nth-child(2)').trigger('click');
    await wrapper.get('.payload-stub').setValue('50 49 4E 47');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ format: 'hex' }));
    expect(wrapper.get('[role="status"]').text()).toContain('history unavailable');
  });

  test('opens templates and history from compact toolbar buttons', async () => {
    const wrapper = await mountPanel(vi.fn(async () => ({ ok: true, value: null })));

    await wrapper.get('button[aria-label="发送模板"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.send-library').exists()).toBe(true);
    expect(wrapper.get('.send-library').text()).toContain('模板');

    await wrapper.get('button[aria-label="发送历史"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.send-library').text()).toContain('历史');
  });

  test('loads a template into the editor without sending it automatically', async () => {
    const runtime = createLibraryRuntime();
    runtime.template.list.mockResolvedValue([{
      id: 'hex-template',
      endpointId: 'serial-1',
      name: 'PING bytes',
      format: 'hex',
      framing: 'line',
      target: { endpointId: 'serial-1' },
      payloadBase64: 'UElORw==',
      createdAt: 10,
      updatedAt: 20,
    }]);
    const sendCommand = vi.fn(async () => ({ ok: true, value: null }));
    const wrapper = mount(SendPanel, {
      props: { ...sendProps('serial-1', sendCommand), runtime },
      global: { stubs: { PayloadEditor: PayloadEditorStub } },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="发送模板"]').trigger('click');
    await flushPromises();
    await wrapper.get('button[aria-label="载入模板 PING bytes"]').trigger('click');
    await nextTick();

    expect(sendCommand).not.toHaveBeenCalled();
    expect(wrapper.get('.payload-stub').element.value).toBe('50 49 4E 47');
    expect(wrapper.get('button[role="radio"][aria-checked="true"]').text()).toBe('HEX');
    expect(wrapper.get('select[name="framing"]').element.value).toBe('line');

    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();
    expect([...sendCommand.mock.calls[0][0].bytes]).toEqual([80, 73, 78, 71]);
  });

  test('UDP server send controls follow the active endpoint default target', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true, value: null }));
    const endpointId = 'udp-server-1';
    const endpoint = {
      id: endpointId,
      name: 'UDP Server',
      transport: 'udp-server',
      config: { bindHost: '0.0.0.0', bindPort: 9000 },
    };
    const wrapper = mount(SendPanel, {
      props: {
        ...sendProps(endpointId, sendCommand),
        endpoint,
        statusEvent: {
          endpointId,
          operationId: `${endpointId}-op`,
          sessionId: `${endpointId}-session`,
          status: 'listening',
        },
      },
      global: { stubs: { PayloadEditor: PayloadEditorStub } },
    });
    await flushPromises();
    await wrapper.get('.payload-stub').setValue('ping');

    expect(wrapper.find('select[name="framing"]').exists()).toBe(false);
    expect(wrapper.get('.send-panel__toolbar').text()).toContain('数据报');

    const sendButton = wrapper.get('.send-panel__footer .command-button');
    expect(sendButton.attributes('disabled')).toBeDefined();
    expect(wrapper.get('.send-panel__footer').text())
      .toContain('UDP 服务端未配置有效的默认发送目标');

    await wrapper.setProps({
      endpoint: {
        ...endpoint,
        config: { ...endpoint.config, targetHost: '127.0.0.1', targetPort: 9001 },
      },
    });
    await nextTick();

    expect(sendButton.attributes('disabled')).toBeUndefined();
    expect(wrapper.get('.send-panel__footer').text())
      .not.toContain('UDP 服务端未配置有效的默认发送目标');
    await sendButton.trigger('click');
    await flushPromises();
    const request = sendCommand.mock.calls[0][0];
    expect(request.endpointId).toBe(endpointId);
    expect([...request.bytes]).toEqual([112, 105, 110, 103]);
    expect(request.framing).toBe('datagram');
    expect(request).not.toHaveProperty('targetHost');
    expect(request).not.toHaveProperty('targetPort');
  });

  test('UDP server can target one discovered peer or broadcast to all peers', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true, value: null }));
    const endpointId = 'udp-server-peers';
    const wrapper = mount(SendPanel, {
      props: {
        ...sendProps(endpointId, sendCommand),
        endpoint: {
          id: endpointId,
          name: 'UDP Server Peers',
          transport: 'udp-server',
          config: { bindHost: '0.0.0.0', bindPort: 9000 },
        },
        statusEvent: {
          endpointId,
          operationId: `${endpointId}-op`,
          sessionId: `${endpointId}-session`,
          status: 'listening',
        },
        peers: [
          { id: 'udp-peer-a', remoteAddress: '127.0.0.1:51001' },
          { id: 'udp-peer-b', remoteAddress: '127.0.0.1:51002' },
        ],
        activePeerId: 'udp-peer-b',
      },
      global: { stubs: { PayloadEditor: PayloadEditorStub } },
    });
    await flushPromises();
    await wrapper.get('.payload-stub').setValue('ping');

    const target = wrapper.get('select[aria-label="发送目标"]');
    expect(target.element.value).toBe('udp-peer-b');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();
    expect(sendCommand.mock.calls[0][0].target).toEqual({ peerId: 'udp-peer-b' });

    await target.setValue('all');
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();
    expect(sendCommand.mock.calls[1][0].target).toEqual({ broadcast: true });
  });

  test('selecting a UDP peer overrides the configured default target', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true, value: null }));
    const endpointId = 'udp-server-default-and-peer';
    const wrapper = mount(SendPanel, {
      props: {
        ...sendProps(endpointId, sendCommand),
        endpoint: {
          id: endpointId,
          name: 'UDP Server Default And Peer',
          transport: 'udp-server',
          config: {
            bindHost: '0.0.0.0', bindPort: 9000, targetHost: '127.0.0.1', targetPort: 9001,
          },
        },
        statusEvent: {
          endpointId,
          operationId: `${endpointId}-op`,
          sessionId: `${endpointId}-session`,
          status: 'listening',
        },
      },
      global: { stubs: { PayloadEditor: PayloadEditorStub } },
    });
    await flushPromises();
    expect(wrapper.get('select[aria-label="发送目标"]').element.value).toBe('endpoint');

    await wrapper.setProps({
      peers: [{ id: 'udp-peer-selected', remoteAddress: '127.0.0.1:51001' }],
      activePeerId: 'udp-peer-selected',
    });
    await nextTick();

    expect(wrapper.get('select[aria-label="发送目标"]').element.value).toBe('udp-peer-selected');
  });

  test('TCP server selects multiple peers and reports partial send failures', async () => {
    const sendCommand = vi.fn(async () => ({
      ok: true,
      value: { peerCount: 2, successCount: 1, failureCount: 1 },
    }));
    const endpointId = 'tcp-server-multi';
    const wrapper = mount(SendPanel, {
      props: {
        ...sendProps(endpointId, sendCommand),
        endpoint: {
          id: endpointId,
          name: 'TCP Server Multi',
          transport: 'tcp-server',
          config: { listenHost: '127.0.0.1', listenPort: 9000 },
        },
        statusEvent: {
          endpointId,
          operationId: `${endpointId}-op`,
          sessionId: `${endpointId}-session`,
          status: 'listening',
        },
        peers: [
          { id: 'tcp-peer-a', remoteAddress: '127.0.0.1:51001' },
          { id: 'tcp-peer-b', remoteAddress: '127.0.0.1:51002' },
          { id: 'tcp-peer-c', remoteAddress: '127.0.0.1:51003' },
        ],
      },
      global: { stubs: { PayloadEditor: PayloadEditorStub } },
    });
    await flushPromises();
    await wrapper.get('.payload-stub').setValue('ping');

    const mode = wrapper.get('select[aria-label="TCP 发送模式"]');
    expect(mode.element.value).toBe('broadcast');
    await mode.setValue('selected');
    const peerTargets = wrapper.findAll('input[name="tcp-peer-target"]');
    await peerTargets[0].setValue(true);
    await peerTargets[2].setValue(true);
    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();

    expect(sendCommand.mock.calls[0][0].target).toEqual({
      type: 'peer', peerIds: ['tcp-peer-a', 'tcp-peer-c'],
    });
    expect(wrapper.get('[role="status"]').text()).toContain('已发送至 1/2 个远端');

    await wrapper.setProps({
      peers: [{ id: 'tcp-peer-b', remoteAddress: '127.0.0.1:51002' }],
    });
    await nextTick();

    expect(mode.element.value).toBe('selected');
    expect(wrapper.get('input[name="tcp-peer-target"]').element.checked).toBe(false);
    expect(wrapper.get('.send-panel__manual-send').attributes('disabled')).toBeDefined();
  });

  test('shows compact Chinese scheduled controls and disables them without a sendable session', async () => {
    const sender = createSenderStub();
    const wrapper = mount(SendPanel, {
      props: {
        ...sendProps('serial-1', vi.fn(), sender),
        operation: null,
        statusEvent: { status: 'closed', sessionId: null },
      },
      global: { stubs: { PayloadEditor: PayloadEditorStub } },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('定时发送');
    expect(wrapper.text()).toContain('间隔');
    expect(wrapper.text()).toContain('次数');
    expect(wrapper.get('input[name="scheduled-enabled"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[aria-label="开始定时发送"]').exists()).toBe(false);
    expect(wrapper.get('input[name="scheduled-interval"]').isVisible()).toBe(false);
    expect(wrapper.find('button[aria-label="停止定时发送"]').exists()).toBe(false);
  });

  test('manual and scheduled sends share the same encoded request builder', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true, value: null }));
    const sender = createSenderStub();
    const wrapper = await mountPanel(sendCommand, sender);
    await wrapper.findAll('[role="radio"]')[1].trigger('click');
    await wrapper.get('.payload-stub').setValue('50 49 4E 47');
    await wrapper.get('select[name="framing"]').setValue('length-prefix');

    await wrapper.get('.send-panel__footer .command-button').trigger('click');
    await flushPromises();
    await wrapper.get('input[name="scheduled-enabled"]').setValue(true);
    await wrapper.get('input[name="scheduled-interval"]').setValue('250');
    await wrapper.get('select[name="scheduled-count-mode"]').setValue('finite');
    await wrapper.get('input[name="scheduled-count"]').setValue('3');
    await findButton(wrapper, '开始定时发送').trigger('click');

    const manualRequest = sendCommand.mock.calls[0][0];
    const scheduled = sender.start.mock.calls[0][0];
    assertEquivalentRequests(scheduled.request, manualRequest);
    expect(scheduled).toMatchObject({
      endpointId: 'serial-1', sessionId: 'serial-1-session', intervalMs: 250, count: 3,
    });
  });

  test('starts and stops the shared sender with clear active state', async () => {
    const sender = createSenderStub();
    const wrapper = await mountPanel(vi.fn(async () => ({ ok: true, value: null })), sender);
    await wrapper.get('.payload-stub').setValue('ping');
    await wrapper.get('input[name="scheduled-enabled"]').setValue(true);
    await findButton(wrapper, '开始定时发送').trigger('click');
    await nextTick();

    expect(sender.start).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('已发送 0 次');
    expect(wrapper.get('input[name="scheduled-enabled"]').attributes('disabled')).toBeDefined();
    expect(sender.stop).not.toHaveBeenCalled();
    expect(wrapper.find('button[aria-label="停止定时发送"]').exists()).toBe(true);
    await wrapper.get('button[aria-label="停止定时发送"]').trigger('click');
    expect(sender.stop).toHaveBeenCalledWith('serial-1', 'serial-1-session');
  });

  test('endpoint switch keeps a background job and restores its active state when returning', async () => {
    const sender = createSenderStub();
    const sendCommand = vi.fn(async () => ({ ok: true, value: null }));
    const wrapper = await mountPanel(sendCommand, sender);
    await wrapper.get('.payload-stub').setValue('ping');
    await wrapper.get('input[name="scheduled-enabled"]').setValue(true);
    await findButton(wrapper, '开始定时发送').trigger('click');

    await wrapper.setProps(sendProps('serial-2', sendCommand, sender));
    expect(sender.stop).not.toHaveBeenCalled();
    expect(wrapper.find('button[aria-label="停止定时发送"]').exists()).toBe(false);

    await wrapper.setProps(sendProps('serial-1', sendCommand, sender));
    expect(wrapper.text()).toContain('已发送 0 次');
    await wrapper.get('button[aria-label="停止定时发送"]').trigger('click');
    expect(sender.stop).toHaveBeenCalledOnce();
    expect(sender.stop).toHaveBeenCalledWith('serial-1', 'serial-1-session');
  });

  test('unmount only unsubscribes and leaves the model-owned job running', async () => {
    const sender = createSenderStub();
    const wrapper = await mountPanel(vi.fn(async () => ({ ok: true, value: null })), sender);
    await wrapper.get('.payload-stub').setValue('ping');
    await wrapper.get('input[name="scheduled-enabled"]').setValue(true);
    await findButton(wrapper, '开始定时发送').trigger('click');

    wrapper.unmount();
    expect(sender.stop).not.toHaveBeenCalled();
    expect(sender.getStatus('serial-1').active).toBe(true);
  });
});

async function mountPanel(sendCommand, scheduledSender = createSenderStub()) {
  const wrapper = mount(SendPanel, {
    props: sendProps('serial-1', sendCommand, scheduledSender),
    global: { stubs: { PayloadEditor: PayloadEditorStub } },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

function sendProps(endpointId, sendCommand, scheduledSender = createSenderStub()) {
  return {
    endpoint: { id: endpointId, name: endpointId, transport: 'serial', config: {} },
    activeEndpointId: endpointId,
    operation: { endpointId, operationId: `${endpointId}-op`, sessionId: `${endpointId}-session` },
    statusEvent: {
      endpointId,
      operationId: `${endpointId}-op`,
      sessionId: `${endpointId}-session`,
      status: 'open',
    },
    sendCommand,
    scheduledSender,
    runtime: createLibraryRuntime(),
  };
}

function createLibraryRuntime() {
  return {
    template: {
      list: vi.fn(async () => []),
      save: vi.fn(async (value) => value),
      delete: vi.fn(async () => true),
    },
    sendHistory: {
      query: vi.fn(async () => ({ rows: [], total: 0, page: 1, pageSize: 20 })),
      delete: vi.fn(async () => true),
      clear: vi.fn(async () => 0),
    },
  };
}

function createSenderStub() {
  const statuses = new Map();
  const listeners = new Set();
  const idle = (endpointId) => ({
    active: false, endpointId, sessionId: null, sentCount: 0, reason: 'idle', error: null,
  });
  const sender = {
    getStatus(endpointId) { return statuses.get(endpointId) ?? idle(endpointId); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: vi.fn((options) => {
      sender.activate(options.endpointId, options.sessionId);
      return statuses.get(options.endpointId);
    }),
    stop: vi.fn((endpointId, sessionId) => {
      const current = statuses.get(endpointId);
      if (!current?.active || current.sessionId !== sessionId) return false;
      const status = { ...current, active: false, reason: 'stopped' };
      statuses.set(endpointId, status);
      for (const listener of listeners) listener(endpointId, status);
      return true;
    }),
    activate(endpointId, sessionId) {
      const status = {
        active: true, endpointId, sessionId, sentCount: 0, reason: 'running', error: null,
      };
      statuses.set(endpointId, status);
      for (const listener of listeners) listener(endpointId, status);
    },
  };
  return sender;
}

function findButton(wrapper, label) {
  return wrapper.findAll('button').find((button) => (
    button.attributes('aria-label') === label || button.text().includes(label)
  ));
}

function assertEquivalentRequests(actual, expected) {
  expect(actual.endpointId).toBe(expected.endpointId);
  expect([...actual.bytes]).toEqual([...expected.bytes]);
  expect(actual.target).toEqual(expected.target);
  expect(actual.framing).toBe(expected.framing);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
