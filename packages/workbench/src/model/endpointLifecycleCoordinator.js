export function createEndpointLifecycleCoordinator({ cancelOpen, createDisposedError }) {
  if (typeof cancelOpen !== 'function') throw new TypeError('cancelOpen must be a function');
  if (typeof createDisposedError !== 'function') {
    throw new TypeError('createDisposedError must be a function');
  }

  const queues = new Map();
  const openRecords = new Map();
  const currentIntents = new Map();
  const intentMetadata = new WeakMap();
  let intentGeneration = 0;
  let collectionRevision = 0;
  let loadGeneration = 0;
  let disposed = false;

  const coordinator = {
    beginLoad() {
      loadGeneration += 1;
      return { generation: loadGeneration, collectionRevision };
    },
    canApplyLoad(load) {
      return load.generation === loadGeneration
        && load.collectionRevision === collectionRevision;
    },
    recordCollectionMutation() {
      collectionRevision += 1;
    },
    beginOpenIntent(endpointId, operationId, { blockedSessionIds = [] } = {}) {
      return beginIntent(endpointId, operationId, blockedSessionIds, null);
    },
    beginInvalidation(endpointId, { operationId = null, forceRuntime = false } = {}) {
      return beginIntent(endpointId, null, [], { operationId, forceRuntime });
    },
    enqueue(endpointId, operation, { readiness } = {}) {
      return enqueueItem(endpointId, operation, { readiness }).promise;
    },
    enqueueOpen(intent, operation, { readiness } = {}) {
      if (!intentMetadata.has(intent)) throw new TypeError('Unknown open intent');
      let record;
      const item = enqueueItem(intent.endpointId, operation, {
        readiness,
        onStart(startedItem) {
          record = { intent, item: startedItem, cancellation: null };
          openRecords.set(intent.endpointId, record);
        },
      });
      item.promise.then(
        () => { if (record) retireOpen(record); },
        () => { if (record) retireOpen(record); },
      );
      return item.promise;
    },
    hasOperation(endpointId, operationId) {
      return currentIntents.get(endpointId)?.operationId === operationId
        || openRecords.get(endpointId)?.intent.operationId === operationId;
    },
    isCurrent(intent) {
      return currentIntents.get(intent.endpointId) === intent;
    },
    acceptsEvent(endpointId, operationId, sessionId) {
      const intent = currentIntents.get(endpointId);
      if (!intent) return true;
      if (intent.operationId === null || intent.operationId !== operationId) return false;
      const metadata = intentMetadata.get(intent);
      if (metadata.boundSession !== null) return metadata.boundSession === sessionId;
      return !metadata.blockedSessionIds.has(sessionId);
    },
    bindSession(intent, sessionId) {
      if (!coordinator.isCurrent(intent)) return false;
      const metadata = intentMetadata.get(intent);
      metadata.blockedSessionIds.delete(sessionId);
      metadata.boundSession = sessionId;
      return true;
    },
    bindEventSession(endpointId, operationId, sessionId) {
      const intent = currentIntents.get(endpointId);
      if (!intent || intent.operationId !== operationId) return;
      coordinator.bindSession(intent, sessionId);
    },
    clearIntent(intent) {
      if (coordinator.isCurrent(intent)) currentIntents.delete(intent.endpointId);
    },
    reset() {
      if (disposed) return;
      loadGeneration += 1;
      collectionRevision += 1;
      currentIntents.clear();
      for (const record of [...openRecords.values()]) {
        requestNativeCancel(record).catch(() => {});
        abortItem(record.item, createOpenCancelledError(
          record.intent.endpointId,
          record.intent.operationId,
        ));
      }
      for (const [endpointId, queue] of queues) {
        const error = createOpenCancelledError(endpointId, 'workspace-import');
        if (queue.running) abortItem(queue.running, error);
        for (const item of [...queue.items]) abortItem(item, error);
      }
      queues.clear();
      openRecords.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      currentIntents.clear();
      for (const record of [...openRecords.values()]) {
        requestNativeCancel(record).catch(() => {});
      }
      for (const queue of queues.values()) {
        if (queue.running) abortItem(queue.running, createDisposedError());
        for (const item of [...queue.items]) abortItem(item, createDisposedError());
      }
      queues.clear();
      openRecords.clear();
    },
    diagnostics() {
      let queued = 0;
      let running = 0;
      for (const queue of queues.values()) {
        queued += queue.items.length;
        if (queue.running) running += 1;
      }
      return { endpoints: queues.size, queued, running, opens: openRecords.size };
    },
  };

  function beginIntent(endpointId, operationId, blockedSessionIds, cancellationOptions) {
    intentGeneration += 1;
    const previousIntent = currentIntents.get(endpointId) ?? null;
    const intent = Object.freeze({ endpointId, operationId, generation: intentGeneration });
    intentMetadata.set(intent, {
      blockedSessionIds: new Set(blockedSessionIds),
      boundSession: null,
    });
    currentIntents.set(endpointId, intent);
    let rolledBack = false;
    const cancellation = cancelForIntent(endpointId, cancellationOptions).catch((error) => {
      if (currentIntents.get(endpointId) === intent) {
        if (previousIntent) currentIntents.set(endpointId, previousIntent);
        else currentIntents.delete(endpointId);
        rolledBack = true;
      }
      throw error;
    });
    return {
      intent,
      previousIntent,
      cancellation,
      wasRolledBack: () => rolledBack,
    };
  }

  async function cancelForIntent(endpointId, options) {
    const record = openRecords.get(endpointId);
    if (record && (!options?.operationId || record.intent.operationId === options.operationId)) {
      await requestNativeCancel(record);
      abortItem(record.item, createOpenCancelledError(endpointId, record.intent.operationId));
      retireOpen(record);
      return;
    }
    if (options?.forceRuntime && options.operationId) {
      await cancelOpen(endpointId, { operationId: options.operationId });
    }
  }

  function requestNativeCancel(record) {
    if (!record.item.started) return Promise.resolve();
    if (!record.cancellation) {
      try {
        record.cancellation = Promise.resolve(cancelOpen(
          record.intent.endpointId,
          { operationId: record.intent.operationId },
        ));
      } catch (error) {
        record.cancellation = Promise.reject(error);
      }
      record.item.nativeCancellation = record.cancellation.then(
        () => true,
        () => false,
      );
      record.cancellation = record.cancellation.catch((error) => {
        record.cancellation = null;
        throw error;
      });
    }
    return record.cancellation;
  }

  function enqueueItem(endpointId, operation, { readiness, onStart } = {}) {
    if (disposed) return rejectedItem(createDisposedError());
    const queue = queues.get(endpointId) ?? { running: null, items: [] };
    queues.set(endpointId, queue);
    const item = createQueueItem(endpointId, operation, onStart);
    queue.items.push(item);
    drain(endpointId, queue);
    if (readiness) {
      Promise.resolve(readiness).catch((error) => abortItem(item, error));
    }
    return item;
  }

  function drain(endpointId, queue) {
    if (disposed || queue.running) return;
    const item = queue.items.shift();
    if (!item) {
      queues.delete(endpointId);
      return;
    }
    queue.running = item;
    item.started = true;
    item.onStart?.(item);
    let runtimePromise;
    try {
      runtimePromise = Promise.resolve(item.operation());
    } catch (error) {
      runtimePromise = Promise.reject(error);
    }
    const runtimeOutcome = runtimePromise.then(
      (value) => waitForNativeCancellation(item, { type: 'success', value }),
      (error) => waitForNativeCancellation(item, { type: 'failure', error }),
    );
    Promise.race([
      runtimeOutcome,
      item.abort.then((error) => ({ type: 'abort', error })),
    ]).then((outcome) => {
      queue.running = null;
      item.settled = true;
      if (queues.get(endpointId) === queue) drain(endpointId, queue);
      if (outcome.type === 'success') item.resolve(outcome.value);
      else item.reject(outcome.error);
    });
  }

  async function waitForNativeCancellation(item, outcome) {
    if (!item.nativeCancellation) return outcome;
    return await item.nativeCancellation ? new Promise(() => {}) : outcome;
  }

  function abortItem(item, error) {
    if (item.settled || item.aborted) return;
    item.aborted = error;
    if (!item.started) {
      const queue = queues.get(item.endpointId);
      const index = queue?.items.indexOf(item) ?? -1;
      if (index >= 0) queue.items.splice(index, 1);
      item.settled = true;
      item.reject(error);
      if (queue && !queue.running && queue.items.length === 0) queues.delete(item.endpointId);
      return;
    }
    item.resolveAbort(error);
  }

  function retireOpen(record) {
    if (openRecords.get(record.intent.endpointId) === record) {
      openRecords.delete(record.intent.endpointId);
    }
  }

  return coordinator;
}

function createQueueItem(endpointId, operation, onStart) {
  let resolve;
  let reject;
  let resolveAbort;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const abort = new Promise((resolvePromise) => { resolveAbort = resolvePromise; });
  return {
    endpointId,
    operation,
    onStart,
    promise,
    resolve,
    reject,
    abort,
    resolveAbort,
    started: false,
    settled: false,
    aborted: null,
    nativeCancellation: null,
  };
}

function rejectedItem(error) {
  const promise = Promise.reject(error);
  return { promise };
}

function createOpenCancelledError(endpointId, operationId) {
  const error = new Error(`Open operation "${operationId}" was cancelled for ${endpointId}`);
  error.name = 'OpenCancelledError';
  error.code = 'OPEN_CANCELLED';
  return error;
}
