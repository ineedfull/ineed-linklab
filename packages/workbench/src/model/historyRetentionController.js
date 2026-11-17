const RETENTION_INTERVAL_MS = 86_400_000;

/** Owns the cleanup generation and timer. Cancel invalidates late results.
 * The model supplies current preferences and keeps the persisted schema unchanged.
 */
export function createHistoryRetentionController({
  cleanup,
  getRetention,
  isDisposed,
  notify,
  clock,
  timers,
}) {
  let retentionTimerId = null;
  let retentionGeneration = 0;
  let retentionCleanupRunning = false;
  let retentionLastCleanupAt = null;
  let retentionCleanupError = null;
  const retentionTimers = timers ?? globalThis;

  function cancelRetentionCleanup() {
    retentionGeneration += 1;
    retentionCleanupRunning = false;
    if (retentionTimerId !== null) {
      retentionTimers.clearTimeout(retentionTimerId);
      retentionTimerId = null;
    }
  }

  async function applyRetentionPolicy(retention) {
    try {
      return await runRetentionCleanup(retention);
    } catch {
      return null;
    }
  }

  function runRetentionCleanup(retention) {
    cancelRetentionCleanup();
    const currentGeneration = retentionGeneration;
    if (retention === 'forever') {
      retentionCleanupError = null;
      notify();
      return Promise.resolve({ deletedCount: 0, completedAt: null, skipped: true });
    }
    retentionCleanupRunning = true;
    retentionCleanupError = null;
    notify();
    return Promise.resolve(cleanup(retention))
      .then((result) => {
        if (!isDisposed() && currentGeneration === retentionGeneration) {
          retentionLastCleanupAt = Number.isSafeInteger(result?.completedAt)
            ? result.completedAt
            : (typeof clock === 'function' ? clock() : Date.now());
          retentionCleanupError = null;
        }
        return result;
      })
      .catch((error) => {
        if (!isDisposed() && currentGeneration === retentionGeneration) {
          retentionCleanupError = error instanceof Error ? error.message : String(error);
        }
        throw error;
      })
      .finally(() => {
        if (isDisposed() || currentGeneration !== retentionGeneration) return;
        retentionCleanupRunning = false;
        retentionTimerId = retentionTimers.setTimeout(() => {
          retentionTimerId = null;
          void applyRetentionPolicy(getRetention());
        }, RETENTION_INTERVAL_MS);
        retentionTimerId?.unref?.();
        notify();
      });
  }
  return {
    cancel: cancelRetentionCleanup,
    apply: applyRetentionPolicy,
    run: runRetentionCleanup,
    getStatus: () => ({
      cleanupRunning: retentionCleanupRunning,
      lastCleanupAt: retentionLastCleanupAt,
      cleanupError: retentionCleanupError,
    }),
  };
}
