<script setup>
import { computed } from 'vue';
import { LoaderCircle, RefreshCw } from 'lucide-vue-next';
import { MAX_SERIAL_BAUD_RATE, SUPPORTED_BAUD_RATES, normalizeSerialPorts } from '../../model/endpointDraft.js';
// The dialog owns this stable, mutable draft and error map. Fields only edit the
// draft; validation, saving, focus, and asynchronous lifetime stay in the dialog.
const props = defineProps({
  draft: { type: Object, required: true },
  fieldErrors: { type: Object, required: true },
  serialPorts: { type: Array, default: () => [] },
  scanningPorts: Boolean,
  serialScanError: { type: String, default: '' },
});
const form = props.draft;
const fieldErrors = props.fieldErrors;
const emit = defineEmits(['scan-serial-ports']);
const normalizedSerialPorts = computed(() => normalizeSerialPorts(props.serialPorts));
const serialPortOptions = computed(() => {
  const options = [...normalizedSerialPorts.value];
  const configured = form.serialPortChoice;
  if (configured && configured !== '__custom__' && !options.some(({ path }) => path === configured)) {
    options.unshift({ path: configured, label: `${configured}（当前不可用）` });
  }
  return options;
});
const serialParityOptions = computed(() => (
  form.transport.startsWith('modbus-rtu-') || form.transport.startsWith('dlt645-')
    ? ['none', 'even', 'odd'] : ['none', 'even', 'odd', 'mark', 'space']
));
const serialStopBitOptions = computed(() => (
  form.transport.startsWith('modbus-rtu-') || form.transport.startsWith('dlt645-')
    ? [1, 2] : [1, 1.5, 2]
));
</script>

<template>
  <label class="field-control endpoint-dialog__wide">
    <span>串口</span>
    <div class="field-control__with-action">
      <select
        v-model="form.serialPortChoice"
        name="serial-port-select"
      >
        <option
          v-for="port in serialPortOptions"
          :key="port.path"
          :value="port.path"
        >{{ port.label }}</option>
        <option value="__custom__">自定义...</option>
      </select>
      <button
        type="button"
        class="icon-button"
        :disabled="scanningPorts"
        aria-label="刷新串口列表"
        title="刷新串口列表"
        @click="emit('scan-serial-ports')"
      ><LoaderCircle
        v-if="scanningPorts"
        :size="15"
        class="spin"
      /><RefreshCw
        v-else
        :size="15"
      /></button>
    </div>
    <input
      v-if="form.serialPortChoice === '__custom__'"
      v-model="form.customPath"
      name="serial-custom-path"
      required
      placeholder="例如 COM3 或 /dev/ttyUSB0"
      :aria-invalid="Boolean(fieldErrors.path)"
    >
    <small
      v-if="scanningPorts"
      class="field-note"
    >正在扫描串口...</small>
    <small
      v-else-if="serialScanError"
      class="field-error"
      role="alert"
    >{{ serialScanError }}</small>
    <small
      v-else-if="normalizedSerialPorts.length === 0"
      class="field-note"
    >未发现串口</small>
    <small
      v-if="fieldErrors.path"
      class="field-error"
      role="alert"
    >{{ fieldErrors.path }}</small>
  </label>
  <div
    class="field-control"
    role="group"
    aria-labelledby="serial-baud-rate-label"
  >
    <span id="serial-baud-rate-label">波特率</span>
    <select
      v-model="form.baudRateChoice"
      name="serial-baud-rate-choice"
      aria-labelledby="serial-baud-rate-label"
      required
    >
      <option
        v-for="rate in SUPPORTED_BAUD_RATES"
        :key="rate"
        :value="rate"
      >
        {{ rate }}
      </option>
      <option value="__custom__">
        自定义...
      </option>
    </select>
    <input
      v-if="form.baudRateChoice === '__custom__'"
      v-model.number="form.customBaudRate"
      name="serial-custom-baud-rate"
      type="number"
      min="1"
      :max="MAX_SERIAL_BAUD_RATE"
      step="1"
      aria-label="自定义波特率"
      required
      :aria-invalid="Boolean(fieldErrors.baudRate)"
    >
    <small
      v-if="fieldErrors.baudRate"
      class="field-error"
      role="alert"
    >{{ fieldErrors.baudRate }}</small>
  </div>
  <label class="field-control">
    <span>数据位</span>
    <select
      v-model.number="form.dataBits"
      name="serial-data-bits"
    >
      <option
        v-for="value in [5, 6, 7, 8]"
        :key="value"
        :value="value"
      >{{ value }}</option>
    </select>
    <small
      v-if="fieldErrors.dataBits"
      class="field-error"
      role="alert"
    >{{ fieldErrors.dataBits }}</small>
  </label>
  <label class="field-control">
    <span>校验位</span>
    <select
      v-model="form.parity"
      name="serial-parity"
    >
      <option
        v-for="value in serialParityOptions"
        :key="value"
        :value="value"
      >{{ {
        none: '无（None）', even: '偶校验（Even）', odd: '奇校验（Odd）',
        mark: '固定 1（Mark）', space: '固定 0（Space）',
      }[value] }}</option>
    </select>
    <small
      v-if="fieldErrors.parity"
      class="field-error"
      role="alert"
    >{{ fieldErrors.parity }}</small>
  </label>
  <label class="field-control">
    <span>停止位</span>
    <select
      v-model.number="form.stopBits"
      name="serial-stop-bits"
    >
      <option
        v-for="value in serialStopBitOptions"
        :key="value"
        :value="value"
      >{{ value }}</option>
    </select>
    <small
      v-if="fieldErrors.stopBits"
      class="field-error"
      role="alert"
    >{{ fieldErrors.stopBits }}</small>
  </label>
  <label class="field-control">
    <span>流控</span>
    <select
      v-model="form.flowControl"
      name="serial-flow-control"
    >
      <option value="none">无（None）</option>
      <option value="hardware">硬件（RTS/CTS）</option>
      <option value="software">软件（XON/XOFF）</option>
    </select>
    <small
      v-if="fieldErrors.flowControl"
      class="field-error"
      role="alert"
    >{{ fieldErrors.flowControl }}</small>
  </label>
  <template v-if="form.transport === 'serial'">
    <label class="field-control">
      <span>接收分帧</span>
      <select
        v-model="form.receiveFramingMode"
        name="serial-receive-framing"
        :aria-invalid="Boolean(fieldErrors.receiveFraming)"
      >
        <option value="raw">原始数据</option>
        <option value="delimiter">分隔符</option>
        <option value="fixed">固定长度</option>
        <option value="idle">空闲超时</option>
      </select>
      <small
        v-if="fieldErrors.receiveFraming"
        class="field-error"
        role="alert"
      >{{ fieldErrors.receiveFraming }}</small>
    </label>
    <label
      v-if="form.receiveFramingMode === 'delimiter'"
      class="field-control"
    >
      <span>HEX 分隔符</span>
      <input
        v-model="form.receiveDelimiterHex"
        name="serial-receive-delimiter"
        placeholder="0D 0A"
        :aria-invalid="Boolean(fieldErrors.delimiterBytes)"
      >
      <small
        v-if="fieldErrors.delimiterBytes"
        class="field-error"
        role="alert"
      >{{ fieldErrors.delimiterBytes }}</small>
    </label>
    <label
      v-else-if="form.receiveFramingMode === 'fixed'"
      class="field-control"
    >
      <span>固定长度</span>
      <input
        v-model.number="form.receiveFrameLength"
        name="serial-receive-length"
        type="number"
        min="1"
        max="1048576"
        :aria-invalid="Boolean(fieldErrors.receiveFrameLength)"
      >
      <small
        v-if="fieldErrors.receiveFrameLength"
        class="field-error"
        role="alert"
      >{{ fieldErrors.receiveFrameLength }}</small>
    </label>
    <label
      v-else-if="form.receiveFramingMode === 'idle'"
      class="field-control"
    >
      <span>空闲毫秒</span>
      <input
        v-model.number="form.receiveIdleMs"
        name="serial-receive-idle-ms"
        type="number"
        min="1"
        max="60000"
        :aria-invalid="Boolean(fieldErrors.receiveIdleMs)"
      >
      <small
        v-if="fieldErrors.receiveIdleMs"
        class="field-error"
        role="alert"
      >{{ fieldErrors.receiveIdleMs }}</small>
    </label>
  </template>
  <fieldset
    v-if="form.transport === 'dlt645-master'"
    class="endpoint-parameter-section endpoint-dialog__wide"
  >
    <legend>电表抄读</legend>
    <label class="field-control">
      <span>请求超时（毫秒）</span>
      <input
        v-model.number="form.dlt645TimeoutMs"
        name="dlt645-timeout"
        type="number"
        min="100"
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
      <span>最小请求间隔（毫秒）</span>
      <input
        v-model.number="form.dlt645MinRequestGapMs"
        name="dlt645-min-request-gap"
        type="number"
        min="0"
        max="60000"
        :aria-invalid="Boolean(fieldErrors.minRequestGapMs)"
      >
      <small
        v-if="fieldErrors.minRequestGapMs"
        class="field-error"
        role="alert"
      >{{ fieldErrors.minRequestGapMs }}</small>
    </label>
    <label class="field-control">
      <span>唤醒字节（FE）数量</span>
      <input
        v-model.number="form.dlt645WakeUpBytes"
        name="dlt645-wake-up-bytes"
        type="number"
        min="0"
        max="16"
        :aria-invalid="Boolean(fieldErrors.wakeUpBytes)"
      >
      <small
        v-if="fieldErrors.wakeUpBytes"
        class="field-error"
        role="alert"
      >{{ fieldErrors.wakeUpBytes }}</small>
    </label>
    <label class="endpoint-parameter-section__toggle endpoint-parameter-section__toggle--field-row">
      <input
        v-model="form.dlt645AutoStart"
        name="dlt645-auto-start"
        type="checkbox"
      >
      <span>连接后自动轮询</span>
    </label>
  </fieldset>
  <fieldset
    v-if="form.transport === 'dlt645-slave'"
    class="endpoint-parameter-section endpoint-dialog__wide"
  >
    <legend>电表模拟器</legend>
    <label class="field-control">
      <span>响应延迟（毫秒）</span>
      <input
        v-model.number="form.dlt645ResponseDelayMs"
        name="dlt645-response-delay"
        type="number"
        min="0"
        max="10000"
        :aria-invalid="Boolean(fieldErrors.responseDelayMs)"
      >
      <small
        v-if="fieldErrors.responseDelayMs"
        class="field-error"
        role="alert"
      >{{ fieldErrors.responseDelayMs }}</small>
    </label>
    <label class="field-control">
      <span>响应唤醒字节（FE）数量</span>
      <input
        v-model.number="form.dlt645ResponseWakeUpBytes"
        name="dlt645-response-wake-up-bytes"
        type="number"
        min="0"
        max="16"
        :aria-invalid="Boolean(fieldErrors.wakeUpBytes)"
      >
      <small
        v-if="fieldErrors.wakeUpBytes"
        class="field-error"
        role="alert"
      >{{ fieldErrors.wakeUpBytes }}</small>
    </label>
  </fieldset>
</template>
