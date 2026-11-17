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
  <fieldset class="endpoint-parameter-section endpoint-dialog__wide">
    <legend>TCP 连接与接收</legend>
    <div class="endpoint-dialog__option-row">
      <label class="endpoint-parameter-section__toggle">
        <input
          v-model="form.keepAlive"
          name="tcp-keep-alive"
          type="checkbox"
        >
        <span>TCP Keepalive</span>
      </label>
      <label
        v-if="form.transport === 'tcp-client'"
        class="endpoint-parameter-section__toggle"
      >
        <input
          v-model="form.autoReconnect"
          name="tcp-auto-reconnect"
          type="checkbox"
        >
        <span>自动重连</span>
      </label>
    </div>
    <label class="field-control">
      <span>首次探测延迟（秒）</span>
      <input
        v-model.number="form.keepAliveInitialDelaySeconds"
        name="tcp-keep-alive-delay"
        type="number"
        min="1"
        max="3600"
        step="1"
        :disabled="!form.keepAlive"
        :aria-invalid="Boolean(fieldErrors.keepAliveInitialDelaySeconds)"
      >
      <small
        v-if="fieldErrors.keepAliveInitialDelaySeconds"
        class="field-error"
        role="alert"
      >{{ fieldErrors.keepAliveInitialDelaySeconds }}</small>
    </label>
    <label
      class="field-control"
      :class="{ 'endpoint-dialog__wide': form.receiveFramingMode === 'raw' }"
    >
      <span>接收分帧</span>
      <select
        v-model="form.receiveFramingMode"
        name="tcp-receive-framing"
        :aria-invalid="Boolean(fieldErrors.receiveFraming)"
      >
        <option value="raw">原始数据</option>
        <option value="delimiter">分隔符</option>
        <option value="fixed">固定长度</option>
        <option value="idle">空闲超时</option>
      </select>
      <small
        v-if="fieldErrors.receiveFraming"
        class="field-error"
        role="alert"
      >{{ fieldErrors.receiveFraming }}</small>
    </label>
    <label
      v-if="form.receiveFramingMode === 'delimiter'"
      class="field-control"
    >
      <span>HEX 分隔符</span>
      <input
        v-model="form.receiveDelimiterHex"
        name="tcp-receive-delimiter"
        placeholder="0D 0A"
        :aria-invalid="Boolean(fieldErrors.delimiterBytes)"
      >
      <small
        v-if="fieldErrors.delimiterBytes"
        class="field-error"
        role="alert"
      >{{ fieldErrors.delimiterBytes }}</small>
    </label>
    <label
      v-else-if="form.receiveFramingMode === 'fixed'"
      class="field-control"
    >
      <span>固定长度</span>
      <input
        v-model.number="form.receiveFrameLength"
        name="tcp-receive-length"
        type="number"
        min="1"
        max="1048576"
        :aria-invalid="Boolean(fieldErrors.receiveFrameLength)"
      >
      <small
        v-if="fieldErrors.receiveFrameLength"
        class="field-error"
        role="alert"
      >{{ fieldErrors.receiveFrameLength }}</small>
    </label>
    <label
      v-else-if="form.receiveFramingMode === 'idle'"
      class="field-control"
    >
      <span>空闲毫秒</span>
      <input
        v-model.number="form.receiveIdleMs"
        name="tcp-receive-idle-ms"
        type="number"
        min="1"
        max="60000"
        :aria-invalid="Boolean(fieldErrors.receiveIdleMs)"
      >
      <small
        v-if="fieldErrors.receiveIdleMs"
        class="field-error"
        role="alert"
      >{{ fieldErrors.receiveIdleMs }}</small>
    </label>
  </fieldset>
</template>
