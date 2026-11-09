<script setup>
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { createModalFocusTrap } from '../model/modalFocus.js';

import {
  MODBUS_MASTER_POINT_TYPES,
  modbusMasterPointLength,
  normalizeModbusRequest,
  normalizeModbusRequestGroup,
  validateModbusRequestGroups,
} from '../model/modbusMasterConfig.js';
import {
  applyModbusDataOrder,
  modbusDataOrderCode,
  modbusDataOrderOptions,
} from '../model/modbusDataOrder.js';

const props = defineProps({
  open: Boolean,
  saving: Boolean,
  saveError: { type: String, default: '' },
  request: { type: Object, default: null },
  group: { type: Object, required: true },
  masterConfig: { type: Object, required: true },
  existingRequests: { type: Array, default: () => [] },
});
const emit = defineEmits(['save', 'cancel']);

let nextId = 0;
const dialogRef = ref(null);
const draft = reactive(emptyRequest());
const errors = ref({});
const errorPrefix = ref('');
const isBitRequest = computed(() => [1, 2].includes(Number(draft.functionCode)));
const errorMessages = computed(() => [...new Set(Object.values(errors.value))]);
const focusTrap = createModalFocusTrap({ container: () => dialogRef.value, requestClose: cancel, isBusy: () => props.saving });

watch(() => [props.open, props.request], async ([open], previous = []) => {
  if (!open) { if (previous[0]) focusTrap.restore(); return; }
  if (!previous[0]) focusTrap.capture();
  Object.assign(draft, normalizeModbusRequest(props.request ?? emptyRequest()));
  draft.dataPoints = draft.dataPoints.map((point) => ({ ...point }));
  errors.value = {};
  await nextTick();
  if (props.open) focusTrap.activate('[name="modbus-request-name"]');
}, { immediate: true });
onBeforeUnmount(focusTrap.restore);
function cancel() { if (!props.saving) emit('cancel'); }

function emptyRequest() {
  return {
    id: uniqueId('request'),
    name: '',
    enabled: true,
    order: props.existingRequests.length,
    functionCode: 3,
    startAddress: 0,
    quantity: 10,
    intervalMs: 1000,
    timeoutMs: null,
    retryCount: null,
    retryIntervalMs: null,
    dataPoints: [],
  };
}

function addPoint() {
  const index = draft.dataPoints.length;
  draft.dataPoints.push({
    id: uniqueId('point'),
    key: uniquePointKey(`point_${index + 1}`),
    name: '',
    enabled: true,
    offset: index,
    dataType: isBitRequest.value ? 'boolean' : 'uint16',
    length: 1,
    byteOrder: props.masterConfig.byteOrder ?? 'big-endian',
    wordOrder: props.masterConfig.wordOrder ?? 'high-first',
    bitIndex: null,
    scale: 1,
    valueOffset: 0,
    unit: '',
    decimals: null,
    minimum: null,
    maximum: null,
    invalidPolicy: 'mark-bad',
    saveHistory: false,
    historyMode: 'on-change',
  });
}

function copyPoint(index) {
  const source = draft.dataPoints[index];
  draft.dataPoints.splice(index + 1, 0, {
    ...source,
    id: uniqueId('point'),
    key: uniquePointKey(`${source.key}_copy`),
    name: `${source.name}副本`,
  });
}

function updatePointType(point) {
  point.length = modbusMasterPointLength(point.dataType, point.length);
  if (isBitRequest.value) {
    point.dataType = 'boolean';
    point.length = 1;
    point.bitIndex = null;
  } else if (point.dataType !== 'boolean') {
    point.bitIndex = null;
  }
}

function updatePointDataOrder(point, code) {
  Object.assign(point, applyModbusDataOrder(code));
}

function updateFunctionCode() {
  for (const point of draft.dataPoints) updatePointType(point);
}

function movePoint(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= draft.dataPoints.length) return;
  const [point] = draft.dataPoints.splice(index, 1);
  draft.dataPoints.splice(target, 0, point);
}

function removePoint(index) {
  draft.dataPoints.splice(index, 1);
}

function submit() {
  if (props.saving) return;
  const candidate = {
    ...draft,
    dataPoints: draft.dataPoints.map((point) => ({ ...point })),
  };
  const peers = props.existingRequests.filter(({ id }) => id !== candidate.id);
  const rawGroup = {
    ...props.group,
    requests: [...peers, candidate],
  };
  const allErrors = validateModbusRequestGroups([rawGroup], props.masterConfig);
  errorPrefix.value = `requestGroup-0-request-${peers.length}`;
  errors.value = Object.fromEntries(Object.entries(allErrors)
    .filter(([key]) => key.startsWith(errorPrefix.value)));
  if (Object.keys(errors.value).length > 0) return;
  const normalizedGroup = normalizeModbusRequestGroup(rawGroup);
  const requestIndex = normalizedGroup.requests.findIndex(({ id }) => id === candidate.id);
  emit('save', normalizedGroup.requests[requestIndex]);
}

function uniquePointKey(base) {
  const used = new Set(draft.dataPoints.map(({ key }) => key));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function uniqueId(kind) {
  nextId += 1;
  return `${kind}-${Date.now()}-${nextId}`;
}

function pointError(index, field) {
  return errors.value[`${errorPrefix.value}-point-${index}-${field}`] ?? '';
}
</script>

<template>
  <div
    v-if="open"
    class="dialog-backdrop modbus-group-dialog-backdrop"
    @mousedown.self="cancel"
    @keydown="focusTrap.handleKeydown"
  >
    <form
      ref="dialogRef"
      class="endpoint-dialog modbus-group-dialog modbus-request-dialog"
      role="dialog"
      aria-modal="true"
      :aria-busy="saving"
      aria-labelledby="modbus-request-dialog-title"
      novalidate
      @submit.prevent="submit"
    >
      <header>
        <h2 id="modbus-request-dialog-title">
          {{ request ? '编辑请求' : '新增请求' }}
        </h2>
        <button
          type="button"
          class="icon-button"
          title="关闭"
          aria-label="关闭请求编辑器"
          :disabled="saving"
          @click="cancel"
        >
          <X :size="17" />
        </button>
      </header>

      <fieldset
        class="modbus-group-dialog__body"
        :disabled="saving"
      >
        <section
          class="dialog-form-stack"
          aria-label="请求配置"
        >
          <fieldset class="modbus-group-fields dialog-form-section">
            <legend>基本信息</legend>
            <label class="dialog-form-wide">
              <span>请求名称</span>
              <input
                v-model="draft.name"
                name="modbus-request-name"
                required
              >
            </label>
            <label class="checkbox-control dialog-form-wide">
              <input
                v-model="draft.enabled"
                name="modbus-request-enabled"
                type="checkbox"
              >
              <span>启用请求</span>
            </label>
          </fieldset>
          <fieldset class="modbus-group-fields dialog-form-section">
            <legend>读取范围</legend>
            <label class="dialog-form-wide">
              <span>功能码</span>
              <select
                v-model.number="draft.functionCode"
                name="modbus-request-function"
                @change="updateFunctionCode"
              >
                <option :value="1">FC01 读取线圈</option>
                <option :value="2">FC02 读取离散输入</option>
                <option :value="3">FC03 读取保持寄存器</option>
                <option :value="4">FC04 读取输入寄存器</option>
              </select>
            </label>
            <label>
              <span>起始地址</span>
              <input
                v-model.number="draft.startAddress"
                name="modbus-request-address"
                type="number"
                min="0"
                max="65535"
              >
            </label>
            <label>
              <span>读取数量</span>
              <input
                v-model.number="draft.quantity"
                name="modbus-request-quantity"
                type="number"
                min="1"
                :max="isBitRequest ? 2000 : 125"
              >
            </label>
          </fieldset>
          <fieldset class="modbus-group-fields dialog-form-section">
            <legend>轮询与恢复</legend>
            <label>
              <span>轮询周期（毫秒）</span>
              <input
                v-model.number="draft.intervalMs"
                name="modbus-request-interval"
                type="number"
                min="100"
                max="3600000"
              >
            </label>
            <label>
              <span>请求超时（毫秒）</span>
              <input
                v-model.number="draft.timeoutMs"
                name="modbus-request-timeout"
                type="number"
                min="50"
                max="60000"
                placeholder="继承主站"
              >
            </label>
            <label>
              <span>重试次数</span>
              <input
                v-model.number="draft.retryCount"
                name="modbus-request-retries"
                type="number"
                min="0"
                max="10"
                placeholder="继承主站"
              >
            </label>
            <label>
              <span>重试间隔（毫秒）</span>
              <input
                v-model.number="draft.retryIntervalMs"
                name="modbus-request-retry-interval"
                type="number"
                min="0"
                max="60000"
                placeholder="继承主站"
              >
            </label>
          </fieldset>
        </section>

        <section
          class="modbus-group-points"
          aria-labelledby="modbus-request-points-title"
        >
          <header>
            <div>
              <strong id="modbus-request-points-title">数据点</strong>
              <span>{{ draft.dataPoints.length }} 个</span>
            </div>
            <button
              type="button"
              class="command-button command-button--quiet"
              aria-label="新增数据点"
              @click="addPoint"
            >
              <Plus :size="14" />新增
            </button>
          </header>
          <p
            v-if="draft.dataPoints.length === 0"
            class="table-empty"
          >
            当前读取范围还没有配置数据点
          </p>
          <article
            v-for="(point, index) in draft.dataPoints"
            :key="point.id"
            class="modbus-group-point"
            :class="{ disabled: !point.enabled }"
          >
            <div class="modbus-group-point__heading">
              <label class="checkbox-control">
                <input
                  v-model="point.enabled"
                  :name="`request-point-${index}-enabled`"
                  type="checkbox"
                >
                <span>启用</span>
              </label>
              <strong>数据点 {{ index + 1 }}</strong>
              <div class="modbus-group-point__actions">
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="`复制数据点 ${point.name || index + 1}`"
                  title="复制"
                  @click="copyPoint(index)"
                >
                  <Copy :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :disabled="index === 0"
                  :aria-label="`上移数据点 ${point.name || index + 1}`"
                  title="上移"
                  @click="movePoint(index, -1)"
                >
                  <ArrowUp :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :disabled="index === draft.dataPoints.length - 1"
                  :aria-label="`下移数据点 ${point.name || index + 1}`"
                  title="下移"
                  @click="movePoint(index, 1)"
                >
                  <ArrowDown :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button danger"
                  :aria-label="`删除数据点 ${point.name || index + 1}`"
                  title="删除"
                  @click="removePoint(index)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
            <div class="modbus-group-point__grid">
              <label class="dialog-form-point-identity"><span>名称</span><input
                v-model="point.name"
                :name="`request-point-${index}-name`"
              ></label>
              <label class="dialog-form-point-identity"><span>唯一标识</span><input
                v-model="point.key"
                :name="`request-point-${index}-key`"
              ></label>
              <label><span>偏移</span><input
                v-model.number="point.offset"
                :name="`request-point-${index}-offset`"
                type="number"
                min="0"
              ></label>
              <label><span>数据类型</span><select
                v-model="point.dataType"
                :name="`request-point-${index}-type`"
                @change="updatePointType(point)"
              ><option
                v-for="type in MODBUS_MASTER_POINT_TYPES"
                :key="type"
                :value="type"
              >{{ type === 'boolean' ? 'Bool' : type.replace('string', 'String') }}</option></select></label>
              <label v-if="point.dataType === 'string'"><span>长度</span><input
                v-model.number="point.length"
                :name="`request-point-${index}-length`"
                type="number"
                min="1"
                max="125"
              ></label>
              <label v-if="point.dataType === 'boolean' && !isBitRequest"><span>位索引</span><input
                v-model.number="point.bitIndex"
                :name="`request-point-${index}-bit`"
                type="number"
                min="0"
                max="15"
              ></label>
              <label v-if="!isBitRequest && point.dataType !== 'boolean'">
                <span>数据顺序</span>
                <select
                  :value="modbusDataOrderCode(point)"
                  :name="`request-point-${index}-data-order`"
                  @change="updatePointDataOrder(point, $event.target.value)"
                >
                  <option
                    v-for="option in modbusDataOrderOptions(point)"
                    :key="option.value"
                    :value="option.value"
                  >{{ option.label }}</option>
                </select>
              </label>
              <label><span>倍率</span><input
                v-model.number="point.scale"
                type="number"
                step="any"
              ></label>
              <label><span>偏移量</span><input
                v-model.number="point.valueOffset"
                type="number"
                step="any"
              ></label>
              <label><span>单位</span><input v-model="point.unit"></label>
              <label><span>小数位</span><input
                v-model.number="point.decimals"
                type="number"
                min="0"
                max="12"
                placeholder="自动"
              ></label>
              <label><span>合理下限</span><input
                v-model="point.minimum"
                type="text"
                inputmode="decimal"
                placeholder="不限"
              ></label>
              <label><span>合理上限</span><input
                v-model="point.maximum"
                type="text"
                inputmode="decimal"
                placeholder="不限"
              ></label>
              <label><span>异常处理</span><select v-model="point.invalidPolicy"><option value="mark-bad">标记异常</option><option value="keep-last-good">保留上次正常值</option></select></label>
              <div class="modbus-group-point__history">
                <label class="checkbox-control">
                  <input
                    v-model="point.saveHistory"
                    :name="`request-point-${index}-save-history`"
                    type="checkbox"
                  >
                  <span>记录历史数据</span>
                </label>
                <div
                  v-if="point.saveHistory"
                  class="segmented-control"
                  role="radiogroup"
                  aria-label="历史采集模式"
                >
                  <button
                    v-for="mode in [
                      { value: 'on-change', label: '变化时' },
                      { value: 'every-poll', label: '每次轮询' },
                    ]"
                    :key="mode.value"
                    type="button"
                    role="radio"
                    :data-mode="mode.value"
                    :aria-checked="point.historyMode === mode.value"
                    @click="point.historyMode = mode.value"
                  >
                    {{ mode.label }}
                  </button>
                </div>
              </div>
            </div>
            <p
              v-if="pointError(index, 'offset') || pointError(index, 'dataType') || pointError(index, 'bitIndex')"
              class="field-error"
              role="alert"
            >
              {{ pointError(index, 'offset') || pointError(index, 'dataType') || pointError(index, 'bitIndex') }}
            </p>
          </article>
        </section>

        <div
          v-if="errorMessages.length"
          class="modbus-group-errors"
          role="alert"
        >
          <span
            v-for="message in errorMessages"
            :key="message"
          >{{ message }}</span>
        </div>
        <p
          v-if="saveError"
          class="field-error"
          role="alert"
        >
          {{ saveError }}
        </p>
      </fieldset>

      <footer>
        <button
          type="button"
          class="command-button command-button--quiet"
          :disabled="saving"
          @click="cancel"
        >
          取消
        </button>
        <button
          type="submit"
          class="command-button"
          :disabled="saving"
        >
          {{ saving ? '正在保存…' : '保存请求' }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
fieldset.modbus-group-dialog__body { min-width: 0; margin: 0; border: 0; }
</style>
