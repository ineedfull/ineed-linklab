<script setup>
import { formatRaw, formatTime, successRate } from '../../model/modbusMasterPresentation.js';
defineProps({
  liveGroups: { type: Array, required: true },
  pointAddressLabel: { type: Function, required: true },
});
const emit = defineEmits(['configure']);
const QUALITY_LABELS = Object.freeze({
  good: '正常', 'bad-communication': '通信异常', 'bad-value': '非法值',
  'uncertain-overflow': '超出合理范围', disabled: '已停用', waiting: '等待读取',
});
</script>

<template>
  <section
    class="modbus-master-live"
  >
    <div
      v-if="liveGroups.length"
      class="modbus-master-live-groups"
    >
      <article
        v-for="liveGroup in liveGroups"
        :key="liveGroup.group.id"
        class="modbus-master-live-group"
        :class="{ disabled: !liveGroup.group.enabled }"
      >
        <header class="modbus-master-live-group__header">
          <div class="modbus-master-live-group__identity">
            <strong>{{ liveGroup.group.name }}</strong>
            <span>从站地址 <code>{{ liveGroup.group.unitId }}</code></span>
            <span
              class="modbus-master-live-group__error"
              :title="liveGroup.lastError"
              aria-live="polite"
            >
              {{ liveGroup.lastError ? `通信异常：${liveGroup.lastError}` : '' }}
            </span>
          </div>
          <div class="modbus-master-live-group__summary">
            <span
              class="status-indicator"
              :class="liveGroup.group.enabled ? 'status-indicator--enabled' : 'status-indicator--disabled'"
            ><i />{{ liveGroup.group.enabled ? '已启用' : '已停用' }}</span>
            <span class="quality quality--good">正常 {{ liveGroup.goodCount }}</span>
            <span class="quality quality--bad">异常 {{ liveGroup.badCount }}</span>
            <span class="quality quality--unknown">等待 {{ liveGroup.waitingCount }}</span>
            <span v-if="liveGroup.disabledCount">停用 {{ liveGroup.disabledCount }}</span>
            <span>最近 {{ formatTime(liveGroup.lastUpdatedAt) }}</span>
          </div>
        </header>
        <div
          v-if="liveGroup.rows.length"
          class="modbus-result-table"
        >
          <table>
            <thead><tr><th>请求</th><th>数据点</th><th>地址</th><th>当前值</th><th>原始值</th><th>质量</th><th>最后成功</th><th>成功率</th></tr></thead>
            <tbody>
              <tr
                v-for="row in liveGroup.rows"
                :key="`${row.group.id}:${row.request.id}:${row.point.id}`"
              >
                <td>{{ row.request.name }}</td><td><strong>{{ row.point.name }}</strong><small>{{ row.point.key }}</small></td><td>{{ pointAddressLabel(row.request, row.point) }}</td>
                <td>
                  {{ row.reading.display }}<template v-if="row.point.unit">
                    {{ row.point.unit }}
                  </template>
                </td><td>{{ formatRaw(row.reading.raw) }}</td>
                <td>
                  <span
                    class="quality-badge"
                    :class="`quality-badge--${row.displayQuality}`"
                    :title="row.reading.reason ?? ''"
                  >{{ QUALITY_LABELS[row.displayQuality] ?? row.displayQuality }}</span>
                </td>
                <td>{{ formatTime(row.requestStatus?.lastSuccessAt) }}</td><td>{{ successRate(row.requestStatus) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-else
          class="table-empty"
        >
          该请求组还没有可展示的数据点
        </p>
      </article>
    </div>
    <div
      v-else
      class="table-empty modbus-master-live__empty"
    >
      <p>还没有请求组，请先配置读取任务。</p><button
        type="button"
        class="command-button"
        @click="emit('configure')"
      >
        配置读取任务
      </button>
    </div>
  </section>
</template>
