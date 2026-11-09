<script setup>
import {
  Bookmark, Braces, History, LoaderCircle, Play, Send, Square, WrapText,
} from 'lucide-vue-next';
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';

import {
  getSendEligibility,
  hasActiveSendSession,
  isValidSendTarget,
  normalizeSendTarget,
} from '../model/sendPanelState.js';
import { isWebSocketTransport } from '../model/websocketConfig.js';
import { encodeSendPayload } from '../model/sendPayloadCodec.js';
import { formatHistoryPayload } from '../model/secondaryViews.js';
import SendLibraryPanel from './SendLibraryPanel.vue';

const PayloadEditor = defineAsyncComponent(() => import('./PayloadEditor.vue'));

const props = defineProps({
  endpoint: { type: Object, required: true },
  height: { type: Number, default: 220 },
  draftStore: { type: Map, default: () => new Map() },
  activeEndpointId: { type: String, default: null },
  operation: { type: Object, default: null },
  statusEvent: { type: Object, default: null },
  peers: { type: Array, default: () => [] },
  activePeerId: { type: String, default: null },
  sendCommand: { type: Function, required: true },
  scheduledSender: { type: Object, required: true },
  runtime: { type: Object, required: true },
  theme: { type: String, default: 'light' },
  largeFont: Boolean,
  defaultFraming: { type: String, default: 'none' },
});
const emit = defineEmits(['update:height']);
const mode = ref('text');
const websocketMessageType = ref('auto');
const payload = ref('');
const target = ref('endpoint');
const tcpTargetMode = ref('broadcast');
const selectedTcpPeerIds = ref([]);
const appendCrlf = ref(false);
const framing = ref(props.defaultFraming);
const sendError = ref('');
const sendWarning = ref('');
const sendPending = ref(false);
const scheduledEnabled = ref(false);
const scheduledIntervalMs = ref(1000);
const scheduledCountMode = ref('unlimited');
const scheduledCount = ref(10);
const scheduledStatus = ref(props.scheduledSender.getStatus(props.endpoint.id));
const panelHeight = computed({ get: () => props.height, set: value => emit('update:height', value) });
const libraryOpen = ref(false);
const libraryTab = ref('templates');
const libraryRefreshRevision = ref(0);
let dragState = null;
let activeAttempt = 0;
let contextVersion = 0;
let disposed = false;
let unsubscribeScheduledSender = () => {};

const isServer = computed(() => (
  ['tcp-server', 'websocket-server', 'udp-server'].includes(props.endpoint.transport)
));
const isTcpServer = computed(() => ['tcp-server', 'websocket-server'].includes(props.endpoint.transport));
const isWebSocket = computed(() => isWebSocketTransport(props.endpoint.transport));
const isUdp = computed(() => (
  props.endpoint.transport === 'udp-client' || props.endpoint.transport === 'udp-server'
));
const hasDefaultServerTarget = computed(() => isValidSendTarget({
  endpoint: props.endpoint,
  peers: props.peers,
  target: 'endpoint',
}));
const sessionActive = computed(() => hasActiveSendSession(sendContext()));
const payloadEncoding = computed(() => encodeSendPayload({
  mode: mode.value,
  payload: payload.value,
  appendCrlf: !isWebSocket.value && appendCrlf.value,
}));
const effectiveMessageType = computed(() => websocketMessageType.value === 'auto'
  ? (mode.value === 'hex' ? 'binary' : 'text') : websocketMessageType.value);
const librarySnapshot = computed(() => payloadEncoding.value.ok ? {
  format: isWebSocket.value ? (effectiveMessageType.value === 'binary' ? 'hex' : 'text') : mode.value,
  framing: effectiveFraming(),
  target: buildSendTarget(),
  payloadBase64: encodeBase64(payloadEncoding.value.bytes),
} : null);
const sendEligibility = computed(() => getSendEligibility({
  ...sendContext(),
  payloadValid: payloadEncoding.value.ok,
  payloadError: payloadEncoding.value.error,
}));
const scheduledActive = computed(() => (
  scheduledStatus.value.active && scheduledStatus.value.endpointId === props.endpoint.id
));
const scheduledValuesValid = computed(() => (
  Number.isInteger(Number(scheduledIntervalMs.value))
  && Number(scheduledIntervalMs.value) >= 100
  && Number(scheduledIntervalMs.value) <= 60_000
  && (scheduledCountMode.value === 'unlimited'
    || (Number.isInteger(Number(scheduledCount.value)) && Number(scheduledCount.value) >= 1))
));
const canSend = computed(() => (
  sendEligibility.value.canSend && !sendPending.value && !scheduledActive.value
));
const canStartScheduled = computed(() => (
  scheduledEnabled.value
  && sendEligibility.value.canSend
  && !sendPending.value
  && !scheduledActive.value
  && scheduledValuesValid.value
));
const sendContextIdentity = computed(() => [
  props.endpoint.id,
  props.activeEndpointId ?? '',
  props.operation?.operationId ?? '',
  props.operation?.sessionId ?? '',
].join('\u0000'));

const drafts = props.draftStore;
watch(() => props.endpoint.id, (id, previous) => {
  if (previous) rememberDraft(previous);
  const draft = drafts.get(id);
  payload.value = draft?.payload ?? '';
  mode.value = draft?.mode ?? 'text';
  websocketMessageType.value = draft?.websocketMessageType ?? 'auto';
  appendCrlf.value = draft?.appendCrlf ?? false;
  target.value = normalizeTarget('');
  tcpTargetMode.value = 'broadcast';
  selectedTcpPeerIds.value = [];
  framing.value = draft?.framing ?? props.defaultFraming;
  scheduledStatus.value = props.scheduledSender.getStatus(props.endpoint.id);
  scheduledEnabled.value = scheduledStatus.value.active;
}, { immediate: true });

watch(sendContextIdentity, (_current, previous) => {
  if (previous === undefined) return;
  retireActiveAttempt();
  scheduledStatus.value = props.scheduledSender.getStatus(props.endpoint.id);
}, { flush: 'sync' });

watch(() => props.activePeerId, () => {
  if (isTcpServer.value) {
    if (props.peers.some(({ id }) => id === props.activePeerId)) {
      tcpTargetMode.value = 'selected';
      selectedTcpPeerIds.value = [props.activePeerId];
    }
    return;
  }
  target.value = normalizeTarget(target.value, true);
});

watch([
  () => props.peers.map(({ id }) => id).join('\u0000'),
  () => props.endpoint.config?.targetHost,
  () => props.endpoint.config?.targetPort,
], () => {
  if (isTcpServer.value) {
    const livePeerIds = new Set(props.peers.map(({ id }) => id));
    selectedTcpPeerIds.value = selectedTcpPeerIds.value.filter((peerId) => (
      livePeerIds.has(peerId)
    ));
    return;
  }
  target.value = normalizeTarget(target.value);
});

watch([
  () => props.endpoint.id,
  sendContextIdentity,
  payload,
  mode,
  target,
  tcpTargetMode,
  () => selectedTcpPeerIds.value.join('\u0000'),
  appendCrlf,
  websocketMessageType,
], () => {
  contextVersion += 1;
  sendError.value = '';
  sendWarning.value = '';
}, { flush: 'sync' });

function rememberDraft(id = props.endpoint.id) {
  drafts.set(id, { payload: payload.value, mode: mode.value, appendCrlf: appendCrlf.value, framing: framing.value, websocketMessageType: websocketMessageType.value });
}

function formatJson() {
  try {
    payload.value = JSON.stringify(JSON.parse(payload.value), null, 2);
  } catch {
    return;
  }
}

function sendContext() {
  return {
    endpoint: props.endpoint,
    activeEndpointId: props.activeEndpointId,
    operation: props.operation,
    statusEvent: props.statusEvent,
    peers: props.peers,
    target: isTcpServer.value ? buildSendTarget() : target.value,
  };
}

function normalizeTarget(preferredTarget, preferActivePeer = false) {
  return normalizeSendTarget({
    endpoint: props.endpoint,
    peers: props.peers,
    activePeerId: props.activePeerId,
    target: preferredTarget,
    preferActivePeer,
  });
}

async function sendPayload() {
  if (sendPending.value) return;
  target.value = normalizeTarget(target.value);
  if (!canSend.value) return;
  const attempt = activeAttempt + 1;
  activeAttempt = attempt;
  const attemptedVersion = contextVersion;
  const request = buildSendRequest();
  sendPending.value = true;
  sendError.value = '';
  sendWarning.value = '';
  try {
    const result = await props.sendCommand(request);
    if (isCurrentAttempt(attempt, attemptedVersion)) {
      if (result?.ok !== true) {
        sendError.value = result?.error?.message ?? '发送失败';
      } else {
        if (Number(result.value?.failureCount) > 0) {
          sendWarning.value = `已发送至 ${result.value.successCount}/${result.value.peerCount} 个远端`;
        }
        if (result.value?.historyPersisted === false) {
          const historyWarning = `发送成功，但历史记录保存失败：${result.value.historyError}`;
          sendWarning.value = sendWarning.value
            ? `${sendWarning.value}；${historyWarning}`
            : historyWarning;
        }
        libraryRefreshRevision.value += 1;
      }
    }
  } catch (error) {
    if (isCurrentAttempt(attempt, attemptedVersion)) {
      sendError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!disposed && activeAttempt === attempt) sendPending.value = false;
  }
}

function buildSendRequest() {
  return {
    endpointId: props.endpoint.id,
    bytes: new Uint8Array(payloadEncoding.value.bytes),
    target: buildSendTarget(),
    format: mode.value,
    framing: effectiveFraming(),
    ...(isWebSocket.value ? { messageType: effectiveMessageType.value } : {}),
  };
}

function buildSendTarget() {
  if (isTcpServer.value) {
    return tcpTargetMode.value === 'broadcast'
      ? { type: 'broadcast' }
      : { type: 'peer', peerIds: [...selectedTcpPeerIds.value] };
  }
  if (!isServer.value || target.value === 'endpoint') return { endpointId: props.endpoint.id };
  return target.value === 'all' ? { broadcast: true } : { peerId: target.value };
}

function effectiveFraming() {
  return isWebSocket.value ? 'websocket' : isUdp.value ? 'datagram' : framing.value;
}

function openLibrary(tab) {
  if (libraryOpen.value && libraryTab.value === tab) {
    libraryOpen.value = false;
    return;
  }
  libraryTab.value = tab;
  libraryOpen.value = true;
}

function loadLibraryItem(item) {
  if (isWebSocket.value) websocketMessageType.value = 'auto';
  mode.value = ['text', 'hex', 'json'].includes(item.format) ? item.format : 'text';
  payload.value = formatHistoryPayload({
    format: mode.value,
    payloadBase64: item.payloadBase64,
  });
  appendCrlf.value = false;
  framing.value = isUdp.value
    ? 'none'
    : (['none', 'line', 'length-prefix'].includes(item.framing) ? item.framing : 'none');
  if (isTcpServer.value) {
    const requestedPeerIds = item.target?.type === 'peer'
      ? item.target.peerIds
      : (item.target?.peerId ? [item.target.peerId] : []);
    if (Array.isArray(requestedPeerIds) && requestedPeerIds.length > 0) {
      const livePeerIds = new Set(props.peers.map(({ id }) => id));
      tcpTargetMode.value = 'selected';
      selectedTcpPeerIds.value = requestedPeerIds.filter((peerId, index) => (
        typeof peerId === 'string'
        && requestedPeerIds.indexOf(peerId) === index
        && livePeerIds.has(peerId)
      ));
    } else {
      tcpTargetMode.value = 'broadcast';
      selectedTcpPeerIds.value = [];
    }
  } else {
    const preferredTarget = item.target?.peerId
      ?? (item.target?.broadcast === true ? 'all' : 'endpoint');
    target.value = normalizeTarget(preferredTarget);
  }
  libraryOpen.value = false;
}

function encodeBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function startScheduledSend() {
  target.value = normalizeTarget(target.value);
  if (!canStartScheduled.value) return;
  sendError.value = '';
  try {
    scheduledStatus.value = props.scheduledSender.start({
      endpointId: props.endpoint.id,
      sessionId: props.operation.sessionId,
      request: buildSendRequest(),
      intervalMs: Number(scheduledIntervalMs.value),
      count: scheduledCountMode.value === 'unlimited' ? null : Number(scheduledCount.value),
    });
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error);
  }
}

function stopScheduledSend() {
  const status = scheduledStatus.value;
  if (!status?.active) return false;
  return props.scheduledSender.stop(status.endpointId, status.sessionId);
}

function isCurrentAttempt(attempt, attemptedVersion) {
  return !disposed && activeAttempt === attempt && contextVersion === attemptedVersion;
}

function retireActiveAttempt() {
  activeAttempt += 1;
  sendPending.value = false;
  sendError.value = '';
}

function beginResize(event) {
  const main = event.currentTarget.closest('.linklab-shell__main');
  dragState = { startY: event.clientY, startHeight: panelHeight.value, mainHeight: main.clientHeight };
  window.addEventListener('pointermove', resizePanel);
  window.addEventListener('pointerup', endResize, { once: true });
}

function resizePanel(event) {
  if (!dragState) return;
  const next = dragState.startHeight + dragState.startY - event.clientY;
  panelHeight.value = Math.round(Math.min(500, dragState.mainHeight * 0.5, Math.max(180, next)));
}

function endResize() {
  dragState = null;
  window.removeEventListener('pointermove', resizePanel);
}

onMounted(() => {
  unsubscribeScheduledSender = props.scheduledSender.subscribe((endpointId, status) => {
    if (!disposed && endpointId === props.endpoint.id) scheduledStatus.value = status;
  });
  scheduledStatus.value = props.scheduledSender.getStatus(props.endpoint.id);
});

onUnmounted(() => {
  rememberDraft();
  disposed = true;
  unsubscribeScheduledSender();
  retireActiveAttempt();
  endResize();
});
</script>

<template>
  <section
    class="send-panel"
    :style="{ height: `${panelHeight}px` }"
  >
    <button
      class="send-panel__resize"
      type="button"
      aria-label="调整发送面板大小"
      title="调整发送面板大小"
      @pointerdown.prevent="beginResize"
      @keydown.up.prevent="panelHeight = Math.min(500, panelHeight + 20)"
      @keydown.down.prevent="panelHeight = Math.max(180, panelHeight - 20)"
    />
    <header class="send-panel__toolbar">
      <strong>发送</strong>
      <div
        class="segmented-control"
        role="radiogroup"
        aria-label="数据格式"
      >
        <button
          v-for="option in ['text', 'hex', 'json']"
          :key="option"
          type="button"
          role="radio"
          :aria-checked="mode === option"
          :class="{ active: mode === option }"
          @click="mode = option"
        >
          {{ option === 'text' ? 'Text' : option.toUpperCase() }}
        </button>
      </div>
      <label
        v-if="isTcpServer"
        class="toolbar-select send-panel__target"
      >
        <span>发送目标</span>
        <select
          v-model="tcpTargetMode"
          :disabled="!sessionActive"
          :aria-label="isWebSocket ? 'WebSocket 发送模式' : 'TCP 发送模式'"
        >
          <option value="broadcast">全部远端（{{ peers.length }}）</option>
          <option value="selected">选择远端</option>
        </select>
      </label>
      <details
        v-if="isTcpServer && tcpTargetMode === 'selected'"
        class="send-panel__peer-picker"
      >
        <summary>{{ selectedTcpPeerIds.length }}/{{ peers.length }} 个远端</summary>
        <div class="send-panel__peer-options">
          <span
            v-if="peers.length === 0"
            class="muted"
          >暂无可用远端</span>
          <label
            v-for="peer in peers"
            :key="peer.id"
            class="check-control"
          >
            <input
              v-model="selectedTcpPeerIds"
              name="tcp-peer-target"
              type="checkbox"
              :value="peer.id"
              :disabled="!sessionActive"
            >
            {{ peer.remoteAddress ?? peer.id }}
          </label>
        </div>
      </details>
      <label
        v-if="!isTcpServer"
        class="toolbar-select send-panel__target"
      >
        <span>发送目标</span>
        <select
          v-model="target"
          :disabled="!sessionActive"
          aria-label="发送目标"
        >
          <option
            v-if="!isServer"
            value="endpoint"
          >{{ endpoint.name }}</option>
          <template v-else>
            <option
              v-if="hasDefaultServerTarget"
              value="endpoint"
            >默认目标</option>
            <option
              v-if="peers.length === 0 && !hasDefaultServerTarget"
              disabled
              value=""
            >暂无可用目标</option>
            <option
              v-if="peers.length > 0"
              value="all"
            >全部远端（{{ peers.length }}）</option>
            <option
              v-for="peer in peers"
              :key="peer.id"
              :value="peer.id"
            >
              {{ peer.remoteAddress ?? peer.id }}
            </option>
          </template>
        </select>
      </label>
      <label
        v-if="!isWebSocket"
        class="check-control"
      >
        <input
          v-model="appendCrlf"
          type="checkbox"
          :disabled="mode !== 'text'"
        >
        追加 CRLF
      </label>
      <label
        v-if="!isUdp && !isWebSocket"
        class="toolbar-select"
      >
        <span>分帧</span>
        <select
          v-model="framing"
          name="framing"
          title="按行：末尾没有 CR/LF 时追加 LF；长度前缀：4 字节大端 payload 字节长度，不含前缀本身。"
        >
          <option value="none">无</option>
          <option value="line">按行</option>
          <option value="length-prefix">长度前缀</option>
        </select>
      </label>
      <span
        v-else-if="isUdp"
        class="muted"
      >数据报</span>
      <label
        v-if="isWebSocket"
        class="toolbar-select"
      ><span>消息类型</span><select
        v-model="websocketMessageType"
        aria-label="WebSocket 消息类型"
      ><option value="auto">自动（HEX 二进制 / Text、JSON 文本）</option><option value="text">文本</option><option value="binary">二进制</option></select></label>
      <button
        v-if="mode === 'json'"
        type="button"
        class="icon-button"
        aria-label="格式化 JSON"
        title="格式化 JSON"
        @click="formatJson"
      >
        <Braces :size="15" />
      </button>
      <span class="send-panel__library-actions">
        <button
          type="button"
          class="icon-button"
          :class="{ active: libraryOpen && libraryTab === 'templates' }"
          aria-label="发送模板"
          title="发送模板"
          @click="openLibrary('templates')"
        ><Bookmark :size="15" /></button>
        <button
          type="button"
          class="icon-button"
          :class="{ active: libraryOpen && libraryTab === 'history' }"
          aria-label="发送历史"
          title="发送历史"
          @click="openLibrary('history')"
        ><History :size="15" /></button>
      </span>
    </header>
    <div class="send-panel__editor">
      <PayloadEditor
        v-model="payload"
        :mode="mode"
        :disabled="!sessionActive"
        :theme="theme"
        :large-font="largeFont"
        @submit="sendPayload"
      />
    </div>
    <footer class="send-panel__footer">
      <span
        v-if="sendError"
        class="field-error"
        role="alert"
      >{{ sendError }}</span>
      <span
        v-else-if="sendWarning"
        class="send-panel__warning"
        role="status"
      >{{ sendWarning }}</span>
      <span
        v-else-if="scheduledStatus.reason === 'error'"
        class="field-error"
        role="alert"
      >{{ scheduledStatus.error?.message ?? '定时发送失败' }}</span>
      <span
        v-else-if="scheduledActive"
        class="muted"
      >已发送 {{ scheduledStatus.sentCount }} 次</span>
      <span
        v-else-if="!sendEligibility.canSend"
        class="muted"
      ><WrapText :size="14" />{{ sendEligibility.reason }}</span>
      <span
        v-else
        class="muted"
      >{{ payloadEncoding.bytes?.length ?? 0 }} 字节</span>
      <div class="send-panel__actions">
        <kbd class="send-shortcut">⌘ / Ctrl + Enter</kbd>
        <button
          type="button"
          class="command-button send-panel__manual-send"
          :disabled="!canSend"
          @click="sendPayload"
        >
          <LoaderCircle
            v-if="sendPending"
            :size="15"
            class="spin"
          />
          <Send
            v-else
            :size="15"
          />{{ sendPending ? '正在发送' : '发送' }}
        </button>
        <div
          class="send-panel__schedule"
          :class="{ 'send-panel__schedule--expanded': scheduledEnabled || scheduledActive }"
        >
          <label class="check-control">
            <input
              v-model="scheduledEnabled"
              name="scheduled-enabled"
              type="checkbox"
              :disabled="!sessionActive || scheduledActive"
            >
            定时发送
          </label>
          <label
            v-show="scheduledEnabled || scheduledActive"
            class="send-panel__schedule-field"
          >
            <span>间隔</span>
            <input
              v-model.number="scheduledIntervalMs"
              name="scheduled-interval"
              type="number"
              min="100"
              max="60000"
              :disabled="!scheduledEnabled || scheduledActive"
              aria-label="定时发送间隔（毫秒）"
            >
            <span>毫秒</span>
          </label>
          <label
            v-show="scheduledEnabled || scheduledActive"
            class="send-panel__schedule-field"
          >
            <span>次数</span>
            <select
              v-model="scheduledCountMode"
              name="scheduled-count-mode"
              :disabled="!scheduledEnabled || scheduledActive"
              aria-label="定时发送次数模式"
            >
              <option value="unlimited">无限</option>
              <option value="finite">有限</option>
            </select>
            <input
              v-model.number="scheduledCount"
              name="scheduled-count"
              type="number"
              min="1"
              :disabled="!scheduledEnabled || scheduledActive || scheduledCountMode === 'unlimited'"
              aria-label="定时发送次数"
            >
          </label>
          <button
            v-if="scheduledActive"
            type="button"
            class="command-button command-button--quiet send-panel__schedule-action"
            aria-label="停止定时发送"
            @click="stopScheduledSend"
          >
            <Square :size="14" />停止
          </button>
          <button
            v-else-if="scheduledEnabled"
            type="button"
            class="command-button command-button--quiet send-panel__schedule-action"
            aria-label="开始定时发送"
            :disabled="!canStartScheduled"
            @click="startScheduledSend"
          >
            <Play :size="14" />开始
          </button>
        </div>
      </div>
    </footer>
    <SendLibraryPanel
      v-if="libraryOpen"
      :runtime="runtime"
      :endpoint-id="endpoint.id"
      :snapshot="librarySnapshot"
      :initial-tab="libraryTab"
      :refresh-revision="libraryRefreshRevision"
      @load="loadLibraryItem"
      @close="libraryOpen = false"
    />
  </section>
</template>
