import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';

import SessionStatusBar from '../../src/components/SessionStatusBar.vue';

describe('SessionStatusBar reconnect state', () => {
  test.each([
    ['waiting', '等待重连（第 2 次）', 'reconnect-waiting'],
    ['connecting', '正在重连（第 2 次）', 'reconnecting'],
  ])('renders %s as a cancellable reconnect state', async (phase, label, status) => {
    const wrapper = mount(SessionStatusBar, {
      props: {
        endpoint: {
          id: 'tcp-client-1', name: 'TCP client', transport: 'tcp-client',
          config: { host: 'localhost', port: 9000 },
        },
        reconnectState: {
          endpointId: 'tcp-client-1', phase, attempt: 2,
          nextRetryAt: 1_720_000_001_000, operationId: null, lastError: null,
        },
        counters: { received: 0, sent: 0 },
      },
    });

    const cancel = wrapper.get('[aria-label="取消自动重连"]');
    expect(wrapper.get('.session-state').classes()).toContain(`session-state--${status}`);
    expect(wrapper.get('.session-state').text()).toBe(label);
    expect(wrapper.find('button:not([aria-label="取消自动重连"])').exists()).toBe(false);
    await cancel.trigger('click');

    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
});
