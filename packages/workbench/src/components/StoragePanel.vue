<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RefreshCw, Trash2 } from 'lucide-vue-next';
import { createStorageController, formatByteSize, formatTimestamp } from '../model/secondaryViews.js';
const props = defineProps({
  runtime: { type: Object, required: true },
  confirm: { type: Function, default: (message) => window.confirm(message) },
  modbusHistoryStatus: { type: Object, default: null },
});
const controller = createStorageController(props.runtime); const revision = ref(0);
const state = computed(() => { void revision.value; return { ...controller.state }; });
const unsubscribe = controller.subscribe(() => { revision.value += 1; });
async function run(command) {
  try { await command(); } catch (error) { void error; } finally { revision.value += 1; }
}
function clear() { if (props.confirm('清除历史消息、日志和发送记录？端点配置、模板和设置将保留。')) run(controller.clearHistory); }
onMounted(() => run(controller.refresh));
onBeforeUnmount(() => { unsubscribe(); controller.dispose(); });
</script>
<template>
  <section class="settings-section storage-panel">
    <div class="settings-section__heading">
      <h3>数据存储</h3><button
        type="button"
        class="icon-button"
        aria-label="刷新存储统计"
        title="刷新"
        :disabled="state.loading"
        @click="run(controller.refresh)"
      >
        <RefreshCw :size="14" />
      </button>
    </div>
    <dl class="storage-stats">
      <div><dt>历史消息</dt><dd>{{ state.stats?.frameCount ?? 0 }}</dd></div><div><dt>日志</dt><dd>{{ state.stats?.logCount ?? 0 }}</dd></div><div><dt>发送记录</dt><dd>{{ state.stats?.sendHistoryCount ?? 0 }}</dd></div><div><dt>总计</dt><dd>{{ state.stats?.totalCount ?? 0 }}</dd></div><div><dt>磁盘占用</dt><dd>{{ formatByteSize(state.stats?.diskBytes ?? 0) }}</dd></div>
    </dl>
    <dl class="storage-stats storage-stats--modbus">
      <div><dt>Modbus 数据点</dt><dd>{{ state.stats?.modbusPointHistoryCount ?? 0 }}</dd></div><div><dt>历史估算</dt><dd>{{ formatByteSize(state.stats?.modbusPointHistoryEstimatedBytes ?? 0) }}</dd></div><div><dt>最近清理</dt><dd>{{ formatTimestamp(state.stats?.modbusPointHistoryLastCleanupAt) }}</dd></div><div><dt>待写入</dt><dd>待写入 {{ modbusHistoryStatus?.pendingCount ?? 0 }} 条</dd></div><div><dt>最近刷盘</dt><dd>{{ formatTimestamp(modbusHistoryStatus?.lastFlushedAt) }}</dd></div>
    </dl>
    <p
      v-if="(modbusHistoryStatus?.droppedCount ?? 0) > 0 || (modbusHistoryStatus?.failedBatchCount ?? 0) > 0"
      class="modbus-history-storage-warning"
      role="status"
    >
      历史采集异常：丢弃 {{ modbusHistoryStatus?.droppedCount ?? 0 }} 条，失败批次 {{ modbusHistoryStatus?.failedBatchCount ?? 0 }}。{{ modbusHistoryStatus?.lastError ?? '' }}
    </p>
    <p
      v-if="state.clearResult?.cleared && state.clearResult?.reclaimed === false"
      class="field-error"
      role="status"
    >
      历史记录已清除，但磁盘空间未完全回收。
    </p>
    <p
      v-if="state.error"
      class="field-error"
      role="alert"
    >
      {{ state.error }}
    </p>
    <button
      type="button"
      class="command-button command-button--danger"
      data-action="clear-history"
      :disabled="state.loading"
      @click="clear"
    >
      <Trash2 :size="14" />清除历史记录
    </button>
  </section>
</template>
