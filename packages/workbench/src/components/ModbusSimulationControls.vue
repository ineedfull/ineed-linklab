<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { Settings2, X } from 'lucide-vue-next';
import { createModalFocusTrap } from '../model/modalFocus.js';
import { numericSimulationPoints } from '../model/modbusSlaveSimulation.js';

const props = defineProps({
  endpoint: { type: Object, required: true },
  manager: { type: Object, required: true },
  running: Boolean,
  sessionId: { type: String, default: null },
});
const emit = defineEmits(['active-change']);
const revision = ref(0);
const open = ref(false);
const dialogRef = ref(null);
const draft = ref([]);
const intervalMs = ref(1000);
const error = ref('');
const status = computed(() => {
  void revision.value;
  return props.manager.getStatus(props.endpoint.id);
});
const points = computed(() => numericSimulationPoints(props.endpoint.config.dataPoints));
const unsubscribe = props.manager.subscribe(() => {
  revision.value += 1;
  emit('active-change', props.manager.getStatus(props.endpoint.id).active);
});
emit('active-change', props.manager.getStatus(props.endpoint.id).active);
const focus = createModalFocusTrap({ container: () => dialogRef.value, requestClose: close });

async function edit(event) {
  event?.currentTarget?.focus();
  error.value = '';
  const settings = status.value.settings;
  intervalMs.value = settings?.intervalMs ?? 1000;
  draft.value = points.value.map((point) => {
    const rule = settings?.rules.find(({ pointId }) => pointId === point.id);
    return { pointId: point.id, name: point.name, unit: point.unit,
      selected: Boolean(rule), min: rule?.min ?? 0, max: rule?.max ?? 100, step: rule?.step ?? 1 };
  });
  focus.capture();
  open.value = true;
  await nextTick();
  focus.activate();
}
function close() { open.value = false; focus.restore(); }
function save() {
  try {
    props.manager.configure(props.endpoint.id, props.endpoint.config.dataPoints, {
      intervalMs: intervalMs.value,
      rules: draft.value.filter(({ selected }) => selected),
    });
    error.value = '';
    close();
  } catch (reason) { error.value = reason.message; }
}
function toggle(event) {
  event.target.checked = status.value.active;
  error.value = '';
  if (status.value.active) { props.manager.stop(props.endpoint.id); return; }
  if (!status.value.settings) { void edit(); return; }
  try {
    props.manager.start({ endpointId: props.endpoint.id, sessionId: props.sessionId,
      points: props.endpoint.config.dataPoints });
  } catch (reason) { error.value = reason.message; }
}
onBeforeUnmount(() => { unsubscribe(); focus.restore(); });
</script>

<template>
  <div class="modbus-simulation-controls">
    <label class="checkbox-control">
      <input
        type="checkbox"
        role="switch"
        aria-label="自动变化"
        :checked="status.active"
        :disabled="!running || !sessionId || !points.length"
        @change="toggle"
      >
      <span>自动变化</span>
    </label>
    <button
      type="button"
      class="icon-button"
      aria-label="自动变化设置"
      title="自动变化设置"
      :disabled="!points.length"
      @click="edit"
    >
      <Settings2 :size="15" />
    </button>
    <span
      v-if="(error || status.error) && !open"
      class="modbus-simulation-error"
      role="alert"
      :title="error || status.error"
    >{{ error || status.error }}</span>
    <Teleport to="body">
      <div
        v-if="open"
        class="dialog-backdrop"
        @mousedown.self="close"
        @keydown="focus.handleKeydown"
      >
        <form
          ref="dialogRef"
          class="endpoint-dialog modbus-simulation-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="simulation-title"
          novalidate
          @submit.prevent="save"
        >
          <header>
            <h2 id="simulation-title">
              自动变化设置
            </h2>
            <button
              type="button"
              class="icon-button"
              aria-label="关闭自动变化设置"
              @click="close"
            >
              <X :size="17" />
            </button>
          </header>
          <div class="modbus-simulation-body">
            <p class="modbus-simulation-hint">
              勾选要模拟的数值点位。开启后从下限递增，超过上限回到下限；未勾选的字段保持原值。
            </p>
            <label class="field-control modbus-simulation-interval">
              <span>变化间隔（毫秒）</span>
              <input
                v-model="intervalMs"
                type="number"
                aria-label="变化间隔（毫秒）"
                min="100"
                max="3600000"
              >
            </label>
            <fieldset
              v-for="row in draft"
              :key="row.pointId"
              class="dialog-form-section modbus-simulation-rule"
            >
              <legend>
                <label class="checkbox-control">
                  <input
                    v-model="row.selected"
                    type="checkbox"
                    :aria-label="`模拟 ${row.name}`"
                  >
                  <span>{{ row.name }}{{ row.unit ? `（${row.unit}）` : '' }}</span>
                </label>
              </legend>
              <div
                v-if="row.selected"
                class="modbus-simulation-range"
              >
                <label class="field-control">
                  <span>下限</span>
                  <input
                    v-model="row.min"
                    type="number"
                    step="any"
                    :disabled="!row.selected"
                    :aria-label="`${row.name}下限`"
                  >
                </label>
                <label class="field-control">
                  <span>上限</span>
                  <input
                    v-model="row.max"
                    type="number"
                    step="any"
                    :disabled="!row.selected"
                    :aria-label="`${row.name}上限`"
                  >
                </label>
                <label class="field-control">
                  <span>步长</span>
                  <input
                    v-model="row.step"
                    type="number"
                    step="any"
                    :disabled="!row.selected"
                    :aria-label="`${row.name}步长`"
                  >
                </label>
              </div>
            </fieldset>
            <p class="modbus-simulation-hint">
              设置仅保留在本次工作台会话。切换页面继续变化；关闭从站或修改点位后停止，重新打开需手动开启。
              自动变化不覆盖端点保存的初始值。保存设置会关闭开关。
            </p>
            <p
              v-if="error"
              class="modbus-simulation-error"
              role="alert"
            >
              {{ error }}
            </p>
          </div>
          <footer>
            <button
              type="button"
              class="command-button command-button--quiet"
              @click="close"
            >
              取消
            </button>
            <button
              type="submit"
              class="command-button"
            >
              保存设置
            </button>
          </footer>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.modbus-simulation-controls { display: flex; align-items: center; gap: 4px; min-width: 0; }
.modbus-simulation-controls .checkbox-control { white-space: nowrap; }
.modbus-simulation-dialog { width: min(680px, calc(100vw - 32px)); height: auto; max-height: calc(100dvh - 32px); }
.modbus-simulation-body { min-height: 0; overflow-y: auto; padding: 16px; display: grid; gap: 14px; }
.modbus-simulation-hint { margin: 0; color: var(--text-muted); font-size: var(--font-size-small); line-height: 1.6; }
.modbus-simulation-interval { display: grid; gap: 6px; max-width: 240px; }
.modbus-simulation-rule { min-width: 0; }
.modbus-simulation-rule legend { max-width: 100%; overflow-wrap: anywhere; }
.modbus-simulation-range { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.modbus-simulation-range label { display: grid; gap: 6px; min-width: 0; }
.modbus-simulation-body input[type="number"] { width: 100%; min-width: 0; box-sizing: border-box; height: var(--form-control-height); padding: 0 8px;
  color: var(--text); background: var(--surface-control); border: 1px solid var(--line); border-radius: 4px; }
.modbus-simulation-error { color: var(--danger); overflow-wrap: anywhere; }
.modbus-simulation-controls > .modbus-simulation-error { max-width: 120px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
@media (max-width: 500px) { .modbus-simulation-range { grid-template-columns: 1fr; } }
</style>
