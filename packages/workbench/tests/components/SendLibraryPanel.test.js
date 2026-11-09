import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';

import SendLibraryPanel from '../../src/components/SendLibraryPanel.vue';

describe('SendLibraryPanel', () => {
  test.each(['delete acknowledgement ready first', 'rename acknowledgement ready first'])(
    'same-ID delete waits for pending rename: %s', async (order) => {
      const { runtime, rename, deletion, rows, events } = renameDeleteRuntime();
      const wrapper = mountPanel(runtime);
      await flushPromises();
      await submitRename(wrapper, 'A', 'Renamed A');
      await wrapper.get('button[aria-label="删除模板 A"]').trigger('click');
      await flushPromises();
      expect(events).toEqual(['rename']);
      expect(wrapper.find('.send-library__loading').exists()).toBe(true);
      if (order.startsWith('delete')) deletion.resolve();
      rename.resolve();
      await flushPromises();
      expect(events).toEqual(['rename', 'delete']);
      if (order.startsWith('rename')) {
        expect(wrapper.find('.send-library__loading').exists()).toBe(true);
        expect(wrapper.find('button[aria-label="载入模板 Renamed A"]').exists()).toBe(true);
        deletion.resolve();
      }
      await flushPromises();
      expect(rows.has('A')).toBe(false);
      expect(wrapper.findAll('.send-library__item')).toHaveLength(0);
      expect(wrapper.find('.send-library__loading').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  test('different-ID delete proceeds while same-ID rename/delete remain pending', async () => {
    const { runtime, rename, deletion, rows, events } = renameDeleteRuntime();
    rows.set('B', template({ id: 'B', name: 'B' }));
    const deleteA = runtime.template.delete.getMockImplementation();
    runtime.template.delete.mockImplementation(async (id) => {
      if (id === 'A') return deleteA(id);
      events.push('delete B');
      return rows.delete(id);
    });
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await submitRename(wrapper, 'A', 'Renamed A');
    await wrapper.get('button[aria-label="删除模板 A"]').trigger('click');
    await wrapper.get('button[aria-label="删除模板 B"]').trigger('click');
    await flushPromises();
    expect(events).toEqual(['rename', 'delete B']);
    expect(wrapper.find('button[aria-label="载入模板 B"]').exists()).toBe(false);
    expect(wrapper.find('.send-library__loading').exists()).toBe(true);
    rename.resolve();
    deletion.resolve();
    await flushPromises();
    expect(rows.size).toBe(0);
    expect(wrapper.findAll('.send-library__item')).toHaveLength(0);
    expect(wrapper.find('.send-library__loading').exists()).toBe(false);
    wrapper.unmount();
  });

  test('a failed rename releases the ID queue and can be retried', async () => {
    const runtime = createRuntime({ templates: [template({ id: 'A', name: 'A' })] });
    runtime.template.save.mockRejectedValueOnce(new Error('rename busy'));
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await submitRename(wrapper, 'A', 'Renamed A');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('rename busy');
    expect(wrapper.find('.send-library__loading').exists()).toBe(false);
    await wrapper.get('.send-library__rename').trigger('submit');
    await flushPromises();
    expect(wrapper.find('button[aria-label="载入模板 Renamed A"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get('button[aria-label="删除模板 Renamed A"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.send-library__item')).toHaveLength(0);
    wrapper.unmount();
  });

  test('failed queued delete retains the successful rename and delete retry removes it', async () => {
    const { runtime, rename, deletion, rows } = renameDeleteRuntime();
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await submitRename(wrapper, 'A', 'Renamed A');
    await wrapper.get('button[aria-label="删除模板 A"]').trigger('click');
    rename.resolve();
    deletion.reject(new Error('delete busy'));
    await flushPromises();
    expect(rows.get('A').name).toBe('Renamed A');
    expect(wrapper.find('button[aria-label="载入模板 Renamed A"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('delete busy');
    expect(wrapper.find('.send-library__loading').exists()).toBe(false);
    runtime.template.delete.mockImplementationOnce(async (id) => rows.delete(id));
    await wrapper.get('button[aria-label="删除模板 Renamed A"]').trigger('click');
    await flushPromises();
    expect(rows.has('A')).toBe(false);
    expect(wrapper.findAll('.send-library__item')).toHaveLength(0);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test.each(['endpoint', 'tab', 'unmount'])(
    'queued rename/delete does not publish stale state after %s change', async (kind) => {
      const { runtime, rename, deletion, rows } = renameDeleteRuntime();
      const wrapper = mountPanel(runtime);
      await flushPromises();
      await submitRename(wrapper, 'A', 'Renamed A');
      await wrapper.get('button[aria-label="删除模板 A"]').trigger('click');
      if (kind === 'endpoint') {
        runtime.template.list.mockResolvedValueOnce([template({ id: 'A', name: 'Other endpoint', endpointId: 'serial-2' })]);
        await wrapper.setProps({ endpointId: 'serial-2' });
      } else if (kind === 'tab') {
        await wrapper.get('button[role="tab"]:nth-child(2)').trigger('click');
      } else wrapper.unmount();
      await flushPromises();
      rename.resolve();
      deletion.resolve();
      await flushPromises();
      expect(rows.has('A')).toBe(false);
      if (kind === 'endpoint') expect(wrapper.find('button[aria-label="载入模板 Other endpoint"]').exists()).toBe(true);
      if (kind === 'tab') {
        await wrapper.get('button[role="tab"]:nth-child(1)').trigger('click');
        await flushPromises();
        expect(wrapper.findAll('.send-library__item')).toHaveLength(0);
      }
      expect(wrapper.emitted('load')).toBeUndefined();
      if (kind !== 'unmount') {
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        expect(wrapper.find('.send-library__loading').exists()).toBe(false);
        wrapper.unmount();
      }
    },
  );

  test('late tab reload cannot resurrect a successfully deleted template', async () => {
    const item = template({ id: 'A', name: 'A' });
    const reload = deferred();
    const runtime = createRuntime({ templates: [item] });
    runtime.template.list.mockResolvedValueOnce([item]).mockImplementationOnce(() => reload.promise);
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await wrapper.get('button[role="tab"]:nth-child(2)').trigger('click');
    await flushPromises();
    await wrapper.get('button[role="tab"]:nth-child(1)').trigger('click');
    await wrapper.get('button[aria-label="删除模板 A"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('button[aria-label="载入模板 A"]').exists()).toBe(false);
    expect(wrapper.find('.send-library__loading').exists()).toBe(true);
    reload.resolve([item]);
    await flushPromises();
    expect(wrapper.find('button[aria-label="载入模板 A"]').exists()).toBe(false);
    expect(wrapper.find('.send-library__loading').exists()).toBe(false);
    wrapper.unmount();
  });

  test.each([
    ['tab', 'delete-first'], ['tab', 'reload-first'],
    ['endpoint', 'delete-first'], ['endpoint', 'reload-first'],
  ])('pending delete stays removed after %s return with %s completion', async (switchKind, order) => {
    const item = template({ id: 'A', name: 'A' });
    const deletion = deferred();
    const reload = deferred();
    const runtime = createRuntime({ templates: [item] });
    runtime.template.delete.mockImplementationOnce(() => deletion.promise);
    runtime.template.list.mockResolvedValueOnce([item]);
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await wrapper.get('button[aria-label="删除模板 A"]').trigger('click');
    if (switchKind === 'tab') {
      await wrapper.get('button[role="tab"]:nth-child(2)').trigger('click');
      await flushPromises();
      runtime.template.list.mockImplementationOnce(() => reload.promise);
      await wrapper.get('button[role="tab"]:nth-child(1)').trigger('click');
    } else {
      runtime.template.list.mockResolvedValueOnce([template({ id: 'A', name: 'Other endpoint', endpointId: 'serial-2' })]);
      await wrapper.setProps({ endpointId: 'serial-2' });
      await flushPromises();
      runtime.template.list.mockImplementationOnce(() => reload.promise);
      await wrapper.setProps({ endpointId: 'serial-1' });
    }
    if (order === 'delete-first') {
      deletion.resolve(true);
      await flushPromises();
      expect(wrapper.find('.send-library__loading').exists()).toBe(true);
      reload.resolve([item]);
    } else {
      reload.resolve([item]);
      await flushPromises();
      deletion.resolve(true);
    }
    await flushPromises();
    expect(wrapper.find('button[aria-label="载入模板 A"]').exists()).toBe(false);
    expect(wrapper.find('.send-library__loading').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test.each([['A first', ['A', 'B']], ['B first', ['B', 'A']]])(
    'concurrent successful deletes remove both loadable rows: %s', async (_label, order) => {
      const gates = { A: deferred(), B: deferred() };
      const runtime = createRuntime({ templates: [template({ id: 'A', name: 'A' }), template({ id: 'B', name: 'B' })] });
      runtime.template.delete.mockImplementation((id) => gates[id].promise);
      const wrapper = mountPanel(runtime);
      await flushPromises();
      await wrapper.get('button[aria-label="删除模板 A"]').trigger('click');
      await wrapper.get('button[aria-label="删除模板 B"]').trigger('click');
      for (const [index, id] of order.entries()) {
        gates[id].resolve(true);
        await flushPromises();
        expect(wrapper.find(`button[aria-label="载入模板 ${id}"]`).exists()).toBe(false);
        if (index === 0) expect(wrapper.find('.send-library__loading').exists()).toBe(true);
      }
      expect(wrapper.findAll('.send-library__item')).toHaveLength(0);
      expect(wrapper.find('.send-library__loading').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  test('old delete cannot remove same-id template or show error after endpoint switch', async () => {
    const gate = deferred();
    const runtime = createRuntime({ templates: [template({ id: 'same', name: 'Old' })] });
    runtime.template.delete.mockImplementationOnce(() => gate.promise);
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await wrapper.get('button[aria-label="删除模板 Old"]').trigger('click');
    runtime.template.list.mockResolvedValueOnce([template({ id: 'same', name: 'Current', endpointId: 'serial-2' })]);
    await wrapper.setProps({ endpointId: 'serial-2' });
    await flushPromises();
    gate.resolve(true);
    await flushPromises();
    expect(wrapper.find('button[aria-label="载入模板 Current"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('failed delete is retained and retry succeeds', async () => {
    const runtime = createRuntime({ templates: [template()] });
    runtime.template.delete.mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(true);
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await wrapper.get('button[aria-label="删除模板 Ping"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('button[aria-label="载入模板 Ping"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('busy');
    await wrapper.get('button[aria-label="删除模板 Ping"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('button[aria-label="载入模板 Ping"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('late delete failure after unmount is inert', async () => {
    const gate = deferred();
    const runtime = createRuntime({ templates: [template()] });
    runtime.template.delete.mockImplementation(() => gate.promise);
    const wrapper = mountPanel(runtime);
    await flushPromises();
    await wrapper.get('button[aria-label="删除模板 Ping"]').trigger('click');
    wrapper.unmount();
    gate.reject(new Error('late failure'));
    await flushPromises();
    expect(wrapper.emitted('load')).toBeUndefined();
  });

  test('saves, loads, renames, and deletes templates through a structured-clone boundary', async () => {
    const original = template({ id: 'template-1', name: 'Ping' });
    const saved = [];
    const runtime = createRuntime({ templates: [original] });
    runtime.template.save.mockImplementation(async (value) => {
      // Electron IPC rejects Vue proxies, including nested template targets.
      const result = { ...structuredClone(value), createdAt: 100, updatedAt: 200 };
      saved.push(result);
      return result;
    });
    const wrapper = mountPanel(runtime);
    await flushPromises();

    expect(runtime.template.list).toHaveBeenCalledWith('serial-1');
    await wrapper.get('button[aria-label="载入模板 Ping"]').trigger('click');
    expect(wrapper.emitted('load')?.[0]).toEqual([original]);

    await wrapper.get('input[name="template-name"]').setValue('Status');
    await wrapper.get('.send-library__save').trigger('submit');
    await flushPromises();
    expect(runtime.template.save).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: 'serial-1',
      name: 'Status',
      format: 'text',
      framing: 'line',
      target: { endpointId: 'serial-1' },
      payloadBase64: 'cGluZw==',
    }));

    await wrapper.get('button[aria-label="重命名模板 Ping"]').trigger('click');
    await wrapper.get('input[name="rename-template-template-1"]').setValue('Ping v2');
    await wrapper.get('.send-library__rename').trigger('submit');
    await flushPromises();
    expect(runtime.template.save).toHaveBeenLastCalledWith({
      id: 'template-1',
      endpointId: 'serial-1',
      name: 'Ping v2',
      format: 'text',
      framing: 'none',
      target: { endpointId: 'serial-1' },
      payloadBase64: 'cGluZw==',
      createdAt: 10,
      updatedAt: 20,
    });

    await wrapper.get('button[aria-label="删除模板 Ping v2"]').trigger('click');
    await flushPromises();
    expect(runtime.template.delete).toHaveBeenCalledWith('template-1');
    expect(wrapper.text()).not.toContain('Ping v2');
    expect(saved).toHaveLength(2);
  });

  test('loads and manages paged send history for the current endpoint', async () => {
    const rows = [history({ id: 12, payloadBase64: 'QQ==', byteCount: 1 })];
    const runtime = createRuntime({ historyPages: [
      { rows, total: 21, page: 1, pageSize: 20 },
      { rows: [history({ id: 11, payloadBase64: 'Qg==', byteCount: 1 })], total: 21, page: 2, pageSize: 20 },
    ] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = mountPanel(runtime, { initialTab: 'history' });
    await flushPromises();

    expect(runtime.sendHistory.query).toHaveBeenCalledWith({ endpointId: 'serial-1', page: 1, pageSize: 20 });
    expect(wrapper.text()).toContain('1 字节');
    await wrapper.get('button[aria-label="载入历史记录 12"]').trigger('click');
    expect(wrapper.emitted('load')?.[0]).toEqual([rows[0]]);

    await wrapper.get('button[aria-label="下一页"]').trigger('click');
    await flushPromises();
    expect(runtime.sendHistory.query).toHaveBeenLastCalledWith({ endpointId: 'serial-1', page: 2, pageSize: 20 });

    await wrapper.get('button[aria-label="删除历史记录 11"]').trigger('click');
    await flushPromises();
    expect(runtime.sendHistory.delete).toHaveBeenCalledWith(11);

    await wrapper.get('button[aria-label="清空当前端点发送历史"]').trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalled();
    expect(runtime.sendHistory.clear).toHaveBeenCalledWith('serial-1');
  });

  test('surfaces persistence errors without discarding already loaded rows', async () => {
    const runtime = createRuntime({ templates: [template()] });
    runtime.template.delete.mockRejectedValue(new Error('database busy'));
    const wrapper = mountPanel(runtime);
    await flushPromises();

    await wrapper.get('button[aria-label="删除模板 Ping"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('database busy');
    expect(wrapper.text()).toContain('Ping');
  });

  test('an older endpoint load cannot replace the current endpoint templates', async () => {
    const first = deferred();
    const runtime = createRuntime();
    runtime.template.list
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([template({ id: 'template-2', endpointId: 'serial-2', name: 'Current' })]);
    const wrapper = mountPanel(runtime);

    await wrapper.setProps({ endpointId: 'serial-2' });
    await flushPromises();
    first.resolve([template({ name: 'Stale' })]);
    await flushPromises();

    expect(wrapper.text()).toContain('Current');
    expect(wrapper.text()).not.toContain('Stale');
  });
});

function mountPanel(runtime, overrides = {}) {
  return mount(SendLibraryPanel, {
    props: {
      runtime,
      endpointId: 'serial-1',
      snapshot: {
        format: 'text',
        framing: 'line',
        target: { endpointId: 'serial-1' },
        payloadBase64: 'cGluZw==',
      },
      initialTab: 'templates',
      ...overrides,
    },
  });
}

function template(overrides = {}) {
  return {
    id: 'template-1',
    endpointId: 'serial-1',
    name: 'Ping',
    format: 'text',
    framing: 'none',
    target: { endpointId: 'serial-1' },
    payloadBase64: 'cGluZw==',
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function history(overrides = {}) {
  return {
    id: 12,
    endpointId: 'serial-1',
    sessionId: 'session-1',
    peerId: null,
    target: { endpointId: 'serial-1' },
    format: 'text',
    framing: 'none',
    payloadBase64: 'cGluZw==',
    byteCount: 4,
    createdAt: 1_725_000_000_000,
    ...overrides,
  };
}

function createRuntime({ templates = [], historyPages = [] } = {}) {
  let templateRows = [...templates];
  let historyCall = 0;
  return {
    template: {
      list: vi.fn(async () => [...templateRows]),
      save: vi.fn(async (value) => {
        templateRows = [value, ...templateRows.filter(({ id }) => id !== value.id)];
        return value;
      }),
      delete: vi.fn(async (id) => {
        templateRows = templateRows.filter((row) => row.id !== id);
        return true;
      }),
    },
    sendHistory: {
      query: vi.fn(async () => historyPages[Math.min(historyCall++, historyPages.length - 1)]
        ?? { rows: [], total: 0, page: 1, pageSize: 20 }),
      delete: vi.fn(async () => true),
      clear: vi.fn(async () => 1),
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}


async function submitRename(wrapper, previousName, nextName) {
  await wrapper.get(`button[aria-label="重命名模板 ${previousName}"]`).trigger('click');
  await wrapper.get('input[aria-label="新的模板名称"]').setValue(nextName);
  await wrapper.get('.send-library__rename').trigger('submit');
}

function renameDeleteRuntime() {
  const rename = deferred();
  const deletion = deferred();
  const rows = new Map([['A', template({ id: 'A', name: 'A' })]]);
  const events = [];
  const runtime = createRuntime();
  runtime.template.list.mockImplementation(async (endpointId) => [...rows.values()]
    .filter((row) => row.endpointId === endpointId));
  runtime.template.save.mockImplementation(async (value) => {
    events.push('rename');
    await rename.promise;
    rows.set(value.id, value);
    return value;
  });
  runtime.template.delete.mockImplementation(async (id) => {
    events.push('delete');
    await deletion.promise;
    return rows.delete(id);
  });
  return { runtime, rename, deletion, rows, events };
}
