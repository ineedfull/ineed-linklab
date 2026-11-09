<script setup>
import { formatTimestamp as formatTime } from '../model/dateTime.js';
import {
  buildDlt645ReadRequest,
  decodeDlt645Bcd,
  extractDlt645Frames,
  formatDlt645Hex,
  parseDlt645Frame,
} from '@ineed-linklab/codecs/dlt645.js';
import {
  CircleStop, FileCode2, Gauge, LoaderCircle, Plus, RadioTower,
  RefreshCw, Save, Trash2,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import {
  DLT645_DATA_ITEMS,
  applyDlt645CatalogItem,
  createDlt645Meter,
  createDlt645Task,
  normalizeDlt645Config,
  validateDlt645Config,
} from '../model/dlt645Config.js';
import {
  appendDlt645Transaction,
  failDlt645Transaction,
} from '../model/dlt645Transactions.js';
import Dlt645TransactionDiagnostics from './Dlt645TransactionDiagnostics.vue';

const props = defineProps({
  endpoint: { type: Object, required: true },
  frames: { type: Array, default: () => [] },
  running: Boolean,
  sessionId: { type: String, default: null },
  sendCommand: { type: Function, required: true },
  saveCommand: { type: Function, required: true },
});

const activeTab = ref('live');
const config = reactive(normalizeDlt645Config(props.endpoint.config));
const dirty = ref(false);
const saving = ref(false);
const saveError = ref('');
const polling = ref(false);
const requestPending = ref(false);
const values = reactive(new Map());
const dueAt = new Map();
const transactions = ref([]);
const selectedTransaction = ref(null);
let processedFrames = new WeakSet();
let incomingRemainder = new Uint8Array();
let resynchronizing = false;
let pollTimer = null;
let timeoutTimer = null;
let lastRequestAt = 0;
let pendingKey = null;
let pendingRequest = null;
let mounted = true;
let draftRevision = 0;

const tasks = computed(() => config.meters.flatMap((meter) => (
  meter.tasks.map((task) => ({ meter, task, key: taskKey(meter, task) }))
)));
const enabledTasks = computed(() => tasks.value.filter(({ meter, task }) => (
  meter.enabled && task.enabled
)));
const validationErrors = computed(() => validateDlt645Config(config));
const configValid = computed(() => Object.keys(validationErrors.value).length === 0);
const canRead = computed(() => props.running && Boolean(props.sessionId) && configValid.value);
const canPoll = computed(() => canRead.value && enabledTasks.value.length > 0);
const liveRows = computed(() => tasks.value.map(({ meter, task, key }) => ({
  meter,
  task,
  value: values.get(key) ?? emptyValue(),
})));
const liveGroups = computed(() => config.meters.map((meter) => {
  const rows = liveRows.value.filter((row) => row.meter === meter);
  const updatedTimes = rows
    .map(({ value }) => value.updatedAt)
    .filter((updatedAt) => updatedAt !== null);
  const latestFailedRow = rows.reduce((latest, row) => {
    if (row.value.quality !== 'bad' || !row.value.error) return latest;
    if (!latest || (row.value.updatedAt ?? 0) > (latest.value.updatedAt ?? 0)) return row;
    return latest;
  }, null);
  return {
    meter,
    rows,
    goodCount: rows.filter(({ value }) => value.quality === 'good').length,
    badCount: rows.filter(({ value }) => value.quality === 'bad').length,
    unknownCount: rows.filter(({ value }) => value.quality === 'unknown').length,
    lastUpdatedAt: updatedTimes.length > 0 ? Math.max(...updatedTimes) : null,
    lastError: latestFailedRow?.value.error ?? '',
  };
}));
const successCount = computed(() => liveRows.value.filter(({ value }) => value.quality === 'good').length);
const failedCount = computed(() => liveRows.value.filter(({ value }) => value.quality === 'bad').length);

watch(() => props.endpoint.config, (next) => {
  if (dirty.value) return;
  Object.assign(config, normalizeDlt645Config(next));
}, { deep: true });

watch(() => props.frames, processFrames, { deep: false, immediate: true });

watch(() => [props.running, props.sessionId], ([running]) => {
  // A port can acquire a new session without an intermediate stopped render.
  stopPolling();
  finishRequest();
  incomingRemainder = new Uint8Array();
  resynchronizing = false;
  lastRequestAt = 0;
  values.clear();
  transactions.value = [];
  selectedTransaction.value = null;
  if (running && config.autoStart) startPolling();
}, { flush: 'sync' });

onMounted(() => {
  pollTimer = globalThis.setInterval(runPollingCycle, 100);
  if (props.running && config.autoStart) startPolling();
});

onBeforeUnmount(() => {
  mounted = false;
  incomingRemainder = new Uint8Array();
  resynchronizing = false;
  if (pollTimer !== null) globalThis.clearInterval(pollTimer);
  stopPolling();
  finishRequest();
});

function addMeter() {
  config.meters.push(createDlt645Meter(config.meters.length + 1));
  markDirty();
}

function removeMeter(index) {
  config.meters.splice(index, 1);
  markDirty();
}

function addTask(meter) {
  meter.tasks.push(createDlt645Task());
  markDirty();
}

function removeTask(meter, index) {
  meter.tasks.splice(index, 1);
  markDirty();
}

function selectCatalogItem(task, identifier) {
  Object.assign(task, applyDlt645CatalogItem(task, identifier));
  markDirty();
}

function markDirty() {
  draftRevision += 1;
  dirty.value = true;
  saveError.value = '';
}

async function saveConfiguration() {
  if (saving.value || Object.keys(validationErrors.value).length > 0) return;
  saving.value = true;
  saveError.value = '';
  const revision = draftRevision;
  const draft = {
    ...props.endpoint,
    config: JSON.parse(JSON.stringify(config)),
  };
  try {
    const result = await props.saveCommand(draft);
    if (result?.ok) {
      if (revision === draftRevision) dirty.value = false;
    }
    else saveError.value = result?.error?.message ?? '保存失败';
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

function startPolling() {
  if (!canPoll.value) return;
  const now = Date.now();
  for (const { key } of enabledTasks.value) dueAt.set(key, now);
  polling.value = true;
}

function stopPolling() {
  polling.value = false;
  dueAt.clear();
}

async function runPollingCycle() {
  if (!polling.value || !canPoll.value || requestPending.value) return;
  const now = Date.now();
  if (now - lastRequestAt < config.minRequestGapMs) return;
  const next = enabledTasks.value.reduce((earliest, candidate) => {
    const candidateDueAt = dueAt.get(candidate.key) ?? 0;
    if (candidateDueAt > now) return earliest;
    if (!earliest) return candidate;
    return candidateDueAt < (dueAt.get(earliest.key) ?? 0) ? candidate : earliest;
  }, null);
  if (!next) return;
  dueAt.set(next.key, now + next.task.pollIntervalMs);
  await readTask(next.meter, next.task);
}

async function readTask(meter, task) {
  if (!canRead.value || requestPending.value || !meter.enabled || !task.enabled) return;
  // Capture the wire identity and timing before awaiting the native send. A newer
  // read of the same task must never be completed by this request's continuation.
  const request = {
    key: taskKey(meter, task),
    address: meter.address,
    identifier: task.identifier,
    sessionId: props.sessionId,
    timeoutMs: config.timeoutMs,
  };
  pendingRequest = request;
  requestPending.value = true;
  pendingKey = request.key;
  lastRequestAt = Date.now();
  try {
    const bytes = buildDlt645ReadRequest({
      address: request.address,
      dataIdentifier: request.identifier,
      wakeUpBytes: config.wakeUpBytes,
    });
    const result = await props.sendCommand({
      endpointId: props.endpoint.id,
      bytes,
      target: { endpointId: props.endpoint.id, expectedSessionId: request.sessionId },
      framing: 'dlt645',
    });
    if (!isCurrentRequest(request)) return;
    if (result?.ok !== true) throw new Error(result?.error?.message ?? '发送失败');
    timeoutTimer = globalThis.setTimeout(() => {
      if (!isCurrentRequest(request)) return;
      markFailure(request.key, '响应超时');
      markTransactionFailure(request.address, request.identifier, '响应超时');
      finishRequest();
    }, request.timeoutMs);
  } catch (error) {
    if (!isCurrentRequest(request)) return;
    const message = error instanceof Error ? error.message : String(error);
    markFailure(request.key, message);
    markTransactionFailure(request.address, request.identifier, message);
    finishRequest();
  }
}

function isCurrentRequest(request) {
  return mounted && props.running && props.sessionId === request.sessionId
    && pendingRequest === request;
}

function processFrames(frames) {
  for (const frame of frames) {
    if (processedFrames.has(frame)) continue;
    processedFrames.add(frame);
    if (!props.running || !props.sessionId || frame.endpointId !== props.endpoint.id
      || frame.sessionId !== props.sessionId) continue;
    if (frame.direction === 'out') {
      try { recordTransaction(parseDlt645Frame(frame.bytes), 'out', frame.createdAt); } catch { /* Raw serial frame. */ }
      continue;
    }
    const combined = Uint8Array.of(...incomingRemainder, ...frame.bytes);
    const extracted = extractDlt645Frames(combined, { resynchronizing });
    incomingRemainder = new Uint8Array(extracted.remainder);
    resynchronizing = extracted.resynchronizing;
    for (const parsed of extracted.frames) {
      recordTransaction(parsed, 'in', frame.createdAt);
      applyResponse(parsed, frame.createdAt);
    }
  }
}

function recordTransaction(parsed, direction, createdAt) {
  const result = appendDlt645Transaction(
    transactions.value,
    { parsed, direction, createdAt },
    100,
  );
  transactions.value = result.transactions;
  if (!selectedTransaction.value || selectedTransaction.value.id === result.transaction?.id) {
    selectedTransaction.value = result.transaction;
  }
}

function markTransactionFailure(address, dataIdentifier, message) {
  const result = failDlt645Transaction(transactions.value, {
    address,
    dataIdentifier,
    functionCode: 0x11,
  }, message);
  if (!result.transaction) return;
  transactions.value = result.transactions;
  if (!selectedTransaction.value || selectedTransaction.value.id === result.transaction.id) {
    selectedTransaction.value = result.transaction;
  }
}

function applyResponse(parsed, createdAt) {
  if (!parsed.response || parsed.functionCode !== 0x11) return;
  if (parsed.abnormal) {
    if (!pendingRequest || parsed.address !== pendingRequest.address) return;
    const message = parsed.errorFlags.join('、') || '电表返回异常应答';
    if (pendingKey) markFailure(pendingKey, message, createdAt);
    finishRequest();
    return;
  }
  // Configuration edits can be temporarily invalid while live bytes arrive.
  // Keep diagnostics, but do not pass an invalid decoder draft to the codec.
  if (!configValid.value) return;
  const row = tasks.value.find(({ meter, task }) => (
    meter.address === parsed.address && task.identifier === parsed.dataIdentifier
  ));
  if (!row) return;
  const lengthValid = row.task.byteLength === 0 || row.task.byteLength === parsed.valueBytes.length;
  const decoded = lengthValid
    ? decodeDlt645Bcd(parsed.valueBytes, row.task.decimals, { signed: row.task.signed })
    : null;
  values.set(row.key, {
    quality: decoded === null ? 'bad' : 'good',
    display: decoded === null ? '--' : formatNumber(decoded, row.task.decimals),
    rawHex: formatDlt645Hex(parsed.valueBytes),
    error: decoded === null
      ? (lengthValid ? 'BCD 数据无效' : `长度应为 ${row.task.byteLength} 字节`)
      : '',
    updatedAt: createdAt,
  });
  if (pendingRequest?.address === parsed.address
    && pendingRequest.identifier === parsed.dataIdentifier) finishRequest();
}

function markFailure(key, message, createdAt = Date.now()) {
  if (!key) return;
  values.set(key, { quality: 'bad', display: '--', rawHex: '', error: message, updatedAt: createdAt });
}

function finishRequest() {
  clearRequestTimeout();
  requestPending.value = false;
  pendingKey = null;
  pendingRequest = null;
}

function clearRequestTimeout() {
  if (timeoutTimer !== null) globalThis.clearTimeout(timeoutTimer);
  timeoutTimer = null;
}

function taskKey(meter, task) {
  return `${meter.id}:${task.id}`;
}

function emptyValue() {
  return { quality: 'unknown', display: '--', rawHex: '', error: '', updatedAt: null };
}

function formatNumber(value, decimals) {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(value);
}



function fieldError(path) {
  return validationErrors.value[path] ?? '';
}
</script>

<template>
  <section class="dlt645-panel">
    <header class="dlt645-panel__header">
      <div>
        <strong>DL/T 645-2007 电表主站</strong>
        <span>{{ config.path || '未设置串口' }} · {{ config.baudRate }} {{ config.dataBits }}{{ config.parity === 'even' ? 'E' : config.parity === 'odd' ? 'O' : 'N' }}{{ config.stopBits }}</span>
      </div>
      <div class="dlt645-panel__summary">
        <span>电表 {{ config.meters.length }}</span>
        <span class="quality quality--good">正常 {{ successCount }}</span>
        <span class="quality quality--bad">异常 {{ failedCount }}</span>
        <button
          v-if="!polling"
          type="button"
          class="command-button"
          :disabled="!canPoll"
          @click="startPolling"
        >
          <RadioTower :size="15" />启动轮询
        </button>
        <button
          v-else
          type="button"
          class="command-button"
          @click="stopPolling"
        >
          <CircleStop :size="15" />停止轮询
        </button>
      </div>
    </header>

    <nav
      class="dlt645-tabs"
      aria-label="DL/T 645 主站视图"
    >
      <button
        type="button"
        :class="{ active: activeTab === 'live' }"
        @click="activeTab = 'live'"
      >
        <Gauge :size="15" />实时数据
      </button>
      <button
        type="button"
        :class="{ active: activeTab === 'config' }"
        @click="activeTab = 'config'"
      >
        <RadioTower :size="15" />电表与抄读项
      </button>
      <button
        type="button"
        :class="{ active: activeTab === 'frames' }"
        @click="activeTab = 'frames'"
      >
        <FileCode2 :size="15" />报文诊断
      </button>
    </nav>

    <div
      v-if="activeTab === 'live'"
      class="dlt645-panel__body"
    >
      <div
        v-if="liveGroups.length === 0"
        class="dlt645-empty"
      >
        尚未配置电表
      </div>
      <div
        v-else
        class="dlt645-live-groups"
      >
        <article
          v-for="group in liveGroups"
          :key="group.meter.id"
          class="dlt645-live-group"
        >
          <header class="dlt645-live-group__header">
            <div class="dlt645-live-group__identity">
              <strong>{{ group.meter.name }}</strong>
              <span class="dlt645-live-group__address">通信地址 <code>{{ group.meter.address }}</code></span>
              <span
                class="dlt645-live-group__error"
                :title="group.lastError"
                aria-live="polite"
              >
                {{ group.lastError ? `通信异常：${group.lastError}` : '' }}
              </span>
            </div>
            <div class="dlt645-live-group__summary">
              <span
                class="dlt645-live-group__state"
                :class="{ 'dlt645-live-group__state--enabled': group.meter.enabled }"
              >
                {{ group.meter.enabled ? '已启用' : '已停用' }}
              </span>
              <span class="quality quality--good">正常 {{ group.goodCount }}</span>
              <span class="quality quality--bad">异常 {{ group.badCount }}</span>
              <span class="quality quality--unknown">等待 {{ group.unknownCount }}</span>
              <span>最近 {{ formatTime(group.lastUpdatedAt) }}</span>
            </div>
          </header>
          <div
            v-if="group.rows.length === 0"
            class="dlt645-live-group__empty"
          >
            该电表尚未配置抄读项
          </div>
          <div
            v-else
            class="dlt645-table-wrap"
          >
            <table class="dlt645-table dlt645-live-table">
              <thead><tr><th>数据项</th><th>DI</th><th>当前值</th><th>质量</th><th>原始数据</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>
                <tr
                  v-for="row in group.rows"
                  :key="`${row.meter.id}:${row.task.id}`"
                >
                  <td data-label="数据项">
                    {{ row.task.name }}
                  </td>
                  <td data-label="DI">
                    <code>{{ row.task.identifier }}</code>
                  </td>
                  <td
                    data-label="当前值"
                    class="dlt645-value"
                  >
                    {{ row.value.display }} <small>{{ row.task.unit }}</small>
                  </td>
                  <td data-label="质量">
                    <span
                      class="quality"
                      :class="`quality--${row.value.quality}`"
                    >{{ row.value.quality === 'good' ? '正常' : row.value.quality === 'bad' ? '异常' : '等待' }}</span><small v-if="row.value.error">{{ row.value.error }}</small>
                  </td>
                  <td data-label="原始数据">
                    <code>{{ row.value.rawHex || '--' }}</code>
                  </td>
                  <td data-label="更新时间">
                    {{ formatTime(row.value.updatedAt) }}
                  </td>
                  <td data-label="操作">
                    <button
                      type="button"
                      class="icon-button"
                      title="单次抄读"
                      :disabled="!canRead || requestPending || !row.meter.enabled || !row.task.enabled"
                      @click="readTask(row.meter, row.task)"
                    >
                      <LoaderCircle
                        v-if="requestPending && pendingKey === `${row.meter.id}:${row.task.id}`"
                        :size="14"
                        class="spin"
                      /><RefreshCw
                        v-else
                        :size="14"
                      />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </div>

    <div
      v-else-if="activeTab === 'config'"
      class="dlt645-panel__body dlt645-config"
    >
      <div class="dlt645-config__actions">
        <button
          type="button"
          class="command-button"
          @click="addMeter"
        >
          <Plus :size="15" />新增电表
        </button>
        <button
          type="button"
          class="command-button command-button--primary"
          :disabled="!dirty || saving || Object.keys(validationErrors).length > 0"
          @click="saveConfiguration"
        >
          <LoaderCircle
            v-if="saving"
            :size="15"
            class="spin"
          /><Save
            v-else
            :size="15"
          />保存配置
        </button>
      </div>
      <div
        v-if="saveError"
        class="dlt645-notice dlt645-notice--error"
      >
        {{ saveError }}
      </div>
      <article
        v-for="(meter, meterIndex) in config.meters"
        :key="meter.id"
        class="dlt645-meter"
      >
        <header>
          <label><span>电表名称</span><input
            v-model="meter.name"
            :aria-invalid="Boolean(fieldError(`meters.${meterIndex}.name`))"
            @input="markDirty"
          ></label>
          <label><span>通信地址</span><input
            v-model.trim="meter.address"
            maxlength="12"
            :aria-invalid="Boolean(fieldError(`meters.${meterIndex}.address`))"
            @input="markDirty"
          ></label>
          <label class="dlt645-toggle"><input
            v-model="meter.enabled"
            type="checkbox"
            @change="markDirty"
          ><span>启用</span></label>
          <button
            type="button"
            class="icon-button danger"
            title="删除电表"
            @click="removeMeter(meterIndex)"
          >
            <Trash2 :size="15" />
          </button>
        </header>
        <small
          v-if="fieldError(`meters.${meterIndex}.address`)"
          class="field-error"
        >{{ fieldError(`meters.${meterIndex}.address`) }}</small>
        <div class="dlt645-table-wrap">
          <table class="dlt645-table dlt645-task-table">
            <thead><tr><th>启用</th><th>标准数据项</th><th>名称</th><th>DI</th><th>单位</th><th>小数</th><th>长度</th><th>周期 ms</th><th /></tr></thead>
            <tbody>
              <tr
                v-for="(task, taskIndex) in meter.tasks"
                :key="task.id"
              >
                <td data-label="启用">
                  <input
                    v-model="task.enabled"
                    type="checkbox"
                    @change="markDirty"
                  >
                </td>
                <td data-label="标准数据项">
                  <select
                    :value="DLT645_DATA_ITEMS.some(({ identifier }) => identifier === task.identifier) ? task.identifier : '__custom__'"
                    @change="$event.target.value !== '__custom__' && selectCatalogItem(task, $event.target.value)"
                  >
                    <option value="__custom__">
                      自定义
                    </option><option
                      v-for="item in DLT645_DATA_ITEMS"
                      :key="item.identifier"
                      :value="item.identifier"
                    >
                      {{ item.name }}
                    </option>
                  </select>
                </td>
                <td data-label="名称">
                  <input
                    v-model="task.name"
                    @input="markDirty"
                  >
                </td>
                <td data-label="DI">
                  <input
                    v-model.trim="task.identifier"
                    maxlength="8"
                    class="dlt645-di-input"
                    :aria-invalid="Boolean(fieldError(`meters.${meterIndex}.tasks.${taskIndex}.identifier`))"
                    @input="task.identifier = task.identifier.toUpperCase(); markDirty()"
                  >
                </td>
                <td data-label="单位">
                  <input
                    v-model="task.unit"
                    class="dlt645-short-input"
                    @input="markDirty"
                  >
                </td>
                <td data-label="小数">
                  <input
                    v-model.number="task.decimals"
                    type="number"
                    min="0"
                    max="12"
                    class="dlt645-number-input"
                    @input="markDirty"
                  >
                </td>
                <td data-label="长度">
                  <input
                    v-model.number="task.byteLength"
                    type="number"
                    min="0"
                    max="64"
                    class="dlt645-number-input"
                    title="0 表示自动"
                    @input="markDirty"
                  >
                </td>
                <td data-label="周期 ms">
                  <input
                    v-model.number="task.pollIntervalMs"
                    type="number"
                    min="500"
                    max="3600000"
                    step="100"
                    class="dlt645-period-input"
                    @input="markDirty"
                  >
                </td>
                <td data-label="操作">
                  <button
                    type="button"
                    class="icon-button danger"
                    title="删除抄读项"
                    @click="removeTask(meter, taskIndex)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <button
          type="button"
          class="text-button"
          @click="addTask(meter)"
        >
          <Plus :size="14" />添加抄读项
        </button>
      </article>
      <div
        v-if="config.meters.length === 0"
        class="dlt645-empty"
      >
        尚未配置电表
      </div>
    </div>

    <div
      v-else
      class="dlt645-panel__body dlt645-frames"
    >
      <Dlt645TransactionDiagnostics
        :transactions="transactions"
        :selected-transaction="selectedTransaction"
        @select="selectedTransaction = $event"
      />
    </div>
  </section>
</template>

<style scoped>
.dlt645-panel { min-height: 0; grid-row: 2 / -1; display: flex; flex-direction: column; overflow: hidden; color: var(--text); background: var(--surface); }
.dlt645-panel__header { min-height: 58px; padding: 10px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dlt645-panel__header > div:first-child { display: grid; gap: 3px; }
.dlt645-panel__header span { color: var(--text-muted); font-size: var(--font-size-control); }
.dlt645-panel__summary, .dlt645-config__actions { display: flex; align-items: center; gap: 10px; }
.dlt645-tabs { display: flex; gap: 2px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.dlt645-tabs button { height: 40px; padding: 0 9px; border: 0; border-bottom: 2px solid transparent; background: transparent; display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); cursor: pointer; }
.dlt645-tabs button:hover { color: var(--text); background: var(--surface-control); }
.dlt645-tabs button.active { color: var(--accent); border-bottom-color: currentColor; background: transparent; font-weight: 600; }
.dlt645-panel__body { min-height: 0; flex: 1; overflow: auto; padding: 14px 16px; }
.dlt645-live-groups { display: grid; gap: 12px; }
.dlt645-live-group { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
.dlt645-live-group__header { min-height: 48px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); display: flex; align-items: center; justify-content: space-between; gap: 16px; background: var(--surface-control); }
.dlt645-live-group__identity { min-width: 0; flex: 1 1 auto; display: grid; grid-template-columns: minmax(120px, auto) auto minmax(120px, 1fr); align-items: baseline; gap: 5px 14px; }
.dlt645-live-group__identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dlt645-live-group__address { color: var(--text-muted); font-size: var(--font-size-small); }
.dlt645-live-group__address code { margin-left: 4px; color: var(--text); font-size: var(--font-size-control); }
.dlt645-live-group__error { min-width: 0; height: 16px; overflow: hidden; color: var(--danger); font-size: var(--font-size-small); line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.dlt645-live-group__summary { flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 5px 12px; color: var(--text-muted); font-size: var(--font-size-small); }
.dlt645-live-group__state { display: inline-flex; align-items: center; gap: 5px; }
.dlt645-live-group__state::before { width: 6px; height: 6px; border-radius: 50%; background: currentColor; content: ''; }
.dlt645-live-group__state--enabled { color: var(--success); }
.dlt645-live-group__empty { padding: 22px 12px; text-align: center; color: var(--text-muted); font-size: var(--font-size-control); }
.dlt645-table-wrap { width: 100%; overflow: auto; }
.dlt645-table { width: 100%; border-collapse: collapse; font-size: var(--font-size); }
.dlt645-table th { text-align: left; color: var(--text-muted); font-weight: 600; background: var(--surface-control); }
.dlt645-table th, .dlt645-table td { padding: 9px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; white-space: nowrap; }
.dlt645-table td small { display: block; margin-top: 2px; color: var(--text-muted); }
.dlt645-value { font-size: calc(var(--font-size-title) + 1px); font-weight: 650; font-variant-numeric: tabular-nums; }
.dlt645-value small { display: inline !important; margin-left: 3px; font-weight: 400; }
.quality { display: inline-flex; align-items: center; font-size: var(--font-size-control); }
.quality--good { color: var(--success) !important; }
.quality--bad { color: var(--danger) !important; }
.quality--unknown { color: var(--text-muted) !important; }
.dlt645-empty { padding: 48px 16px; text-align: center; color: var(--text-muted); }
.dlt645-config { display: grid; align-content: start; gap: 12px; }
.dlt645-config__actions { justify-content: flex-end; }
.dlt645-meter { border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.dlt645-meter > header { min-height: 54px; padding: 8px 10px; display: grid; grid-template-columns: minmax(150px, 1fr) minmax(180px, 1fr) auto 32px; gap: 10px; align-items: end; background: var(--surface-control); border-bottom: 1px solid var(--line-soft); }
.dlt645-meter label { display: grid; gap: 4px; font-size: var(--font-size-control); color: var(--text-muted); }
.dlt645-meter input, .dlt645-meter select { min-width: 0; height: 30px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); padding: 0 7px; }
.dlt645-meter .dlt645-toggle { display: flex; align-items: center; align-self: end; min-height: 30px; gap: 6px; }
.dlt645-toggle input { width: 16px; height: 16px; }
.dlt645-task-table input, .dlt645-task-table select { width: 100%; }
.dlt645-task-table .dlt645-di-input { width: 90px; font-family: ui-monospace, monospace; }
.dlt645-task-table .dlt645-short-input { width: 62px; }
.dlt645-task-table .dlt645-number-input { width: 56px; }
.dlt645-task-table .dlt645-period-input { width: 96px; }
.dlt645-meter > .text-button { margin: 8px 10px; }
.dlt645-notice { margin: 10px 16px 0; padding: 8px 10px; border-radius: 4px; font-size: var(--font-size); }
.dlt645-notice--error { color: var(--danger); background: var(--surface-control); border: 1px solid var(--danger); }
.dlt645-frames { overflow: hidden; }
.danger { color: var(--danger); }
@media (max-width: 900px) {
  .dlt645-panel__header { align-items: flex-start; flex-direction: column; }
  .dlt645-panel__summary { width: 100%; flex-wrap: wrap; }
  .dlt645-live-group__header { align-items: flex-start; flex-direction: column; gap: 6px; }
  .dlt645-live-group__identity { width: 100%; grid-template-columns: minmax(120px, auto) auto minmax(100px, 1fr); }
  .dlt645-live-group__summary { width: 100%; justify-content: flex-start; }
  .dlt645-meter > header { grid-template-columns: 1fr 1fr; }
  .dlt645-table thead { display: none; }
  .dlt645-table tbody, .dlt645-table tr { display: block; }
  .dlt645-table tbody tr { padding: 8px; border-bottom: 1px solid var(--line); }
  .dlt645-table tbody td { display: grid; grid-template-columns: 92px minmax(0, 1fr); align-items: center; gap: 6px; padding: 5px 4px; border: 0; white-space: normal; }
  .dlt645-table tbody td::before { content: attr(data-label); color: var(--text-muted); font-size: var(--font-size-small); font-weight: 600; }
  .dlt645-task-table tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
  .dlt645-task-table tbody td { grid-template-columns: 1fr; gap: 3px; padding: 2px 0; }
  .dlt645-task-table tbody td:last-child { align-content: end; justify-items: end; }
  .dlt645-task-table .dlt645-di-input,
  .dlt645-task-table .dlt645-short-input,
  .dlt645-task-table .dlt645-number-input,
  .dlt645-task-table .dlt645-period-input { width: 100%; }
}
@media (max-width: 700px) {
  .dlt645-live-group__identity { grid-template-columns: minmax(0, 1fr) auto; }
  .dlt645-live-group__error { grid-column: 1 / -1; }
}
</style>
