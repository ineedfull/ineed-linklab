import { flushPromises, mount } from '@vue/test-utils';
import { expect, test } from 'vitest';
import ModbusRequestGroupDialog from '../../src/components/ModbusRequestGroupDialog.vue';
import ModbusRequestDialog from '../../src/components/ModbusRequestDialog.vue';
import ModbusWriteCommandDialog from '../../src/components/ModbusWriteCommandDialog.vue';

const editors = [
  ['group', ModbusRequestGroupDialog, 'request-group-name', { existingGroups: [] }],
  ['request', ModbusRequestDialog, 'modbus-request-name', { group: { id: 'g', name: '组', unitId: 1, requests: [] }, existingRequests: [] }],
  ['command', ModbusWriteCommandDialog, 'modbus-write-command-name', { existingCommands: [] }],
];

test.each(editors)('%s editor confines focus and restores its launcher after Escape', async (_kind, component, name, extra) => {
  const launcher = document.createElement('button'); document.body.append(launcher); launcher.focus();
  const wrapper = mount(component, { attachTo: document.body, props: { open: false, masterConfig: { unitId: 1 }, ...extra } });
  try {
    await wrapper.setProps({ open: true }); await flushPromises();
    expect(document.activeElement).toBe(document.querySelector(`[name="${name}"]`));
    const dialog = document.querySelector('[role="dialog"]');
    const last = dialog.querySelector('button[type="submit"]'); last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector('button'));
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises(); expect(wrapper.emitted('cancel')).toHaveLength(1);
    await wrapper.setProps({ open: false }); expect(document.activeElement).toBe(launcher);
  } finally { wrapper.unmount(); launcher.remove(); }
});

test.each(editors)('%s editor blocks dismissal and changes while saving, then displays a retryable storage error', async (_kind, component, name, extra) => {
  const wrapper = mount(component, { attachTo: document.body, props: { open: true, saving: true, masterConfig: { unitId: 1 }, ...extra } });
  try {
    await flushPromises();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(dialog.querySelector(`[name="${name}"]`).matches(':disabled')).toBe(true);
    expect(dialog.querySelector('button[type="submit"]').disabled).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dialog.closest('.dialog-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises(); expect(wrapper.emitted('cancel')).toBeUndefined();
    await wrapper.setProps({ saving: false, saveError: '磁盘已满，请重试' });
    expect(dialog.textContent).toContain('磁盘已满，请重试');
    expect(dialog.querySelector('button[type="submit"]').disabled).toBe(false);
  } finally { wrapper.unmount(); }
});
