export function createBatchedPersistence({
  flushMs = 1000,
  maxBatchSize = 200,
  maxQueueSize = 2000,
  maxRetries = 2,
  persistBatch,
  onError,
  onDrop,
  retryDelay = defaultRetryDelay,
  schedule = (callback, delay) => setTimeout(callback, delay),
  clear = (timer) => clearTimeout(timer),
} = {}) {
  validatePositiveInteger(flushMs, 'flushMs');
  validatePositiveInteger(maxBatchSize, 'maxBatchSize');
  validatePositiveInteger(maxQueueSize, 'maxQueueSize');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('maxRetries must be a nonnegative integer');
  }
  validateFunction(persistBatch, 'persistBatch');
  validateOptionalFunction(onError, 'onError');
  validateOptionalFunction(onDrop, 'onDrop');
  validateFunction(retryDelay, 'retryDelay');
  validateFunction(schedule, 'schedule');
  validateFunction(clear, 'clear');

  const queue = [];
  let timer = null;
  let draining = null;
  let disposed = false;
  let disposal = null;
  let failure = null;

  function rememberFailure(error, count) {
    const message = String(error?.message ?? error).slice(0, 256);
    failure = {
      rowCount: Math.min(Number.MAX_SAFE_INTEGER, (failure?.rowCount ?? 0) + count),
      firstMessage: failure?.firstMessage ?? message,
      latestMessage: message,
    };
  }

  function clearTimer() {
    if (timer === null) return;
    const current = timer;
    timer = null;
    clear(current);
  }

  function reportError(error, rows) {
    rememberFailure(error, rows.length);
    try {
      onError?.(error, rows);
    } catch {
      // Persistence must not become recursive because an observer failed.
    }
  }

  async function persistWithRetry(rows) {
    let retry = 0;
    while (true) {
      try {
        await persistBatch(rows);
        return;
      } catch (error) {
        if (retry >= maxRetries) {
          reportError(error, rows);
          return;
        }
        retry += 1;
        try {
          await retryDelay(retry);
        } catch (delayError) {
          reportError(delayError, rows);
          return;
        }
      }
    }
  }

  async function drain(completion, resolveCompletion, rejectCompletion) {
    try {
      while (queue.length > 0) {
        const rows = queue.splice(0, maxBatchSize);
        await persistWithRetry(rows);
      }
      if (draining === completion) draining = null;
      resolveCompletion();
    } catch (error) {
      if (draining === completion) draining = null;
      rejectCompletion(error);
    }
  }

  function drainPending() {
    clearTimer();
    if (draining !== null) return draining;
    if (queue.length === 0) return Promise.resolve();

    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    draining = completion;
    void drain(completion, resolveCompletion, rejectCompletion);
    return completion;
  }

  async function flush() {
    await drainPending();
    if (failure === null) return;
    const summary = failure;
    failure = null;
    const error = new Error(`History incomplete: ${summary.rowCount} rows lost; ${summary.latestMessage}`);
    error.code = 'HISTORY_INCOMPLETE';
    error.summary = summary;
    throw error;
  }

  function ensureTimer() {
    if (timer !== null || draining !== null) return;
    timer = schedule(() => {
      timer = null;
      return drainPending().catch(() => {});
    }, flushMs);
  }

  return {
    enqueue(row) {
      if (disposed) throw new Error('Batched persistence is disposed');
      queue.push(row);
      if (queue.length > maxQueueSize) {
        const dropped = queue.splice(0, queue.length - maxQueueSize);
        rememberFailure(new Error('Persistence queue overflow'), dropped.length);
        try {
          onDrop?.(dropped);
        } catch {
          // Dropped rows stay dropped even when an observer fails.
        }
      }

      if (queue.length >= maxBatchSize) {
        void drainPending().catch(() => {});
      } else {
        ensureTimer();
      }
    },
    dispose() {
      if (disposal !== null) return disposal;
      disposed = true;
      clearTimer();
      disposal = flush();
      return disposal;
    },
    flush,
    size() {
      return queue.length;
    },
  };
}

function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function validateFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function validateOptionalFunction(value, name) {
  if (value !== undefined) validateFunction(value, name);
}

function defaultRetryDelay(attempt) {
  const delay = Math.min(1000, 250 * (2 ** (attempt - 1)));
  return new Promise((resolve) => setTimeout(resolve, delay));
}
