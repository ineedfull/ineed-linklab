<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { createStompWorkbench } from '../model/stompWorkbench.js';
import { formatTimestamp } from '../model/dateTime.js';
import StompMessage from './StompMessage.vue';
import '../styles/stomp.css';
import '../styles/protocolControls.css';

const props = defineProps({
  runtime: { type: Object, required: true },
  controller: { type: Object, default: null },
  endpoint: { type: Object, default: null },
  visible: { type: Boolean, default: true },
});
const emit = defineEmits(['back']);
const api = props.controller ?? createStompWorkbench(props.runtime, { reactive });
const s = api.state;
// Protocol processing stays immediate. Publish the bounded history to the view
// once per screen frame so a busy stream cannot repaint 500 rows per message.
const messages = shallowRef(props.visible ? [...s.messages] : []);
let historyFrame = null;
function cancelHistoryFrame() {
  if (historyFrame !== null) window.cancelAnimationFrame(historyFrame);
  historyFrame = null;
}
watch(() => [props.visible, s.messages, s.messages.length, s.messages.at(-1)?.id], () => {
  if (!props.visible || !s.messages.length) { cancelHistoryFrame(); messages.value = []; return; }
  if (historyFrame !== null) return;
  historyFrame = window.requestAnimationFrame(() => {
    historyFrame = null;
    messages.value = [...s.messages];
  });
}, { flush: 'post' });
const tab = ref('连接与认证');
const subscription = reactive({ destination: '/topic/events', ack: 'auto' });
const outgoing = reactive({ destination: '/topic/events', body: '', contentType: 'text/plain', receipt: true });
const locked = computed(() => !!s.busy || s.status !== 'disconnected');
const active = computed(() => s.status !== 'disconnected');
const ready = computed(() => s.mode === 'client' ? s.status === 'connected' : s.status === 'listening');
const pendingOutsideHistory = computed(() => {
  if (!props.visible || s.mode !== 'client' || s.status !== 'connected') return [];
  const displayed = new Set(messages.value.map(message => message.id));
  return (s.pendingMessages ?? []).filter(message => !displayed.has(message.id));
});
const labels = { disconnected: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', listening: '监听中' };
async function run(action, ...args) {
  try { return await api[action](...args); }
  catch (error) { s.error = error?.message || '操作失败，请重试'; }
}
onMounted(() => { if (!props.controller) void run('initialize'); });
onBeforeUnmount(() => { cancelHistoryFrame(); if (!props.controller) void Promise.resolve(api.dispose()).catch(() => {}); });
</script>

<template>
  <section
    class="stomp-panel"
    aria-label="STOMP 工作台"
  >
    <header class="stomp-header">
      <div>
        <h1>STOMP</h1><strong v-if="endpoint">{{ endpoint.name }}</strong><p class="stomp-muted">
          WebSocket 消息订阅与本地联调服务
        </p>
      </div>
      <span
        class="stomp-status"
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
        v-if="active"
        type="button"
        :disabled="s.busy === 'disconnect'"
        @click="run('disconnect')"
      >
        {{ s.status === 'connecting' ? '取消连接' : s.mode === 'server' ? '停止服务' : '断开' }}
      </button>
      <button
        v-else
        type="button"
        class="stomp-primary"
        :disabled="!!s.busy"
        @click="run('connect')"
      >
        {{ s.mode === 'client' ? '连接' : '启动服务' }}
      </button>
    </header>
    <nav
      class="stomp-tabs"
      aria-label="STOMP 分区"
    >
      <button
        v-for="item in ['连接与认证', '消息与订阅']"
        :key="item"
        type="button"
        :aria-pressed="tab === item"
        @click="tab = item"
      >
        {{ item }}
      </button>
    </nav>
    <div
      class="stomp-notices"
      aria-live="polite"
    >
      <p
        v-if="s.error"
        role="alert"
        class="stomp-error"
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
        class="stomp-muted"
      >
        正在处理…
      </p>
    </div>
    <div class="stomp-body">
      <section
        v-show="tab === '连接与认证'"
        class="stomp-stack"
        aria-label="STOMP 连接与认证"
      >
        <div class="stomp-card stomp-stack">
          <h2>连接配置</h2>
          <div class="stomp-grid">
            <label v-if="!endpoint">已保存配置<select
              name="stomp-profile"
              :value="s.profileId"
              :disabled="locked"
              @change="run('selectProfile', $event.target.value)"
            >
              <option value="">新建配置</option><option
                v-for="profile in s.profiles"
                :key="profile.id"
                :value="profile.id"
              >{{ profile.name }}</option>
            </select></label>
            <label>配置名称<input
              v-model="s.name"
              name="stomp-name"
              maxlength="100"
              :disabled="locked"
            ></label>
          </div>
          <div class="stomp-actions">
            <button
              type="button"
              :disabled="locked"
              @click="run('saveProfile')"
            >
              保存配置
            </button>
            <button
              v-if="!endpoint"
              type="button"
              :disabled="locked || !s.profileId"
              @click="run('deleteProfile')"
            >
              删除配置
            </button>
          </div>
          <p class="stomp-muted">
            保存角色、连接设置与订阅目的地。登录名、口令、请求头及服务端认证值仅用于本次会话，不会保存。
          </p>
        </div>
        <div class="stomp-card stomp-stack">
          <h2>服务地址</h2>
          <div class="stomp-grid">
            <label v-if="!endpoint">连接角色<select
              v-model="s.mode"
              name="stomp-mode"
              :disabled="locked"
            ><option value="client">客户端</option><option value="server">服务端（本地联调）</option></select></label>
            <label>Virtual host<input
              v-model="s.config.host"
              name="stomp-host"
              :disabled="locked"
              spellcheck="false"
            ></label>
            <label
              v-if="s.mode === 'client'"
              class="stomp-wide"
            >WebSocket URL<input
              v-model="s.config.url"
              name="stomp-url"
              :disabled="locked"
              spellcheck="false"
              placeholder="ws://127.0.0.1:61614/stomp"
            ></label>
            <template v-else>
              <label>监听地址<input
                v-model="s.config.listenHost"
                name="stomp-listen-host"
                :disabled="locked"
                spellcheck="false"
              ></label>
              <label>监听端口<input
                v-model.number="s.config.listenPort"
                name="stomp-listen-port"
                type="number"
                min="1"
                max="65535"
                :disabled="locked"
              ></label>
              <label class="stomp-wide">WebSocket 路径<input
                v-model="s.config.path"
                name="stomp-path"
                :disabled="locked"
                spellcheck="false"
              ></label>
            </template>
            <label>发送心跳（毫秒）<input
              v-model.number="s.config.heartbeatOutgoing"
              name="stomp-heartbeat-out"
              type="number"
              min="0"
              max="60000"
              step="1000"
              :disabled="locked"
            ></label>
            <label>期望接收心跳（毫秒）<input
              v-model.number="s.config.heartbeatIncoming"
              name="stomp-heartbeat-in"
              type="number"
              min="0"
              max="60000"
              step="1000"
              :disabled="locked"
            ></label>
          </div>
          <label
            v-if="s.mode === 'client'"
            class="stomp-check"
          ><input
            v-model="s.config.autoReconnect"
            type="checkbox"
            :disabled="locked"
          >断线后自动重连并恢复订阅</label>
          <p class="stomp-muted">
            心跳填 0 表示关闭该方向，实际间隔由双方协商。修改连接与认证设置前请先断开。
          </p>
        </div>
        <div class="stomp-card stomp-stack">
          <h2>临时认证</h2>
          <label
            v-if="s.mode === 'server'"
            class="stomp-check"
          ><input
            v-model="s.credentials.requireAuthentication"
            name="stomp-require-auth"
            type="checkbox"
            :disabled="locked"
          >要求账号密码</label>
          <div class="stomp-grid">
            <label>登录名<input
              v-model="s.credentials.login"
              name="stomp-login"
              autocomplete="off"
              :disabled="locked || (s.mode === 'server' && !s.credentials.requireAuthentication)"
            ></label>
            <label>口令<input
              v-model="s.credentials.passcode"
              name="stomp-passcode"
              type="password"
              autocomplete="off"
              :disabled="locked || (s.mode === 'server' && !s.credentials.requireAuthentication)"
            ></label>
          </div>
          <template v-if="s.mode === 'client'">
            <h3>WebSocket 握手请求头</h3>
            <div
              v-for="(header, index) in s.credentials.headers"
              :key="index"
              class="stomp-header-row"
            >
              <label>名称<input
                v-model="header.name"
                :aria-label="`请求头名称 ${index + 1}`"
                :disabled="locked"
                spellcheck="false"
                autocomplete="off"
              ></label>
              <label>值<input
                v-model="header.value"
                :aria-label="`请求头值 ${index + 1}`"
                :disabled="locked"
                type="password"
                autocomplete="off"
              ></label>
              <button
                type="button"
                :disabled="locked"
                :aria-label="`移除请求头 ${index + 1}`"
                @click="s.credentials.headers.splice(index, 1)"
              >
                移除
              </button>
            </div>
            <div class="stomp-actions">
              <button
                type="button"
                :disabled="locked || s.credentials.headers.length >= 32"
                @click="s.credentials.headers.push({ name: '', value: '' })"
              >
                添加请求头
              </button>
            </div>
          </template>
          <p class="stomp-muted">
            账号密码与请求头不进入历史记录或消息导出。远程连接可使用 wss，由系统验证 TLS 证书。
          </p>
        </div>
        <div
          v-if="s.mode === 'server'"
          class="stomp-card stomp-stack"
        >
          <h2>本地联调 broker</h2>
          <p>/topic/ 精确目的地广播，/queue/ 精确目的地轮转分发。无消费者的 topic 不留存；queue 仅在本次服务运行内暂存。</p>
          <p class="stomp-muted">
            不支持事务、通配订阅、SockJS、持久队列或集群。停止服务将释放连接和未消费消息。
          </p>
        </div>
      </section>
      <section
        v-show="tab === '消息与订阅'"
        class="stomp-stack"
        aria-label="STOMP 消息与订阅"
      >
        <div
          v-if="s.mode === 'client'"
          class="stomp-card stomp-stack"
        >
          <h2>订阅目的地</h2>
          <form
            data-testid="stomp-subscribe"
            class="stomp-stack"
            @submit.prevent="run('subscribe', { ...subscription })"
          >
            <div class="stomp-grid">
              <label>订阅目的地<input
                v-model="subscription.destination"
                name="stomp-sub-destination"
                placeholder="/topic/events"
                spellcheck="false"
                :disabled="!!s.busy"
              ></label>
              <label>确认模式<select
                v-model="subscription.ack"
                name="stomp-sub-ack"
                :disabled="!!s.busy"
              ><option value="auto">auto · 自动确认</option><option value="client">client · 累计确认</option><option value="client-individual">client-individual · 逐条确认</option></select></label>
            </div>
            <div class="stomp-actions">
              <button
                type="submit"
                :disabled="!ready || !!s.busy"
              >
                订阅
              </button><span class="stomp-muted">{{ s.subscriptions.length }} / 100 个订阅</span>
            </div>
          </form>
          <div
            v-if="s.subscriptions.length"
            class="stomp-subscriptions"
          >
            <div
              v-for="row in s.subscriptions"
              :key="row.id"
              class="stomp-subscription"
            >
              <div><code>{{ row.destination }}</code><span class="stomp-muted">{{ row.id }} · {{ row.ack }}</span></div><button
                type="button"
                :disabled="!ready || !!s.busy"
                @click="run('unsubscribe', row.id)"
              >
                退订
              </button>
            </div>
          </div>
          <p class="stomp-muted">
            client 模式的 ACK/NACK 同时影响此前尚未确认的消息；client-individual 仅影响所选消息。
          </p>
        </div>
        <div
          v-else
          class="stomp-card stomp-stack"
        >
          <h2>客户端连接（{{ s.peers.length }} / 64）</h2>
          <ul
            v-if="s.peers.length"
            class="stomp-peers"
          >
            <li
              v-for="peer in s.peers"
              :key="peer.id"
            >
              <code>{{ peer.id }}</code><span>{{ peer.remoteAddress }}</span><span
                v-if="peer.protocolConnected !== undefined"
                class="stomp-muted"
              >{{ peer.protocolConnected ? 'STOMP 已连接' : '等待 STOMP 握手' }}</span>
            </li>
          </ul>
          <p
            v-else
            class="stomp-muted"
          >
            暂无客户端，启动服务后可使用其它 STOMP 1.2 客户端接入。
          </p>
          <p class="stomp-muted">
            本地联调 broker 支持 /topic/ 广播与 /queue/ 轮转；不支持事务、通配订阅、SockJS、持久队列或集群。
          </p>
        </div>
        <form
          data-testid="stomp-send"
          class="stomp-card stomp-stack"
          @submit.prevent="run('send', { ...outgoing })"
        >
          <h2>{{ s.mode === 'server' ? '发布测试消息' : '发送消息' }}</h2>
          <div class="stomp-grid">
            <label>发送目的地<input
              v-model="outgoing.destination"
              name="stomp-send-destination"
              placeholder="/topic/events"
              spellcheck="false"
              :disabled="!!s.busy"
            ></label><label>Content-Type<input
              v-model="outgoing.contentType"
              name="stomp-content-type"
              spellcheck="false"
              :disabled="!!s.busy"
            ></label>
          </div>
          <label>消息内容<textarea
            v-model="outgoing.body"
            name="stomp-body"
            rows="5"
            spellcheck="false"
            :disabled="!!s.busy"
          /></label>
          <div class="stomp-actions">
            <button
              type="submit"
              class="stomp-primary"
              :disabled="!ready || !!s.busy"
            >
              {{ s.mode === 'server' ? '发布消息' : '发送' }}
            </button><label
              v-if="s.mode === 'client'"
              class="stomp-check"
            ><input
              v-model="outgoing.receipt"
              name="stomp-receipt"
              type="checkbox"
              :disabled="!!s.busy"
            >请求 RECEIPT 回执</label>
          </div>
        </form>
        <section
          v-if="pendingOutsideHistory.length"
          class="stomp-card stomp-stack"
          aria-label="待确认消息"
        >
          <h2>待确认消息（{{ pendingOutsideHistory.length }}）</h2>
          <p class="stomp-muted">
            以下消息已移出实时列表，仍可确认或拒绝。这里只保留确认信息，不保留正文。
          </p>
          <ul class="stomp-pending-list">
            <li
              v-for="message in pendingOutsideHistory"
              :key="message.id"
              class="stomp-pending-item"
            >
              <code>{{ message.destination }}</code>
              <dl class="stomp-message-meta">
                <dt>subscription</dt><dd>{{ message.subscription }}</dd>
                <dt>message-id</dt><dd>{{ message.messageId }}</dd>
                <dt>ack-id</dt><dd>{{ message.ackId }}</dd>
              </dl>
              <div class="stomp-actions">
                <button
                  type="button"
                  :disabled="!!s.busy"
                  @click="run('ack', message.id)"
                >
                  ACK
                </button>
                <button
                  type="button"
                  :disabled="!!s.busy"
                  @click="run('nack', message.id)"
                >
                  NACK
                </button>
                <span class="stomp-muted">{{ message.ack }} · {{ formatTimestamp(message.createdAt) }}</span>
              </div>
            </li>
          </ul>
        </section>
        <div class="stomp-card stomp-stack stomp-messages">
          <div class="stomp-actions">
            <h2>实时消息（{{ messages.length }} / 500）</h2><button
              type="button"
              :disabled="!messages.length"
              @click="run('clearMessages')"
            >
              清空消息
            </button>
          </div>
          <p
            v-if="!messages.length"
            class="stomp-muted"
          >
            暂无消息。连接后订阅目的地，或发送一条测试消息。
          </p>
          <StompMessage
            v-for="message in messages"
            :key="message.id"
            :message="message"
            :mode="s.mode"
            :connection-status="s.status"
            :busy="!!s.busy"
            @ack="run('ack', $event)"
            @nack="run('nack', $event)"
          />
        </div>
      </section>
    </div>
  </section>
</template>
