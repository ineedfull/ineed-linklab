import { inject, onBeforeUnmount, ref, watch } from 'vue';
import { presentationStorageKey } from '../runtimeContext.js';

// Only presentation preferences live here; protocol settings stay in the runtime store.
export function useDesktopLayout(product) {
  const storage = inject(presentationStorageKey, null);
  const key = `ineed.${product}.desktop-layout.v1`;
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(key) || '{}') || {}; } catch { /* Storage may be unavailable. */ }
  const density = ref(saved.density === 'compact' ? 'compact' : 'comfortable');
  const sidebarWidth = ref(clamp(saved.sidebarWidth, 240, 240, 380));
  const sidebarOpen = ref(typeof saved.sidebarOpen === 'boolean' ? saved.sidebarOpen : !(globalThis.matchMedia?.('(max-width: 760px)').matches ?? false));
  const composerHeight = ref(clamp(saved.composerHeight, 220, 180, 500));
  const themePreference = ref(['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'system');
  watch([density, sidebarWidth, sidebarOpen, composerHeight, themePreference], () => {
    try {
      storage?.setItem(key, JSON.stringify({ density: density.value, sidebarWidth: sidebarWidth.value,
        sidebarOpen: sidebarOpen.value, composerHeight: composerHeight.value, theme: themePreference.value }));
    } catch { /* The current window remains usable without storage. */ }
  });
  function resizeSidebar(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    window.addEventListener('pointermove', moveSidebar);
    window.addEventListener('pointerup', stopResize, { once: true });
    window.addEventListener('pointercancel', stopResize, { once: true });
  }
  function moveSidebar(event) { sidebarWidth.value = clamp(event.clientX, 240, 240, 380); }
  function stopResize() {
    window.removeEventListener('pointermove', moveSidebar);
    window.removeEventListener('pointerup', stopResize);
    window.removeEventListener('pointercancel', stopResize);
  }
  function resizeSidebarWithKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    sidebarWidth.value = event.key === 'Home' ? 240 : clamp(sidebarWidth.value + (event.key === 'ArrowRight' ? 10 : -10), 240, 240, 380);
  }
  function toggleDensity() { density.value = density.value === 'compact' ? 'comfortable' : 'compact'; }
  onBeforeUnmount(stopResize);
  return { density, sidebarWidth, sidebarOpen, composerHeight, themePreference, resizeSidebar, resizeSidebarWithKeys, toggleDensity };
}

function clamp(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
