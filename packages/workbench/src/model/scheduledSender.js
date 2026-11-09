export const MIN_SCHEDULED_SEND_INTERVAL_MS = 100;
export const MAX_SCHEDULED_SEND_INTERVAL_MS = 60_000;

const terminalStatuses = new Set(['close', 'closed', 'closing', 'error']);

export function createScheduledSender({ send, clock = globalThis, reporter = () => {} } = {}) {
  if (typeof send !== 'function') throw new TypeError('send must be a function');
  if (typeof clock?.setTimeout !== 'function' || typeof clock?.clearTimeout !== 'function') {
    throw new TypeError('clock must provide setTimeout and clearTimeout');
  }
  if (typeof reporter !== 'function') throw new TypeError('reporter must be a function');

  const jobs = new Map();
  const statuses = new Map();
  const listeners = new Set();
  let generation = 0;
  let disposed = false;

  function start(options) {
    if (disposed) throw new Error('scheduled sender is disposed');
    const normalized = normalizeJob(options);
    const previous = jobs.get(normalized.endpointId);
    if (previous) finish(previous, 'replaced');

    const job = {
      ...normalized,
      generation: ++generation,
      sentCount: 0,
      timerId: null,
    };
    jobs.set(job.endpointId, job);
    publish(job.endpointId, activeStatus(job));
    void execute(job);
    return getStatus(job.endpointId);
  }

  function stop(endpointId, sessionId) {
    const job = jobs.get(endpointId);
    if (!job || job.sessionId !== sessionId) return false;
    finish(job, 'stopped');
    return true;
  }

  async function execute(job) {
    let result;
    try {
      result = await send(cloneData(job.request));
    } catch (error) {
      if (isCurrent(job)) finish(job, 'error', normalizeError(error));
      return;
    }
    if (!isCurrent(job)) return;
    if (result?.ok === false) {
      finish(job, 'error', normalizeError(result.error ?? new Error('发送失败')));
      return;
    }

    job.sentCount += 1;
    publish(job.endpointId, activeStatus(job));
    if (job.count !== null && job.sentCount >= job.count) {
      finish(job, 'completed');
      return;
    }
    job.timerId = clock.setTimeout(() => {
      job.timerId = null;
      if (isCurrent(job)) void execute(job);
    }, job.intervalMs);
  }

  function finish(job, reason, error = null) {
    if (!isCurrent(job)) return false;
    if (job.timerId !== null) {
      clock.clearTimeout(job.timerId);
      job.timerId = null;
    }
    jobs.delete(job.endpointId);
    publish(job.endpointId, Object.freeze({
      active: false,
      endpointId: job.endpointId,
      sessionId: job.sessionId,
      sentCount: job.sentCount,
      reason,
      error,
    }));
    return true;
  }

  function reconcile({
    endpoints,
    operations,
    statuses: endpointStatuses,
    reset = false,
    disposed: workspaceDisposed = false,
  } = {}) {
    if (reset || workspaceDisposed) {
      stopAll(reset ? 'reset' : 'disposed');
      return;
    }
    const endpointIds = Array.isArray(endpoints)
      ? new Set(endpoints.map(({ id }) => id))
      : null;
    for (const job of [...jobs.values()]) {
      if (endpointIds && !endpointIds.has(job.endpointId)) {
        finish(job, 'deleted');
        continue;
      }
      const operation = operations?.get(job.endpointId);
      if (!operation || operation.sessionId !== job.sessionId) {
        finish(job, 'session-replaced');
        continue;
      }
      const status = endpointStatuses?.get(job.endpointId);
      if (status && terminalStatuses.has(status.status)) finish(job, status.status);
    }
  }

  function getStatus(endpointId) {
    return statuses.get(endpointId) ?? Object.freeze({
      active: false,
      endpointId,
      sessionId: null,
      sentCount: 0,
      reason: 'idle',
      error: null,
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function publish(endpointId, status) {
    statuses.set(endpointId, status);
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        const result = listener(endpointId, status);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch((error) => reportListenerError(error, endpointId, status));
        }
      } catch (error) {
        reportListenerError(error, endpointId, status);
      }
    }
  }

  function reportListenerError(error, endpointId, status) {
    try {
      const result = reporter(normalizeError(error), Object.freeze({
        source: 'scheduledSender.listener',
        endpointId,
        status,
      }));
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
    } catch {
      // Observer diagnostics must not become part of the send state machine.
    }
  }

  function stopAll(reason) {
    for (const job of [...jobs.values()]) finish(job, reason);
  }

  function dispose() {
    if (disposed) return;
    stopAll('disposed');
    disposed = true;
    listeners.clear();
  }

  function isCurrent(job) {
    return jobs.get(job.endpointId) === job && job.generation <= generation;
  }

  return { start, stop, getStatus, subscribe, reconcile, dispose };
}

function normalizeJob(options) {
  if (!isPlainObject(options)) throw new TypeError('scheduled send options must be an object');
  requireNonblank(options.endpointId, 'endpointId');
  requireNonblank(options.sessionId, 'sessionId');
  if (
    !Number.isInteger(options.intervalMs)
    || options.intervalMs < MIN_SCHEDULED_SEND_INTERVAL_MS
    || options.intervalMs > MAX_SCHEDULED_SEND_INTERVAL_MS
  ) {
    throw new RangeError(
      `intervalMs must be an integer from ${MIN_SCHEDULED_SEND_INTERVAL_MS} to ${MAX_SCHEDULED_SEND_INTERVAL_MS}`,
    );
  }
  if (options.count !== null && (!Number.isInteger(options.count) || options.count < 1)) {
    throw new RangeError('count must be null or a positive integer');
  }
  if (!isPlainObject(options.request)) throw new TypeError('request must be an object');
  if (options.request.endpointId !== options.endpointId) {
    throw new TypeError('request.endpointId must match endpointId');
  }
  if (!(options.request.bytes instanceof Uint8Array)) {
    throw new TypeError('request.bytes must be Uint8Array');
  }
  return {
    endpointId: options.endpointId,
    sessionId: options.sessionId,
    intervalMs: options.intervalMs,
    count: options.count,
    request: cloneData(options.request),
  };
}

function activeStatus(job) {
  return Object.freeze({
    active: true,
    endpointId: job.endpointId,
    sessionId: job.sessionId,
    sentCount: job.sentCount,
    reason: 'running',
    error: null,
  });
}

function cloneData(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== 'object') throw new TypeError('request contains unsupported data');
  if (ancestors.has(value)) throw new TypeError('request must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => cloneData(item, ancestors)));
    }
    if (!isPlainObject(value)) throw new TypeError('request contains unsupported data');
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneData(item, ancestors)]),
    ));
  } finally {
    ancestors.delete(value);
  }
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function requireNonblank(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a nonblank string`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPromiseLike(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}
