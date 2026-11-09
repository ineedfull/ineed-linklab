<script setup>
import { X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { createModalFocusTrap } from '../model/modalFocus.js';

import {
  normalizeModbusRequestGroup,
  validateModbusRequestGroups,
} from '../model/modbusMasterConfig.js';

const props = defineProps({
  open: Boolean,
  saving: Boolean,
  saveError: { type: String, default: '' },
  group: { type: Object, default: null },
  masterConfig: { type: Object, required: true },
  existingGroups: { type: Array, default: () => [] },
});
const emit = defineEmits(['save', 'cancel']);

let nextId = 0;
const draft = reactive(emptyGroup());
const errors = ref({});
const errorMessages = computed(() => [...new Set(Object.values(errors.value))]);
const dialogRef = ref(null);
const focusTrap = createModalFocusTrap({ container: () => dialogRef.value, requestClose: cancel, isBusy: () => props.saving });

watch(() => [props.open, props.group], async ([open], previous = []) => {
  if (!open) { if (previous[0]) focusTrap.restore(); return; }
  if (!previous[0]) focusTrap.capture();
  Object.assign(draft, normalizeModbusRequestGroup(props.group ?? emptyGroup()));
  errors.value = {};
  await nextTick();
  if (props.open) focusTrap.activate('[name="request-group-name"]');
}, { immediate: true });
onBeforeUnmount(focusTrap.restore);
function cancel() { if (!props.saving) emit('cancel'); }

function emptyGroup() {
  return {
    id: uniqueId('group'),
    name: '',
    description: '',
    enabled: true,
    order: props.existingGroups.length,
    unitId: props.masterConfig.unitId ?? 1,
    requests: [],
  };
}

function submit() {
  if (props.saving) return;
  const candidate = { ...draft };
  const peers = props.existingGroups.filter(({ id }) => id !== candidate.id);
  const allErrors = validateModbusRequestGroups([...peers, candidate], props.masterConfig);
  const prefix = `requestGroup-${peers.length}`;
  errors.value = Object.fromEntries(Object.entries(allErrors)
    .filter(([key]) => key.startsWith(prefix) && !key.startsWith(`${prefix}-request-`)));
  if (Object.keys(errors.value).length > 0) return;
  emit('save', normalizeModbusRequestGroup(candidate));
}

function uniqueId(kind) {
  nextId += 1;
  return `${kind}-${Date.now()}-${nextId}`;
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
      class="endpoint-dialog modbus-group-dialog modbus-group-dialog--metadata"
      role="dialog"
      aria-modal="true"
      :aria-busy="saving"
      aria-labelledby="modbus-group-dialog-title"
      novalidate
      @submit.prevent="submit"
    >
      <header>
        <h2 id="modbus-group-dialog-title">
          {{ group ? '编辑请求组' : '新增请求组' }}
        </h2>
        <button
          type="button"
          class="icon-button"
          title="关闭"
          aria-label="关闭请求组编辑器"
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
          class="modbus-group-fields modbus-group-fields--metadata"
          aria-label="请求组配置"
        >
          <label class="dialog-form-wide">
            <span>请求组名称</span>
            <input
              v-model="draft.name"
              name="request-group-name"
              required
            >
          </label>
          <label>
            <span>从站 ID</span>
            <input
              v-model.number="draft.unitId"
              name="request-group-unit-id"
              type="number"
              min="1"
              max="247"
            >
          </label>
          <label class="checkbox-control">
            <input
              v-model="draft.enabled"
              name="request-group-enabled"
              type="checkbox"
            >
            <span>启用请求组</span>
          </label>
          <label class="modbus-group-fields__description">
            <span>说明</span>
            <textarea
              v-model="draft.description"
              name="request-group-description"
              maxlength="200"
              rows="3"
              placeholder="例如：一号锅炉控制器"
            />
          </label>
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
          {{ saving ? '正在保存…' : '保存请求组' }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
fieldset.modbus-group-dialog__body { min-width: 0; margin: 0; border: 0; }
</style>
