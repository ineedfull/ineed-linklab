<script setup>
import { formatTimestamp } from '../model/dateTime.js';
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { createOpcuaWorkbench, OPCUA_WRITE_TYPES, opcuaDisplayValue } from '../model/opcuaWorkbench.js';
import '../styles/opcua.css';
import '../styles/protocolControls.css';
const props = defineProps({
  runtime: { type: Object, required: true },
  controller: { type: Object, default: null },
  endpoint: { type: Object, default: null },
});
const emit = defineEmits(['back']);
const api = props.controller ?? createOpcuaWorkbench(props.runtime, { reactive });
const s = api.state;
const tab = ref('连接与安全');
const tabs = ['连接与安全', '节点与监视', '证书'];
const selected = ref([]); const filter = ref(''); const interval = ref(1000);
const confirmations = reactive({});
const editor = reactive({ nodeId: '', dataType: 'String', arrayType: 'Scalar', text: '', confirmed: false });
const connected = computed(() => s.status === 'connected' && !!s.sessionId);
const locked = computed(() => !!s.sessionId || !!s.busy || s.status === 'reconnecting');
const nodes = computed(() => s.nodes.filter(n => `${n.nodeId} ${n.displayName}`.toLowerCase().includes(filter.value.toLowerCase())));
const values = computed(() => Object.values(s.values));
const labels = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', disconnected: '未连接', error: '连接异常' };
watch(() => s.sessionId, () => { selected.value = []; editor.nodeId = ''; });
watch(nodes, current => {
  const visible = new Set(current.map(node => node.nodeId));
  selected.value = selected.value.filter(id => visible.has(id));
}, { flush: 'sync' });
watch(() => [editor.nodeId, editor.dataType, editor.arrayType, editor.text], () => { editor.confirmed = false; });
function edit(row) {
  Object.assign(editor, { nodeId: row.nodeId, dataType: row.dataType, arrayType: row.arrayType,
    text: row.arrayType === 'Array' ? JSON.stringify(row.value) : String(row.value ?? ''), confirmed: false });
}
async function write() { if (editor.confirmed) { await api.write({ ...editor }); editor.confirmed = false; } }
async function importFile(event) {
  const file = event.target.files?.[0];
  try { if (file) { if (file.size > 1048576) throw new Error('导入文件最多 1 MiB'); await api.importProfiles(await file.text()); } }
  catch (error) { s.error = error.message; }
  finally { event.target.value = ''; }
}
function supported(endpoint) { return ['None', 'Basic256Sha256'].includes(endpoint.securityPolicy); }
onMounted(() => { if (!props.controller) void api.initialize(); });
onBeforeUnmount(() => { if (!props.controller) void api.dispose(); });
</script>

<template>
  <section
    class="opcua-panel"
    aria-label="OPC UA 工作台"
  >
    <header class="opcua-header">
      <div>
        <h1>OPC UA</h1><p v-if="endpoint">
          {{ endpoint.name }}
        </p><span class="opcua-muted">工业节点浏览、读写与订阅</span>
      </div>
      <span
        class="opcua-status"
        :data-status="s.status"
      >{{ labels[s.status] || s.status }}</span>
      <button
        v-if="!endpoint"
        type="button"
        @click="emit('back')"
      >
        返回通信
      </button>
      <button
        v-if="s.sessionId || ['connecting', 'reconnecting'].includes(s.status)"
        type="button"
        :disabled="s.busy === 'disconnect'"
        @click="api.disconnect()"
      >
        {{ ['connecting', 'reconnecting'].includes(s.status) ? '取消连接' : '断开' }}
      </button>
      <button
        v-else
        type="button"
        class="opcua-primary"
        :disabled="!!s.busy"
        @click="api.connect()"
      >
        连接
      </button>
    </header>
    <nav
      class="opcua-tabs"
      aria-label="OPC UA 分区"
    >
      <button
        v-for="item in tabs"
        :key="item"
        type="button"
        :aria-pressed="tab === item"
        @click="tab = item"
      >
        {{ item }}
      </button>
    </nav>
    <div
      class="opcua-notices"
      aria-live="polite"
    >
      <p
        v-if="s.error"
        role="alert"
        class="opcua-error"
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
        v-if="s.statusMessage"
        class="opcua-muted"
      >
        {{ s.statusMessage }}
      </p>
      <p
        v-if="s.busy"
        class="opcua-muted"
      >
        正在处理…
      </p>
    </div>
    <div class="opcua-body">
      <section
        v-show="tab === '连接与安全'"
        class="opcua-stack"
        aria-label="连接与安全设置"
      >
        <div class="opcua-card opcua-stack">
          <h2>连接配置</h2>
          <div class="opcua-grid">
            <label v-if="!endpoint">已保存连接<select
              :value="s.profileId"
              :disabled="locked"
              @change="api.selectProfile($event.target.value)"
            ><option value="">新建连接</option><option
              v-for="p in s.profiles"
              :key="p.id"
              :value="p.id"
            >{{ p.name }}</option></select></label>
            <label>配置名称<input
              v-model="s.name"
              maxlength="100"
              :disabled="!!s.busy"
            ></label>
          </div>
          <div class="opcua-actions">
            <button
              :disabled="!!s.busy"
              @click="api.saveProfile()"
            >
              保存连接与收藏
            </button>
            <button
              v-if="!endpoint"
              :disabled="locked || !s.profileId"
              @click="api.deleteProfile()"
            >
              删除配置
            </button>
            <label class="opcua-file">导入配置<input
              aria-label="导入 OPC UA 配置"
              type="file"
              accept=".json,application/json"
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
          <p class="opcua-muted">
            密码仅保留在本次会话内，保存与导出均不包含密码。
          </p>
        </div>
        <div class="opcua-card opcua-stack">
          <h2>服务器与安全</h2>
          <div class="opcua-address">
            <label>Endpoint URL<input
              v-model="s.config.endpointUrl"
              :disabled="locked"
              placeholder="opc.tcp://127.0.0.1:4840"
              spellcheck="false"
            ></label><button
              :disabled="locked"
              @click="api.discover()"
            >
              发现端点
            </button>
          </div>
          <label v-if="s.endpoints.length">发现的端点<select
            :disabled="locked"
            value=""
            @change="api.chooseEndpoint($event.target.value)"
          ><option
            value=""
            disabled
          >选择服务器提供的安全端点</option><option
            v-for="(discoveredEndpoint, index) in s.endpoints"
            :key="index"
            :value="index"
            :disabled="!supported(discoveredEndpoint)"
          >{{ discoveredEndpoint.securityPolicy }} / {{ discoveredEndpoint.securityMode }} · {{ discoveredEndpoint.endpointUrl }}{{ supported(discoveredEndpoint) ? '' : '（暂不支持）' }}</option></select></label>
          <div class="opcua-grid">
            <label>安全策略<select
              v-model="s.config.securityPolicy"
              :disabled="locked"
              @change="s.config.securityMode = s.config.securityPolicy === 'None' ? 'None' : 'SignAndEncrypt'"
            ><option>None</option><option>Basic256Sha256</option></select></label>
            <label>消息安全模式<select
              v-model="s.config.securityMode"
              :disabled="locked"
            ><option v-if="s.config.securityPolicy === 'None'">None</option><template v-else><option>Sign</option><option>SignAndEncrypt</option></template></select></label>
            <label>认证<select
              v-model="s.config.authentication"
              :disabled="locked"
            ><option value="anonymous">匿名</option><option value="username">用户名与密码</option></select></label>
            <template v-if="s.config.authentication === 'username'">
              <label>用户名<input
                v-model="s.config.username"
                :disabled="locked"
                autocomplete="off"
              ></label><label>密码<input
                v-model="s.config.password"
                :disabled="locked"
                type="password"
                autocomplete="off"
              ></label>
            </template>
          </div>
          <p class="opcua-muted">
            {{ s.config.securityMode === 'SignAndEncrypt' ? '消息已选择签名与加密。未知证书需到“证书”页核对指纹并明确信任。' : '当前消息未加密。生产连接建议选择 Basic256Sha256 / SignAndEncrypt。' }}
          </p>
        </div>
      </section>
      <section
        v-show="tab === '节点与监视'"
        class="opcua-stack"
        aria-label="节点与监视"
      >
        <div class="opcua-card opcua-stack">
          <h2>节点浏览</h2>
          <div class="opcua-actions">
            <button
              v-for="n in s.breadcrumbs"
              :key="n.nodeId"
              :disabled="!connected || !!s.busy"
              @click="api.browse(n)"
            >
              {{ n.displayName }}
            </button>
          </div>
          <div class="opcua-address">
            <label>NodeId<input
              v-model="s.nodeId"
              spellcheck="false"
              placeholder="i=85"
            ></label><button
              :disabled="!connected || !!s.busy"
              @click="api.browse()"
            >
              浏览
            </button><button
              :disabled="!connected || !!s.busy"
              @click="api.read([s.nodeId])"
            >
              读取节点
            </button>
          </div>
          <label>筛选当前层已加载节点<input
            v-model="filter"
            type="search"
            placeholder="节点名称或 NodeId"
          ></label>
          <div class="opcua-table">
            <table>
              <thead><tr><th>选择</th><th>名称 / NodeId</th><th>类别</th><th>操作</th></tr></thead><tbody>
                <tr
                  v-for="node in nodes"
                  :key="node.nodeId"
                >
                  <td>
                    <input
                      v-model="selected"
                      type="checkbox"
                      :value="node.nodeId"
                      :aria-label="`选择 ${node.displayName}`"
                    >
                  </td><td><strong>{{ node.displayName }}</strong><code>{{ node.nodeId }}</code></td><td>{{ node.nodeClass }}</td><td>
                    <div class="opcua-actions">
                      <button
                        :disabled="!connected || !!s.busy"
                        @click="api.browse(node)"
                      >
                        展开
                      </button><button
                        :disabled="!connected || !!s.busy"
                        @click="api.read([node.nodeId])"
                      >
                        读取
                      </button><button
                        :aria-label="`收藏 ${node.displayName}`"
                        :aria-pressed="s.favorites.some(n => n.nodeId === node.nodeId)"
                        @click="api.toggleFavorite(node)"
                      >
                        {{ s.favorites.some(n => n.nodeId === node.nodeId) ? '已收藏' : '收藏' }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table><p
              v-if="!nodes.length"
              class="opcua-muted"
            >
              连接后点击“浏览”载入节点。筛选仅针对当前层已加载的节点。
            </p>
          </div>
          <button
            v-if="s.continuationPoint"
            :disabled="!connected || !!s.busy"
            @click="api.browse(undefined, true)"
          >
            加载更多（已加载 {{ s.nodes.length }} / 2000）
          </button>
          <div
            v-if="s.favorites.length"
            class="opcua-actions"
          >
            <span>收藏</span><button
              v-for="n in s.favorites"
              :key="n.nodeId"
              :title="n.nodeId"
              :disabled="!connected || !!s.busy"
              @click="api.read([n.nodeId])"
            >
              {{ n.displayName }}
            </button>
          </div>
          <div class="opcua-actions">
            <label>采样间隔（毫秒）<input
              v-model.number="interval"
              type="number"
              min="100"
              max="60000"
              step="100"
            ></label><button
              :disabled="!connected || !!s.busy || !selected.length || selected.length > 100"
              @click="api.read(selected)"
            >
              读取所选
            </button><button
              :disabled="!connected || !!s.busy || !selected.length || selected.length > 100"
              @click="api.subscribe(selected, interval)"
            >
              监视所选（{{ selected.length }}/100）
            </button><button
              :disabled="!connected || !!s.busy || !s.subscriptionId"
              @click="api.unsubscribe()"
            >
              停止监视
            </button>
          </div>
          <p
            v-if="s.monitored.length"
            class="opcua-muted"
          >
            当前监视 {{ s.monitored.length }} 个节点；断线时自动尝试恢复。
          </p>
        </div>
        <div class="opcua-card opcua-stack">
          <h2>最新值（{{ values.length }} / 500）</h2><div class="opcua-table opcua-values opcua-values--client">
            <table>
              <colgroup><col class="opcua-value-node"><col class="opcua-value-data"><col class="opcua-value-quality"><col class="opcua-value-time"><col class="opcua-value-actions"></colgroup>
              <thead><tr><th>NodeId</th><th>类型 / 值</th><th>质量</th><th>源时间 / 服务器时间</th><th>操作</th></tr></thead><tbody>
                <tr
                  v-for="row in values"
                  :key="row.nodeId"
                >
                  <td><code>{{ row.nodeId }}</code></td><td><span>{{ row.dataType }} · {{ row.arrayType }}</span><code>{{ opcuaDisplayValue(row.value) }}</code></td><td>{{ row.statusCode }}</td><td><time>{{ formatTimestamp(row.sourceTimestamp) }}</time><br><time>{{ formatTimestamp(row.serverTimestamp) }}</time></td><td>
                    <button
                      :disabled="!connected || !!s.busy || !OPCUA_WRITE_TYPES.includes(row.dataType) || !['Scalar','Array'].includes(row.arrayType)"
                      @click="edit(row)"
                    >
                      准备写入
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <form
          v-if="editor.nodeId"
          class="opcua-card opcua-stack"
          @submit.prevent="write"
        >
          <h2>写入节点值</h2><code>{{ editor.nodeId }}</code><div class="opcua-grid">
            <label>数据类型<select v-model="editor.dataType"><option
              v-for="t in OPCUA_WRITE_TYPES"
              :key="t"
            >{{ t }}</option></select></label><label>值结构<select v-model="editor.arrayType"><option>Scalar</option><option>Array</option></select></label>
          </div><label>新值<textarea
            v-model="editor.text"
            rows="3"
            spellcheck="false"
          /></label><p class="opcua-muted">
            数组使用 JSON；64 位整数数组的每一项必须是十进制字符串；ByteString 使用 base64。复杂结构仅支持读取。
          </p><label class="opcua-check"><input
            v-model="editor.confirmed"
            name="write-confirm"
            type="checkbox"
          >我已核对目标节点及新值，确认写入设备</label><button
            data-testid="opcua-write"
            type="submit"
            :disabled="!connected || !!s.busy || !editor.confirmed"
            class="opcua-primary"
          >
            确认写入
          </button>
        </form>
        <div class="opcua-card opcua-actions">
          <span>最近变化 {{ s.records.length }} / 1000 条</span><button
            :disabled="!!s.busy || !s.records.length"
            @click="api.exportData()"
          >
            导出 CSV
          </button><button
            :disabled="!s.records.length"
            @click="api.clearRecords()"
          >
            清空记录
          </button><span class="opcua-muted">清空记录后继续监视，最新值保留。</span>
        </div>
      </section>
      <section
        v-show="tab === '证书'"
        class="opcua-stack"
        aria-label="服务器证书"
      >
        <div class="opcua-actions">
          <h2>服务器证书</h2><button
            :disabled="!!s.busy"
            @click="api.loadCertificates()"
          >
            刷新证书
          </button>
        </div>
        <p class="opcua-muted">
          安全连接拒绝未知证书后，刷新列表。请通过可信渠道核对 SHA-256 指纹、有效期和服务器身份，再确认信任并重新连接。
        </p>
        <article
          v-for="cert in s.certificates"
          :key="cert.fingerprint"
          class="opcua-card opcua-stack"
        >
          <strong>{{ cert.subject }}</strong><label>SHA-256 指纹<code>{{ cert.fingerprint }}</code></label><span>有效期：{{ formatTimestamp(cert.validFrom) }} 至 {{ formatTimestamp(cert.validTo) }}</span><span v-if="cert.trusted">已信任</span><template v-else>
            <label class="opcua-check"><input
              v-model="confirmations[cert.fingerprint]"
              :name="`trust-${cert.fingerprint}`"
              type="checkbox"
            >已核对指纹与服务器身份</label><button
              data-testid="opcua-trust"
              :disabled="!!s.busy || !confirmations[cert.fingerprint]"
              @click="api.trust(cert.fingerprint)"
            >
              信任此证书
            </button>
          </template>
        </article>
        <p
          v-if="!s.certificates.length"
          class="opcua-muted"
        >
          暂无证书记录。此列表来自当前桌面客户端的独立证书存储。
        </p>
      </section>
    </div>
  </section>
</template>
