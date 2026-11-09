<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { createOpcuaSimulator } from '../model/opcuaSimulator.js';
import { OPCUA_SERVER_TYPES } from '../model/opcuaSimulatorConfig.js';
import { opcuaDisplayValue } from '../model/opcuaWorkbench.js';
import { formatTimestamp } from '../model/dateTime.js';
import '../styles/opcua.css';
import '../styles/protocolControls.css';
import '../styles/opcuaSimulator.css';
const props = defineProps({ runtime: { type: Object, required: true }, controller: { type: Object, default: null }, endpoint: { type: Object, default: null }, visible: { type: Boolean, default: true } });
const api = props.controller ?? createOpcuaSimulator(props.runtime, { reactive });
const s = api.state;
const index = ref(0), current = ref('');
const selected = computed(() => s.nodes[index.value]);
const locked = computed(() => !!s.sessionId || s.status === 'connecting' || !!s.busy);
const values = computed(() => props.visible ? Object.values(s.values) : []);
const labels = { disconnected: '已停止', connecting: '启动中', listening: '正在监听', error: '服务异常' };
const modes = computed(() => selected.value?.arrayType !== 'Scalar' ? ['manual'] : selected.value?.dataType === 'Boolean' ? ['manual', 'toggle'] : ['Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double'].includes(selected.value?.dataType) ? ['manual', 'increment'] : ['manual']);
const modeNames = { manual: '手动更新', toggle: '定时翻转', increment: '定时递增' };
const asText = node => node ? node.arrayType === 'Array' ? JSON.stringify(node.value) : String(node.value) : '';
const initial = computed({ get: () => selected.value?.initialText ?? asText(selected.value), set: text => { if (selected.value) selected.value.initialText = text; } });
watch(selected, () => { current.value = ''; });
function commitInitial() {
  if (locked.value || !selected.value) return true;
  return api.applyInitialValues();
}
function changeType() {
  const node = selected.value;
  node.value = node.arrayType === 'Array' ? [] : node.dataType === 'Boolean' ? false : ['String', 'ByteString'].includes(node.dataType) ? '' : node.dataType === 'DateTime' ? new Date().toISOString() : node.dataType.endsWith('64') ? '0' : 0;
  node.simulation.mode = 'manual'; delete node.initialText;
}
function selectNode(i) { if (commitInitial()) index.value = i; }
function addNode() { if (commitInitial() && api.addNode()) index.value = s.nodes.length - 1; }
function removeNode() { if (api.removeNode(index.value)) { index.value = Math.min(index.value, s.nodes.length - 1); } }
function examples() { if (api.loadExamples()) { index.value = 0; } }
function start() { if (commitInitial()) void api.connect(); }
function save() { if (commitInitial()) void api.saveProfile(); }
async function importFile(event) {
  const file = event.target.files?.[0];
  try { if (file) { if (file.size > 1048576) throw new Error('导入文件最多 1 MiB'); await api.importProfiles(await file.text()); } }
  catch (error) { s.error = error.message; }
  finally { event.target.value = ''; }
}
onMounted(() => { if (!props.controller) void api.initialize(); });
onBeforeUnmount(() => { if (!props.controller) void api.dispose(); });
</script>

<template>
  <section
    class="opcua-panel"
    aria-label="OPC UA 模拟服务端"
  >
    <header class="opcua-header">
      <div><h1>OPC UA 模拟服务端</h1><p>{{ endpoint?.name ?? s.name }}</p><span class="opcua-muted">节点读写、订阅与自动变化</span></div>
      <span
        class="opcua-status"
        :data-status="s.status"
      >{{ labels[s.status] ?? s.status }}</span>
      <button
        v-if="s.sessionId || s.status === 'connecting'"
        :disabled="s.busy === 'disconnect'"
        @click="api.disconnect()"
      >
        {{ s.status === 'connecting' ? '取消启动' : '停止' }}
      </button>
      <button
        v-else
        class="opcua-primary"
        :disabled="!!s.busy"
        @click="start"
      >
        启动
      </button>
    </header>
    <div
      class="opcua-notices"
      aria-live="polite"
    >
      <p
        v-if="s.error"
        class="opcua-error"
        role="alert"
      >
        {{ s.error }}
      </p>
      <p
        v-if="s.feedback"
        role="status"
      >
        {{ s.feedback }}
      </p>
      <p
        v-if="s.busy"
        class="opcua-muted"
      >
        正在处理…
      </p>
    </div>
    <div class="opcua-body opcua-stack">
      <section
        class="opcua-card opcua-stack"
        aria-label="服务端配置"
      >
        <h2>服务端配置</h2>
        <div class="opcua-grid">
          <label class="opcua-simulator-wide">配置名称<input
            v-model="s.name"
            maxlength="100"
            :disabled="locked"
          ></label>
          <label>监听地址<select
            v-model="s.config.listenHost"
            name="server-host"
            :disabled="locked"
          ><option>127.0.0.1</option><option>0.0.0.0</option></select></label>
          <label>监听端口<input
            v-model.number="s.config.listenPort"
            name="server-port"
            type="number"
            min="1"
            max="65535"
            :disabled="locked"
          ></label>
          <label class="opcua-simulator-wide">路径<input
            v-model="s.config.path"
            name="server-path"
            maxlength="128"
            :disabled="locked"
            spellcheck="false"
          ></label>
          <label class="opcua-simulator-wide">命名空间 URI<input
            v-model="s.config.namespaceUri"
            name="server-namespace"
            maxlength="256"
            :disabled="locked"
            spellcheck="false"
          ></label>
        </div>
        <p class="opcua-muted">
          None / 匿名 · 未加密的测试模拟器。默认只监听本机；0.0.0.0 会允许网络中的客户端连接。
        </p>
        <p
          v-if="s.endpointUrl"
          class="opcua-muted"
        >
          客户端连接地址<code>{{ s.endpointUrl }}</code>{{ s.config.listenHost === '0.0.0.0' ? '远程客户端请使用本机实际 IP 地址。' : '' }}
        </p>
        <div class="opcua-actions">
          <button
            :disabled="locked"
            @click="save"
          >
            保存初始配置
          </button>
          <label class="opcua-file">导入配置<input
            type="file"
            accept=".json,application/json"
            aria-label="导入 OPC UA 服务端配置"
            :disabled="locked"
            @change="importFile"
          ></label>
          <button
            :disabled="!!s.busy || !s.profiles.length"
            @click="api.exportProfiles()"
          >
            导出配置
          </button>
        </div>
      </section>
      <section
        class="opcua-card opcua-stack"
        aria-label="模拟节点"
      >
        <div class="opcua-actions">
          <h2>模拟节点（{{ s.nodes.length }}/100）</h2><button
            :disabled="locked || s.nodes.length >= 100"
            @click="addNode"
          >
            添加节点
          </button><button
            :disabled="locked"
            @click="examples"
          >
            载入示例
          </button>
        </div>
        <div class="opcua-simulator-editor">
          <div
            class="opcua-simulator-nodes"
            aria-label="节点列表"
          >
            <button
              v-for="(node, i) in s.nodes"
              :key="i"
              :aria-pressed="index === i"
              @click="selectNode(i)"
            >
              <strong>{{ node.name }}</strong><code>{{ node.id }}</code><span class="opcua-muted">{{ node.dataType }} · {{ node.arrayType }}</span>
            </button>
          </div>
          <div
            v-if="selected"
            class="opcua-stack"
          >
            <fieldset
              class="opcua-simulator-fields opcua-stack"
              :disabled="locked"
            >
              <legend>节点初始配置</legend>
              <div class="opcua-grid">
                <label>ID<input
                  v-model="selected.id"
                  name="node-id"
                  maxlength="80"
                  spellcheck="false"
                ></label>
                <label>名称<input
                  v-model="selected.name"
                  name="node-name"
                  maxlength="100"
                ></label>
                <label>数据类型<select
                  v-model="selected.dataType"
                  name="node-type"
                  @change="changeType"
                ><option
                  v-for="type in OPCUA_SERVER_TYPES"
                  :key="type"
                >{{ type }}</option></select></label>
                <label>值结构<select
                  v-model="selected.arrayType"
                  name="node-array"
                  @change="changeType"
                ><option>Scalar</option><option>Array</option></select></label>
              </div>
              <label>初始值<textarea
                v-model="initial"
                name="node-initial"
                rows="2"
                spellcheck="false"
              /></label>
              <label class="opcua-check"><input
                v-model="selected.writable"
                type="checkbox"
                name="node-writable"
              >允许远程客户端写入</label>
              <div class="opcua-grid">
                <label>变化方式<select
                  v-model="selected.simulation.mode"
                  name="node-mode"
                ><option
                  v-for="mode in modes"
                  :key="mode"
                  :value="mode"
                >{{ modeNames[mode] }}</option></select></label>
                <label v-if="selected.simulation.mode !== 'manual'">变化间隔（毫秒）<input
                  v-model.number="selected.simulation.intervalMs"
                  type="number"
                  min="100"
                  max="60000"
                  step="100"
                ></label>
                <template v-if="selected.simulation.mode === 'increment'">
                  <label>最小值<input
                    v-model.number="selected.simulation.min"
                    type="number"
                    step="any"
                  ></label>
                  <label>最大值<input
                    v-model.number="selected.simulation.max"
                    type="number"
                    step="any"
                  ></label>
                  <label>递增步长<input
                    v-model.number="selected.simulation.step"
                    type="number"
                    min="0"
                    step="any"
                  ></label>
                </template>
              </div>
              <p class="opcua-muted">
                数组使用 JSON；64 位整数使用十进制字符串，ByteString 使用 base64，DateTime 使用带时区的 ISO 时间。递增后超出范围回到最小值。
              </p>
              <div class="opcua-actions">
                <button @click="commitInitial">
                  应用初始值
                </button><button
                  :disabled="s.nodes.length <= 1"
                  @click="removeNode"
                >
                  删除节点
                </button>
              </div>
            </fieldset>
            <div
              v-if="s.sessionId"
              class="opcua-stack"
            >
              <label>实际 NodeId<code>{{ s.nodeIds[selected.id] }}</code></label>
              <label>更新当前值<textarea
                v-model="current"
                name="node-current"
                rows="2"
                spellcheck="false"
              /></label>
              <div class="opcua-actions">
                <button
                  :disabled="!!s.busy"
                  @click="api.setValue(selected.id, current)"
                >
                  更新当前值
                </button><span class="opcua-muted">本地可更新只读节点；运行值不会覆盖下次启动的初始值。</span>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section
        class="opcua-card opcua-stack"
        aria-label="当前节点值"
      >
        <h2>当前节点值</h2><p class="opcua-muted">
          每秒刷新；自动变化在原生服务端持续运行，切换页面不受影响。
        </p>
        <div
          v-if="visible"
          class="opcua-table opcua-values opcua-values--server"
        >
          <table>
            <colgroup><col class="opcua-value-node"><col class="opcua-value-data"><col class="opcua-value-quality"><col class="opcua-value-time"></colgroup>
            <thead><tr><th>NodeId</th><th>类型 / 值</th><th>质量</th><th>源时间 / 服务器时间</th></tr></thead><tbody>
              <tr
                v-for="row in values"
                :key="row.nodeId"
              >
                <td><code>{{ row.nodeId }}</code></td><td><span>{{ row.dataType }} · {{ row.arrayType }}</span><code>{{ opcuaDisplayValue(row.value) }}</code></td><td>{{ row.statusCode }}</td><td><time>{{ formatTimestamp(row.sourceTimestamp) }}</time><br><time>{{ formatTimestamp(row.serverTimestamp) }}</time></td>
              </tr>
            </tbody>
          </table><p
            v-if="!values.length"
            class="opcua-muted"
          >
            启动服务端后显示当前值。
          </p>
        </div>
      </section>
    </div>
  </section>
</template>
