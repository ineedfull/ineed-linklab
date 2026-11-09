import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AboutPanel from '../../src/components/AboutPanel.vue';
import EndpointDialog from '../../src/components/EndpointDialog.vue';

const wrappers = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

describe('Chinese endpoint configuration', () => {
  test('renders required transport, serial, and UDP terminology', async () => {
    track(mount(EndpointDialog, {
      attachTo: document.body,
      props: { open: true, endpoint: null, saveCommand: vi.fn() },
    }));
    await nextTick();
    const text = document.body.textContent;
    for (const label of [
      '串口', 'TCP 客户端', 'TCP 服务端', 'UDP 客户端', 'UDP 服务端',
      '波特率', '自定义...', '数据位', '校验位', '停止位', '流控',
    ]) expect(text).toContain(label);
    expect(optionLabels('select[name="serial-parity"]')).toEqual([
      '无（None）', '偶校验（Even）', '奇校验（Odd）', '固定 1（Mark）', '固定 0（Space）',
    ]);
    expect(optionLabels('select[name="serial-flow-control"]')).toEqual([
      '无（None）', '硬件（RTS/CTS）', '软件（XON/XOFF）',
    ]);
    expect(document.querySelector('button[aria-label="刷新串口列表"]')).not.toBeNull();
  });
});

describe('AboutPanel', () => {
  test('shows one runtime identity and supports focus, Escape, close, and restore', async () => {
    const prior = document.createElement('button');
    prior.textContent = '之前';
    document.body.append(prior);
    prior.focus();
    const wrapper = track(mount(AboutPanel, {
      attachTo: document.body,
      props: { open: false, runtimeName: 'Electron' },
    }));
    await wrapper.setProps({ open: true });
    await nextTick();
    expect(document.body.textContent).toContain('Ineed LinkLab');
    expect(document.body.textContent).toContain('0.1.0');
    expect(document.body.textContent).toContain('Electron');
    expect(document.body.textContent).not.toContain('Tauri');
    expect(document.body.textContent).toContain('版权所有');
    expect(document.body.textContent).not.toContain('Copyright');
    expect(document.activeElement).toBe(document.querySelector('button[aria-label="关闭关于"]'));
    const controls = [...document.querySelectorAll('[role="dialog"] button:not([disabled])')];
    controls.at(-1).focus();
    controls.at(-1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(controls[0]);
    controls[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(controls.at(-1));
    document.querySelector('[role="dialog"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(prior);
  });
});

function track(wrapper) {
  wrappers.push(wrapper);
  return wrapper;
}

function optionLabels(selector) {
  return [...document.querySelector(selector).options].map((option) => option.textContent);
}
