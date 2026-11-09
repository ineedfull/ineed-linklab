export function createFakeTimers(start = 1_720_000_000_000) {
  let nextId = 1;
  const queue = [];
  const api = {
    now: start,
    setTimeout(callback, delay) {
      const task = { id: nextId, callback, delay, cancelled: false };
      nextId += 1;
      queue.push(task);
      return task.id;
    },
    clearTimeout(id) {
      const task = queue.find((candidate) => candidate.id === id);
      if (task) task.cancelled = true;
    },
    pendingCount() {
      return queue.filter(({ cancelled }) => !cancelled).length;
    },
    nextDelay() {
      return queue.find(({ cancelled }) => !cancelled)?.delay ?? null;
    },
    nextCallback() {
      return queue.find(({ cancelled }) => !cancelled)?.callback ?? null;
    },
    async runNext() {
      const index = queue.findIndex(({ cancelled }) => !cancelled);
      if (index === -1) throw new Error('No pending timer');
      const [task] = queue.splice(index, 1);
      api.now += task.delay;
      await task.callback();
      await Promise.resolve();
    },
  };
  return api;
}
