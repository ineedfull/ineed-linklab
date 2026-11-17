<script setup>
import ProtocolEndpointFields from './endpoint-fields/ProtocolEndpointFields.vue';
import WebSocketEndpointFields from './endpoint-fields/WebSocketEndpointFields.vue';
import SerialEndpointFields from './endpoint-fields/SerialEndpointFields.vue';
import NetworkEndpointFields from './endpoint-fields/NetworkEndpointFields.vue';
import ModbusEndpointFields from './endpoint-fields/ModbusEndpointFields.vue';
import TcpResilienceFields from './endpoint-fields/TcpResilienceFields.vue';
import { isWebSocketTransport, snapshotWebSocketHeaders } from '../model/websocketConfig.js';
import { trapModalTab } from '../model/modalFocus.js';
import { createEndpointForm, buildEndpointConfig } from '../model/endpointDialogForm.js';
import { LoaderCircle, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

import { generateEndpointName, validateEndpointDraft } from '../model/endpointDraft.js';
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

          <ProtocolEndpointFields
            v-if="isProtocolEndpoint"
            :draft="form"
            :field-errors="fieldErrors"
            :connection-locked="connectionLocked"
          />
          <WebSocketEndpointFields
            v-else-if="isWebSocket"
            :draft="form"
            :field-errors="fieldErrors"
          />

          <SerialEndpointFields
            v-if="isSerialTransport"
            :draft="form"
            :field-errors="fieldErrors"
            :serial-ports="serialPorts"
            :scanning-ports="scanningPorts"
            :serial-scan-error="serialScanError"
            @scan-serial-ports="emit('scan-serial-ports')"
          />
          <NetworkEndpointFields
            v-else-if="isTcpTransport || form.transport.startsWith('modbus-tcp-') || form.transport.startsWith('udp-')"
            :draft="form"
            :field-errors="fieldErrors"
          />
          <ModbusEndpointFields
            v-if="isModbusTransport"
            :draft="form"
            :field-errors="fieldErrors"
          />
          <TcpResilienceFields
            v-if="isTcpTransport"
            :draft="form"
            :field-errors="fieldErrors"
          />
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
