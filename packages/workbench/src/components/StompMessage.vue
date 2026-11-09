<script setup>
import { formatTimestamp } from '../model/dateTime.js';
import { computed } from 'vue';

// Stable keyed rows keep unchanged payloads out of each history refresh.
const props = defineProps({
  message: { type: Object, required: true },
  mode: { type: String, required: true },
  connectionStatus: { type: String, required: true },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['ack', 'nack']);
const messageLabels = { received: '已接收', sending: '发送中', sent: '已发送', queued: '已入队', 'no-subscribers': '无订阅者', confirmed: '回执已确认', acknowledged: '已确认', rejected: '已拒绝', failed: '发送失败', 'receipt-timeout': '回执超时', stale: '会话已结束', unsubscribed: '已退订' };
const canAcknowledge = computed(() => props.mode === 'client' && props.connectionStatus === 'connected' && props.message.direction === 'in' && !!props.message.ackId && props.message.status === 'received');
</script>

<template>
  <article
    class="stomp-message"
  >
    <div class="stomp-message-heading">
      <strong>{{ message.direction === 'in' ? '接收' : '发送' }}</strong><code>{{ message.destination }}</code><time>{{ formatTimestamp(message.createdAt) }}</time><span class="stomp-muted">{{ messageLabels[message.status] || message.status }}</span>
    </div>
    <dl class="stomp-message-meta">
      <template
        v-for="[label, value] in [['subscription', message.subscription], ['message-id', message.messageId], ['ack-id', message.ackId], ['peer', message.peerId]]"
        :key="label"
      >
        <template v-if="value">
          <dt>{{ label }}</dt><dd>{{ value }}</dd>
        </template>
      </template>
    </dl>
    <pre class="stomp-message-body">{{ message.body }}</pre>
    <div
      v-if="canAcknowledge"
      class="stomp-actions"
    >
      <button
        type="button"
        :disabled="busy"
        @click="emit('ack', message.id)"
      >
        ACK
      </button><button
        type="button"
        :disabled="busy"
        @click="emit('nack', message.id)"
      >
        NACK
      </button><span class="stomp-muted">{{ message.ack }}</span>
    </div>
  </article>
</template>
