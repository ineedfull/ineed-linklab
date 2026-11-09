const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function createModalFocusTrap({ container, requestClose, isBusy = () => false }) {
  let priorFocus = null;

  function capture() {
    priorFocus = document.activeElement;
  }

  function activate(selector) {
    const root = container();
    (selector ? root?.querySelector(selector) : null)?.focus();
    if (!root?.contains(document.activeElement)) controls()[0]?.focus();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      if (isBusy()) return;
      event.preventDefault();
      requestClose();
      return;
    }
    trapModalTab(container(), event);
  }

  function controls() {
    return modalControls(container());
  }

  function restore() {
    if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus();
    priorFocus = null;
  }

  return { activate, capture, handleKeydown, restore };
}

function modalControls(root) {
  return [...(root?.querySelectorAll(FOCUSABLE) ?? [])].filter(item => {
    if (item.matches(':disabled') || item.tabIndex < 0 || item.closest('[hidden], [inert]')) return false;
    for (let node = item; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
}

export function trapModalTab(root, event) {
  if (event.key !== 'Tab' || !root) return;
  event.preventDefault();
  const items = modalControls(root);
  if (!items.length) {
    root.setAttribute('tabindex', '-1');
    root.focus();
    return;
  }
  // WebKit can skip native buttons; move through every available control explicitly.
  const index = items.indexOf(document.activeElement);
  const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0)
    : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
  items[next].focus();
}
