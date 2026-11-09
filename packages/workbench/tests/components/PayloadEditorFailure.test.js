import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@codemirror/commands', () => {
  throw new Error('CodeMirror chunk unavailable');
});

import PayloadEditor from '../../src/components/PayloadEditor.vue';

describe('PayloadEditor initialization failure', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('renders a concise factual state when editor initialization fails', async () => {
    const wrapper = mount(PayloadEditor, { attachTo: document.body });
    await settleInitialization();

    const status = wrapper.get('[role="status"]');
    expect(status.text()).toBe('编辑器加载失败');
    expect(wrapper.find('.cm-editor').exists()).toBe(false);
  });

  test('initialization failure after rapid unmount is inert', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const wrapper = mount(PayloadEditor, { attachTo: host });
    wrapper.unmount();

    await settleInitialization();
    expect(host.textContent).toBe('');
  });
});

async function settleInitialization() {
  await flushPromises();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
