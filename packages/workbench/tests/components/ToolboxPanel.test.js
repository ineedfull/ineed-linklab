import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import ToolboxPanel from '../../src/components/ToolboxPanel.vue';

let wrapper;
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function open() {
  wrapper = mount(ToolboxPanel, { attachTo: document.body, props: { open: false } });
  await wrapper.setProps({ open: true });
  await nextTick();
}
function control(name) { return document.querySelector(`[name="${name}"]`); }
async function input(value) {
  control('toolbox-input').value = value;
  control('toolbox-input').dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}
async function click(label) {
  const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === label);
  expect(button, label).toBeTruthy();
  button.click(); await nextTick();
}
test('calculates a CRC without a connection and clears stale results immediately on input or parameter edit', async () => {
  await open();
  await input('01 03 00 00 00 0A'); await click('计算');
  expect(document.querySelector('[aria-label="结果：发送字节"]').value).toBe('C5 CD');
  expect(document.body.textContent).not.toContain('校验通过');
  await input('01 0G');
  expect(document.querySelector('[aria-label="计算结果"]')).toBeNull();
  await click('计算');
  expect(document.querySelector('[role="alert"]').textContent).toContain('HEX');
  await input('01 03 00 00 00 0A'); await click('计算');
  control('wireOrder').value = 'big';
  control('wireOrder').dispatchEvent(new Event('change', { bubbles: true })); await nextTick();
  expect(document.querySelector('[aria-label="计算结果"]')).toBeNull();
});
test('tool switching and reopening preserve individual drafts', async () => {
  await open(); await input('AA BB');
  await click('编码转换'); await input('Hello');
  await click('校验计算'); expect(control('toolbox-input').value).toBe('AA BB');
  await wrapper.setProps({ open: false }); await wrapper.setProps({ open: true });
  expect(control('toolbox-input').value).toBe('AA BB');
  await click('载入示例'); expect(control('toolbox-input').value).toBe('01 03 00 00 00 0A');
  await click('清空'); expect(control('toolbox-input').value).toBe('');
});
test('loading an example preserves the selected decoding scenario and clears stale results', async () => {
  await open(); await click('编码转换');
  control('direction').value = 'decode';
  control('direction').dispatchEvent(new Event('change', { bubbles: true })); await nextTick();
  await input('41'); await click('计算');
  await click('载入示例');
  expect(control('direction').value).toBe('decode');
  expect(control('toolbox-input').value).toBe('48 65 6C 6C 6F 0D 0A');
  expect(document.querySelector('[aria-label="计算结果"]')).toBeNull();
  await click('计算');
  expect(document.querySelector('[aria-label="结果：字符（转义展示）"]').value).toBe('Hello\\r\\n');
});
test('unavailable clipboard reports failure and retains selectable output', async () => {
  vi.stubGlobal('navigator', { clipboard: undefined });
  await open(); await click('载入示例'); await click('计算');
  document.querySelector('[aria-label="复制 发送字节"]').click(); await flushPromises();
  expect(document.querySelector('[role="alert"]').textContent).toContain('复制失败');
  expect(document.querySelector('[aria-label="结果：发送字节"]').value).toBe('C5 CD');
});
test('stale asynchronous copy cannot replace feedback after editing the draft', async () => {
  let reject;
  vi.stubGlobal('navigator', { clipboard: { writeText: () => new Promise((_resolve, fail) => { reject = fail; }) } });
  await open(); await click('载入示例'); await click('计算');
  document.querySelector('[aria-label="复制 发送字节"]').click(); await nextTick();
  await input('01'); reject(new Error('denied')); await flushPromises();
  expect(document.body.textContent).not.toContain('复制失败');
  expect(document.body.textContent).not.toContain('已复制');
});
test('Escape closes and restoring the open prop returns focus to the trigger', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  await open();
  expect(document.activeElement.getAttribute('aria-label')).toBe('关闭工具箱');
  document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick(); expect(wrapper.emitted('close')).toHaveLength(1);
  await wrapper.setProps({ open: false }); expect(document.activeElement).toBe(trigger);
});
