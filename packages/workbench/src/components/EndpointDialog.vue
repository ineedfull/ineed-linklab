<script setup>
import { isWebSocketTransport, snapshotWebSocketHeaders } from '../model/websocketConfig.js';
import { trapModalTab } from '../model/modalFocus.js';
import { createEndpointForm, buildEndpointConfig } from '../model/endpointDialogForm.js';
import { LoaderCircle, Plus, RefreshCw, Trash2, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

import {
  MAX_SERIAL_BAUD_RATE,
  MODBUS_AREA_KEYS,
  SUPPORTED_BAUD_RATES,
  generateEndpointName,
  normalizeSerialPorts,
  validateEndpointDraft,
} from '../model/endpointDraft.js';
import {
  MODBUS_POINT_TYPES,
  modbusPointLength,
} from '../model/modbusDataPoints.js';
import {
  applyModbusDataOrder,
  modbusDataOrderCode,
  modbusDataOrderOptions,
} from '../model/modbusDataOrder.js';
import { validateModbusWriteCommands } from '../model/modbusWriteCommands.js';
import { DLT645_TRANSPORT } from '../model/dlt645Config.js';
import { DLT645_SLAVE_TRANSPORT } from '../model/dlt645SimulatorConfig.js';

const props = defineProps({
  open: Boolean,
  endpoint: { type: Object, default: null },
  connectionLocked: Boolean,
  websocketHeaders: { type: Array, default: () => [] },
  existingNames: { type: Array, default: () => [] },
  saveCommand: { type: Function, required: true },
  serialPorts: { type: Array, default: () => [] },
  scanningPorts: Boolean,
  serialScanError: { type: String, default: '' },
});
const emit = defineEmits(['close', 'scan-serial-ports']);

const form = reactive(createEndpointForm());
const fieldErrors = reactive({});
const dialogRef = ref(null);
const saving = ref(false);
const saveError = ref('');
const normalizedSerialPorts = computed(() => normalizeSerialPorts(props.serialPorts));
const isProtocolEndpoint = computed(() => ['opcua-client', 'opcua-server', 'stomp-client', 'stomp-server'].includes(form.transport));
const isWebSocket = computed(() => isWebSocketTransport(form.transport));
const isTcpTransport = computed(() => form.transport === 'tcp-client' || form.transport === 'tcp-server');
const isSerialTransport = computed(() => (
  form.transport === 'serial'
  || form.transport === DLT645_TRANSPORT
  || form.transport === DLT645_SLAVE_TRANSPORT
  || form.transport.startsWith('modbus-rtu-')
));
const isModbusTransport = computed(() => form.transport.startsWith('modbus-'));
const isModbusMaster = computed(() => isModbusTransport.value && form.transport.endsWith('-master'));
const serialParityOptions = computed(() => (
  form.transport.startsWith('modbus-rtu-') || form.transport.startsWith('dlt645-')
    ? ['none', 'even', 'odd']
    : ['none', 'even', 'odd', 'mark', 'space']
));
const serialStopBitOptions = computed(() => (
  form.transport.startsWith('modbus-rtu-') || form.transport.startsWith('dlt645-')
    ? [1, 2] : [1, 1.5, 2]
));
const isModbusSlave = computed(() => isModbusTransport.value && form.transport.endsWith('-slave'));
const serialPortOptions = computed(() => {
  const options = [...normalizedSerialPorts.value];
  const configured = form.serialPortChoice;
  if (configured && configured !== '__custom__' && !options.some(({ path }) => path === configured)) {
    options.unshift({ path: configured, label: `${configured}（当前不可用）` });
  }
  return options;
});
let instanceToken = 0;
let priorFocus = null;

watch(() => ({ open: props.open, endpoint: props.endpoint }), async (current, previous) => {
  instanceToken += 1;
  saving.value = false;
  saveError.value = '';
  if (!current.open) {
    if (previous?.open) restoreFocus();
    return;
  }
  if (!previous?.open) priorFocus = document.activeElement;
  Object.assign(form, createEndpointForm(props.endpoint, props.websocketHeaders));
  clearErrors();
  const token = instanceToken;
  await nextTick();
  if (token === instanceToken && props.open) focusFirstControl();
}, { immediate: true });

watch(() => form.transport, (transport, previous) => {
  if (!transport.startsWith('dlt645-') || previous?.startsWith('dlt645-') || props.endpoint) return;
  form.baudRateChoice = 2400;
  form.customBaudRate = 2400;
  form.dataBits = 8;
  form.parity = 'even';
  form.stopBits = 1;
  form.flowControl = 'none';
});

async function save() {
  if (saving.value) return;
  const id = form.id || `endpoint-${Date.now()}`;
  clearErrors();
  saveError.value = '';
  if (isModbusMaster.value) {
    const persistedWriteErrors = validateModbusWriteCommands(props.endpoint?.config?.writeCommands);
    if (Object.keys(persistedWriteErrors).length > 0) {
      Object.assign(fieldErrors, persistedWriteErrors);
      saveError.value = '写入指令配置无效，请先在主站“写入操作”中修复。';
      return;
    }
  }
  let config;
  try {
    config = buildEndpointConfig(form, props.endpoint);
  } catch {
    fieldErrors.delimiterBytes = '请输入有效且非空的 HEX 分隔符。';
    await focusFirstInvalidControl();
    return;
  }
  let websocketHeaders;
  if (form.transport === 'websocket-client') {
    try { websocketHeaders = snapshotWebSocketHeaders(form.websocketHeaders.filter(header => header.name || header.value)); }
    catch (error) { fieldErrors.websocketHeaders = error.message; }
  }
  const enteredName = form.name.trim();
  const name = enteredName || (!props.endpoint
    ? generateEndpointName({ transport: form.transport, config }, props.existingNames)
    : '');
  const draft = { id, name, transport: form.transport, config };
  Object.assign(fieldErrors, validateEndpointDraft(draft));
  if (props.endpoint && !draft.name) fieldErrors.name = '请输入端点名称。';
  if (Object.keys(fieldErrors).length > 0) {
    await focusFirstInvalidControl();
    return;
  }
  const token = instanceToken;
  saving.value = true;
  saveError.value = '';
  try {
    const result = await props.saveCommand(draft, ...(websocketHeaders === undefined ? [] : [{ websocketHeaders }]));
    if (!isCurrentInstance(token)) return;
    if (result?.ok) emit('close');
    else saveError.value = result?.error?.message ?? '无法保存端点';
  } catch (error) {
    if (isCurrentInstance(token)) {
      saveError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (isCurrentInstance(token)) saving.value = false;
  }
}

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

function clearErrors() {
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key];
}

function requestClose() {
  if (!saving.value) emit('close');
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    requestClose();
    return;
  }
  trapModalTab(dialogRef.value, event);
}

function focusFirstControl() {
  dialogRef.value?.querySelector('[name="endpoint-name"]')?.focus();
}

async function focusFirstInvalidControl() {
  await nextTick();
  const control = dialogRef.value?.querySelector('[aria-invalid="true"]:not([disabled])');
  if (!(control instanceof HTMLElement)) return;
  control.focus();
  if (typeof control.scrollIntoView === 'function') {
    control.scrollIntoView({ block: 'nearest' });
  }
}

function restoreFocus() {
  if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus();
  priorFocus = null;
}

function isCurrentInstance(token) {
  return token === instanceToken && props.open;
}

onBeforeUnmount(() => {
  instanceToken += 1;
  restoreFocus();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      @mousedown.self="requestClose"
      @keydown="handleKeydown"
    >
      <form
        ref="dialogRef"
        class="endpoint-dialog endpoint-config-dialog"
        aria-modal="true"
        role="dialog"
        aria-labelledby="endpoint-dialog-title"
        novalidate
        @submit.prevent="save"
      >
        <header>
          <h2 id="endpoint-dialog-title">
            {{ endpoint ? '编辑端点' : '新建端点' }}
          </h2>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭对话框"
            title="关闭"
            :disabled="saving"
            @click="requestClose"
          >
            <X :size="17" />
          </button>
        </header>
        <div class="endpoint-dialog__body">
          <label class="field-control endpoint-dialog__wide">
            <span>名称</span>
            <input
              v-model="form.name"
              name="endpoint-name"
              :required="Boolean(endpoint)"
              maxlength="80"
              :aria-invalid="Boolean(fieldErrors.name)"
            >
            <small
              v-if="fieldErrors.name"
              class="field-error"
              role="alert"
            >{{ fieldErrors.name }}</small>
            <small
              v-else-if="!endpoint"
              class="field-note"
            >留空将根据连接参数自动生成</small>
          </label>
          <label class="field-control endpoint-dialog__wide">
            <span>传输类型</span>
            <select
              v-model="form.transport"
              name="endpoint-transport"
              :disabled="Boolean(endpoint)"
            >
              <option value="serial">串口</option>
              <option value="opcua-client">OPC UA 客户端</option>
              <option value="opcua-server">OPC UA 模拟服务端</option>
              <option value="stomp-client">STOMP 客户端</option>
              <option value="stomp-server">STOMP 服务端</option>
              <option value="websocket-client">WebSocket 客户端</option>
              <option value="websocket-server">WebSocket 服务端</option>
              <option value="tcp-client">TCP 客户端</option>
              <option value="tcp-server">TCP 服务端</option>
              <option value="udp-client">UDP 客户端</option>
              <option value="udp-server">UDP 服务端</option>
              <option value="dlt645-master">DL/T 645-2007 电表主站</option>
              <option value="dlt645-slave">DL/T 645-2007 电表从端模拟器</option>
              <option value="modbus-tcp-master">Modbus TCP 主站</option>
              <option value="modbus-tcp-slave">Modbus TCP 从站</option>
              <option value="modbus-rtu-master">Modbus RTU 主站</option>
              <option value="modbus-rtu-slave">Modbus RTU 从站</option>
            </select>
          </label>

          <template v-if="isProtocolEndpoint">
            <label
              v-if="form.transport === 'opcua-client'"
              class="field-control endpoint-dialog__wide"
            >
              <span>Endpoint URL</span><input
                v-model="form.opcuaEndpointUrl"
                name="opcua-endpoint-url"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.endpointUrl)"
              >
              <small
                v-if="fieldErrors.endpointUrl"
                class="field-error"
                role="alert"
              >{{ fieldErrors.endpointUrl }}</small>
            </label>
            <label
              v-else-if="form.transport === 'stomp-client'"
              class="field-control endpoint-dialog__wide"
            >
              <span>WebSocket URL</span><input
                v-model="form.stompUrl"
                name="stomp-url"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.url)"
              >
              <small
                v-if="fieldErrors.url"
                class="field-error"
                role="alert"
              >{{ fieldErrors.url }}</small>
            </label>
            <template v-else-if="form.transport === 'opcua-server'">
              <label class="field-control"><span>监听地址</span><select
                v-model="form.opcuaServerHost"
                name="opcua-server-host"
                :disabled="connectionLocked"
              ><option>127.0.0.1</option><option>0.0.0.0</option></select></label>
              <label class="field-control"><span>监听端口</span><input
                v-model.number="form.opcuaServerPort"
                name="opcua-server-port"
                type="number"
                min="1"
                max="65535"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.listenPort)"
              ><small
                v-if="fieldErrors.listenPort"
                class="field-error"
                role="alert"
              >{{ fieldErrors.listenPort }}</small></label>
              <label class="field-control endpoint-dialog__wide"><span>路径</span><input
                v-model="form.opcuaServerPath"
                name="opcua-server-path"
                maxlength="128"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.path)"
              ><small
                v-if="fieldErrors.path"
                class="field-error"
                role="alert"
              >{{ fieldErrors.path }}</small></label>
              <label class="field-control endpoint-dialog__wide"><span>命名空间 URI</span><input
                v-model="form.opcuaNamespaceUri"
                name="opcua-namespace-uri"
                maxlength="256"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.namespaceUri)"
              ><small
                v-if="fieldErrors.namespaceUri"
                class="field-error"
                role="alert"
              >{{ fieldErrors.namespaceUri }}</small></label>
              <p class="field-note endpoint-dialog__wide">
                None / 匿名测试模拟器。保存后可在工作台编辑节点与自动变化；默认仅监听本机。
              </p>
            </template>
            <template v-else>
              <label class="field-control"><span>监听地址</span><input
                v-model="form.stompListenHost"
                name="stomp-listen-host"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.listenHost)"
              ><small
                v-if="fieldErrors.listenHost"
                class="field-error"
                role="alert"
              >{{ fieldErrors.listenHost }}</small></label>
              <label class="field-control"><span>监听端口</span><input
                v-model.number="form.stompListenPort"
                name="stomp-listen-port"
                type="number"
                min="1"
                max="65535"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.listenPort)"
              ><small
                v-if="fieldErrors.listenPort"
                class="field-error"
                role="alert"
              >{{ fieldErrors.listenPort }}</small></label>
              <label class="field-control endpoint-dialog__wide"><span>WebSocket 路径</span><input
                v-model="form.stompPath"
                name="stomp-path"
                :disabled="connectionLocked"
                :aria-invalid="Boolean(fieldErrors.path)"
              ><small
                v-if="fieldErrors.path"
                class="field-error"
                role="alert"
              >{{ fieldErrors.path }}</small></label>
            </template>
            <p class="field-note endpoint-dialog__wide">
              {{ connectionLocked ? '连接中可修改名称；修改连接参数前请先断开。' : form.transport === 'opcua-server' ? '运行中请先停止再修改监听参数与节点结构。' : '安全、认证及订阅设置可在保存后的端点工作台中编辑。' }}
            </p>
          </template>
          <template v-else-if="isWebSocket">
            <label
              v-if="form.transport === 'websocket-client'"
              class="field-control endpoint-dialog__wide"
            >
              <span>WebSocket URL</span>
              <input
                v-model="form.websocketUrl"
                name="websocket-url"
                placeholder="ws://127.0.0.1:9000/"
                :aria-invalid="Boolean(fieldErrors.url)"
              >
              <small
                v-if="fieldErrors.url"
                class="field-error"
                role="alert"
              >{{ fieldErrors.url }}</small>
              <small class="field-note">wss 使用系统信任证书并校验主机名</small>
            </label>
            <template v-else>
              <label class="field-control"><span>监听地址</span><input
                v-model="form.websocketListenHost"
                name="websocket-listen-host"
                :aria-invalid="Boolean(fieldErrors.listenHost)"
              ><small
                v-if="fieldErrors.listenHost"
                class="field-error"
                role="alert"
              >{{ fieldErrors.listenHost }}</small></label>
              <label class="field-control"><span>监听端口</span><input
                v-model.number="form.websocketListenPort"
                name="websocket-listen-port"
                type="number"
                min="1"
                max="65535"
                :aria-invalid="Boolean(fieldErrors.listenPort)"
              ><small
                v-if="fieldErrors.listenPort"
                class="field-error"
                role="alert"
              >{{ fieldErrors.listenPort }}</small></label>
              <label class="field-control endpoint-dialog__wide"><span>WebSocket 路径</span><input
                v-model="form.websocketPath"
                name="websocket-path"
                :aria-invalid="Boolean(fieldErrors.websocketPath)"
              ><small
                v-if="fieldErrors.websocketPath"
                class="field-error"
                role="alert"
              >{{ fieldErrors.websocketPath }}</small></label>
              <small class="field-note endpoint-dialog__wide">本地 ws 监听，最多 64 个客户端</small>
            </template>
            <label class="field-control endpoint-dialog__wide"><span>子协议（逗号分隔）</span><input
              v-model="form.websocketSubprotocols"
              name="websocket-subprotocols"
              :aria-invalid="Boolean(fieldErrors.subprotocols)"
            ><small
              v-if="fieldErrors.subprotocols"
              class="field-error"
              role="alert"
            >{{ fieldErrors.subprotocols }}</small></label>
            <div class="endpoint-dialog__message-options endpoint-dialog__wide">
              <label class="field-control"><span>默认消息类型</span><select
                v-model="form.websocketMessageType"
                name="websocket-message-type"
              ><option value="text">文本</option><option value="binary">二进制</option></select></label>
              <div class="endpoint-dialog__message-toggles">
                <label
                  v-if="form.transport === 'websocket-client'"
                  class="check-control"
                ><input
                  v-model="form.autoReconnect"
                  name="websocket-auto-reconnect"
                  type="checkbox"
                >自动重连</label>
                <label class="check-control"><input
                  v-model="form.websocketHeartbeatEnabled"
                  name="websocket-heartbeat-enabled"
                  type="checkbox"
                >Ping/Pong 心跳</label>
              </div>
            </div>
            <label class="field-control"><span>心跳间隔（毫秒）</span><input
              v-model.number="form.websocketHeartbeatIntervalMs"
              name="websocket-heartbeat-interval"
              type="number"
              min="1000"
              max="60000"
              :aria-invalid="Boolean(fieldErrors.heartbeat)"
            ></label>
            <label class="field-control"><span>Pong 超时（毫秒）</span><input
              v-model.number="form.websocketHeartbeatTimeoutMs"
              name="websocket-heartbeat-timeout"
              type="number"
              min="1000"
              max="60000"
            ></label>
            <small
              v-if="fieldErrors.heartbeat"
              class="field-error endpoint-dialog__wide"
              role="alert"
            >{{ fieldErrors.heartbeat }}</small>
            <template v-if="form.transport === 'websocket-client'">
              <div class="field-control endpoint-dialog__wide">
                <span>自定义请求头</span><small class="field-note">仅当前会话保留，不保存或导出；关闭应用后清除。</small>
              </div>
              <template
                v-for="(header, index) in form.websocketHeaders"
                :key="index"
              >
                <label class="field-control"><span>请求头名称 {{ index + 1 }}</span><input
                  v-model="header.name"
                  :name="`websocket-header-name-${index}`"
                  autocomplete="off"
                  :aria-invalid="Boolean(fieldErrors.websocketHeaders)"
                ></label>
                <label class="field-control"><span>请求头值 {{ index + 1 }}</span><div class="field-control__with-action"><input
                  v-model="header.value"
                  :name="`websocket-header-value-${index}`"
                  type="password"
                  autocomplete="off"
                ><button
                  type="button"
                  class="icon-button"
                  :aria-label="`删除请求头 ${index + 1}`"
                  @click="form.websocketHeaders.splice(index, 1)"
                ><Trash2 :size="14" /></button></div></label>
              </template>
              <button
                type="button"
                class="command-button command-button--quiet"
                :disabled="form.websocketHeaders.length >= 32"
                @click="form.websocketHeaders.push({ name: '', value: '' })"
              >
                添加请求头
              </button>
              <small
                v-if="fieldErrors.websocketHeaders"
                class="field-error endpoint-dialog__wide"
                role="alert"
              >{{ fieldErrors.websocketHeaders }}</small>
            </template>
          </template>

          <template v-if="isSerialTransport">
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
          <template v-else-if="form.transport === 'tcp-client'">
            <label class="field-control">
              <span>服务器地址</span>
              <input
                v-model="form.host"
                required
                placeholder="127.0.0.1"
                :aria-invalid="Boolean(fieldErrors.host)"
              >
              <small
                v-if="fieldErrors.host"
                class="field-error"
                role="alert"
              >{{ fieldErrors.host }}</small>
            </label>
            <label class="field-control">
              <span>服务器端口</span>
              <input
                v-model.number="form.port"
                type="number"
                min="1"
                max="65535"
                required
                :aria-invalid="Boolean(fieldErrors.port)"
              >
              <small
                v-if="fieldErrors.port"
                class="field-error"
                role="alert"
              >{{ fieldErrors.port }}</small>
            </label>
          </template>
          <template v-else-if="form.transport === 'tcp-server'">
            <label class="field-control">
              <span>监听地址</span>
              <input
                v-model="form.listenHost"
                required
                placeholder="0.0.0.0"
                :aria-invalid="Boolean(fieldErrors.listenHost)"
              >
              <small
                v-if="fieldErrors.listenHost"
                class="field-error"
                role="alert"
              >{{ fieldErrors.listenHost }}</small>
            </label>
            <label class="field-control">
              <span>监听端口</span>
              <input
                v-model.number="form.listenPort"
                type="number"
                min="1"
                max="65535"
                required
                :aria-invalid="Boolean(fieldErrors.listenPort)"
              >
              <small
                v-if="fieldErrors.listenPort"
                class="field-error"
                role="alert"
              >{{ fieldErrors.listenPort }}</small>
            </label>
          </template>
          <template v-else-if="form.transport.startsWith('modbus-tcp-')">
            <label class="field-control">
              <span>{{ form.transport.endsWith('-master') ? '从站地址' : '监听地址' }}</span>
              <input
                v-if="form.transport.endsWith('-master')"
                v-model="form.modbusHost"
                name="modbus-host"
                placeholder="127.0.0.1"
                :aria-invalid="Boolean(fieldErrors.host)"
              >
              <input
                v-else
                v-model="form.modbusListenHost"
                name="modbus-listen-host"
                placeholder="0.0.0.0"
                :aria-invalid="Boolean(fieldErrors.listenHost)"
              >
              <small
                v-if="fieldErrors.host || fieldErrors.listenHost"
                class="field-error"
                role="alert"
              >
                {{ fieldErrors.host || fieldErrors.listenHost }}
              </small>
            </label>
            <label class="field-control">
              <span>{{ form.transport.endsWith('-master') ? '从站端口' : '监听端口' }}</span>
              <input
                v-if="form.transport.endsWith('-master')"
                v-model.number="form.modbusPort"
                name="modbus-port"
                type="number"
                min="1"
                max="65535"
                :aria-invalid="Boolean(fieldErrors.port)"
              >
              <input
                v-else
                v-model.number="form.modbusListenPort"
                name="modbus-listen-port"
                type="number"
                min="1"
                max="65535"
                :aria-invalid="Boolean(fieldErrors.listenPort)"
              >
              <small
                v-if="fieldErrors.port || fieldErrors.listenPort"
                class="field-error"
                role="alert"
              >
                {{ fieldErrors.port || fieldErrors.listenPort }}
              </small>
            </label>
          </template>
          <template v-else-if="form.transport.startsWith('udp-')">
            <label class="field-control">
              <span>本地绑定地址</span>
              <input
                v-model="form.bindHost"
                required
                placeholder="0.0.0.0"
                :aria-invalid="Boolean(fieldErrors.bindHost)"
              >
              <small
                v-if="fieldErrors.bindHost"
                class="field-error"
                role="alert"
              >{{ fieldErrors.bindHost }}</small>
            </label>
            <label class="field-control">
              <span>本地绑定端口</span>
              <input
                v-model.number="form.bindPort"
                type="number"
                min="1"
                max="65535"
                required
                :aria-invalid="Boolean(fieldErrors.bindPort)"
              >
              <small
                v-if="fieldErrors.bindPort"
                class="field-error"
                role="alert"
              >{{ fieldErrors.bindPort }}</small>
            </label>
            <label class="field-control">
              <span>默认目标地址{{ form.transport === 'udp-server' ? '（可选，主动发送时使用）' : '' }}</span>
              <input
                v-model="form.targetHost"
                :required="form.transport === 'udp-client'"
                placeholder="127.0.0.1"
                :aria-invalid="Boolean(fieldErrors.targetHost)"
              >
              <small
                v-if="fieldErrors.targetHost"
                class="field-error"
                role="alert"
              >{{ fieldErrors.targetHost }}</small>
            </label>
            <label class="field-control">
              <span>默认目标端口{{ form.transport === 'udp-server' ? '（可选）' : '' }}</span>
              <input
                v-model.number="form.targetPort"
                type="number"
                min="1"
                max="65535"
                :required="form.transport === 'udp-client'"
                :disabled="form.transport === 'udp-server' && !form.targetHost.trim()"
                :aria-invalid="Boolean(fieldErrors.targetPort)"
              >
              <small
                v-if="fieldErrors.targetPort"
                class="field-error"
                role="alert"
              >{{ fieldErrors.targetPort }}</small>
            </label>
            <p class="field-note endpoint-dialog__wide">
              每个 UDP 数据报独立显示为一帧。
            </p>
          </template>
          <template v-if="isModbusTransport">
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
          <template v-if="isTcpTransport">
            <fieldset class="endpoint-parameter-section endpoint-dialog__wide">
              <legend>TCP 连接与接收</legend>
              <div class="endpoint-dialog__option-row">
                <label class="endpoint-parameter-section__toggle">
                  <input
                    v-model="form.keepAlive"
                    name="tcp-keep-alive"
                    type="checkbox"
                  >
                  <span>TCP Keepalive</span>
                </label>
                <label
                  v-if="form.transport === 'tcp-client'"
                  class="endpoint-parameter-section__toggle"
                >
                  <input
                    v-model="form.autoReconnect"
                    name="tcp-auto-reconnect"
                    type="checkbox"
                  >
                  <span>自动重连</span>
                </label>
              </div>
              <label class="field-control">
                <span>首次探测延迟（秒）</span>
                <input
                  v-model.number="form.keepAliveInitialDelaySeconds"
                  name="tcp-keep-alive-delay"
                  type="number"
                  min="1"
                  max="3600"
                  step="1"
                  :disabled="!form.keepAlive"
                  :aria-invalid="Boolean(fieldErrors.keepAliveInitialDelaySeconds)"
                >
                <small
                  v-if="fieldErrors.keepAliveInitialDelaySeconds"
                  class="field-error"
                  role="alert"
                >{{ fieldErrors.keepAliveInitialDelaySeconds }}</small>
              </label>
              <label
                class="field-control"
                :class="{ 'endpoint-dialog__wide': form.receiveFramingMode === 'raw' }"
              >
                <span>接收分帧</span>
                <select
                  v-model="form.receiveFramingMode"
                  name="tcp-receive-framing"
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
                  name="tcp-receive-delimiter"
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
                  name="tcp-receive-length"
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
                  name="tcp-receive-idle-ms"
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
            </fieldset>
          </template>
          <p
            v-if="saveError"
            class="endpoint-dialog__error"
            role="alert"
          >
            {{ saveError }}
          </p>
        </div>
        <footer>
          <button
            type="button"
            class="command-button command-button--quiet"
            :disabled="saving"
            @click="requestClose"
          >
            取消
          </button>
          <button
            type="submit"
            class="command-button"
            :disabled="saving || (Boolean(endpoint) && !form.name.trim())"
          >
            <LoaderCircle
              v-if="saving"
              :size="15"
              class="spin"
            />
            {{ saving ? '正在保存' : '保存端点' }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>
