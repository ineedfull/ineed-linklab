<script setup>
import { X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

import { createModalFocusTrap } from '../model/modalFocus.js';
import {
  normalizeModbusWriteCommand,
  validateModbusWriteCommands,
} from '../model/modbusWriteCommands.js';

const props = defineProps({
  open: Boolean,
  saving: Boolean,
  saveError: { type: String, default: '' },
  command: { type: Object, default: null },
  masterConfig: { type: Object, required: true },
  existingCommands: { type: Array, default: () => [] },
});
const emit = defineEmits(['save', 'cancel']);

let nextId = 0;
const dialogRef = ref(null);
const draft = reactive(emptyCommand());
const errors = ref({});
const errorPrefix = ref('writeCommand-0');
const errorMessages = computed(() => [...new Set(Object.values(errors.value))]);
const isCoil = computed(() => [5, 15].includes(Number(draft.functionCode)));
const valueHint = computed(() => (isCoil.value
  ? '使用 true、false、1 或 0，并以逗号分隔'
  : '使用 0 到 65535 的整数（支持 0x 十六进制），并以逗号分隔'));
const focusTrap = createModalFocusTrap({
  container: () => dialogRef.value,
  requestClose: cancel,
  isBusy: () => props.saving,
});

watch(() => [props.open, props.command], async ([open], previous = []) => {
  const [wasOpen] = previous;
  if (!open) {
    if (wasOpen) focusTrap.restore();
    return;
  }
  if (!wasOpen) focusTrap.capture();
  const command = props.command ? normalizeModbusWriteCommand(props.command) : emptyCommand();
  Object.assign(draft, command, { values: formatValues(command.values) });
  errors.value = {};
  await nextTick();
  focusTrap.activate('[name="modbus-write-command-name"]');
}, { immediate: true });

function emptyCommand() {
  return {
    id: uniqueId(),
    name: '',
    description: '',
    enabled: true,
    order: props.existingCommands.length,
    unitId: Number.isInteger(props.masterConfig?.unitId) ? props.masterConfig.unitId : 1,
    functionCode: 6,
    address: 0,
    values: '',
  };
}

function submit() {
  if (props.saving) return;
  const rawCandidate = {
    ...draft,
    unitId: Number(draft.unitId),
    functionCode: Number(draft.functionCode),
    address: Number(draft.address),
    values: parseValues(draft.values, Number(draft.functionCode)),
  };
  const peers = props.existingCommands.filter(({ id }) => id !== rawCandidate.id);
  const commands = [...peers, rawCandidate];
  const candidateIndex = commands.length - 1;
  const allErrors = validateModbusWriteCommands(commands);
  errorPrefix.value = `writeCommand-${candidateIndex}`;
  errors.value = Object.fromEntries(Object.entries(allErrors)
    .filter(([key]) => key.startsWith(errorPrefix.value)));
  if (Object.keys(errors.value).length > 0) return;
  emit('save', normalizeModbusWriteCommand(rawCandidate));
}

function parseValues(text, functionCode) {
  const tokens = String(text).split(',').map((part) => part.trim());
  return tokens.map((token) => (isCoilFunction(functionCode) ? parseCoil(token) : parseRegister(token)));
}

function parseCoil(token) {
  if (token === 'true' || token === '1') return true;
  if (token === 'false' || token === '0') return false;
  return token;
}

function parseRegister(token) {
  if (!token || !/^(?:0x[0-9a-f]+|\d+)$/i.test(token)) return token;
  return Number(token);
}

function isCoilFunction(functionCode) {
  return functionCode === 5 || functionCode === 15;
}

function formatValues(values) {
  if (Array.isArray(values)) return values.join(', ');
  return values === undefined || values === null ? '' : String(values);
}

function fieldError(field) {
  return errors.value[`${errorPrefix.value}-${field}`] ?? '';
}

function cancel() {
  if (!props.saving) emit('cancel');
}

function uniqueId() {
  nextId += 1;
  return `write-command-${Date.now()}-${nextId}`;
}

onBeforeUnmount(focusTrap.restore);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop modbus-write-command-dialog-backdrop"
      @mousedown.self="cancel"
      @keydown="focusTrap.handleKeydown"
    >
      <form
        ref="dialogRef"
        class="endpoint-dialog modbus-write-command-dialog"
        role="dialog"
        aria-modal="true"
        :aria-busy="saving"
        aria-labelledby="modbus-write-command-dialog-title"
        novalidate
        @submit.prevent="submit"
      >
        <header>
          <h2 id="modbus-write-command-dialog-title">
            {{ command ? '编辑写入指令' : '新增写入指令' }}
          </h2>
          <button
            type="button"
            class="icon-button"
            title="关闭"
            aria-label="关闭写入指令编辑器"
            :disabled="saving"
            @click="cancel"
          >
            <X :size="17" />
          </button>
        </header>

        <fieldset
          class="endpoint-dialog__body modbus-write-command-dialog__body"
          :disabled="saving"
        >
          <label class="field-control endpoint-dialog__wide">
            <span>指令名称</span>
            <input
              v-model="draft.name"
              name="modbus-write-command-name"
              :aria-invalid="Boolean(fieldError('name'))"
            >
            <span
              v-if="fieldError('name')"
              class="field-error"
              role="alert"
            >{{ fieldError('name') }}</span>
          </label>
          <label class="field-control endpoint-dialog__wide">
            <span>说明</span>
            <textarea
              v-model="draft.description"
              name="modbus-write-command-description"
              rows="2"
            />
          </label>
          <label class="checkbox-control endpoint-dialog__wide">
            <input
              v-model="draft.enabled"
              name="modbus-write-command-enabled"
              type="checkbox"
            >
            <span>启用指令</span>
          </label>
          <fieldset class="dialog-form-section dialog-form-section__fields endpoint-dialog__wide">
            <legend>写入目标</legend>
            <label class="field-control endpoint-dialog__wide">
              <span>功能码</span>
              <select
                v-model="draft.functionCode"
                name="modbus-write-command-function"
                :aria-invalid="Boolean(fieldError('functionCode'))"
              >
                <option :value="5">FC05 写入单个线圈</option>
                <option :value="6">FC06 写入单个寄存器</option>
                <option :value="15">FC15 写入多个线圈</option>
                <option :value="16">FC16 写入多个寄存器</option>
              </select>
              <span
                v-if="fieldError('functionCode')"
                class="field-error"
                role="alert"
              >{{ fieldError('functionCode') }}</span>
            </label>
            <label class="field-control">
              <span>从站 ID</span>
              <input
                v-model="draft.unitId"
                name="modbus-write-command-unit-id"
                type="number"
                min="1"
                max="247"
                :aria-invalid="Boolean(fieldError('unitId'))"
              >
              <span
                v-if="fieldError('unitId')"
                class="field-error"
                role="alert"
              >{{ fieldError('unitId') }}</span>
            </label>
            <label class="field-control">
              <span>地址</span>
              <input
                v-model="draft.address"
                name="modbus-write-command-address"
                type="number"
                min="0"
                max="65535"
                :aria-invalid="Boolean(fieldError('address'))"
              >
              <span
                v-if="fieldError('address')"
                class="field-error"
                role="alert"
              >{{ fieldError('address') }}</span>
            </label>
          </fieldset>
          <label class="field-control endpoint-dialog__wide">
            <span>写入值</span>
            <input
              v-model="draft.values"
              name="modbus-write-command-values"
              :placeholder="valueHint"
              :aria-invalid="Boolean(fieldError('values'))"
            >
            <small>{{ valueHint }}</small>
            <span
              v-if="fieldError('values')"
              class="field-error"
              role="alert"
            >{{ fieldError('values') }}</span>
          </label>
          <div
            v-if="errorMessages.length"
            class="endpoint-dialog__error"
            role="alert"
          >
            <span
              v-for="message in errorMessages"
              :key="message"
            >{{ message }}</span>
          </div>
          <p
            v-if="saveError"
            class="field-error endpoint-dialog__wide"
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
            {{ saving ? '正在保存…' : '保存指令' }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
fieldset.modbus-write-command-dialog__body { min-width: 0; margin: 0; border: 0; }
</style>
