const FLUSH_MS = 1_000;
const MAX_BATCH_SIZE = 200;

async function createTransportPersistence({
  database,
  endpointReceiveMode = () => 'raw',
  reportError = defaultReportError,
  timers = globalThis,
  retryDelay,
} = {}) {
  if (typeof database?.insertFrameBatch !== 'function') {
    throw new TypeError('database.insertFrameBatch is required');
  }
  if (typeof database?.insertLogBatch !== 'function') {
    throw new TypeError('database.insertLogBatch is required');
  }
  if (typeof endpointReceiveMode !== 'function') {
    throw new TypeError('endpointReceiveMode must be a function');
  }
  if (typeof reportError !== 'function') throw new TypeError('reportError must be a function');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('timers must provide setTimeout and clearTimeout');
  }

  const { createBatchedPersistence } = await import(
    '@ineed-linklab/persistence-contract/batchedPersistence.js'
  );
  const batcherOptions = {
    flushMs: FLUSH_MS,
    maxBatchSize: MAX_BATCH_SIZE,
    schedule: (callback, delay) => timers.setTimeout(callback, delay),
    clear: (timer) => timers.clearTimeout(timer),
    ...(retryDelay ? { retryDelay } : {}),
  };
  const frames = createBatchedPersistence({
    ...batcherOptions,
    persistBatch: async (rows) => {
      await Promise.resolve();
      return database.insertFrameBatch(rows);
    },
    onError: (error, rows) => safeReport(reportError, error, {
      kind: 'frames', rowCount: rows.length,
    }),
    onDrop: (rows) => safeReport(reportError, new Error('Frame persistence queue overflow'), {
      kind: 'frames', droppedCount: rows.length,
    }),
  });
  const logs = createBatchedPersistence({
    ...batcherOptions,
    persistBatch: async (rows) => {
      await Promise.resolve();
      return database.insertLogBatch(rows);
    },
    onError: (error, rows) => safeReport(reportError, error, {
      kind: 'logs', rowCount: rows.length,
    }),
    onDrop: (rows) => safeReport(reportError, new Error('Log persistence queue overflow'), {
      kind: 'logs', droppedCount: rows.length,
    }),
  });

  return {
    handle(channel, payload) {
      try {
        if (channel === 'transport:frames') {
          const framing = endpointReceiveMode(payload.endpointId);
          for (const frame of payload.frames) {
            const bytes = Uint8Array.from(frame.bytes);
            frames.enqueue({
              endpointId: payload.endpointId,
              sessionId: payload.sessionId,
              peerId: frame.peerId ?? null,
              direction: frame.direction,
              format: frame.messageType === 'text' ? 'text' : 'hex',
              framing,
              payload: bytes,
              byteCount: bytes.byteLength,
              createdAt: frame.createdAt,
            });
          }
        } else if (channel === 'transport:status' && payload.log !== null) {
          const log = payload.log;
          logs.enqueue({
            endpointId: payload.endpointId,
            sessionId: payload.sessionId,
            peerId: log.peerId ?? null,
            level: log.level,
            source: log.source,
            code: log.code,
            message: log.message,
            details: structuredClone(log.details),
            createdAt: log.createdAt,
          });
        }
      } catch (error) {
        safeReport(reportError, error, { kind: 'event', channel });
      }
    },
    flush() {
      return settleQueues([frames.flush(), logs.flush()]);
    },
    dispose() {
      return settleQueues([frames.dispose(), logs.dispose()]);
    },
  };
}

async function settleQueues(operations) {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function safeReport(reportError, error, context) {
  try {
    reportError(error, context);
  } catch {
    // Persistence reporting never feeds back into the transport event path.
  }
}

function defaultReportError(error, context) {
  console.error('[Ineed LinkLab] transport persistence failed', error, context);
}

module.exports = { createTransportPersistence };
