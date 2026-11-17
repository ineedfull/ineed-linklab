<script setup>
// The dialog owns this stable, mutable draft and error map. Fields only edit the
// draft; validation, saving, focus, and asynchronous lifetime stay in the dialog.
const props = defineProps({
  draft: { type: Object, required: true },
  fieldErrors: { type: Object, required: true },
  connectionLocked: Boolean,
});
const form = props.draft;
const fieldErrors = props.fieldErrors;
</script>

<template>
  <label
    v-if="form.transport === 'opcua-client'"
    class="field-control endpoint-dialog__wide"
  >
    <span>Endpoint URL</span><input
      v-model="form.opcuaEndpointUrl"
      name="opcua-endpoint-url"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.endpointUrl)"
    >
    <small
      v-if="fieldErrors.endpointUrl"
      class="field-error"
      role="alert"
    >{{ fieldErrors.endpointUrl }}</small>
  </label>
  <label
    v-else-if="form.transport === 'stomp-client'"
    class="field-control endpoint-dialog__wide"
  >
    <span>WebSocket URL</span><input
      v-model="form.stompUrl"
      name="stomp-url"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.url)"
    >
    <small
      v-if="fieldErrors.url"
      class="field-error"
      role="alert"
    >{{ fieldErrors.url }}</small>
  </label>
  <template v-else-if="form.transport === 'opcua-server'">
    <label class="field-control"><span>监听地址</span><select
      v-model="form.opcuaServerHost"
      name="opcua-server-host"
      :disabled="connectionLocked"
    ><option>127.0.0.1</option><option>0.0.0.0</option></select></label>
    <label class="field-control"><span>监听端口</span><input
      v-model.number="form.opcuaServerPort"
      name="opcua-server-port"
      type="number"
      min="1"
      max="65535"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.listenPort)"
    ><small
      v-if="fieldErrors.listenPort"
      class="field-error"
      role="alert"
    >{{ fieldErrors.listenPort }}</small></label>
    <label class="field-control endpoint-dialog__wide"><span>路径</span><input
      v-model="form.opcuaServerPath"
      name="opcua-server-path"
      maxlength="128"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.path)"
    ><small
      v-if="fieldErrors.path"
      class="field-error"
      role="alert"
    >{{ fieldErrors.path }}</small></label>
    <label class="field-control endpoint-dialog__wide"><span>命名空间 URI</span><input
      v-model="form.opcuaNamespaceUri"
      name="opcua-namespace-uri"
      maxlength="256"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.namespaceUri)"
    ><small
      v-if="fieldErrors.namespaceUri"
      class="field-error"
      role="alert"
    >{{ fieldErrors.namespaceUri }}</small></label>
    <p class="field-note endpoint-dialog__wide">
      None / 匿名测试模拟器。保存后可在工作台编辑节点与自动变化；默认仅监听本机。
    </p>
  </template>
  <template v-else>
    <label class="field-control"><span>监听地址</span><input
      v-model="form.stompListenHost"
      name="stomp-listen-host"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.listenHost)"
    ><small
      v-if="fieldErrors.listenHost"
      class="field-error"
      role="alert"
    >{{ fieldErrors.listenHost }}</small></label>
    <label class="field-control"><span>监听端口</span><input
      v-model.number="form.stompListenPort"
      name="stomp-listen-port"
      type="number"
      min="1"
      max="65535"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.listenPort)"
    ><small
      v-if="fieldErrors.listenPort"
      class="field-error"
      role="alert"
    >{{ fieldErrors.listenPort }}</small></label>
    <label class="field-control endpoint-dialog__wide"><span>WebSocket 路径</span><input
      v-model="form.stompPath"
      name="stomp-path"
      :disabled="connectionLocked"
      :aria-invalid="Boolean(fieldErrors.path)"
    ><small
      v-if="fieldErrors.path"
      class="field-error"
      role="alert"
    >{{ fieldErrors.path }}</small></label>
  </template>
  <p class="field-note endpoint-dialog__wide">
    {{ connectionLocked ? '连接中可修改名称；修改连接参数前请先断开。' : form.transport === 'opcua-server' ? '运行中请先停止再修改监听参数与节点结构。' : '安全、认证及订阅设置可在保存后的端点工作台中编辑。' }}
  </p>
</template>
