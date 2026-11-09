<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { Copy, X } from 'lucide-vue-next';
import { createModalFocusTrap } from '../model/modalFocus.js';
import { createToolDraft, createToolExample, INDUSTRIAL_TOOLS, industrialTool, runTool, TOOL_GROUPS } from '../model/industrialTools.js';
import '../styles/toolbox.css';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);
const panelRef = ref(null);
const group = ref('checksums');
const selected = reactive({ encoding: 'ascii', numbers: 'radix', checksums: 'crc' });
const drafts = reactive(Object.fromEntries(INDUSTRIAL_TOOLS.map(tool => [tool.id, createToolDraft(tool.id)])));
const toolId = computed(() => selected[group.value]);
const tool = computed(() => industrialTool(toolId.value));
const draft = computed(() => drafts[toolId.value]);
const toolsInGroup = computed(() => INDUSTRIAL_TOOLS.filter(item => item.group === group.value));
const hexInput = computed(() => ['crc', 'checksum', 'order'].includes(toolId.value) || draft.value.options.direction === 'decode');
const inputHint = computed(() => hexInput.value
  ? 'HEX 使用完整字节与空白分隔，不含 0x 或逗号。校验数据不含末尾校验字节。'
  : toolId.value === 'ascii' ? '直接输入 ASCII 字符；换行按真实 CR/LF 编码，反斜杠不会自动解释为转义序列。'
    : toolId.value === 'bits' ? '输入 HEX 整数，不含空格；例如 8001。'
      : '按所选进制或转换方向输入数字；具体规则见当前工具说明。');
const copying = ref(false);
const feedback = ref('');
const copyError = ref('');
// A revision also changes on close/tool changes, so an old clipboard completion
// cannot write feedback into a different calculation or a reopened panel.
let revision = 0;
const focusTrap = createModalFocusTrap({ container: () => panelRef.value, requestClose: () => emit('close') });

function resetCopyState() {
  revision++;
  copying.value = false;
  feedback.value = '';
  copyError.value = '';
}
function invalidate() {
  draft.value.result = null;
  draft.value.error = '';
  resetCopyState();
}
function editInput(value) { draft.value.input = value; invalidate(); }
function editOption(key, value) { draft.value.options[key] = value; invalidate(); }
function loadExample() {
  invalidate();
  try {
    const example = createToolExample(toolId.value, draft.value.options);
    draft.value.options = example.options;
    draft.value.input = example.input;
  } catch (error) { draft.value.error = error.message || '无法载入示例，请检查当前参数。'; }
}
function calculate() {
  invalidate();
  try { draft.value.result = runTool(toolId.value, draft.value.input, draft.value.options); }
  catch (error) { draft.value.error = error.message || '无法计算，请检查输入和参数。'; }
}
async function copy(value) {
  if (copying.value) return;
  const current = revision;
  copying.value = true;
  feedback.value = '';
  copyError.value = '';
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if (current === revision && props.open) feedback.value = '已复制。';
  } catch {
    if (current === revision && props.open) copyError.value = '复制失败，请选中结果后手动复制。';
  } finally {
    if (current === revision) copying.value = false;
  }
}
watch(toolId, resetCopyState);
watch(() => props.open, async (open, previous) => {
  resetCopyState();
  if (open) {
    focusTrap.capture();
    await nextTick();
    if (props.open) focusTrap.activate('[aria-label="关闭工具箱"]');
  } else if (previous) focusTrap.restore();
}, { immediate: true });
onBeforeUnmount(() => { resetCopyState(); focusTrap.restore(); });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop toolbox-overlay"
    >
      <section
        ref="panelRef"
        class="toolbox-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="toolbox-title"
        @keydown="focusTrap.handleKeydown"
      >
        <header class="toolbox-header">
          <div>
            <h2 id="toolbox-title">
              工具箱
            </h2>
            <p>工业数据转换与校验 · 离线计算</p>
          </div>
          <button
            type="button"
            class="toolbox-close"
            aria-label="关闭工具箱"
            title="关闭"
            @click="emit('close')"
          >
            <X :size="18" />
          </button>
        </header>
        <nav
          class="toolbox-groups"
          aria-label="工具分类"
        >
          <button
            v-for="item in TOOL_GROUPS"
            :key="item.id"
            type="button"
            :aria-pressed="group === item.id"
            @click="group = item.id"
          >
            {{ item.label }}
          </button>
        </nav>
        <div class="toolbox-body">
          <label class="toolbox-picker">
            <span>当前工具</span>
            <select
              v-model="selected[group]"
              name="toolbox-tool"
            >
              <option
                v-for="item in toolsInGroup"
                :key="item.id"
                :value="item.id"
              >{{ item.label }}</option>
            </select>
          </label>
          <p class="toolbox-description">
            {{ tool.description }}
          </p>
          <div class="toolbox-workspace">
            <form
              class="toolbox-form"
              @submit.prevent="calculate"
            >
              <div class="toolbox-fields">
                <label
                  v-for="field in tool.fields"
                  :key="`${tool.id}-${field.key}`"
                >
                  <span>{{ field.label }}</span>
                  <select
                    v-if="field.options"
                    :name="field.key"
                    :value="draft.options[field.key]"
                    @change="editOption(field.key, $event.target.value)"
                  >
                    <option
                      v-for="option in field.options"
                      :key="option.value"
                      :value="option.value"
                    >{{ option.label }}</option>
                  </select>
                  <input
                    v-else
                    :name="field.key"
                    :type="field.type || 'text'"
                    :min="field.min"
                    :max="field.max"
                    :step="field.type === 'number' ? 1 : undefined"
                    :value="draft.options[field.key]"
                    autocomplete="off"
                    spellcheck="false"
                    @input="editOption(field.key, $event.target.value)"
                  >
                </label>
              </div>
              <label class="toolbox-input-label">
                <span>输入数据</span>
                <textarea
                  name="toolbox-input"
                  class="toolbox-source"
                  :value="draft.input"
                  :aria-invalid="Boolean(draft.error)"
                  aria-describedby="toolbox-input-hint"
                  rows="6"
                  spellcheck="false"
                  @input="editInput($event.target.value)"
                />
              </label>
              <p
                id="toolbox-input-hint"
                class="toolbox-hint"
              >
                最多 65,536 字符 / 16,384 字节。{{ inputHint }}
              </p>
              <div class="toolbox-actions">
                <button
                  type="submit"
                  class="toolbox-primary"
                >
                  计算
                </button>
                <button
                  type="button"
                  title="按当前选项载入示例，保留转换方向、位宽和算法；同步示例掩码及已填写的核对字节"
                  @click="loadExample"
                >
                  载入示例
                </button>
                <button
                  type="button"
                  @click="editInput('')"
                >
                  清空
                </button>
              </div>
              <p
                v-if="draft.error"
                class="toolbox-error"
                role="alert"
              >
                {{ draft.error }}
              </p>
            </form>
            <section
              class="toolbox-output"
              aria-label="结果区域"
            >
              <h3>计算结果</h3>
              <template v-if="draft.result">
                <p
                  v-if="draft.result.verification !== null"
                  :class="draft.result.verification ? 'toolbox-success' : 'toolbox-error'"
                  :role="draft.result.verification ? 'status' : 'alert'"
                >
                  {{ draft.result.verification ? '校验通过：待核对字节与计算一致。' : '校验不匹配：请核对数据范围、算法与发送顺序。' }}
                </p>
                <div aria-label="计算结果">
                  <div
                    v-for="(row, index) in draft.result.rows"
                    :key="index"
                    class="toolbox-result"
                  >
                    <div>
                      <label :for="`toolbox-result-${index}`">{{ row.label }}</label>
                      <button
                        type="button"
                        :disabled="copying"
                        :aria-label="`复制 ${row.label}`"
                        @click="copy(row.value)"
                      >
                        <Copy :size="14" />复制
                      </button>
                    </div>
                    <textarea
                      :id="`toolbox-result-${index}`"
                      :aria-label="`结果：${row.label}`"
                      :value="row.value"
                      readonly
                      rows="2"
                      spellcheck="false"
                    />
                  </div>
                </div>
                <p class="toolbox-result-note">
                  {{ draft.result.note }}
                </p>
              </template>
              <p
                v-else
                class="toolbox-placeholder"
              >
                输入数据后点击“计算”。修改输入或参数会清除旧结果。
              </p>
              <p
                v-if="feedback"
                class="toolbox-success"
                role="status"
              >
                {{ feedback }}
              </p>
              <p
                v-if="copyError"
                class="toolbox-error"
                role="alert"
              >
                {{ copyError }}
              </p>
            </section>
          </div>
        </div>
        <footer class="toolbox-footer">
          各工具草稿在本次会话中保留；关闭应用后不保存。计算结果不会自动发送到设备。
        </footer>
      </section>
    </div>
  </Teleport>
</template>
