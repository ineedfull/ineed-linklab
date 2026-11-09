// Serialize read/modify/write operations sharing one native settings adapter.
// The read belongs inside the operation so queued callers see the latest profiles.
const queues = new WeakMap();

export function mutateSettings(runtime, operation) {
  // Vue may proxy the runtime object. Functions retain identity across that
  // boundary, so all views using this native adapter still share one queue.
  const adapter = runtime.settings.getAll;
  const previous = queues.get(adapter) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const settled = result.catch(() => {});
  queues.set(adapter, settled);
  void settled.then(() => { if (queues.get(adapter) === settled) queues.delete(adapter); });
  return result;
}
