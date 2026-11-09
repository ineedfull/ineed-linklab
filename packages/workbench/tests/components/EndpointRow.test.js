import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, test } from 'vitest';
import { nextTick } from 'vue';

import EndpointRow from '../../src/components/EndpointRow.vue';

const wrappers = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('EndpointRow keyboard behavior', () => {
  test('protocol recovery has a clear label and cancel action without a transport retry counter', async () => {
    const wrapper = mountRow({ endpoint: { id: 'protocol:opcua:a', name: '节点 A', transport: 'opcua-client', config: { endpointUrl: 'opc.tcp://localhost:4840' } }, statusEvent: { status: 'reconnecting' } });
    expect(wrapper.get('.status-dot').attributes('title')).toBe('正在重连');
    await wrapper.get('[aria-label="取消自动重连"]').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
  test('outside clicks close the menu even when the target stops bubbling', async () => {
    const wrapper = mountRow();
    await wrapper.get('[aria-label="端点操作"]').trigger('click');
    const outside = document.createElement('button');
    outside.addEventListener('click', event => event.stopPropagation());
    document.body.append(outside);
    try {
      outside.click();
      await nextTick();
      expect(wrapper.find('[role="menu"]').exists()).toBe(false);
      expect(wrapper.emitted('edit')).toBeUndefined();
      expect(wrapper.emitted('delete')).toBeUndefined();
    } finally { outside.remove(); }
  });

  test('Escape closes the menu and returns focus to the trigger', async () => {
    const wrapper = mountRow();
    const trigger = wrapper.get('[aria-label="端点操作"]');
    await trigger.trigger('click');
    wrapper.get('[role="menuitem"]').element.focus();
    await wrapper.get('[role="menuitem"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  test('opening another menu dismisses the first; focus outside and row selection also close it', async () => {
    const first = mountRow();
    const second = mountRow();
    await first.get('[aria-label="端点操作"]').trigger('click');
    await second.get('[aria-label="端点操作"]').trigger('click');
    expect(first.find('[role="menu"]').exists()).toBe(false);
    expect(second.find('[role="menu"]').exists()).toBe(true);
    second.get('.endpoint-row__select').element.focus();
    await nextTick();
    expect(second.find('[role="menu"]').exists()).toBe(false);
    await first.get('[aria-label="端点操作"]').trigger('click');
    await first.get('.endpoint-row__select').trigger('click');
    expect(first.find('[role="menu"]').exists()).toBe(false);
    expect(first.emitted('select')).toHaveLength(1);
  });

  test.each(['edit', 'delete'])('inside %s remains actionable and closes before emitting', async (action) => {
    const wrapper = mountRow();
    await wrapper.get('[aria-label="端点操作"]').trigger('click');
    const item = wrapper.findAll('[role="menuitem"]')[action === 'edit' ? 0 : 1];
    await item.trigger('pointerdown');
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    await item.trigger('click');
    expect(wrapper.emitted(action)).toHaveLength(1);
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  test('unmount removes the Escape listener of an open menu', async () => {
    const wrapper = mountRow();
    await wrapper.get('[aria-label="端点操作"]').trigger('click');
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  test('selectable surface is a native keyboard-operable button', async () => {
    const wrapper = mountRow();
    const row = wrapper.get('.endpoint-row__select');

    expect(row.element.tagName).toBe('BUTTON');
    expect(row.attributes('role')).toBeUndefined();
    expect(row.attributes('tabindex')).toBeUndefined();
    await row.trigger('click');

    expect(wrapper.emitted('select')).toHaveLength(1);
  });

  test('selection and action controls are sibling buttons without nested interactivity', async () => {
    const wrapper = mountRow();
    const open = wrapper.get('[aria-label="打开端点"]');

    expect(wrapper.findAll('button button')).toHaveLength(0);
    expect(open.element.parentElement).not.toBe(wrapper.get('.endpoint-row__select').element);
    await open.trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('select')).toBeUndefined();
  });

  test('exposes selection and menu state through ARIA attributes and menu roles', async () => {
    const wrapper = mountRow();
    const select = wrapper.get('.endpoint-row__select');
    const actions = wrapper.get('[aria-label="端点操作"]');

    expect(select.attributes('aria-current')).toBeUndefined();
    expect(actions.attributes('aria-haspopup')).toBe('menu');
    expect(actions.attributes('aria-expanded')).toBe('false');

    await wrapper.setProps({ selected: true });
    await actions.trigger('click');

    expect(select.attributes('aria-current')).toBe('true');
    expect(actions.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.endpoint-row__menu').attributes('role')).toBe('menu');
    for (const item of wrapper.findAll('.endpoint-row__menu button')) {
      expect(item.attributes('role')).toBe('menuitem');
    }

    await wrapper.get('.endpoint-row__menu button').trigger('click');
    expect(actions.attributes('aria-expanded')).toBe('false');
  });

  test('opening state exposes a cancel button that emits cancel', async () => {
    const wrapper = mountRow();
    await wrapper.setProps({
      operation: { endpointId: 'serial-1', operationId: 'open-1', sessionId: null },
    });

    const cancel = wrapper.get('[aria-label="取消打开端点"]');
    expect(wrapper.find('[aria-label="打开端点"]').exists()).toBe(false);
    await cancel.trigger('click');

    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  test.each([
    ['waiting', '等待重连（第 2 次）', 'reconnect-waiting'],
    ['connecting', '正在重连（第 2 次）', 'reconnecting'],
  ])('shows %s reconnect state with a cancel action instead of open', async (phase, label, status) => {
    const wrapper = mountRow({
      endpoint: {
        id: 'tcp-client-1', name: 'TCP client', transport: 'tcp-client',
        config: { host: 'localhost', port: 9000 },
      },
      reconnectState: {
        endpointId: 'tcp-client-1', phase, attempt: 2,
        nextRetryAt: 1_720_000_001_000, operationId: null, lastError: null,
      },
    });

    expect(wrapper.get('.status-dot').classes()).toContain(`status-dot--${status}`);
    expect(wrapper.get('.status-dot').attributes('title')).toBe(label);
    expect(wrapper.get('.endpoint-row__secondary').text()).toContain(label);
    expect(wrapper.find('[aria-label="打开端点"]').exists()).toBe(false);
    const cancel = wrapper.get('[aria-label="取消自动重连"]');
    await cancel.trigger('click');

    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  test('shows enabled and total request-group counts for Modbus masters', () => {
    const wrapper = mountRow({
      endpoint: {
        id: 'master-1', name: 'Master', transport: 'modbus-tcp-master',
        config: {
          host: '192.168.1.20', port: 502,
          requestGroups: [{ id: 'a', enabled: true }, { id: 'b', enabled: false }],
        },
      },
    });

    expect(wrapper.get('.endpoint-row__secondary').text()).toContain('请求组 1/2');
  });
});

function mountRow(overrides = {}) {
  const wrapper = mount(EndpointRow, {
    attachTo: document.body,
    props: {
      endpoint: {
        id: 'serial-1', name: 'Serial', transport: 'serial', config: { path: 'COM3' },
      },
      ...overrides,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
