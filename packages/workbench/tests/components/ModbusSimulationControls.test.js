import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import ModbusSimulationControls from '../../src/components/ModbusSimulationControls.vue';
import { createModbusSlaveSimulation } from '../../src/model/modbusSlaveSimulation.js';

const points = [{ id: 'f', name: '模数', area: 'holdingRegisters', address: 0, dataType: 'float32' },
  { id: 'id', name: '编号', area: 'holdingRegisters', address: 2, dataType: 'ascii', length: 5 }];
let wrapper, manager;
afterEach(() => { wrapper?.unmount(); manager?.dispose(); document.body.innerHTML = ''; });
test('switch starts off, configures explicit points, restores focus and survives remount', async () => {
  manager = createModbusSlaveSimulation({ writeMap: vi.fn(async () => {}) });
  const props = { manager, endpoint: { id: 's', config: { dataPoints: points } }, running: true, sessionId: 'session' };
  wrapper = mount(ModbusSimulationControls, { props, attachTo: document.body });
  const toggle = wrapper.get('[role="switch"]');
  expect(toggle.element.checked).toBe(false);
  await wrapper.get('[aria-label="自动变化设置"]').trigger('click');
  await flushPromises();
  expect(document.querySelector('[aria-label="模拟 编号"]')).toBeNull();
  document.querySelector('[aria-label="模拟 模数"]').click();
  await flushPromises();
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
  expect(manager.getStatus('s').settings.rules).toHaveLength(1);
  expect(toggle.element.checked).toBe(false);
  await toggle.setValue(true);
  expect(manager.getStatus('s').active).toBe(true);
  wrapper.unmount();
  expect(manager.getStatus('s').active).toBe(true);
  wrapper = mount(ModbusSimulationControls, { props, attachTo: document.body });
  expect(wrapper.get('[role="switch"]').element.checked).toBe(true);
  await wrapper.get('[role="switch"]').setValue(false);
  expect(manager.getStatus('s').active).toBe(false);
  const button = wrapper.get('[aria-label="自动变化设置"]');
  button.element.focus();
  await button.trigger('click');
  await flushPromises();
  document.querySelector('form').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
  expect(document.querySelector('form')).toBeNull();
  expect(document.activeElement).toBe(button.element);
});
test('cannot start closed slave and cannot enable without an explicitly selected point', async () => {
  manager = createModbusSlaveSimulation({ writeMap: vi.fn(async () => {}) });
  wrapper = mount(ModbusSimulationControls, { attachTo: document.body, props: {
    manager, endpoint: { id: 's', config: { dataPoints: points } }, running: false,
  } });
  expect(wrapper.get('[role="switch"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[aria-label="自动变化设置"]').trigger('click');
  await flushPromises();
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
  expect(document.querySelector('[role="alert"]').textContent).toContain('至少勾选');
  expect(manager.getStatus('s').settings).toBeNull();
});
