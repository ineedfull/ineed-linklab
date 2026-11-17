<script setup>
import MasterConnectionSummary from './modbus-master/MasterConnectionSummary.vue';
import MasterLiveReadings from './modbus-master/MasterLiveReadings.vue';
import MasterTransactionDiagnostics from './modbus-master/MasterTransactionDiagnostics.vue';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight,
  Copy, Pencil, Play, Plus, Power, Send, Square, Trash2,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, reactive, ref, toRef, watch } from 'vue';

import {
  createModbusMasterPresentation, formatRaw, formatTime,
  transactionIdentity, writeAddressRange,
} from '../model/modbusMasterPresentation.js';
import {
  cloneModbusRequest,
  cloneModbusRequestGroup,
  normalizeModbusMasterConfig,
} from '../model/modbusMasterConfig.js';
import {
  cloneModbusWriteCommand,
  normalizeModbusWriteCommand,
  validateModbusWriteCommands,
} from '../model/modbusWriteCommands.js';
import { createModbusMasterWriteController } from '../model/modbusMasterWriteController.js';
import ModbusRequestDialog from './ModbusRequestDialog.vue';
import ModbusPointTrends from './ModbusPointTrends.vue';
import ModbusRequestGroupDialog from './ModbusRequestGroupDialog.vue';
import ModbusWriteCommandDialog from './ModbusWriteCommandDialog.vue';

const props = defineProps({
  endpoint: { type: Object, required: true },
  runtime: { type: Object, required: true },
  running: Boolean,
  sessionId: { type: String, default: null },
  scheduler: { type: Object, required: true },
  saveCommand: { type: Function, required: true },
  collectorStatus: { type: Object, default: null },
});

const TABS = Object.freeze([
  ['live', '实时数据'], ['groups', '请求组'], ['settings', '基础配置'],
  ['records', '报文诊断'], ['write', '写入操作'], ['trends', '数据趋势'],
]);
const FUNCTIONS = Object.freeze({
  1: 'FC01 读取线圈', 2: 'FC02 读取离散输入',
  3: 'FC03 读取保持寄存器', 4: 'FC04 读取输入寄存器',
});
const WRITE_FUNCTIONS = Object.freeze({
  5: 'FC05 写入单个线圈', 6: 'FC06 写入单个寄存器',
  15: 'FC15 写入多个线圈', 16: 'FC16 写入多个寄存器',
});
const config = ref(normalizeModbusMasterConfig(props.endpoint.config));
const activeTab = ref(config.value.requestGroups.length ? 'live' : 'groups');
const schedulerStatus = ref(props.scheduler.getStatus(props.endpoint.id));
const groupDialogOpen = ref(false);
const requestDialogOpen = ref(false);
const editingGroup = ref(null);
const editingRequest = ref(null);
const requestGroup = ref(null);
const expandedRequests = ref(new Set());
const saving = ref(false);
const writeState = reactive({
  actionError: '', results: new Map(), confirmation: null,
  writingCommandId: null, deleteConfirmation: null,
});
const actionError = toRef(writeState, 'actionError');
const transactions = ref([]);
const selectedTransaction = ref(null);
const quickReadResult = ref(null);
const writeResults = toRef(writeState, 'results');
const writeDialogOpen = ref(false);
const editingWriteCommand = ref(null);
const deleteConfirmation = toRef(writeState, 'deleteConfirmation');
const writeConfirmation = toRef(writeState, 'confirmation');
const writingCommandId = toRef(writeState, 'writingCommandId');
const writeController = createModbusMasterWriteController({
  state: writeState,
  getContext: () => ({
    endpointId: props.endpoint.id,
    sessionId: props.sessionId,
    running: props.running,
    config: config.value,
  }),
  scheduler: { executeImmediate: (request) => props.scheduler.executeImmediate(request) },
  validateCommand: writeCommandError,
  recordTransaction,
});
let nextId = 0;
let persistenceGeneration = 0;
let disposed = false;

const quickRead = reactive({ functionCode: 3, unitId: config.value.unitId, address: 0, quantity: 10 });

const orderedGroups = computed(() => [...config.value.requestGroups]
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)));
const orderedWriteCommands = computed(() => [...config.value.writeCommands]
  .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)));
const writeCommandErrors = computed(() => validateModbusWriteCommands(config.value.writeCommands));
const enabledGroupCount = computed(() => config.value.requestGroups.filter(({ enabled }) => enabled).length);
const enabledWriteCommandCount = computed(() => (
  config.value.writeCommands.filter(({ enabled }) => enabled).length
));
const enabledRequestCount = computed(() => config.value.requestGroups.reduce((total, group) => (
  total + (group.enabled ? group.requests.filter(({ enabled }) => enabled).length : 0)
), 0));
const liveGroups = computed(() => orderedGroups.value.map((group) => {
  const groupStatus = schedulerStatus.value.groups?.[group.id];
  const rows = orderedRequests(group).flatMap((request) => {
    const requestStatus = groupStatus?.requests?.[request.id];
    return request.dataPoints.map((point) => {
      const reading = liveReading(group, request, point, requestStatus);
      return {
        group, request, point, reading, requestStatus,
        displayQuality: reading.quality !== 'disabled' && !hasRequestAttempt(requestStatus)
          ? 'waiting'
          : reading.quality,
      };
    });
  });
  const requestStatuses = Object.values(groupStatus?.requests ?? {});
  const timestamps = requestStatuses.flatMap((status) => (
    [status.lastSuccessAt, status.lastFailureAt].filter(Boolean)
  ));
  return {
    group,
    rows,
    goodCount: rows.filter(({ reading }) => reading.quality === 'good').length,
    badCount: rows.filter(({ reading, requestStatus }) => (
      reading.quality !== 'good'
      && reading.quality !== 'disabled'
      && hasRequestAttempt(requestStatus)
    )).length,
    waitingCount: rows.filter(({ reading, requestStatus }) => (
      reading.quality !== 'disabled' && !hasRequestAttempt(requestStatus)
    )).length,
    disabledCount: rows.filter(({ reading }) => reading.quality === 'disabled').length,
    lastUpdatedAt: timestamps.length ? Math.max(...timestamps) : null,
    lastError: requestStatuses.find(({ lastError }) => lastError)?.lastError ?? '',
  };
}));
const records = computed(() => schedulerStatus.value.records ?? []);
const presentation = computed(() => createModbusMasterPresentation({
  endpoint: props.endpoint,
  sessionId: props.sessionId,
  config: config.value,
  records: records.value,
}));
const diagnosticTransactions = computed(() => {
  const entries = [...transactions.value];
  const identities = new Set(entries.map((transaction) => transactionIdentity(transaction)));
  for (const record of records.value) {
    const transaction = record.transaction ?? presentation.value.transactionFromRecord(record);
    if (!transaction) continue;
    const identity = transactionIdentity(transaction);
    if (identities.has(identity)) continue;
    entries.push(transaction);
    identities.add(identity);
  }
  return entries
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, 200);
});
const connectionAddress = computed(() => (
  props.endpoint.transport === 'modbus-tcp-master'
    ? `${config.value.host}:${config.value.port}`
    : `${config.value.path ?? '未设置串口'} · ${config.value.baudRate ?? 9600} baud`
));

function liveReading(group, request, point, requestStatus) {
  if (!group.enabled || !request.enabled || !point.enabled) {
    return { display: '—', raw: [], quality: 'disabled', reason: '当前配置已停用' };
  }
  return requestStatus?.points?.[point.id] ?? {
    display: '—', raw: [], quality: 'bad-communication', reason: '尚未读取',
  };
}

function hasRequestAttempt(status) {
  return Boolean(
    status?.lastAttemptAt
    || status?.lastSuccessAt
    || status?.lastFailureAt
    || status?.lastError
    || status?.successCount
    || status?.failureCount,
  );
}

watch(() => props.endpoint, (endpoint, previousEndpoint) => {
  persistenceGeneration += 1;
  saving.value = false;
  config.value = normalizeModbusMasterConfig(endpoint.config);
  quickRead.unitId = config.value.unitId;
  schedulerStatus.value = props.scheduler.getStatus(endpoint.id);
  actionError.value = '';
  quickReadResult.value = null;
  writeConfirmation.value = null;
  deleteConfirmation.value = null;
  writeDialogOpen.value = false;
  groupDialogOpen.value = false;
  requestDialogOpen.value = false;
  expandedRequests.value = new Set();
  if (previousEndpoint && endpoint.id !== previousEndpoint.id) {
    writeResults.value = new Map();
    transactions.value = [];
    selectedTransaction.value = null;
  }
}, { deep: true });

watch(() => props.sessionId, () => {
  writeConfirmation.value = null;
});

watch(diagnosticTransactions, (entries) => {
  if (entries.length === 0) {
    selectedTransaction.value = null;
    return;
  }
  const selectedIdentity = selectedTransaction.value
    ? transactionIdentity(selectedTransaction.value)
    : null;
  if (!selectedIdentity || !entries.some((entry) => transactionIdentity(entry) === selectedIdentity)) {
    [selectedTransaction.value] = entries;
  }
}, { immediate: true });

const unsubscribeScheduler = props.scheduler.subscribe((endpointId, status) => {
  if (endpointId === props.endpoint.id) schedulerStatus.value = status;
});
const unsubscribeTransactions = props.runtime.modbus.onTransactions((transaction) => {
  if (transaction?.endpointId === props.endpoint.id) recordTransaction(transaction);
});

function newGroup() {
  if (saving.value) return;
  actionError.value = '';
  editingGroup.value = null;
  groupDialogOpen.value = true;
}

function editGroup(group) {
  if (saving.value) return;
  actionError.value = '';
  editingGroup.value = group;
  groupDialogOpen.value = true;
}

async function saveGroup(group) {
  const groups = editingGroup.value
    ? config.value.requestGroups.map((item) => item.id === group.id ? group : item)
    : [...config.value.requestGroups, { ...group, order: config.value.requestGroups.length }];
  if (await persistGroups(groups)) groupDialogOpen.value = false;
}

function newRequest(group) {
  if (saving.value) return;
  actionError.value = '';
  requestGroup.value = group;
  editingRequest.value = null;
  requestDialogOpen.value = true;
}

function editRequest(group, request) {
  if (saving.value) return;
  actionError.value = '';
  requestGroup.value = group;
  editingRequest.value = request;
  requestDialogOpen.value = true;
}

async function saveRequest(request) {
  const group = requestGroup.value;
  if (!group) return;
  const requests = editingRequest.value
    ? group.requests.map((item) => item.id === request.id ? request : item)
    : [...group.requests, { ...request, order: group.requests.length }];
  if (await replaceGroup(group.id, { ...group, requests })) requestDialogOpen.value = false;
}

async function copyRequest(group, request) {
  const existingPointKeys = group.requests.flatMap(({ dataPoints }) => (
    dataPoints.map(({ key }) => key)
  ));
  const copy = cloneModbusRequest(request, (kind) => uniqueId(kind), existingPointKeys);
  copy.order = group.requests.length;
  await replaceGroup(group.id, { ...group, requests: [...group.requests, copy] });
}

async function toggleRequest(group, request) {
  const requests = group.requests.map((item) => (
    item.id === request.id ? { ...item, enabled: !item.enabled } : item
  ));
  await replaceGroup(group.id, {
    ...group,
    enabled: requests.some(({ enabled }) => enabled),
    requests,
  });
}

async function removeRequest(group, request) {
  await replaceGroup(group.id, {
    ...group,
    requests: group.requests.filter(({ id }) => id !== request.id),
  });
}

async function moveRequest(group, request, delta) {
  const requests = [...group.requests]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const index = requests.findIndex(({ id }) => id === request.id);
  const target = index + delta;
  if (target < 0 || target >= requests.length) return;
  [requests[index], requests[target]] = [requests[target], requests[index]];
  await replaceGroup(group.id, {
    ...group,
    requests: requests.map((item, order) => ({ ...item, order })),
  });
}

async function copyGroup(group) {
  const copy = cloneModbusRequestGroup(group, (kind) => uniqueId(kind));
  copy.order = config.value.requestGroups.length;
  await persistGroups([...config.value.requestGroups, copy]);
}

async function toggleGroup(group) {
  const enabled = groupEnablementState(group) !== 'enabled';
  await replaceGroup(group.id, {
    ...group,
    enabled,
    requests: group.requests.map((request) => ({ ...request, enabled })),
  });
}

function requestGroupDeletion(group) {
  writeConfirmation.value = null;
  deleteConfirmation.value = { type: 'group', item: group };
}

async function moveGroup(group, delta) {
  const groups = [...orderedGroups.value];
  const index = groups.findIndex(({ id }) => id === group.id);
  const target = index + delta;
  if (target < 0 || target >= groups.length) return;
  [groups[index], groups[target]] = [groups[target], groups[index]];
  await persistGroups(groups.map((item, order) => ({ ...item, order })));
}

async function replaceGroup(id, replacement) {
  return persistGroups(config.value.requestGroups
    .map((group) => group.id === id ? replacement : group));
}

async function persistGroups(groups) {
  return persistConfig({
    requestGroups: groups.map((group, order) => ({ ...group, order })),
  });
}

async function persistCommands(commands) {
  const persisted = await persistConfig({
    writeCommands: commands.map((command, order) => ({ ...command, order })),
  });
  if (persisted) writeConfirmation.value = null;
  return persisted;
}

async function persistConfig(patch) {
  if (saving.value) return false;
  const generation = ++persistenceGeneration;
  const isCurrent = () => !disposed && generation === persistenceGeneration;
  saving.value = true;
  actionError.value = '';
  const normalized = normalizeModbusMasterConfig({
    ...config.value,
    ...patch,
  });
  try {
    const outcome = await props.saveCommand({
      ...props.endpoint,
      config: { ...props.endpoint.config, ...normalized },
    });
    if (!isCurrent()) return false;
    if (outcome?.ok === false) throw outcome.error ?? new Error('无法保存主站配置。');
    config.value = normalized;
    return true;
  } catch (reason) {
    if (isCurrent()) actionError.value = errorMessage(reason);
    return false;
  } finally {
    if (isCurrent()) saving.value = false;
  }
}

function newWriteCommand() {
  if (saving.value) return;
  actionError.value = '';
  editingWriteCommand.value = null;
  writeConfirmation.value = null;
  writeDialogOpen.value = true;
}

function editWriteCommand(command) {
  if (saving.value) return;
  actionError.value = '';
  editingWriteCommand.value = command;
  writeConfirmation.value = null;
  writeDialogOpen.value = true;
}

async function saveWriteCommand(command) {
  const normalized = normalizeModbusWriteCommand(command);
  const commands = editingWriteCommand.value
    ? config.value.writeCommands.map((item) => item.id === normalized.id ? normalized : item)
    : [...config.value.writeCommands, { ...normalized, order: config.value.writeCommands.length }];
  if (await persistCommands(commands)) writeDialogOpen.value = false;
}

async function copyWriteCommand(command) {
  const copy = cloneModbusWriteCommand(command, (kind) => uniqueId(kind));
  copy.order = config.value.writeCommands.length;
  await persistCommands([...config.value.writeCommands, copy]);
}

async function toggleWriteCommand(command) {
  await persistCommands(config.value.writeCommands.map((item) => (
    item.id === command.id ? { ...item, enabled: !item.enabled } : item
  )));
}

async function moveWriteCommand(command, delta) {
  const commands = [...orderedWriteCommands.value];
  const index = commands.findIndex(({ id }) => id === command.id);
  const target = index + delta;
  if (target < 0 || target >= commands.length) return;
  [commands[index], commands[target]] = [commands[target], commands[index]];
  await persistCommands(commands);
}

function requestWriteCommandDeletion(command) {
  writeConfirmation.value = null;
  deleteConfirmation.value = { type: 'write-command', item: command };
}

async function confirmDeletion() {
  const pending = deleteConfirmation.value;
  if (!pending) return;
  const persisted = pending.type === 'group'
    ? await persistGroups(config.value.requestGroups.filter(({ id }) => id !== pending.item.id))
    : await persistCommands(config.value.writeCommands.filter(({ id }) => id !== pending.item.id));
  if (persisted) deleteConfirmation.value = null;
}

function startPolling() {
  if (!props.running || !props.sessionId) return;
  props.scheduler.start({ endpointId: props.endpoint.id, sessionId: props.sessionId, config: config.value });
  schedulerStatus.value = props.scheduler.getStatus(props.endpoint.id);
}

function stopPolling() {
  props.scheduler.stop(props.endpoint.id, props.sessionId ?? undefined);
  schedulerStatus.value = props.scheduler.getStatus(props.endpoint.id);
}

async function runGroup(group) {
  if (!props.running || !props.sessionId) return;
  actionError.value = '';
  try {
    await props.scheduler.runGroup({
      endpointId: props.endpoint.id, sessionId: props.sessionId,
      config: config.value, groupId: group.id,
    });
    schedulerStatus.value = props.scheduler.getStatus(props.endpoint.id);
  } catch (reason) {
    actionError.value = errorMessage(reason);
  }
}

async function runRequest(group, request) {
  if (!props.running || !props.sessionId) return;
  actionError.value = '';
  try {
    await props.scheduler.runRequest({
      endpointId: props.endpoint.id,
      sessionId: props.sessionId,
      config: config.value,
      groupId: group.id,
      requestId: request.id,
    });
    schedulerStatus.value = props.scheduler.getStatus(props.endpoint.id);
  } catch (reason) {
    actionError.value = errorMessage(reason);
  }
}

function toggleExpandedRequest(groupId, requestId) {
  expandedRequests.value = toggledSet(expandedRequests.value, `${groupId}:${requestId}`);
}

function toggledSet(collection, key) {
  const next = new Set(collection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function requestCount(group) {
  return group.requests.length;
}

function enabledRequestsInGroup(group) {
  return group.requests.filter(({ enabled }) => enabled).length;
}

function groupEnablementState(group) {
  if (!group.enabled) return 'disabled';
  if (group.requests.length === 0 || enabledRequestsInGroup(group) === group.requests.length) {
    return 'enabled';
  }
  return enabledRequestsInGroup(group) === 0 ? 'disabled' : 'partial';
}

function groupEnablementLabel(group) {
  return ({ enabled: '启用', partial: '部分启用', disabled: '停用' })[groupEnablementState(group)];
}

function pointCount(group) {
  return group.requests.reduce((total, request) => total + request.dataPoints.length, 0);
}

function enabledPointCount(request) {
  return request.dataPoints.filter(({ enabled }) => enabled).length;
}

function orderedRequests(group) {
  return [...group.requests]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function requestState(group, request) {
  return schedulerStatus.value.groups?.[group.id]?.requests?.[request.id];
}

function requestResult(group, request) {
  const status = requestState(group, request);
  if (status?.lastError) return status.lastError;
  return status?.lastSuccessAt ? `${status.durationMs} ms` : '尚未执行';
}

function groupResult(group) {
  const result = schedulerStatus.value.groups?.[group.id]?.lastResult;
  return ({ success: '成功', partial: '部分失败', failed: '失败', skipped: '无可执行请求' })[result]
    ?? '尚未执行';
}

function requestAddressLabel(request) {
  if (config.value.addressNotation !== 'reference') return String(request.startAddress);
  const base = { 1: 1, 2: 10_001, 3: 40_001, 4: 30_001 }[request.functionCode];
  return String(base + request.startAddress).padStart(5, '0');
}

function pointAddressLabel(request, point) {
  return requestAddressLabel({
    functionCode: request.functionCode,
    startAddress: request.startAddress + point.offset,
  });
}

async function executeQuickRead() {
  if (!props.running) return;
  actionError.value = '';
  try {
    const transaction = await props.scheduler.executeImmediate({
      endpointId: props.endpoint.id, sessionId: props.sessionId, config: config.value,
      request: {
        functionCode: Number(quickRead.functionCode), unitId: Number(quickRead.unitId),
        address: Number(quickRead.address), quantity: Number(quickRead.quantity), values: [],
      },
    });
    quickReadResult.value = transaction;
    recordTransaction(transaction);
  } catch (reason) {
    actionError.value = errorMessage(reason);
    if (reason?.transaction) {
      quickReadResult.value = reason.transaction;
      recordTransaction(reason.transaction);
    }
  }
}

function requestWriteConfirmation(command) {
  writeController.requestConfirmation(command);
}

async function confirmWrite() {
  await writeController.confirm();
}

function writeResultText(commandId) {
  const result = writeResults.value.get(commandId);
  if (!result) return '尚未执行';
  const timestamp = formatTime(result.createdAt);
  if (!result.success) return `${result.error ?? '写入失败'} · ${timestamp}`;
  return `写入成功 · ${timestamp} · ${result.durationMs ?? '—'} ms`;
}

function writeCommandError(command) {
  const index = config.value.writeCommands.findIndex((item) => item === command);
  if (index < 0) return '写入指令不存在。';
  const prefix = `writeCommand-${index}-`;
  return Object.entries(writeCommandErrors.value)
    .find(([key]) => key === `writeCommand-${index}` || key.startsWith(prefix))?.[1] ?? '';
}

function recordTransaction(transaction) {
  if (!transaction) return;
  const identity = transactionIdentity(transaction);
  const duplicate = transactions.value.some((item) => transactionIdentity(item) === identity);
  if (!duplicate) {
    transactions.value = [transaction, ...transactions.value].slice(0, 200);
    selectedTransaction.value ??= transaction;
  }
}

function uniqueId(kind) {
  nextId += 1;
  return `${kind}-${Date.now()}-${nextId}`;
}

function errorMessage(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

onBeforeUnmount(() => {
  disposed = true;
  persistenceGeneration += 1;
  unsubscribeScheduler?.();
  unsubscribeTransactions?.();
});
</script>

<template>
  <section class="modbus-master-panel">
    <nav
      class="modbus-master-tabs"
      role="tablist"
      aria-label="Modbus 主站视图"
    >
      <button
        v-for="[key, label] in TABS"
        :key="key"
        type="button"
        role="tab"
        :aria-selected="activeTab === key"
        :class="{ active: activeTab === key }"
        @click="activeTab = key"
      >
        {{ label }}
      </button>
    </nav>

    <div class="modbus-master-panel__content">
      <MasterConnectionSummary
        v-if="activeTab === 'settings'"
        :endpoint="endpoint"
        :config="config"
        :running="running"
        :enabled-group-count="enabledGroupCount"
        :connection-address="connectionAddress"
      />

      <section
        v-else-if="activeTab === 'groups'"
        class="modbus-master-groups"
      >
        <header class="modbus-master-toolbar">
          <div><strong>读取请求组</strong><span>{{ enabledGroupCount }} / {{ config.requestGroups.length }} 组已启用 · {{ enabledRequestCount }} 个请求参与轮询</span></div>
          <div>
            <button
              v-if="schedulerStatus.active"
              type="button"
              class="command-button command-button--quiet"
              @click="stopPolling"
            >
              <Square :size="13" />停止轮询
            </button>
            <button
              v-else
              type="button"
              class="command-button command-button--quiet"
              :disabled="!running || !sessionId || enabledGroupCount === 0"
              @click="startPolling"
            >
              <Play :size="14" />启动轮询
            </button>
            <button
              type="button"
              class="command-button"
              aria-label="新增请求组"
              @click="newGroup"
            >
              <Plus :size="14" />新增请求组
            </button>
          </div>
        </header>

        <form
          class="modbus-quick-read"
          aria-label="临时读取"
          @submit.prevent="executeQuickRead"
        >
          <strong>临时读取</strong>
          <label><span>功能码</span><select v-model.number="quickRead.functionCode"><option
            v-for="(label, code) in FUNCTIONS"
            :key="code"
            :value="Number(code)"
          >{{ label }}</option></select></label>
          <label><span>从站 ID</span><input
            v-model.number="quickRead.unitId"
            type="number"
            min="1"
            max="247"
          ></label>
          <label><span>起始地址</span><input
            v-model.number="quickRead.address"
            type="number"
            min="0"
            max="65535"
          ></label>
          <label><span>数量</span><input
            v-model.number="quickRead.quantity"
            type="number"
            min="1"
            :max="quickRead.functionCode <= 2 ? 2000 : 125"
          ></label>
          <button
            type="submit"
            class="command-button command-button--quiet"
            :disabled="!running"
          >
            <Send :size="14" />读取一次
          </button>
        </form>
        <div
          v-if="quickReadResult"
          class="modbus-quick-read-result"
          :class="{ failed: !quickReadResult.success }"
        >
          <strong>{{ quickReadResult.success ? '读取成功' : '读取失败' }}</strong>
          <span>FC{{ String(quickReadResult.functionCode).padStart(2, '0') }} · 地址 {{ quickReadResult.address }} · {{ quickReadResult.durationMs }} ms</span>
          <code>{{ quickReadResult.success ? formatRaw(quickReadResult.values) : (quickReadResult.message ?? '未知错误') }}</code>
        </div>

        <div class="modbus-request-groups">
          <section
            v-for="(group, groupIndex) in orderedGroups"
            :key="group.id"
            :data-request-group-id="group.id"
            class="modbus-request-group"
            :class="{ disabled: !group.enabled }"
          >
            <header class="modbus-request-group__header">
              <span
                class="status-indicator modbus-request-group__status"
                :class="`status-indicator--${groupEnablementState(group)}`"
              ><i />{{ groupEnablementLabel(group) }}</span>
              <div class="modbus-request-group__identity">
                <strong>{{ group.name }}</strong>
                <small>Slave {{ group.unitId }}<template v-if="group.description"> · {{ group.description }}</template></small>
              </div>
              <div class="modbus-request-group__counts">
                <span>{{ requestCount(group) }} 个请求</span>
                <span>{{ pointCount(group) }} 个数据点</span>
                <span>{{ groupResult(group) }}</span>
              </div>
              <div class="table-actions">
                <button
                  type="button"
                  class="icon-button"
                  :disabled="!running || !sessionId || enabledRequestsInGroup(group) === 0"
                  :aria-label="`单次执行请求组 ${group.name}`"
                  title="执行请求组"
                  @click="runGroup(group)"
                >
                  <Play :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button status-action"
                  :aria-label="`${groupEnablementState(group) === 'enabled' ? '停用' : '启用'}请求组 ${group.name}`"
                  :title="`${groupEnablementState(group) === 'enabled' ? '停用' : '启用'}请求组`"
                  @click="toggleGroup(group)"
                >
                  <Power :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="`新增请求到 ${group.name}`"
                  title="新增请求"
                  @click="newRequest(group)"
                >
                  <Plus :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="`编辑请求组 ${group.name}`"
                  title="编辑请求组"
                  @click="editGroup(group)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="`复制请求组 ${group.name}`"
                  title="复制请求组"
                  @click="copyGroup(group)"
                >
                  <Copy :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :disabled="groupIndex === 0"
                  :aria-label="`上移请求组 ${group.name}`"
                  title="上移"
                  @click="moveGroup(group, -1)"
                >
                  <ArrowUp :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :disabled="groupIndex === orderedGroups.length - 1"
                  :aria-label="`下移请求组 ${group.name}`"
                  title="下移"
                  @click="moveGroup(group, 1)"
                >
                  <ArrowDown :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button danger"
                  :aria-label="`删除请求组 ${group.name}`"
                  title="删除请求组"
                  @click="requestGroupDeletion(group)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </header>

            <div class="modbus-request-group__body">
              <div
                v-if="group.requests.length"
                class="modbus-result-table modbus-request-table"
              >
                <table>
                  <thead><tr><th>状态</th><th>请求</th><th>功能与范围</th><th>请求帧模板（HEX）</th><th>运行信息</th><th>操作</th></tr></thead>
                  <tbody>
                    <template
                      v-for="(request, requestIndex) in orderedRequests(group)"
                      :key="request.id"
                    >
                      <tr
                        :data-request-id="request.id"
                        :class="{ disabled: !request.enabled }"
                      >
                        <td>
                          <span
                            class="status-indicator modbus-request-status"
                            :class="request.enabled ? 'status-indicator--enabled' : 'status-indicator--disabled'"
                          ><i />{{ request.enabled ? '启用' : '停用' }}</span>
                        </td>
                        <td>
                          <button
                            type="button"
                            class="modbus-request-name"
                            :aria-label="`${expandedRequests.has(`${group.id}:${request.id}`) ? '收起' : '展开'}请求 ${request.name}`"
                            @click="toggleExpandedRequest(group.id, request.id)"
                          >
                            <ChevronDown
                              v-if="expandedRequests.has(`${group.id}:${request.id}`)"
                              :size="14"
                            /><ChevronRight
                              v-else
                              :size="14"
                            /><strong>{{ request.name }}</strong>
                          </button>
                        </td>
                        <td>{{ FUNCTIONS[request.functionCode] }} · {{ requestAddressLabel(request) }} +{{ request.quantity }}</td>
                        <td>
                          <code
                            class="modbus-request-command"
                            :title="presentation.requestFrameTitle()"
                          >{{ presentation.readRequestFrame(group, request) }}</code>
                        </td>
                        <td>
                          <div class="modbus-request-runtime">
                            <span>{{ request.intervalMs }} ms</span><span>数据点 {{ enabledPointCount(request) }} / {{ request.dataPoints.length }}</span><strong>{{ requestResult(group, request) }}</strong>
                          </div>
                        </td>
                        <td>
                          <div class="table-actions">
                            <button
                              type="button"
                              class="icon-button"
                              :disabled="!running || !sessionId"
                              :aria-label="`单次执行请求 ${request.name}`"
                              title="执行一次"
                              @click="runRequest(group, request)"
                            >
                              <Play :size="14" />
                            </button>
                            <button
                              type="button"
                              class="icon-button status-action"
                              :aria-label="`${request.enabled ? '停用' : '启用'}请求 ${request.name}`"
                              :title="`${request.enabled ? '停用' : '启用'}请求`"
                              @click="toggleRequest(group, request)"
                            >
                              <Power :size="14" />
                            </button>
                            <button
                              type="button"
                              class="icon-button"
                              :aria-label="`编辑请求 ${request.name}`"
                              title="编辑"
                              @click="editRequest(group, request)"
                            >
                              <Pencil :size="14" />
                            </button>
                            <button
                              type="button"
                              class="icon-button"
                              :aria-label="`复制请求 ${request.name}`"
                              title="复制"
                              @click="copyRequest(group, request)"
                            >
                              <Copy :size="14" />
                            </button>
                            <button
                              type="button"
                              class="icon-button"
                              :disabled="requestIndex === 0"
                              :aria-label="`上移请求 ${request.name}`"
                              title="上移"
                              @click="moveRequest(group, request, -1)"
                            >
                              <ArrowUp :size="14" />
                            </button>
                            <button
                              type="button"
                              class="icon-button"
                              :disabled="requestIndex === orderedRequests(group).length - 1"
                              :aria-label="`下移请求 ${request.name}`"
                              title="下移"
                              @click="moveRequest(group, request, 1)"
                            >
                              <ArrowDown :size="14" />
                            </button>
                            <button
                              type="button"
                              class="icon-button danger"
                              :aria-label="`删除请求 ${request.name}`"
                              title="删除"
                              @click="removeRequest(group, request)"
                            >
                              <Trash2 :size="14" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      <tr
                        v-if="expandedRequests.has(`${group.id}:${request.id}`)"
                        class="modbus-request-points-preview"
                      >
                        <td colspan="6">
                          <span
                            v-for="point in request.dataPoints"
                            :key="point.id"
                          ><strong>{{ point.name }}</strong>{{ point.key }} · +{{ point.offset }}</span>
                          <small v-if="request.dataPoints.length === 0">当前请求还没有数据点</small>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
              <p
                v-else
                class="table-empty"
              >
                当前请求组还没有请求
              </p>
            </div>
          </section>
          <p
            v-if="orderedGroups.length === 0"
            class="table-empty"
          >
            还没有请求组，请先按设备或业务新增请求组
          </p>
        </div>
      </section>

      <MasterLiveReadings
        v-else-if="activeTab === 'live'"
        :live-groups="liveGroups"
        :point-address-label="pointAddressLabel"
        @configure="activeTab = 'groups'"
      />

      <MasterTransactionDiagnostics
        v-else-if="activeTab === 'records'"
        v-model:selected-transaction="selectedTransaction"
        :presentation="presentation"
        :diagnostic-transactions="diagnosticTransactions"
      />

      <section
        v-else-if="activeTab === 'write'"
        class="modbus-master-write"
      >
        <header class="modbus-master-toolbar">
          <div><strong>保存的写入指令</strong><span>{{ enabledWriteCommandCount }} / {{ config.writeCommands.length }} 条已启用</span></div>
          <div>
            <button
              type="button"
              class="command-button"
              aria-label="新增写入指令"
              @click="newWriteCommand"
            >
              <Plus :size="14" />新增写入指令
            </button>
          </div>
        </header>
        <div class="modbus-write-command-list">
          <article
            v-for="(command, commandIndex) in orderedWriteCommands"
            :key="command.id"
            :data-write-command-id="command.id"
            class="modbus-write-command"
            :class="{ disabled: !command.enabled }"
          >
            <div class="modbus-write-command__summary">
              <span
                class="status-indicator modbus-write-command__status"
                :class="command.enabled ? 'status-indicator--enabled' : 'status-indicator--disabled'"
              ><i />{{ command.enabled ? '启用' : '停用' }}</span>
              <div class="modbus-write-command__identity">
                <strong>{{ command.name }}</strong><small v-if="command.description">{{ command.description }}</small>
              </div>
              <div class="modbus-write-command__metadata">
                <span>Slave {{ command.unitId }}</span><span>{{ WRITE_FUNCTIONS[command.functionCode] }}</span><span>{{ writeAddressRange(command) }}</span>
              </div>
              <div class="modbus-write-command__value">
                <span>写入值</span><code class="modbus-write-command__values">{{ formatRaw(command.values) }}</code>
              </div>
              <div class="table-actions">
                <button
                  type="button"
                  class="icon-button"
                  :disabled="!command.enabled || Boolean(writeCommandError(command)) || !running || !sessionId || Boolean(writingCommandId)"
                  :aria-label="`执行写入指令 ${command.name}`"
                  :title="writeCommandError(command) || '执行写入指令'"
                  @click="requestWriteConfirmation(command)"
                >
                  <Play :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button status-action"
                  :aria-label="`${command.enabled ? '停用' : '启用'}写入指令 ${command.name}`"
                  :title="`${command.enabled ? '停用' : '启用'}写入指令`"
                  @click="toggleWriteCommand(command)"
                >
                  <Power :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="`编辑写入指令 ${command.name}`"
                  title="编辑"
                  @click="editWriteCommand(command)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="`复制写入指令 ${command.name}`"
                  title="复制"
                  @click="copyWriteCommand(command)"
                >
                  <Copy :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :disabled="commandIndex === 0"
                  :aria-label="`上移写入指令 ${command.name}`"
                  title="上移"
                  @click="moveWriteCommand(command, -1)"
                >
                  <ArrowUp :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :disabled="commandIndex === orderedWriteCommands.length - 1"
                  :aria-label="`下移写入指令 ${command.name}`"
                  title="下移"
                  @click="moveWriteCommand(command, 1)"
                >
                  <ArrowDown :size="14" />
                </button>
                <button
                  type="button"
                  class="icon-button danger"
                  :aria-label="`删除写入指令 ${command.name}`"
                  title="删除"
                  @click="requestWriteCommandDeletion(command)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
            <div class="modbus-write-command__frame modbus-write-command__pdu">
              <span>请求帧模板（HEX）</span><code :title="presentation.requestFrameTitle()">{{ presentation.writeCommandFrame(command) }}</code>
            </div>
            <footer class="modbus-write-command__footer">
              <span
                class="modbus-write-command__result"
                :class="{ failed: Boolean(writeCommandError(command)) || writeResults.get(command.id)?.success === false }"
              >{{ writeCommandError(command) ? `配置错误：${writeCommandError(command)}` : writeResultText(command.id) }}</span>
            </footer>
          </article>
          <div
            v-if="orderedWriteCommands.length === 0"
            class="modbus-write-command-empty"
          >
            <p>还没有写入指令</p>
            <button
              type="button"
              class="command-button command-button--quiet"
              aria-label="从空状态新增写入指令"
              @click="newWriteCommand"
            >
              <Plus :size="14" />新增写入指令
            </button>
          </div>
        </div>
        <div
          v-if="writeConfirmation"
          class="modbus-write-confirmation"
          role="alertdialog"
          aria-label="写入确认"
        >
          <div><strong>确认执行写入指令 {{ writeConfirmation.commandName }}</strong><span>Slave {{ writeConfirmation.unitId }} · FC{{ String(writeConfirmation.functionCode).padStart(2, '0') }} · 地址 {{ writeConfirmation.address }} · {{ writeConfirmation.quantity }} 个值</span><code>{{ writeConfirmation.values.join(', ') }}</code></div>
          <button
            type="button"
            class="command-button command-button--quiet"
            :aria-label="`取消执行写入指令 ${writeConfirmation.commandName}`"
            :disabled="Boolean(writingCommandId)"
            @click="writeConfirmation = null"
          >
            取消
          </button>
          <button
            type="button"
            class="command-button command-button--danger"
            :aria-label="`确认执行写入指令 ${writeConfirmation.commandName}`"
            :disabled="Boolean(writingCommandId)"
            @click="confirmWrite"
          >
            确认写入
          </button>
        </div>
      </section>

      <ModbusPointTrends
        v-else
        :key="endpoint.id"
        :endpoint="endpoint"
        :runtime="runtime"
        :config="config"
        :collector-status="collectorStatus"
      />
    </div>

    <div
      v-if="deleteConfirmation"
      class="modbus-delete-confirmation"
      role="alertdialog"
      aria-label="删除确认"
    >
      <div v-if="deleteConfirmation.type === 'group'">
        <strong>删除请求组 {{ deleteConfirmation.item.name }}</strong>
        <span>将删除 {{ requestCount(deleteConfirmation.item) }} 个请求和 {{ pointCount(deleteConfirmation.item) }} 个数据点。</span>
      </div>
      <div v-else>
        <strong>删除写入指令 {{ deleteConfirmation.item.name }}</strong>
        <span>删除后需要重新创建才能再次使用。</span>
      </div>
      <button
        type="button"
        class="command-button command-button--quiet"
        :aria-label="`取消删除${deleteConfirmation.type === 'group' ? '请求组' : '写入指令'} ${deleteConfirmation.item.name}`"
        :disabled="saving"
        @click="deleteConfirmation = null"
      >
        取消
      </button>
      <button
        type="button"
        class="command-button command-button--danger"
        :aria-label="`确认删除${deleteConfirmation.type === 'group' ? '请求组' : '写入指令'} ${deleteConfirmation.item.name}`"
        :disabled="saving"
        @click="confirmDeletion"
      >
        确认删除
      </button>
    </div>

    <p
      v-if="actionError"
      class="modbus-panel__error"
      role="alert"
    >
      {{ actionError }}
    </p>

    <ModbusRequestGroupDialog
      :open="groupDialogOpen"
      :saving="saving"
      :save-error="actionError"
      :group="editingGroup"
      :master-config="config"
      :existing-groups="config.requestGroups"
      @save="saveGroup"
      @cancel="groupDialogOpen = false"
    />
    <ModbusRequestDialog
      v-if="requestGroup"
      :open="requestDialogOpen"
      :saving="saving"
      :save-error="actionError"
      :request="editingRequest"
      :group="requestGroup"
      :master-config="config"
      :existing-requests="requestGroup.requests"
      @save="saveRequest"
      @cancel="requestDialogOpen = false"
    />
    <ModbusWriteCommandDialog
      :open="writeDialogOpen"
      :saving="saving"
      :save-error="actionError"
      :command="editingWriteCommand"
      :master-config="config"
      :existing-commands="config.writeCommands"
      @save="saveWriteCommand"
      @cancel="writeDialogOpen = false"
    />
  </section>
</template>
