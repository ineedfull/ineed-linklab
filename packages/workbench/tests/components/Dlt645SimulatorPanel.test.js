import { buildDlt645ReadRequest, parseDlt645Frame } from '@ineed-linklab/codecs/dlt645.js';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';

import { createDlt645SimulatorController } from '../../src/model/dlt645SimulatorController.js';
import Dlt645SimulatorPanel from '../../src/components/Dlt645SimulatorPanel.vue';

describe('Dlt645SimulatorPanel', () => {
  test('answers matching reads and returns a missing-data abnormal response', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true, value: { byteCount: 18 } }));
    const wrapper = mount(Dlt645SimulatorPanel, {
      props: {
        endpoint: endpoint(), frames: [], running: true, sessionId: 'session-1',
        sendCommand, saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });
    const voltageRequest = buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4,
    });
    const voltageFrame = frame(voltageRequest, 1_700_000_000_000);
    await wrapper.setProps({ frames: [voltageFrame] });
    await flushPromises();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][0]).not.toHaveProperty('format');
    const response = parseDlt645Frame(sendCommand.mock.calls[0][0].bytes);
    expect(response).toMatchObject({
      address: '123456789012', control: 0x91, dataIdentifier: '02010100', abnormal: false,
    });
    expect([...response.valueBytes]).toEqual([0x01, 0x23]);
    expect(wrapper.text()).toContain('请求 1');
    expect(wrapper.text()).toContain('响应 1');

    const responseFrame = {
      ...frame(sendCommand.mock.calls[0][0].bytes, 1_700_000_000_010),
      direction: 'out',
    };

    const missingRequest = buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '04000101', wakeUpBytes: 0,
    });
    await wrapper.setProps({ frames: [
      voltageFrame,
      responseFrame,
      frame(missingRequest, 1_700_000_000_100),
    ] });
    await flushPromises();

    const abnormal = parseDlt645Frame(sendCommand.mock.calls[1][0].bytes);
    expect(abnormal.control).toBe(0xd1);
    expect(abnormal.errorFlags).toEqual(['无请求数据']);
    expect(wrapper.text()).toContain('异常 1');

    await wrapper.findAll('.dlt645-simulator__tabs button')[2].trigger('click');
    expect(wrapper.findAll('.dlt645-transaction-list > button')).toHaveLength(2);
    const completed = wrapper.findAll('.dlt645-transaction-list > button')[1];
    expect(completed.get('.dlt645-transaction-list__frames').text()).toContain('RX');
    expect(completed.get('.dlt645-transaction-list__frames').text()).toContain('TX');
    const frameHex = completed.get('.dlt645-transaction-list__frames').text();
    expect(frameHex).toContain('68 12 90 78 56 34 12 68');
    expect(frameHex).not.toContain('123456789012');
  });

  test('mounting retained frames does not answer historical requests', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const request = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100' });
    const retained = frame(request, 1_700_000_000_000);
    const props = { endpoint: endpoint(), frames: [], running: true, sessionId: 'session-1', sendCommand, saveCommand: vi.fn() };
    const first = mount(Dlt645SimulatorPanel, { props });
    await first.setProps({ frames: [retained] });
    await flushPromises();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = mount(Dlt645SimulatorPanel, { props: { ...props, frames: [retained] } });
    await flushPromises();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  test('reopening cancels a delayed response from the previous session', async () => {
    vi.useFakeTimers();
    try {
      const configured = endpoint();
      configured.config.responseDelayMs = 1000;
      const sendCommand = vi.fn(async () => ({ ok: true }));
      const wrapper = mount(Dlt645SimulatorPanel, { props: {
        endpoint: configured, frames: [], running: true, sessionId: 'session-1', sendCommand, saveCommand: vi.fn(),
      } });
      const request = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100' });
      await wrapper.setProps({ frames: [frame(request, 1_700_000_000_000)] });
      await Promise.resolve();
      await wrapper.setProps({ running: false });
      await wrapper.setProps({ running: true, sessionId: 'session-2' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendCommand).not.toHaveBeenCalled();
      await wrapper.setProps({ frames: [{ ...frame(request, 1_700_000_002_000), sessionId: 'session-2', operationId: 'open-2' }] });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendCommand).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    } finally { vi.useRealTimers(); }
  });

  test('unmounting a standalone simulator cancels its delayed response', async () => {
    vi.useFakeTimers();
    try {
      const configured = endpoint(); configured.config.responseDelayMs = 1000;
      const sendCommand = vi.fn(async () => ({ ok: true }));
      const wrapper = mount(Dlt645SimulatorPanel, { props: { endpoint: configured, frames: [], running: true,
        sessionId: 'session-1', sendCommand, saveCommand: vi.fn() } });
      await wrapper.setProps({ frames: [frame(buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100' }), 1)] });
      await Promise.resolve();
      wrapper.unmount();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendCommand).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  test('shared diagnostics survive view changes while the controller keeps answering new requests', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const configured = endpoint();
    const controller = createDlt645SimulatorController({ endpointId: configured.id, send: sendCommand });
    controller.reconcile({ running: true, sessionId: 'session-1', config: configured.config });
    const request = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100' });
    const retained = frame(request, 1);
    controller.consume([retained]); await flushPromises();
    const props = { endpoint: configured, controller, frames: [retained], running: true,
      sessionId: 'session-1', sendCommand, saveCommand: vi.fn() };
    const first = mount(Dlt645SimulatorPanel, { props });
    expect(first.text()).toContain('响应 1'); first.unmount();
    controller.consume([frame(request, 2)]); await flushPromises();
    const second = mount(Dlt645SimulatorPanel, { props });
    expect(second.text()).toContain('响应 2');
    await second.findAll('.dlt645-simulator__tabs button')[2].trigger('click');
    expect(second.findAll('.dlt645-transaction-list > button')).toHaveLength(2);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    second.unmount(); controller.dispose();
  });

  test('edits a simulated business value and persists it in endpoint config', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true }));
    const wrapper = mount(Dlt645SimulatorPanel, {
      props: {
        endpoint: endpoint(), frames: [], running: false, sessionId: null,
        sendCommand: vi.fn(), saveCommand,
      },
    });

    await wrapper.get('.simulator-data-row input').setValue('231.6');
    await wrapper.get('.dlt645-simulator__toolbar button').trigger('click');
    await flushPromises();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      id: 'meter-simulator',
      transport: 'dlt645-slave',
      config: expect.objectContaining({
        meters: [expect.objectContaining({
          tasks: [expect.objectContaining({ value: 231.6 })],
        })],
      }),
    }));
  });

  test('groups data items by meter and shows its communication address once', () => {
    const configuredEndpoint = endpoint();
    configuredEndpoint.config.meters[0].tasks.push({
      id: 'current-a', name: 'A 相电流', identifier: '02020100', unit: 'A',
      decimals: 3, byteLength: 3, signed: false, value: 5.123, enabled: true,
    });
    const wrapper = mount(Dlt645SimulatorPanel, {
      props: {
        endpoint: configuredEndpoint, frames: [], running: false, sessionId: null,
        sendCommand: vi.fn(), saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });

    expect(wrapper.findAll('.simulator-data-group')).toHaveLength(1);
    expect(wrapper.findAll('.simulator-data-group__address')).toHaveLength(1);
    expect(wrapper.find('.simulator-data-group__address').text()).toContain('123456789012');
    expect(wrapper.findAll('.simulator-data-row')).toHaveLength(2);
    expect(wrapper.findAll('.simulator-data-row__identity')[0].text()).not.toContain('123456789012');
  });

  test('shows a response error beside its meter address without a global notice', async () => {
    const wrapper = mount(Dlt645SimulatorPanel, {
      props: {
        endpoint: endpoint(), frames: [], running: true, sessionId: 'session-1',
        sendCommand: vi.fn(async () => ({
          ok: false, error: { message: '串口连接已断开' },
        })),
        saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });
    const request = buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0,
    });

    await wrapper.setProps({ frames: [frame(request, 1_700_000_000_000)] });
    await flushPromises();

    expect(wrapper.get('.simulator-data-group__error').text()).toBe('通信异常：串口连接已断开');
    expect(wrapper.find('.dlt645-simulator > .dlt645-simulator__notice').exists()).toBe(false);
    expect(wrapper.text()).toContain('异常 1');

    await wrapper.findAll('.dlt645-simulator__tabs button')[2].trigger('click');
    expect(wrapper.get('.dlt645-transaction-status').text()).toBe('串口连接已断开');
    expect(wrapper.get('.dlt645-transaction-list > button').classes()).toContain('failed');
  });
});

function endpoint() {
  return {
    id: 'meter-simulator',
    name: '模拟电表',
    transport: 'dlt645-slave',
    config: {
      path: '/dev/tty.sim', baudRate: 2400, dataBits: 8, parity: 'even',
      stopBits: 1, flowControl: 'none', responseDelayMs: 0, wakeUpBytes: 0,
      meters: [{
        id: 'meter-1', name: '模拟总表', address: '123456789012', enabled: true,
        tasks: [{
          id: 'voltage-a', name: 'A 相电压', identifier: '02010100', unit: 'V',
          decimals: 1, byteLength: 2, signed: false, value: 230.1, enabled: true,
        }],
      }],
    },
  };
}

function frame(bytes, createdAt) {
  return {
    endpointId: 'meter-simulator', operationId: 'open-1', sessionId: 'session-1',
    direction: 'in', bytes, createdAt,
  };
}


test('simulator keeps a newer edit dirty after an older save succeeds and allows saving it', async () => {
  let completeSave;
  const snapshots = [];
  const saveCommand = async (saved) => {
    snapshots.push(saved.config.meters[0].tasks[0].value);
    if (snapshots.length === 1) return new Promise((resolve) => { completeSave = resolve; });
    return { ok: true };
  };
  const wrapper = mount(Dlt645SimulatorPanel, { props: {
    endpoint: endpoint(), sendCommand: async () => ({ ok: true }), saveCommand,
  } });
  try {
    const input = wrapper.get('.simulator-data-row input');
    const save = wrapper.get('.dlt645-simulator__toolbar button');
    await input.setValue('231.6');
    await save.trigger('click');
    await input.setValue('232.7');
    completeSave({ ok: true });
    await flushPromises();
    expect(save.element.disabled).toBe(false);
    await save.trigger('click');
    await flushPromises();
    expect(snapshots).toEqual([231.6, 232.7]);
    expect(save.element.disabled).toBe(true);
  } finally { wrapper.unmount(); }
});

test.each(['result', 'throw'])('simulator ignores stale %s failures after a session is replaced', async (failureKind) => {
  let completeSave;
  let rejectSave;
  const wrapper = mount(Dlt645SimulatorPanel, { props: {
    endpoint: endpoint(), sessionId: 'old', sendCommand: async () => ({ ok: true }),
    saveCommand: () => new Promise((resolve, reject) => { completeSave = resolve; rejectSave = reject; }),
  } });
  try {
    await wrapper.get('.simulator-data-row input').setValue('231.6');
    await wrapper.get('.dlt645-simulator__toolbar button').trigger('click');
    await wrapper.setProps({ sessionId: 'new' });
    if (failureKind === 'throw') rejectSave(new Error('旧保存失败'));
    else completeSave({ ok: false, error: { message: '旧保存失败' } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('旧保存失败');
    expect(wrapper.get('.dlt645-simulator__toolbar button').element.disabled).toBe(false);
  } finally { wrapper.unmount(); }
});

test('simulator old success cannot clear a new session edit or release its pending save', async () => {
  const completions = [];
  const snapshots = [];
  const wrapper = mount(Dlt645SimulatorPanel, { props: {
    endpoint: endpoint(), sessionId: 'old', sendCommand: async () => ({ ok: true }),
    saveCommand: (saved) => {
      snapshots.push(saved.config.meters[0].tasks[0].value);
      return new Promise((resolve) => completions.push(resolve));
    },
  } });
  try {
    const input = wrapper.get('.simulator-data-row input');
    const save = wrapper.get('.dlt645-simulator__toolbar button');
    await input.setValue('231.6');
    await save.trigger('click');
    await wrapper.setProps({ sessionId: 'new' });
    await input.setValue('232.7');
    expect(save.element.disabled).toBe(false);
    await save.trigger('click');
    completions[0]({ ok: true });
    await flushPromises();
    expect(save.element.disabled).toBe(true);
    completions[1]({ ok: true });
    await flushPromises();
    expect(snapshots).toEqual([231.6, 232.7]);
    expect(save.element.disabled).toBe(true);
  } finally { wrapper.unmount(); }
});

test('simulator rejects a blank value without saving and recovers after a valid edit', async () => {
  const snapshots = [];
  const wrapper = mount(Dlt645SimulatorPanel, { props: {
    endpoint: endpoint(), sendCommand: async () => ({ ok: true }),
    saveCommand: async (saved) => { snapshots.push(saved); return { ok: true }; },
  } });
  try {
    const input = wrapper.get('.simulator-data-row input');
    const save = wrapper.get('.dlt645-simulator__toolbar button');
    await input.setValue('');
    expect(save.element.disabled).toBe(true);
    expect(input.attributes('aria-invalid')).toBe('true');
    await save.trigger('click');
    expect(snapshots).toHaveLength(0);
    await input.setValue('231.6');
    expect(save.element.disabled).toBe(false);
    await save.trigger('click');
    await flushPromises();
    expect(snapshots[0].config.meters[0].tasks[0].value).toBe(231.6);
  } finally { wrapper.unmount(); }
});
