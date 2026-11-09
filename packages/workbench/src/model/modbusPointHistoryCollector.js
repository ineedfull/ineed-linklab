const RETRY_DELAYS_MS = Object.freeze([100, 500]);

export function createModbusPointHistoryCollector({
  recordBatch,
  clock = Date.now,
  timers = globalThis,
  batchSize = 200,
  flushDelayMs = 1_000,
  maxPendingRows = 2_000,
} = {}) {
  if (typeof recordBatch !== 'function') throw new TypeError('recordBatch must be a function');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('timers must provide setTimeout and clearTimeout');
  }
  requirePositiveInteger(batchSize, 'batchSize');
  requirePositiveInteger(maxPendingRows, 'maxPendingRows');
  if (!Number.isSafeInteger(flushDelayMs) || flushDelayMs < 0) {
    throw new TypeError('flushDelayMs must be a non-negative integer');
  }

  const pendingRows = [];
  const signatures = new Map();
  const sessions = new Map();
  const listeners = new Set();
  let writeTail = Promise.resolve();
  let drainPromise = null;
  let timerId = null;
  let activeBatchCount = 0;
  let accepting = true;
  let disposePromise = null;
  let droppedCount = 0;
  let failedBatchCount = 0;
  let lastFlushedAt = null;
  let lastError = null;

  function capture(batch) {
    if (!accepting) return 0;
    const source = snapshotBatch(batch);
    resetForSessionChange(source.endpointId, source.sessionId);
    let accepted = 0;
    for (const point of source.points) {
      if (point.enabled === false || point.saveHistory !== true) continue;
      const key = pointIdentity(source, point);
      const nextSignature = changeSignature(point);
      if (point.historyMode !== 'every-poll' && signatures.get(key) === nextSignature) continue;
      signatures.set(key, nextSignature);
      pendingRows.push(toHistoryRow(source, point));
      accepted += 1;
    }
    trimPendingRows();
    if (accepted > 0) {
      notify();
      if (pendingRows.length >= batchSize) triggerDrain();
      else armFlushTimer();
    }
    return accepted;
  }

  async function flush() {
    cancelFlushTimer();
    while (pendingRows.length > 0 || drainPromise || activeBatchCount > 0) {
      if (!drainPromise && pendingRows.length > 0) triggerDrain();
      if (drainPromise) await drainPromise;
      else await writeTail;
    }
    await writeTail;
    return getStatus();
  }

  function reset(endpointId) {
    if (endpointId === undefined) {
      signatures.clear();
      sessions.clear();
      return;
    }
    for (const key of signatures.keys()) {
      if (JSON.parse(key)[0] === endpointId) signatures.delete(key);
    }
    sessions.delete(endpointId);
  }

  function getStatus() {
    return {
      pendingCount: pendingRows.length + activeBatchCount,
      droppedCount,
      failedBatchCount,
      lastFlushedAt,
      lastError,
    };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (!accepting) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    accepting = false;
    disposePromise = flush().finally(() => {
      cancelFlushTimer();
      signatures.clear();
      sessions.clear();
      listeners.clear();
    });
    return disposePromise;
  }

  function resetForSessionChange(endpointId, sessionId) {
    const previous = sessions.get(endpointId);
    if (previous !== undefined && previous !== sessionId) reset(endpointId);
    sessions.set(endpointId, sessionId);
  }

  function trimPendingRows() {
    const overflow = pendingRows.length + activeBatchCount - maxPendingRows;
    if (overflow <= 0) return;
    pendingRows.splice(0, overflow);
    droppedCount += overflow;
  }

  function armFlushTimer() {
    if (timerId !== null || drainPromise || pendingRows.length === 0) return;
    timerId = timers.setTimeout(() => {
      timerId = null;
      triggerDrain();
    }, flushDelayMs);
  }

  function cancelFlushTimer() {
    if (timerId === null) return;
    timers.clearTimeout(timerId);
    timerId = null;
  }

  function triggerDrain() {
    if (drainPromise || pendingRows.length === 0) return drainPromise;
    cancelFlushTimer();
    drainPromise = drainPending().finally(() => {
      drainPromise = null;
      if (pendingRows.length >= batchSize) triggerDrain();
      else armFlushTimer();
    });
    return drainPromise;
  }

  async function drainPending() {
    while (pendingRows.length > 0) {
      const rows = pendingRows.splice(0, batchSize);
      activeBatchCount = rows.length;
      notify();
      const write = writeTail.then(() => writeWithRetry(rows));
      writeTail = write.catch(() => {});
      await write;
      activeBatchCount = 0;
      notify();
    }
  }

  async function writeWithRetry(rows) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await recordBatch(structuredClone(rows));
        lastFlushedAt = clock();
        lastError = null;
        return;
      } catch (error) {
        lastError = normalizeError(error);
        notify();
        if (attempt === RETRY_DELAYS_MS.length) {
          failedBatchCount += 1;
          return;
        }
        await delay(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => timers.setTimeout(resolve, milliseconds));
  }

  function notify() {
    const status = getStatus();
    for (const listener of [...listeners]) {
      try {
        listener(structuredClone(status));
      } catch {
        // Status observers do not own persistence progress.
      }
    }
  }

  return { capture, flush, reset, getStatus, subscribe, dispose };
}

function snapshotBatch(batch) {
  if (!batch || typeof batch !== 'object' || !Array.isArray(batch.points)) {
    throw new TypeError('point outcome batch is required');
  }
  return structuredClone(batch);
}

function pointIdentity(batch, point) {
  return JSON.stringify([batch.endpointId, batch.requestGroupId, batch.requestId, point.id]);
}

function changeSignature(point) {
  return canonicalJson([point.value, point.quality, point.reason ?? null]);
}

function toHistoryRow(batch, point) {
  return {
    endpointId: batch.endpointId,
    requestGroupId: batch.requestGroupId,
    requestId: batch.requestId,
    pointId: point.id,
    pointKey: point.key,
    pointName: point.name,
    dataType: point.dataType,
    unit: point.unit || null,
    raw: structuredClone(point.raw),
    value: structuredClone(point.value),
    numericValue: numericProjection(point.value),
    displayValue: point.display,
    quality: point.quality,
    reason: point.reason ?? null,
    createdAt: batch.createdAt,
  };
}

function numericProjection(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError('point value must contain lossless JSON data');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('point value must contain lossless JSON data');
}

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}
