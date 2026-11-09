<script setup>
import { Ban, CircleStop, Play, X } from 'lucide-vue-next';
import { computed } from 'vue';

const props = defineProps({
  endpoint: { type: Object, required: true },
  operation: { type: Object, default: null },
  statusEvent: { type: Object, default: null },
  reconnectState: { type: Object, default: null },
  counters: { type: Object, required: true },
  peerCount: { type: Number, default: 0 },
  commandError: { type: Object, default: null },
});
defineEmits(['open', 'cancel', 'close']);

const websocketClose = computed(() => {
  if (!props.endpoint.transport.startsWith('websocket-')) return '';
  const details = props.statusEvent?.log?.details;
  if (!Number.isInteger(details?.closeCode)) return '';
  return `关闭 ${details.closeCode}${typeof details.closeReason === 'string' && details.closeReason ? `：${details.closeReason.slice(0, 256)}` : ''}`;
});
const status = computed(() => {
  if (props.reconnectState?.phase === 'waiting') return 'reconnect-waiting';
  if (props.reconnectState?.phase === 'connecting') return 'reconnecting';
  if (props.operation?.sessionId === null) return 'opening';
  if (props.statusEvent?.status) return props.statusEvent.status;
  return props.operation?.sessionId ? 'open' : 'closed';
});
const running = computed(() => ['connected', 'listening', 'open'].includes(status.value));
const transportLabel = computed(() => ({
  serial: '串口',
  'websocket-client': 'WebSocket 客户端',
  'websocket-server': 'WebSocket 服务端',
  'tcp-client': 'TCP 客户端',
  'tcp-server': 'TCP 服务端',
  'udp-client': 'UDP 客户端',
  'udp-server': 'UDP 服务端',
  'modbus-tcp-master': 'Modbus TCP 主站',
  'modbus-tcp-slave': 'Modbus TCP 从站',
  'modbus-rtu-master': 'Modbus RTU 主站',
  'modbus-rtu-slave': 'Modbus RTU 从站',
  'dlt645-master': 'DL/T 645-2007 电表主站',
  'dlt645-slave': 'DL/T 645-2007 电表模拟器',
}[props.endpoint.transport] ?? props.endpoint.transport));
const statusLabel = computed(() => {
  if (status.value === 'reconnect-waiting') return `等待重连（第 ${props.reconnectState?.attempt} 次）`;
  if (status.value === 'reconnecting') return `正在重连（第 ${props.reconnectState?.attempt} 次）`;
  return {
    opening: '正在打开', open: '已打开', connected: '已连接', listening: '监听中',
    closed: '已关闭', error: '错误',
  }[status.value] ?? status.value;
});
</script>

<template>
  <header class="session-status-bar">
    <div class="session-status-bar__identity">
      <strong>{{ endpoint.name }}</strong>
      <span class="transport-badge">{{ transportLabel }}</span>
      <span
        class="session-state"
        :class="`session-state--${status}`"
      >{{ statusLabel }}</span>
    </div>
    <div class="session-status-bar__stats">
      <span
        v-if="websocketClose"
        :title="websocketClose"
      >{{ websocketClose }}</span>
      <span>RX {{ counters.received ?? 0 }}</span>
      <span>TX {{ counters.sent ?? 0 }}</span>
      <span v-if="['tcp-server', 'websocket-server'].includes(endpoint.transport)">连接 {{ peerCount }}</span>
      <span
        v-if="commandError"
        class="session-status-bar__error"
        :title="commandError.message"
      >
        <Ban :size="14" />{{ commandError.message }}
      </span>
      <button
        v-if="status === 'opening' || status === 'reconnect-waiting' || status === 'reconnecting'"
        type="button"
        class="command-button command-button--quiet"
        :aria-label="status === 'opening' ? '取消打开端点' : '取消自动重连'"
        @click="$emit('cancel')"
      >
        <X :size="14" />取消
      </button>
      <button
        v-else-if="running"
        type="button"
        class="command-button command-button--quiet"
        @click="$emit('close')"
      >
        <CircleStop :size="14" />关闭
      </button>
      <button
        v-else
        type="button"
        class="command-button"
        @click="$emit('open')"
      >
        <Play :size="14" />打开
      </button>
    </div>
  </header>
</template>
