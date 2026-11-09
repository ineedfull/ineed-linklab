<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { createProtocolEndpointCatalog } from '../model/protocolEndpointCatalog.js';
import { CircleHelp, PanelLeftClose, PanelLeftOpen, Plus, Settings } from 'lucide-vue-next';
import AcceptancePanel from '../components/AcceptancePanel.vue';
import DeviceTemplatesPanel from '../components/DeviceTemplatesPanel.vue';
import { createAcceptanceTargets } from '../model/acceptanceTargets.js';
import { createAcceptanceRunner } from '../model/acceptanceRunner.js';
import { createAcceptanceWorkspace } from '../model/acceptanceWorkspace.js';
import appIcon from '../assets/ineed-linklab.svg';
import { useDesktopLayout } from '../model/useDesktopLayout.js';

import AboutPanel from '../components/AboutPanel.vue';
import Dlt645Panel from '../components/Dlt645Panel.vue';
import Dlt645SimulatorPanel from '../components/Dlt645SimulatorPanel.vue';
import EndpointDialog from '../components/EndpointDialog.vue';
import EndpointTree from '../components/EndpointTree.vue';
import FrameList from '../components/FrameList.vue';
import FrameToolbar from '../components/FrameToolbar.vue';
import LogList from '../components/LogList.vue';
import ModbusPanel from '../components/ModbusPanel.vue';
import SendPanel from '../components/SendPanel.vue';
import SessionStatusBar from '../components/SessionStatusBar.vue';
import SettingsPanel from '../components/SettingsPanel.vue';
import OpcuaServerPanel from '../components/OpcuaServerPanel.vue';
import OpcuaPanel from '../components/OpcuaPanel.vue';
import StompPanel from '../components/StompPanel.vue';
import ToolboxPanel from '../components/ToolboxPanel.vue';
import WorkspaceToolsMenu from '../components/WorkspaceToolsMenu.vue';

const props = defineProps({
  model: { type: Object, required: true },
  runtime: { type: Object, required: true },
  preferences: { type: Object, required: true },
  savePreferences: { type: Function, required: true },
  revision: { type: Number, required: true },
  runtimeName: { type: String, required: true },
  loading: Boolean,
  loadError: { type: String, default: '' },
  serialPorts: { type: Array, default: () => [] },
  scanningPorts: Boolean,
  serialScanError: { type: String, default: '' },
  saveCommand: { type: Function, required: true },
  sendCommand: { type: Function, required: true },
  workspaceImportedCommand: { type: Function, required: true },
});
const emit = defineEmits([
  'select-endpoint', 'select-peer', 'endpoint-filter', 'frame-filters',
  'clear-realtime', 'delete-endpoint', 'open-endpoint',
  'cancel-open', 'close-endpoint', 'scan-serial-ports',
  'workspace-imported',
]);

const { density, sidebarWidth, sidebarOpen, composerHeight, resizeSidebar, resizeSidebarWithKeys, toggleDensity } = useDesktopLayout('devtool');
const treeCollapsed = computed({ get: () => !sidebarOpen.value, set: value => { sidebarOpen.value = !value; } });
const streamController = ref(null);
const sendDrafts = new Map();
const following = ref(props.preferences.values.autoScroll);
const streamContext = computed(() => [state.value.activeEndpointId, activeView.value,
  state.value.frameFilters.direction, state.value.frameFilters.keyword, state.value.frameFilters.peerId].join('|'));
const activeView = ref('messages');
const dialogOpen = ref(false);
const editingEndpoint = ref(null);
const settingsOpen = ref(false);
const aboutOpen = ref(false);
const toolboxOpen = ref(false);
const acceptanceOpen = ref(false);
const deviceTemplatesOpen = ref(false);
const acceptanceEpoch = ref(0);
const catalog = shallowRef(createProtocolEndpointCatalog(props.runtime, { reactive }));
const acceptanceTargets = createAcceptanceTargets({ model: props.model, getCatalog: () => catalog.value, runtime: props.runtime });
const acceptanceRunner = createAcceptanceRunner(acceptanceTargets);
const acceptanceWorkspace = createAcceptanceWorkspace(props.runtime, { runner: acceptanceRunner });
async function prepareForShutdown() {
  await acceptanceWorkspace.stop();
  await acceptanceWorkspace.flush();
}
// Invalidate report ownership before native replacement, including when its dialog cancels.
const settingsRuntime = { ...props.runtime, workspace: { ...props.runtime.workspace, import: async (...args) => {
  await prepareForShutdown();
  await acceptanceWorkspace.reload();
  return props.runtime.workspace.import(...args);
} } };
defineExpose({ prepareForShutdown });
const protocolSelection = ref('');
const visitedProtocols = reactive(new Set());
const protocolError = ref('');
const endpointFilter = ref(props.model.state.endpointFilter || 'all');
const ordinaryTreeId = id => `ordinary:${id}`;
const ordinaryByTreeId = computed(() => new Map(state.value.endpoints.map(endpoint => [ordinaryTreeId(endpoint.id), endpoint])));
const allEndpoints = computed(() => [...state.value.endpoints.map(endpoint => ({ ...endpoint, id: ordinaryTreeId(endpoint.id) })), ...catalog.value.endpoints]);
const treeMap = source => new Map([...source].map(([id, value]) => [ordinaryTreeId(id), value]));
const filteredEndpoints = computed(() => allEndpoints.value.filter(endpoint => endpointFilter.value === 'all'
  || endpoint.transport === endpointFilter.value || endpoint.transport.startsWith(`${endpointFilter.value}-`)));
const selectedEndpointId = computed(() => protocolSelection.value || ordinaryTreeId(state.value.activeEndpointId));
const visitedEndpoints = computed(() => catalog.value.endpoints.filter(endpoint => visitedProtocols.has(endpoint.id)));
const treeStatuses = computed(() => {
  const statuses = treeMap(state.value.statuses);
  for (const [id, api] of catalog.value.state.instances) statuses.set(id, { status: api.state.status });
  return statuses;
});
const editingProtocolLocked = computed(() => {
  if (!['opcua-client', 'opcua-server', 'stomp-client', 'stomp-server'].includes(editingEndpoint.value?.transport)) return false;
  const current = catalog.value.get(editingEndpoint.value.id).state;
  return !!current.busy || !!current.sessionId || current.status !== 'disconnected';
});
async function protocolCommand(action) {
  protocolError.value = '';
  try {
    const result = await action();
    if (result?.ok === false) protocolError.value = result.error?.message || '操作失败，请重试';
    return result;
  } catch (error) {
    protocolError.value = error?.message || '操作失败，请重试';
    return { ok: false, error };
  }
}
function selectEndpoint(id) {
  const ordinary = ordinaryByTreeId.value.get(id);
  if (!ordinary && catalog.value.has(id)) {
    catalog.value.get(id);
    visitedProtocols.add(id);
    protocolSelection.value = id;
  } else {
    protocolSelection.value = '';
    emit('select-endpoint', ordinary?.id ?? id);
  }
}
function filterEndpoints(filter) {
  endpointFilter.value = filter;
  if (!['opcua', 'stomp'].includes(filter)) emit('endpoint-filter', filter);
}
function endpointAction(action, id) {
  const ordinary = ordinaryByTreeId.value.get(id);
  if (ordinary || !catalog.value.has(id)) return emit(action, ordinary?.id ?? id);
  return protocolCommand(async () => {
    const result = await (action === 'open-endpoint' ? catalog.value.connect(id) : catalog.value.disconnect(id));
    const message = catalog.value.state.instances.get(id)?.state.error;
    if (result === false && message) protocolError.value = message;
    return result;
  });
}
async function saveUnifiedEndpoint(draft, options) {
  if (!['opcua-client', 'opcua-server', 'stomp-client', 'stomp-server'].includes(draft.transport)) return props.saveCommand(draft, options);
  const result = await protocolCommand(() => catalog.value.saveEndpoint(draft));
  if (result?.ok && result.value?.id) selectEndpoint(result.value.id);
  return result;
}
async function deleteUnifiedEndpoint(id) {
  const ordinary = ordinaryByTreeId.value.get(id);
  if (ordinary || !catalog.value.has(id)) return emit('delete-endpoint', ordinary?.id ?? id);
  const result = await protocolCommand(() => catalog.value.remove(id));
  if (result?.ok) {
    visitedProtocols.delete(id);
    if (protocolSelection.value === id) protocolSelection.value = '';
  }
}
async function refreshWorkspace() {
  acceptanceEpoch.value++;
  const refreshed = await Promise.allSettled([props.workspaceImportedCommand(), acceptanceWorkspace.reload()]);
  const failed = refreshed.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  protocolSelection.value = '';
  visitedProtocols.clear();
  let cleanupError;
  try { await catalog.value.dispose(); }
  catch (error) { cleanupError = error; }
  catalog.value = createProtocolEndpointCatalog(props.runtime, { reactive });
  await protocolCommand(() => catalog.value.initialize());
  if (cleanupError) {
    protocolError.value = `旧端点会话清理失败：${cleanupError.message || cleanupError}`;
    throw cleanupError;
  }
}
onMounted(() => {
  void protocolCommand(() => catalog.value.initialize());
  void acceptanceWorkspace.load().catch(() => {});
});
onBeforeUnmount(() => {
  void acceptanceWorkspace.dispose().catch(() => {});
  void catalog.value.dispose().catch(() => {});
});
function openWorkspaceTool(tool) {
  if (tool === 'converters') toolboxOpen.value = true;
  if (tool === 'templates') deviceTemplatesOpen.value = true;
  if (tool === 'acceptance') acceptanceOpen.value = true;
}
function openSettings(event) {
  event.currentTarget.focus();
  settingsOpen.value = true;
}
function openAbout(event) {
  event.currentTarget.focus();
  aboutOpen.value = true;
}

const state = computed(() => {
  void props.revision;
  return { ...props.model.state };
});
const activeEndpoint = computed(() => {
  void props.revision;
  return props.model.activeEndpoint;
});
const endpointNames = computed(() => {
  void props.revision;
  return allEndpoints.value.map(({ name }) => name);
});
const activeOperation = computed(() => state.value.operations.get(state.value.activeEndpointId) ?? null);
const activeStatus = computed(() => state.value.statuses.get(state.value.activeEndpointId) ?? null);
const activeReconnectState = computed(() => {
  void props.revision;
  return props.model.reconnectStateFor(state.value.activeEndpointId);
});
const activePeers = computed(() => {
  void props.revision;
  return props.model.peersForEndpoint(state.value.activeEndpointId);
});
const endpointCounters = computed(() => (
  state.value.endpointCounters.get(state.value.activeEndpointId)
  ?? { received: 0, sent: 0, logs: 0 }
));
const visibleFrames = computed(() => {
  void props.revision;
  return props.model.visibleFrames;
});
const visibleLogs = computed(() => {
  const keyword = state.value.frameFilters.keyword.trim().toLowerCase();
  return props.model.visibleLogs.filter((log) => (
    !keyword || String(log.message).toLowerCase().includes(keyword)
  ));
});
const activeCommandError = computed(() => {
  void props.revision;
  return props.model.commandErrorForEndpoint(state.value.activeEndpointId);
});
const isModbusEndpoint = computed(() => activeEndpoint.value?.transport?.startsWith('modbus-'));
const isDlt645Endpoint = computed(() => activeEndpoint.value?.transport?.startsWith('dlt645-'));
const isDlt645Master = computed(() => activeEndpoint.value?.transport === 'dlt645-master');
const modbusRunning = computed(() => (
  ['open', 'listening'].includes(activeStatus.value?.status)
  || Boolean(activeOperation.value?.sessionId)
));

const filterDrafts = new Map();
watch(() => state.value.activeEndpointId, (id, previous) => {
  if (previous) filterDrafts.set(previous, { ...state.value.frameFilters });
  const filters = filterDrafts.get(id) ?? { direction: 'all', keyword: '', peerId: 'all' };
  emit('frame-filters', filters);
});

function showCreateDialog() {
  editingEndpoint.value = null;
  dialogOpen.value = true;
}

function showEditDialog(endpoint) {
  endpoint = ordinaryByTreeId.value.get(endpoint.id) ?? endpoint;
  if (!['opcua-client', 'opcua-server', 'stomp-client', 'stomp-server'].includes(endpoint.transport)) void props.model.commands.cancelReconnect(endpoint.id);
  editingEndpoint.value = endpoint;
  dialogOpen.value = true;
}

function openHistory(kind) {
  return props.runtime.window.openHistory({
    kind,
    ...(state.value.activeEndpointId ? { endpointId: state.value.activeEndpointId } : {}),
  });
}
</script>

<template>
  <div
    class="linklab-shell"
    :class="{ 'tree-collapsed': treeCollapsed }"
    :data-density="density"
    :style="{ '--endpoint-tree-width': sidebarWidth + 'px' }"
  >
    <aside class="linklab-shell__tree">
      <header class="linklab-shell__brand">
        <div class="linklab-shell__identity">
          <img
            class="linklab-shell__icon"
            :src="appIcon"
            :alt="treeCollapsed ? 'Ineed LinkLab' : ''"
            title="Ineed LinkLab · 通信调试工具"
            width="28"
            height="28"
          >
          <span v-if="!treeCollapsed">LinkLab</span>
        </div>
        <button
          class="icon-button"
          type="button"
          :aria-label="treeCollapsed ? '展开端点列表' : '折叠端点列表'"
          :title="treeCollapsed ? '展开端点列表' : '折叠端点列表'"
          @click="treeCollapsed = !treeCollapsed"
        >
          <PanelLeftOpen
            v-if="treeCollapsed"
            :size="16"
          />
          <PanelLeftClose
            v-else
            :size="16"
          />
        </button>
      </header>

      <div
        v-if="!treeCollapsed"
        class="linklab-shell__tree-heading"
      >
        <span>端点</span>
        <button
          class="icon-button"
          type="button"
          aria-label="添加端点"
          title="添加端点"
          @click="showCreateDialog"
        >
          <Plus :size="16" />
        </button>
      </div>

      <EndpointTree
        :endpoints="filteredEndpoints"
        :active-endpoint-id="selectedEndpointId"
        :active-peer-id="state.activePeerId"
        :statuses="treeStatuses"
        :operations="treeMap(state.operations)"
        :reconnects="treeMap(state.reconnects)"
        :peers="treeMap(state.peers)"
        :counters="treeMap(state.endpointCounters)"
        :collapsed="treeCollapsed"
        :loading="loading"
        :error="loadError"
        :filter="endpointFilter"
        @select-endpoint="selectEndpoint"
        @select-peer="emit('select-peer', $event)"
        @filter="filterEndpoints"
        @edit="showEditDialog"
        @open="endpointAction('open-endpoint', $event)"
        @cancel="endpointAction('cancel-open', $event)"
        @close="endpointAction('close-endpoint', $event)"
        @delete="deleteUnifiedEndpoint"
      />

      <footer
        class="linklab-shell__runtime"
        :title="runtimeName"
      >
        <WorkspaceToolsMenu
          :collapsed="treeCollapsed"
          @select="openWorkspaceTool"
        />
        <button
          class="icon-button"
          type="button"
          aria-label="打开设置"
          title="设置"
          @click="openSettings"
        >
          <Settings :size="15" /><span v-if="!treeCollapsed">设置</span>
        </button>
        <button
          class="icon-button"
          type="button"
          aria-label="打开关于"
          title="关于"
          @click="openAbout"
        >
          <CircleHelp :size="15" /><span v-if="!treeCollapsed">关于</span>
        </button>
      </footer>
    </aside>

    <div
      v-if="!treeCollapsed"
      class="resource-resizer"
      role="separator"
      tabindex="0"
      aria-label="调整资源栏宽度"
      aria-orientation="vertical"
      :aria-valuenow="sidebarWidth"
      aria-valuemin="240"
      aria-valuemax="380"
      @pointerdown="resizeSidebar"
      @keydown="resizeSidebarWithKeys"
    />
    <main class="linklab-shell__workspace">
      <p
        v-if="state.historyPersistenceWarning"
        class="state-message state-message--error"
        role="alert"
      >
        历史记录保存失败，部分记录可能不完整：{{ state.historyPersistenceWarning.message }}
      </p>
      <p
        v-if="protocolError || catalog.state.error"
        class="state-message state-message--error"
        role="alert"
      >
        {{ protocolError || catalog.state.error }}
      </p>
      <template
        v-for="endpoint in visitedEndpoints"
        :key="endpoint.id"
      >
        <OpcuaPanel
          v-if="endpoint.transport === 'opcua-client'"
          v-show="protocolSelection === endpoint.id"
          :runtime="runtime"
          :controller="catalog.get(endpoint.id)"
          :endpoint="endpoint"
        />
        <OpcuaServerPanel
          v-else-if="endpoint.transport === 'opcua-server'"
          v-show="protocolSelection === endpoint.id"
          :visible="protocolSelection === endpoint.id"
          :runtime="runtime"
          :controller="catalog.get(endpoint.id)"
          :endpoint="endpoint"
        />
        <StompPanel
          v-else
          v-show="protocolSelection === endpoint.id"
          :visible="protocolSelection === endpoint.id"
          :runtime="runtime"
          :controller="catalog.get(endpoint.id)"
          :endpoint="endpoint"
        />
      </template>
      <div
        v-show="!protocolSelection"
        class="linklab-shell__main"
      >
        <template v-if="activeEndpoint">
          <SessionStatusBar
            :endpoint="activeEndpoint"
            :operation="activeOperation"
            :status-event="activeStatus"
            :reconnect-state="activeReconnectState"
            :counters="endpointCounters"
            :peer-count="activePeers.length"
            :command-error="activeCommandError"
            @open="emit('open-endpoint', activeEndpoint.id)"
            @cancel="emit('cancel-open', activeEndpoint.id)"
            @close="emit('close-endpoint', activeEndpoint.id)"
          />
          <template v-if="!isModbusEndpoint && !isDlt645Endpoint">
            <FrameToolbar
              :active-view="activeView"
              :following="following"
              :density="density"
              :filters="state.frameFilters"
              :peers="activePeers"
              @follow="streamController?.toggleFollow()"
              @density="toggleDensity"
              @view="activeView = $event"
              @filters="emit('frame-filters', $event)"
              @history="openHistory"
              @clear="emit('clear-realtime')"
            />
            <section
              class="linklab-shell__stream"
            >
              <FrameList
                v-if="activeView === 'messages'"
                ref="streamController"
                :context-key="streamContext"
                :frames="visibleFrames"
                :peers="activePeers"
                :preview-byte-limit="preferences.values.previewByteLimit"
                :auto-scroll="preferences.values.autoScroll"
                @follow-change="following = $event"
              />
              <LogList
                v-else
                ref="streamController"
                :context-key="streamContext"
                :logs="visibleLogs"
                :auto-scroll="preferences.values.autoScroll"
                @follow-change="following = $event"
              />
            </section>
            <SendPanel
              v-model:height="composerHeight"
              :draft-store="sendDrafts"
              :endpoint="activeEndpoint"
              :active-endpoint-id="state.activeEndpointId"
              :operation="activeOperation"
              :status-event="activeStatus"
              :peers="activePeers"
              :active-peer-id="state.activePeerId"
              :send-command="sendCommand"
              :scheduled-sender="model.scheduledSender"
              :runtime="runtime"
              :theme="preferences.resolvedTheme"
              :large-font="preferences.values.largeFont"
              :default-framing="preferences.values.defaultFraming"
            />
          </template>
          <ModbusPanel
            v-else-if="isModbusEndpoint"
            :key="activeEndpoint.id"
            :endpoint="activeEndpoint"
            :runtime="runtime"
            :running="modbusRunning"
            :session-id="activeOperation?.sessionId ?? null"
            :scheduler="model.modbusMasterScheduler"
            :simulation="model.modbusSlaveSimulation"
            :save-command="saveCommand"
            :collector-status="model.modbusPointHistoryStatus"
          />
          <Dlt645Panel
            v-else-if="isDlt645Master"
            :key="activeEndpoint.id"
            :endpoint="activeEndpoint"
            :frames="state.frames"
            :running="modbusRunning"
            :session-id="activeOperation?.sessionId ?? null"
            :send-command="sendCommand"
            :save-command="saveCommand"
          />
          <Dlt645SimulatorPanel
            v-else
            :key="activeEndpoint.id"
            :endpoint="activeEndpoint"
            :controller="model.dlt645Simulators?.forEndpoint(activeEndpoint.id) ?? null"
            :frames="state.frames"
            :running="modbusRunning"
            :session-id="activeOperation?.sessionId ?? null"
            :send-command="sendCommand"
            :save-command="saveCommand"
          />
        </template>

        <section
          v-else
          class="linklab-shell__empty"
          aria-live="polite"
        >
          <div
            v-if="loading"
            class="state-message state-message--loading"
          >
            正在加载端点...
          </div>
          <div
            v-else-if="loadError"
            class="state-message state-message--error"
          >
            <strong>无法加载端点</strong>
            <span>{{ loadError }}</span>
          </div>
          <div
            v-else
            class="state-message"
          >
            <strong>未选择端点</strong>
            <button
              type="button"
              class="command-button"
              @click="showCreateDialog"
            >
              <Plus :size="15" />
              添加端点
            </button>
          </div>
        </section>
      </div>
    </main>

    <EndpointDialog
      :open="dialogOpen"
      :endpoint="editingEndpoint"
      :websocket-headers="model.websocketHeadersForEndpoint?.(editingEndpoint?.id) ?? []"
      :existing-names="endpointNames"
      :save-command="saveUnifiedEndpoint"
      :connection-locked="editingProtocolLocked"
      :serial-ports="serialPorts"
      :scanning-ports="scanningPorts"
      :serial-scan-error="serialScanError"
      @close="dialogOpen = false"
      @scan-serial-ports="emit('scan-serial-ports')"
    />
    <SettingsPanel
      :open="settingsOpen"
      :density="density"
      :runtime="settingsRuntime"
      :preferences="preferences.values"
      :preference-revision="preferences.revision"
      :modbus-history-status="model.modbusPointHistoryStatus"
      :save-command="savePreferences"
      :workspace-imported-command="refreshWorkspace"
      @density="density = $event"
      @close="settingsOpen = false"
      @workspace-imported="emit('workspace-imported', $event)"
    />
    <DeviceTemplatesPanel
      :key="`models-${acceptanceEpoch}`"
      :open="deviceTemplatesOpen"
      :endpoints="state.endpoints"
      :workspace="acceptanceWorkspace"
      :runtime="runtime"
      :create-endpoint="saveUnifiedEndpoint"
      @close="deviceTemplatesOpen = false"
    />
    <AcceptancePanel
      :key="acceptanceEpoch"
      :open="acceptanceOpen"
      :workspace="acceptanceWorkspace"
      :targets="acceptanceTargets"
      :runtime="runtime"
      :revision="revision"
      @close="acceptanceOpen = false"
    />
    <ToolboxPanel
      :open="toolboxOpen"
      @close="toolboxOpen = false"
    />
    <AboutPanel
      :open="aboutOpen"
      :runtime-name="runtimeName"
      :open-website="runtime.window?.openWebsite"
      @close="aboutOpen = false"
    />
  </div>
</template>

<style scoped>
.linklab-shell__workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
}
.linklab-shell__workspace > .linklab-shell__main {
  flex: 1;
}
.linklab-shell__workspace > [role="alert"] {
  flex: none;
  margin: 0;
  padding: 8px 12px;
  overflow-wrap: anywhere;
}
</style>
