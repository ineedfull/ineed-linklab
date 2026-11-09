export function reconnectDelayMs(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('attempt must be a positive integer');
  }
  return Math.min(500 * (2 ** Math.min(attempt - 1, 16)), 30_000);
}

export function createTcpReconnectController({
  clock = Date.now,
  timers = globalThis,
  states = new Map(),
  createOperationId,
  _issuedOperationIds,
  openAttempt,
  onChange = () => {},
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('timers must provide setTimeout and clearTimeout');
  }
  if (!(states instanceof Map)) throw new TypeError('states must be a Map');
  const hasCustomOperationIdFactory = createOperationId !== undefined;
  const operationIdFactory = createOperationId ?? createDefaultOperationId(clock);
  if (typeof operationIdFactory !== 'function') {
    throw new TypeError('createOperationId must be a function');
  }
  if (_issuedOperationIds !== undefined && !(_issuedOperationIds instanceof Map)) {
    throw new TypeError('_issuedOperationIds must be a Map');
  }
  if (typeof openAttempt !== 'function') throw new TypeError('openAttempt must be a function');
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');

  const records = new Map();
  const generations = new Map();
  const issuedOperationIds = hasCustomOperationIdFactory
    ? (_issuedOperationIds ?? new Map())
    : null;
  let disposed = false;

  const controller = {
    states,
    arm(endpointId, operationId) {
      if (disposed) return null;
      retire(endpointId);
      const record = {
        endpointId,
        generation: nextGeneration(endpointId),
        operationId,
        sessionId: null,
        phase: 'connecting',
        attempt: 0,
        timerId: null,
        lastError: null,
        lastTerminal: null,
      };
      records.set(endpointId, record);
      issuedIdsFor(endpointId)?.add(operationId);
      return record.generation;
    },
    connected(identity) {
      const record = matchingRecord(identity, true);
      if (!record) return false;
      clearRecordTimer(record);
      record.sessionId = identity.sessionId ?? null;
      record.phase = 'connected';
      record.attempt = 0;
      record.lastError = null;
      record.lastTerminal = null;
      unpublish(record.endpointId);
      return true;
    },
    failed(identity) {
      const record = matchingRecord(identity, false);
      if (!record || isRepeatedTerminal(record, identity)) return false;
      record.lastTerminal = terminalIdentity(identity);
      scheduleRetry(record, identity.error);
      return true;
    },
    cancel(endpointId) {
      return cancelRecord(endpointId);
    },
    reconcile(endpoints) {
      const eligible = new Set((Array.isArray(endpoints) ? endpoints : [])
        .filter((endpoint) => (
          ['tcp-client', 'modbus-tcp-master', 'websocket-client'].includes(endpoint?.transport)
          && endpoint.config?.autoReconnect === true
        ))
        .map(({ id }) => id));
      for (const endpointId of [...records.keys()]) {
        if (!eligible.has(endpointId)) cancelRecord(endpointId);
      }
    },
    stateFor(endpointId) {
      return states.get(endpointId) ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const endpointId of [...records.keys()]) cancelRecord(endpointId);
      if (states.size > 0) {
        states.clear();
        notify();
      }
    },
  };

  function nextGeneration(endpointId) {
    const generation = (generations.get(endpointId) ?? 0) + 1;
    generations.set(endpointId, generation);
    return generation;
  }

  function issuedIdsFor(endpointId) {
    if (issuedOperationIds === null) return null;
    let issued = issuedOperationIds.get(endpointId);
    if (!issued) {
      issued = new Set();
      issuedOperationIds.set(endpointId, issued);
    }
    return issued;
  }

  function matchingRecord(identity, canBindSession) {
    if (disposed) return null;
    const record = records.get(identity?.endpointId);
    if (!record || record.operationId !== identity?.operationId) return null;
    const sessionId = identity?.sessionId ?? null;
    if (record.sessionId !== null && record.sessionId !== sessionId) return null;
    if (!canBindSession && record.sessionId === null && sessionId !== null) return null;
    return record;
  }

  function scheduleRetry(record, error) {
    if (!isCurrent(record)) return;
    clearRecordTimer(record);
    record.attempt += 1;
    record.phase = 'waiting';
    record.lastError = normalizeError(error);
    const delay = reconnectDelayMs(record.attempt);
    const nextRetryAt = clock() + delay;
    const generation = record.generation;
    const timerId = timers.setTimeout(async () => {
      if (!isCurrent(record, generation) || record.timerId !== timerId) return;
      record.timerId = null;
      await runAttempt(record, generation);
    }, delay);
    record.timerId = timerId;
    publish(record, nextRetryAt);
  }

  async function runAttempt(record, generation) {
    if (!isCurrent(record, generation)) return;
    let operationId;
    try {
      operationId = operationIdFactory({
        endpointId: record.endpointId,
        attempt: record.attempt,
        generation,
      });
      if (!isNonblankString(operationId)) {
        throw new TypeError('createOperationId must return a nonblank string');
      }
      const issued = issuedIdsFor(record.endpointId);
      if (issued?.has(operationId)) {
        throw new TypeError('createOperationId must return a fresh operation id');
      }
      issued?.add(operationId);
    } catch (error) {
      if (isCurrent(record, generation)) scheduleRetry(record, error);
      return;
    }
    if (!isCurrent(record, generation)) return;
    record.operationId = operationId;
    record.sessionId = null;
    record.phase = 'connecting';
    record.lastTerminal = null;
    publish(record, null);
    if (!isCurrent(record, generation) || record.operationId !== operationId) return;

    let result;
    try {
      result = await openAttempt({
        endpointId: record.endpointId,
        operationId,
        generation,
        attempt: record.attempt,
      });
    } catch (error) {
      result = { ok: false, error };
    }
    if (!isCurrent(record, generation) || record.operationId !== operationId) return;
    if (result?.ok) {
      controller.connected({
        endpointId: record.endpointId,
        operationId,
        sessionId: result.value?.sessionId ?? result.value?.id,
      });
    } else {
      controller.failed({
        endpointId: record.endpointId,
        operationId,
        sessionId: null,
        error: result?.error ?? new Error('TCP reconnect attempt failed'),
      });
    }
  }

  function publish(record, nextRetryAt) {
    states.set(record.endpointId, Object.freeze({
      endpointId: record.endpointId,
      phase: record.phase,
      attempt: record.attempt,
      nextRetryAt,
      operationId: record.phase === 'connecting' ? record.operationId : null,
      lastError: record.lastError,
    }));
    notify();
  }

  function unpublish(endpointId) {
    if (!states.delete(endpointId)) return;
    notify();
  }

  function notify() {
    try {
      Promise.resolve(onChange(states)).catch(() => {});
    } catch {
      // Observers do not own reconnect resources.
    }
  }

  function clearRecordTimer(record) {
    if (record.timerId === null) return;
    timers.clearTimeout(record.timerId);
    record.timerId = null;
  }

  function retire(endpointId) {
    const record = records.get(endpointId);
    if (record) clearRecordTimer(record);
    records.delete(endpointId);
    unpublish(endpointId);
  }

  function cancelRecord(endpointId) {
    const record = records.get(endpointId);
    nextGeneration(endpointId);
    if (!record) {
      unpublish(endpointId);
      return null;
    }
    const cancelled = Object.freeze({
      phase: record.phase,
      operationId: record.operationId,
    });
    retire(endpointId);
    return cancelled;
  }

  function isCurrent(record, generation = record.generation) {
    return !disposed
      && records.get(record.endpointId) === record
      && record.generation === generation;
  }

  return controller;
}

function isRepeatedTerminal(record, identity) {
  return record.lastTerminal?.operationId === identity.operationId
    && record.lastTerminal?.sessionId === (identity.sessionId ?? null);
}

function terminalIdentity(identity) {
  return {
    operationId: identity.operationId,
    sessionId: identity.sessionId ?? null,
  };
}

function normalizeError(error) {
  const code = isNonblankString(error?.code) ? error.code : 'UNKNOWN';
  const message = isNonblankString(error?.message) ? error.message : String(error ?? 'Unknown error');
  return Object.freeze({ code, message });
}

function isNonblankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function createDefaultOperationId(clock) {
  let sequence = 0;
  return ({ endpointId, attempt }) => {
    sequence += 1;
    return `reconnect-${endpointId}-${clock()}-${attempt}-${sequence}`;
  };
}
