<script setup>
import {
  ChevronLeft, ChevronRight, LoaderCircle, Pencil, Save, Trash2, X,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { formatHistoryPayload, formatTimestamp } from '../model/secondaryViews.js';

const props = defineProps({
  runtime: { type: Object, required: true },
  endpointId: { type: String, required: true },
  snapshot: { type: Object, default: null },
  initialTab: { type: String, default: 'templates' },
  refreshRevision: { type: Number, default: 0 },
});
const emit = defineEmits(['close', 'load']);

const activeTab = ref(props.initialTab === 'history' ? 'history' : 'templates');
const templates = ref([]);
const historyRows = ref([]);
const historyTotal = ref(0);
const historyPage = ref(1);
const pageSize = 20;
const loading = ref(false);
const error = ref('');
const templateName = ref('');
const renamingId = ref(null);
const renameValue = ref('');
let generation = 0;
let pendingCount = 0;
let disposed = false;
let templateSequence = 0;
const templateLoads = new Set();
const templateMutations = new Map();

const historyPages = computed(() => Math.max(1, Math.ceil(historyTotal.value / pageSize)));

watch(() => props.initialTab, (tab) => {
  const next = tab === 'history' ? 'history' : 'templates';
  if (activeTab.value === next) return;
  activeTab.value = next;
  loadActiveTab();
});

watch(() => props.endpointId, () => {
  templates.value = [];
  historyRows.value = [];
  historyTotal.value = 0;
  historyPage.value = 1;
  renamingId.value = null;
  loadActiveTab();
});

watch(() => props.refreshRevision, (_current, previous) => {
  if (previous !== undefined && activeTab.value === 'history') loadHistory(historyPage.value);
});

onMounted(loadActiveTab);
onBeforeUnmount(() => { disposed = true; generation += 1; templateLoads.clear(); });

function selectTab(tab) {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
  loadActiveTab();
}

function loadActiveTab() {
  return activeTab.value === 'templates' ? loadTemplates() : loadHistory(1);
}

async function loadTemplates() {
  const endpointId = props.endpointId;
  return run(async (isCurrent) => {
    // A list may have captured its rows before a concurrent delete succeeds.
    // Keep deletion overlays only for the lifetime of outstanding snapshots.
    const load = { endpointId, deletedIds: new Set() };
    templateLoads.add(load);
    try {
      const rows = await props.runtime.template.list(endpointId);
      if (isCurrent()) templates.value = rows.filter(({ id }) => !load.deletedIds.has(id));
    } finally {
      templateLoads.delete(load);
    }
  });
}

async function loadHistory(page) {
  const endpointId = props.endpointId;
  return run(async (isCurrent) => {
    const result = await props.runtime.sendHistory.query({
      endpointId,
      page,
      pageSize,
    });
    if (!isCurrent()) return;
    historyRows.value = result.rows;
    historyTotal.value = result.total;
    historyPage.value = result.page;
  });
}

async function saveCurrentTemplate() {
  const name = templateName.value.trim();
  if (!name || !props.snapshot) return;
  const value = await runValue(() => saveTemplateSnapshot({
    id: createTemplateId(),
    endpointId: props.endpointId,
    name,
    ...props.snapshot,
  }));
  if (!value) return;
  upsertTemplate(value);
  templateName.value = '';
}

function beginRename(template) {
  renamingId.value = template.id;
  renameValue.value = template.name;
}

async function renameTemplate(template) {
  const name = renameValue.value.trim();
  if (!name) return;
  const endpointId = props.endpointId;
  const snapshot = { ...template, name };
  await run(async (isCurrent) => {
    await serializeTemplateMutation(endpointId, template.id, async () => {
      const value = await saveTemplateSnapshot(snapshot);
      if (!isCurrent() || !value) return;
      upsertTemplate(value);
      renamingId.value = null;
      renameValue.value = '';
    });
  }, false);
}

async function deleteTemplate(template) {
  const endpointId = props.endpointId;
  await run(async () => serializeTemplateMutation(endpointId, template.id, async () => {
    const deleted = await props.runtime.template.delete(template.id);
    if (!deleted || disposed) return deleted;
    for (const load of templateLoads) {
      if (load.endpointId === endpointId) load.deletedIds.add(template.id);
    }
    // Successful storage mutation belongs to this endpoint/ID even if the
    // user left and returned while awaiting it. Errors still use generation.
    if (props.endpointId === endpointId) {
      templates.value = templates.value.filter(({ id }) => id !== template.id);
      if (renamingId.value === template.id) renamingId.value = null;
    }
    return deleted;
  }), false);
}

function serializeTemplateMutation(endpointId, id, operation) {
  const key = JSON.stringify([endpointId, id]);
  const previous = templateMutations.get(key);
  const task = previous ? previous.catch(() => {}).then(operation) : operation();
  templateMutations.set(key, task);
  const cleanUp = () => {
    if (templateMutations.get(key) === task) templateMutations.delete(key);
  };
  task.then(cleanUp, cleanUp);
  return task;
}

async function deleteHistory(row) {
  const deleted = await runValue(() => props.runtime.sendHistory.delete(row.id));
  if (!deleted) return;
  const targetPage = historyRows.value.length === 1 && historyPage.value > 1
    ? historyPage.value - 1
    : historyPage.value;
  await loadHistory(targetPage);
}

async function clearHistory() {
  if (!window.confirm('确定清空当前端点的全部发送历史吗？')) return;
  const result = await runValue(() => props.runtime.sendHistory.clear(props.endpointId));
  if (result === undefined) return;
  historyRows.value = [];
  historyTotal.value = 0;
  historyPage.value = 1;
}

function upsertTemplate(value) {
  templates.value = [value, ...templates.value.filter(({ id }) => id !== value.id)];
}

function saveTemplateSnapshot(value) {
  // Templates contain JSON values only. Copy nested reactive targets before IPC;
  // a shallow spread still leaves Vue proxies inside a renamed template.
  return props.runtime.template.save(JSON.parse(JSON.stringify(value)));
}

function createTemplateId() {
  templateSequence += 1;
  return `template-${Date.now()}-${templateSequence}`;
}

async function run(operation, replaceContext = true) {
  if (disposed) return;
  if (replaceContext) {
    generation += 1;
    pendingCount = 0;
  }
  const requestGeneration = generation;
  const isCurrent = () => !disposed && requestGeneration === generation;
  pendingCount += 1;
  loading.value = true;
  error.value = '';
  try {
    await operation(isCurrent);
  } catch (reason) {
    if (isCurrent()) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (isCurrent()) {
      pendingCount -= 1;
      loading.value = pendingCount > 0;
    }
  }
}

async function runValue(operation) {
  let value;
  await run(async (isCurrent) => {
    const result = await operation();
    if (isCurrent()) value = result;
  }, false);
  return value;
}
</script>

<template>
  <aside
    class="send-library"
    aria-label="发送资料库"
  >
    <header class="send-library__header">
      <div
        class="segmented-control"
        role="tablist"
        aria-label="发送资料库视图"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'templates'"
          :class="{ active: activeTab === 'templates' }"
          @click="selectTab('templates')"
        >
          模板
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'history'"
          :class="{ active: activeTab === 'history' }"
          @click="selectTab('history')"
        >
          历史
        </button>
      </div>
      <LoaderCircle
        v-if="loading"
        :size="15"
        class="spin send-library__loading"
      />
      <button
        class="icon-button"
        type="button"
        aria-label="关闭发送资料库"
        title="关闭"
        @click="emit('close')"
      >
        <X :size="16" />
      </button>
    </header>

    <p
      v-if="error"
      class="send-library__error"
      role="alert"
    >
      {{ error }}
    </p>

    <template v-if="activeTab === 'templates'">
      <form
        class="send-library__save"
        @submit.prevent="saveCurrentTemplate"
      >
        <input
          v-model="templateName"
          name="template-name"
          maxlength="80"
          placeholder="模板名称"
          aria-label="模板名称"
        >
        <button
          class="icon-button"
          type="submit"
          :disabled="!templateName.trim() || !snapshot || loading"
          aria-label="保存当前内容为模板"
          title="保存当前内容为模板"
        >
          <Save :size="15" />
        </button>
      </form>
      <div class="send-library__list">
        <p
          v-if="templates.length === 0 && !loading"
          class="send-library__empty"
        >
          暂无模板
        </p>
        <article
          v-for="item in templates"
          :key="item.id"
          class="send-library__item"
        >
          <form
            v-if="renamingId === item.id"
            class="send-library__rename"
            @submit.prevent="renameTemplate(item)"
          >
            <input
              v-model="renameValue"
              :name="`rename-template-${item.id}`"
              maxlength="80"
              aria-label="新的模板名称"
            >
            <button
              class="icon-button"
              type="submit"
              :disabled="!renameValue.trim() || loading"
              :aria-label="`保存模板名称 ${item.name}`"
              title="保存名称"
            >
              <Save :size="14" />
            </button>
          </form>
          <button
            v-else
            class="send-library__load"
            type="button"
            :aria-label="`载入模板 ${item.name}`"
            @click="emit('load', item)"
          >
            <strong>{{ item.name }}</strong>
            <small>{{ item.format.toUpperCase() }} · {{ formatHistoryPayload(item, { byteLimit: 48 }) }}</small>
          </button>
          <div class="send-library__item-actions">
            <button
              class="icon-button"
              type="button"
              :aria-label="`重命名模板 ${item.name}`"
              title="重命名"
              @click="beginRename(item)"
            >
              <Pencil :size="14" />
            </button>
            <button
              class="icon-button icon-button--danger"
              type="button"
              :aria-label="`删除模板 ${item.name}`"
              title="删除"
              @click="deleteTemplate(item)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </article>
      </div>
    </template>

    <template v-else>
      <div class="send-library__history-tools">
        <span>{{ historyTotal }} 条记录</span>
        <button
          class="icon-button icon-button--danger"
          type="button"
          :disabled="historyTotal === 0 || loading"
          aria-label="清空当前端点发送历史"
          title="清空当前端点发送历史"
          @click="clearHistory"
        >
          <Trash2 :size="14" />
        </button>
      </div>
      <div class="send-library__list">
        <p
          v-if="historyRows.length === 0 && !loading"
          class="send-library__empty"
        >
          暂无发送历史
        </p>
        <article
          v-for="row in historyRows"
          :key="row.id"
          class="send-library__item"
        >
          <button
            class="send-library__load"
            type="button"
            :aria-label="`载入历史记录 ${row.id}`"
            @click="emit('load', row)"
          >
            <strong>{{ formatTimestamp(row.createdAt) }}</strong>
            <small>{{ row.byteCount }} 字节 · {{ row.format.toUpperCase() }} · {{ formatHistoryPayload(row, { byteLimit: 48 }) }}</small>
          </button>
          <div class="send-library__item-actions">
            <button
              class="icon-button icon-button--danger"
              type="button"
              :aria-label="`删除历史记录 ${row.id}`"
              title="删除"
              @click="deleteHistory(row)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </article>
      </div>
      <footer class="send-library__pagination">
        <button
          class="icon-button"
          type="button"
          :disabled="historyPage <= 1 || loading"
          aria-label="上一页"
          title="上一页"
          @click="loadHistory(historyPage - 1)"
        >
          <ChevronLeft :size="15" />
        </button>
        <span>{{ historyPage }} / {{ historyPages }}</span>
        <button
          class="icon-button"
          type="button"
          :disabled="historyPage >= historyPages || loading"
          aria-label="下一页"
          title="下一页"
          @click="loadHistory(historyPage + 1)"
        >
          <ChevronRight :size="15" />
        </button>
      </footer>
    </template>
  </aside>
</template>
