<script setup>
import { AlertCircle, CircleAlert, Info } from 'lucide-vue-next';
import { ref, watch } from 'vue';
import { useStreamFollow } from '../model/useStreamFollow.js';
import { formatLogLevel } from '../model/logLevels.js';
import { formatTimestamp } from '../model/secondaryViews.js';

const props = defineProps({
  logs: { type: Array, required: true },
  contextKey: { type: String, default: '' },
  autoScroll: { type: Boolean, default: true },
});
const listRef = ref(null);

function logTime(value) {
  return formatTimestamp(value);
}

const emit = defineEmits(['follow-change']);
const { following, unread, toggle, resume, onScroll, onWheel, onKeydown } = useStreamFollow({
  element: listRef, keys: () => props.logs.map(log => log.id ?? log), enabled: () => props.autoScroll, context: () => props.contextKey,
});
watch(following, value => emit('follow-change', value), { immediate: true });
defineExpose({ toggleFollow: toggle, resume });

</script>

<template>
  <div
    v-if="logs.length"
    ref="listRef"
    class="log-list"
    tabindex="0"
    aria-label="实时日志"
    @scroll="onScroll"
    @wheel.passive="onWheel"
    @keydown="onKeydown"
  >
    <div
      v-for="(log, index) in logs"
      :key="log.id ?? `${log.createdAt}-${index}`"
      class="log-list__row"
    >
      <AlertCircle
        v-if="log.level === 'error'"
        :size="15"
        class="log-level log-level--error"
      />
      <CircleAlert
        v-else-if="['warn', 'warning'].includes(log.level)"
        :size="15"
        class="log-level log-level--warning"
      />
      <Info
        v-else
        :size="15"
        class="log-level log-level--info"
      />
      <time>{{ logTime(log.createdAt) }}</time>
      <span class="log-list__level">{{ formatLogLevel(log.level ?? 'info') }}</span>
      <span class="log-list__message">{{ log.message }}</span>
    </div>
  </div>
  <div
    v-else
    class="stream-empty"
  >
    <strong>暂无日志</strong>
  </div>
  <button
    v-if="unread"
    type="button"
    class="new-records"
    @click="resume"
  >
    {{ unread }} 条新记录 · 回到最新
  </button>
</template>
