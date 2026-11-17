// Registers listeners atomically; rollback and disposal isolate each cleanup failure.
export function subscribeTransaction(subscriptions) {
  const unsubscribes = [];
  try {
    for (const [subscribe, callback, label] of subscriptions) {
      const unsubscribe = subscribe(callback);
      if (typeof unsubscribe !== 'function') {
        throw new TypeError(`${label} must return an unsubscribe function`);
      }
      unsubscribes.push(once(unsubscribe));
    }
    return unsubscribes;
  } catch (error) {
    for (const unsubscribe of unsubscribes) safeUnsubscribe(unsubscribe);
    throw error;
  }
}

export function once(operation) {
  let called = false;
  return () => {
    if (called) return undefined;
    called = true;
    return operation();
  };
}

export function safeUnsubscribe(unsubscribe) {
  try {
    Promise.resolve(unsubscribe()).catch(() => {});
  } catch {
    // Continue cleanup when one subscription cannot be removed cleanly.
  }
}
