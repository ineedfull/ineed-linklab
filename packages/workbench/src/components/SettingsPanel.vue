<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { LoaderCircle, X } from 'lucide-vue-next';
import { formatLogLevel, LOG_LEVEL_OPTIONS } from '../model/logLevels.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../model/secondaryViews.js';
import StoragePanel from './StoragePanel.vue';
import WorkspaceActions from './WorkspaceActions.vue';
import { createModalFocusTrap } from '../model/modalFocus.js';
import { mutateSettings } from '../model/settingsMutation.js';
const props = defineProps({
  open: Boolean,
  density: { type: String, default: 'comfortable' },
  runtime: { type: Object, required: true },
  preferences: { type: Object, default: null },
  preferenceRevision: { type: Number, default: 0 },
  modbusHistoryStatus: { type: Object, default: null },
  saveCommand: { type: Function, default: null },
  workspaceImportedCommand: { type: Function, default: null },
});
const emit = defineEmits(['close', 'workspace-imported', 'density']);
const draft = reactive({ ...DEFAULT_SETTINGS }); const saved = ref({ ...DEFAULT_SETTINGS });
const loading = ref(false); const saving = ref(false); const workspaceBusy = ref(false); const error = ref('');
const panelRef = ref(null);
const draftDensity = ref(props.density);
const discardRequested = ref(false);
const dirty = computed(() => JSON.stringify(draft) !== JSON.stringify(saved.value) || draftDensity.value !== props.density);
const busy = computed(() => saving.value || workspaceBusy.value);
const focusTrap = createModalFocusTrap({
  container: () => panelRef.value,
  requestClose,
  isBusy: () => busy.value,
});
let loadGeneration = 0;
let appliedPreferenceRevision = -1;
function applyDraft(value, revision = props.preferenceRevision) {
  const normalized = normalizeSettings(value);
  Object.assign(draft, normalized);
  saved.value = { ...normalized };
  error.value = '';
  appliedPreferenceRevision = revision;
}
watch(() => props.open, async (open, previous) => {
  if (!open) {
    if (previous) focusTrap.restore();
    return;
  }
  const generation = ++loadGeneration;
  draftDensity.value = props.density;
  discardRequested.value = false;
  focusTrap.capture(); loading.value = true; error.value = '';
  try {
    const value = props.preferences ?? await props.runtime.settings.getAll();
    if (generation === loadGeneration) applyDraft(value);
  }
  catch (reason) {
    if (generation === loadGeneration) error.value = reason instanceof Error ? reason.message : String(reason);
  }
  finally {
    if (generation === loadGeneration) loading.value = false;
    await nextTick();
    if (generation === loadGeneration) focusTrap.activate('[aria-label="关闭设置"]');
  }
}, { immediate: true });
watch(() => props.preferenceRevision, (revision) => {
  if (!props.open || revision <= appliedPreferenceRevision || !props.preferences) return;
  loadGeneration += 1;
  loading.value = false;
  applyDraft(props.preferences, revision);
});
async function save() {
  if (!dirty.value || busy.value || loading.value) return; saving.value = true; error.value = '';
  const revision = appliedPreferenceRevision;
  try {
    const value = normalizeSettings(draft);
    if (props.saveCommand) await props.saveCommand(value);
    else {
      await mutateSettings(props.runtime, async () => {
        const current = await props.runtime.settings.getAll();
        const acceptanceWorkspace = normalizeSettings({ acceptanceWorkspace: current.acceptanceWorkspace ?? DEFAULT_SETTINGS.acceptanceWorkspace }).acceptanceWorkspace;
        await props.runtime.settings.saveAll({ ...value, stompProfiles: current.stompProfiles ?? [], acceptanceWorkspace });
      });
    }
    if (revision === appliedPreferenceRevision) saved.value = { ...value };
    emit('density', draftDensity.value);
    emit('close');
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { saving.value = false; }
}
function requestClose() {
  if (busy.value) return;
  if (dirty.value) { discardRequested.value = true; return; }
  emit('close');
}
onBeforeUnmount(focusTrap.restore);
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      @mousedown.self="requestClose"
    >
      <form
        ref="panelRef"
        class="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        @submit.prevent="save"
        @keydown="focusTrap.handleKeydown"
      >
        <header>
          <h2 id="settings-title">
            设置
          </h2><button
            type="button"
            class="icon-button"
            aria-label="关闭设置"
            title="关闭"
            :disabled="busy"
            @click="requestClose"
          >
            <X :size="17" />
          </button>
        </header>
        <fieldset
          class="settings-panel__body"
          :disabled="busy"
        >
          <div
            v-if="loading"
            class="state-message state-message--loading"
          >
            <LoaderCircle
              :size="16"
              class="spin"
            />正在加载设置...
          </div>
          <template v-else>
            <section class="settings-section">
              <h3>运行设置</h3><div class="settings-grid">
                <label class="field-control"><span>日志级别</span><select
                  v-model="draft.logLevel"
                  name="log-level"
                ><option
                  v-for="value in LOG_LEVEL_OPTIONS"
                  :key="value"
                  :value="value"
                >{{ formatLogLevel(value) }}</option></select></label>
                <label class="field-control"><span>实时消息上限</span><input
                  v-model.number="draft.realtimeFrameLimit"
                  name="realtime-frame-limit"
                  type="number"
                  min="1"
                  max="50000"
                ></label>
                <label class="field-control"><span>实时日志上限</span><input
                  v-model.number="draft.realtimeLogLimit"
                  name="realtime-log-limit"
                  type="number"
                  min="1"
                  max="50000"
                ></label>
                <label class="field-control"><span>预览字节上限</span><input
                  v-model.number="draft.previewByteLimit"
                  name="preview-byte-limit"
                  type="number"
                  min="1"
                  max="16777216"
                ></label>
                <label class="field-control"><span>默认分帧方式</span><select
                  v-model="draft.defaultFraming"
                  name="default-framing"
                ><option value="none">无</option><option value="line">按行</option><option value="length-prefix">长度前缀</option></select></label>
                <label class="field-control"><span>Modbus 数据点历史</span><select
                  v-model="draft.modbusPointHistoryRetention"
                  name="modbus-point-history-retention"
                ><option value="7-days">保留 7 天</option><option value="30-days">保留 30 天</option><option value="90-days">保留 90 天</option><option value="forever">永久保留</option></select></label>
              </div>
            </section>
            <section class="settings-section">
              <h3>显示设置</h3><div class="settings-grid">
                <label class="field-control"><span>显示密度</span><select
                  v-model="draftDensity"
                  name="density"
                ><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
                <label class="field-control"><span>主题</span><select
                  v-model="draft.theme"
                  name="theme"
                  aria-label="主题"
                ><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
                <label class="check-control"><input
                  v-model="draft.autoScroll"
                  name="auto-scroll"
                  type="checkbox"
                ><span>自动滚动</span></label>
                <label class="check-control"><input
                  v-model="draft.largeFont"
                  name="large-font"
                  type="checkbox"
                ><span>大字体</span></label>
              </div>
            </section>
            <WorkspaceActions
              :runtime="runtime"
              :disabled="saving"
              :workspace-imported-command="workspaceImportedCommand"
              @busy-change="workspaceBusy = $event"
              @imported="emit('workspace-imported', $event)"
            />
            <StoragePanel
              :runtime="runtime"
              :modbus-history-status="modbusHistoryStatus"
            />
          </template>
          <p
            v-if="error"
            class="field-error"
            role="alert"
          >
            {{ error }}
          </p>
        </fieldset>
        <div
          v-if="discardRequested"
          class="settings-discard"
          role="alert"
        >
          <span>设置尚未保存。</span><button
            type="button"
            class="command-button command-button--quiet"
            @click="discardRequested = false"
          >
            继续编辑
          </button><button
            type="button"
            class="command-button command-button--quiet"
            @click="emit('close')"
          >
            放弃修改
          </button>
        </div>
        <footer>
          <button
            type="button"
            class="command-button command-button--quiet"
            :disabled="busy"
            @click="requestClose"
          >
            取消
          </button><button
            type="submit"
            class="command-button"
            :disabled="!dirty || busy || loading"
          >
            <LoaderCircle
              v-if="saving"
              :size="14"
              class="spin"
            />保存
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>
