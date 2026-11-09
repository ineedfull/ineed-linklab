import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, test, vi } from 'vitest';

import EndpointDialog from '../../src/components/EndpointDialog.vue';
import FrameToolbar from '../../src/components/FrameToolbar.vue';
import SessionStatusBar from '../../src/components/SessionStatusBar.vue';
import LinkLabShell from '../../src/layouts/LinkLabShell.vue';

const wrappers = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('EndpointDialog modal behavior', () => {
  test('locks close, backdrop, Escape, and Cancel while saving', async () => {
    const gate = deferred();
    const wrapper = mountDialog({ saveCommand: vi.fn(() => gate.promise) });
    await submitDialog();

    expect(wrapper.props('saveCommand')).toHaveBeenCalledTimes(1);
    expect(button('关闭对话框').disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    backdrop().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('close')).toBeUndefined();

    gate.resolve({ ok: true, value: null });
    await flushPromises();
  });

  test('old save completion cannot close or mutate a newer dialog instance', async () => {
    const gate = deferred();
    const saveCommand = vi.fn(() => gate.promise);
    const wrapper = mountDialog({ saveCommand });
    await submitDialog();
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true, endpoint: tcpEndpoint('endpoint-b') });
    await nextTick();

    gate.resolve({ ok: false, error: new Error('old failure') });
    await flushPromises();

    expect(dialog()).not.toBeNull();
    expect(button('取消').disabled).toBe(false);
    expect(document.body.textContent).not.toContain('old failure');
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  test('focuses the name field for both new and existing endpoints', async () => {
    const wrapper = mountDialog({ open: false, endpoint: null });

    await wrapper.setProps({ open: true });
    await nextTick();
    const name = document.querySelector('input[name="endpoint-name"]');
    const transport = document.querySelector('select[name="endpoint-transport"]');
    expect(document.activeElement).toBe(name);
    expect(name.required).toBe(false);
    expect(transport.closest('label').classList.contains('endpoint-dialog__wide')).toBe(true);
    expect(transport.disabled).toBe(false);

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true, endpoint: tcpEndpoint('endpoint-a') });
    await nextTick();
    const editedName = document.querySelector('input[name="endpoint-name"]');
    expect(document.activeElement).toBe(editedName);
    expect(editedName.required).toBe(true);
    expect(document.querySelector('select[name="endpoint-transport"]').disabled).toBe(true);
  });

  test('traps Tab, closes on Escape, and restores prior focus', async () => {
    const prior = document.createElement('button');
    prior.textContent = 'Prior';
    document.body.append(prior);
    prior.focus();
    const wrapper = mountDialog({ open: false, saveCommand: vi.fn() });

    await wrapper.setProps({ open: true });
    await nextTick();

    const focusable = [...dialog().querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')];
    focusable.at(-1).focus();
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]);
    focusable[0].focus();
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(focusable.at(-1));

    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(prior);
  });
});

describe('EndpointDialog endpoint names', () => {
  test('shows an optional name field and generates a collision suffix when it is left blank', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({
      endpoint: null,
      existingNames: ['serial_com3'],
      saveCommand,
    });
    await nextTick();

    expect(document.querySelector('input[name="endpoint-name"]')).not.toBeNull();
    expect(document.body.textContent).toContain('留空将根据连接参数自动生成');
    await setValue('input[name="serial-custom-path"]', 'COM3');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      name: 'SERIAL_COM3_2',
      transport: 'serial',
      config: expect.objectContaining({ path: 'COM3' }),
    }));
  });

  test('uses a custom name when creating an endpoint', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: null, saveCommand });
    await nextTick();

    await setValue('input[name="endpoint-name"]', '锅炉房主站');
    await setValue('input[name="serial-custom-path"]', 'COM3');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      name: '锅炉房主站',
      transport: 'serial',
      config: expect.objectContaining({ path: 'COM3' }),
    }));
  });

  test('saves an edited endpoint name when its configuration changes', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({
      endpoint: { ...serialEndpoint('/dev/ttyUSB0'), name: 'My manual endpoint' },
      existingNames: ['My manual endpoint'],
      saveCommand,
    });
    await nextTick();

    await setValue('input[name="endpoint-name"]', 'Renamed endpoint');
    await setValue('select[name="serial-port-select"]', '__custom__');
    await setValue('input[name="serial-custom-path"]', '/dev/ttyUSB1');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Renamed endpoint',
      config: expect.objectContaining({ path: '/dev/ttyUSB1' }),
    }));
  });

  test('preserves the original endpoint name when only its configuration changes', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    const originalName = 'Original endpoint name';
    mountDialog({
      endpoint: { ...serialEndpoint('/dev/ttyUSB0'), name: originalName },
      existingNames: [originalName],
      saveCommand,
    });
    await nextTick();

    await setValue('select[name="serial-port-select"]', '__custom__');
    await setValue('input[name="serial-custom-path"]', '/dev/ttyUSB1');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      name: originalName,
      config: expect.objectContaining({ path: '/dev/ttyUSB1' }),
    }));
  });

  test('rejects a blank edited endpoint name', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: tcpEndpoint('endpoint-a'), saveCommand });
    await nextTick();

    await setValue('input[name="endpoint-name"]', '   ');
    await submitDialog();

    expect(saveCommand).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请输入端点名称。');
  });
});

describe('EndpointDialog protocol endpoints', () => {
  test.each([
    ['opcua-client', 'opcua-endpoint-url', 'opc.tcp://localhost:4841', 'endpointUrl'],
    ['stomp-client', 'stomp-url', 'ws://localhost:61615/stomp', 'url'],
  ])('creates %s through the shared endpoint flow', async (transport, field, address, key) => {
    const saveCommand = vi.fn(async () => ({ ok: true }));
    mountDialog({ endpoint: null, saveCommand }); await nextTick();
    await setValue('select[name="endpoint-transport"]', transport);
    await setValue(`input[name="${field}"]`, address);
    await submitDialog();
    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({ transport, config: expect.objectContaining({ [key]: address }) }));
  });
  test('editing a protocol address retains detailed settings and subscriptions', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true }));
    mountDialog({ endpoint: { id: 'protocol:stomp:a', name: '消息', transport: 'stomp-server', config: { listenHost: '127.0.0.1', listenPort: 61614, path: '/stomp', host: 'virtual', heartbeatIncoming: 2000, subscriptions: [{ id: 'sub', destination: '/topic/a', ack: 'auto' }] } }, saveCommand });
    await nextTick(); await setValue('input[name="stomp-listen-port"]', '61616'); await submitDialog();
    expect(saveCommand.mock.calls[0][0].config).toMatchObject({ listenPort: 61616, host: 'virtual', heartbeatIncoming: 2000, subscriptions: [{ id: 'sub', destination: '/topic/a', ack: 'auto' }] });
  });
});

describe('EndpointDialog serial configuration', () => {
  test('creates a DL/T 645 simulator with a practical default meter', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: null, saveCommand });
    await nextTick();

    await setValue('select[name="endpoint-transport"]', 'dlt645-slave');
    await setValue('input[name="serial-custom-path"]', '/dev/tty.sim');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      name: 'DLT645_SIMULATOR_tty.sim',
      transport: 'dlt645-slave',
      config: expect.objectContaining({
        baudRate: 2400,
        responseDelayMs: 50,
        meters: [expect.objectContaining({
          name: '模拟电表 1',
          tasks: expect.arrayContaining([
            expect.objectContaining({ identifier: '02010100', value: 230.1 }),
          ]),
        })],
      }),
    }));
  });

  test('saves and reopens preset and custom baud rates without transient fields', async () => {
    const presetSave = vi.fn(async () => ({ ok: true, value: null }));
    const presetWrapper = mountDialog({
      endpoint: serialEndpoint('/dev/ttyUSB0', undefined, 9600),
      saveCommand: presetSave,
    });
    await nextTick();

    const presetChoice = document.querySelector('select[name="serial-baud-rate-choice"]');
    expect(presetChoice.value).toBe('9600');
    expect(document.querySelector('input[name="serial-custom-baud-rate"]')).toBeNull();
    await submitDialog();
    const presetDraft = presetSave.mock.calls[0][0];
    expect(presetDraft.config.baudRate).toBe(9600);
    expect(presetDraft.config).not.toHaveProperty('baudRateChoice');
    expect(presetDraft.config).not.toHaveProperty('customBaudRate');
    presetWrapper.unmount();

    const reopenedPreset = mountDialog({ endpoint: presetDraft });
    await nextTick();
    expect(document.querySelector('select[name="serial-baud-rate-choice"]').value).toBe('9600');
    expect(document.querySelector('input[name="serial-custom-baud-rate"]')).toBeNull();
    reopenedPreset.unmount();

    const customSave = vi.fn(async () => ({ ok: true, value: null }));
    const customWrapper = mountDialog({
      endpoint: serialEndpoint('/dev/ttyUSB0', undefined, 250000),
      saveCommand: customSave,
    });
    await nextTick();

    expect(document.querySelector('select[name="serial-baud-rate-choice"]').value).toBe('__custom__');
    const customInput = document.querySelector('input[name="serial-custom-baud-rate"]');
    expect(customInput.value).toBe('250000');
    expect(customInput.getAttribute('aria-label')).toBe('自定义波特率');
    const baudGroup = customInput.closest('[role="group"]');
    expect(baudGroup.getAttribute('aria-labelledby')).toBe('serial-baud-rate-label');
    expect(document.querySelector('select[name="serial-baud-rate-choice"]')
      .getAttribute('aria-labelledby')).toBe('serial-baud-rate-label');
    expect(customInput.min).toBe('1');
    expect(customInput.max).toBe('4294967295');
    expect(customInput.step).toBe('1');
    await setValue('input[name="serial-custom-baud-rate"]', '250001');
    await submitDialog();
    const customDraft = customSave.mock.calls[0][0];
    expect(customDraft.config.baudRate).toBe(250001);
    customWrapper.unmount();

    const reopened = mountDialog({ endpoint: customDraft });
    await nextTick();
    expect(document.querySelector('select[name="serial-baud-rate-choice"]').value).toBe('__custom__');
    expect(document.querySelector('input[name="serial-custom-baud-rate"]').value).toBe('250001');
    reopened.unmount();
  });

  test('shows a field-specific error and does not save an invalid custom baud rate', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: serialEndpoint('/dev/ttyUSB0'), saveCommand });
    await nextTick();

    await setValue('select[name="serial-baud-rate-choice"]', '__custom__');
    await setValue('input[name="serial-custom-baud-rate"]', '0');
    const customInput = document.querySelector('input[name="serial-custom-baud-rate"]');
    customInput.scrollIntoView = vi.fn();
    button('保存端点').click();
    await flushPromises();

    expect(saveCommand).not.toHaveBeenCalled();
    expect(customInput.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(customInput);
    expect(customInput.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    const inlineError = customInput.closest('.field-control').querySelector('.field-error');
    expect(inlineError.getAttribute('role')).toBe('alert');
    expect(inlineError.textContent).toContain('波特率必须为 1 到 4294967295 的整数。');
  });

  test('normalizes discovered ports, refreshes, and saves all line settings exactly', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    const wrapper = mountDialog({
      endpoint: serialEndpoint('/dev/tty.absent'),
      serialPorts: [
        'COM3',
        { path: '/dev/ttyUSB0', manufacturer: 'Acme' },
        { name: '/dev/cu.usbmodem', label: 'USB Modem' },
      ],
      saveCommand,
    });
    await nextTick();

    const portSelect = document.querySelector('select[name="serial-port-select"]');
    expect([...portSelect.options].map((option) => option.value)).toEqual([
      '/dev/tty.absent', 'COM3', '/dev/ttyUSB0', '/dev/cu.usbmodem', '__custom__',
    ]);
    expect(portSelect.value).toBe('/dev/tty.absent');
    button('刷新串口列表').click();
    await nextTick();
    expect(wrapper.emitted('scan-serial-ports')).toHaveLength(1);

    await setValue('select[name="serial-port-select"]', '/dev/ttyUSB0');
    await setValue('select[name="serial-data-bits"]', '7');
    await setValue('select[name="serial-parity"]', 'even');
    await setValue('select[name="serial-stop-bits"]', '1.5');
    await setValue('select[name="serial-flow-control"]', 'hardware');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith({
      id: 'serial-a', name: 'Serial A', transport: 'serial',
      config: {
        path: '/dev/ttyUSB0', baudRate: 9600, dataBits: 7,
        parity: 'even', stopBits: 1.5, flowControl: 'hardware',
        receiveFraming: { mode: 'raw' },
      },
    });
  });

  test('custom option exposes manual path and disconnected edited port remains selectable', async () => {
    const wrapper = mountDialog({ endpoint: serialEndpoint('/dev/tty.absent'), serialPorts: [] });
    await nextTick();
    const portSelect = document.querySelector('select[name="serial-port-select"]');
    expect(portSelect.value).toBe('/dev/tty.absent');
    await setValue('select[name="serial-port-select"]', '__custom__');
    const manual = document.querySelector('input[name="serial-custom-path"]');
    expect(manual).not.toBeNull();
    await setValue('input[name="serial-custom-path"]', '/dev/tty.manual');
    await submitDialog();
    expect(wrapper.props('saveCommand')).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ path: '/dev/tty.manual' }),
    }));
  });

  test.each([
    ['raw', '原始数据', null, null, { mode: 'raw' }],
    ['delimiter', '分隔符', 'input[name="serial-receive-delimiter"]', '0D 0A',
      { mode: 'delimiter', delimiterBytes: [13, 10] }],
    ['fixed', '固定长度', 'input[name="serial-receive-length"]', '64',
      { mode: 'fixed', length: 64 }],
    ['idle', '空闲超时', 'input[name="serial-receive-idle-ms"]', '50',
      { mode: 'idle', idleMs: 50 }],
  ])('saves and reopens %s receive framing', async (mode, label, selector, value, receiveFraming) => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    const wrapper = mountDialog({
      endpoint: serialEndpoint('/dev/ttyUSB0', receiveFraming),
      saveCommand,
    });
    await nextTick();

    const framingSelect = document.querySelector('select[name="serial-receive-framing"]');
    expect(framingSelect).not.toBeNull();
    expect(framingSelect.value).toBe(mode);
    expect(framingSelect.textContent).toContain(label);
    if (selector) expect(document.querySelector(selector).value).toBe(value);

    await submitDialog();
    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ receiveFraming }),
    }));
    wrapper.unmount();

    const reopened = mountDialog({ endpoint: serialEndpoint('/dev/ttyUSB0', receiveFraming) });
    await nextTick();
    expect(document.querySelector('select[name="serial-receive-framing"]').value).toBe(mode);
    if (selector) expect(document.querySelector(selector).value).toBe(value);
    reopened.unmount();
  });

  test('legacy serial endpoint defaults receive framing to raw and rejects invalid delimiter HEX', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: serialEndpoint('/dev/ttyUSB0'), saveCommand });
    await nextTick();
    expect(document.querySelector('select[name="serial-receive-framing"]').value).toBe('raw');

    await setValue('select[name="serial-receive-framing"]', 'delimiter');
    await setValue('input[name="serial-receive-delimiter"]', '0D GG');
    await submitDialog();

    expect(saveCommand).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请输入有效且非空的 HEX 分隔符。');
  });

  test('shows compact loading, empty, and scan failure states', async () => {
    const wrapper = mountDialog({
      endpoint: serialEndpoint(''),
      scanningPorts: true,
      serialScanError: '',
    });
    await nextTick();
    expect(document.body.textContent).toContain('正在扫描串口...');
    await wrapper.setProps({ scanningPorts: false });
    expect(document.body.textContent).toContain('未发现串口');
    await wrapper.setProps({ serialScanError: 'Scan failed' });
    expect(document.querySelector('[role="alert"]').textContent).toContain('Scan failed');
  });
});

describe('EndpointDialog TCP configuration', () => {
  test('shows normalized keepalive defaults for legacy TCP endpoints and limits auto reconnect to clients', async () => {
    const client = mountDialog({ endpoint: tcpEndpoint('tcp-client-legacy') });
    await nextTick();

    const keepAlive = document.querySelector('input[name="tcp-keep-alive"]');
    expect(keepAlive.checked).toBe(true);
    expect(keepAlive.labels).toHaveLength(1);
    expect(keepAlive.labels[0].textContent.trim()).toBe('TCP Keepalive');
    expect(document.querySelector('input[name="tcp-keep-alive-delay"]').value).toBe('30');
    expect(document.querySelector('input[name="tcp-auto-reconnect"]')).not.toBeNull();
    client.unmount();

    mountDialog({ endpoint: tcpServerEndpoint('tcp-server-legacy') });
    await nextTick();

    expect(document.querySelector('input[name="tcp-keep-alive"]').checked).toBe(true);
    expect(document.querySelector('input[name="tcp-keep-alive-delay"]').value).toBe('30');
    expect(document.querySelector('input[name="tcp-auto-reconnect"]')).toBeNull();
  });

  test('retains a disabled keepalive delay and saves resilience settings for a TCP client', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: tcpEndpoint('tcp-client-a'), saveCommand });
    await nextTick();

    await setChecked('input[name="tcp-keep-alive"]', false);
    await setChecked('input[name="tcp-auto-reconnect"]', true);
    const delay = document.querySelector('input[name="tcp-keep-alive-delay"]');
    expect(delay.disabled).toBe(true);
    expect(delay.value).toBe('30');
    await submitDialog();

    expect(saveCommand.mock.calls[0][0].config).toEqual(expect.objectContaining({
      keepAlive: { enabled: false, initialDelaySeconds: 30 },
      autoReconnect: true,
    }));
  });

  test.each(['0', '3601', '1.5'])('blocks an invalid TCP keepalive delay of %s and focuses it', async (value) => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: tcpEndpoint('tcp-client-a'), saveCommand });
    await nextTick();

    await setValue('input[name="tcp-keep-alive-delay"]', value);
    const delay = document.querySelector('input[name="tcp-keep-alive-delay"]');
    await submitDialog();

    expect(saveCommand).not.toHaveBeenCalled();
    expect(delay.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain('首次探测延迟必须为 1 到 3600 的整数秒。');
    expect(document.activeElement).toBe(delay);
  });

  test.each([
    ['tcp-client', tcpEndpoint('tcp-client-a')],
    ['tcp-server', tcpServerEndpoint('tcp-server-a')],
  ])('saves %s receive framing', async (_transport, endpoint) => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint, saveCommand });
    await nextTick();

    expect(document.querySelector('select[name="tcp-receive-framing"]')).not.toBeNull();
    await setValue('select[name="tcp-receive-framing"]', 'delimiter');
    await setValue('input[name="tcp-receive-delimiter"]', '0D 0A');
    await submitDialog();

    expect(saveCommand.mock.calls[0][0].config.receiveFraming).toEqual({
      mode: 'delimiter',
      delimiterBytes: [0x0d, 0x0a],
    });
  });
});

describe('EndpointDialog UDP configuration', () => {
  test.each([
    ['udp-client', udpEndpoint('udp-client-a')],
    ['udp-server', udpServerEndpoint('udp-server-a')],
  ])('uses datagram boundaries for %s and removes legacy stream framing', async (_transport, endpoint) => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint, saveCommand });
    await nextTick();

    expect(document.querySelector('select[name="udp-receive-framing"]')).toBeNull();
    expect(document.body.textContent).toContain('每个 UDP 数据报独立显示为一帧');
    await submitDialog();

    expect(saveCommand.mock.calls[0][0].config).not.toHaveProperty('receiveFraming');
  });
});

describe('EndpointDialog Modbus business model', () => {
  test('preserves normalized request groups and write commands while editing master settings', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    const endpoint = {
      id: 'master-a', name: '主站 A', transport: 'modbus-tcp-master',
      config: {
        host: '192.168.1.20', port: 502, unitId: 1, timeoutMs: 1000,
        marker: 'preserved', description: '旧说明', enabled: true,
        retryCount: 1, retryIntervalMs: 200, autoReconnect: false,
        scheduler: { autoStart: false, minGapMs: 50 },
        requestGroups: [{ id: 'group-1', name: '环境参数', enabled: true, order: 0,
          unitId: 1, functionCode: 3, startAddress: 100, quantity: 10,
          intervalMs: 1000, dataPoints: [] }],
        writeCommands: [
          {
            id: 'set-thresholds', name: ' 设置阈值 ', description: '批量设定',
            enabled: false, order: 8, unitId: 7, functionCode: 16,
            address: 200, values: [10, 20, 30],
          },
          {
            id: 'reset-alarm', name: ' 复位报警 ', description: '',
            enabled: true, order: 3, unitId: 7, functionCode: 5,
            address: 12, values: [true],
          },
        ],
      },
    };
    mountDialog({ endpoint, saveCommand });
    await nextTick();

    await setValue('input[name="modbus-host"]', '10.20.30.40');
    await setValue('input[name="modbus-port"]', '1502');
    await setValue('input[name="modbus-master-description"]', '锅炉房采集');
    await setValue('input[name="modbus-master-retry-count"]', '3');
    await setValue('input[name="modbus-master-retry-interval"]', '500');
    await setValue('input[name="modbus-master-min-gap"]', '80');
    await setChecked('input[name="modbus-master-auto-start"]', true);
    await setChecked('input[name="modbus-master-auto-reconnect"]', true);
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        configVersion: 3, marker: 'preserved', host: '10.20.30.40', port: 1502,
        description: '锅炉房采集', retryCount: 3,
        retryIntervalMs: 500, autoReconnect: true,
        scheduler: { autoStart: true, minGapMs: 80 },
        requestGroups: [expect.objectContaining({
          id: 'group-1', name: '环境参数',
          requests: [expect.objectContaining({
            id: 'group-1-request', functionCode: 3, startAddress: 100, quantity: 10,
          })],
        })],
        writeCommands: [
          {
            id: 'reset-alarm', name: '复位报警', description: '',
            enabled: true, order: 0, unitId: 7, functionCode: 5,
            address: 12, values: [true],
          },
          {
            id: 'set-thresholds', name: '设置阈值', description: '批量设定',
            enabled: false, order: 1, unitId: 7, functionCode: 16,
            address: 200, values: [10, 20, 30],
          },
        ],
      }),
    }));
  });

  test('blocks a base-settings save when a persisted write command has malformed values', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    const endpoint = {
      id: 'master-invalid-write', name: '主站异常配置', transport: 'modbus-tcp-master',
      config: {
        host: '192.168.1.20', port: 502, unitId: 1, timeoutMs: 1000,
        requestGroups: [],
        writeCommands: [{
          id: 'bad-coil', name: '异常线圈', description: '', enabled: true, order: 0,
          unitId: 1, functionCode: 5, address: 12, values: ['enabled'],
        }],
      },
    };
    mountDialog({ endpoint, saveCommand });
    await nextTick();

    await setValue('input[name="modbus-host"]', '10.20.30.40');
    await submitDialog();

    expect(saveCommand).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('写入指令配置无效，请先在主站“写入操作”中修复。');
    expect(endpoint.config.writeCommands[0].values).toEqual(['enabled']);
  });

  test('configures and persists a typed slave business data point', async () => {
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint: modbusSlaveEndpoint('slave-a'), saveCommand });
    await nextTick();

    button('添加数据点').click();
    await nextTick();
    await setValue('input[name="modbus-point-0-name"]', '出水温度');
    await setValue('input[name="modbus-point-0-address"]', '10');
    await setValue('select[name="modbus-point-0-type"]', 'float32');
    const item = document.querySelector('.modbus-point-settings__item');
    const inputs = item.querySelectorAll('input');
    const scale = [...inputs].find((input) => input.previousElementSibling?.textContent === '缩放');
    const unit = [...inputs].find((input) => input.previousElementSibling?.textContent === '单位');
    await setElementValue(scale, '0.1');
    await setElementValue(unit, '℃');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'modbus-tcp-slave',
      config: expect.objectContaining({
        dataPoints: [expect.objectContaining({
          name: '出水温度', area: 'holdingRegisters', address: 10,
          dataType: 'float32', length: 2, scale: 0.1, unit: '℃',
        })],
      }),
    }));
  });

  test('uses one data-order control for slave defaults and typed business points', async () => {
    const endpoint = modbusSlaveEndpoint('slave-order');
    endpoint.config.byteOrder = 'little-endian';
    endpoint.config.wordOrder = 'low-first';
    endpoint.config.dataPoints = [{
      id: 'temperature', name: '温度', group: '温控', area: 'holdingRegisters',
      address: 10, dataType: 'float32', length: 2, byteOrder: 'big-endian',
      wordOrder: 'low-first', scale: 0.1, offset: 0, unit: '℃', access: 'read-write',
    }];
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint, saveCommand });
    await nextTick();

    const defaultOrder = document.querySelector('select[name="modbus-data-order"]');
    const pointOrder = document.querySelector('select[name="modbus-point-0-data-order"]');
    expect(defaultOrder.value).toBe('DCBA');
    expect([...defaultOrder.options].map(({ value }) => value))
      .toEqual(['ABCD', 'BADC', 'CDAB', 'DCBA']);
    expect(pointOrder.value).toBe('CDAB');
    expect([...pointOrder.options].map(({ value }) => value))
      .toEqual(['ABCD', 'BADC', 'CDAB', 'DCBA']);
    expect(document.querySelector('select[name="modbus-byte-order"]')).toBeNull();
    expect(document.querySelector('select[name="modbus-word-order"]')).toBeNull();

    await setElementValue(defaultOrder, 'BADC');
    await setElementValue(pointOrder, 'DCBA');
    await submitDialog();

    expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        byteOrder: 'little-endian', wordOrder: 'high-first',
        dataPoints: [expect.objectContaining({
          byteOrder: 'little-endian', wordOrder: 'low-first',
        })],
      }),
    }));
  });

  test('shows AB and BA for one-register slave points and no order for booleans', async () => {
    const endpoint = modbusSlaveEndpoint('slave-point-width');
    endpoint.config.dataPoints = [{
      id: 'speed', name: '速度', group: '产线', area: 'holdingRegisters',
      address: 10, dataType: 'uint16', length: 1, byteOrder: 'little-endian',
      wordOrder: 'low-first', scale: 1, offset: 0, unit: '', access: 'read-write',
    }, {
      id: 'running', name: '运行', group: '产线', area: 'coils',
      address: 0, dataType: 'boolean', length: 1, byteOrder: 'big-endian',
      wordOrder: 'high-first', scale: 1, offset: 0, unit: '', access: 'read-write',
    }];
    mountDialog({ endpoint });
    await nextTick();

    const order = document.querySelector('select[name="modbus-point-0-data-order"]');
    expect(order.value).toBe('BA');
    expect([...order.options].map(({ value }) => value)).toEqual(['AB', 'BA']);
    expect(document.querySelector('select[name="modbus-point-1-data-order"]')).toBeNull();
  });

  test('blocks overlapping slave business points with a field error', async () => {
    const endpoint = modbusSlaveEndpoint('slave-a');
    endpoint.config.dataPoints = [
      { id: 'a', name: 'A', group: '默认分组', area: 'holdingRegisters', address: 10, dataType: 'uint32', length: 2, byteOrder: 'big-endian', wordOrder: 'high-first', scale: 1, offset: 0, unit: '', access: 'read-write' },
      { id: 'b', name: 'B', group: '默认分组', area: 'holdingRegisters', address: 11, dataType: 'uint16', length: 1, byteOrder: 'big-endian', wordOrder: 'high-first', scale: 1, offset: 0, unit: '', access: 'read-write' },
    ];
    const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
    mountDialog({ endpoint, saveCommand });
    await nextTick();
    await submitDialog();

    expect(saveCommand).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('该地址范围与同一数据区的其他业务点重叠。');
  });
});

function mountDialog(overrides = {}) {
  const wrapper = mount(EndpointDialog, {
    attachTo: document.body,
    props: {
      open: true,
      endpoint: tcpEndpoint('endpoint-a'),
      saveCommand: vi.fn(async () => ({ ok: true, value: null })),
      ...overrides,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

async function submitDialog() {
  await nextTick();
  dialog().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await nextTick();
}

function tcpEndpoint(id) {
  return { id, name: id, transport: 'tcp-client', config: { host: 'localhost', port: 9000 } };
}

function tcpServerEndpoint(id) {
  return {
    id,
    name: id,
    transport: 'tcp-server',
    config: { listenHost: '0.0.0.0', listenPort: 9000 },
  };
}

function udpEndpoint(id) {
  return {
    id,
    name: id,
    transport: 'udp-client',
    config: {
      bindHost: '0.0.0.0', bindPort: 9000, targetHost: '127.0.0.1', targetPort: 9001,
    },
  };
}

function udpServerEndpoint(id) {
  return {
    id,
    name: id,
    transport: 'udp-server',
    config: { bindHost: '0.0.0.0', bindPort: 9000 },
  };
}

function serialEndpoint(path, receiveFraming, baudRate = 9600) {
  return {
    id: 'serial-a', name: 'Serial A', transport: 'serial',
    config: {
      path, baudRate,
      ...(receiveFraming ? { receiveFraming } : {}),
    },
  };
}

describe('LinkLabShell endpoint names', () => {
  test('starts with the endpoint rail collapsed on a compact viewport', () => {
    vi.stubGlobal('matchMedia', vi.fn((query) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const wrapper = shallowMount(LinkLabShell, { props: shellProps(['Endpoint A']) });
    wrappers.push(wrapper);

    expect(wrapper.get('.linklab-shell').classes()).toContain('tree-collapsed');
    expect(wrapper.get('[aria-label="展开端点列表"]').exists()).toBe(true);
  });

  test('passes current model endpoint names to EndpointDialog', async () => {
    const props = shellProps(['Endpoint A', 'Endpoint B']);
    const wrapper = shallowMount(LinkLabShell, {
      props,
    });
    wrappers.push(wrapper);

    expect(wrapper.findComponent(EndpointDialog).props('existingNames')).toEqual([
      'Endpoint A', 'Endpoint B',
    ]);

    props.model.state.endpoints = [{
      id: 'endpoint-2', name: 'Endpoint C', transport: 'tcp-client', config: {},
    }];
    await wrapper.setProps({ revision: 1 });
    expect(wrapper.findComponent(EndpointDialog).props('existingNames')).toEqual(['Endpoint C']);
  });

  test('refreshes active session state and counters when model revision changes', async () => {
    const props = shellProps(['Serial A']);
    const endpoint = props.model.state.endpoints[0];
    props.model.state.activeEndpointId = endpoint.id;
    props.model.activeEndpoint = endpoint;
    const wrapper = shallowMount(LinkLabShell, { props });
    wrappers.push(wrapper);

    expect(wrapper.findComponent(SessionStatusBar).props('operation')).toBeNull();
    expect(wrapper.findComponent(SessionStatusBar).props('counters')).toEqual({
      received: 0, sent: 0, logs: 0,
    });

    const operation = {
      endpointId: endpoint.id,
      operationId: 'open-1',
      sessionId: 'session-1',
    };
    const status = { ...operation, status: 'open', error: null, log: null, createdAt: 1 };
    props.model.state.operations.set(endpoint.id, operation);
    props.model.state.statuses.set(endpoint.id, status);
    props.model.state.endpointCounters.set(endpoint.id, {
      received: 12, sent: 3, logs: 1,
    });
    await wrapper.setProps({ revision: 1 });

    const statusBar = wrapper.findComponent(SessionStatusBar);
    expect(statusBar.props('operation')).toEqual(operation);
    expect(statusBar.props('statusEvent')).toEqual(status);
    expect(statusBar.props('counters')).toEqual({ received: 12, sent: 3, logs: 1 });
  });

  test('cancels a reconnect before opening the endpoint editor', async () => {
    const props = shellProps(['TCP client']);
    const endpoint = props.model.state.endpoints[0];
    let dialogVisibleDuringCancellation = false;
    props.model.commands = {
      cancelReconnect: vi.fn(() => {
        dialogVisibleDuringCancellation = document.querySelector('.endpoint-dialog') !== null;
      }),
    };
    const wrapper = mount(LinkLabShell, { attachTo: document.body, props });
    wrappers.push(wrapper);

    await wrapper.get('[aria-label="端点操作"]').trigger('click');
    const edit = wrapper.get('.endpoint-row__menu button[role="menuitem"]');
    expect(edit.text()).toContain('编辑');
    await edit.trigger('click');
    await nextTick();

    expect(props.model.commands.cancelReconnect).toHaveBeenCalledWith(endpoint.id);
    expect(dialogVisibleDuringCancellation).toBe(false);
    expect(document.querySelector('.endpoint-dialog')).not.toBeNull();
  });

  test('keeps history actions out of the sidebar footer and opens toolbar history for the active endpoint', async () => {
    const props = shellProps(['Serial A']);
    const endpoint = props.model.state.endpoints[0];
    props.model.state.activeEndpointId = endpoint.id;
    props.model.activeEndpoint = endpoint;
    const wrapper = shallowMount(LinkLabShell, { props });
    wrappers.push(wrapper);

    const footer = wrapper.find('.linklab-shell__runtime');
    expect(footer.find('button[aria-label="打开消息历史"]').exists()).toBe(false);
    expect(footer.find('button[aria-label="打开日志历史"]').exists()).toBe(false);
    expect(footer.find('button[aria-label="打开设置"]').exists()).toBe(true);
    expect(footer.find('button[aria-label="打开关于"]').exists()).toBe(true);
    expect(footer.text()).toContain('设置');
    expect(footer.text()).not.toContain('Test');

    wrapper.findComponent(FrameToolbar).vm.$emit('history', 'frames');
    await nextTick();
    expect(props.runtime.window.openHistory).toHaveBeenCalledWith({
      kind: 'frames', endpointId: endpoint.id,
    });
  });
});

describe('FrameToolbar history action', () => {
  test('renders history immediately before clear and emits the active history kind', async () => {
    const wrapper = mount(FrameToolbar, {
      props: {
        activeView: 'messages',
        filters: { direction: 'all', peerId: 'all', keyword: '' },
      },
    });
    wrappers.push(wrapper);

    const messageHistory = wrapper.find('button[aria-label="打开消息历史"]');
    const clear = wrapper.find('button[aria-label="清空实时视图"]');
    expect(messageHistory.exists()).toBe(true);
    expect(messageHistory.attributes('title')).toBe('消息历史');
    expect(messageHistory.element.nextElementSibling).toBe(clear.element);
    await messageHistory.trigger('click');
    expect(wrapper.emitted('history')).toEqual([['frames']]);

    await wrapper.setProps({ activeView: 'logs' });
    const logHistory = wrapper.find('button[aria-label="打开日志历史"]');
    expect(logHistory.exists()).toBe(true);
    expect(logHistory.attributes('title')).toBe('日志历史');
    expect(logHistory.element.nextElementSibling).toBe(clear.element);
    await logHistory.trigger('click');
    expect(wrapper.emitted('history')).toEqual([['frames'], ['logs']]);
  });
});

function shellProps(endpointNames) {
  const endpoints = endpointNames.map((name, index) => ({
    id: `endpoint-${index}`, name, transport: 'tcp-client', config: {},
  }));
  const state = {
    endpoints,
    operations: new Map(),
    reconnects: new Map(),
    statuses: new Map(),
    endpointCounters: new Map(),
    peers: new Map(),
    activeEndpointId: '',
    activePeerId: '',
    endpointFilter: '',
    frameFilters: { keyword: '' },
  };
  return {
    model: {
      state,
      activeEndpoint: null,
      filteredEndpoints: endpoints,
      visibleFrames: [],
      visibleLogs: [],
      peersForEndpoint: () => [],
      commandErrorForEndpoint: () => null,
      reconnectStateFor: () => null,
      commands: { cancelReconnect: vi.fn() },
      scheduledSender: {
        getStatus: () => ({ active: false }),
        subscribe: () => () => {},
      },
    },
    runtime: { window: { openHistory: vi.fn() } },
    preferences: {
      values: {
        previewByteLimit: 100,
        autoScroll: true,
        largeFont: false,
        defaultFraming: 'text',
      },
      resolvedTheme: 'light',
      revision: 0,
    },
    savePreferences: vi.fn(),
    revision: 0,
    runtimeName: 'Test',
    saveCommand: vi.fn(),
    sendCommand: vi.fn(),
    workspaceImportedCommand: vi.fn(),
  };
}

function dialog() {
  return document.querySelector('.endpoint-dialog');
}

function backdrop() {
  return document.querySelector('.dialog-backdrop');
}

function button(label) {
  return [...document.querySelectorAll('button')].find((item) => (
    item.getAttribute('aria-label') === label || item.textContent.trim() === label
  ));
}

async function setValue(selector, value) {
  const element = document.querySelector(selector);
  await setElementValue(element, value);
}

async function setElementValue(element, value) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

function modbusSlaveEndpoint(id) {
  const emptyBits = Array.from({ length: 100 }, () => false);
  const emptyWords = Array.from({ length: 100 }, () => 0);
  return {
    id,
    name: id,
    transport: 'modbus-tcp-slave',
    config: {
      listenHost: '127.0.0.1', listenPort: 1502, unitId: 1, timeoutMs: 1000,
      addressNotation: 'zero-based', byteOrder: 'big-endian', wordOrder: 'high-first',
      dataAreas: {
        coils: { start: 0, count: 100, values: emptyBits },
        discreteInputs: { start: 0, count: 100, values: [...emptyBits] },
        holdingRegisters: { start: 0, count: 100, values: emptyWords },
        inputRegisters: { start: 0, count: 100, values: [...emptyWords] },
      },
      dataPoints: [],
    },
  };
}

async function setChecked(selector, checked) {
  const element = document.querySelector(selector);
  element.checked = checked;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('OPC UA simulator dialog validates listening settings and preserves saved nodes when editing', async () => {
  const saveCommand = vi.fn(async () => ({ ok: true }));
  const wrapper = mountDialog({ open: false, endpoint: null, saveCommand });
  await wrapper.setProps({ open: true }); await nextTick();
  const transport = document.querySelector('[name="endpoint-transport"]');
  transport.value = 'opcua-server'; transport.dispatchEvent(new Event('change', { bubbles: true })); await nextTick();
  const port = document.querySelector('[name="opcua-server-port"]');
  port.value = '0'; port.dispatchEvent(new Event('input', { bubbles: true }));
  await submitDialog(); expect(saveCommand).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('端口必须');
  port.value = '4841'; port.dispatchEvent(new Event('input', { bubbles: true })); await submitDialog();
  const draft = saveCommand.mock.calls[0][0]; expect(draft.transport).toBe('opcua-server'); expect(draft.name).toBe('OPCUA_SERVER_4841');
  const nodes = [{ id: 'saved', value: 'unchanged' }];
  await wrapper.setProps({ open: false }); await wrapper.setProps({ open: true, connectionLocked: true, endpoint: { ...draft, config: { ...draft.config, nodes } } }); await nextTick();
  expect(document.querySelector('[name="opcua-server-port"]').disabled).toBe(true);
  await submitDialog(); expect(saveCommand.mock.calls.at(-1)[0].config.nodes).toEqual(nodes);
});
