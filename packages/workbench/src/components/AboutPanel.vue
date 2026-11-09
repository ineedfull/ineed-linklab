<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import appIcon from '../assets/ineed-linklab.svg';

import { APP_VERSION, PRODUCT_NAME, PRODUCT_WEBSITE } from '../product.js';
import { createModalFocusTrap } from '../model/modalFocus.js';

const props = defineProps({
  open: Boolean,
  openWebsite: { type: Function, default: undefined },
  runtimeName: { type: String, required: true },
});
const emit = defineEmits(['close']);
const websiteError = ref('');
async function visitWebsite(event) {
  if (!props.openWebsite) return;
  event.preventDefault();
  websiteError.value = '';
  try { await props.openWebsite(); }
  catch { websiteError.value = '无法打开浏览器，请复制官网地址后访问。'; }
}
const closeButton = ref(null);
const panelRef = ref(null);
const focusTrap = createModalFocusTrap({
  container: () => panelRef.value,
  requestClose,
});

watch(() => props.open, async (open, previous) => {
  if (open) {
    websiteError.value = '';
    focusTrap.capture();
    await nextTick();
    focusTrap.activate('[aria-label="关闭关于"]');
  } else if (previous) {
    focusTrap.restore();
  }
});

function requestClose() {
  emit('close');
}

onBeforeUnmount(focusTrap.restore);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop about-overlay"
      @mousedown.self="requestClose"
    >
      <section
        ref="panelRef"
        class="about-panel desktop-about"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        @keydown="focusTrap.handleKeydown"
      >
        <header>
          <h2 id="about-title">
            关于
          </h2>
          <button
            ref="closeButton"
            type="button"
            tabindex="0"
            class="about-panel__close"
            aria-label="关闭关于"
            title="关闭"
            @click="requestClose"
          >
            <X :size="18" />
          </button>
        </header>
        <div
          class="about-panel__body"
          tabindex="0"
          role="region"
          aria-label="产品信息"
        >
          <div class="about-panel__identity">
            <img
              class="about-panel__icon"
              :src="appIcon"
              alt=""
              width="64"
              height="64"
            >
            <div class="about-panel__product">
              <strong>{{ PRODUCT_NAME }}</strong>
              <span>多协议通信调试助手</span>
            </div>
          </div>
          <dl class="about-panel__details">
            <div>
              <dt>版本</dt>
              <dd>{{ APP_VERSION }}</dd>
            </div>
            <div>
              <dt>运行环境</dt>
              <dd class="about-panel__runtime">
                {{ runtimeName }}
              </dd>
            </div>
            <div>
              <dt>支持协议</dt>
              <dd>串口 · TCP / UDP · WebSocket · Modbus · DL/T645 · OPC UA · STOMP</dd>
            </div>
            <div>
              <dt>本地存储</dt>
              <dd>SQLite</dd>
            </div>
            <div>
              <dt>官方网站</dt>
              <dd>
                <a
                  tabindex="0"
                  class="about-panel__website"
                  :href="PRODUCT_WEBSITE"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click="visitWebsite"
                >linklab.ineedfull.com</a>
              </dd>
            </div>
          </dl>
          <p
            v-if="websiteError"
            class="about-panel__website-error"
            role="alert"
          >
            {{ websiteError }}
          </p>
          <p class="about-panel__note">
            连接、收发、协议解析与设备模拟。<br>让日常通信调试更顺手。
          </p>
          <small>版权所有 © 2026 Ineed</small>
        </div>
        <footer>
          <button
            type="button"
            tabindex="0"
            class="about-panel__button"
            @click="requestClose"
          >
            关闭
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
