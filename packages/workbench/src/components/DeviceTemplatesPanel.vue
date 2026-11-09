<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { createModalFocusTrap } from '../model/modalFocus.js';
import {
  extractDeviceTemplate,
  normalizeDeviceTemplate,
  instantiateDeviceTemplate,
  deviceTemplatePlan,
  DEVICE_TEMPLATE_LIMITS,
} from '../model/deviceTemplates.js';
import '../styles/acceptance.css';
const props = defineProps({
  open: Boolean,
  endpoints: { type: Array, required: true },
  workspace: { type: Object, required: true },
  runtime: { type: Object, required: true },
  createEndpoint: { type: Function, required: true },
});
const emit = defineEmits(['close']);
const panelRef = ref(null);
const sourceEndpointId = ref('');
const modelName = ref('新设备型号');
const modelText = ref('');
const conditionsText = ref('[]');
const selectedTemplateRevision = ref('');
const importText = ref('');
const importPreview = ref(null);
// The workspace exposes plain snapshots; subscriptions invalidate computed readers.
const workspaceRevision = ref(0);
const busy = ref(false);
const error = ref('');
const feedback = ref('');
// A created endpoint survives a plan-save failure; retry only the missing plan.
const pendingAcceptancePlan = ref(null);
const siteDraft = ref({
  name: '新设备实例',
  transport: 'modbus-tcp-master',
  host: '127.0.0.1',
  port: 502,
  path: '',
  baudRate: 9600,
  parity: 'none',
  unitId: 1,
});
const templates = computed(() => {
  void workspaceRevision.value;
  return props.workspace.state.templates;
});
const importPreviewPointCount = computed(() =>
  (importPreview.value?.groups ?? []).reduce((groupTotal, group) =>
    groupTotal + group.requests.reduce((pointTotal, request) => pointTotal + request.dataPoints.length, 0),
  0),
);
const masters = computed(() =>
  props.endpoints.filter((e) =>
    ['modbus-tcp-master', 'modbus-rtu-master'].includes(e.transport),
  ),
);
const trap = createModalFocusTrap({
  container: () => panelRef.value,
  requestClose: () => {
    if (!busy.value) emit('close');
  },
  isBusy: () => busy.value,
});
const unsubscribe = props.workspace.subscribe(() => {
  workspaceRevision.value++;
});
watch(
  () => props.open,
  async (open) => {
    if (!open) return trap.restore();
    trap.capture();
    await nextTick();
    trap.activate('[aria-label="关闭设备模板"]');
  },
  { immediate: true },
);
watch(importText, () => {
  importPreview.value = null;
});
onBeforeUnmount(() => {
  unsubscribe();
  trap.restore();
});
function loadTemplateDraft(value) {
  modelName.value = value.model;
  modelText.value = JSON.stringify(value, null, 2);
  conditionsText.value = JSON.stringify(value.conditions, null, 2);
}
function readTemplateDraft() {
  const value = JSON.parse(modelText.value);
  value.model = modelName.value;
  value.conditions = JSON.parse(conditionsText.value);
  return normalizeDeviceTemplate(value);
}
async function runPanelAction(action) {
  if (busy.value) return;
  const prior = document.activeElement;
  const hadFocus = panelRef.value?.contains(prior);
  busy.value = true;
  error.value = '';
  feedback.value = '';
  try {
    await action();
  } catch (reason) {
    error.value = reason?.message || '操作失败，请重试';
  } finally {
    busy.value = false;
    await nextTick();
    if (hadFocus && props.open) {
      if (prior?.isConnected && !prior.disabled) prior.focus();
      else trap.activate('[aria-label="关闭设备模板"]');
    }
  }
}
function extractFromEndpoint() {
  return runPanelAction(() => {
    loadTemplateDraft(
      extractDeviceTemplate(
        masters.value.find((e) => e.id === sourceEndpointId.value),
        modelName.value,
      ),
    );
    selectedTemplateRevision.value = '';
    feedback.value = '已提取点表，请检查验收条件后保存';
  });
}
function selectTemplate() {
  const value = templates.value.find(
    (t) => `${t.id}:${t.version}` === selectedTemplateRevision.value,
  );
  if (value) {
    loadTemplateDraft(value);
    error.value = '';
    feedback.value = '';
  }
}
function saveTemplateRevision() {
  return runPanelAction(async () => {
    const value = await props.workspace.saveTemplate(readTemplateDraft());
    selectedTemplateRevision.value = `${value.id}:${value.version}`;
    loadTemplateDraft(value);
    feedback.value = `已保存 ${value.model} v${value.version}`;
  });
}
function exportTemplate() {
  return runPanelAction(async () => {
    const result = await props.runtime.opcua.execute({
      action: 'export',
      fileName: 'linklab-device-template.json',
      content: JSON.stringify(readTemplateDraft()),
    });
    if (result?.saved !== false) feedback.value = '模板已导出';
  });
}
function previewImport() {
  return runPanelAction(() => {
    if (
      new TextEncoder().encode(importText.value).length >
      DEVICE_TEMPLATE_LIMITS.bytes
    )
      throw new Error('模板文件超过 256 KiB');
    importPreview.value = normalizeDeviceTemplate(JSON.parse(importText.value));
  });
}
function confirmImport() {
  return runPanelAction(async () => {
    if (!importPreview.value) throw new Error('请先预览导入');
    const value = await props.workspace.importTemplate(importPreview.value);
    selectedTemplateRevision.value = `${value.id}:${value.version}`;
    loadTemplateDraft(value);
    importPreview.value = null;
    feedback.value = '已作为新的模板保存';
  });
}
async function readImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  await runPanelAction(async () => {
    if (file.size > DEVICE_TEMPLATE_LIMITS.bytes)
      throw new Error('模板文件超过 256 KiB');
    importText.value = await file.text();
    importPreview.value = null;
  });
  event.target.value = '';
}
async function createInstance(withPlan) {
  return runPanelAction(async () => {
    if (pendingAcceptancePlan.value)
      throw new Error('已有端点创建成功，请先重试保存验收方案');
    if (props.workspace.state.dirty) throw new Error('请先重试保存模板库或验收方案');
    const template = readTemplateDraft();
    const isSavedVersion = templates.value.some(
      (savedTemplate) => JSON.stringify(savedTemplate) === JSON.stringify(template),
    );
    if (!isSavedVersion) throw new Error('请先保存当前模板版本');
    const draft = instantiateDeviceTemplate(template, {
      ...siteDraft.value,
      port: Number(siteDraft.value.port),
      baudRate: Number(siteDraft.value.baudRate),
      unitId: Number(siteDraft.value.unitId),
    });
    const plan = withPlan
      ? deviceTemplatePlan(template, Number(siteDraft.value.unitId))
      : null;
    if (plan) {
      plan.name = `${siteDraft.value.name} · ${template.model} v${template.version}`.slice(0, 100);
    }
    // Persist the endpoint before its optional plan; never repeat this step on retry.
    const result = await props.createEndpoint(draft);
    if (result?.ok === false)
      throw new Error(result.error?.message || '端点保存失败');
    if (plan) {
      pendingAcceptancePlan.value = plan;
      await props.workspace.savePlan(plan);
      pendingAcceptancePlan.value = null;
    }
    feedback.value = `已新建端点 ${siteDraft.value.name}${plan ? ' 和验收方案；打开端点后到验收检查执行' : '；请显式打开连接'}`;
  });
}
function retrySaveAcceptancePlan() {
  return runPanelAction(async () => {
    await props.workspace.savePlan(pendingAcceptancePlan.value);
    pendingAcceptancePlan.value = null;
    feedback.value = '验收方案已保存，请到验收检查选择新端点';
  });
}
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop acceptance-overlay"
      @keydown="trap.handleKeydown"
    >
      <section
        ref="panelRef"
        class="acceptance-panel device-templates-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-template-title"
        tabindex="-1"
      >
        <header class="acceptance-header">
          <div>
            <h2 id="device-template-title">
              设备模板
            </h2>
            <p>复用 Modbus 点表与工程量验收条件</p>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="关闭设备模板"
            :disabled="busy"
            @click="emit('close')"
          >
            <X :size="18" />
          </button>
        </header>
        <div class="acceptance-body">
          <p class="acceptance-hint">
            模板不含现场地址；每次实例化创建新端点。先保存版本，再创建实例；已有报告保留执行时的解释配置。
          </p>
          <fieldset class="dialog-form-section">
            <legend>提取设备模板</legend>
            <div class="acceptance-fields">
              <label class="acceptance-wide">来源主站<select
                v-model="sourceEndpointId"
                name="model-source"
                :disabled="busy"
              >
                <option value="">选择现有 Modbus 主站</option>
                <option
                  v-for="entry in masters"
                  :key="entry.id"
                  :value="entry.id"
                >
                  {{ entry.name }}
                </option>
              </select></label>
              <label class="acceptance-wide">型号名称<input
                v-model="modelName"
                name="model-name"
                maxlength="100"
                :disabled="busy"
              ></label>
            </div>
            <div class="acceptance-actions">
              <button
                type="button"
                :disabled="busy || !sourceEndpointId"
                @click="extractFromEndpoint"
              >
                提取点表
              </button>
            </div>
          </fieldset>
          <fieldset class="dialog-form-section">
            <legend>模板内容与版本</legend>
            <label>已保存的模板版本<select
              v-model="selectedTemplateRevision"
              name="model-version"
              :disabled="busy"
              @change="selectTemplate"
            >
              <option value="">选择模板版本</option>
              <option
                v-for="entry in templates"
                :key="`${entry.id}:${entry.version}`"
                :value="`${entry.id}:${entry.version}`"
              >
                {{ entry.model }} v{{ entry.version }}
              </option>
            </select></label>
            <template v-if="modelText">
              <details>
                <summary>点表与解码配置 JSON（可编辑）</summary>
                <label>模板 JSON<textarea
                  v-model="modelText"
                  name="model-json"
                  rows="9"
                  :disabled="busy"
                  spellcheck="false"
                />
                </label>
              </details>
              <label>只读验收条件 JSON<textarea
                v-model="conditionsText"
                name="model-conditions"
                rows="5"
                :disabled="busy"
                spellcheck="false"
              />
              </label>
              <p class="acceptance-hint">
                条件引用 groupId / requestId / pointId；assertion 使用
                {"kind":"range","minimum":20,"maximum":30} 或
                {"kind":"equals","expected":true}。上下限均已填写的启用点位会自动提取范围条件；单位沿用点位配置。64
                位整数精确值使用字符串。
              </p>
              <div class="acceptance-actions">
                <button
                  type="button"
                  :disabled="busy"
                  @click="saveTemplateRevision"
                >
                  保存新版本
                </button><button
                  type="button"
                  :disabled="busy"
                  @click="exportTemplate"
                >
                  导出模板
                </button>
              </div>
            </template>
          </fieldset>
          <fieldset
            v-if="modelText"
            class="dialog-form-section"
          >
            <legend>新建现场实例</legend>
            <div class="acceptance-fields">
              <label class="acceptance-wide">端点名称<input
                v-model="siteDraft.name"
                name="model-site-name"
                maxlength="80"
                :disabled="busy"
              ></label>
              <label>传输类型<select
                v-model="siteDraft.transport"
                name="model-site-transport"
                :disabled="busy"
              >
                <option value="modbus-tcp-master">Modbus TCP 主站</option>
                <option value="modbus-rtu-master">Modbus RTU 主站</option>
              </select></label>
              <label>现场从站号（1～247）<input
                v-model="siteDraft.unitId"
                name="model-site-unit"
                inputmode="numeric"
                :disabled="busy"
              ></label>
              <template v-if="siteDraft.transport === 'modbus-tcp-master'">
                <label>现场地址<input
                  v-model="siteDraft.host"
                  name="model-site-host"
                  :disabled="busy"
                ></label><label>端口<input
                  v-model="siteDraft.port"
                  name="model-site-port"
                  inputmode="numeric"
                  :disabled="busy"
                ></label>
              </template>
              <template v-else>
                <label class="acceptance-wide">现场串口<input
                  v-model="siteDraft.path"
                  name="model-site-path"
                  :disabled="busy"
                  placeholder="/dev/tty… 或 COM3"
                ></label><label>波特率<input
                  v-model="siteDraft.baudRate"
                  name="model-site-baud"
                  inputmode="numeric"
                  :disabled="busy"
                ></label><label>校验<select
                  v-model="siteDraft.parity"
                  name="model-site-parity"
                  :disabled="busy"
                >
                  <option value="none">无校验</option>
                  <option value="even">偶校验</option>
                  <option value="odd">奇校验</option>
                </select></label>
              </template>
            </div>
            <div class="acceptance-actions">
              <button
                type="button"
                :disabled="busy || !!pendingAcceptancePlan"
                @click="createInstance(false)"
              >
                新建端点
              </button><button
                type="button"
                :disabled="busy || !!pendingAcceptancePlan"
                @click="createInstance(true)"
              >
                新建端点和验收方案
              </button><button
                v-if="pendingAcceptancePlan"
                type="button"
                :disabled="busy"
                @click="retrySaveAcceptancePlan"
              >
                重试保存验收方案
              </button>
            </div>
          </fieldset>
          <details class="acceptance-import">
            <summary>导入设备模板</summary>
            <label>模板文件<input
              name="model-import-file"
              type="file"
              accept=".json,application/json"
              :disabled="busy"
              @change="readImportFile"
            ></label><label>模板 JSON<textarea
              v-model="importText"
              name="model-import"
              rows="4"
              :disabled="busy"
            /></label><button
              type="button"
              :disabled="busy"
              @click="previewImport"
            >
              预览导入
            </button>
            <section
              v-if="importPreview"
              aria-label="导入预览"
            >
              <h3>导入预览</h3>
              <p>
                {{ importPreview.model }} v{{ importPreview.version }} ·
                {{ importPreview.groups.length }} 个请求组 ·
                {{ importPreviewPointCount }}
                个点位 · {{ importPreview.conditions.length }} 个验收条件
              </p>
              <p>确认后保存为新模板 v1，不覆盖已有模板或端点。</p>
              <button
                type="button"
                :disabled="busy"
                @click="confirmImport"
              >
                确认导入为新模板
              </button>
            </section>
          </details>
          <p
            v-if="error || workspace.state.error"
            role="alert"
            class="acceptance-error"
          >
            {{ error || workspace.state.error }}
          </p>
          <p
            v-if="feedback"
            role="status"
          >
            {{ feedback }}
          </p>
          <button
            v-if="workspace.state.dirty"
            type="button"
            :disabled="busy"
            @click="runPanelAction(() => workspace.flush())"
          >
            重试保存
          </button>
        </div>
        <footer class="acceptance-footer">
          模板库最多 50 个版本，每个 256 KiB；每个模板最多 25
          个验收条件。只读检查不会执行写命令。
        </footer>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.device-templates-panel label {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.device-templates-panel textarea {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  resize: vertical;
}
.device-templates-panel details,
.device-templates-panel h3 {
  margin-block: 12px;
}
.device-templates-panel p {
  overflow-wrap: anywhere;
}
</style>
