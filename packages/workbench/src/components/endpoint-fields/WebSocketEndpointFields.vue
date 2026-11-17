<script setup>
import { Trash2 } from 'lucide-vue-next';
// The dialog owns this stable, mutable draft and error map. Fields only edit the
// draft; validation, saving, focus, and asynchronous lifetime stay in the dialog.
const props = defineProps({
  draft: { type: Object, required: true },
  fieldErrors: { type: Object, required: true },
});
const form = props.draft;
const fieldErrors = props.fieldErrors;
</script>

<template>
  <label
    v-if="form.transport === 'websocket-client'"
    class="field-control endpoint-dialog__wide"
  >
    <span>WebSocket URL</span>
    <input
      v-model="form.websocketUrl"
      name="websocket-url"
      placeholder="ws://127.0.0.1:9000/"
      :aria-invalid="Boolean(fieldErrors.url)"
    >
    <small
      v-if="fieldErrors.url"
      class="field-error"
      role="alert"
    >{{ fieldErrors.url }}</small>
    <small class="field-note">wss 使用系统信任证书并校验主机名</small>
  </label>
  <template v-else>
    <label class="field-control"><span>监听地址</span><input
      v-model="form.websocketListenHost"
      name="websocket-listen-host"
      :aria-invalid="Boolean(fieldErrors.listenHost)"
    ><small
      v-if="fieldErrors.listenHost"
      class="field-error"
      role="alert"
    >{{ fieldErrors.listenHost }}</small></label>
    <label class="field-control"><span>监听端口</span><input
      v-model.number="form.websocketListenPort"
      name="websocket-listen-port"
      type="number"
      min="1"
      max="65535"
      :aria-invalid="Boolean(fieldErrors.listenPort)"
    ><small
      v-if="fieldErrors.listenPort"
      class="field-error"
      role="alert"
    >{{ fieldErrors.listenPort }}</small></label>
    <label class="field-control endpoint-dialog__wide"><span>WebSocket 路径</span><input
      v-model="form.websocketPath"
      name="websocket-path"
      :aria-invalid="Boolean(fieldErrors.websocketPath)"
    ><small
      v-if="fieldErrors.websocketPath"
      class="field-error"
      role="alert"
    >{{ fieldErrors.websocketPath }}</small></label>
    <small class="field-note endpoint-dialog__wide">本地 ws 监听，最多 64 个客户端</small>
  </template>
  <label class="field-control endpoint-dialog__wide"><span>子协议（逗号分隔）</span><input
    v-model="form.websocketSubprotocols"
    name="websocket-subprotocols"
    :aria-invalid="Boolean(fieldErrors.subprotocols)"
  ><small
    v-if="fieldErrors.subprotocols"
    class="field-error"
    role="alert"
  >{{ fieldErrors.subprotocols }}</small></label>
  <div class="endpoint-dialog__message-options endpoint-dialog__wide">
    <label class="field-control"><span>默认消息类型</span><select
      v-model="form.websocketMessageType"
      name="websocket-message-type"
    ><option value="text">文本</option><option value="binary">二进制</option></select></label>
    <div class="endpoint-dialog__message-toggles">
      <label
        v-if="form.transport === 'websocket-client'"
        class="check-control"
      ><input
        v-model="form.autoReconnect"
        name="websocket-auto-reconnect"
        type="checkbox"
      >自动重连</label>
      <label class="check-control"><input
        v-model="form.websocketHeartbeatEnabled"
        name="websocket-heartbeat-enabled"
        type="checkbox"
      >Ping/Pong 心跳</label>
    </div>
  </div>
  <label class="field-control"><span>心跳间隔（毫秒）</span><input
    v-model.number="form.websocketHeartbeatIntervalMs"
    name="websocket-heartbeat-interval"
    type="number"
    min="1000"
    max="60000"
    :aria-invalid="Boolean(fieldErrors.heartbeat)"
  ></label>
  <label class="field-control"><span>Pong 超时（毫秒）</span><input
    v-model.number="form.websocketHeartbeatTimeoutMs"
    name="websocket-heartbeat-timeout"
    type="number"
    min="1000"
    max="60000"
  ></label>
  <small
    v-if="fieldErrors.heartbeat"
    class="field-error endpoint-dialog__wide"
    role="alert"
  >{{ fieldErrors.heartbeat }}</small>
  <template v-if="form.transport === 'websocket-client'">
    <div class="field-control endpoint-dialog__wide">
      <span>自定义请求头</span><small class="field-note">仅当前会话保留，不保存或导出；关闭应用后清除。</small>
    </div>
    <template
      v-for="(header, index) in form.websocketHeaders"
      :key="index"
    >
      <label class="field-control"><span>请求头名称 {{ index + 1 }}</span><input
        v-model="header.name"
        :name="`websocket-header-name-${index}`"
        autocomplete="off"
        :aria-invalid="Boolean(fieldErrors.websocketHeaders)"
      ></label>
      <label class="field-control"><span>请求头值 {{ index + 1 }}</span><div class="field-control__with-action"><input
        v-model="header.value"
        :name="`websocket-header-value-${index}`"
        type="password"
        autocomplete="off"
      ><button
        type="button"
        class="icon-button"
        :aria-label="`删除请求头 ${index + 1}`"
        @click="form.websocketHeaders.splice(index, 1)"
      ><Trash2 :size="14" /></button></div></label>
    </template>
    <button
      type="button"
      class="command-button command-button--quiet"
      :disabled="form.websocketHeaders.length >= 32"
      @click="form.websocketHeaders.push({ name: '', value: '' })"
    >
      添加请求头
    </button>
    <small
      v-if="fieldErrors.websocketHeaders"
      class="field-error endpoint-dialog__wide"
      role="alert"
    >{{ fieldErrors.websocketHeaders }}</small>
  </template>
</template>
