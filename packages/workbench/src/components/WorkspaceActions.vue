<script setup>
import { onUnmounted, ref } from 'vue';
import { Download, Upload } from 'lucide-vue-next';
const props = defineProps({
  runtime: { type: Object, required: true },
  disabled: Boolean,
  workspaceImportedCommand: { type: Function, default: null },
});
const emit = defineEmits(['busy-change', 'imported']);
const busy = ref(false); const success = ref(''); const error = ref('');
let generation = 0;
async function execute(kind) {
  if (busy.value || props.disabled) return;
  const current = ++generation;
  busy.value = true; emit('busy-change', true); success.value = ''; error.value = '';
  try {
    const result = await props.runtime.workspace[kind]();
    if (current !== generation || result?.canceled) return;
    if (kind === 'import') {
      emit('imported', result);
      if (props.workspaceImportedCommand) await props.workspaceImportedCommand(result);
      if (current !== generation) return;
    }
    success.value = `${kind === 'export' ? '工作区已导出到' : '工作区已从以下文件导入'} ${result?.path ?? '所选文件'}`;
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (current === generation) {
      busy.value = false;
      emit('busy-change', false);
    }
  }
}
onUnmounted(() => {
  generation += 1;
  busy.value = false;
  success.value = '';
  error.value = '';
});
</script>
<template>
  <section class="settings-section workspace-actions">
    <h3>工作区</h3>
    <div class="settings-actions">
      <button
        type="button"
        class="command-button command-button--quiet"
        data-action="export"
        :disabled="busy || disabled"
        @click="execute('export')"
      >
        <Download :size="14" />导出
      </button><button
        type="button"
        class="command-button command-button--quiet"
        data-action="import"
        :disabled="busy || disabled"
        @click="execute('import')"
      >
        <Upload :size="14" />导入
      </button>
    </div>
    <p
      v-if="success"
      role="status"
      class="settings-success"
    >
      {{ success }}
    </p><p
      v-if="error"
      role="alert"
      class="field-error"
    >
      {{ error }}
    </p>
  </section>
</template>
