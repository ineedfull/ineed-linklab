<script setup>
import { Check, Copy } from 'lucide-vue-next';
import { computed } from 'vue';
import { formatClockTime, formatTimestamp } from '../model/dateTime.js';

// A row keeps its component identity when the 500-message window slides.
// Stable preview/peer/feedback props avoid rendering the other 499 messages.
const props = defineProps({
  row: { type: Object, required: true },
  peer: { type: String, required: true },
  copied: Boolean,
  copyError: Boolean,
});
const emit = defineEmits(['inspect', 'copy']);
const timestamp = computed(() => formatTimestamp(props.row.frame.createdAt));
const clock = computed(() => formatClockTime(props.row.frame.createdAt));
</script>

<template>
  <article
    :data-frame-key="row.key"
    class="frame-list__item"
    :class="row.frame.direction === 'in' ? 'frame-list__item--received' : 'frame-list__item--sent'"
  >
    <time
      :title="timestamp"
      :aria-label="timestamp"
    >{{ clock }}</time>
    <span class="frame-direction">{{ row.frame.direction === 'in' ? 'RX' : 'TX' }}<small
      v-if="row.frame.messageType"
      :title="row.frame.messageType === 'binary' ? 'WebSocket 二进制消息' : 'WebSocket 文本消息'"
    >{{ row.frame.messageType === 'binary' ? 'BIN' : 'TXT' }}</small></span>
    <span
      class="frame-peer"
      :title="peer"
    >{{ peer }}</span>
    <button
      type="button"
      class="frame-preview"
      :aria-label="'查看消息 ' + timestamp"
      @click="emit('inspect', $event)"
    >
      <pre>{{ row.text }}</pre><span
        v-if="row.truncated"
        class="sr-only"
      >已截断</span>
    </button>
    <span class="frame-bytes">{{ row.totalBytes }}</span>
    <button
      type="button"
      class="icon-button"
      aria-label="复制消息"
      title="复制完整消息"
      @click="emit('copy')"
    >
      <Check
        v-if="copied"
        :size="14"
      /><Copy
        v-else
        :size="14"
      />
    </button>
    <span
      v-if="copyError"
      class="field-error"
      role="alert"
    >复制失败</span>
  </article>
</template>

<style scoped>
.frame-direction small {
  display: block;
  color: var(--text-muted);
  font-size: var(--font-size-small);
  font-weight: 500;
  line-height: 1.2;
}
</style>
