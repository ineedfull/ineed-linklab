import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

// Pausing the viewport never stops reception, persistence, or protocol activity.
export function useStreamFollow({ element, keys, enabled, context = () => '' }) {
  const following = ref(enabled());
  const unread = ref(0);
  let lastTop = 0;
  let disposed = false;
  async function scrollToLatest() {
    await nextTick();
    if (disposed || !following.value || !element.value) return;
    element.value.scrollTop = element.value.scrollHeight;
    lastTop = element.value.scrollTop;
  }
  function resume() { following.value = true; unread.value = 0; void scrollToLatest(); }
  function pause() { following.value = false; }
  function toggle() { if (following.value) pause(); else resume(); }
  function onScroll() {
    const target = element.value;
    if (!target) return;
    if (target.scrollTop < lastTop - 1 && target.scrollHeight - target.clientHeight - target.scrollTop > 8) pause();
    lastTop = target.scrollTop;
  }
  function onWheel(event) { if (event.deltaY < 0) pause(); }
  function onKeydown(event) { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause(); }
  watch([keys, enabled, context], ([current, isEnabled, activeContext], previousState = []) => {
    const [previous = [], previousEnabled, previousContext] = previousState;
    if (previousEnabled === undefined || isEnabled !== previousEnabled || activeContext !== previousContext) {
      unread.value = 0;
      following.value = isEnabled;
      void scrollToLatest();
      return;
    }
    if (following.value) { void scrollToLatest(); return; }
    if (!current.length) { unread.value = 0; return; }
    const known = new Set(previous);
    unread.value += current.filter(key => !known.has(key)).length;
  }, { immediate: true });
  onBeforeUnmount(() => { disposed = true; });
  return { following, unread, resume, pause, toggle, onScroll, onWheel, onKeydown };
}
