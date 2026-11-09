<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ChevronLeft, ChevronRight, Search } from 'lucide-vue-next';

import { formatLogLevel, LOG_LEVEL_OPTIONS } from '../model/logLevels.js';
import {
  createHistoryPayloadCache,
  createHistoryController,
  formatFramingLabel,
  formatTimestamp,
} from '../model/secondaryViews.js';

const props = defineProps({
  runtime: { type: Object, required: true },
  kind: { type: String, required: true },
  endpointId: { type: String, default: null },
  preferences: { type: Object, default: null },
});
const controller = createHistoryController(props.runtime, {
  kind: props.kind, endpointId: props.endpointId,
});
const revision = ref(0);
const selected = ref(null);
const payloadCache = createHistoryPayloadCache();
// The controller publishes a plain mutable state. Each revision needs a new
// snapshot so Vue also renders changes when page totals stay the same.
const state = computed(() => { void revision.value; return { ...controller.state }; });
const title = computed(() => props.kind === 'frames' ? '消息历史' : '日志历史');
const previewByteLimit = computed(() => {
  const value = props.preferences?.values?.previewByteLimit;
  return Number.isSafeInteger(value) && value > 0 ? value : 4096;
});
const framePreviews = computed(() => {
  void revision.value;
  return payloadCache.previews(state.value.rows, previewByteLimit.value);
});
const pagerTotalPages = computed(() => {
  void revision.value;
  return Math.max(1, state.value.totalPages);
});
const pagerPage = computed(() => {
  void revision.value;
  return Math.min(Math.max(1, state.value.page), pagerTotalPages.value);
});
const selectedPayload = computed(() => selected.value
  ? payloadCache.detail(state.value.rows, selected.value)
  : '');
const unsubscribe = controller.subscribe(() => { revision.value += 1; });

async function search() {
  if (await run(controller.search)) selected.value = state.value.rows[0] ?? null;
}
async function page(value) {
  if (await run(() => controller.goToPage(value))) selected.value = state.value.rows[0] ?? null;
}
async function pageSize(event) {
  if (await run(() => controller.setPageSize(Number(event.target.value)))) {
    selected.value = state.value.rows[0] ?? null;
  }
}
async function run(command) {
  try {
    await command();
    return true;
  } catch {
    // The controller publishes the error; the UI preserves the selected row.
    return false;
  } finally {
    revision.value += 1;
  }
}
function setDraft(key, value) { controller.setDraft({ [key]: value }); revision.value += 1; }
function directionLabel(value) { return { in: '接收', out: '发送' }[value] ?? value; }
function selectRow(row) { selected.value = row; }
function selectRowByKeyboard(event, row) {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  selectRow(row);
}
onMounted(async () => {
  try {
    await controller.load();
    selected.value = state.value.rows[0] ?? null;
  } catch {
    // Error state is published by the controller.
  }
});
onBeforeUnmount(() => { unsubscribe(); controller.dispose(); });
</script>

<template>
  <main class="history-window">
    <header class="history-window__header">
      <h1>{{ title }}</h1>
      <span
        v-if="endpointId"
        class="history-window__scope"
      >{{ endpointId }}</span>
    </header>
    <form
      class="history-filters"
      @submit.prevent="search"
    >
      <input
        type="search"
        aria-label="搜索历史记录"
        placeholder="搜索"
        :value="state.draft.search"
        @input="setDraft('search', $event.target.value)"
      >
      <select
        v-if="kind === 'frames'"
        name="direction"
        aria-label="消息方向"
        :value="state.draft.direction"
        @change="setDraft('direction', $event.target.value)"
      >
        <option value="">
          全部方向
        </option><option value="in">
          接收
        </option><option value="out">
          发送
        </option>
      </select>
      <template v-else>
        <select
          :value="state.draft.level"
          aria-label="日志级别"
          @change="setDraft('level', $event.target.value)"
        >
          <option value="">
            全部级别
          </option><option
            v-for="level in LOG_LEVEL_OPTIONS"
            :key="level"
            :value="level"
          >
            {{ formatLogLevel(level) }}
          </option>
        </select>
        <input
          aria-label="来源"
          placeholder="来源"
          :value="state.draft.source"
          @input="setDraft('source', $event.target.value)"
        >
      </template>
      <input
        type="datetime-local"
        aria-label="开始时间"
        @change="setDraft('from', $event.target.value ? new Date($event.target.value).getTime() : null)"
      >
      <input
        type="datetime-local"
        aria-label="结束时间"
        @change="setDraft('to', $event.target.value ? new Date($event.target.value).getTime() : null)"
      >
      <button
        type="submit"
        class="command-button"
        :disabled="state.loading"
        @click.prevent="search"
      >
        <Search :size="14" />搜索
      </button>
    </form>
    <div class="history-window__state">
      <p
        v-if="state.error"
        class="history-window__error"
        role="alert"
      >
        {{ state.error }}
      </p>
    </div>
    <div class="history-window__content">
      <section class="history-table-wrap">
        <table
          class="history-table"
          :class="`history-table--${kind}`"
        >
          <thead>
            <tr>
              <th>时间</th><th>端点</th>
              <template v-if="kind === 'frames'">
                <th>方向</th><th>格式</th><th>字节</th><th>预览</th>
              </template>
              <template v-else>
                <th>级别</th><th>来源</th><th>消息</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in state.rows"
              :key="row.id"
              :class="{ selected: selected?.id === row.id }"
              tabindex="0"
              :aria-selected="selected?.id === row.id ? 'true' : 'false'"
              @click="selectRow(row)"
              @keydown="selectRowByKeyboard($event, row)"
            >
              <td>{{ formatTimestamp(row.createdAt) }}</td><td>{{ row.endpointId }}</td>
              <template v-if="kind === 'frames'">
                <td>{{ directionLabel(row.direction) }}</td><td>{{ row.format }}</td><td>{{ row.byteCount }}</td><td>{{ framePreviews[index] }}</td>
              </template>
              <template v-else>
                <td>{{ formatLogLevel(row.level) }}</td><td>{{ row.source }}</td><td>{{ row.message }}</td>
              </template>
            </tr>
          </tbody>
        </table>
        <div
          v-if="!state.loading && state.rows.length === 0"
          class="history-window__empty"
        >
          没有匹配的历史记录
        </div>
      </section>
      <aside class="history-detail">
        <template v-if="selected">
          <div class="history-detail__identity">
            <strong>#{{ selected.id }}</strong><time>{{ formatTimestamp(selected.createdAt) }}</time>
          </div>
          <div class="history-detail__metadata">
            <template v-if="kind === 'frames'">
              {{ directionLabel(selected.direction) }} · {{ selected.format }} · {{ formatFramingLabel(selected.framing) }} · {{ selected.byteCount }} 字节
            </template>
            <template v-else>
              {{ formatLogLevel(selected.level) }} · {{ selected.source }}<span v-if="selected.code"> · {{ selected.code }}</span>
            </template>
          </div>
          <section class="history-detail__endpoint">
            <h2>端点 / 连接</h2><div>{{ selected.endpointId }}</div><div>{{ selected.peerId || '无连接' }}</div><div>{{ selected.sessionId || '无会话' }}</div>
          </section>
          <section class="history-detail__payload">
            <h2>{{ kind === 'frames' ? '载荷' : '消息' }}</h2><pre>{{ kind === 'frames' ? selectedPayload : selected.message }}</pre><pre v-if="kind === 'logs' && selected.details">{{ JSON.stringify(selected.details, null, 2) }}</pre>
          </section>
        </template>
        <div
          v-else
          class="history-window__empty"
        >
          未选择记录
        </div>
      </aside>
    </div>
    <footer class="history-pager">
      <span class="history-pager__total">共 {{ state.total }} 条</span>
      <select
        name="page-size"
        aria-label="每页条数"
        :value="state.pageSize"
        :disabled="state.loading"
        @change="pageSize"
      >
        <option :value="25">
          25 / 页
        </option>
        <option :value="50">
          50 / 页
        </option>
        <option :value="100">
          100 / 页
        </option>
        <option :value="200">
          200 / 页
        </option>
      </select>
      <button
        class="icon-button"
        type="button"
        aria-label="上一页"
        title="上一页"
        :disabled="state.page <= 1 || state.loading"
        @click="page(state.page - 1)"
      >
        <ChevronLeft :size="15" />
      </button>
      <span>第 {{ pagerPage }} / {{ pagerTotalPages }} 页</span>
      <button
        class="icon-button"
        type="button"
        aria-label="下一页"
        title="下一页"
        :disabled="state.totalPages === 0 || state.page >= state.totalPages || state.loading"
        @click="page(state.page + 1)"
      >
        <ChevronRight :size="15" />
      </button>
    </footer>
  </main>
</template>
