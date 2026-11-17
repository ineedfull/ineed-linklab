<script setup>
import { X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { createFramePresenter, formatFrameForCopy, originalFrameContent } from '../model/framePresentation.js';
import { formatTimestamp } from '../model/dateTime.js';
import { useStreamFollow } from '../model/useStreamFollow.js';
import { useFrameViewport } from '../model/useFrameViewport.js';
import FrameRow from './FrameRow.vue';
const props = defineProps({
  frames: { type: Array, required: true },
  peers: { type: Array, default: () => [] },
  previewByteLimit: { type: Number, default: 4096 },
  autoScroll: { type: Boolean, default: true },
  contextKey: { type: String, default: '' },
});
const emit = defineEmits(['follow-change']);
const copiedFrame = ref(null);
const copyError = ref(null);
const listRef = ref(null);
const selected = ref(null);
const detailRef = ref(null);
const detailFormat = ref('text');
let detailTrigger = null;
let copyTimer;
const presenter = createFramePresenter();
const rows = computed(() => presenter.present(props.frames, { previewByteLimit: props.previewByteLimit }));
const { following, unread, toggle, resume, onScroll: followScroll, onWheel, onKeydown } = useStreamFollow({
  element: listRef, keys: () => rows.value.map(row => row.key), enabled: () => props.autoScroll, context: () => props.contextKey,
});
const { visibleRows, virtualized, beforeHeight, afterHeight, setRowElement, onScroll: viewportScroll } = useFrameViewport({
  rows, element: listRef, following, context: () => props.contextKey, refreshFollow: resume,
});
function onScroll() { followScroll(); viewportScroll(); }
watch(following, value => emit('follow-change', value), { immediate: true });
watch(() => props.contextKey, () => { selected.value = null; });
const detail = computed(() => selected.value ? presenter.present([{ ...selected.value.frame, format: detailFormat.value }], { previewByteLimit: props.previewByteLimit })[0] : null);
function framePeer(frame) {
  const peer = props.peers.find(({ id }) => id === frame.peerId);
  return peer?.remoteAddress ?? frame.remoteAddress ?? frame.peerId ?? '端点';
}
async function inspect(row, event) {
  selected.value = row;
  detailFormat.value = row.format;
  detailTrigger = event.currentTarget;
  await nextTick();
  detailRef.value?.querySelector('button')?.focus();
}
function closeDetail() { selected.value = null; detailTrigger?.focus(); }
async function copyFrame(row, original = false) {
  try {
    await navigator.clipboard.writeText(original ? originalFrameContent(row.frame).text : formatFrameForCopy(row.frame));
    copiedFrame.value = row.key;
    copyError.value = null;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedFrame.value = null; }, 1200);
  } catch { copiedFrame.value = null; copyError.value = row.key; }
}
onBeforeUnmount(() => clearTimeout(copyTimer));
defineExpose({ toggleFollow: toggle, resume });
</script>
<template>
  <div
    class="frame-workspace"
    @keydown.esc="closeDetail"
  >
    <div
      class="message-columns"
      aria-hidden="true"
    >
      <span>时间</span><span>方向</span><span>来源 / 目标</span><span>内容预览</span><span>字节</span><span />
    </div>
    <div
      ref="listRef"
      class="frame-list"
      tabindex="0"
      aria-label="实时消息"
      @scroll="onScroll"
      @wheel.passive="onWheel"
      @keydown="onKeydown"
    >
      <div
        v-if="beforeHeight"
        aria-hidden="true"
        class="frame-list__spacer"
        :style="{ height: `${beforeHeight}px` }"
      />
      <FrameRow
        v-for="(row, index) in visibleRows"
        :key="virtualized ? index : row.key"
        :ref="component => setRowElement(index, row.key, component)"
        :row="row"
        :peer="framePeer(row.frame)"
        :copied="copiedFrame === row.key"
        :copy-error="copyError === row.key"
        @inspect="inspect"
        @copy="copyFrame"
      />
      <div
        v-if="afterHeight"
        aria-hidden="true"
        class="frame-list__spacer"
        :style="{ height: `${afterHeight}px` }"
      />
      <div
        v-if="!rows.length"
        class="stream-empty"
      >
        <strong>暂无匹配消息</strong><span>调整筛选，或发送一条数据开始调试。</span>
      </div>
    </div>
    <button
      v-if="unread"
      class="new-records"
      type="button"
      @click="resume"
    >
      {{ unread }} 条新记录 · 回到最新
    </button>
    <aside
      v-if="selected"
      ref="detailRef"
      class="message-inspector"
      aria-label="消息详情"
    >
      <header>
        <strong>消息详情</strong><button
          type="button"
          class="icon-button"
          aria-label="关闭消息详情"
          @click="closeDetail"
        >
          <X :size="16" />
        </button>
      </header>
      <dl><dt>时间</dt><dd>{{ formatTimestamp(selected.frame.createdAt) }}</dd><dt>方向</dt><dd>{{ selected.frame.direction === 'in' ? '接收 RX' : '发送 TX' }}</dd><dt>来源</dt><dd>{{ framePeer(selected.frame) }}</dd><dt>长度</dt><dd>{{ selected.totalBytes }} B</dd></dl>
      <div class="message-inspector__actions">
        <label>查看为 <select v-model="detailFormat"><option value="text">Text</option><option value="json">JSON</option><option value="hex">HEX</option></select></label><button
          type="button"
          class="command-button command-button--quiet"
          @click="copyFrame(selected, true)"
        >
          {{ originalFrameContent(selected.frame).label }}
        </button>
      </div>
      <pre>{{ detail.text }}</pre><p
        v-if="detail.truncated"
        class="muted"
      >
        预览已截断，复制保留完整内容。
      </p><span
        v-if="copyError === selected.key"
        role="alert"
      >复制失败</span><span
        v-if="copiedFrame === selected.key"
        role="status"
      >已复制</span>
    </aside>
  </div>
</template>
