import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

// Retention and persistence stay with the workbench. Only the rows near the
// viewport own DOM; spacers preserve scrolling through all retained messages.
export function useFrameViewport({ rows, element, following, context, refreshFollow }) {
  const heights = new Map(), elements = new Map();
  const revision = ref(0), top = ref(0), height = ref(0);
  let observer, scheduled = null, disposed = false, width = 0;
  let estimate = 40;
  const layoutFor = items => {
    const offsets = [0];
    for (const row of items) offsets.push(offsets.at(-1) + (heights.get(row.key) ?? estimate));
    return { items, offsets, total: offsets.at(-1) };
  };
  const layout = computed(() => { revision.value; return layoutFor(rows.value); });
  const virtualized = computed(() => rows.value.length > 40 && height.value > 0);
  const viewport = computed(() => {
    const { items, offsets, total } = layout.value;
    // Before a container has a measurable layout, retain normal list behavior.
    if (!virtualized.value) return { items, before: 0, after: 0 };
    const position = following.value ? Math.max(0, total - height.value) : Math.min(top.value, Math.max(0, total - height.value));
    let start = 0;
    while (start < items.length && offsets[start + 1] <= Math.max(0, position - 160)) start++;
    let end = start;
    while (end < items.length && offsets[end] < position + height.value + 160) end++;
    return { items: items.slice(start, end), before: offsets[start], after: total - offsets[end] };
  });
  function onScroll() { top.value = element.value?.scrollTop ?? 0; }
  function readingAnchor(itemsLayout) {
    if (following.value) return null;
    const index = itemsLayout.items.findIndex((_, index) => itemsLayout.offsets[index + 1] > top.value);
    return index < 0 ? null : {
      key: itemsLayout.items[index].key, inset: top.value - itemsLayout.offsets[index], context: context(),
    };
  }
  function restoreAnchor(anchor) {
    if (!anchor) return;
    void nextTick(() => {
      if (disposed || following.value || !element.value || context() !== anchor.context) return;
      const index = layout.value.items.findIndex(row => row.key === anchor.key);
      element.value.scrollTop = index < 0 ? 0 : layout.value.offsets[index] + anchor.inset;
      onScroll();
    });
  }
  function measure() {
    if (disposed || !element.value?.clientHeight) return;
    const anchor = readingAnchor(layout.value);
    const container = element.value;
    height.value = container.clientHeight;
    if (container.clientWidth !== width) { width = container.clientWidth; heights.clear(); }
    const minimum = Number.parseFloat(getComputedStyle(container).getPropertyValue('--row-height'));
    if (Number.isFinite(minimum) && minimum > 0 && estimate !== minimum) { estimate = minimum; heights.clear(); }
    let changed = false;
    for (const { key, row } of elements.values()) {
      const measured = row.getBoundingClientRect().height;
      if (measured > 0 && Math.abs((heights.get(key) ?? 0) - measured) > 0.5) {
        heights.set(key, measured); changed = true;
      }
    }
    if (changed) { revision.value++; restoreAnchor(anchor); }
    if (following.value) refreshFollow();
  }
  function scheduleMeasure() {
    if (disposed || scheduled !== null) return;
    // ResizeObserver delivery must finish before changing spacer geometry.
    scheduled = requestAnimationFrame(() => { scheduled = null; measure(); });
  }
  function setRowElement(slot, key, component) {
    const row = component?.$el ?? component;
    const previous = elements.get(slot);
    // Vue can clear a previous ref after a recycled slot has its next message.
    if (!row && previous?.key !== key) return;
    if (previous?.row === row && previous.key === key) return;
    if (previous) observer?.unobserve(previous.row);
    if (row) { elements.set(slot, { key, row }); observer?.observe(row); }
    else elements.delete(slot);
  }
  watch(rows, (current, previous) => {
    const anchor = readingAnchor(layoutFor(previous ?? []));
    const retained = new Set(current.map(row => row.key));
    for (const key of heights.keys()) if (!retained.has(key)) heights.delete(key);
    restoreAnchor(anchor);
  });
  watch(context, () => { heights.clear(); revision.value++; top.value = 0; scheduleMeasure(); });
  onMounted(() => {
    observer = new ResizeObserver(scheduleMeasure);
    if (element.value) observer.observe(element.value);
    for (const { row } of elements.values()) observer.observe(row);
    measure();
  });
  onBeforeUnmount(() => {
    disposed = true;
    if (scheduled !== null) cancelAnimationFrame(scheduled);
    observer?.disconnect(); elements.clear(); heights.clear();
  });
  return {
    visibleRows: computed(() => viewport.value.items), virtualized,
    beforeHeight: computed(() => viewport.value.before),
    afterHeight: computed(() => viewport.value.after), setRowElement, onScroll,
  };
}
