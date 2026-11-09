import { assertRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import { createApp } from 'vue';

import App from './App.vue';
import { runtimeAdapterKey, useRuntimeAdapter, presentationStorageKey } from './runtimeContext.js';

export { runtimeAdapterKey, useRuntimeAdapter, presentationStorageKey };

export function createWorkbench(runtimeAdapter, { presentationStorage = null } = {}) {
  assertRuntimeAdapter(runtimeAdapter);
  if (typeof runtimeAdapter.runtimeName !== 'string' || runtimeAdapter.runtimeName.trim() === '') {
    throw new TypeError('runtimeName must be a nonblank string');
  }

  const app = createApp(App);
  app.provide(runtimeAdapterKey, runtimeAdapter);
  if (presentationStorage) app.provide(presentationStorageKey, presentationStorage);
  return app;
}
