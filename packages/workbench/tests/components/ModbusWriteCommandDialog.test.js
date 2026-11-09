import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, test } from 'vitest';
import { nextTick } from 'vue';

import ModbusWriteCommandDialog from '../../src/components/ModbusWriteCommandDialog.vue';

const wrappers = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

describe('ModbusWriteCommandDialog', () => {
  test('defaults a new command to the master Slave ID, focuses its name, and emits a normalized command', async () => {
    const wrapper = mountDialog(null, { open: false, masterConfig: { unitId: 1 } });

    await wrapper.setProps({ open: true });
    await nextTick();

    expect(document.activeElement).toBe(document.querySelector('input[name="modbus-write-command-name"]'));
    expect(document.querySelector('input[name="modbus-write-command-unit-id"]').value).toBe('1');
    await setValue('input[name="modbus-write-command-name"]', '启动水泵');
    await setValue('select[name="modbus-write-command-function"]', '5');
    await setValue('input[name="modbus-write-command-values"]', '1');
    await submit();

    expect(wrapper.emitted('save')[0][0]).toMatchObject({
      name: '启动水泵', unitId: 1, functionCode: 5, address: 0, values: [true],
    });
    expect(Object.getPrototypeOf(wrapper.emitted('save')[0][0])).toBe(Object.prototype);
  });

  test('edits an isolated local command and cancels with Escape or the footer without saving', async () => {
    const source = command({ name: '原始指令', values: [10] });
    const wrapper = mountDialog(source);

    await setValue('input[name="modbus-write-command-name"]', '已编辑指令');
    expect(source.name).toBe('原始指令');
    document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('save')).toBeUndefined();

    await document.querySelectorAll('button[type="button"]').item(1)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(wrapper.emitted('cancel')).toHaveLength(2);
  });

  test('parses coil tokens and register decimal and hexadecimal values before save', async () => {
    const coil = mountDialog(null);
    await setValue('input[name="modbus-write-command-name"]', '线圈序列');
    await setValue('select[name="modbus-write-command-function"]', '15');
    await setValue('input[name="modbus-write-command-values"]', '1, 0, true, false');
    await submit();
    expect(coil.emitted('save')[0][0].values).toEqual([true, false, true, false]);
    coil.unmount();

    const register = mountDialog(null);
    await setValue('input[name="modbus-write-command-name"]', '目标值');
    await setValue('select[name="modbus-write-command-function"]', '16');
    await setValue('input[name="modbus-write-command-values"]', '10, 0x20');
    await submit();
    expect(register.emitted('save')[0][0].values).toEqual([10, 32]);
  });

  test('does not emit malformed or empty coil and register editor text', async () => {
    for (const { functionCode, values, message } of [
      { functionCode: 5, values: 'enabled', message: 'FC05 必须写入一个布尔值。' },
      { functionCode: 15, values: 'true, enabled', message: 'FC15 必须写入 1 到 1968 个布尔值。' },
      { functionCode: 6, values: 'not-a-number', message: 'FC06 必须写入一个 0 到 65535 的整数。' },
      { functionCode: 6, values: '', message: 'FC06 必须写入一个 0 到 65535 的整数。' },
    ]) {
      const wrapper = mountDialog(null);
      await setValue('input[name="modbus-write-command-name"]', '无效输入');
      await setValue('select[name="modbus-write-command-function"]', String(functionCode));
      await setValue('input[name="modbus-write-command-values"]', values);
      await submit();

      expect(document.body.textContent).toContain(message);
      expect(wrapper.emitted('save')).toBeUndefined();
      wrapper.unmount();
    }
  });

  test('saves an edit when the matching existing command is a distinct object', async () => {
    const source = command({ id: 'edit-id' });
    const wrapper = mountDialog({ ...source }, { existingCommands: [{ ...source }] });

    await setValue('input[name="modbus-write-command-name"]', '已编辑指令');
    await submit();

    expect(wrapper.emitted('save')[0][0]).toMatchObject({ id: 'edit-id', name: '已编辑指令' });
  });

  test('accepts the inclusive FC15 and FC16 value-count boundaries', async () => {
    for (const { functionCode, count, token } of [
      { functionCode: 15, count: 1, token: 'true' },
      { functionCode: 15, count: 1968, token: 'true' },
      { functionCode: 16, count: 1, token: '1' },
      { functionCode: 16, count: 123, token: '1' },
    ]) {
      const wrapper = mountDialog(null);
      await setValue('input[name="modbus-write-command-name"]', `边界 FC${functionCode}`);
      await setValue('select[name="modbus-write-command-function"]', String(functionCode));
      await setValue('input[name="modbus-write-command-values"]', Array(count).fill(token).join(','));
      await submit();

      expect(wrapper.emitted('save')[0][0].values).toHaveLength(count);
      wrapper.unmount();
    }
  });

  test('requires FC06 to contain exactly one register value', async () => {
    const wrapper = mountDialog(null);
    await setValue('input[name="modbus-write-command-name"]', '单寄存器');
    await setValue('input[name="modbus-write-command-values"]', '1, 2');
    await submit();

    expect(document.body.textContent).toContain('FC06 必须写入一个 0 到 65535 的整数。');
    expect(wrapper.emitted('save')).toBeUndefined();
  });

  test('shows field errors and does not save invalid limits or address overflow', async () => {
    const wrapper = mountDialog(command());

    await setValue('select[name="modbus-write-command-function"]', '5');
    await setValue('input[name="modbus-write-command-values"]', 'true, false');
    await submit();
    expect(document.body.textContent).toContain('FC05 必须写入一个布尔值。');
    expect(wrapper.emitted('save')).toBeUndefined();

    await setValue('select[name="modbus-write-command-function"]', '15');
    await setValue('input[name="modbus-write-command-values"]', Array(1969).fill('true').join(','));
    await submit();
    expect(document.body.textContent).toContain('FC15 必须写入 1 到 1968 个布尔值。');

    await setValue('select[name="modbus-write-command-function"]', '16');
    await setValue('input[name="modbus-write-command-values"]', Array(124).fill('1').join(','));
    await submit();
    expect(document.body.textContent).toContain('FC16 必须写入 1 到 123 个 0 到 65535 的整数。');

    await setValue('input[name="modbus-write-command-address"]', '65535');
    await setValue('input[name="modbus-write-command-values"]', '1, 2');
    await submit();
    expect(document.body.textContent).toContain('写入范围不能超过地址 65535。');
    expect(wrapper.emitted('save')).toBeUndefined();
  });
});

function mountDialog(source, overrides = {}) {
  const wrapper = mount(ModbusWriteCommandDialog, {
    attachTo: document.body,
    props: {
      open: true,
      command: source,
      masterConfig: { unitId: 7 },
      existingCommands: source ? [source] : [],
      ...overrides,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

async function setValue(selector, value) {
  const input = document.querySelector(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

async function submit() {
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await nextTick();
}

function command(overrides = {}) {
  return {
    id: 'write-1', name: '设置目标', description: '', enabled: true, order: 0,
    unitId: 7, functionCode: 6, address: 20, values: [10],
    ...overrides,
  };
}
