import { once } from './workbenchSubscriptions.js';

// Owns reentrant delivery and listener isolation; the model owns final disposal.
export function createStateNotifier(state, beforeNotify = () => {}) {
  const listeners = new Set();
  let dispatching = false;
  let pending = false;
  let finished = false;

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (finished) return () => {};
    listeners.add(listener);
    return once(() => listeners.delete(listener));
  }

  function notify() {
    if (finished) return;
    beforeNotify();
    pending = true;
    if (dispatching) return;
    dispatching = true;
    try {
      while (pending && !finished) {
        pending = false;
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          try {
            listener(state);
          } catch {
            // A listener cannot block model delivery to other subscribers.
          }
        }
      }
    } finally {
      dispatching = false;
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    pending = false;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Dispose still completes when a listener fails.
      }
    }
    listeners.clear();
  }

  return { finish, notify, subscribe };
}
