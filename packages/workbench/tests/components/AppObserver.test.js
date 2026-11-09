/* eslint-disable vue/one-component-per-file */
import { mount, flushPromises } from '@vue/test-utils';
import { createUnavailableRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import { defineComponent, nextTick } from 'vue';
import { afterEach, describe, expect, test, vi } from 'vitest';

import App from '../../src/App.vue';
import { runtimeAdapterKey } from '../../src/runtimeContext.js';
import { createElectronRuntimeAdapter } from '../../../../apps/electron/renderer/runtimeAdapter.js';

const ShellStub = defineComponent({
  props: {
    revision: { type: Number, required: true },
    preferences: { type: Object, default: null },
    model: { type: Object, default: null },
    serialPorts: { type: Array, default: () => [] },
    scanningPorts: Boolean,
    serialScanError: { type: String, default: '' },
    loading: Boolean,
    loadError: { type: String, default: '' },
    workspaceImportedCommand: { type: Function, default: null },
  },
  emits: ['endpoint-filter', 'scan-serial-ports'],
  template: '<div><button class="revision" @click="$emit(\'endpoint-filter\', \'tcp\')">{{ revision }}-{{ preferences?.resolvedTheme }}-{{ preferences?.values?.largeFont }}</button><button class="scan" @click="$emit(\'scan-serial-ports\')">scan</button><button class="workspace-imported" @click="workspaceImportedCommand?.()">imported</button><span class="ports">{{ serialPorts.map(port => port.path).join(\',\') }}|{{ scanningPorts }}|{{ serialScanError }}</span><span class="endpoint-names">{{ model?.state.endpoints.map(endpoint => endpoint.name).join(\',\') }}</span><span class="load-state">{{ loading }}|{{ loadError }}</span></div>',
});
const HistoryStub = defineComponent({
  props: { preferences: { type: Object, required: true } },
  template: '<div class="history-stub">{{ preferences.resolvedTheme }}</div>',
});

afterEach(() => {
  document.documentElement.classList.remove('large-font', 'ui-preferences-loading');
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeMode;
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('App observer integration', () => {
  test('model notifications drive shell revision without polling', async () => {
    const wrapper = mount(App, {
      global: {
        provide: { [runtimeAdapterKey]: createUnavailableRuntimeAdapter('test') },
        stubs: { LinkLabShell: ShellStub },
      },
    });
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('.revision').exists()).toBe(true));
    const before = Number(wrapper.get('.revision').text().split('-')[0]);

    await wrapper.get('.revision').trigger('click');
    await nextTick();

    expect(Number(wrapper.get('.revision').text().split('-')[0])).toBe(before + 1);
    wrapper.unmount();
  });

  test('loads persisted dark and large-font settings before rendering the shell', async () => {
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.settings.getAll = vi.fn(async () => ({ theme: 'dark', largeFont: true }));
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { LinkLabShell: ShellStub } },
    });
    expect(wrapper.text()).toContain('正在加载界面设置');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('.revision').exists()).toBe(true));
    expect(wrapper.get('.revision').text()).toContain('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('large-font')).toBe(true);
    wrapper.unmount();
  });

  test('loads and applies persisted preferences before rendering history', async () => {
    window.history.replaceState({}, '', '/?view=history&kind=logs&endpointId=Unicode-%E4%B8%AD%E6%96%87');
    const runtime = createUnavailableRuntimeAdapter('Tauri');
    runtime.settings.getAll = vi.fn(async () => ({ theme: 'dark', largeFont: true }));
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { HistoryWindow: HistoryStub } },
    });
    await vi.waitFor(() => expect(wrapper.find('.history-stub').exists()).toBe(true));
    expect(wrapper.get('.history-stub').text()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('large-font')).toBe(true);
    wrapper.unmount();
  });

  test('mounts Electron history from its restricted bridge and performs initial reads', async () => {
    window.history.replaceState({}, '', '/?view=history&kind=frames&endpointId=ep-1');
    const queryFrames = vi.fn(async (query) => ({
      rows: [], total: 0, page: query.page, pageSize: query.pageSize,
    }));
    const getAll = vi.fn(async () => ({ theme: 'dark' }));
    const bridge = {
      runtimeName: 'electron',
      history: {
        queryFrames: async (...args) => ({ ok: true, value: await queryFrames(...args) }),
        queryLogs: async () => ({ ok: true, value: { rows: [], total: 0, page: 1, pageSize: 50 } }),
      },
      settings: { getAll: async () => ({ ok: true, value: await getAll() }) },
    };
    expect(bridge.endpoint).toBeUndefined();
    expect(bridge.workspace).toBeUndefined();
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: createElectronRuntimeAdapter(bridge) } },
    });
    await vi.waitFor(() => expect(queryFrames).toHaveBeenCalledTimes(1));
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(queryFrames).toHaveBeenCalledWith(expect.objectContaining({ endpointId: 'ep-1', page: 1 }));
    expect(wrapper.find('.history-window').exists()).toBe(true);
    wrapper.unmount();
  });

  test('serial refresh keeps only the newest completion', async () => {
    const runtime = createUnavailableRuntimeAdapter('Electron');
    const first = deferred();
    const second = deferred();
    runtime.transport.scanSerialPorts = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { LinkLabShell: ShellStub } },
    });
    await vi.waitFor(() => expect(wrapper.find('.scan').exists()).toBe(true));
    await wrapper.get('.scan').trigger('click');
    await wrapper.get('.scan').trigger('click');
    second.resolve([{ path: '/dev/new' }]);
    await flushPromises();
    first.resolve([{ path: '/dev/old' }]);
    await flushPromises();
    expect(wrapper.get('.ports').text()).toContain('/dev/new|false|');
    expect(wrapper.get('.ports').text()).not.toContain('/dev/old');
    wrapper.unmount();
  });

  test('successful workspace import reloads endpoints and applies imported preferences', async () => {
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.endpoint.list = vi.fn()
      .mockResolvedValueOnce([{ id: 'old', name: 'Old', transport: 'serial', config: {} }])
      .mockResolvedValueOnce([{ id: 'new', name: 'New', transport: 'serial', config: {} }]);
    runtime.settings.getAll = vi.fn()
      .mockResolvedValueOnce({ theme: 'light', largeFont: false })
      .mockResolvedValueOnce({ theme: 'dark', largeFont: true });
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { LinkLabShell: ShellStub } },
    });
    await vi.waitFor(() => expect(wrapper.get('.endpoint-names').text()).toBe('Old'));
    await wrapper.get('.workspace-imported').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('.endpoint-names').text()).toBe('New'));
    expect(wrapper.get('.revision').text()).toContain('dark-true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('large-font')).toBe(true);
    expect(runtime.endpoint.list).toHaveBeenCalledTimes(2);
    expect(runtime.settings.getAll).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  test('workspace import stays locked until endpoint and settings refreshes both settle', async () => {
    const importGate = deferred();
    const endpointRefreshGate = deferred();
    const settingsRefreshGate = deferred();
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.endpoint.list = vi.fn()
      .mockResolvedValueOnce([{ id: 'old', name: 'Old', transport: 'serial', config: {} }])
      .mockReturnValueOnce(endpointRefreshGate.promise);
    runtime.settings.getAll = vi.fn(async () => ({ theme: 'light', largeFont: false }));
    runtime.opcua.execute = vi.fn(async () => ({ profiles: [] }));
    runtime.settings.saveAll = vi.fn(async () => true);
    runtime.workspace.import = vi.fn(() => importGate.promise);
    runtime.storage.stats = vi.fn(async () => ({
      frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 0,
    }));
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime } },
    });
    await vi.waitFor(() => expect(wrapper.find('button[aria-label="打开设置"]').exists()).toBe(true));
    await wrapper.get('button[aria-label="打开设置"]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('select[name="theme"]')).not.toBeNull());

    const theme = document.querySelector('select[name="theme"]');
    theme.value = 'system';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();
    document.querySelector('button[data-action="import"]').click();
    await vi.waitFor(() => expect(runtime.workspace.import).toHaveBeenCalledTimes(1));

    const dialog = document.querySelector('.settings-panel');
    const backdrop = document.querySelector('.dialog-backdrop');
    const close = document.querySelector('button[aria-label="关闭设置"]');
    const cancel = [...dialog.querySelectorAll('button')].find((button) => button.textContent.includes('取消'));
    const save = dialog.querySelector('button[type="submit"]');
    expect(close.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    close.click();
    cancel.click();
    document.querySelector('button[data-action="import"]').click();
    dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.querySelector('.settings-panel')).toBe(dialog);
    expect(runtime.settings.saveAll).not.toHaveBeenCalled();
    expect(runtime.workspace.import).toHaveBeenCalledTimes(1);

    // Preferences and the protocol catalog both read the same native snapshot.
    // Hold subsequent reads only once the user has committed the import.
    const initialSettingsReads = runtime.settings.getAll.mock.calls.length;
    runtime.settings.getAll.mockImplementation(() => settingsRefreshGate.promise);
    importGate.resolve({ canceled: false, path: '/tmp/imported-workspace.json' });
    await vi.waitFor(() => expect(runtime.endpoint.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(runtime.settings.getAll.mock.calls.length).toBeGreaterThan(initialSettingsReads));
    expect(close.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    close.click();
    cancel.click();
    document.querySelector('button[data-action="import"]').click();
    dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector('.settings-panel')).toBe(dialog);
    expect(runtime.settings.saveAll).not.toHaveBeenCalled();
    expect(runtime.workspace.import).toHaveBeenCalledTimes(1);

    endpointRefreshGate.resolve([{ id: 'new', name: 'New', transport: 'serial', config: {} }]);
    await flushPromises();
    expect(close.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);

    settingsRefreshGate.resolve({ theme: 'dark', largeFont: true });
    await vi.waitFor(() => expect(document.querySelector('select[name="theme"]').value).toBe('dark'));
    expect(document.querySelector('input[name="large-font"]').checked).toBe(true);
    expect(close.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
    expect(document.querySelector('button[data-action="import"]').disabled).toBe(false);
    document.querySelector('select[name="theme"]').value = 'system';
    document.querySelector('select[name="theme"]').dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();
    expect(save.disabled).toBe(false);
    wrapper.unmount();
  });

  test('workspace refresh rejection reports the error and releases the import lock', async () => {
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.endpoint.list = vi.fn()
      .mockResolvedValueOnce([{ id: 'old', name: 'Old', transport: 'serial', config: {} }])
      .mockResolvedValueOnce([{ id: 'new', name: 'New', transport: 'serial', config: {} }]);
    runtime.settings.getAll = vi.fn(async () => ({ theme: 'light' }));
    runtime.opcua.execute = vi.fn(async () => ({ profiles: [] }));
    runtime.workspace.import = vi.fn(async () => ({
      canceled: false, path: '/tmp/imported-workspace.json',
    }));
    runtime.storage.stats = vi.fn(async () => ({
      frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 0,
    }));
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime } },
    });
    await vi.waitFor(() => expect(wrapper.find('button[aria-label="打开设置"]').exists()).toBe(true));
    await wrapper.get('button[aria-label="打开设置"]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('button[data-action="import"]')).not.toBeNull());

    await flushPromises();
    const initialSettingsReads = runtime.settings.getAll.mock.calls.length;
    runtime.workspace.import.mockImplementationOnce(async () => {
      runtime.settings.getAll.mockRejectedValue(new Error('refresh settings failed'));
      return { canceled: false, path: '/tmp/imported-workspace.json' };
    });
    document.querySelector('button[data-action="import"]').click();

    await vi.waitFor(() => {
      expect(document.querySelector('.workspace-actions [role="alert"]')?.textContent)
        .toContain('refresh settings failed');
    });
    expect(document.querySelector('button[aria-label="关闭设置"]').disabled).toBe(false);
    expect(document.querySelector('button[data-action="import"]').disabled).toBe(false);
    expect(runtime.endpoint.list).toHaveBeenCalledTimes(2);
    expect(runtime.settings.getAll.mock.calls.length).toBeGreaterThan(initialSettingsReads);
    wrapper.unmount();
  });

  test('late initial endpoint failure is inert after a newer import refresh succeeds', async () => {
    const runtime = createUnavailableRuntimeAdapter('Electron');
    const initial = deferred();
    runtime.endpoint.list = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce([{ id: 'new', name: 'New', transport: 'serial', config: {} }]);
    runtime.settings.getAll = vi.fn()
      .mockResolvedValueOnce({ theme: 'light' })
      .mockResolvedValueOnce({ theme: 'dark' });
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { LinkLabShell: ShellStub } },
    });
    await vi.waitFor(() => expect(runtime.endpoint.list).toHaveBeenCalledTimes(1));
    await wrapper.get('.workspace-imported').trigger('click');
    await vi.waitFor(() => expect(runtime.endpoint.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(wrapper.get('.endpoint-names').text()).toBe('New'));
    await vi.waitFor(() => expect(wrapper.get('.load-state').text()).toBe('false|'));

    initial.reject(new Error('stale initial failure'));
    await flushPromises();

    expect(wrapper.get('.endpoint-names').text()).toBe('New');
    expect(wrapper.get('.load-state').text()).toBe('false|');
    wrapper.unmount();
  });

  test('late initial endpoint success is inert after a newer import refresh succeeds', async () => {
    const runtime = createUnavailableRuntimeAdapter('Electron');
    const initial = deferred();
    runtime.endpoint.list = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce([{ id: 'new', name: 'New', transport: 'serial', config: {} }]);
    runtime.settings.getAll = vi.fn()
      .mockResolvedValueOnce({ theme: 'light' })
      .mockResolvedValueOnce({ theme: 'dark' });
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { LinkLabShell: ShellStub } },
    });
    await vi.waitFor(() => expect(runtime.endpoint.list).toHaveBeenCalledTimes(1));
    await wrapper.get('.workspace-imported').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('.endpoint-names').text()).toBe('New'));
    await vi.waitFor(() => expect(wrapper.get('.load-state').text()).toBe('false|'));

    initial.resolve([{ id: 'old', name: 'Old', transport: 'serial', config: {} }]);
    await flushPromises();

    expect(wrapper.get('.endpoint-names').text()).toBe('New');
    expect(wrapper.get('.load-state').text()).toBe('false|');
    wrapper.unmount();
  });

  test('system theme changes preserve a dirty settings draft while import resets it', async () => {
    let mediaListener = () => {};
    const media = {
      matches: false,
      addEventListener: vi.fn((_name, listener) => { mediaListener = listener; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.endpoint.list = vi.fn(async () => []);
    let storedSettings = { theme: 'system', largeFont: false };
    runtime.settings.getAll = vi.fn(async () => ({ ...storedSettings }));
    runtime.opcua.execute = vi.fn(async () => ({ profiles: [] }));
    runtime.workspace.import = vi.fn(async () => {
      storedSettings = { theme: 'dark', largeFont: true };
      return { canceled: false, path: '/tmp/imported-workspace.json' };
    });
    runtime.storage.stats = vi.fn(async () => ({
      frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 0,
    }));
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime } },
    });
    await vi.waitFor(() => expect(wrapper.find('button[aria-label="打开设置"]').exists()).toBe(true));
    await wrapper.get('button[aria-label="打开设置"]').trigger('click');
    await flushPromises();
    const theme = document.querySelector('select[name="theme"]');
    const submit = document.querySelector('.settings-panel button[type="submit"]');
    theme.value = 'light';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();
    expect(submit.disabled).toBe(false);

    media.matches = true;
    mediaListener({ matches: true });
    await flushPromises();

    expect(theme.value).toBe('light');
    expect(submit.disabled).toBe(false);

    document.querySelector('button[data-action="import"]').click();
    await vi.waitFor(() => expect(theme.value).toBe('dark'));
    expect(document.querySelector('input[name="large-font"]').checked).toBe(true);
    expect(submit.disabled).toBe(true);
    wrapper.unmount();
  });

  test('native shutdown flushes renderer and native Modbus history before acknowledgement', async () => {
    const trace = [];
    let beforeShutdown = () => {};
    const unsubscribe = vi.fn();
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.endpoint.list = vi.fn(async () => []);
    runtime.modbusHistory.recordBatch = vi.fn(async () => { trace.push('collector.flush'); });
    runtime.modbusHistory.flush = vi.fn(async () => { trace.push('history.flush'); });
    runtime.modbusHistory.cleanup = vi.fn(async () => ({ deletedCount: 0, completedAt: 1 }));
    runtime.lifecycle.onBeforeShutdown = vi.fn((listener) => {
      beforeShutdown = listener;
      return unsubscribe;
    });
    runtime.lifecycle.readyForShutdown = vi.fn(async (requestId) => {
      trace.push(`ready:${requestId}`);
    });
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { LinkLabShell: ShellStub } },
    });
    await vi.waitFor(() => expect(wrapper.findComponent(ShellStub).exists()).toBe(true));
    wrapper.findComponent(ShellStub).props('model').modbusPointHistoryCollector.capture(
      appHistoryPointOutcome(),
    );

    await beforeShutdown({ requestId: 'shutdown-1' });

    expect(trace).toEqual(['collector.flush', 'history.flush', 'ready:shutdown-1']);
    expect(runtime.lifecycle.onBeforeShutdown).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('native shutdown is acknowledged even when Modbus history flush fails', async () => {
    let beforeShutdown = () => {};
    const ready = vi.fn(async () => true);
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.endpoint.list = vi.fn(async () => []);
    runtime.modbusHistory.flush = vi.fn(async () => { throw new Error('flush failed'); });
    runtime.modbusHistory.cleanup = vi.fn(async () => ({ deletedCount: 0, completedAt: 1 }));
    runtime.lifecycle.onBeforeShutdown = vi.fn((listener) => {
      beforeShutdown = listener;
      return () => {};
    });
    runtime.lifecycle.readyForShutdown = ready;
    const wrapper = mount(App, {
      global: { provide: { [runtimeAdapterKey]: runtime }, stubs: { LinkLabShell: ShellStub } },
    });
    await vi.waitFor(() => expect(wrapper.findComponent(ShellStub).exists()).toBe(true));

    await expect(beforeShutdown({ requestId: 'shutdown-failed' })).resolves.toBeUndefined();
    expect(ready).toHaveBeenCalledWith('shutdown-failed');
    wrapper.unmount();
  });
});

function appHistoryPointOutcome() {
  return {
    endpointId: 'master-1', sessionId: 'session-1',
    requestGroupId: 'environment', requestId: 'holding-registers', createdAt: 10,
    points: [{
      id: 'temperature', key: 'temperature', name: 'Temperature', enabled: true,
      dataType: 'uint16', unit: 'C', saveHistory: true, historyMode: 'on-change',
      raw: [42], value: 42, display: '42', quality: 'good', reason: null,
    }],
  };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}
