<script setup>
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
  <template v-if="form.transport === 'tcp-client'">
    <label class="field-control">
      <span>服务器地址</span>
      <input
        v-model="form.host"
        required
        placeholder="127.0.0.1"
        :aria-invalid="Boolean(fieldErrors.host)"
      >
      <small
        v-if="fieldErrors.host"
        class="field-error"
        role="alert"
      >{{ fieldErrors.host }}</small>
    </label>
    <label class="field-control">
      <span>服务器端口</span>
      <input
        v-model.number="form.port"
        type="number"
        min="1"
        max="65535"
        required
        :aria-invalid="Boolean(fieldErrors.port)"
      >
      <small
        v-if="fieldErrors.port"
        class="field-error"
        role="alert"
      >{{ fieldErrors.port }}</small>
    </label>
  </template>
  <template v-else-if="form.transport === 'tcp-server'">
    <label class="field-control">
      <span>监听地址</span>
      <input
        v-model="form.listenHost"
        required
        placeholder="0.0.0.0"
        :aria-invalid="Boolean(fieldErrors.listenHost)"
      >
      <small
        v-if="fieldErrors.listenHost"
        class="field-error"
        role="alert"
      >{{ fieldErrors.listenHost }}</small>
    </label>
    <label class="field-control">
      <span>监听端口</span>
      <input
        v-model.number="form.listenPort"
        type="number"
        min="1"
        max="65535"
        required
        :aria-invalid="Boolean(fieldErrors.listenPort)"
      >
      <small
        v-if="fieldErrors.listenPort"
        class="field-error"
        role="alert"
      >{{ fieldErrors.listenPort }}</small>
    </label>
  </template>
  <template v-else-if="form.transport.startsWith('modbus-tcp-')">
    <label class="field-control">
      <span>{{ form.transport.endsWith('-master') ? '从站地址' : '监听地址' }}</span>
      <input
        v-if="form.transport.endsWith('-master')"
        v-model="form.modbusHost"
        name="modbus-host"
        placeholder="127.0.0.1"
        :aria-invalid="Boolean(fieldErrors.host)"
      >
      <input
        v-else
        v-model="form.modbusListenHost"
        name="modbus-listen-host"
        placeholder="0.0.0.0"
        :aria-invalid="Boolean(fieldErrors.listenHost)"
      >
      <small
        v-if="fieldErrors.host || fieldErrors.listenHost"
        class="field-error"
        role="alert"
      >
        {{ fieldErrors.host || fieldErrors.listenHost }}
      </small>
    </label>
    <label class="field-control">
      <span>{{ form.transport.endsWith('-master') ? '从站端口' : '监听端口' }}</span>
      <input
        v-if="form.transport.endsWith('-master')"
        v-model.number="form.modbusPort"
        name="modbus-port"
        type="number"
        min="1"
        max="65535"
        :aria-invalid="Boolean(fieldErrors.port)"
      >
      <input
        v-else
        v-model.number="form.modbusListenPort"
        name="modbus-listen-port"
        type="number"
        min="1"
        max="65535"
        :aria-invalid="Boolean(fieldErrors.listenPort)"
      >
      <small
        v-if="fieldErrors.port || fieldErrors.listenPort"
        class="field-error"
        role="alert"
      >
        {{ fieldErrors.port || fieldErrors.listenPort }}
      </small>
    </label>
  </template>
  <template v-else-if="form.transport.startsWith('udp-')">
    <label class="field-control">
      <span>本地绑定地址</span>
      <input
        v-model="form.bindHost"
        required
        placeholder="0.0.0.0"
        :aria-invalid="Boolean(fieldErrors.bindHost)"
      >
      <small
        v-if="fieldErrors.bindHost"
        class="field-error"
        role="alert"
      >{{ fieldErrors.bindHost }}</small>
    </label>
    <label class="field-control">
      <span>本地绑定端口</span>
      <input
        v-model.number="form.bindPort"
        type="number"
        min="1"
        max="65535"
        required
        :aria-invalid="Boolean(fieldErrors.bindPort)"
      >
      <small
        v-if="fieldErrors.bindPort"
        class="field-error"
        role="alert"
      >{{ fieldErrors.bindPort }}</small>
    </label>
    <label class="field-control">
      <span>默认目标地址{{ form.transport === 'udp-server' ? '（可选，主动发送时使用）' : '' }}</span>
      <input
        v-model="form.targetHost"
        :required="form.transport === 'udp-client'"
        placeholder="127.0.0.1"
        :aria-invalid="Boolean(fieldErrors.targetHost)"
      >
      <small
        v-if="fieldErrors.targetHost"
        class="field-error"
        role="alert"
      >{{ fieldErrors.targetHost }}</small>
    </label>
    <label class="field-control">
      <span>默认目标端口{{ form.transport === 'udp-server' ? '（可选）' : '' }}</span>
      <input
        v-model.number="form.targetPort"
        type="number"
        min="1"
        max="65535"
        :required="form.transport === 'udp-client'"
        :disabled="form.transport === 'udp-server' && !form.targetHost.trim()"
        :aria-invalid="Boolean(fieldErrors.targetPort)"
      >
      <small
        v-if="fieldErrors.targetPort"
        class="field-error"
        role="alert"
      >{{ fieldErrors.targetPort }}</small>
    </label>
    <p class="field-note endpoint-dialog__wide">
      每个 UDP 数据报独立显示为一帧。
    </p>
  </template>
</template>
