<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

import LinkLabShell from './layouts/LinkLabShell.vue';
import HistoryWindow from './layouts/HistoryWindow.vue';
import { createWorkbenchModel } from './model/createWorkbenchModel.js';
import { parseHistoryLocation } from './model/secondaryViews.js';
import { createUiPreferences } from './model/uiPreferences.js';
import { useRuntimeAdapter } from './runtimeContext.js';
import './styles/workbench.css';
import './styles/desktop.css';
import './styles/about.css';
import './styles/typography.css';
import './styles/dialog-forms.css';
import './styles/select-controls.css';

const runtimeAdapter = useRuntimeAdapter();
const preferenceController = createUiPreferences(runtimeAdapter);
const preferenceRenderRevision = ref(0);
const preferences = computed(() => {
  void preferenceRenderRevision.value;
  return {
    ...preferenceController.state,
    revision: preferenceController.state.settingsRevision,
  };
});
const locationParams = new URLSearchParams(globalThis.location?.search ?? '');
const historyRoute = locationParams.get('view') === 'history'
  ? parseHistoryLocation(globalThis.location.search)
  : null;
const model = createWorkbenchModel(runtimeAdapter, { frameLimit: 2000, logLimit: 1000 });
const guardedRuntimeAdapter = {
  ...runtimeAdapter,
  workspace: { ...runtimeAdapter.workspace, import: () => model.importWorkspace() },
  modbusHistory: {
    ...runtimeAdapter.modbusHistory,
    clear: (query) => model.clearModbusPointHistory(query),
    exportCsv: (query) => model.exportModbusPointHistory(query),
  },
};
const shell = ref(null);
const revision = ref(0);
const loading = ref(true);
const loadError = ref('');
const serialPorts = ref([]);
const scanningPorts = ref(false);
const serialScanError = ref('');
let unsubscribeModel = () => {};
let unsubscribePreferences = () => {};
let unsubscribeShutdown = () => {};
let operationSequence = 0;
let serialScanGeneration = 0;
let endpointLoadGeneration = 0;

unsubscribeShutdown = runtimeAdapter.lifecycle.onBeforeShutdown(async ({ requestId }) => {
  try {
    try { await shell.value?.prepareForShutdown?.(); }
    catch { /* Continue flushing communication history if acceptance saving fails. */ }
    await model.flushModbusPointHistory();
  } catch {
    // Native shutdown still needs acknowledgement so its deadline remains a fallback.
  } finally {
    try { await runtimeAdapter.lifecycle.readyForShutdown(requestId); } catch { /* Host is exiting. */ }
  }
});

async function run(command) {
  return command();
}

async function saveEndpoint(draft, options) {
  return run(() => model.commands.save(draft, options));
}

async function deleteEndpoint(endpointId) {
  return run(() => model.commands.delete(endpointId));
}

async function sendEndpoint(request) {
  return run(() => model.commands.send(request));
}

async function openEndpoint(endpointId) {
  operationSequence += 1;
  const operationId = `open-${Date.now()}-${operationSequence}`;
  return run(() => model.commands.open(endpointId, operationId));
}

async function cancelOpen(endpointId) {
  const operationId = model.state.operations.get(endpointId)?.operationId;
  if (!operationId) return null;
  return run(() => model.commands.cancelOpen(endpointId, operationId));
}

async function cancelEndpoint(endpointId) {
  if (model.reconnectStateFor(endpointId)) {
    return run(() => model.commands.cancelReconnect(endpointId));
  }
  return cancelOpen(endpointId);
}

async function scanSerialPorts() {
  const generation = ++serialScanGeneration;
  scanningPorts.value = true;
  serialScanError.value = '';
  try {
    const result = await run(() => model.commands.scanSerialPorts());
    if (generation !== serialScanGeneration) return result;
    if (result.ok) serialPorts.value = result.value;
    else serialScanError.value = result.error.message;
    return result;
  } catch (error) {
    if (generation === serialScanGeneration) {
      serialScanError.value = error instanceof Error ? error.message : String(error);
    }
    return { ok: false, error };
  } finally {
    if (generation === serialScanGeneration) scanningPorts.value = false;
  }
}

async function refreshEndpoints({ reset = false } = {}) {
  const generation = ++endpointLoadGeneration;
  loading.value = true;
  loadError.value = '';
  if (reset) model.resetWorkspaceState();
  let result;
  try {
    result = await model.commands.loadEndpoints();
  } catch (error) {
    result = { ok: false, error };
  }
  if (generation !== endpointLoadGeneration) return { current: false, generation, result };
  loading.value = false;
  if (!result.ok) loadError.value = result.error instanceof Error
    ? result.error.message
    : String(result.error?.message ?? result.error);
  return { current: true, generation, result };
}

async function refreshWorkspace() {
  const endpointPromise = refreshEndpoints({ reset: true });
  const generation = endpointLoadGeneration;
  const [endpointOutcome, preferenceOutcome] = await Promise.allSettled([
    endpointPromise, preferenceController.reload(),
  ]);
  if (generation !== endpointLoadGeneration) return;
  if (endpointOutcome.status === 'rejected') throw endpointOutcome.reason;
  if (!endpointOutcome.value.current
    || endpointOutcome.value.generation !== endpointLoadGeneration) return;
  if (preferenceOutcome.status === 'rejected' && !loadError.value) {
    loadError.value = preferenceOutcome.reason instanceof Error
      ? preferenceOutcome.reason.message
      : String(preferenceOutcome.reason);
  }
  if (!endpointOutcome.value.result.ok) throw endpointOutcome.value.result.error;
  if (preferenceOutcome.status === 'rejected') throw preferenceOutcome.reason;
}

onMounted(async () => {
  unsubscribePreferences = preferenceController.subscribe((state) => {
    preferenceRenderRevision.value += 1;
    if (!historyRoute && state.ready) model.updatePreferences(state.values);
  });
  try { await preferenceController.load(); } catch { /* Error remains in preference state. */ }
  if (historyRoute) return;
  model.updatePreferences(preferenceController.state.values);
  unsubscribeModel = model.subscribe(() => { revision.value += 1; });
  await refreshEndpoints();
});

onUnmounted(() => {
  serialScanGeneration += 1;
  endpointLoadGeneration += 1;
  unsubscribeModel();
  unsubscribePreferences();
  unsubscribeShutdown();
  preferenceController.dispose();
  model.dispose();
});
</script>

<template>
  <div
    v-if="!preferences.ready"
    class="app-preferences-loading"
    role="status"
  >
    正在加载界面设置...
  </div>
  <HistoryWindow
    v-else-if="historyRoute"
    :runtime="guardedRuntimeAdapter"
    :kind="historyRoute.kind"
    :endpoint-id="historyRoute.endpointId"
    :preferences="preferences"
  />
  <LinkLabShell
    v-else
    ref="shell"
    :model="model"
    :runtime="guardedRuntimeAdapter"
    :preferences="preferences"
    :save-preferences="preferenceController.save"
    :revision="revision"
    :runtime-name="runtimeAdapter.runtimeName"
    :loading="loading"
    :load-error="loadError"
    :serial-ports="serialPorts"
    :scanning-ports="scanningPorts"
    :serial-scan-error="serialScanError"
    :save-command="saveEndpoint"
    :send-command="sendEndpoint"
    :workspace-imported-command="refreshWorkspace"
    @select-endpoint="model.selectEndpoint($event)"
    @select-peer="model.selectPeer($event)"
    @endpoint-filter="model.setEndpointFilter($event)"
    @frame-filters="model.setFrameFilters($event)"
    @clear-realtime="model.clearRealtime()"
    @delete-endpoint="deleteEndpoint"
    @open-endpoint="openEndpoint"
    @cancel-open="cancelEndpoint"
    @close-endpoint="run(() => model.commands.close($event))"
    @scan-serial-ports="scanSerialPorts"
  />
</template>
