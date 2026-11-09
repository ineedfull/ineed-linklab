import { normalizeModbusMasterConfig } from './modbusMasterConfig.js';
import {
  communicationFailureReading,
  decodeModbusMasterPoint,
} from './modbusMasterDataPoints.js';

export function createModbusMasterScheduler({
  execute,
  onPointOutcomes = () => {},
  clock = Date.now,
  timers = globalThis,
  recordLimit = 200,
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute must be a function');
  if (typeof onPointOutcomes !== 'function') {
    throw new TypeError('onPointOutcomes must be a function');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('timers must provide setTimeout and clearTimeout');
  }
  if (!Number.isInteger(recordLimit) || recordLimit < 1) {
    throw new TypeError('recordLimit must be a positive integer');
  }

  const jobs = new Map();
  const manualContexts = new Map();
  const autoStartedSessions = new Map();
  const statuses = new Map();
  const queues = new Map();
  const lastFinishedAt = new Map();
  const listeners = new Set();
  let generation = 0;
  let disposed = false;

  function start(options) {
    requireContext(options);
    stop(options.endpointId);
    const config = normalizeModbusMasterConfig(options.config);
    const job = {
      endpointId: options.endpointId,
      sessionId: options.sessionId,
      config,
      configSignature: signature(config),
      generation: ++generation,
      kind: 'scheduled',
      cancelled: false,
      timerId: null,
      retryWaiters: new Set(),
      busy: false,
      due: new Map(enabledRequests(config)
        .map(({ group, request }) => [requestKey(group.id, request.id), clock()])),
    };
    jobs.set(job.endpointId, job);
    ensureStatus(job.endpointId, job.sessionId, config, true);
    publish(job.endpointId);
    schedule(job, 0);
    return getStatus(job.endpointId);
  }

  function stop(endpointId, sessionId) {
    const job = jobs.get(endpointId);
    let stopped = false;
    if (job && (sessionId === undefined || job.sessionId === sessionId)) {
      jobs.delete(endpointId);
      cancelContext(job);
      job.timerId = null;
      job.generation = ++generation;
      const status = statuses.get(endpointId);
      if (status) {
        status.active = false;
        publish(endpointId);
      }
      stopped = true;
    }
    for (const context of [...(manualContexts.get(endpointId) ?? [])]) {
      if (sessionId !== undefined && context.sessionId !== sessionId) continue;
      cancelContext(context);
      stopped = true;
    }
    return stopped;
  }

  async function runGroup(options) {
    requireContext(options);
    const config = normalizeModbusMasterConfig(options.config);
    const group = config.requestGroups.find(({ id }) => id === options.groupId);
    if (!group) throw new RangeError(`Unknown Modbus request group: ${String(options.groupId)}`);
    const context = createManualContext(options, config);
    ensureStatus(options.endpointId, options.sessionId, config, jobs.has(options.endpointId));
    return enqueue(options.endpointId, () => executeGroupRun(context, group))
      .finally(() => releaseManualContext(context));
  }

  async function runRequest(options) {
    requireContext(options);
    const config = normalizeModbusMasterConfig(options.config);
    const group = config.requestGroups.find(({ id }) => id === options.groupId);
    if (!group) throw new RangeError(`Unknown Modbus request group: ${String(options.groupId)}`);
    const request = group.requests.find(({ id }) => id === options.requestId);
    if (!request) throw new RangeError(`Unknown Modbus request: ${String(options.requestId)}`);
    const context = createManualContext(options, config);
    ensureStatus(options.endpointId, options.sessionId, config, jobs.has(options.endpointId));
    return enqueue(options.endpointId, () => executeRequest(context, group, request))
      .finally(() => releaseManualContext(context));
  }

  async function executeImmediate(options) {
    requireContext(options);
    if (!options.request || typeof options.request !== 'object') {
      throw new TypeError('immediate Modbus request is required');
    }
    const config = normalizeModbusMasterConfig(options.config);
    const context = createManualContext(options, config);
    const request = {
      ...options.request,
      endpointId: options.endpointId,
      expectedSessionId: options.sessionId,
      values: Array.from(options.request.values ?? []),
    };
    return enqueue(options.endpointId, async () => {
      if (!await waitForRequestGap(context)) return null;
      try {
        const result = await execute(request);
        return isCancelled(context) ? null : result;
      } finally {
        lastFinishedAt.set(context.endpointId, clock());
      }
    }).finally(() => releaseManualContext(context));
  }

  function getStatus(endpointId) {
    return snapshotStatus(statuses.get(endpointId) ?? emptyStatus(endpointId));
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function reconcile({ endpoints = [], operations = new Map(), statuses: endpointStatuses = new Map(), reset = false, disposed: workspaceDisposed = false } = {}) {
    if (reset || workspaceDisposed) {
      stopAll();
      autoStartedSessions.clear();
      return;
    }
    const endpointMap = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
    // Manual reads and confirmed writes also belong to a connection, even when
    // automatic polling has never been started for this endpoint.
    for (const [endpointId, contexts] of manualContexts) {
      for (const context of contexts) {
        if (!endpointMap.has(endpointId)
          || operations.get(endpointId)?.sessionId !== context.sessionId
          || ['closed', 'closing', 'error'].includes(endpointStatuses.get(endpointId)?.status)) {
          cancelContext(context);
        }
      }
    }
    for (const [endpointId, sessionId] of autoStartedSessions) {
      if (!endpointMap.has(endpointId) || operations.get(endpointId)?.sessionId !== sessionId
        || ['closed', 'closing', 'error'].includes(endpointStatuses.get(endpointId)?.status)) {
        autoStartedSessions.delete(endpointId);
      }
    }
    for (const [endpointId, job] of jobs) {
      const endpoint = endpointMap.get(endpointId);
      const operation = operations.get(endpointId);
      const endpointStatus = endpointStatuses.get(endpointId)?.status;
      if (!endpoint || operation?.sessionId !== job.sessionId
        || ['closed', 'closing', 'error'].includes(endpointStatus)) {
        stop(endpointId);
        continue;
      }
      const config = normalizeModbusMasterConfig(endpoint.config);
      if (!config.enabled) {
        stop(endpointId);
      } else if (job.configSignature !== signature(config)) {
        start({ endpointId, sessionId: operation.sessionId, config });
      }
    }
    for (const endpoint of endpoints) {
      if (!endpoint.transport?.endsWith('-master') || !endpoint.transport.startsWith('modbus-')) continue;
      const config = normalizeModbusMasterConfig(endpoint.config);
      const operation = operations.get(endpoint.id);
      const running = operation?.sessionId
        && ['open', 'connected'].includes(endpointStatuses.get(endpoint.id)?.status ?? 'open');
      if (running && config.enabled && config.scheduler.autoStart && !jobs.has(endpoint.id)
        && autoStartedSessions.get(endpoint.id) !== operation.sessionId) {
        autoStartedSessions.set(endpoint.id, operation.sessionId);
        start({ endpointId: endpoint.id, sessionId: operation.sessionId, config });
      }
    }
  }

  function dispose() {
    if (disposed) return;
    stopAll();
    autoStartedSessions.clear();
    lastFinishedAt.clear();
    disposed = true;
    listeners.clear();
  }

  function stopAll() {
    for (const endpointId of new Set([...jobs.keys(), ...manualContexts.keys()])) stop(endpointId);
  }

  function schedule(job, delay) {
    if (!isCurrent(job) || job.timerId !== null) return;
    job.timerId = timers.setTimeout(() => {
      job.timerId = null;
      void tick(job);
    }, Math.max(0, delay));
  }

  async function tick(job) {
    if (!isCurrent(job) || job.busy) return;
    const now = clock();
    const dueRequests = enabledRequests(job.config)
      .filter(({ group, request }) => (
        (job.due.get(requestKey(group.id, request.id)) ?? now) <= now
      ))
      .sort((left, right) => (
        (job.due.get(requestKey(left.group.id, left.request.id)) ?? now)
          - (job.due.get(requestKey(right.group.id, right.request.id)) ?? now)
        || left.group.order - right.group.order
        || left.request.order - right.request.order
        || left.group.id.localeCompare(right.group.id)
        || left.request.id.localeCompare(right.request.id)
      ));
    if (dueRequests.length === 0) {
      const nextDue = Math.min(...job.due.values());
      if (Number.isFinite(nextDue)) schedule(job, nextDue - now);
      return;
    }
    const { group, request } = dueRequests[0];
    job.busy = true;
    try {
      await enqueue(job.endpointId, () => executeRequest(job, group, request));
    } catch {
      // executeRequest already recorded the terminal request failure.
    } finally {
      job.busy = false;
    }
    if (!isCurrent(job)) return;
    const finishedAt = clock();
    job.due.set(requestKey(group.id, request.id), finishedAt + request.intervalMs);
    schedule(job, job.config.scheduler.minGapMs);
  }

  async function executeGroupRun(context, group) {
    const status = ensureStatus(context.endpointId, context.sessionId, context.config, jobs.has(context.endpointId));
    status.groups[group.id].running = true;
    publish(context.endpointId);
    const results = [];
    for (const request of orderedRequests(group).filter(({ enabled }) => enabled)) {
      if (isCancelled(context)) break;
      try {
        const transaction = await executeRequest(context, group, request);
        if (transaction) {
          results.push({ requestId: request.id, requestName: request.name, success: true, transaction });
        }
      } catch (error) {
        const failure = normalizeError(error);
        results.push({
          requestId: request.id,
          requestName: request.name,
          success: false,
          error: failure.message,
          transaction: failure.transaction ?? null,
        });
      }
    }
    if (isCancelled(context)) {
      status.groups[group.id].running = false;
      return null;
    }
    const successful = results.filter(({ success }) => success).length;
    const result = results.length === 0
      ? 'skipped'
      : successful === results.length ? 'success' : successful === 0 ? 'failed' : 'partial';
    const summary = { groupId: group.id, groupName: group.name, result, results, createdAt: clock() };
    const current = ensureStatus(
      context.endpointId, context.sessionId, context.config, jobs.has(context.endpointId),
    );
    Object.assign(current.groups[group.id], {
      running: false,
      lastResult: result,
      lastRunSummary: summary,
    });
    publish(context.endpointId);
    return summary;
  }

  async function executeRequest(context, group, request) {
    const retryCount = request.retryCount ?? context.config.retryCount;
    const retryIntervalMs = request.retryIntervalMs ?? context.config.retryIntervalMs;
    const timeoutMs = request.timeoutMs ?? context.config.timeoutMs;
    let lastError;
    let lastStartedAt = clock();
    for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
      if (isCancelled(context)) return null;
      if (!await waitForRequestGap(context)) return null;
      const startedAt = clock();
      lastStartedAt = startedAt;
      try {
        const result = await execute({
          endpointId: context.endpointId,
          expectedSessionId: context.sessionId,
          requestGroupId: group.id,
          requestId: request.id,
          functionCode: request.functionCode,
          unitId: group.unitId,
          address: request.startAddress,
          quantity: request.quantity,
          values: [],
          timeoutMs,
        });
        lastFinishedAt.set(context.endpointId, clock());
        if (isCancelled(context)) return null;
        updateSuccess(context, group, request, result, attempt, startedAt);
        return result;
      } catch (error) {
        lastFinishedAt.set(context.endpointId, clock());
        if (isCancelled(context)) return null;
        lastError = normalizeError(error);
        if (attempt > retryCount || !isRetryableRequestFailure(lastError)) break;
        if (retryIntervalMs > 0) await delay(retryIntervalMs, context);
      }
    }
    if (isCancelled(context)) return null;
    updateFailure(context, group, request, lastError, lastStartedAt);
    throw lastError;
  }

  function updateSuccess(context, group, request, transaction, attempt, startedAt) {
    const status = ensureStatus(context.endpointId, context.sessionId, context.config, jobs.has(context.endpointId));
    const requestState = status.groups[group.id].requests[request.id];
    const points = Object.fromEntries(request.dataPoints.map((point) => {
      const next = decodeModbusMasterPoint(point, transaction.values, request.functionCode);
      if (next.quality === 'good') requestState.lastGoodPoints[point.id] = cloneReading(next);
      return [point.id, applyInvalidPolicy(point, next, requestState.lastGoodPoints[point.id])];
    }));
    Object.assign(requestState, {
      enabled: request.enabled,
      lastAttemptAt: transaction.createdAt ?? clock(),
      lastSuccessAt: transaction.createdAt ?? clock(),
      lastError: null,
      durationMs: transaction.durationMs ?? Math.max(0, clock() - startedAt),
      successCount: requestState.successCount + 1,
      consecutiveFailures: 0,
      rawValues: [...(transaction.values ?? [])],
      points,
    });
    addRecord(status, group, request, true, attempt, requestState.durationMs, null, transaction);
    publish(context.endpointId);
    publishPointOutcomes(
      context, group, request, transaction.createdAt ?? clock(), requestState.points,
    );
  }

  function updateFailure(context, group, request, error, startedAt) {
    const status = ensureStatus(context.endpointId, context.sessionId, context.config, jobs.has(context.endpointId));
    const requestState = status.groups[group.id].requests[request.id];
    const failedAt = clock();
    const durationMs = error.transaction?.durationMs ?? Math.max(0, failedAt - startedAt);
    Object.assign(requestState, {
      enabled: request.enabled,
      lastAttemptAt: failedAt,
      lastFailureAt: failedAt,
      lastError: error.message,
      durationMs,
      failureCount: requestState.failureCount + 1,
      consecutiveFailures: requestState.consecutiveFailures + 1,
      points: Object.fromEntries(request.dataPoints.map((point) => {
        const next = communicationFailureReading(point, error.message);
        return [point.id, applyInvalidPolicy(point, next, requestState.lastGoodPoints[point.id])];
      })),
    });
    addRecord(status, group, request, false, retryAttempts(request, context.config), durationMs, error.message, error.transaction ?? null);
    publish(context.endpointId);
    publishPointOutcomes(context, group, request, failedAt, requestState.points);
  }

  function publishPointOutcomes(context, group, request, createdAt, readings) {
    const batch = {
      endpointId: context.endpointId,
      sessionId: context.sessionId,
      requestGroupId: group.id,
      requestId: request.id,
      createdAt,
      points: request.dataPoints
        .filter(({ enabled }) => enabled)
        .map((point) => ({ ...point, ...cloneReading(readings[point.id]) })),
    };
    try {
      Promise.resolve(onPointOutcomes(structuredClone(batch))).catch(() => {});
    } catch {
      // History observers do not own scheduler progress.
    }
  }

  function addRecord(status, group, request, success, attempt, durationMs, error, transaction) {
    status.records.unshift({
      id: `${status.endpointId}-${group.id}-${request.id}-${clock()}-${status.records.length}`,
      groupId: group.id,
      requestGroupId: group.id,
      groupName: group.name,
      requestId: request.id,
      requestName: request.name,
      success,
      attempt,
      durationMs,
      error,
      createdAt: transaction?.createdAt ?? clock(),
      transaction,
    });
    status.records.splice(recordLimit);
  }

  function ensureStatus(endpointId, sessionId, configSource, active) {
    const config = normalizeModbusMasterConfig(configSource);
    let status = statuses.get(endpointId);
    if (!status || status.sessionId !== sessionId) {
      status = emptyStatus(endpointId, sessionId);
      statuses.set(endpointId, status);
    }
    status.active = active;
    for (const group of config.requestGroups) {
      status.groups[group.id] ??= emptyGroupStatus(group);
      const groupState = status.groups[group.id];
      groupState.enabled = group.enabled;
      for (const request of group.requests) {
        groupState.requests[request.id] ??= emptyRequestStatus(request);
        const requestState = groupState.requests[request.id];
        requestState.enabled = request.enabled;
        const pointIds = new Set(request.dataPoints.map(({ id }) => id));
        for (const pointId of Object.keys(requestState.lastGoodPoints)) {
          if (!pointIds.has(pointId)) delete requestState.lastGoodPoints[pointId];
        }
        for (const pointId of Object.keys(requestState.points)) {
          if (!pointIds.has(pointId)) delete requestState.points[pointId];
        }
      }
      const requestIds = new Set(group.requests.map(({ id }) => id));
      for (const requestId of Object.keys(groupState.requests)) {
        if (!requestIds.has(requestId)) delete groupState.requests[requestId];
      }
    }
    const validIds = new Set(config.requestGroups.map(({ id }) => id));
    for (const groupId of Object.keys(status.groups)) {
      if (!validIds.has(groupId)) delete status.groups[groupId];
    }
    return status;
  }

  function publish(endpointId) {
    const snapshot = getStatus(endpointId);
    for (const listener of [...listeners]) {
      try { listener(endpointId, snapshot); } catch { /* observers do not own scheduling */ }
    }
  }

  function enqueue(endpointId, operation) {
    const prior = queues.get(endpointId) ?? Promise.resolve();
    const pending = prior.then(operation, operation);
    queues.set(endpointId, pending.catch(() => {}));
    return pending;
  }

  function delay(milliseconds, context) {
    if (!(context.retryWaiters instanceof Set)) {
      return new Promise((resolve) => timers.setTimeout(resolve, milliseconds));
    }
    return new Promise((resolve) => {
      let settled = false;
      let cancelWait;
      const timerId = timers.setTimeout(finish, milliseconds);
      function finish() {
        if (settled) return;
        settled = true;
        context.retryWaiters.delete(cancelWait);
        resolve();
      }
      cancelWait = () => {
        timers.clearTimeout(timerId);
        finish();
      };
      context.retryWaiters.add(cancelWait);
      if (isCancelled(context)) cancelWait();
    });
  }

  function isCurrent(job) {
    return !disposed && jobs.get(job.endpointId) === job;
  }

  function isCancelled(context) {
    return context.cancelled || (context.kind === 'scheduled' && !isCurrent(context));
  }

  async function waitForRequestGap(context) {
    const minimum = context.config.scheduler.minGapMs;
    const previous = lastFinishedAt.get(context.endpointId);
    const remaining = previous === undefined ? 0 : minimum - (clock() - previous);
    if (remaining > 0) await delay(remaining, context);
    return !isCancelled(context);
  }

  function cancelContext(context) {
    context.cancelled = true;
    if (context.timerId !== null && context.timerId !== undefined) {
      timers.clearTimeout(context.timerId);
    }
    for (const cancelWait of [...context.retryWaiters]) cancelWait();
    context.retryWaiters.clear();
  }

  function createManualContext(options, config) {
    const context = {
      endpointId: options.endpointId,
      sessionId: options.sessionId,
      config,
      kind: 'manual',
      cancelled: false,
      retryWaiters: new Set(),
    };
    const contexts = manualContexts.get(options.endpointId) ?? new Set();
    contexts.add(context);
    manualContexts.set(options.endpointId, contexts);
    return context;
  }

  function releaseManualContext(context) {
    const contexts = manualContexts.get(context.endpointId);
    contexts?.delete(context);
    if (contexts?.size === 0) manualContexts.delete(context.endpointId);
  }

  return {
    start, stop, runGroup, runRequest, executeImmediate,
    getStatus, subscribe, reconcile, dispose,
  };
}

function emptyStatus(endpointId, sessionId = null) {
  return { active: false, endpointId, sessionId, groups: {}, records: [] };
}

function emptyGroupStatus(group) {
  return {
    groupId: group.id,
    enabled: group.enabled,
    running: false,
    lastResult: null,
    lastRunSummary: null,
    requests: Object.fromEntries(group.requests.map((request) => [
      request.id, emptyRequestStatus(request),
    ])),
  };
}

function emptyRequestStatus(request) {
  return {
    requestId: request.id,
    enabled: request.enabled,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    durationMs: null,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    rawValues: [],
    lastGoodPoints: {},
    points: Object.fromEntries(request.dataPoints.map((point) => [
      point.id,
      point.enabled === false
        ? communicationFailureReading({ enabled: false }, '')
        : { raw: [], value: null, display: '—', quality: 'bad-communication', reason: '尚未读取' },
    ])),
  };
}

function enabledRequests(config) {
  return config.requestGroups.flatMap((group) => (
    group.enabled
      ? orderedRequests(group)
        .filter(({ enabled }) => enabled)
        .map((request) => ({ group, request }))
      : []
  ));
}

function orderedRequests(group) {
  return [...group.requests].sort((left, right) => (
    left.order - right.order || left.id.localeCompare(right.id)
  ));
}

function requestKey(groupId, requestId) {
  return JSON.stringify([groupId, requestId]);
}

function retryAttempts(request, config) {
  return (request.retryCount ?? config.retryCount) + 1;
}

function snapshotStatus(status) {
  return structuredClone(status);
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableRequestFailure(error) {
  if (error.code === 'MODBUS_EXCEPTION') return true;
  return ![
    'IO_ERROR', 'DEVICE_REMOVED', 'PORT_NOT_FOUND', 'PORT_BUSY', 'PERMISSION_DENIED',
  ].includes(error.code);
}

function applyInvalidPolicy(point, next, previous) {
  if (point.invalidPolicy !== 'keep-last-good'
    || ['good', 'disabled'].includes(next.quality)
    || previous?.value === null || previous?.value === undefined) {
    return next;
  }
  return {
    ...next,
    value: previous.value,
    display: previous.display,
    reason: next.reason ? `${next.reason}；已保留上次正常值` : '已保留上次正常值',
  };
}

function cloneReading(value) {
  return { ...value, raw: [...value.raw] };
}

function signature(config) {
  return JSON.stringify(config);
}

function requireContext(options) {
  if (!options || typeof options !== 'object') throw new TypeError('scheduler context is required');
  if (typeof options.endpointId !== 'string' || !options.endpointId.trim()) {
    throw new TypeError('endpointId must be a nonblank string');
  }
  if (typeof options.sessionId !== 'string' || !options.sessionId.trim()) {
    throw new TypeError('sessionId must be a nonblank string');
  }
}
