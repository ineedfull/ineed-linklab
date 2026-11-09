<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import {
  acceptanceId,
  normalizeAcceptancePlan,
} from '../model/acceptancePlan.js';
import { formatAcceptanceReport } from '../model/acceptanceWorkspace.js';
import { createModalFocusTrap } from '../model/modalFocus.js';
import { formatTimestamp } from '../model/dateTime.js';
import '../styles/acceptance.css';

const props = defineProps({
  open: Boolean,
  workspace: { type: Object, required: true },
  targets: { type: Object, required: true },
  runtime: { type: Object, required: true },
  revision: { type: Number, default: 0 },
});
const emit = defineEmits(['close']);
const panel = ref(null);
const changes = ref(0);
const draft = ref(newPlan());
const selectedCheck = ref(0);
const targetId = ref('');
const error = ref('');
const feedback = ref('');
const busy = ref(false);
const importText = ref('');
const selectedReport = ref('');
const activeReportId = ref('');
const state = computed(() => {
  void changes.value;
  return props.workspace.state;
});
const running = computed(() => {
  void changes.value;
  return props.workspace.runner.state.running;
});
const availableTargets = computed(() => {
  void props.revision;
  void changes.value;
  return props.targets
    .list()
    .filter((row) => row.protocol === draft.value.protocol);
});
const check = computed(() => draft.value.checks[selectedCheck.value]);
const report = computed(() => {
  void changes.value;
  const live = props.workspace.runner.state.report;
  if (activeReportId.value && live?.id === activeReportId.value) return live;
  return (
    state.value.pendingReport ??
    state.value.reports.find((row) => row.id === selectedReport.value) ??
    state.value.reports.at(-1) ??
    null
  );
});
const statusLabels = {
  running: '执行中',
  passed: '通过',
  failed: '失败',
  stopped: '已停止',
  invalidated: '会话失效',
  'not-run': '未执行',
};
const trap = createModalFocusTrap({
  container: () => panel.value,
  requestClose: close,
});
const unsubscribeWorkspace = props.workspace.subscribe(() => {
  changes.value++;
});
const unsubscribeRunner = props.workspace.runner.subscribe(() => {
  changes.value++;
});

function newCheck(protocol) {
  return {
    id: acceptanceId(),
    name: '检查项',
    query:
      protocol === 'modbus'
        ? {
            unitId: '1',
            functionCode: '3',
            address: '0',
            quantity: '1',
            timeoutMs: '1000',
          }
        : { nodeId: 'i=2258' },
    kind: 'equals',
    expected: protocol === 'modbus' ? '[0]' : '0',
    minimum: '0',
    maximum: '100',
  };
}
function newPlan(protocol = 'modbus') {
  return {
    id: acceptanceId(),
    name: '新验收方案',
    protocol,
    checks: [newCheck(protocol)],
  };
}
function resetPlan() {
  draft.value = newPlan(draft.value.protocol);
  selectedCheck.value = 0;
  error.value = '';
  feedback.value = '';
}
function changeProtocol() {
  draft.value.checks = [newCheck(draft.value.protocol)];
  selectedCheck.value = 0;
  targetId.value = '';
}
function addCheck() {
  retainKeyboardFocus();
  draft.value.checks.push(newCheck(draft.value.protocol));
  selectedCheck.value = draft.value.checks.length - 1;
}
function removeCheck() {
  retainKeyboardFocus();
  draft.value.checks.splice(selectedCheck.value, 1);
  selectedCheck.value = Math.min(
    selectedCheck.value,
    draft.value.checks.length - 1,
  );
}
function requiredNumber(value, label) {
  if (String(value).trim() === '')
    throw new Error(`${label}必填，请输入有效数字`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}无效`);
  return number;
}
function snapshot() {
  const value = draft.value;
  return normalizeAcceptancePlan({
    id: value.id,
    name: value.name,
    protocol: value.protocol,
    checks: value.checks.map((row) => ({
      id: row.id,
      name: row.name,
      query:
        value.protocol === 'opcua'
          ? { nodeId: row.query.nodeId }
          : Object.fromEntries(
              Object.entries(row.query).map(([key, number]) => [
                key,
                requiredNumber(number, key),
              ]),
            ),
      ...(row.engineering ? { engineering: JSON.parse(JSON.stringify(row.engineering)) } : {}),
      assertion:
        row.kind === 'equals'
          ? { kind: 'equals', expected: JSON.parse(row.expected) }
          : {
              kind: 'range',
              minimum: row.engineering ? String(row.minimum) : requiredNumber(row.minimum, '最小值'),
              maximum: row.engineering ? String(row.maximum) : requiredNumber(row.maximum, '最大值'),
            },
    })),
  });
}
function editPlan(value) {
  if (!value) return;
  draft.value = {
    ...value,
    checks: value.checks.map((row) => ({
      id: row.id,
      name: row.name,
      query: { ...row.query },
      ...(row.engineering ? { engineering: JSON.parse(JSON.stringify(row.engineering)) } : {}),
      kind: row.assertion.kind,
      expected: JSON.stringify(row.assertion.expected ?? null),
      minimum: String(row.assertion.minimum ?? 0),
      maximum: String(row.assertion.maximum ?? 100),
    })),
  };
  selectedCheck.value = 0;
  targetId.value = '';
  error.value = '';
}
function retainKeyboardFocus() {
  if (props.open && panel.value?.contains(document.activeElement)) {
    trap.activate('[aria-label="关闭验收检查"]');
  }
}
async function operation(action) {
  if (busy.value) return;
  retainKeyboardFocus();
  busy.value = true;
  error.value = '';
  feedback.value = '';
  try {
    await action();
  } catch (reason) {
    error.value = reason?.message || '操作失败，请重试';
  } finally {
    busy.value = false;
  }
}
function deletePlan() {
  return operation(async () => {
    await props.workspace.deletePlan(draft.value.id);
    resetPlan();
  });
}
function save() {
  return operation(async () => {
    await props.workspace.savePlan(snapshot());
    feedback.value = '方案已保存';
  });
}
async function execute() {
  retainKeyboardFocus();
  // Keep stop and close available while a native read is pending.
  error.value = '';
  feedback.value = '';
  try {
    const value = snapshot();
    activeReportId.value = '';
    selectedReport.value = '';
    const pending = props.workspace.run(value, targetId.value);
    activeReportId.value = props.workspace.runner.state.report?.id ?? '';
    changes.value++;
    await pending;
  } catch (reason) {
    error.value = reason?.message || '执行失败，请重试';
  }
}
function stop() {
  return operation(() => props.workspace.stop());
}
function close() {
  emit('close');
}
function exportContent(fileName, content) {
  return props.runtime.opcua
    .execute({ action: 'export', fileName, content })
    .then((result) => {
      feedback.value = result.saved ? '已导出' : '已取消导出';
    });
}
function exportPlan() {
  return operation(() =>
    exportContent(
      'linklab-acceptance-plan.json',
      props.workspace.exportPlan(snapshot()),
    ),
  );
}
function exportReport(format) {
  return operation(() =>
    exportContent(
      `linklab-acceptance-report.${format === 'json' ? 'json' : 'md'}`,
      formatAcceptanceReport(report.value, format),
    ),
  );
}
function importPlan() {
  return operation(async () => {
    const value = await props.workspace.importPlan(importText.value);
    editPlan(value);
    importText.value = '';
    feedback.value = '方案已导入';
  });
}
async function readImport(event) {
  await operation(async () => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 65536) throw new Error('方案文件最多 64 KiB');
    importText.value = await file.text();
  });
  event.target.value = '';
}
watch(
  () => props.open,
  async (open, previous) => {
    if (open) {
      trap.capture();
      await nextTick();
      if (props.open) trap.activate('[aria-label="关闭验收检查"]');
    } else if (previous) trap.restore();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  unsubscribeWorkspace();
  unsubscribeRunner();
  trap.restore();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop acceptance-overlay"
    >
      <section
        ref="panel"
        class="acceptance-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="acceptance-title"
        @keydown="trap.handleKeydown"
      >
        <header class="acceptance-header">
          <div>
            <h2 id="acceptance-title">
              验收检查
            </h2>
            <p>对已连接的 Modbus 主站 / OPC UA 客户端执行只读检查</p>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭验收检查"
            @click="close"
          >
            <X :size="18" />
          </button>
        </header>
        <div class="acceptance-body">
          <div class="acceptance-actions">
            <label>已保存方案<select
              name="acceptance-saved-plan"
              :value="draft.id"
              :disabled="running || busy"
              @change="
                editPlan(
                  state.plans.find((row) => row.id === $event.target.value),
                )
              "
            >
              <option value="">选择方案</option>
              <option
                v-for="row in state.plans"
                :key="row.id"
                :value="row.id"
              >
                {{ row.name }}
              </option>
            </select></label>
            <button
              type="button"
              :disabled="running || busy"
              @click="resetPlan"
            >
              新建方案
            </button>
            <button
              type="button"
              :disabled="
                running ||
                  busy ||
                  !state.plans.some((row) => row.id === draft.id)
              "
              @click="deletePlan"
            >
              删除方案
            </button>
          </div>
          <div class="acceptance-fields">
            <label class="acceptance-wide">方案名称<input
              v-model="draft.name"
              name="acceptance-plan-name"
              maxlength="100"
              :disabled="running"
            ></label>
            <label>协议<select
              v-model="draft.protocol"
              name="acceptance-protocol"
              :disabled="running"
              @change="changeProtocol"
            >
              <option value="modbus">Modbus</option>
              <option value="opcua">OPC UA</option>
            </select></label>
            <label>已连接目标<select
              v-model="targetId"
              name="acceptance-target"
              :disabled="running"
            >
              <option value="">选择已连接端点</option>
              <option
                v-for="row in availableTargets"
                :key="row.endpointId"
                :value="row.endpointId"
              >
                {{ row.name }}
              </option>
            </select></label>
          </div>
          <p
            v-if="availableTargets.length === 0"
            class="acceptance-hint"
          >
            暂无可用目标，请先在工作台连接对应端点。
          </p>
          <div class="acceptance-actions">
            <label>检查项<select
              v-model.number="selectedCheck"
              name="acceptance-check"
              :disabled="running"
            >
              <option
                v-for="(row, index) in draft.checks"
                :key="row.id"
                :value="index"
              >
                {{ index + 1 }}. {{ row.name }}
              </option>
            </select></label>
            <button
              type="button"
              :disabled="running || draft.checks.length >= 25"
              @click="addCheck"
            >
              添加检查
            </button>
            <button
              type="button"
              :disabled="running || draft.checks.length <= 1"
              @click="removeCheck"
            >
              删除检查
            </button>
          </div>
          <fieldset
            :disabled="running"
            class="acceptance-fields dialog-form-section"
          >
            <legend>检查参数</legend>
            <label class="acceptance-wide">检查名称<input
              v-model="check.name"
              name="acceptance-check-name"
              maxlength="100"
            ></label>
            <template v-if="draft.protocol === 'modbus'">
              <label>功能码<select
                v-model="check.query.functionCode"
                name="acceptance-function-code"
              >
                <option value="1">FC1 线圈</option>
                <option value="2">FC2 离散输入</option>
                <option value="3">FC3 保持寄存器</option>
                <option value="4">FC4 输入寄存器</option>
              </select></label>
              <label>单元 ID<input
                v-model="check.query.unitId"
                name="acceptance-unit-id"
                type="number"
                min="1"
                max="247"
              ></label>
              <label>起始地址（从 0 开始）<input
                v-model="check.query.address"
                name="acceptance-address"
                type="number"
                min="0"
                max="65535"
              ></label>
              <label>数量<input
                v-model="check.query.quantity"
                name="acceptance-quantity"
                type="number"
                min="1"
                max="2000"
              ></label>
              <label>超时（毫秒）<input
                v-model="check.query.timeoutMs"
                name="acceptance-timeout"
                type="number"
                min="100"
                max="30000"
              ></label>
            </template>
            <label v-else>Node ID<input
              v-model="check.query.nodeId"
              name="acceptance-node-id"
              spellcheck="false"
            ></label>
            <label>断言<select
              v-model="check.kind"
              name="acceptance-assertion"
            >
              <option value="equals">严格等于 JSON 值</option>
              <option value="range">数值闭区间</option>
            </select></label>
            <label
              v-if="check.kind === 'equals'"
              class="acceptance-wide"
            >期望值（JSON）<textarea
              v-model="check.expected"
              name="acceptance-expected"
              rows="2"
              spellcheck="false"
            />
            </label>
            <template v-else>
              <label>最小值<input
                v-model="check.minimum"
                name="acceptance-minimum"
                type="number"
                step="any"
              ></label><label>最大值<input
                v-model="check.maximum"
                name="acceptance-maximum"
                type="number"
                step="any"
              ></label>
            </template>
          </fieldset>
          <p class="acceptance-hint">
            Modbus 等于断言使用数组，例如
            [7]；范围断言可检查单个寄存器。执行使用当前编辑内容，报告保留独立快照。
          </p>
          <div class="acceptance-actions">
            <button
              type="button"
              :disabled="busy || running || !state.loaded"
              @click="save"
            >
              保存方案
            </button>
            <button
              type="button"
              class="acceptance-primary"
              :disabled="
                busy ||
                  running ||
                  !state.loaded ||
                  !availableTargets.some((row) => row.endpointId === targetId)
              "
              @click="execute"
            >
              执行检查
            </button>
            <button
              type="button"
              :disabled="!running || busy"
              @click="stop"
            >
              停止检查
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="exportPlan"
            >
              导出方案
            </button>
            <button
              v-if="state.dirty"
              type="button"
              :disabled="busy"
              @click="operation(() => workspace.flush())"
            >
              重试保存
            </button>
          </div>
          <details class="acceptance-import">
            <summary>导入验收方案 JSON</summary>
            <label>选择方案文件<input
              name="acceptance-import-file"
              type="file"
              accept=".json,application/json"
              :disabled="running || busy"
              @change="readImport"
            ></label><label>方案 JSON<textarea
              v-model="importText"
              name="acceptance-plan-import"
              rows="3"
              :disabled="running || busy"
            /></label><button
              type="button"
              :disabled="running || busy"
              @click="importPlan"
            >
              导入方案
            </button>
          </details>
          <p
            v-if="error || state.error"
            role="alert"
            class="acceptance-error"
          >
            {{ error || state.error }}
          </p>
          <p
            v-if="feedback"
            role="status"
          >
            {{ feedback }}
          </p>
          <section
            class="acceptance-report"
            aria-label="检查报告"
          >
            <div class="acceptance-actions">
              <h3>检查报告</h3>
              <label>历史报告<select
                v-model="selectedReport"
                name="acceptance-report"
                :disabled="running"
                @change="activeReportId = ''"
              >
                <option value="">最新报告</option>
                <option
                  v-for="row in [...state.reports].reverse()"
                  :key="row.id"
                  :value="row.id"
                >
                  {{ row.plan.name }} · {{ formatTimestamp(row.startedAt) }} ·
                  {{ statusLabels[row.status] }}
                </option>
              </select></label>
            </div>
            <template v-if="report">
              <p
                class="acceptance-summary"
                :data-status="report.status"
              >
                {{ report.plan.name }} · {{ statusLabels[report.status] }} ·
                {{ report.target.name }}
              </p>
              <p class="acceptance-hint">
                {{ report.target.identity }} · 会话 {{ report.target.sessionId
                }}<br>开始 {{ formatTimestamp(report.startedAt) }} · 结束
                {{ report.endedAt ? formatTimestamp(report.endedAt) : '—' }}
              </p>
              <ol>
                <li
                  v-for="(row, index) in report.results"
                  :key="row.checkId"
                >
                  <strong>{{ report.plan.checks[index].name }} ·
                    {{ statusLabels[row.status] }}</strong>
                  <pre>{{
                    JSON.stringify(
                      {
                        query: report.plan.checks[index].query,
                        assertion: report.plan.checks[index].assertion,
                        actual: row.actual,
                        quality: row.quality,
                        evidence: row.evidence,
                      },
                      null,
                      2,
                    )
                  }}</pre>
                  <p
                    v-if="row.error"
                    class="acceptance-error"
                  >
                    {{ row.error }}
                  </p>
                </li>
              </ol>
              <div class="acceptance-actions">
                <button
                  type="button"
                  :disabled="busy || report.status === 'running'"
                  @click="exportReport('json')"
                >
                  导出 JSON
                </button><button
                  type="button"
                  :disabled="busy || report.status === 'running'"
                  @click="exportReport('markdown')"
                >
                  导出 Markdown
                </button>
              </div>
            </template>
            <p
              v-else
              class="acceptance-hint"
            >
              执行检查后查看实际值、质量、断言及逐项结果。
            </p>
          </section>
        </div>
        <footer class="acceptance-footer">
          最多 50 个方案，每方案 25 项；保留最近 20
          份报告。关闭面板不中断检查；草稿在本次会话保留。
        </footer>
      </section>
    </div>
  </Teleport>
</template>
