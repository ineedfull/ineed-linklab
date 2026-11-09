<script setup>
import { safeWebSocketAddress } from '../model/websocketConfig.js';
import { MoreHorizontal, Pencil, Play, Square, Trash2, X } from 'lucide-vue-next';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  endpoint: { type: Object, required: true },
  selected: Boolean,
  statusEvent: { type: Object, default: null },
  operation: { type: Object, default: null },
  reconnectState: { type: Object, default: null },
  counter: { type: Object, default: () => ({ received: 0, sent: 0 }) },
});
const emit = defineEmits(['select', 'edit', 'open', 'cancel', 'close', 'delete']);
const menuOpen = ref(false);
const menu = ref(null);
const menuTrigger = ref(null);

function closeMenu(restoreFocus = false) {
  menuOpen.value = false;
  if (restoreFocus) menuTrigger.value?.focus();
}

function dismissOutside(event) {
  const path = event.composedPath();
  if (!path.includes(menu.value) && !path.includes(menuTrigger.value)) closeMenu();
}

function dismissOnEscape(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu(true);
}

function removeMenuListeners() {
  document.removeEventListener('pointerdown', dismissOutside, true);
  document.removeEventListener('click', dismissOutside, true);
  document.removeEventListener('focusin', dismissOutside, true);
  document.removeEventListener('keydown', dismissOnEscape, true);
}

watch(menuOpen, (open) => {
  removeMenuListeners();
  if (!open) return;
  // Capture outside interactions even when other controls stop bubbling.
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('click', dismissOutside, true);
  document.addEventListener('focusin', dismissOutside, true);
  document.addEventListener('keydown', dismissOnEscape, true);
}, { flush: 'sync' });
onBeforeUnmount(removeMenuListeners);

function chooseAction(action) {
  closeMenu(true);
  emit(action);
}

const status = computed(() => {
  if (props.reconnectState?.phase === 'waiting') return 'reconnect-waiting';
  if (props.reconnectState?.phase === 'connecting') return 'reconnecting';
  if (props.operation?.sessionId === null) return 'opening';
  if (props.statusEvent?.status) return ({ connecting: 'opening', disconnected: 'closed' })[props.statusEvent.status] ?? props.statusEvent.status;
  if (props.operation?.sessionId) return 'open';
  return 'closed';
});
const isRunning = computed(() => ['connected', 'listening', 'open'].includes(status.value));
const statusLabel = computed(() => {
  if (status.value === 'reconnect-waiting') return `等待重连（第 ${props.reconnectState?.attempt} 次）`;
  if (status.value === 'reconnecting') return props.reconnectState?.attempt ? `正在重连（第 ${props.reconnectState.attempt} 次）` : '正在重连';
  return {
    reconnecting: '正在重连', opening: '正在打开', open: '已打开', connected: '已连接', listening: '正在监听',
    closed: '已关闭', error: '错误',
  }[status.value] ?? status.value;
});
const address = computed(() => {
  const config = props.endpoint.config;
  if (props.endpoint.transport === 'opcua-client') return config.endpointUrl;
  if (props.endpoint.transport === 'opcua-server') return `${config.listenHost}:${config.listenPort}${config.path ?? '/LinkLab'}`;
  if (props.endpoint.transport === 'stomp-client') return safeWebSocketAddress(config.url);
  if (props.endpoint.transport === 'stomp-server') return `${config.listenHost}:${config.listenPort}${config.path ?? '/stomp'}`;
  if (props.endpoint.transport === 'serial') return config.path ?? config.port ?? '未设置串口';
  if (props.endpoint.transport.startsWith('dlt645-')) return config.path ?? '未设置串口';
  if (props.endpoint.transport === 'websocket-client') return safeWebSocketAddress(config.url);
  if (props.endpoint.transport === 'websocket-server') return `${config.listenHost}:${config.listenPort}${config.path ?? '/'}`;
  if (props.endpoint.transport === 'tcp-client') return `${config.host}:${config.port}`;
  if (props.endpoint.transport === 'tcp-server') return `${config.listenHost}:${config.listenPort}`;
  if (props.endpoint.transport === 'modbus-tcp-master') return `${config.host}:${config.port}`;
  if (props.endpoint.transport === 'modbus-tcp-slave') return `${config.listenHost}:${config.listenPort}`;
  if (props.endpoint.transport.startsWith('modbus-rtu-')) return config.path ?? '未设置串口';
  return `${config.bindHost}:${config.bindPort}`;
});
const secondaryLabel = computed(() => (
  ['reconnect-waiting', 'reconnecting'].includes(status.value)
    ? statusLabel.value
    : address.value
));
const protocolRoleLabel = computed(() => ({
  'opcua-client': 'OPC UA 客户端',
  'opcua-server': 'OPC UA 模拟服务端',
  'stomp-client': 'STOMP 客户端',
  'stomp-server': 'STOMP 服务端',
})[props.endpoint.transport]);
const requestGroupSummary = computed(() => {
  if (!props.endpoint.transport.endsWith('-master') || !props.endpoint.transport.startsWith('modbus-')) {
    return null;
  }
  const groups = Array.isArray(props.endpoint.config?.requestGroups)
    ? props.endpoint.config.requestGroups : [];
  return `请求组 ${groups.filter(({ enabled }) => enabled !== false).length}/${groups.length}`;
});
</script>

<template>
  <article
    class="endpoint-row"
    :class="{ selected }"
  >
    <button
      type="button"
      class="endpoint-row__select"
      :aria-label="`选择 ${endpoint.name}`"
      :aria-current="selected ? 'true' : undefined"
      @click="emit('select')"
    >
      <span class="endpoint-row__primary">
        <span
          class="status-dot"
          :class="`status-dot--${status}`"
          :title="statusLabel"
        />
        <strong :title="endpoint.name">{{ endpoint.name }}</strong>
      </span>
      <span class="endpoint-row__secondary">
        <span :title="secondaryLabel">{{ secondaryLabel }}</span>
        <span>{{ protocolRoleLabel ?? requestGroupSummary ?? `RX ${counter?.received ?? 0} / TX ${counter?.sent ?? 0}` }}</span>
      </span>
    </button>
    <div class="endpoint-row__actions">
      <button
        v-if="status === 'opening' || status === 'reconnect-waiting' || status === 'reconnecting'"
        class="icon-button"
        type="button"
        :aria-label="status === 'opening' ? '取消打开端点' : '取消自动重连'"
        :title="status === 'opening' ? '取消' : '取消自动重连'"
        @click.stop="emit('cancel')"
      >
        <X :size="14" />
      </button>
      <button
        v-else-if="isRunning"
        class="icon-button"
        type="button"
        aria-label="关闭端点"
        title="关闭"
        @click.stop="emit('close')"
      >
        <Square :size="13" />
      </button>
      <button
        v-else
        class="icon-button"
        type="button"
        aria-label="打开端点"
        title="打开"
        @click.stop="emit('open')"
      >
        <Play :size="14" />
      </button>
      <button
        ref="menuTrigger"
        class="icon-button"
        type="button"
        aria-label="端点操作"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        title="端点操作"
        @click.stop="menuOpen = !menuOpen"
      >
        <MoreHorizontal :size="15" />
      </button>
    </div>
    <div
      v-if="menuOpen"
      ref="menu"
      class="endpoint-row__menu"
      role="menu"
      @click.stop
    >
      <button
        type="button"
        role="menuitem"
        @click="chooseAction('edit')"
      >
        <Pencil :size="14" />编辑
      </button>
      <button
        type="button"
        role="menuitem"
        class="danger"
        @click="chooseAction('delete')"
      >
        <Trash2 :size="14" />删除
      </button>
    </div>
  </article>
</template>
