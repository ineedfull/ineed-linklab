<script setup>
import { ArrowDownToLine, FileClock, Pause, Search, Trash2 } from 'lucide-vue-next';
defineProps({
  activeView: { type: String, required: true },
  filters: { type: Object, required: true },
  peers: { type: Array, default: () => [] },
  following: Boolean,
  density: { type: String, default: 'comfortable' },
});
const emit = defineEmits(['view', 'filters', 'clear', 'history', 'follow', 'density']);
function moveTab(event, view) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'messages' : event.key === 'End' ? 'logs' : view === 'messages' ? 'logs' : 'messages';
  emit('view', next);
  event.currentTarget.parentElement.querySelector(`[data-view="${next}"]`)?.focus();
}
</script>
<template>
  <div class="stream-controls">
    <nav
      class="workspace-tabs"
      aria-label="调试工作区"
    >
      <div
        role="tablist"
        aria-label="实时视图"
      >
        <button
          v-for="view in ['messages', 'logs']"
          :key="view"
          type="button"
          role="tab"
          :data-view="view"
          :aria-selected="activeView === view"
          :tabindex="activeView === view ? 0 : -1"
          @keydown="moveTab($event, view)"
          @click="emit('view', view)"
        >
          {{ view === 'messages' ? '消息' : '日志' }}
        </button>
      </div>
      <div class="workspace-tabs__actions">
        <button
          type="button"
          :aria-pressed="density === 'compact'"
          title="切换显示密度"
          @click="emit('density')"
        >
          {{ density === 'compact' ? '舒适' : '紧凑' }}
        </button>
        <button
          type="button"
          :aria-label="activeView === 'messages' ? '打开消息历史' : '打开日志历史'"
          :title="activeView === 'messages' ? '消息历史' : '日志历史'"
          @click="emit('history', activeView === 'messages' ? 'frames' : 'logs')"
        >
          <FileClock :size="14" />历史记录
        </button>
        <button
          type="button"
          aria-label="清空实时视图"
          @click="emit('clear')"
        >
          <Trash2 :size="14" />清空视图
        </button>
      </div>
    </nav>
    <div class="frame-toolbar">
      <label
        v-if="activeView === 'messages'"
        class="toolbar-select"
      ><span class="sr-only">消息方向</span><select
        :value="filters.direction"
        aria-label="消息方向"
        @change="emit('filters', { direction: $event.target.value })"
      ><option value="all">全部方向</option><option value="in">接收 RX</option><option value="out">发送 TX</option></select></label>
      <label
        v-if="peers.length && activeView === 'messages'"
        class="toolbar-select"
      ><span class="sr-only">连接</span><select
        :value="filters.peerId"
        aria-label="按连接筛选"
        @change="emit('filters', { peerId: $event.target.value })"
      ><option value="all">全部连接</option><option
        v-for="peer in peers"
        :key="peer.id"
        :value="peer.id"
      >{{ peer.remoteAddress ?? peer.id }}</option></select></label>
      <label class="compact-search frame-toolbar__search"><Search
        :size="14"
        aria-hidden="true"
      /><input
        :value="filters.keyword"
        type="search"
        aria-label="搜索实时内容"
        placeholder="过滤地址或消息内容…"
        @input="emit('filters', { keyword: $event.target.value })"
      ></label>
      <button
        class="follow-button"
        type="button"
        :aria-pressed="following"
        @click="emit('follow')"
      >
        <ArrowDownToLine
          v-if="following"
          :size="14"
        /><Pause
          v-else
          :size="14"
        />{{ following ? '跟随最新' : '已暂停跟随' }}
      </button>
    </div>
  </div>
</template>
