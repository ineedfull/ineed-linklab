import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { afterEach, describe, expect, test, vi } from 'vitest';

import HistoryWindow from '../../src/layouts/HistoryWindow.vue';
import LogList from '../../src/components/LogList.vue';
import SettingsPanel from '../../src/components/SettingsPanel.vue';
import StoragePanel from '../../src/components/StoragePanel.vue';
import WorkspaceActions from '../../src/components/WorkspaceActions.vue';
import { createUiPreferences } from '../../src/model/uiPreferences.js';
import { mutateSettings } from '../../src/model/settingsMutation.js';

const wrappers = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.documentElement.classList.remove('large-font', 'ui-preferences-loading');
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeMode;
});

describe('HistoryWindow', () => {
  test.each(['search', 'page', 'page-size'])('handles a failed %s without an unhandled UI error and allows retry', async (action) => {
    const errors = [];
    const rows = [1, 2].map((id) => ({
      id, endpointId: 'ep-1', sessionId: 'session-1', peerId: null,
      direction: 'in', format: 'text', framing: 'raw', payloadBase64: 'eA==',
      byteCount: 1, createdAt: 1_720_000_000_000 + id,
    }));
    const queryFrames = vi.fn(async (query) => ({ rows, total: 125, page: query.page, pageSize: query.pageSize }));
    const wrapper = track(mount(HistoryWindow, {
      props: { runtime: historyRuntime(queryFrames), kind: 'frames' },
      global: { config: { errorHandler: (error) => errors.push(error.message) } },
    }));
    await flushPromises();
    await wrapper.findAll('tbody tr')[1].trigger('click');
    queryFrames.mockRejectedValueOnce(new Error('数据库繁忙，请重试'));
    if (action === 'search') await wrapper.get('button[type="submit"]').trigger('click');
    else if (action === 'page') await wrapper.get('[aria-label="下一页"]').trigger('click');
    else await wrapper.get('[aria-label="每页条数"]').setValue('25');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('数据库繁忙');
    expect(wrapper.get('.history-detail__identity').text()).toContain('#2');
    expect(errors).toEqual([]);
    await wrapper.get('button[type="submit"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
  });

  test('loads once, keeps filters draft until Search, and supports keyboard row selection', async () => {
    const timestamp = new Date(2024, 6, 3, 17, 46, 40, 123).getTime();
    const queryFrames = vi.fn(async (query) => ({
      rows: [{
        id: 7, endpointId: 'ep-1', sessionId: 'session', peerId: 'peer-1',
        direction: 'in', format: 'text', framing: 'line', payloadBase64: 'aGVsbG8=',
        byteCount: 5, createdAt: timestamp,
      }],
      total: 125, page: query.page, pageSize: query.pageSize,
    }));
    const wrapper = track(mount(HistoryWindow, {
      props: {
        runtime: historyRuntime(queryFrames),
        kind: 'frames',
        endpointId: 'ep-1',
      },
    }));
    await flushPromises();
    expect(queryFrames).toHaveBeenCalledTimes(1);
    await wrapper.find('input[type="search"]').setValue('hello');
    await wrapper.find('select[name="direction"]').setValue('in');
    expect(queryFrames).toHaveBeenCalledTimes(1);
    await wrapper.find('button[type="submit"]').trigger('click');
    await flushPromises();
    expect(queryFrames).toHaveBeenCalledTimes(2);
    expect(queryFrames).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: 'ep-1', search: 'hello', direction: 'in', page: 1, pageSize: 50,
    }));
    expect(wrapper.find('.history-filters select[name="page-size"]').exists()).toBe(false);
    expect(wrapper.find('.history-pager select[name="page-size"]').exists()).toBe(true);
    expect(wrapper.find('.history-window__state').exists()).toBe(true);
    expect(wrapper.find('.history-pager__total').text()).toBe('共 125 条');
    expect(wrapper.find('.history-pager').text()).toContain('第 1 / 3 页');
    expect(wrapper.find('.history-pager select[name="page-size"]').findAll('option')
      .map((option) => option.text().trim())).toEqual([
      '25 / 页', '50 / 页', '100 / 页', '200 / 页',
    ]);
    expect(wrapper.text()).toContain('2024-07-03 17:46:40.123');
    expect(wrapper.text()).not.toContain('T17:46:40.123');
    expect(wrapper.find('.history-detail__identity').text()).toContain('7');
    expect(wrapper.find('.history-detail__metadata').text()).toContain('text');
    expect(wrapper.find('.history-detail__endpoint').text()).toContain('peer-1');
    expect(wrapper.find('.history-detail__payload').text()).toContain('hello');
    const row = wrapper.find('tbody tr');
    expect(row.attributes('tabindex')).toBe('0');
    expect(row.attributes('aria-selected')).toBe('true');
    await row.trigger('keydown', { key: ' ' });
    expect(row.attributes('aria-selected')).toBe('true');
  });

  test('shows bilingual log levels in filters, rows, and details', async () => {
    const queryLogs = vi.fn(async () => ({
      rows: [
        { id: 1, endpointId: 'ep-1', level: 'warn', source: 'runtime', message: 'current', createdAt: 1 },
        { id: 2, endpointId: 'ep-1', level: 'warning', source: 'legacy', message: 'old', createdAt: 2 },
      ],
      total: 2, page: 1, pageSize: 50,
    }));
    const wrapper = track(mount(HistoryWindow, {
      props: {
        runtime: { history: { queryFrames: vi.fn(), queryLogs } },
        kind: 'logs',
      },
    }));
    await flushPromises();

    const levelOptions = wrapper.find('.history-filters select').findAll('option');
    expect(levelOptions.map((option) => [option.element.value, option.text().trim()])).toEqual([
      ['', '全部级别'],
      ['debug', 'DEBUG 调试'],
      ['info', 'INFO 信息'],
      ['warn', 'WARN 警告'],
      ['error', 'ERROR 错误'],
    ]);
    expect(wrapper.findAll('tbody tr').map((row) => row.findAll('td')[2].text())).toEqual([
      'WARN 警告', 'WARN 警告',
    ]);
    expect(wrapper.find('.history-detail__metadata').text()).toContain('WARN 警告');
    await wrapper.findAll('tbody tr')[1].trigger('click');
    expect(wrapper.find('.history-detail__metadata').text()).toContain('WARN 警告');
  });

  test('renders HEX history byte-for-byte in the table preview and detail', async () => {
    const queryFrames = vi.fn(async (query) => ({
      rows: [{
        id: 8, endpointId: 'ep-hex', direction: 'in', format: 'hex', framing: 'raw',
        payloadBase64: 'AID/', byteCount: 3, createdAt: 1_720_000_000_123,
      }],
      total: 1, page: query.page, pageSize: query.pageSize,
    }));
    const wrapper = track(mount(HistoryWindow, {
      props: { runtime: historyRuntime(queryFrames), kind: 'frames' },
    }));
    await flushPromises();

    expect(wrapper.find('tbody tr').findAll('td')[5].text()).toBe('00 80 FF');
    expect(wrapper.find('.history-detail__payload pre').text()).toBe('00 80 FF');
    expect(wrapper.text()).not.toContain('\uFFFD');
  });

  test('bounds table previews using preferences while keeping selected HEX details complete', async () => {
    const queryFrames = vi.fn(async (query) => ({
      rows: [{
        id: 9, endpointId: 'ep-hex', direction: 'in', format: 'hex', framing: 'raw',
        payloadBase64: 'AID/', byteCount: 3, createdAt: 1_720_000_000_123,
      }],
      total: 1, page: query.page, pageSize: query.pageSize,
    }));
    const wrapper = track(mount(HistoryWindow, {
      props: {
        runtime: historyRuntime(queryFrames),
        kind: 'frames',
        preferences: { values: { previewByteLimit: 2 } },
      },
    }));
    await flushPromises();

    expect(wrapper.find('tbody tr').findAll('td')[5].text()).toBe('00 80 ...（已截断）');
    expect(wrapper.find('.history-detail__payload pre').text()).toBe('00 80 FF');
  });

  test('labels all serial receive and send framing modes in frame details', async () => {
    const framing = ['raw', 'delimiter', 'fixed', 'idle', 'none', 'line', 'length-prefix'];
    const queryFrames = vi.fn(async (query) => ({
      rows: framing.map((value, index) => ({
        id: index + 1, endpointId: 'ep-1', direction: 'in', format: 'text', framing: value,
        payloadBase64: 'eA==', byteCount: 1, createdAt: index + 1,
      })),
      total: framing.length, page: query.page, pageSize: query.pageSize,
    }));
    const wrapper = track(mount(HistoryWindow, {
      props: { runtime: historyRuntime(queryFrames), kind: 'frames' },
    }));
    await flushPromises();

    for (const [index, label] of [
      '原始数据', '分隔符', '固定长度', '空闲超时', '无', '按行', '长度前缀',
    ].entries()) {
      await wrapper.findAll('tbody tr')[index].trigger('click');
      expect(wrapper.find('.history-detail__metadata').text()).toContain(label);
    }
  });
});

describe('LogList', () => {
  test('shows bilingual levels and styles warn and legacy warning identically', () => {
    const timestamp = new Date(2024, 6, 3, 17, 46, 40, 123).getTime();
    const wrapper = track(mount(LogList, {
      props: {
        logs: [
          { id: 1, level: 'warn', message: 'current', createdAt: timestamp },
          { id: 2, level: 'warning', message: 'legacy', createdAt: 2 },
          { id: 3, level: 'debug', message: 'detail', createdAt: 3 },
          { id: 4, level: 'error', message: 'failure', createdAt: 4 },
        ],
      },
    }));

    expect(wrapper.findAll('.log-list__level').map((level) => level.text())).toEqual([
      'WARN 警告', 'WARN 警告', 'DEBUG 调试', 'ERROR 错误',
    ]);
    expect(wrapper.findAll('.log-level--warning')).toHaveLength(2);
    expect(wrapper.text()).toContain('2024-07-03 17:46:40.123');
    expect(wrapper.text()).not.toContain('T17:46:40.123');
  });
});

describe('SettingsPanel', () => {
  test('fallback appearance save preserves acceptance documents written after opening the dialog', async () => {
    let acceptanceWorkspace = '{"version":1,"plans":[],"reports":[]}';
    const runtime = { settings: { getAll: vi.fn(async () => ({ theme: 'light', acceptanceWorkspace })), saveAll: vi.fn(async () => {}) }, storage: { stats: vi.fn(async () => emptyStats()) }, workspace: {} };
    const wrapper = track(mount(SettingsPanel, { global: { stubs: { Teleport: true } }, props: { open: true, runtime } }));
    await flushPromises(); acceptanceWorkspace = '{"version":1,"plans":[],"reports":[] }';
    await wrapper.get('select[name="theme"]').setValue('dark'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(runtime.settings.saveAll).toHaveBeenCalledWith(expect.objectContaining({ acceptanceWorkspace }));
  });
  test('fallback appearance save reports domain-corrupt acceptance data without rewriting settings', async () => {
    let acceptanceWorkspace = '{"version":1,"plans":[],"reports":[]}';
    const runtime = { settings: { getAll: vi.fn(async () => ({ theme: 'light', acceptanceWorkspace })), saveAll: vi.fn(async () => {}) }, storage: { stats: vi.fn(async () => emptyStats()) }, workspace: {} };
    const wrapper = track(mount(SettingsPanel, { global: { stubs: { Teleport: true } }, props: { open: true, runtime } }));
    await flushPromises(); acceptanceWorkspace = '{"version":1,"plans":[{}],"reports":[]}';
    await wrapper.get('select[name="theme"]').setValue('dark'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(runtime.settings.saveAll).not.toHaveBeenCalled(); expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  test('fallback save waits for protocol settings writes before reading the latest profiles', async () => {
    let release;
    let rows = [];
    const runtime = {
      settings: { getAll: vi.fn(async () => ({ theme: 'light', stompProfiles: rows })), saveAll: vi.fn(async () => {}) },
      storage: { stats: vi.fn(async () => emptyStats()) }, workspace: {},
    };
    const wrapper = track(mount(SettingsPanel, { global: { stubs: { Teleport: true } }, props: { open: true, runtime } }));
    await flushPromises();
    const write = mutateSettings(runtime, async () => { await new Promise(resolve => { release = resolve; }); rows = [{ id: 'latest' }]; });
    await flushPromises();
    await wrapper.get('select[name="theme"]').setValue('dark');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(runtime.settings.saveAll).not.toHaveBeenCalled();
    release(); await write; await flushPromises();
    expect(runtime.settings.saveAll).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark', stompProfiles: [{ id: 'latest' }] }));
  });
  test('loads typed settings and exposes draft, save, loading, and error states', async () => {
    const saveAll = vi.fn(async () => true);
    const wrapper = track(mount(SettingsPanel, {
      global: { stubs: { Teleport: true } },
      props: {
        open: true,
        runtime: {
          settings: { getAll: vi.fn(async () => ({ theme: 'dark' })), saveAll },
          storage: { stats: vi.fn(async () => emptyStats()), clearHistory: vi.fn() },
          workspace: { export: vi.fn(), import: vi.fn() },
        },
      },
    }));
    await flushPromises();
    expect(wrapper.find('select[name="log-level"]').exists()).toBe(true);
    expect(wrapper.find('select[name="log-level"]').findAll('option')
      .map((option) => [option.element.value, option.text().trim()])).toEqual([
      ['debug', 'DEBUG 调试'],
      ['info', 'INFO 信息'],
      ['warn', 'WARN 警告'],
      ['error', 'ERROR 错误'],
    ]);
    expect(wrapper.find('input[name="realtime-frame-limit"]').exists()).toBe(true);
    expect(wrapper.find('input[name="realtime-log-limit"]').exists()).toBe(true);
    expect(wrapper.find('input[name="preview-byte-limit"]').exists()).toBe(true);
    expect(wrapper.find('input[name="realtime-frame-limit"]').attributes('max')).toBe('50000');
    expect(wrapper.find('input[name="realtime-log-limit"]').attributes('max')).toBe('50000');
    expect(wrapper.find('input[name="preview-byte-limit"]').attributes('max')).toBe('16777216');
    expect(wrapper.find('select[name="default-framing"]').exists()).toBe(true);
    expect(wrapper.find('select[name="time-display-mode"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('时间显示');
    expect(wrapper.find('input[name="auto-scroll"]').exists()).toBe(true);
    expect(wrapper.find('select[name="theme"]').element.value).toBe('dark');
    expect(wrapper.find('input[name="large-font"]').exists()).toBe(true);
    expect(wrapper.find('select[name="modbus-point-history-retention"]').findAll('option')
      .map((option) => [option.element.value, option.text().trim()])).toEqual([
      ['7-days', '保留 7 天'],
      ['30-days', '保留 30 天'],
      ['90-days', '保留 90 天'],
      ['forever', '永久保留'],
    ]);
    expect(wrapper.find('select[name="modbus-point-history-retention"]').element.value).toBe('30-days');
    expect(wrapper.findAll('.settings-section').at(-1).text()).toContain('数据存储');
    await wrapper.find('select[name="theme"]').setValue('light');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(saveAll).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
  });

  test('successful saves apply theme immediately and failed saves preserve the applied theme', async () => {
    const saveAll = vi.fn(async (value) => {
      if (value.theme === 'system') throw new Error('save rejected');
    });
    const runtime = {
      settings: { getAll: vi.fn(async () => ({ theme: 'light' })), saveAll },
      storage: { stats: vi.fn(async () => emptyStats()), clearHistory: vi.fn() },
      workspace: { export: vi.fn(), import: vi.fn() },
    };
    const controller = createUiPreferences(runtime);
    await controller.load();
    const wrapper = track(mount(SettingsPanel, {
      global: { stubs: { Teleport: true } },
      props: {
        open: true, runtime, preferences: controller.state.values, saveCommand: controller.save,
      },
    }));
    await flushPromises();
    await wrapper.find('select[name="theme"]').setValue('dark');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(document.documentElement.dataset.theme).toBe('dark');

    await wrapper.find('select[name="theme"]').setValue('system');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('save rejected');
    expect(document.documentElement.dataset.theme).toBe('dark');
    controller.dispose();
  });

  test('successful workspace import resets an open dirty draft to the imported revision', async () => {
    const saveAll = vi.fn(async () => true);
    const imported = { theme: 'dark', largeFont: true, realtimeFrameLimit: 4321 };
    const runtime = {
      settings: { getAll: vi.fn(async () => imported), saveAll },
      storage: { stats: vi.fn(async () => emptyStats()), clearHistory: vi.fn() },
      workspace: {
        export: vi.fn(),
        import: vi.fn(async () => ({ canceled: false, path: '/tmp/imported.json' })),
      },
    };
    const Harness = defineComponent({
      components: { SettingsPanel },
      setup() {
        const preferences = ref({ theme: 'light', largeFont: false });
        const preferenceRevision = ref(1);
        async function refreshImportedPreferences() {
          preferences.value = await runtime.settings.getAll();
          preferenceRevision.value += 1;
        }
        return { preferences, preferenceRevision, refreshImportedPreferences, runtime, saveAll };
      },
      template: '<SettingsPanel :open="true" :runtime="runtime" :preferences="preferences" :preference-revision="preferenceRevision" :save-command="saveAll" :workspace-imported-command="refreshImportedPreferences" />',
    });
    const wrapper = track(mount(Harness, { attachTo: document.body }));
    await flushPromises();
    const theme = document.querySelector('select[name="theme"]');
    theme.value = 'system';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(document.querySelector('button[type="submit"]').disabled).toBe(false);

    document.querySelector('button[data-action="import"]').click();
    await flushPromises();

    expect(document.querySelector('select[name="theme"]').value).toBe('dark');
    expect(document.querySelector('input[name="large-font"]').checked).toBe(true);
    expect(document.querySelector('input[name="realtime-frame-limit"]').value).toBe('4321');
    expect(document.querySelector('button[type="submit"]').disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(saveAll).not.toHaveBeenCalled();

    document.querySelector('select[name="theme"]').value = 'light';
    document.querySelector('select[name="theme"]').dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    wrapper.vm.preferences = { theme: 'system', largeFont: false };
    wrapper.vm.preferenceRevision = 1;
    await flushPromises();
    expect(document.querySelector('select[name="theme"]').value).toBe('light');
    document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(saveAll).toHaveBeenCalledWith(expect.objectContaining({
      theme: 'light', largeFont: true, realtimeFrameLimit: 4321,
    }));
  });

  test('traps focus, closes on idle Escape, and ignores Escape while saving', async () => {
    const save = deferred();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const wrapper = track(mount(SettingsPanel, {
      attachTo: document.body,
      props: {
        open: false,
        runtime: {
          settings: { getAll: vi.fn(async () => ({ theme: 'light' })), saveAll: () => save.promise },
          storage: { stats: vi.fn(async () => emptyStats()), clearHistory: vi.fn() },
          workspace: { export: vi.fn(), import: vi.fn() },
        },
      },
    }));
    await wrapper.setProps({ open: true });
    await flushPromises();
    const dialog = document.querySelector('.settings-panel');
    const controls = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')];
    expect(document.activeElement).toBe(document.querySelector('[aria-label="关闭设置"]'));
    controls.at(-1).focus();
    controls.at(-1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(controls[0]);
    controls[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(controls.at(-1));

    const theme = document.querySelector('select[name="theme"]');
    theme.value = 'dark';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
    dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(wrapper.emitted('close')).toBeUndefined();
    save.resolve(true);
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.setProps({ open: false });
    await flushPromises();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  test('workspace failure releases the unified busy state', async () => {
    const importGate = deferred();
    const importWorkspace = vi.fn(() => importGate.promise);
    track(mount(SettingsPanel, {
      attachTo: document.body,
      props: {
        open: true,
        runtime: {
          settings: { getAll: vi.fn(async () => ({ theme: 'light' })), saveAll: vi.fn() },
          storage: { stats: vi.fn(async () => emptyStats()), clearHistory: vi.fn() },
          workspace: { export: vi.fn(), import: importWorkspace },
        },
      },
    }));
    await flushPromises();
    const theme = document.querySelector('select[name="theme"]');
    theme.value = 'dark';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('button[data-action="import"]').click();
    await flushPromises();
    expect(importWorkspace).toHaveBeenCalledTimes(1);
    expect(document.querySelector('button[aria-label="关闭设置"]').disabled).toBe(true);
    expect(document.querySelector('button[type="submit"]').disabled).toBe(true);

    importGate.reject(new Error('invalid workspace'));
    await flushPromises();

    expect(document.querySelector('[role="alert"]').textContent).toContain('invalid workspace');
    expect(document.querySelector('button[aria-label="关闭设置"]').disabled).toBe(false);
    expect(document.querySelector('button[type="submit"]').disabled).toBe(false);
  });

  test('pending settings save rejects workspace operations', async () => {
    const saveGate = deferred();
    const importWorkspace = vi.fn();
    const wrapper = track(mount(SettingsPanel, {
      global: { stubs: { Teleport: true } },
      props: {
        open: true,
        runtime: {
          settings: { getAll: vi.fn(async () => ({ theme: 'light' })), saveAll: vi.fn() },
          storage: { stats: vi.fn(async () => emptyStats()), clearHistory: vi.fn() },
          workspace: { export: vi.fn(), import: importWorkspace },
        },
        saveCommand: vi.fn(() => saveGate.promise),
      },
    }));
    await flushPromises();
    await wrapper.find('select[name="theme"]').setValue('dark');
    await wrapper.find('form').trigger('submit');
    await wrapper.find('button[data-action="import"]').trigger('click');

    expect(importWorkspace).not.toHaveBeenCalled();
    expect(wrapper.find('button[data-action="import"]').attributes('disabled')).toBeDefined();
    saveGate.resolve(true);
    await flushPromises();
  });
});

describe('StoragePanel and WorkspaceActions', () => {
  test('renders nonzero storage statistics after the initial refresh', async () => {
    const runtime = {
      storage: {
        stats: async () => ({
          frameCount: 36,
          logCount: 48,
          sendHistoryCount: 8,
          totalCount: 92,
          diskBytes: 262144,
          modbusPointHistoryCount: 12,
          modbusPointHistoryEstimatedBytes: 2048,
          modbusPointHistoryLastCleanupAt: 1_720_000_000_123,
        }),
        clearHistory: async () => ({ cleared: true }),
      },
    };
    const wrapper = track(mount(StoragePanel, {
      props: {
        runtime,
        modbusHistoryStatus: {
          pendingCount: 3, droppedCount: 2, failedBatchCount: 1,
          lastFlushedAt: 1_720_000_000_000, lastError: 'database offline',
        },
      },
    }));

    await flushPromises();

    expect(wrapper.text()).toContain('36');
    expect(wrapper.text()).toContain('48');
    expect(wrapper.text()).toContain('256 KB');
    expect(wrapper.text()).toContain('Modbus 数据点');
    expect(wrapper.text()).toContain('12');
    expect(wrapper.text()).toContain('2 KB');
    expect(wrapper.text()).toContain('待写入 3 条');
    expect(wrapper.get('.modbus-history-storage-warning').text()).toContain('丢弃 2 条');
    expect(wrapper.get('.modbus-history-storage-warning').text()).toContain('失败批次 1');
    expect(wrapper.get('.modbus-history-storage-warning').text()).toContain('database offline');
  });

  test('healthy Modbus point-history storage does not render a warning', async () => {
    const wrapper = track(mount(StoragePanel, {
      props: {
        runtime: {
          storage: { stats: async () => emptyStats(), clearHistory: async () => ({}) },
        },
        modbusHistoryStatus: {
          pendingCount: 0, droppedCount: 0, failedBatchCount: 0,
          lastFlushedAt: null, lastError: null,
        },
      },
    }));
    await flushPromises();

    expect(wrapper.find('.modbus-history-storage-warning').exists()).toBe(false);
  });

  test('confirms config preservation, flushes, clears, and refreshes counts', async () => {
    const calls = [];
    const confirm = vi.fn(() => true);
    const runtime = {
      persistence: { flush: async () => calls.push('flush') },
      storage: {
        clearHistory: async () => calls.push('clear'),
        stats: async () => { calls.push('stats'); return emptyStats(); },
      },
    };
    const wrapper = track(mount(StoragePanel, { props: { runtime, confirm } }));
    await flushPromises();
    await wrapper.find('button[data-action="clear-history"]').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/配置.*保留/));
    expect(calls.slice(-3)).toEqual(['flush', 'clear', 'stats']);
    expect(wrapper.text()).toContain('发送记录');
    expect(wrapper.text()).toContain('0 KB');
  });

  test('workspace actions treat cancel quietly and clear prior success on errors', async () => {
    const exportWorkspace = vi.fn()
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: false, path: '/tmp/export.json' });
    const importWorkspace = vi.fn().mockRejectedValue(new Error('bad schema'));
    const wrapper = track(mount(WorkspaceActions, {
      props: { runtime: { workspace: { export: exportWorkspace, import: importWorkspace } } },
    }));
    await wrapper.find('button[data-action="export"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.emitted('imported')).toBeUndefined();
    await wrapper.find('button[data-action="export"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="status"]').text()).toContain('export.json');
    await wrapper.find('button[data-action="import"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('bad schema');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  test('workspace import emits only for a current successful completion', async () => {
    const pending = deferred();
    const wrapper = track(mount(WorkspaceActions, {
      props: {
        runtime: {
          workspace: { export: vi.fn(), import: vi.fn(() => pending.promise) },
        },
      },
    }));
    await wrapper.find('button[data-action="import"]').trigger('click');
    wrapper.unmount();
    pending.resolve({ canceled: false, path: '/tmp/late.json' });
    await flushPromises();
    expect(wrapper.emitted('imported')).toBeUndefined();

    const current = track(mount(WorkspaceActions, {
      props: {
        runtime: {
          workspace: { export: vi.fn(), import: vi.fn(async () => ({ canceled: false, path: '/tmp/current.json' })) },
        },
      },
    }));
    await current.find('button[data-action="import"]').trigger('click');
    await flushPromises();
    expect(current.emitted('imported')).toEqual([[{ canceled: false, path: '/tmp/current.json' }]]);
  });

  test('unmount does not write parent state while an imported workspace callback is pending', async () => {
    const refreshGate = deferred();
    const workspaceImportedCommand = vi.fn(() => refreshGate.promise);
    const parentWrites = [];
    const wrapper = mount(WorkspaceActions, {
      props: {
        runtime: {
          workspace: {
            export: vi.fn(),
            import: vi.fn(async () => ({ canceled: false, path: '/tmp/imported.json' })),
          },
        },
        workspaceImportedCommand,
        onBusyChange: (value) => parentWrites.push(['busy', value]),
        onImported: (value) => parentWrites.push(['imported', value]),
      },
    });
    await wrapper.find('button[data-action="import"]').trigger('click');
    await vi.waitFor(() => expect(workspaceImportedCommand).toHaveBeenCalledTimes(1));
    const writesBeforeUnmount = structuredClone(parentWrites);

    wrapper.unmount();
    expect(parentWrites).toEqual(writesBeforeUnmount);

    refreshGate.resolve();
    await flushPromises();
    expect(parentWrites).toEqual(writesBeforeUnmount);
  });
});

function historyRuntime(queryFrames) {
  return { history: { queryFrames, queryLogs: vi.fn() } };
}

function emptyStats() {
  return {
    frameCount: 0, logCount: 0, sendHistoryCount: 0, totalCount: 0, diskBytes: 0,
    modbusPointHistoryCount: 0, modbusPointHistoryEstimatedBytes: 0,
    modbusPointHistoryLastCleanupAt: null,
  };
}

function track(wrapper) {
  wrappers.push(wrapper);
  return wrapper;
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}
