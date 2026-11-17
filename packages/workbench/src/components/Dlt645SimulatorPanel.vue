<script setup>
import { formatTimestamp as formatTime } from '../model/dateTime.js';
import {
  Activity, FileCode2, Gauge, LoaderCircle, Plus, Save, Settings2, Trash2,
} from 'lucide-vue-next';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';

import { DLT645_DATA_ITEMS } from '../model/dlt645Config.js';
import { createDlt645SimulatorController } from '../model/dlt645SimulatorController.js';
import {
  applyDlt645SimulatorCatalogItem,
  createDlt645SimulatorItem,
  createDlt645SimulatorMeter,
  normalizeDlt645SimulatorConfig,
  validateDlt645SimulatorConfig,
} from '../model/dlt645SimulatorConfig.js';
import Dlt645TransactionDiagnostics from './Dlt645TransactionDiagnostics.vue';

const props = defineProps({
  endpoint: { type: Object, required: true },
  controller: { type: Object, default: null },
  frames: { type: Array, default: () => [] },
  running: Boolean,
  sessionId: { type: String, default: null },
  sendCommand: { type: Function, required: true },
  saveCommand: { type: Function, required: true },
});

const activeTab = ref('data');
const config = reactive(normalizeDlt645SimulatorConfig(props.endpoint.config));
const dirty = ref(false);
const saving = ref(false);
const saveError = ref('');
let mounted = true;
let draftRevision = 0;
let saveGeneration = 0;
const transactions = ref([]);
const selectedTransaction = ref(null);
const statistics = reactive({ requests: 0, responses: 0, errors: 0 });
const itemActivity = reactive(new Map());
const meterErrors = reactive(new Map());
const ownsController = !props.controller;
const controller = props.controller ?? createDlt645SimulatorController({
  endpointId: props.endpoint.id, send: (request) => props.sendCommand(request),
});
function applyDiagnostics(snapshot) {
  transactions.value = snapshot.transactions;
  Object.assign(statistics, snapshot.statistics);
  itemActivity.clear();
  for (const [key, value] of snapshot.itemActivity) itemActivity.set(key, value);
  meterErrors.clear();
  for (const [key, value] of snapshot.meterErrors) meterErrors.set(key, value);
  selectedTransaction.value = snapshot.transactions.find((transaction) => transaction.id === selectedTransaction.value?.id)
    ?? snapshot.transactions[0] ?? null;
}
const unsubscribe = controller.subscribe(applyDiagnostics);
applyDiagnostics(controller.snapshot());
onUnmounted(() => { mounted = false; unsubscribe(); if (ownsController) controller.dispose(); });

const validationErrors = computed(() => validateDlt645SimulatorConfig(config));
const dataGroups = computed(() => config.meters.map((meter) => ({
  meter,
  error: meterErrors.get(meter.id) ?? '',
  rows: meter.tasks.map((item) => ({
    meter,
    item,
    activity: itemActivity.get(itemKey(meter, item)) ?? { reads: 0, lastReadAt: null },
  })),
})));

watch(() => props.endpoint.config, (next) => {
  if (dirty.value) return;
  Object.assign(config, normalizeDlt645SimulatorConfig(next));
}, { deep: true });

watch(() => [props.endpoint.id, props.sessionId], () => {
  saveGeneration += 1;
  saving.value = false;
  saveError.value = '';
}, { flush: 'sync' });

if (ownsController) {
  watch(() => [props.running, props.sessionId, config], () => {
    controller.reconcile({ running: props.running, sessionId: props.sessionId, config });
  }, { deep: true, immediate: true });
  // Standalone mounts can show retained diagnostics but only new frames answer.
  controller.consume(props.frames, { respond: false });
  watch(() => props.frames, (frames) => controller.consume(frames));
}

function addMeter() {
  config.meters.push(createDlt645SimulatorMeter(config.meters.length + 1));
  markDirty();
}

function removeMeter(index) {
  meterErrors.delete(config.meters[index]?.id);
  config.meters.splice(index, 1);
  markDirty();
}

function addItem(meter) {
  meter.tasks.push(createDlt645SimulatorItem());
  markDirty();
}

function removeItem(meter, index) {
  meter.tasks.splice(index, 1);
  markDirty();
}

function selectCatalogItem(item, identifier) {
  Object.assign(item, applyDlt645SimulatorCatalogItem(item, identifier));
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
  const generation = ++saveGeneration;
  const current = () => mounted && generation === saveGeneration;
  try {
    const result = await props.saveCommand({
      ...props.endpoint,
      config: JSON.parse(JSON.stringify(config)),
    });
    if (!current() || revision !== draftRevision) return;
    if (result?.ok) dirty.value = false;
    else saveError.value = result?.error?.message ?? '保存失败';
  } catch (error) {
    if (current() && revision === draftRevision) {
      saveError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (current()) saving.value = false;
  }
}

function itemKey(meter, item) {
  return `${meter.id}:${item.id}`;
}

function fieldError(path) {
  return validationErrors.value[path] ?? '';
}



</script>

<template>
  <section class="dlt645-simulator">
    <header class="dlt645-simulator__header">
      <div>
        <strong>DL/T 645-2007 电表从端模拟器</strong>
        <span>{{ config.path || '未设置串口' }} · {{ config.baudRate }} {{ config.dataBits }}{{ config.parity === 'even' ? 'E' : config.parity === 'odd' ? 'O' : 'N' }}{{ config.stopBits }}</span>
      </div>
      <div class="dlt645-simulator__summary">
        <span>电表 {{ config.meters.length }}</span>
        <span>请求 {{ statistics.requests }}</span>
        <span class="quality quality--good">响应 {{ statistics.responses }}</span>
        <span
          v-if="statistics.errors"
          class="quality quality--bad"
        >异常 {{ statistics.errors }}</span>
        <span
          class="simulator-state"
          :class="{ 'simulator-state--running': running }"
        >
          <Activity :size="14" />{{ running ? '监听中' : '未启动' }}
        </span>
      </div>
    </header>

    <nav
      class="dlt645-simulator__tabs"
      aria-label="DL/T 645 从端模拟器视图"
    >
      <button
        type="button"
        :class="{ active: activeTab === 'data' }"
        @click="activeTab = 'data'"
      >
        <Gauge :size="15" />模拟数据
      </button>
      <button
        type="button"
        :class="{ active: activeTab === 'config' }"
        @click="activeTab = 'config'"
      >
        <Settings2 :size="15" />电表配置
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
      v-if="activeTab === 'data'"
      class="dlt645-simulator__body"
    >
      <div class="dlt645-simulator__toolbar">
        <span>修改数值后保存，下一次主站读取即返回新值。</span>
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
          />保存数据
        </button>
      </div>
      <div
        v-if="saveError"
        class="dlt645-simulator__notice"
      >
        {{ saveError }}
      </div>
      <div
        v-if="dataGroups.length === 0"
        class="dlt645-simulator__empty"
      >
        尚未配置模拟数据
      </div>
      <div
        v-else
        class="dlt645-simulator__data-groups"
      >
        <article
          v-for="group in dataGroups"
          :key="group.meter.id"
          class="simulator-data-group"
        >
          <header class="simulator-data-group__header">
            <div class="simulator-data-group__identity">
              <strong>{{ group.meter.name }}</strong>
              <span class="simulator-data-group__address">通信地址 <code>{{ group.meter.address }}</code></span>
              <span
                class="simulator-data-group__error"
                :title="group.error"
                aria-live="polite"
              >
                {{ group.error ? `通信异常：${group.error}` : '' }}
              </span>
            </div>
            <div class="simulator-data-group__meta">
              <span
                class="simulator-data-group__state"
                :class="{ 'simulator-data-group__state--enabled': group.meter.enabled }"
              >
                {{ group.meter.enabled ? '已启用' : '已停用' }}
              </span>
              <span>{{ group.rows.length }} 个数据项</span>
            </div>
          </header>
          <div
            v-if="group.rows.length === 0"
            class="simulator-data-group__empty"
          >
            该电表尚未配置数据项
          </div>
          <div
            v-else
            class="dlt645-simulator__data-grid"
          >
            <div
              v-for="row in group.rows"
              :key="itemKey(row.meter, row.item)"
              class="simulator-data-row"
            >
              <div class="simulator-data-row__identity">
                <strong>{{ row.item.name }}</strong>
              </div>
              <code>{{ row.item.identifier }}</code>
              <label>
                <span>当前模拟值</span>
                <div><input
                  v-model.number="row.item.value"
                  type="number"
                  :step="1 / (10 ** row.item.decimals)"
                  :aria-invalid="Boolean(fieldError(`meters.${config.meters.indexOf(row.meter)}.tasks.${row.meter.tasks.indexOf(row.item)}.value`))"
                  @input="markDirty"
                ><span>{{ row.item.unit }}</span></div>
              </label>
              <span class="simulator-data-row__reads">读取 {{ row.activity.reads }} 次<small>最近 {{ formatTime(row.activity.lastReadAt) }}</small></span>
            </div>
          </div>
        </article>
      </div>
    </div>

    <div
      v-else-if="activeTab === 'config'"
      class="dlt645-simulator__body simulator-config"
    >
      <div class="dlt645-simulator__toolbar">
        <button
          type="button"
          class="command-button"
          @click="addMeter"
        >
          <Plus :size="15" />新增模拟电表
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
        class="dlt645-simulator__notice"
      >
        {{ saveError }}
      </div>
      <article
        v-for="(meter, meterIndex) in config.meters"
        :key="meter.id"
        class="simulator-meter"
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
          <label class="simulator-toggle"><input
            v-model="meter.enabled"
            type="checkbox"
            @change="markDirty"
          ><span>启用</span></label>
          <button
            type="button"
            class="icon-button danger"
            title="删除模拟电表"
            @click="removeMeter(meterIndex)"
          >
            <Trash2 :size="15" />
          </button>
        </header>
        <small
          v-if="fieldError(`meters.${meterIndex}.address`)"
          class="field-error"
        >{{ fieldError(`meters.${meterIndex}.address`) }}</small>
        <div class="simulator-items">
          <div
            v-for="(item, itemIndex) in meter.tasks"
            :key="item.id"
            class="simulator-item-row"
          >
            <input
              v-model="item.enabled"
              type="checkbox"
              aria-label="启用数据项"
              @change="markDirty"
            >
            <select
              :value="DLT645_DATA_ITEMS.some(({ identifier }) => identifier === item.identifier) ? item.identifier : '__custom__'"
              aria-label="标准数据项"
              @change="$event.target.value !== '__custom__' && selectCatalogItem(item, $event.target.value)"
            >
              <option value="__custom__">
                自定义数据项
              </option>
              <option
                v-for="catalogItem in DLT645_DATA_ITEMS"
                :key="catalogItem.identifier"
                :value="catalogItem.identifier"
              >
                {{ catalogItem.name }}
              </option>
            </select>
            <input
              v-model="item.name"
              aria-label="数据项名称"
              @input="markDirty"
            >
            <input
              v-model.trim="item.identifier"
              maxlength="8"
              aria-label="数据标识"
              :aria-invalid="Boolean(fieldError(`meters.${meterIndex}.tasks.${itemIndex}.identifier`))"
              @input="item.identifier = item.identifier.toUpperCase(); markDirty()"
            >
            <input
              v-model.number="item.value"
              type="number"
              aria-label="模拟值"
              :aria-invalid="Boolean(fieldError(`meters.${meterIndex}.tasks.${itemIndex}.value`))"
              @input="markDirty"
            >
            <input
              v-model="item.unit"
              aria-label="单位"
              placeholder="单位"
              @input="markDirty"
            >
            <input
              v-model.number="item.decimals"
              type="number"
              min="0"
              max="12"
              aria-label="小数位"
              title="小数位"
              @input="markDirty"
            >
            <input
              v-model.number="item.byteLength"
              type="number"
              min="1"
              max="64"
              aria-label="字节长度"
              title="字节长度"
              @input="markDirty"
            >
            <label
              class="simulator-item-row__signed"
              title="有符号 BCD"
            ><input
              v-model="item.signed"
              type="checkbox"
              @change="markDirty"
            ><span>有符号</span></label>
            <button
              type="button"
              class="icon-button danger"
              title="删除数据项"
              @click="removeItem(meter, itemIndex)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
        <button
          type="button"
          class="text-button"
          @click="addItem(meter)"
        >
          <Plus :size="14" />添加数据项
        </button>
      </article>
      <div
        v-if="config.meters.length === 0"
        class="dlt645-simulator__empty"
      >
        尚未配置模拟电表
      </div>
    </div>

    <div
      v-else
      class="dlt645-simulator__body dlt645-simulator__frames"
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
.dlt645-simulator { min-height: 0; grid-row: 2 / -1; display: flex; flex-direction: column; overflow: hidden; color: var(--text); background: var(--surface); }
.dlt645-simulator__header { min-height: 58px; padding: 10px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dlt645-simulator__header > div:first-child { display: grid; gap: 3px; }
.dlt645-simulator__header span { color: var(--text-muted); font-size: var(--font-size-control); }
.dlt645-simulator__summary, .dlt645-simulator__toolbar { display: flex; align-items: center; gap: 10px; }
.simulator-state { min-height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: 4px; display: inline-flex; align-items: center; gap: 5px; background: var(--surface-control); }
.simulator-state--running { color: var(--success) !important; border-color: var(--success); }
.dlt645-simulator__tabs { display: flex; gap: 2px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
.dlt645-simulator__tabs button { height: 40px; padding: 0 9px; border: 0; border-bottom: 2px solid transparent; background: transparent; display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); cursor: pointer; }
.dlt645-simulator__tabs button:hover { color: var(--text); background: var(--surface-control); }
.dlt645-simulator__tabs button.active { color: var(--accent); border-bottom-color: currentColor; background: transparent; font-weight: 600; }
.dlt645-simulator__body { min-height: 0; flex: 1; overflow: auto; padding: 14px 16px; }
.dlt645-simulator__toolbar { justify-content: space-between; margin-bottom: 12px; }
.dlt645-simulator__toolbar > span { color: var(--text-muted); font-size: var(--font-size-control); }
.dlt645-simulator__notice { padding: 8px 16px; color: var(--danger); background: var(--surface-control); border-bottom: 1px solid var(--danger); font-size: var(--font-size); }
.dlt645-simulator__empty { padding: 36px; text-align: center; color: var(--text-muted); }
.dlt645-simulator__data-groups { display: grid; gap: 12px; }
.simulator-data-group { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
.simulator-data-group__header { min-height: 48px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); display: flex; align-items: center; justify-content: space-between; gap: 16px; background: var(--surface-control); }
.simulator-data-group__identity { min-width: 0; flex: 1 1 auto; display: grid; grid-template-columns: minmax(120px, auto) auto minmax(120px, 1fr); align-items: baseline; gap: 5px 14px; }
.simulator-data-group__identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.simulator-data-group__address { color: var(--text-muted); font-size: var(--font-size-small); }
.simulator-data-group__address code { margin-left: 4px; color: var(--text); font-size: var(--font-size-control); }
.simulator-data-group__error { min-width: 0; height: 16px; overflow: hidden; color: var(--danger); font-size: var(--font-size-small); line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.simulator-data-group__meta { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; color: var(--text-muted); font-size: var(--font-size-small); }
.simulator-data-group__state { display: inline-flex; align-items: center; gap: 5px; }
.simulator-data-group__state::before { width: 6px; height: 6px; border-radius: 50%; background: currentColor; content: ''; }
.simulator-data-group__state--enabled { color: var(--success); }
.simulator-data-group__empty { padding: 22px 12px; text-align: center; color: var(--text-muted); font-size: var(--font-size-control); }
.dlt645-simulator__data-grid { display: grid; gap: 1px; background: var(--line-soft); }
.simulator-data-row { min-width: 0; display: grid; grid-template-columns: minmax(180px, 1.4fr) 100px minmax(190px, .9fr) 110px; align-items: center; gap: 12px; padding: 10px 12px; background: var(--surface); }
.simulator-data-row__identity { min-width: 0; display: grid; gap: 3px; }
.simulator-data-row__identity span, .simulator-data-row__reads small { color: var(--text-muted); font-size: var(--font-size-small); }
.simulator-data-row label { display: grid; gap: 4px; font-size: var(--font-size-small); color: var(--text-muted); }
.simulator-data-row label > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.simulator-data-row input { width: 100%; min-width: 0; height: 30px; padding: 0 7px; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 4px; font: inherit; }
.simulator-data-row__reads { display: grid; gap: 3px; font-size: var(--font-size-control); }
.simulator-config { display: grid; align-content: start; gap: 12px; background: var(--surface-muted); }
.simulator-config .dlt645-simulator__toolbar { margin: 0; }
.simulator-meter { border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.simulator-meter > header { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(180px, 1fr) auto 34px; align-items: end; gap: 10px; padding: 10px 12px; background: var(--surface-control); border-bottom: 1px solid var(--line-soft); }
.simulator-meter label { display: grid; gap: 4px; font-size: var(--font-size-small); color: var(--text-muted); }
.simulator-meter input:not([type="checkbox"]), .simulator-meter select { min-width: 0; width: 100%; height: 30px; padding: 0 7px; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 4px; font: inherit; }
.simulator-meter input[aria-invalid="true"], .simulator-data-row input[aria-invalid="true"] { border-color: var(--danger); }
.simulator-meter .simulator-toggle { display: flex; align-items: center; align-self: end; min-height: 30px; gap: 5px; }
.simulator-meter input[type="checkbox"] { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
.simulator-items { display: grid; gap: 1px; background: var(--line-soft); }
.simulator-item-row { min-width: 0; display: grid; grid-template-columns: 24px minmax(130px, 1.2fr) minmax(120px, 1fr) 92px minmax(90px, .7fr) 74px 54px 54px 76px 34px; align-items: center; gap: 8px; padding: 8px 12px; background: var(--surface); }
.simulator-item-row:hover { background: var(--surface-control); }
.simulator-item-row input, .simulator-item-row select { min-width: 0; width: 100%; }
.simulator-item-row__signed { display: flex !important; align-items: center; gap: 4px; white-space: nowrap; }
.simulator-item-row__signed input { width: auto; }
.simulator-item-row__signed span { font-size: var(--font-size-small); }
.simulator-meter > .text-button { margin: 8px 12px; }
.simulator-meter .icon-button.danger { color: var(--danger); }
.dlt645-simulator__frames { overflow: hidden; }
@media (max-width: 900px) {
  .dlt645-simulator__header { align-items: flex-start; flex-direction: column; }
  .dlt645-simulator__summary { flex-wrap: wrap; }
  .simulator-data-row { grid-template-columns: minmax(0, 1fr) 90px; }
  .simulator-data-row label, .simulator-data-row__reads { grid-column: auto; }
  .simulator-item-row { grid-template-columns: 24px minmax(130px, 1fr) 92px minmax(90px, .7fr) 54px 54px 34px; }
  .simulator-item-row > :nth-child(3), .simulator-item-row > :nth-child(6), .simulator-item-row > :nth-child(9) { display: none !important; }
}
@media (max-width: 700px) {
  .dlt645-simulator__tabs { overflow-x: auto; }
  .dlt645-simulator__tabs button { flex: 0 0 auto; }
  .dlt645-simulator__body { padding: 10px; }
  .simulator-data-group__header { align-items: flex-start; flex-direction: column; gap: 6px; }
  .simulator-data-group__identity { width: 100%; grid-template-columns: minmax(0, 1fr) auto; }
  .simulator-data-group__error { grid-column: 1 / -1; }
  .simulator-data-group__meta { width: 100%; justify-content: space-between; }
  .simulator-data-row { grid-template-columns: 1fr; gap: 7px; }
  .simulator-meter > header { grid-template-columns: minmax(0, 1fr) auto 34px; }
  .simulator-meter > header > label:first-child { grid-column: 1 / -1; }
  .simulator-meter > header > label:nth-child(2) { grid-column: 1; }
  .simulator-item-row { grid-template-columns: 24px minmax(0, 1fr) 90px 34px; }
  .simulator-item-row > :nth-child(3), .simulator-item-row > :nth-child(4), .simulator-item-row > :nth-child(6), .simulator-item-row > :nth-child(7), .simulator-item-row > :nth-child(8), .simulator-item-row > :nth-child(9) { display: none !important; }
}
</style>
