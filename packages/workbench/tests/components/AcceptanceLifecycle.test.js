import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import { createUnavailableRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import App from '../../src/App.vue';
import LinkLabShell from '../../src/layouts/LinkLabShell.vue';
import AcceptancePanel from '../../src/components/AcceptancePanel.vue';
import SettingsPanel from '../../src/components/SettingsPanel.vue';
import { runtimeAdapterKey } from '../../src/runtimeContext.js';
import { plan } from '../acceptanceFixtures.js';

const wrappers = [];
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()));
function shellFixture() {
  let settings = {};
  let finish;
  const trace = [];
  const runtime = {
    opcua: { execute: async () => ({ profiles: [] }) },
    settings: {
      getAll: async () => settings,
      saveAll: async (value) => {
        trace.push('save');
        settings = value;
      },
    },
    workspace: {
      import: async () => {
        trace.push('native-import');
        settings = {};
        return { canceled: false };
      },
    },
  };
  const endpoint = {
    id: 'm',
    name: 'Master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502 },
  };
  const model = {
    state: {
      endpoints: [endpoint],
      activeEndpointId: 'm',
      activePeerId: '',
      endpointFilter: 'all',
      frameFilters: { keyword: '' },
      operations: new Map([['m', { sessionId: 's' }]]),
      statuses: new Map([['m', { status: 'open' }]]),
      reconnects: new Map(),
      peers: new Map(),
      endpointCounters: new Map(),
    },
    activeEndpoint: endpoint,
    reconnectStateFor: () => null,
    peersForEndpoint: () => [],
    commandErrorForEndpoint: () => null,
    visibleFrames: [],
    visibleLogs: [],
    commands: {},
    modbusMasterScheduler: {
      executeImmediate: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  };
  const wrapper = shallowMount(LinkLabShell, {
    props: {
      model,
      runtime,
      preferences: { values: { autoScroll: true } },
      savePreferences: vi.fn(),
      revision: 0,
      runtimeName: 'test',
      saveCommand: vi.fn(),
      sendCommand: vi.fn(),
      workspaceImportedCommand: vi.fn(async () => {}),
    },
  });
  wrappers.push(wrapper);
  return {
    wrapper,
    trace,
    settings: () => settings,
    finish: () =>
      finish({
        endpointId: 'm',
        sessionId: 's',
        success: true,
        values: [7],
        ...plan().checks[0].query,
      }),
  };
}
test('workspace replacement stops, flushes and invalidates report ownership before native import', async () => {
  const f = shellFixture();
  await flushPromises();
  const workspace = f.wrapper.findComponent(AcceptancePanel).props('workspace');
  const pending = workspace.run(plan(), 'm');
  await flushPromises();
  const settingsPanel = f.wrapper.findComponent(SettingsPanel);
  await settingsPanel.props('runtime').workspace.import();
  expect(f.trace.indexOf('save')).toBeLessThan(
    f.trace.indexOf('native-import'),
  );
  await settingsPanel.props('workspaceImportedCommand')();
  f.finish();
  await pending;
  await workspace.stop();
  await workspace.flush();
  expect(workspace.state.reports).toHaveLength(0);
  expect(f.settings().acceptanceWorkspace).toBeUndefined();
});
test('exposed shutdown saves stopped report without waiting for the native read', async () => {
  const f = shellFixture();
  await flushPromises();
  const workspace = f.wrapper.findComponent(AcceptancePanel).props('workspace');
  const pending = workspace.run(plan(), 'm');
  await flushPromises();
  await f.wrapper.vm.prepareForShutdown();
  expect(JSON.parse(f.settings().acceptanceWorkspace).reports[0].status).toBe(
    'stopped',
  );
  f.finish();
  await pending;
});
test.each([false, true])(
  'App acknowledges shutdown after both flush attempts even if acceptance save fails: %s',
  async (failAcceptance) => {
    const trace = [];
    let shutdown;
    const runtime = createUnavailableRuntimeAdapter('Electron');
    runtime.endpoint.list = async () => [];
    runtime.modbusHistory.flush = async () => {
      trace.push('history.flush');
    };
    runtime.lifecycle.onBeforeShutdown = (listener) => {
      shutdown = listener;
      return () => {};
    };
    runtime.lifecycle.readyForShutdown = async () => {
      trace.push('ready');
    };
    const wrapper = mount(App, {
      global: {
        provide: { [runtimeAdapterKey]: runtime },
        stubs: {
          LinkLabShell: {
            template: '<div class="shutdown-shell" />',
            methods: {
              async prepareForShutdown() {
                trace.push('stop+flush');
                if (failAcceptance) throw new Error('disk full');
              },
            },
          },
        },
      },
    });
    wrappers.push(wrapper);
    await vi.waitFor(() =>
      expect(wrapper.find('.shutdown-shell').exists()).toBe(true),
    );
    await shutdown({ requestId: 'exit' });
    expect(trace).toEqual(['stop+flush', 'history.flush', 'ready']);
  },
);
