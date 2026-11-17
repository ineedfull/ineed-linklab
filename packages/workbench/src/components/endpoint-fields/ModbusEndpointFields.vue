<script setup>
import { computed } from 'vue';
import { Plus, Trash2 } from 'lucide-vue-next';
import { MODBUS_AREA_KEYS } from '../../model/endpointDraft.js';
import { MODBUS_POINT_TYPES, modbusPointLength } from '../../model/modbusDataPoints.js';
import { applyModbusDataOrder, modbusDataOrderCode, modbusDataOrderOptions } from '../../model/modbusDataOrder.js';
// The dialog owns this stable, mutable draft and error map. Fields only edit the
// draft; validation, saving, focus, and asynchronous lifetime stay in the dialog.
const props = defineProps({
  draft: { type: Object, required: true },
  fieldErrors: { type: Object, required: true },
});
const form = props.draft;
const fieldErrors = props.fieldErrors;
const isModbusMaster = computed(() => form.transport.endsWith('-master'));
const isModbusSlave = computed(() => form.transport.endsWith('-slave'));

function addModbusDataPoint() {
  const index = form.modbusDataPoints.length + 1;
  form.modbusDataPoints.push({
    id: `point-${Date.now()}-${index}`,
    name: '',
    group: '默认分组',
    area: 'holdingRegisters',
    address: 0,
    dataType: 'uint16',
    length: 1,
    byteOrder: form.byteOrder,
    wordOrder: form.wordOrder,
    scale: 1,
    offset: 0,
    unit: '',
    access: 'read-write',
  });
}

function updateModbusDataOrder(target, code) {
  Object.assign(target, applyModbusDataOrder(code));
}

function removeModbusDataPoint(index) {
  form.modbusDataPoints.splice(index, 1);
}

function updateModbusPointType(point) {
  point.length = modbusPointLength(point.dataType, point.length);
  if (point.dataType === 'boolean') {
    if (!['coils', 'discreteInputs'].includes(point.area)) point.area = 'coils';
  } else if (!['holdingRegisters', 'inputRegisters'].includes(point.area)) {
    point.area = 'holdingRegisters';
  }
  if (['discreteInputs', 'inputRegisters'].includes(point.area)) point.access = 'read-only';
}

function updateModbusPointArea(point) {
  const bitArea = ['coils', 'discreteInputs'].includes(point.area);
  if (bitArea) {
    point.dataType = 'boolean';
    point.length = 1;
  } else if (point.dataType === 'boolean') {
    point.dataType = 'uint16';
  }
  if (['discreteInputs', 'inputRegisters'].includes(point.area)) point.access = 'read-only';
}

function modbusAreaLabel(area) {
  return {
    coils: '线圈',
    discreteInputs: '离散输入',
    holdingRegisters: '保持寄存器',
    inputRegisters: '输入寄存器',
  }[area];
}

function modbusTypeLabel(type) {
  return {
    boolean: '布尔', uint16: 'UInt16', int16: 'Int16', uint32: 'UInt32',
    int32: 'Int32', float32: 'Float32', float64: 'Float64', ascii: 'ASCII 字符串',
  }[type];
}

</script>

<template>
  <fieldset class="endpoint-parameter-section endpoint-dialog__wide">
    <legend>Modbus 参数</legend>
    <label class="field-control">
      <span>站号（Unit ID）</span>
      <input
        v-model.number="form.unitId"
        name="modbus-unit-id"
        type="number"
        min="1"
        max="247"
        :aria-invalid="Boolean(fieldErrors.unitId)"
      >
      <small
        v-if="fieldErrors.unitId"
        class="field-error"
        role="alert"
      >{{ fieldErrors.unitId }}</small>
    </label>
    <label class="field-control">
      <span>请求超时（毫秒）</span>
      <input
        v-model.number="form.timeoutMs"
        name="modbus-timeout"
        type="number"
        min="50"
        max="60000"
        :aria-invalid="Boolean(fieldErrors.timeoutMs)"
      >
      <small
        v-if="fieldErrors.timeoutMs"
        class="field-error"
        role="alert"
      >{{ fieldErrors.timeoutMs }}</small>
    </label>
    <label class="field-control">
      <span>地址显示</span>
      <select
        v-model="form.addressNotation"
        name="modbus-address-notation"
      >
        <option value="zero-based">协议地址（0 基）</option>
        <option value="reference">参考地址（0xxxx / 1xxxx / 3xxxx / 4xxxx）</option>
      </select>
    </label>
    <label class="field-control">
      <span>默认数据顺序</span>
      <select
        :value="modbusDataOrderCode({ ...form, dataType: 'float32', length: 2 })"
        name="modbus-data-order"
        @change="updateModbusDataOrder(form, $event.target.value)"
      >
        <option
          v-for="option in modbusDataOrderOptions({ dataType: 'float32', length: 2 })"
          :key="option.value"
          :value="option.value"
        >{{ option.label }}</option>
      </select>
    </label>
  </fieldset>
  <fieldset
    v-if="isModbusMaster"
    class="endpoint-parameter-section endpoint-dialog__wide"
  >
    <legend>主站调度与恢复</legend>
    <label class="field-control endpoint-dialog__wide">
      <span>说明</span>
      <input
        v-model="form.modbusDescription"
        name="modbus-master-description"
        maxlength="200"
        placeholder="例如：锅炉房环境参数采集"
      >
    </label>
    <div class="endpoint-dialog__option-row">
      <label class="endpoint-parameter-section__toggle">
        <input
          v-model="form.modbusEnabled"
          name="modbus-master-enabled"
          type="checkbox"
        >
        <span>启用主站</span>
      </label>
      <label class="endpoint-parameter-section__toggle">
        <input
          v-model="form.modbusSchedulerAutoStart"
          name="modbus-master-auto-start"
          type="checkbox"
        >
        <span>连接后自动轮询</span>
      </label>
      <label
        v-if="form.transport === 'modbus-tcp-master'"
        class="endpoint-parameter-section__toggle"
      >
        <input
          v-model="form.autoReconnect"
          name="modbus-master-auto-reconnect"
          type="checkbox"
        >
        <span>断线自动重连</span>
      </label>
    </div>
    <label class="field-control">
      <span>默认重试次数</span>
      <input
        v-model.number="form.modbusRetryCount"
        name="modbus-master-retry-count"
        type="number"
        min="0"
        max="10"
        :aria-invalid="Boolean(fieldErrors.retryCount)"
      >
      <small
        v-if="fieldErrors.retryCount"
        class="field-error"
        role="alert"
      >{{ fieldErrors.retryCount }}</small>
    </label>
    <label class="field-control">
      <span>默认重试间隔（毫秒）</span>
      <input
        v-model.number="form.modbusRetryIntervalMs"
        name="modbus-master-retry-interval"
        type="number"
        min="0"
        max="60000"
        :aria-invalid="Boolean(fieldErrors.retryIntervalMs)"
      >
      <small
        v-if="fieldErrors.retryIntervalMs"
        class="field-error"
        role="alert"
      >{{ fieldErrors.retryIntervalMs }}</small>
    </label>
    <label class="field-control">
      <span>最小请求间隔（毫秒）</span>
      <input
        v-model.number="form.modbusSchedulerMinGapMs"
        name="modbus-master-min-gap"
        type="number"
        min="0"
        max="60000"
        :aria-invalid="Boolean(fieldErrors.schedulerMinGapMs)"
      >
      <small
        v-if="fieldErrors.schedulerMinGapMs"
        class="field-error"
        role="alert"
      >{{ fieldErrors.schedulerMinGapMs }}</small>
    </label>
  </fieldset>
  <fieldset
    v-if="isModbusSlave"
    class="modbus-area-settings endpoint-dialog__wide"
  >
    <legend>从站数据区</legend>
    <div
      v-for="key in MODBUS_AREA_KEYS"
      :key="key"
      class="modbus-area-settings__row"
    >
      <strong>{{ {
        coils: '线圈', discreteInputs: '离散输入',
        holdingRegisters: '保持寄存器', inputRegisters: '输入寄存器',
      }[key] }}</strong>
      <label>
        <span>起始地址</span>
        <input
          v-model.number="form[`modbus${key[0].toUpperCase()}${key.slice(1)}Start`]"
          type="number"
          min="0"
          max="65535"
          :aria-invalid="Boolean(fieldErrors[`${key}Start`])"
        >
      </label>
      <label>
        <span>数量</span>
        <input
          v-model.number="form[`modbus${key[0].toUpperCase()}${key.slice(1)}Count`]"
          type="number"
          min="1"
          max="10000"
          :aria-invalid="Boolean(fieldErrors[`${key}Count`])"
        >
      </label>
      <small
        v-if="fieldErrors[`${key}Start`] || fieldErrors[`${key}Count`]"
        class="field-error"
        role="alert"
      >
        {{ fieldErrors[`${key}Start`] || fieldErrors[`${key}Count`] }}
      </small>
    </div>
  </fieldset>
  <fieldset
    v-if="isModbusSlave"
    class="modbus-point-settings endpoint-dialog__wide"
  >
    <legend>业务数据点</legend>
    <header>
      <span>按设备业务定义数据，原始寄存器仍可用于协议调试。</span>
      <button
        type="button"
        class="command-button command-button--quiet"
        @click="addModbusDataPoint"
      >
        <Plus :size="14" />添加数据点
      </button>
    </header>
    <div
      v-if="form.modbusDataPoints.length === 0"
      class="modbus-point-settings__empty"
    >
      尚未配置业务数据点
    </div>
    <article
      v-for="(point, index) in form.modbusDataPoints"
      :key="point.id"
      class="modbus-point-settings__item"
    >
      <div class="modbus-point-settings__heading">
        <strong>{{ point.name || `数据点 ${index + 1}` }}</strong>
        <button
          type="button"
          class="icon-button"
          title="删除数据点"
          aria-label="删除数据点"
          @click="removeModbusDataPoint(index)"
        >
          <Trash2 :size="14" />
        </button>
      </div>
      <div class="modbus-point-settings__grid">
        <label>
          <span>业务分组</span>
          <input v-model.trim="point.group">
        </label>
        <label>
          <span>业务名称</span>
          <input
            v-model.trim="point.name"
            :name="`modbus-point-${index}-name`"
            :aria-invalid="Boolean(fieldErrors[`dataPoint-${index}-name`])"
          >
        </label>
        <label>
          <span>数据区</span>
          <select
            v-model="point.area"
            :name="`modbus-point-${index}-area`"
            @change="updateModbusPointArea(point)"
          >
            <option
              v-for="key in MODBUS_AREA_KEYS"
              :key="key"
              :value="key"
            >{{ modbusAreaLabel(key) }}</option>
          </select>
        </label>
        <label>
          <span>地址</span>
          <input
            v-model.number="point.address"
            :name="`modbus-point-${index}-address`"
            type="number"
            min="0"
            max="65535"
            :aria-invalid="Boolean(fieldErrors[`dataPoint-${index}-address`])"
          >
        </label>
        <label>
          <span>数据类型</span>
          <select
            v-model="point.dataType"
            :name="`modbus-point-${index}-type`"
            @change="updateModbusPointType(point)"
          >
            <option
              v-for="type in MODBUS_POINT_TYPES"
              :key="type"
              :value="type"
            >{{ modbusTypeLabel(type) }}</option>
          </select>
        </label>
        <label>
          <span>长度（寄存器）</span>
          <input
            v-model.number="point.length"
            :name="`modbus-point-${index}-length`"
            type="number"
            min="1"
            max="125"
            :disabled="point.dataType !== 'ascii'"
            :aria-invalid="Boolean(fieldErrors[`dataPoint-${index}-length`])"
          >
        </label>
        <label v-if="point.dataType !== 'boolean'">
          <span>数据顺序</span>
          <select
            :value="modbusDataOrderCode(point)"
            :name="`modbus-point-${index}-data-order`"
            @change="updateModbusDataOrder(point, $event.target.value)"
          >
            <option
              v-for="option in modbusDataOrderOptions(point)"
              :key="option.value"
              :value="option.value"
            >{{ option.label }}</option>
          </select>
        </label>
        <label>
          <span>缩放</span>
          <input
            v-model.number="point.scale"
            type="number"
            step="any"
            :aria-invalid="Boolean(fieldErrors[`dataPoint-${index}-scale`])"
          >
        </label>
        <label>
          <span>偏移</span>
          <input
            v-model.number="point.offset"
            type="number"
            step="any"
            :aria-invalid="Boolean(fieldErrors[`dataPoint-${index}-offset`])"
          >
        </label>
        <label>
          <span>单位</span>
          <input
            v-model.trim="point.unit"
            placeholder="例如 ℃、kPa"
          >
        </label>
        <label>
          <span>读写属性</span>
          <select
            v-model="point.access"
            :disabled="['discreteInputs', 'inputRegisters'].includes(point.area)"
          >
            <option value="read-write">读写</option>
            <option value="read-only">只读</option>
          </select>
        </label>
      </div>
      <small
        v-if="Object.keys(fieldErrors).some((key) => key.startsWith(`dataPoint-${index}-`))"
        class="field-error"
        role="alert"
      >
        {{ Object.entries(fieldErrors).find(([key]) => key.startsWith(`dataPoint-${index}-`))?.[1] }}
      </small>
    </article>
  </fieldset>
</template>
