import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiPreferences } from '../src/model/uiPreferences.js';
import { createProtocolEndpointCatalog } from '../src/model/protocolEndpointCatalog.js';
import { STOMP_DEFAULT_CONFIG } from '../src/model/stompWorkbench.js';

test('appearance and endpoint writes share a queue so an in-flight saveAll cannot erase a new endpoint', async () => {
  let stored = { theme: 'light', stompProfiles: [] };
  const saving = deferred(), release = deferred();
  const runtime = { settings: {
    getAll: async () => structuredClone(stored),
    save: async (key, value) => { stored[key] = structuredClone(value); },
    saveAll: async value => { saving.resolve(); await release.promise; stored = structuredClone(value); },
  }, opcua: { execute: async () => ({ profiles: [] }) } };
  const preferences = createUiPreferences(runtime, { root: fakeRoot(), matchMedia: () => fakeMedia(false) });
  const catalog = createProtocolEndpointCatalog(runtime);
  try {
    await preferences.load(); await catalog.initialize();
    const appearance = preferences.save({ theme: 'dark' }); await saving.promise;
    const creating = catalog.saveEndpoint({ name: 'Concurrent endpoint', transport: 'stomp-client', config: STOMP_DEFAULT_CONFIG });
    await new Promise(resolve => setTimeout(resolve, 0)); release.resolve();
    await appearance; assert((await creating).ok);
    assert.equal(stored.theme, 'dark'); assert.equal(stored.stompProfiles.length, 1);
  } finally { release.resolve(); preferences.dispose(); await catalog.dispose(); }
});

test('appearance save retains STOMP profiles saved after preferences were loaded', async () => {
  let persisted = { theme: 'light', stompProfiles: [] };
  const controller = createUiPreferences({ settings: {
    getAll: async () => structuredClone(persisted),
    saveAll: async values => { persisted = structuredClone(values); },
  } }, { root: fakeRoot(), matchMedia: () => fakeMedia(false) });
  await controller.load();
  persisted.stompProfiles = [{ id: 'stomp-saved', name: 'saved independently', mode: 'client', config: {}, subscriptions: [] }];
  await controller.save({ theme: 'dark' });
  assert.equal(persisted.theme, 'dark');
  assert.equal(persisted.stompProfiles[0]?.id, 'stomp-saved');
  controller.dispose();
});

test('concurrent partial appearance changes compose against the latest stored settings', async () => {
  let stored = { theme: 'light', largeFont: false };
  const preferences = createUiPreferences({ settings: {
    getAll: async () => structuredClone(stored), saveAll: async value => { stored = structuredClone(value); },
  } }, { root: fakeRoot(), matchMedia: () => fakeMedia(false) });
  await preferences.load();
  await Promise.all([preferences.save({ theme: 'dark' }), preferences.save({ largeFont: true })]);
  assert.equal(stored.theme, 'dark'); assert.equal(stored.largeFont, true);
  assert.equal(preferences.state.resolvedTheme, 'dark'); preferences.dispose();
});

test('initial persisted dark and large-font preferences apply before content is ready', async () => {
  const root = fakeRoot();
  const media = fakeMedia(false);
  const controller = createUiPreferences({
    settings: { getAll: async () => ({ theme: 'dark', largeFont: true }), saveAll: async () => {} },
  }, { root, matchMedia: () => media });

  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.classList.has('ui-preferences-loading'), true);
  await controller.load();
  assert.equal(controller.state.ready, true);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.themeMode, 'dark');
  assert.equal(root.classList.has('large-font'), true);
  assert.equal(root.classList.has('ui-preferences-loading'), false);
});

test('system mode follows matchMedia changes and removes its listener on dispose', async () => {
  const root = fakeRoot();
  const media = fakeMedia(false);
  const controller = createUiPreferences({
    settings: { getAll: async () => ({ theme: 'system' }), saveAll: async () => {} },
  }, { root, matchMedia: () => media });
  await controller.load();
  assert.equal(controller.state.settingsRevision, 1);
  assert.equal(root.dataset.theme, 'light');
  media.change(true);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(controller.state.settingsRevision, 1);
  controller.dispose();
  media.change(false);
  assert.equal(root.dataset.theme, 'dark');
});

test('serialized saves apply the newest request after an earlier write fails', async () => {
  const root = fakeRoot();
  const media = fakeMedia(false);
  const first = deferred();
  const calls = [];
  const runtime = {
    settings: {
      getAll: async () => ({ theme: 'system', largeFont: false }),
      saveAll: async (value) => {
        calls.push(value);
        if (value.theme === 'dark') return first.promise;
        return true;
      },
    },
  };
  const controller = createUiPreferences(runtime, { root, matchMedia: () => media });
  await controller.load();
  const stale = controller.save({ theme: 'dark', largeFont: true });
  const newest = controller.save({ theme: 'light', largeFont: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  const rejected = assert.rejects(stale, /stale failure/);
  first.reject(new Error('stale failure'));
  await rejected; await newest;
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.classList.has('large-font'), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ theme, largeFont }) => ({ theme, largeFont })), [
    { theme: 'dark', largeFont: true },
    { theme: 'light', largeFont: true },
  ]);
});

test('matchMedia failures fall back to a stable light system preference', async () => {
  const root = fakeRoot();
  const controller = createUiPreferences({
    settings: { getAll: async () => ({ theme: 'system' }), saveAll: async () => {} },
  }, { root, matchMedia: () => { throw new Error('media unavailable'); } });
  await controller.load();
  assert.equal(controller.state.resolvedTheme, 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.doesNotThrow(() => controller.dispose());
});

test('preference reload ignores older reverse-order settings reads', async () => {
  const root = fakeRoot();
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const controller = createUiPreferences({
    settings: {
      getAll: () => (++calls === 1 ? first.promise : second.promise),
      saveAll: async () => {},
    },
  }, { root, matchMedia: () => fakeMedia(false) });
  const oldReload = controller.reload();
  const newReload = controller.reload();
  second.resolve({ theme: 'dark', largeFont: true });
  await newReload;
  first.resolve({ theme: 'light', largeFont: false });
  await oldReload;
  assert.equal(controller.state.values.theme, 'dark');
  assert.equal(controller.state.values.largeFont, true);
});

test('Modbus point-history retention loads and saves through typed preferences', async () => {
  const saved = [];
  const controller = createUiPreferences({
    settings: {
      getAll: async () => ({ modbusPointHistoryRetention: '7-days' }),
      saveAll: async (value) => saved.push(value),
    },
  }, { root: fakeRoot(), matchMedia: () => fakeMedia(false) });

  await controller.load();
  assert.equal(controller.state.values.modbusPointHistoryRetention, '7-days');
  await controller.save({ modbusPointHistoryRetention: 'forever' });

  assert.equal(controller.state.values.modbusPointHistoryRetention, 'forever');
  assert.equal(saved[0].modbusPointHistoryRetention, 'forever');
  controller.dispose();
});

function fakeRoot() {
  const values = new Set();
  return {
    dataset: {},
    classList: {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      toggle: (name, active) => active ? values.add(name) : values.delete(name),
      has: (name) => values.has(name),
    },
  };
}

function fakeMedia(initial) {
  let listener = null;
  return {
    matches: initial,
    addEventListener: (_name, callback) => { listener = callback; },
    removeEventListener: (_name, callback) => { if (listener === callback) listener = null; },
    change(matches) { this.matches = matches; listener?.({ matches }); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
