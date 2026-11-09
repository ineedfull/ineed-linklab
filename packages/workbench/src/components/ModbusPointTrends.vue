<script setup>
import { formatTimestamp as formatTime } from '../model/dateTime.js';
import { formatClockTime } from '../model/dateTime.js';
import {
  AlertTriangle, BarChart3, ChevronLeft, ChevronRight, Download,
  RefreshCw, Trash2,
} from 'lucide-vue-next';
import {
  computed, nextTick, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';

import { createModbusPointTrendsController } from '../model/modbusPointTrends.js';

const props = defineProps({
  endpoint: { type: Object, required: true },
  runtime: { type: Object, required: true },
  config: { type: Object, required: true },
  collectorStatus: { type: Object, default: null },
});

const QUALITY_LABELS = Object.freeze({
  good: '正常',
  'bad-communication': '通信异常',
  'bad-value': '非法值',
  'uncertain-overflow': '超出合理范围',
  disabled: '已停用',
});
const RANGE_PRESETS = Object.freeze([
  ['1-hour', '1 小时'], ['24-hours', '24 小时'],
  ['7-days', '7 天'], ['30-days', '30 天'],
]);
const CHART_COLORS = Object.freeze([
  '#177c63', '#2878b5', '#bf6a22', '#9b4d83', '#547a31', '#b04a4a',
]);

let controller = createModbusPointTrendsController(
  props.runtime,
  props.endpoint,
  props.config,
);
const catalog = ref([...controller.points]);
const chartElement = ref(null);
const clearConfirmationOpen = ref(false);
const actionMessage = ref('');
const actionError = ref('');
const customFrom = ref(toDateTimeInput(controller.state.from));
const customTo = ref(toDateTimeInput(controller.state.to));
let chart = null;
let resizeObserver = null;
let typographyObserver = null;
let resizeTimer = null;
let chartWidth = 0;
let chartLoading = false;
let unmounted = false;

const state = ref(structuredClone(controller.state));
let unsubscribeController = subscribeController(controller);
const groupedPoints = computed(() => groupCatalog(catalog.value));
const selectedKeys = computed(() => new Set(state.value.selected.map(identityKey)));
const stringSeries = computed(() => state.value.series.filter(({ kind }) => kind === 'string'));
const chartSeries = computed(() => state.value.series.filter(({ kind }) => kind !== 'string'));
const totalPages = computed(() => Math.max(1, Math.ceil(state.value.rowsTotal / state.value.pageSize)));
const collectorHasWarning = computed(() => (
  (props.collectorStatus?.droppedCount ?? 0) > 0
  || (props.collectorStatus?.failedBatchCount ?? 0) > 0
));

onMounted(async () => {
  await nextTick();
  if (unmounted) return;
  observeChartSize();
  typographyObserver = new MutationObserver(renderChart);
  typographyObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  await controller.load();
});

watch(() => props.config, rebuildController, { deep: true });

onBeforeUnmount(() => {
  unmounted = true;
  unsubscribeController();
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeObserver?.disconnect();
  typographyObserver?.disconnect();
  chart?.dispose();
  chart = null;
  controller.dispose();
});

function subscribeController(target) {
  return target.subscribe((nextState) => {
    state.value = structuredClone(nextState);
    void nextTick(renderChart);
  });
}

function rebuildController() {
  if (unmounted) return;
  const previous = structuredClone(controller.state);
  clearConfirmationOpen.value = false;
  unsubscribeController();
  controller.dispose();

  controller = createModbusPointTrendsController(
    props.runtime,
    props.endpoint,
    props.config,
  );
  const availableKeys = new Set(controller.points.map(({ identity }) => identityKey(identity)));
  controller.state.selected = previous.selected
    .filter((identity) => availableKeys.has(identityKey(identity)));
  controller.state.preset = previous.preset;
  controller.state.from = previous.from;
  controller.state.to = previous.to;
  controller.state.chartWidth = previous.chartWidth;
  controller.state.pageSize = previous.pageSize;

  catalog.value = [...controller.points];
  state.value = structuredClone(controller.state);
  unsubscribeController = subscribeController(controller);
  void controller.load();
}

function groupCatalog(points) {
  const groups = [];
  for (const point of points) {
    let group = groups.find(({ id }) => id === point.groupId);
    if (!group) {
      group = { id: point.groupId, name: point.groupName, requests: [] };
      groups.push(group);
    }
    let request = group.requests.find(({ id }) => id === point.requestId);
    if (!request) {
      request = { id: point.requestId, name: point.requestName, points: [] };
      group.requests.push(request);
    }
    request.points.push(point);
  }
  return groups;
}

async function togglePoint(point, event) {
  actionMessage.value = '';
  controller.selectPoint(point.identity, event.target.checked);
  if (controller.state.selectionError) return;
  await controller.load();
}

async function applyPreset(preset) {
  actionMessage.value = '';
  actionError.value = '';
  try {
    await controller.setPreset(preset);
    customFrom.value = toDateTimeInput(controller.state.from);
    customTo.value = toDateTimeInput(controller.state.to);
  } catch (error) {
    actionError.value = errorMessage(error);
  }
}

async function applyCustomRange() {
  actionMessage.value = '';
  actionError.value = '';
  try {
    const from = fromDateTimeInput(customFrom.value);
    const to = fromDateTimeInput(customTo.value);
    await controller.setCustomRange(from, to);
  } catch (error) {
    actionError.value = errorMessage(error);
  }
}

async function retry() {
  actionError.value = '';
  await controller.load();
}

async function changePage(page) {
  if (page < 1 || page > totalPages.value) return;
  await controller.loadRows(page, state.value.pageSize).catch(() => {});
}

async function exportCsv() {
  actionMessage.value = '';
  actionError.value = '';
  try {
    const result = await controller.exportCsv();
    if (!result?.canceled) actionMessage.value = `已导出到 ${result?.path ?? '所选文件'}`;
  } catch (error) {
    actionError.value = errorMessage(error);
  }
}

async function clearHistory() {
  actionMessage.value = '';
  actionError.value = '';
  try {
    const result = await controller.clear();
    const deletedCount = typeof result === 'number' ? result : (result?.deletedCount ?? 0);
    actionMessage.value = `已清除 ${deletedCount} 条历史数据`;
    clearConfirmationOpen.value = false;
  } catch (error) {
    actionError.value = errorMessage(error);
  }
}

function observeChartSize() {
  if (!chartElement.value || resizeObserver) return;
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect?.width ?? chartElement.value?.clientWidth ?? 0;
    const height = entries[0]?.contentRect?.height ?? chartElement.value?.clientHeight ?? 0;
    if (initializeChart(width, height)) return;
    if (!chart || !(width > 0) || !(height > 0)) return;
    chart.resize();
    if (Math.round(width) === Math.round(chartWidth)) return;
    chartWidth = width;
    controller.setChartWidth(width);
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      void controller.refresh().catch(() => {});
    }, 180);
  });
  resizeObserver.observe(chartElement.value);
  const bounds = chartElement.value.getBoundingClientRect();
  initializeChart(bounds.width, bounds.height);
}

function initializeChart(width, height) {
  if (!chartElement.value || chart || chartLoading || !(width > 0) || !(height > 0)) return false;
  chartWidth = width;
  controller.setChartWidth(width);
  chartLoading = true;
  void import('../model/trendChart.js').then((echarts) => {
    chartLoading = false;
    if (unmounted || !chartElement.value || chart) return;
    chart = echarts.init(chartElement.value);
    renderChart();
  }).catch((error) => {
    chartLoading = false;
    if (!unmounted) actionError.value = `图表加载失败：${errorMessage(error)}`;
  });
  return true;
}

function renderChart() {
  if (!chart) return;
  chart.setOption(buildChartOption(chartSeries.value), true);
}

function buildChartOption(seriesValues) {
  const style = getComputedStyle(chartElement.value);
  const color = name => style.getPropertyValue(name).trim();
  const textStyle = {
    fontFamily: style.fontFamily,
    fontSize: Number.parseFloat(style.getPropertyValue('--font-size-control')) || 12,
    color: color('--text'),
  };
  const axisTextStyle = { ...textStyle, color: color('--text-muted') };
  const axisLine = { lineStyle: { color: color('--line') } };
  const groups = [];
  for (const series of seriesValues) {
    const unit = series.unit ?? '';
    let group = groups.find((item) => item.unit === unit);
    if (!group) {
      group = { unit, series: [] };
      groups.push(group);
    }
    group.series.push(series);
  }
  const gridHeight = groups.length ? 150 : 180;
  const gap = 44;
  const grids = groups.map((_, index) => ({
    left: 54, right: 22, top: 20 + (index * (gridHeight + gap)), height: gridHeight,
    containLabel: false,
  }));
  const xAxes = groups.map((_, index) => ({
    type: 'time', gridIndex: index,
    axisLabel: { ...axisTextStyle, hideOverlap: true, formatter: formatClockTime },
    axisPointer: { label: { formatter: ({ value }) => formatTime(value) } },
    axisLine, axisTick: axisLine,
  }));
  const yAxes = groups.map((group, index) => ({
    type: 'value', gridIndex: index,
    name: group.unit || '无单位',
    nameLocation: 'end',
    nameTextStyle: axisTextStyle,
    axisLine, axisTick: axisLine,
    splitLine: { lineStyle: { color: color('--line-soft') } },
    minInterval: group.series.every(({ kind }) => kind === 'boolean') ? 1 : undefined,
    axisLabel: { ...axisTextStyle, ...(group.series.every(({ kind }) => kind === 'boolean')
      ? { formatter: (value) => value === 1 ? 'ON' : value === 0 ? 'OFF' : '' }
      : {}) },
  }));
  const series = groups.flatMap((group, groupIndex) => group.series.map((value, seriesIndex) => ({
    id: identityKey(value),
    name: value.pointName,
    type: 'line',
    step: value.kind === 'boolean' ? 'end' : false,
    showSymbol: value.kind === 'boolean',
    symbolSize: 6,
    connectNulls: false,
    sampling: value.kind === 'numeric' ? 'lttb' : undefined,
    xAxisIndex: groupIndex,
    yAxisIndex: groupIndex,
    itemStyle: { color: CHART_COLORS[(groupIndex + seriesIndex) % CHART_COLORS.length] },
    lineStyle: { width: 1.5 },
    data: chartData(value),
    markPoint: qualityMarkers(value),
  })));
  const axisIndexes = groups.map((_, index) => index);
  return {
    animation: false,
    textStyle,
    color: CHART_COLORS,
    aria: { enabled: true, decal: { show: true } },
    legend: { top: 0, right: 20, type: 'scroll', textStyle },
    tooltip: { trigger: 'axis', formatter: trendTooltip,
      axisPointer: { type: 'cross', label: { ...textStyle, backgroundColor: color('--surface') } }, textStyle,
      backgroundColor: color('--surface'), borderColor: color('--line') },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    dataZoom: groups.length ? [
      { type: 'inside', xAxisIndex: axisIndexes, filterMode: 'none' },
      { type: 'slider', xAxisIndex: axisIndexes, filterMode: 'none', bottom: 2, height: 18,
        labelFormatter: formatTime,
        textStyle: axisTextStyle, borderColor: color('--line'), backgroundColor: color('--surface') },
    ] : [],
    series,
  };
}

function chartData(series) {
  if (series.kind === 'boolean') {
    return series.samples.map((sample) => [sample.createdAt, sample.value ? 1 : 0]);
  }
  const samples = [];
  for (const bucket of series.samples) {
    for (const [createdAt, value] of [
      [bucket.firstAt, bucket.firstValue], [bucket.minAt, bucket.minValue],
      [bucket.maxAt, bucket.maxValue], [bucket.lastAt, bucket.lastValue],
    ]) {
      if (createdAt !== null && value !== null) samples.push([createdAt, value]);
    }
  }
  const seen = new Set();
  return samples
    .sort((left, right) => left[0] - right[0])
    .filter(([createdAt, value]) => {
      const key = `${createdAt}:${value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function trendTooltip(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return [formatTime(rows[0].axisValue), ...rows.map(row => (
    `${escapeHtml(row.seriesName)}: ${escapeHtml(row.value?.[1] ?? '--')}`
  ))].join('<br>');
}

function qualityMarkers(series) {
  const data = [];
  if (series.kind === 'numeric') {
    for (const sample of series.samples) {
      if (!sample.marker) continue;
      data.push({
        coord: [sample.marker.createdAt, sample.lastValue ?? sample.firstValue ?? 0],
        value: QUALITY_LABELS[sample.marker.quality] ?? sample.marker.quality,
        reason: sample.marker.reason,
      });
    }
  } else {
    for (const sample of series.samples) {
      if (sample.quality === 'good') continue;
      data.push({
        coord: [sample.createdAt, sample.value ? 1 : 0],
        value: QUALITY_LABELS[sample.quality] ?? sample.quality,
        reason: sample.reason,
      });
    }
  }
  return data.length ? {
    symbol: 'diamond', symbolSize: 10,
    itemStyle: { color: '#b64646' },
    tooltip: {
      formatter: ({ data: item }) => (
        `${escapeHtml(item.value)}${item.reason ? `<br>${escapeHtml(item.reason)}` : ''}`
      ),
    },
    data,
  } : undefined;
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

function identityKey(value) {
  return JSON.stringify([value.requestGroupId, value.requestId, value.pointId]);
}

function qualityLabel(value) {
  return QUALITY_LABELS[value] ?? value ?? '—';
}

function formatSummaryValue(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value);
}



function formatRaw(raw) {
  if (!Array.isArray(raw)) return raw === undefined || raw === null ? '—' : String(raw);
  if (raw.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)) {
    return raw.flatMap((value) => [value >> 8, value & 0xff])
      .map((value) => value.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }
  return JSON.stringify(raw);
}

function toDateTimeInput(timestamp) {
  if (!Number.isSafeInteger(timestamp)) return '';
  const date = new Date(timestamp - (new Date(timestamp).getTimezoneOffset() * 60_000));
  return date.toISOString().slice(0, 16);
}

function fromDateTimeInput(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('请选择有效的时间范围。');
  return timestamp;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section
    class="modbus-trends"
    aria-label="Modbus 数据趋势"
  >
    <aside class="modbus-trends-selector">
      <header>
        <div><strong>数据点</strong><span>{{ state.selected.length }} / 6 已选择</span></div>
      </header>
      <div
        class="modbus-trends-tree"
        aria-label="历史数据点选择"
      >
        <section
          v-for="group in groupedPoints"
          :key="group.id"
          class="modbus-trends-group"
        >
          <strong>{{ group.name }}</strong>
          <section
            v-for="request in group.requests"
            :key="request.id"
            class="modbus-trends-request"
          >
            <span>{{ request.name }}</span>
            <label
              v-for="point in request.points"
              :key="point.id"
              class="modbus-trends-point"
            >
              <input
                type="checkbox"
                :checked="selectedKeys.has(identityKey(point.identity))"
                :aria-label="`选择数据点 ${point.pointName}`"
                @change="togglePoint(point, $event)"
              >
              <span><strong>{{ point.pointName }}</strong><small>{{ point.pointKey }}<template v-if="point.unit"> · {{ point.unit }}</template></small></span>
            </label>
          </section>
        </section>
      </div>
      <p
        v-if="state.selectionError"
        class="field-error"
        role="alert"
      >
        {{ state.selectionError }}
      </p>
    </aside>

    <main class="modbus-trends-analysis">
      <header class="modbus-trends-toolbar">
        <div
          class="segmented-control"
          role="group"
          aria-label="趋势时间范围"
        >
          <button
            v-for="[key, label] in RANGE_PRESETS"
            :key="key"
            type="button"
            :class="{ active: state.preset === key }"
            :aria-label="`最近 ${label}`"
            @click="applyPreset(key)"
          >
            {{ label }}
          </button>
        </div>
        <form
          class="modbus-trends-custom-range"
          aria-label="自定义趋势范围"
          @submit.prevent="applyCustomRange"
        >
          <input
            v-model="customFrom"
            type="datetime-local"
            aria-label="趋势开始时间"
          >
          <span>至</span>
          <input
            v-model="customTo"
            type="datetime-local"
            aria-label="趋势结束时间"
          >
          <button
            type="submit"
            class="command-button command-button--quiet"
          >
            应用
          </button>
        </form>
        <div class="modbus-trends-actions">
          <button
            type="button"
            class="icon-button"
            aria-label="刷新趋势数据"
            title="刷新"
            @click="retry"
          >
            <RefreshCw :size="15" />
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="导出当前趋势数据 CSV"
            title="导出 CSV"
            :disabled="state.selected.length === 0"
            @click="exportCsv"
          >
            <Download :size="15" />
          </button>
          <button
            type="button"
            class="icon-button danger"
            aria-label="清除当前趋势数据"
            title="清除历史"
            :disabled="state.selected.length === 0"
            @click="clearConfirmationOpen = true"
          >
            <Trash2 :size="15" />
          </button>
        </div>
      </header>

      <div
        class="modbus-trends-collector-status"
        :class="{ warning: collectorHasWarning }"
      >
        <AlertTriangle
          v-if="collectorHasWarning"
          :size="14"
          aria-hidden="true"
        />
        <span>待写入 {{ collectorStatus?.pendingCount ?? 0 }} 条</span>
        <span v-if="(collectorStatus?.droppedCount ?? 0) > 0">丢弃 {{ collectorStatus.droppedCount }} 条</span>
        <span v-if="(collectorStatus?.failedBatchCount ?? 0) > 0">失败批次 {{ collectorStatus.failedBatchCount }}</span>
        <span v-if="collectorStatus?.lastError">{{ collectorStatus.lastError }}</span>
      </div>

      <p
        v-if="actionError"
        class="modbus-trends-message error"
        role="alert"
      >
        {{ actionError }}
      </p>
      <p
        v-if="state.seriesError"
        class="modbus-trends-message error"
        role="alert"
      >
        {{ state.seriesError }}
        <button
          type="button"
          class="command-button command-button--quiet"
          aria-label="重试趋势查询"
          @click="retry"
        >
          重试
        </button>
      </p>
      <p
        v-else-if="actionMessage"
        class="modbus-trends-message success"
        role="status"
      >
        {{ actionMessage }}
      </p>

      <section
        class="modbus-trends-visual"
        aria-label="趋势图表区"
      >
        <div
          v-if="state.seriesLoading"
          class="modbus-trends-state"
        >
          正在查询历史趋势...
        </div>
        <div
          v-else-if="state.selected.length === 0"
          class="modbus-trends-state"
        >
          <BarChart3
            :size="22"
            aria-hidden="true"
          />
          <span>请从左侧选择需要比较的数据点</span>
        </div>
        <div
          v-else-if="state.series.length === 0 && !state.seriesError"
          class="modbus-trends-state"
        >
          <BarChart3
            :size="22"
            aria-hidden="true"
          />
          <span>所选时间范围内暂无历史数据</span>
        </div>
        <div
          ref="chartElement"
          class="modbus-trends-chart"
          :class="{ empty: chartSeries.length === 0 }"
          :style="{ height: `${Math.max(220, new Set(chartSeries.map(({ unit }) => unit ?? '')).size * 194)}px` }"
          aria-label="数值与状态趋势图"
        />

        <section
          v-if="stringSeries.length"
          class="modbus-trends-events"
          aria-label="字符串事件时间线"
        >
          <header><strong>文本事件</strong><span>{{ stringSeries.length }} 个数据点</span></header>
          <div>
            <article
              v-for="series in stringSeries"
              :key="identityKey(series)"
            >
              <strong>{{ series.pointName }}</strong>
              <ol>
                <li
                  v-for="sample in series.samples"
                  :key="`${sample.createdAt}:${sample.displayValue}`"
                >
                  <time>{{ formatTime(sample.createdAt) }}</time>
                  <span>{{ sample.displayValue }}</span>
                  <span
                    class="quality-badge"
                    :class="`quality-badge--${sample.quality}`"
                    :title="sample.reason ?? ''"
                  >{{ qualityLabel(sample.quality) }}</span>
                </li>
              </ol>
            </article>
          </div>
        </section>
      </section>

      <section
        class="modbus-trends-summary"
        aria-label="趋势摘要"
      >
        <header><strong>数据摘要</strong><span>{{ state.series.length }} 个数据点</span></header>
        <div class="modbus-result-table">
          <table>
            <thead><tr><th>数据点</th><th>最新值</th><th>最小值</th><th>最大值</th><th>变化</th><th>质量</th></tr></thead>
            <tbody>
              <tr
                v-for="series in state.series"
                :key="identityKey(series)"
              >
                <td><strong>{{ series.pointName }}</strong><small>{{ series.pointKey }}</small></td>
                <td>
                  {{ formatSummaryValue(series.summary.lastDisplayValue) }}<template v-if="series.unit">
                    {{ series.unit }}
                  </template>
                </td>
                <td>{{ formatSummaryValue(series.summary.minimum) }}</td>
                <td>{{ formatSummaryValue(series.summary.maximum) }}</td>
                <td>{{ series.summary.changeCount ?? 0 }} 次变化 · {{ series.summary.abnormalCount ?? 0 }} 次异常</td>
                <td>
                  <span
                    class="quality-badge"
                    :class="`quality-badge--${series.summary.latestQuality}`"
                    :title="series.samples.find((sample) => sample.marker)?.marker?.reason ?? ''"
                  >{{ qualityLabel(series.summary.latestQuality) }}</span>
                </td>
              </tr>
              <tr v-if="state.series.length === 0">
                <td
                  colspan="6"
                  class="table-empty"
                >
                  暂无摘要数据
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        class="modbus-trends-detail"
        aria-label="趋势历史明细"
      >
        <header><strong>历史明细</strong><span>共 {{ state.rowsTotal }} 条</span></header>
        <p
          v-if="state.rowsError"
          class="modbus-trends-message error"
          role="alert"
        >
          {{ state.rowsError }}
        </p>
        <div class="modbus-result-table">
          <table>
            <thead><tr><th>时间</th><th>数据点</th><th>原始值</th><th>工程值</th><th>质量</th><th>原因</th></tr></thead>
            <tbody>
              <tr
                v-for="row in state.rows"
                :key="row.id"
              >
                <td>{{ formatTime(row.createdAt) }}</td><td><strong>{{ row.pointName }}</strong><small>{{ row.pointKey }}</small></td>
                <td><code>{{ formatRaw(row.raw) }}</code></td><td>
                  {{ row.displayValue }}<template v-if="row.unit">
                    {{ row.unit }}
                  </template>
                </td>
                <td>
                  <span
                    class="quality-badge"
                    :class="`quality-badge--${row.quality}`"
                    :title="row.reason ?? ''"
                  >{{ qualityLabel(row.quality) }}</span>
                </td><td>{{ row.reason ?? '—' }}</td>
              </tr>
              <tr v-if="state.rows.length === 0">
                <td
                  colspan="6"
                  class="table-empty"
                >
                  暂无历史明细
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer class="modbus-trends-pagination">
          <button
            type="button"
            class="icon-button"
            aria-label="上一页历史明细"
            :disabled="state.page <= 1"
            @click="changePage(state.page - 1)"
          >
            <ChevronLeft :size="14" />
          </button>
          <span>第 {{ state.page }} / {{ totalPages }} 页</span>
          <button
            type="button"
            class="icon-button"
            aria-label="下一页历史明细"
            :disabled="state.page >= totalPages"
            @click="changePage(state.page + 1)"
          >
            <ChevronRight :size="14" />
          </button>
        </footer>
      </section>
    </main>

    <div
      v-if="clearConfirmationOpen"
      class="modbus-trends-confirmation"
      role="alertdialog"
      aria-label="清除 Modbus 数据点历史确认"
    >
      <div>
        <strong>清除 {{ endpoint.name }} 的历史数据</strong>
        <span>将永久清除所选 {{ state.selected.length }} 个数据点在当前时间范围（{{ formatTime(state.from) }} 至 {{ formatTime(state.to) }}）内的数据。</span>
        <span>主站配置和数据点配置都会保留。</span>
      </div>
      <button
        type="button"
        class="command-button command-button--quiet"
        @click="clearConfirmationOpen = false"
      >
        取消
      </button>
      <button
        type="button"
        class="command-button command-button--danger"
        aria-label="确认清除当前趋势数据"
        @click="clearHistory"
      >
        确认清除
      </button>
    </div>
  </section>
</template>
