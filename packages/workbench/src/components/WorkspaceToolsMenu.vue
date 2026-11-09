<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { Binary, ClipboardCheck, Copy, Wrench } from 'lucide-vue-next';

defineProps({ collapsed: Boolean });
const emit = defineEmits(['select']);
const triggerRef = ref(null);
const menuRef = ref(null);
const isOpen = ref(false);
const menuPosition = ref({});
const panelId = useId();
const MENU_WIDTH_PX = 276;
const VIEWPORT_GAP_PX = 8;

function closeMenu(restore = false) {
  isOpen.value = false;
  if (restore) triggerRef.value?.focus();
}
async function openMenu(last = false) {
  const anchor = triggerRef.value.getBoundingClientRect();
  menuPosition.value = {
    width: `${Math.min(MENU_WIDTH_PX, window.innerWidth - VIEWPORT_GAP_PX * 2)}px`,
    left: `${Math.max(VIEWPORT_GAP_PX, Math.min(anchor.left, window.innerWidth - MENU_WIDTH_PX - VIEWPORT_GAP_PX))}px`,
    bottom: `${Math.max(VIEWPORT_GAP_PX, window.innerHeight - anchor.top + VIEWPORT_GAP_PX)}px`,
    maxHeight: `${Math.max(80, anchor.top - VIEWPORT_GAP_PX * 2)}px`,
  };
  isOpen.value = true;
  await nextTick();
  if (!isOpen.value) return;
  const buttons = menuRef.value.querySelectorAll('button');
  (last ? buttons[buttons.length - 1] : buttons[0])?.focus();
}
function selectTool(tool) {
  // Dialogs capture this persistent triggerRef, rather than a disappearing item.
  closeMenu(true);
  emit('select', tool);
}
function handleMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === 'Tab') {
    event.preventDefault();
    closeMenu(true);
    // WebKit may skip native buttons; explicitly continue along the footer.
    if (!event.shiftKey) triggerRef.value.nextElementSibling?.focus();
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const buttons = [...menuRef.value.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else {
      const step = event.key === 'ArrowUp' ? -1 : 1;
      next = (index + step + buttons.length) % buttons.length;
    }
    buttons[next]?.focus();
  }
}
function dismissWhenOutside(event) {
  if (isOpen.value && !triggerRef.value?.contains(event.target) && !menuRef.value?.contains(event.target)) closeMenu();
}
function dismissOnResize() {
  if (isOpen.value) closeMenu(true);
}
onMounted(() => {
  document.addEventListener('pointerdown', dismissWhenOutside, true);
  document.addEventListener('focusin', dismissWhenOutside);
  window.addEventListener('resize', dismissOnResize);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismissWhenOutside, true);
  document.removeEventListener('focusin', dismissWhenOutside);
  window.removeEventListener('resize', dismissOnResize);
});
</script>

<template>
  <button
    ref="triggerRef"
    class="icon-button"
    type="button"
    aria-label="打开工具箱"
    :aria-expanded="isOpen"
    :aria-controls="panelId"
    title="工具箱 · 编码、模板与验收"
    @click="isOpen ? closeMenu(true) : openMenu()"
    @keydown.down.prevent="openMenu()"
    @keydown.up.prevent="openMenu(true)"
  >
    <Wrench :size="15" /><span v-if="!collapsed">工具箱</span>
  </button>
  <Teleport to="body">
    <section
      v-if="isOpen"
      :id="panelId"
      ref="menuRef"
      class="workspace-tools-menu"
      role="region"
      aria-label="工具箱菜单"
      :style="menuPosition"
      @keydown="handleMenuKeydown"
    >
      <h2>数据处理</h2>
      <button
        type="button"
        aria-label="打开编码与校验"
        @click="selectTool('converters')"
      >
        <Binary :size="18" />
        <span><strong>编码与校验</strong><small>ASCII、BCD、CRC 与字节转换</small></span>
      </button>
      <h2>工程调试</h2>
      <button
        type="button"
        aria-label="打开设备模板"
        @click="selectTool('templates')"
      >
        <Copy :size="18" />
        <span><strong>设备模板</strong><small>复用 Modbus 点表与解码配置</small></span>
      </button>
      <button
        type="button"
        aria-label="打开验收检查"
        @click="selectTool('acceptance')"
      >
        <ClipboardCheck :size="18" />
        <span><strong>验收检查</strong><small>执行 Modbus / OPC UA 检查方案</small></span>
      </button>
    </section>
  </Teleport>
</template>

<style scoped>
.workspace-tools-menu {
  position: fixed;
  z-index: 25;
  overflow: auto;
  padding: 6px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 18%);
}
.workspace-tools-menu h2 {
  margin: 0;
  padding: 8px 10px 5px;
  color: var(--text-muted);
  font-size: var(--font-size-small);
  font-weight: 600;
}
.workspace-tools-menu h2:not(:first-child) { margin-top: 5px; border-top: 1px solid var(--line-soft); }
.workspace-tools-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 54px;
  padding: 8px 10px;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 5px;
  text-align: left;
  cursor: pointer;
}
.workspace-tools-menu button:hover,
.workspace-tools-menu button:focus-visible { background: var(--accent-soft); }
.workspace-tools-menu button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.workspace-tools-menu svg { flex: none; color: var(--text-muted); }
.workspace-tools-menu span { display: grid; min-width: 0; gap: 3px; }
.workspace-tools-menu strong { font-size: var(--font-size-control); font-weight: 500; }
.workspace-tools-menu small { color: var(--text-muted); font-size: var(--font-size-small); line-height: 1.5; }
</style>
