<script setup>
import { formatTimestamp } from '../model/dateTime.js';
import {
  Activity, Copy, Database, Eraser, Pause, Play, RefreshCw, X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { createModalFocusTrap } from '../model/modalFocus.js';
import { describeModbusTransaction } from '../model/modbusCommands.js';
import {
  formatModbusBusinessValue,
  modbusDataPointRawBytes,
  normalizeModbusDataPoints,
  readModbusDataPoint,
  writeModbusDataPoint,
} from '../model/modbusDataPoints.js';
import { modbusDataOrderLabel } from '../model/modbusDataOrder.js';
import ModbusMasterPanel from './ModbusMasterPanel.vue';
import ModbusSimulationControls from './ModbusSimulationControls.vue';

const props = defineProps({
  endpoint: { type: Object, required: true },
  runtime: { type: Object, required: true },
  running: Boolean,
  sessionId: { type: String, default: null },
  scheduler: {
    type: Object,
    default: () => ({
      getStatus: () => ({ active: false, groups: {}, records: [] }),
      subscribe: () => () => {}, start: () => {}, stop: () => {},
      runGroup: async () => {}, executeImmediate: async () => {},
    }),
  },
  simulation: { type: Object, default: null },
  saveCommand: { type: Function, required: true },
  collectorStatus: { type: Object, default: null },
});

const AREAS = Object.freeze([
  ['coils', '线圈'], ['discreteInputs', '离散输入'],
  ['holdingRegisters', '保持寄存器'], ['inputRegisters', '输入寄存器'],
]);
const error = ref('');
const simulationActive = ref(false);
const transactions = ref([]);
const selectedPointId = ref(null);
const rawDrawerOpen = ref(false);
const rawDrawerRef = ref(null);
const commandsPaused = ref(false);
const dataMap = ref(null);
const mapLoading = ref(false);

const isMaster = computed(() => props.endpoint.transport.endsWith('-master'));
const wireFormatLabel = computed(() => (
  props.endpoint.transport.includes('-tcp-') ? 'ADU HEX · TCP 无 CRC' : 'ADU HEX · RTU CRC16'
));
const rawAreas = computed(() => AREAS.map(([key, label]) => {
  const area = dataMap.value?.areas?.[key];
  const start = area?.start ?? 0;
  const values = area?.values ?? [];
  return {
    key,
    label,
    start,
    count: area?.count ?? values.length,
    cells: values.map((value, index) => ({ address: start + index, value })),
  };
}));
const rawValueCount = computed(() => rawAreas.value
  .reduce((total, area) => total + area.cells.length, 0));
const businessPoints = computed(() => normalizeModbusDataPoints(props.endpoint.config.dataPoints)
  .map((point) => ({ ...point, reading: readModbusDataPoint(point, dataMap.value) })));
const businessGroups = computed(() => {
  const groups = new Map();
  for (const point of businessPoints.value) {
    const name = point.group?.trim() || '未分组';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(point);
  }
  return [...groups].map(([name, points]) => ({
    name,
    points,
    writableCount: points.filter(({ access }) => access !== 'read-only').length,
    areaCount: new Set(points.map(({ area }) => area)).size,
  }));
});
const selectedBusinessPoint = computed(() => businessPoints.value
  .find(({ id }) => id === selectedPointId.value) ?? businessPoints.value[0] ?? null);
const selectedPointCells = computed(() => {
  const point = selectedBusinessPoint.value;
  if (!point) return [];
  return Array.from({ length: point.length }, (_, index) => ({
    address: point.address + index,
    value: point.reading.raw[index],
  }));
});
const selectedPointBytes = computed(() => {
  const point = selectedBusinessPoint.value;
  return point ? modbusDataPointRawBytes(point, point.reading.raw) : [];
});
const commandRows = computed(() => transactions.value.map((transaction) => ({
  transaction,
  command: describeModbusTransaction({
    ...transaction,
    transport: transaction.transport ?? props.endpoint.transport,
  }, { capturedFramesOnly: true }),
})));

watch(() => props.endpoint.id, resetPanel);
watch(() => props.running, (running) => {
  if (running && !isMaster.value) void refreshMap();
}, { immediate: true });
watch(rawDrawerOpen, async (open, previous) => {
  if (open) {
    rawDrawerFocus.capture();
    await nextTick();
    rawDrawerFocus.activate('[aria-label="关闭完整数据区"]');
  } else if (previous) {
    rawDrawerFocus.restore();
  }
});

const rawDrawerFocus = createModalFocusTrap({
  container: () => rawDrawerRef.value,
  requestClose: closeRawDrawer,
});

const unsubscribe = isMaster.value ? null : props.runtime.modbus.onTransactions((transaction) => {
  if (transaction?.endpointId !== props.endpoint.id) return;
  recordTransaction(transaction);
  if (props.running) void refreshMap({ quiet: true });
});

function recordTransaction(transaction) {
  if (commandsPaused.value) return;
  transactions.value = [transaction, ...transactions.value].slice(0, 200);
}

async function copyCommand(hex) {
  await navigator.clipboard?.writeText(hex);
}

async function refreshMap({ quiet = false } = {}) {
  if (!props.running || isMaster.value || (mapLoading.value && !quiet)) return;
  if (!quiet) mapLoading.value = true;
  try {
    dataMap.value = await props.runtime.modbus.readMap(props.endpoint.id);
    error.value = '';
  } catch (reason) {
    if (!quiet) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (!quiet) mapLoading.value = false;
  }
}

async function updateAreaValue(area, address, event) {
  const bitArea = area === 'coils' || area === 'discreteInputs';
  const value = bitArea ? event.target.checked : Number(event.target.value);
  if (!bitArea && (!Number.isInteger(value) || value < 0 || value > 65_535)) {
    error.value = '寄存器值必须为 0 到 65535 的整数。';
    return;
  }
  try {
    dataMap.value = await props.runtime.modbus.writeMap({
      endpointId: props.endpoint.id,
      area,
      address,
      values: [value],
    });
    await persistMap();
    error.value = '';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
    await refreshMap({ quiet: true });
  }
}

async function updateBusinessPoint(point, event) {
  const businessValue = point.dataType === 'boolean' ? event.target.checked : event.target.value;
  try {
    const values = writeModbusDataPoint(point, businessValue);
    dataMap.value = await props.runtime.modbus.writeMap({
      endpointId: props.endpoint.id,
      area: point.area,
      address: point.address,
      values,
    });
    await persistMap();
    error.value = '';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
    await refreshMap({ quiet: true });
  }
}

async function persistMap() {
  if (!dataMap.value) return;
  const endpoint = {
    ...props.endpoint,
    config: {
      ...props.endpoint.config,
      dataAreas: Object.fromEntries(AREAS.map(([key]) => [key, {
        start: dataMap.value.areas[key].start,
        count: dataMap.value.areas[key].count,
        values: [...dataMap.value.areas[key].values],
      }])),
    },
  };
  const outcome = await props.saveCommand(endpoint);
  if (outcome?.ok === false) {
    throw outcome.error instanceof Error
      ? outcome.error
      : new Error(outcome.error?.message ?? '无法保存从站数据区。');
  }
}

function resetPanel() {
  transactions.value = [];
  dataMap.value = null;
  selectedPointId.value = null;
  rawDrawerOpen.value = false;
  error.value = '';
  if (!isMaster.value && props.running) void refreshMap();
}

function clearCommands() {
  transactions.value = [];
}

function selectBusinessPoint(point) {
  selectedPointId.value = point.id;
}

function openRawDrawer() {
  rawDrawerOpen.value = true;
}

function closeRawDrawer() {
  rawDrawerOpen.value = false;
}

function rawPointValue(reading) {
  if (!reading.available) return '—';
  return reading.raw.map((value) => (
    typeof value === 'boolean' ? (value ? '1' : '0') : `0x${value.toString(16).padStart(4, '0').toUpperCase()}`
  )).join(' ');
}

function pointTypeLabel(type) {
  return {
    boolean: '布尔', uint16: 'UInt16', int16: 'Int16', uint32: 'UInt32',
    int32: 'Int32', float32: 'Float32', float64: 'Float64', ascii: 'ASCII',
  }[type] ?? type;
}

function pointLengthLabel(point) {
  return point.dataType === 'boolean' ? '1 位' : `${point.length} 寄存器`;
}

function areaLabel(area) {
  return AREAS.find(([key]) => key === area)?.[1] ?? area;
}

function pointAddressLabel(point) {
  const start = displayAddress(point.area, point.address);
  const end = displayAddress(point.area, point.address + point.length - 1);
  return start === end ? String(start) : `${start}～${end}`;
}

function pointOrderLabel(point) {
  return point.dataType === 'boolean' ? '位值' : modbusDataOrderLabel(point);
}

function rawCellHex(value) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (!Number.isInteger(value)) return '—';
  return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
}

function rawCellValue(value) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return Number.isInteger(value) ? String(value) : '不可用';
}

function formatRawBytes(bytes) {
  return bytes.length ? bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ') : '不可用';
}

function displayAddress(area, address) {
  if (props.endpoint.config.addressNotation !== 'reference') return address;
  const base = { coils: 1, discreteInputs: 10001, inputRegisters: 30001, holdingRegisters: 40001 }[area];
  return base + address;
}

onBeforeUnmount(() => {
  unsubscribe?.();
  rawDrawerFocus.restore();
});
</script>

<template>
  <section
    class="modbus-panel"
    :class="[
      isMaster ? 'modbus-panel--master' : 'modbus-panel--slave',
      { 'modbus-panel--empty-transactions': !isMaster && transactions.length === 0 },
    ]"
  >
    <ModbusMasterPanel
      v-if="isMaster"
      :endpoint="endpoint"
      :runtime="runtime"
      :running="running"
      :session-id="sessionId"
      :scheduler="scheduler"
      :save-command="saveCommand"
      :collector-status="collectorStatus"
    />
    <template v-if="!isMaster">
      <div class="modbus-map-toolbar">
        <div class="modbus-map-toolbar__title">
          <strong>业务数据</strong>
          <span>{{ businessGroups.length }} 个分组 · {{ businessPoints.length }} 个数据点</span>
          <span
            class="modbus-map-toolbar__error"
            :title="error"
            role="alert"
          >{{ error }}</span>
        </div>
        <div class="modbus-map-toolbar__actions">
          <ModbusSimulationControls
            v-if="simulation"
            :endpoint="endpoint"
            :manager="simulation"
            :running="running"
            :session-id="sessionId"
            @active-change="simulationActive = $event"
          />
          <button
            type="button"
            class="command-button modbus-raw-drawer-trigger"
            title="查看完整原始数据区"
            aria-label="查看完整数据区"
            @click="openRawDrawer"
          >
            <Database :size="14" />
            <span>完整数据区</span>
          </button>
          <button
            type="button"
            class="icon-button"
            title="刷新数据区"
            aria-label="刷新数据区"
            :disabled="!running || mapLoading"
            @click="refreshMap()"
          >
            <RefreshCw
              :size="15"
              :class="{ spin: mapLoading }"
            />
          </button>
        </div>
      </div>
      <div class="modbus-business-workspace">
        <div class="modbus-business-groups modbus-result-table--business">
          <article
            v-for="group in businessGroups"
            :key="group.name"
            class="modbus-business-group"
          >
            <header class="modbus-business-group__header">
              <strong>{{ group.name }}</strong>
              <div>
                <span>{{ group.points.length }} 个数据点</span>
                <span>{{ group.areaCount }} 类数据区</span>
                <span>可写 {{ group.writableCount }}</span>
              </div>
            </header>
            <div class="modbus-result-table">
              <table>
                <thead><tr><th>业务名称</th><th>数据区与地址</th><th>类型</th><th>原始值</th><th>业务值</th></tr></thead>
                <tbody>
                  <tr
                    v-for="point in group.points"
                    :key="point.id"
                    class="modbus-business-row"
                    :class="{ selected: selectedBusinessPoint?.id === point.id }"
                    tabindex="0"
                    :aria-label="`查看 ${point.name} 的原始地址`"
                    @click="selectBusinessPoint(point)"
                    @keydown.enter.self="selectBusinessPoint(point)"
                    @keydown.space.self.prevent="selectBusinessPoint(point)"
                  >
                    <td><strong>{{ point.name }}</strong></td>
                    <td><span class="modbus-business-address">{{ areaLabel(point.area) }}</span>{{ pointAddressLabel(point) }}</td>
                    <td>{{ pointTypeLabel(point.dataType) }} · {{ pointLengthLabel(point) }}</td>
                    <td>{{ rawPointValue(point.reading) }}</td>
                    <td>
                      <label class="modbus-business-value">
                        <input
                          v-if="point.dataType === 'boolean'"
                          type="checkbox"
                          :checked="point.reading.value"
                          :disabled="simulationActive || !running || !point.reading.available || point.access === 'read-only'"
                          @change="updateBusinessPoint(point, $event)"
                        >
                        <input
                          v-else
                          class="modbus-value-input"
                          :type="point.dataType === 'ascii' ? 'text' : 'number'"
                          :step="point.dataType.startsWith('float') || point.scale !== 1 ? 'any' : '1'"
                          :value="formatModbusBusinessValue(point, point.reading.value)"
                          :disabled="simulationActive || !running || !point.reading.available || point.access === 'read-only'"
                          @change="updateBusinessPoint(point, $event)"
                        >
                        <span v-if="point.unit">{{ point.unit }}</span>
                      </label>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </article>
          <p
            v-if="businessGroups.length === 0"
            class="table-empty modbus-business-groups__empty"
          >
            请在端点设置中添加业务数据点
          </p>
        </div>
        <section
          v-if="selectedBusinessPoint"
          class="modbus-point-context"
          aria-label="业务数据原始地址"
        >
          <header>
            <div>
              <strong>{{ selectedBusinessPoint.name }}</strong>
              <span>{{ selectedBusinessPoint.group }}</span>
            </div>
            <div class="modbus-point-context__meta">
              <span>{{ areaLabel(selectedBusinessPoint.area) }}</span>
              <span>地址 {{ pointAddressLabel(selectedBusinessPoint) }}</span>
              <span>{{ pointTypeLabel(selectedBusinessPoint.dataType) }}</span>
              <span>{{ pointOrderLabel(selectedBusinessPoint) }}</span>
            </div>
          </header>
          <div class="modbus-point-context__values">
            <div
              v-for="cell in selectedPointCells"
              :key="cell.address"
              class="modbus-point-context__cell"
            >
              <small>地址 {{ displayAddress(selectedBusinessPoint.area, cell.address) }}</small>
              <code>{{ rawCellHex(cell.value) }}</code>
              <span>{{ rawCellValue(cell.value) }}</span>
            </div>
            <div class="modbus-point-context__cell modbus-point-context__cell--wide">
              <small>组合原始字节</small>
              <code>{{ formatRawBytes(selectedPointBytes) }}</code>
            </div>
            <div class="modbus-point-context__cell modbus-point-context__cell--result">
              <small>解析结果</small>
              <strong>{{ formatModbusBusinessValue(selectedBusinessPoint, selectedBusinessPoint.reading.value) }}</strong>
              <span v-if="selectedBusinessPoint.unit">{{ selectedBusinessPoint.unit }}</span>
            </div>
          </div>
        </section>
      </div>

      <div
        v-if="rawDrawerOpen"
        class="modbus-raw-drawer-backdrop"
        @mousedown.self="closeRawDrawer"
      >
        <aside
          ref="rawDrawerRef"
          class="modbus-raw-drawer"
          role="dialog"
          aria-label="完整原始数据区"
          @keydown.esc="closeRawDrawer"
        >
          <header>
            <div>
              <strong>完整原始数据区</strong>
              <span>4 类数据 · {{ rawValueCount }} 项</span>
            </div>
            <button
              type="button"
              class="icon-button"
              title="关闭"
              aria-label="关闭完整数据区"
              @click="closeRawDrawer"
            >
              <X :size="16" />
            </button>
          </header>
          <div class="modbus-raw-drawer__toolbar">
            <div class="modbus-raw-summary">
              <span
                v-for="area in rawAreas"
                :key="area.key"
              >
                <strong>{{ area.label }}</strong>
                {{ area.cells.length }}
              </span>
            </div>
            <button
              type="button"
              class="icon-button"
              title="刷新数据区"
              aria-label="刷新完整数据区"
              :disabled="!running || mapLoading"
              @click="refreshMap()"
            >
              <RefreshCw
                :size="15"
                :class="{ spin: mapLoading }"
              />
            </button>
          </div>
          <div
            class="modbus-raw-matrix"
            aria-label="四类原始数据"
          >
            <section
              v-for="area in rawAreas"
              :key="area.key"
              class="modbus-raw-area"
              role="region"
              :aria-label="`${area.label}原始数据`"
            >
              <header>
                <div>
                  <strong>{{ area.label }}</strong>
                  <span>{{ area.cells.length }} 项</span>
                </div>
                <code v-if="area.cells.length">
                  {{ displayAddress(area.key, area.start) }}～{{ displayAddress(area.key, area.cells.at(-1).address) }}
                </code>
              </header>
              <div
                v-if="area.cells.length"
                class="modbus-raw-area__grid"
              >
                <div
                  v-for="cell in area.cells"
                  :key="cell.address"
                  class="modbus-raw-cell"
                >
                  <small>{{ displayAddress(area.key, cell.address) }}</small>
                  <code>{{ rawCellHex(cell.value) }}</code>
                  <input
                    v-if="area.key === 'coils' || area.key === 'discreteInputs'"
                    type="checkbox"
                    :aria-label="`${area.label} 地址 ${displayAddress(area.key, cell.address)}`"
                    :checked="cell.value"
                    :disabled="simulationActive"
                    @change="updateAreaValue(area.key, cell.address, $event)"
                  >
                  <input
                    v-else
                    class="modbus-value-input"
                    :disabled="simulationActive"
                    type="number"
                    min="0"
                    max="65535"
                    :aria-label="`${area.label} 地址 ${displayAddress(area.key, cell.address)}`"
                    :value="cell.value"
                    @change="updateAreaValue(area.key, cell.address, $event)"
                  >
                </div>
              </div>
              <p
                v-else
                class="table-empty"
              >
                {{ running ? '正在读取数据区...' : '打开从站后显示数据区' }}
              </p>
            </section>
          </div>
        </aside>
      </div>
    </template>

    <aside
      v-if="!isMaster"
      class="modbus-transactions"
    >
      <header>
        <Activity :size="15" />
        <strong>指令监视器</strong>
        <span>{{ transactions.length }}</span>
        <span class="modbus-transactions__hint">{{ wireFormatLabel }}</span>
        <button
          type="button"
          class="icon-button"
          :title="commandsPaused ? '继续接收指令' : '暂停指令显示'"
          :aria-label="commandsPaused ? '继续接收指令' : '暂停指令显示'"
          @click="commandsPaused = !commandsPaused"
        >
          <Play
            v-if="commandsPaused"
            :size="14"
          />
          <Pause
            v-else
            :size="14"
          />
        </button>
        <button
          type="button"
          class="icon-button"
          title="清空指令"
          aria-label="清空指令"
          @click="clearCommands"
        >
          <Eraser :size="14" />
        </button>
      </header>
      <div class="modbus-transactions__list">
        <article
          v-for="({ transaction, command }, index) in commandRows"
          :key="`${transaction.createdAt}-${transaction.functionCode}-${transaction.address}-${index}`"
          :class="{ failed: !transaction.success }"
        >
          <div class="modbus-command__summary">
            <time>{{ formatTimestamp(transaction.createdAt) }}</time>
            <strong>{{ command.functionLabel }}</strong>
            <span>{{ command.requestText }}</span>
            <span>{{ command.responseText }}</span>
          </div>
          <div
            v-if="command.requestHex"
            class="modbus-command__wire"
          >
            <b>{{ transaction.origin === 'slave' ? 'RX' : 'TX' }}</b>
            <div class="modbus-command__frame">
              <div class="modbus-command__hex">
                <code>{{ command.requestHex }}</code>
                <button
                  type="button"
                  class="icon-button"
                  title="复制完整接收帧"
                  aria-label="复制完整接收帧"
                  @click="copyCommand(command.requestHex)"
                >
                  <Copy :size="12" />
                </button>
              </div>
              <div
                v-if="command.requestSegments.length"
                class="modbus-frame-segments"
              >
                <span
                  v-for="segment in command.requestSegments"
                  :key="segment.key"
                  class="modbus-frame-segment"
                ><small>{{ segment.label }}</small><code>{{ segment.hex }}</code></span>
              </div>
            </div>
          </div>
          <div
            v-if="command.responseHex"
            class="modbus-command__wire"
          >
            <b>{{ transaction.origin === 'slave' ? 'TX' : 'RX' }}</b>
            <div class="modbus-command__frame">
              <div class="modbus-command__hex">
                <code>{{ command.responseHex }}</code>
                <button
                  type="button"
                  class="icon-button"
                  title="复制完整发送帧"
                  aria-label="复制完整发送帧"
                  @click="copyCommand(command.responseHex)"
                >
                  <Copy :size="12" />
                </button>
              </div>
              <div
                v-if="command.responseSegments.length"
                class="modbus-frame-segments"
              >
                <span
                  v-for="segment in command.responseSegments"
                  :key="segment.key"
                  class="modbus-frame-segment"
                ><small>{{ segment.label }}</small><code>{{ segment.hex }}</code></span>
              </div>
            </div>
          </div>
          <p
            v-if="command.requestFrameUnavailable"
            class="modbus-command__unavailable"
          >
            {{ transaction.origin === 'slave' ? 'RX' : 'TX' }} 完整帧不可用
          </p>
          <p
            v-if="command.responseFrameUnavailable"
            class="modbus-command__unavailable"
          >
            {{ transaction.origin === 'slave' ? 'TX' : 'RX' }} 完整帧不可用
          </p>
        </article>
        <p
          v-if="transactions.length === 0"
          class="table-empty"
        >
          尚无 Modbus 指令
        </p>
      </div>
    </aside>
  </section>
</template>
