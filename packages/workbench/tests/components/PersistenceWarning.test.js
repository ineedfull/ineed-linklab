import { mount, flushPromises } from '@vue/test-utils';
import { createUnavailableRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import { expect, test } from 'vitest';
import App from '../../src/App.vue';
import { runtimeAdapterKey } from '../../src/runtimeContext.js';

test('native history loss displays a persistent alert in the real shell', async () => {
  const runtime = createUnavailableRuntimeAdapter('electron');
  let warning;
  runtime.transport.onPersistenceWarning = (listener) => {
    warning = listener;
    return () => {};
  };
  runtime.endpoint.list = async () => [];
  runtime.settings.getAll = async () => ({});
  const wrapper = mount(App, { global: { provide: { [runtimeAdapterKey]: runtime } } });
  try {
    await flushPromises();
    expect(typeof warning).toBe('function');
    warning({ message: 'database is locked', rowCount: 1 });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('历史记录保存失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('database is locked');
    expect(wrapper.find('.linklab-shell__workspace > .linklab-shell__main').exists()).toBe(true);
  } finally {
    wrapper.unmount();
    document.documentElement.classList.remove('large-font', 'ui-preferences-loading');
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeMode;
  }
});
