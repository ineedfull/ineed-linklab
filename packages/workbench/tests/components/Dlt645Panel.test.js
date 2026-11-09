import { buildDlt645Frame, buildDlt645ReadRequest } from '@ineed-linklab/codecs/dlt645.js';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';

import Dlt645Panel from '../../src/components/Dlt645Panel.vue';

enableAutoUnmount(afterEach);
afterEach(() => vi.useRealTimers());

describe('Dlt645Panel', () => {
  test('sends a complete read frame and decodes the response into a business value', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true, value: { byteCount: 20 } }));
    const wrapper = mount(Dlt645Panel, {
      props: {
        endpoint: endpoint(), frames: [], running: true, sessionId: 'session-1',
        sendCommand, saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });

    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await flushPromises();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: 'meter-bus',
      bytes: buildDlt645ReadRequest({
        address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4,
      }),
      framing: 'dlt645',
      target: { endpointId: 'meter-bus', expectedSessionId: 'session-1' },
    }));
    expect(sendCommand.mock.calls[0][0]).not.toHaveProperty('format');

    const request = buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4,
    });
    const response = buildDlt645Frame({
      address: '123456789012', control: 0x91,
      data: [0x00, 0x01, 0x01, 0x02, 0x34, 0x22],
    });
    await wrapper.setProps({ frames: [
      frame('out', request, 1_700_000_000_000),
      frame('in', response, 1_700_000_000_010),
    ] });
    await flushPromises();

    expect(wrapper.get('.dlt645-value').text()).toContain('223.4 V');
    expect(wrapper.text()).toContain('正常');
    expect(wrapper.text()).toContain('34 22');

    await wrapper.findAll('.dlt645-tabs button')[2].trigger('click');
    expect(wrapper.findAll('.dlt645-transaction-list > button')).toHaveLength(1);
    const transactionFrames = wrapper.get('.dlt645-transaction-list__frames');
    expect(transactionFrames.text()).toContain('TX');
    expect(transactionFrames.text()).toContain('RX');
    expect(transactionFrames.text()).toContain('68 12 90 78 56 34 12 68');
    expect(transactionFrames.text()).not.toContain('123456789012');
    expect(wrapper.findAll('.dlt645-transaction-frame')).toHaveLength(2);
    expect(wrapper.findAll('.dlt645-transaction-frame__hex')[0].text())
      .toContain('68 12 90 78 56 34 12 68');
    expect(wrapper.findAll('.dlt645-transaction-frame__hex')[1].text())
      .toContain('68 12 90 78 56 34 12 68');
    expect(wrapper.findAll('.dlt645-transaction-segments > div').map((item) => item.text()))
      .toEqual(expect.arrayContaining([
        '唤醒符FE FE FE FE', '电表地址12 90 78 56 34 12',
        '控制码11', '校验和6B', '结束符16',
      ]));
    expect(wrapper.get('.dlt645-transaction-metadata').text()).toContain('往返耗时10 ms');
    const date = new Date(1_700_000_000_000);
    const pad = n => String(n).padStart(2, '0');
    expect(wrapper.findAll('time').some(t => t.text() === `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000`)).toBe(true);
    wrapper.unmount();
  });

  test('edits multiple meters and saves them inside the endpoint config', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true }));
    const wrapper = mount(Dlt645Panel, {
      props: {
        endpoint: endpoint(), frames: [], running: false, sessionId: null,
        sendCommand: vi.fn(), saveCommand,
      },
    });
    await wrapper.findAll('.dlt645-tabs button')[1].trigger('click');
    await wrapper.get('.dlt645-config__actions button:first-child').trigger('click');
    expect(wrapper.findAll('.dlt645-meter')).toHaveLength(2);

    await wrapper.get('.dlt645-config__actions button:last-child').trigger('click');
    await flushPromises();
    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      id: 'meter-bus',
      transport: 'dlt645-master',
      config: expect.objectContaining({ meters: expect.arrayContaining([
        expect.objectContaining({ address: '123456789012' }),
        expect.objectContaining({ address: '000000000002' }),
      ]) }),
    }));
  });

  test('groups live data by meter without repeating meter identity in every row', () => {
    const configuredEndpoint = endpoint();
    configuredEndpoint.config.meters[0].tasks.push({
      id: 'current-a', name: 'A 相电流', identifier: '02020100', unit: 'A',
      decimals: 3, byteLength: 3, pollIntervalMs: 5000, enabled: true,
    });
    configuredEndpoint.config.meters.push({
      id: 'meter-2', name: '车间分表', address: '000000000002', enabled: false,
      tasks: [{
        id: 'energy', name: '组合有功总电能', identifier: '00000000', unit: 'kWh',
        decimals: 2, byteLength: 4, pollIntervalMs: 10000, enabled: true,
      }],
    });
    const wrapper = mount(Dlt645Panel, {
      props: {
        endpoint: configuredEndpoint, frames: [], running: false, sessionId: null,
        sendCommand: vi.fn(), saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });

    expect(wrapper.findAll('.dlt645-live-group')).toHaveLength(2);
    expect(wrapper.findAll('.dlt645-live-group__address')).toHaveLength(2);
    expect(wrapper.findAll('.dlt645-live-table tbody tr')).toHaveLength(3);
    expect(wrapper.findAll('.dlt645-live-group__address')[0].text()).toContain('123456789012');
    expect(wrapper.findAll('.dlt645-live-table tbody tr')[0].text()).not.toContain('123456789012');
    expect(wrapper.findAll('.dlt645-live-group__header')[0].text()).toContain('等待 2');
    expect(wrapper.findAll('.dlt645-live-group__header')[1].text()).toContain('已停用');
  });

  test('shows a communication error beside its meter address without a global notice', async () => {
    const wrapper = mount(Dlt645Panel, {
      props: {
        endpoint: endpoint(), frames: [], running: true, sessionId: 'session-1',
        sendCommand: vi.fn(async () => ({
          ok: false, error: { message: '串口连接已断开' },
        })),
        saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });

    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('.dlt645-live-group__error').text()).toBe('通信异常：串口连接已断开');
    expect(wrapper.find('.dlt645-panel > .dlt645-notice').exists()).toBe(false);
    expect(wrapper.get('.dlt645-live-group__header').text()).toContain('异常 1');
    wrapper.unmount();
  });

  test('marks an unanswered request transaction as timed out', async () => {
    vi.useFakeTimers();
    const sendCommand = vi.fn(async () => ({ ok: true, value: { byteCount: 20 } }));
    const wrapper = mount(Dlt645Panel, {
      props: {
        endpoint: endpoint(), frames: [], running: true, sessionId: 'session-1',
        sendCommand, saveCommand: vi.fn(async () => ({ ok: true })),
      },
    });

    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await flushPromises();
    await wrapper.setProps({ frames: [
      frame('out', sendCommand.mock.calls[0][0].bytes, 1_700_000_000_000),
    ] });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1500);
    await wrapper.findAll('.dlt645-tabs button')[2].trigger('click');

    expect(wrapper.get('.dlt645-transaction-status').text()).toBe('响应超时');
    expect(wrapper.get('.dlt645-transaction-list > button').classes()).toContain('failed');
    expect(wrapper.get('.dlt645-transaction-list__frames').text()).toContain('响应超时');
    wrapper.unmount();
    vi.useRealTimers();
  });

  test.each([true, false])('ignores an old send completion after reconnect (ok=%s)', async (ok) => {
    vi.useFakeTimers();
    let completeOldSend;
    const sendCommand = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { completeOldSend = resolve; }))
      .mockResolvedValue({ ok: true });
    const wrapper = mountMaster({ sendCommand });
    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await wrapper.setProps({ running: false, sessionId: null });
    await wrapper.setProps({ running: true, sessionId: 'session-2' });
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(false);
    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await flushPromises();
    completeOldSend({ ok, error: { message: '旧会话发送失败' } });
    await flushPromises();
    expect(wrapper.get('.dlt645-live-group__error').text()).toBe('');
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(true);
    await wrapper.setProps({ frames: [{ ...voltageResponse(), sessionId: 'session-2' }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.get('.dlt645-value').text()).toContain('223.4 V');
    expect(wrapper.get('.dlt645-live-group__error').text()).toBe('');
  });

  test('drops partial bytes and pending reads when the session changes while running', async () => {
    const wrapper = mountMaster();
    const response = voltageResponse();
    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await flushPromises();
    await wrapper.setProps({ frames: [{ ...response, bytes: response.bytes.slice(0, 10) }] });
    await wrapper.setProps({ sessionId: 'session-2' });
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(false);
    await wrapper.setProps({ frames: [{
      ...response, sessionId: 'session-2', bytes: response.bytes.slice(10),
    }] });
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
    await wrapper.setProps({ frames: [{ ...response, sessionId: 'session-2' }] });
    expect(wrapper.get('.dlt645-value').text()).toContain('223.4 V');
  });

  test('recovers a fragmented response behind an incomplete false header in a corrupt frame', async () => {
    const wrapper = mountMaster();
    const response = voltageResponse();
    const damaged = new Uint8Array(32);
    damaged[0] = damaged[7] = 0x68;
    damaged[9] = 20;
    damaged.set([0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255], 10);
    await wrapper.setProps({ frames: [{ ...response, bytes: Uint8Array.of(...damaged, ...response.bytes.slice(0, -3)) }] });
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
    await wrapper.setProps({ frames: [{ ...response, bytes: response.bytes.slice(-3) }] });
    expect(wrapper.get('.dlt645-value').text()).toContain('223.4 V');
  });

  test('session replacement clears recovery state and preserves an ordinary incomplete response', async () => {
    const wrapper = mountMaster();
    const response = voltageResponse();
    const damaged = new Uint8Array(32);
    damaged[0] = damaged[7] = 0x68;
    damaged[9] = 20;
    damaged.set([0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255], 10);
    await wrapper.setProps({ frames: [{ ...response, bytes: Uint8Array.of(...damaged, ...response.bytes.slice(0, -3)) }] });
    await wrapper.setProps({ sessionId: 'session-2' });
    await wrapper.setProps({ frames: [{ ...response, sessionId: 'session-2', bytes: response.bytes.slice(-3) }] });
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
    await wrapper.setProps({ frames: [{ ...response, sessionId: 'session-2',
      bytes: Uint8Array.of(0x68, 0, 0, 0, 0, 0, 0, 0x68, 0x91, 255, ...response.bytes),
    }] });
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
  });

  test('ignores retained and newly arriving frames from another session', async () => {
    const wrapper = mountMaster({ sessionId: 'session-2', frames: [voltageResponse()] });
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
    await wrapper.setProps({ frames: [voltageResponse()] });
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
    await wrapper.findAll('.dlt645-tabs button')[2].trigger('click');
    expect(wrapper.findAll('.dlt645-transaction-list > button')).toHaveLength(0);
  });

  test.each([
    ['another meter', '000000000002', 0xd1],
    ['another function', '123456789012', 0xd2],
  ])('does not finish a read for an abnormal reply from %s', async (_name, address, control) => {
    const wrapper = mountMaster();
    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await flushPromises();
    await wrapper.setProps({ frames: [frame('in', buildDlt645Frame({ address, control, data: [2] }), Date.now())] });
    expect(wrapper.get('.dlt645-live-group__error').text()).toBe('');
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(true);
    await wrapper.setProps({ frames: [frame('in', buildDlt645Frame({
      address: '123456789012', control: 0xd1, data: [2],
    }), Date.now())] });
    expect(wrapper.get('.dlt645-live-group__error').text()).not.toBe('');
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(false);
  });

  test('does not decode another function as a read response', async () => {
    const wrapper = mountMaster();
    const response = frame('in', buildDlt645Frame({
      address: '123456789012', control: 0x92,
      data: [0x00, 0x01, 0x01, 0x02, 0x34, 0x22],
    }), Date.now());
    await wrapper.setProps({ frames: [response] });
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
  });

  test('does not install a request timeout after unmount', async () => {
    vi.useFakeTimers();
    let completeSend;
    const wrapper = mountMaster({ sendCommand: () => new Promise((resolve) => { completeSend = resolve; }) });
    await wrapper.get('button[title="单次抄读"]').trigger('click');
    wrapper.unmount();
    completeSend({ ok: true });
    await flushPromises();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['99', '1.5', ''])('does not read or decode with invalid draft decimals %j', async (decimals) => {
    const errors = [];
    const wrapper = mount(Dlt645Panel, {
      props: { endpoint: endpoint(), running: true, sessionId: 'session-1',
        sendCommand: vi.fn(async () => ({ ok: true })), saveCommand: vi.fn() },
      global: { config: { errorHandler: (error) => errors.push(error.message) } },
    });
    await wrapper.findAll('.dlt645-tabs button')[1].trigger('click');
    await wrapper.get('td[data-label="小数"] input').setValue(decimals);
    await wrapper.findAll('.dlt645-tabs button')[0].trigger('click');
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(true);
    await wrapper.setProps({ frames: [voltageResponse()] });
    expect(errors).toEqual([]);
    expect(wrapper.get('.dlt645-value').text()).toContain('--');
  });

  test('editing a task identifier does not let a different response finish its in-flight read', async () => {
    const wrapper = mountMaster();
    await wrapper.get('button[title="单次抄读"]').trigger('click');
    await flushPromises();
    await wrapper.findAll('.dlt645-tabs button')[1].trigger('click');
    await wrapper.get('td[data-label="DI"] input').setValue('02010200');
    await wrapper.findAll('.dlt645-tabs button')[0].trigger('click');
    await wrapper.setProps({ frames: [frame('in', buildDlt645Frame({
      address: '123456789012', control: 0x91, data: [0, 2, 1, 2, 0x34, 0x22],
    }), Date.now())] });
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(true);
  });

  test('blocks reads for an invalid draft and recovers when the address is corrected', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const wrapper = mountMaster({ sendCommand });
    await wrapper.findAll('.dlt645-tabs button')[1].trigger('click');
    await wrapper.get('.dlt645-meter header label:nth-child(2) input').setValue('bad');
    await wrapper.findAll('.dlt645-tabs button')[0].trigger('click');
    expect(wrapper.get('button[title="单次抄读"]').element.disabled).toBe(true);
    expect(wrapper.get('.dlt645-panel__summary button').element.disabled).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    await wrapper.findAll('.dlt645-tabs button')[1].trigger('click');
    await wrapper.get('.dlt645-meter header label:nth-child(2) input').setValue('123456789012');
    await wrapper.findAll('.dlt645-tabs button')[0].trigger('click');
    await wrapper.get('button[title="单次抄读"]').trigger('click');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  test('keeps edits made during an in-flight configuration save unsaved', async () => {
    let completeSave;
    const wrapper = mountMaster({ saveCommand: () => new Promise((resolve) => { completeSave = resolve; }) });
    await wrapper.findAll('.dlt645-tabs button')[1].trigger('click');
    const address = wrapper.get('.dlt645-meter header label:nth-child(2) input');
    await address.setValue('000000000001');
    await wrapper.get('.dlt645-config__actions button:last-child').trigger('click');
    await address.setValue('000000000002');
    completeSave({ ok: true });
    await flushPromises();
    expect(wrapper.get('.dlt645-config__actions button:last-child').element.disabled).toBe(false);
    expect(address.element.value).toBe('000000000002');
  });

  test('auto polling serializes tasks, respects the request gap, and stays stopped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_720_000_000_000);
    const configured = endpoint();
    configured.config.autoStart = true;
    configured.config.meters[0].tasks.push({
      ...configured.config.meters[0].tasks[0], id: 'voltage-b', name: 'B 相电压', identifier: '02010200',
    });
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const wrapper = mountMaster({ endpoint: configured, sendCommand });
    await vi.advanceTimersByTimeAsync(200);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ frames: [voltageResponse()] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect([...sendCommand.mock.calls[1][0].bytes].slice(14, 18)).toEqual([0x33, 0x35, 0x34, 0x35]);
    await wrapper.get('.dlt645-panel__summary button').trigger('click');
    await wrapper.setProps({ frames: [frame('in', buildDlt645Frame({
      address: '123456789012', control: 0x91, data: [0, 2, 1, 2, 0x34, 0x22],
    }), Date.now())] });
    await vi.advanceTimersByTimeAsync(6000);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('.dlt645-value')[1].text()).toContain('223.4');
  });
});

function mountMaster(props = {}) {
  return mount(Dlt645Panel, { props: {
    endpoint: endpoint(), frames: [], running: true, sessionId: 'session-1',
    sendCommand: vi.fn(async () => ({ ok: true })),
    saveCommand: vi.fn(async () => ({ ok: true })), ...props,
  } });
}

function voltageResponse() {
  return frame('in', buildDlt645Frame({
    address: '123456789012', control: 0x91,
    data: [0x00, 0x01, 0x01, 0x02, 0x34, 0x22],
  }), Date.now());
}

function endpoint() {
  return {
    id: 'meter-bus',
    name: '厂区电表',
    transport: 'dlt645-master',
    config: {
      path: '/dev/ttyUSB0', baudRate: 2400, dataBits: 8, parity: 'even',
      stopBits: 1, flowControl: 'none', timeoutMs: 1500,
      minRequestGapMs: 200, wakeUpBytes: 4, autoStart: false,
      meters: [{
        id: 'meter-1', name: '进线总表', address: '123456789012', enabled: true,
        tasks: [{
          id: 'voltage-a', name: 'A 相电压', identifier: '02010100', unit: 'V',
          decimals: 1, byteLength: 2, pollIntervalMs: 5000, enabled: true,
        }],
      }],
    },
  };
}

function frame(direction, bytes, createdAt) {
  return {
    endpointId: 'meter-bus', operationId: 'open-1', sessionId: 'session-1',
    direction, bytes, createdAt,
  };
}
