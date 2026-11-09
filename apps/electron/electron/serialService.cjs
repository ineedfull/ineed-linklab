const { Buffer } = require('node:buffer');

const SERIAL_ERROR_CODES = new Set([
  'PORT_NOT_FOUND',
  'PORT_BUSY',
  'PERMISSION_DENIED',
  'OPEN_CANCELLED',
  'DEVICE_REMOVED',
  'IO_ERROR',
]);
const DATA_BITS = new Set([5, 6, 7, 8]);
const PARITIES = new Set(['none', 'even', 'odd', 'mark', 'space']);
const STOP_BITS = new Set([1, 1.5, 2]);
const FLOW_CONTROLS = new Set(['none', 'hardware', 'software']);
const FRAME_BATCH_DELAY_MS = 200;
const FRAME_BATCH_LIMIT = 200;

class SerialService {
  constructor({
    SerialPort,
    clock = Date.now,
    timers = globalThis,
    emitEvent = () => {},
    reportEventError = () => {},
    framerFactory = createDefaultFramer,
  } = {}) {
    if (typeof SerialPort !== 'function') throw new TypeError('SerialPort must be a constructor');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
      throw new TypeError('timers must provide setTimeout and clearTimeout');
    }
    if (typeof emitEvent !== 'function') throw new TypeError('emitEvent must be a function');
    if (typeof reportEventError !== 'function') {
      throw new TypeError('reportEventError must be a function');
    }
    if (typeof framerFactory !== 'function') throw new TypeError('framerFactory must be a function');
    this.SerialPort = SerialPort;
    this.clock = clock;
    this.timers = timers;
    this.emitEvent = emitEvent;
    this.reportEventError = reportEventError;
    this.framerFactory = framerFactory;
    this.sessions = new Map();
    this.nextSessionId = 1;
    this.stopped = false;
  }

  async scan() {
    let records;
    try {
      records = await this.SerialPort.list();
    } catch (reason) {
      const error = mapSerialError(reason, { open: false });
      if (error.code === 'PERMISSION_DENIED') throw error;
      throw serialError('IO_ERROR', error.message);
    }
    const seen = new Set();
    const result = [];
    for (const record of Array.isArray(records) ? records : []) {
      const path = typeof record?.path === 'string' ? record.path.trim() : '';
      if (!path || seen.has(path)) continue;
      seen.add(path);
      result.push({
        path,
        manufacturer: optionalString(record, 'manufacturer'),
        serialNumber: optionalString(record, 'serialNumber'),
        vendorId: optionalString(record, 'vendorId'),
        productId: optionalString(record, 'productId'),
      });
    }
    return result;
  }

  open(endpoint, options = {}) {
    const endpointId = requireId(endpoint?.id, 'endpoint.id');
    const operationId = requireId(options?.operationId, 'options.operationId');
    if (this.stopped) return Promise.reject(serialError('IO_ERROR', 'Serial service is shut down'));
    if (endpoint.transport !== 'serial') {
      return Promise.reject(serialError('IO_ERROR', `Endpoint ${endpointId} is not serial`));
    }
    if (this.sessions.has(endpointId)) {
      return Promise.reject(serialError('PORT_BUSY', `Endpoint ${endpointId} is already active`));
    }

    const session = {
      endpoint,
      endpointId,
      operationId,
      sessionId: null,
      phase: 'opening',
      port: null,
      framer: null,
      listeners: null,
      pendingFrames: [],
      frameTimer: null,
      cancelled: false,
      cancellationError: null,
      failureCycle: false,
      terminal: false,
      forceAborted: false,
      terminalStatusEmitted: false,
      resourceClosed: false,
      openSettled: false,
      openInvoked: false,
      nativeOpenSettled: false,
      closePromise: null,
      sendTail: Promise.resolve(),
      closeOperation: null,
      resolveOpen: null,
      rejectOpen: null,
      resolveNativeOpen: null,
      rejectNativeOpen: null,
    };
    session.openPromise = new Promise((resolve, reject) => {
      session.resolveOpen = resolve;
      session.rejectOpen = reject;
    });
    session.nativeOpenPromise = new Promise((resolve, reject) => {
      session.resolveNativeOpen = resolve;
      session.rejectNativeOpen = reject;
    });
    this.sessions.set(endpointId, session);
    this.#emitStatus(session, 'opening', null, null);
    void this.#beginOpen(session);
    return session.openPromise;
  }

  async cancelOpen(endpointId, options = {}) {
    requireId(endpointId, 'endpointId');
    const operationId = requireId(options?.operationId, 'options.operationId');
    const session = this.sessions.get(endpointId);
    if (
      !session
      || (session.phase !== 'opening' && session.phase !== 'cancelling')
      || session.operationId !== operationId
    ) {
      throw serialError('OPEN_CANCELLED', `Open operation ${operationId} is not active`);
    }

    this.#requestCancellation(session);
    await session.nativeOpenPromise;
    return { endpointId, operationId, cancelled: true };
  }

  async close(endpointId) {
    requireId(endpointId, 'endpointId');
    const session = this.sessions.get(endpointId);
    if (!session) return { endpointId, closed: false };
    return this.#closeActiveSession(session);
  }

  async #closeActiveSession(session) {
    const { endpointId } = session;
    if (session.phase === 'opening' || session.phase === 'cancelling') {
      this.#requestCancellation(session);
      await session.nativeOpenPromise;
      return { endpointId, closed: true };
    }
    if (session.terminal) return { endpointId, closed: false };
    return this.#beginClose(session, { emitClosing: session.phase !== 'error' });
  }

  async send(request) {
    const endpointId = requireId(request?.endpointId, 'request.endpointId');
    const session = this.sessions.get(endpointId);
    if (!session || session.phase !== 'open' || !session.port?.isOpen) {
      throw serialError('IO_ERROR', `Endpoint ${endpointId} is not open`);
    }
    const expectedSessionId = request.target?.expectedSessionId;
    if (expectedSessionId !== undefined && requireId(expectedSessionId, 'target.expectedSessionId') !== session.sessionId) {
      throw serialError('OPEN_CANCELLED', 'Serial response belongs to an inactive session');
    }
    const bytes = copyBytes(request.bytes, 'request.bytes');
    // Native drain callbacks may finish out of order. Own the write, drain and
    // history commit together so outgoing records follow the actual wire order.
    const sending = session.sendTail.then(async () => {
      if (this.sessions.get(endpointId) !== session || session.phase !== 'open' || !session.port?.isOpen) {
        throw serialError('IO_ERROR', `Endpoint ${endpointId} is not open`);
      }
      try {
        await writeAndDrain(session.port, Buffer.from(bytes));
      } catch (reason) {
        const error = mapSerialError(reason, { open: false });
        this.#reportFailure(session, error, { operation: 'write' });
        throw error;
      }
      this.#enqueueFrame(session, 'out', bytes);
      return { endpointId, sessionId: session.sessionId, byteCount: bytes.byteLength };
    });
    // A failed send must settle its caller without poisoning subsequent tasks.
    session.sendTail = sending.then(() => undefined, () => undefined);
    return sending;
  }

  async closeAll() {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((endpointId) => this.close(endpointId)),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async shutdown() {
    this.stopped = true;
    await this.closeAll();
  }

  forceShutdown() {
    this.stopped = true;
    const activeSessions = [...this.sessions.values()];
    for (const session of activeSessions) this.#forceAbortSession(session);
    return { forced: activeSessions.length };
  }

  async #beginOpen(session) {
    try {
      const framer = await this.framerFactory({
        endpoint: session.endpoint,
        framing: session.endpoint.config?.receiveFraming ?? { mode: 'raw' },
        emitFrame: (bytes) => this.#enqueueFrame(session, 'in', bytes),
        clock: this.clock,
        timers: this.timers,
      });
      validateFramer(framer);
      if (session.forceAborted) {
        try {
          framer.reset?.();
        } catch {
          // Forced process cleanup cannot wait for or retry framer cleanup.
        }
        return;
      }
      session.framer = framer;
      if (session.cancelled) {
        this.#finalizeClosed(session);
        this.#settleNativeOpen(session);
        return;
      }

      const portOptions = serialPortOptions(session.endpoint.config);
      session.port = new this.SerialPort(portOptions);
      session.openInvoked = true;
      session.port.open((reason) => {
        session.openCallbackTask = this.#handleOpenResult(session, reason);
      });
    } catch (reason) {
      if (session.forceAborted) return;
      if (session.cancelled) {
        this.#finalizeClosed(session);
        this.#settleNativeOpen(session);
      } else {
        this.#failOpening(session, mapSerialError(reason, { open: true }));
        this.#settleNativeOpen(session);
      }
    }
  }

  async #handleOpenResult(session, reason) {
    if (session.forceAborted) {
      destroyPort(session.port);
      return;
    }
    if (reason) {
      if (session.cancelled) this.#finalizeClosed(session);
      else this.#failOpening(session, mapSerialError(reason, { open: true }));
      this.#settleNativeOpen(session);
      return;
    }
    if (session.cancelled || this.sessions.get(session.endpointId) !== session) {
      try {
        await this.#beginClose(session);
        this.#settleNativeOpen(session);
      } catch (error) {
        this.#settleNativeOpen(session, error);
      }
      return;
    }
    session.sessionId = `serial-${this.nextSessionId}`;
    this.nextSessionId += 1;
    session.phase = 'open';
    this.#attachPortListeners(session);
    this.#emitStatus(session, 'open', session.sessionId, null);
    this.#settleOpen(session, null, {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: session.sessionId,
    });
    this.#settleNativeOpen(session);
  }

  #attachPortListeners(session) {
    const onData = (chunk) => {
      if (session.phase !== 'open') return;
      const bytes = copyBytes(chunk, 'serial input');
      try {
        session.framer.push(bytes);
      } catch (reason) {
        this.#reportFailure(session, mapSerialError(reason, { open: false }), {
          operation: 'read',
        });
      }
    };
    const onError = (reason) => {
      this.#reportFailure(session, mapSerialError(reason, { open: false }), {
        operation: 'read',
      });
    };
    const onClose = () => {
      if (session.phase === 'closing' || session.failureCycle) {
        this.#finalizeClosed(session);
        return;
      }
      this.#reportFailure(
        session,
        serialError('DEVICE_REMOVED', 'Serial device was removed'),
        { portAlreadyClosed: true },
      );
    };
    session.listeners = { onData, onError, onClose };
    session.port.on('data', onData);
    session.port.on('error', onError);
    session.port.on('close', onClose);
  }

  #failOpening(session, error) {
    if (session.failureCycle || session.terminal) return;
    session.failureCycle = true;
    session.phase = 'error';
    this.#emitStatus(session, 'error', null, plainError(error), 'open');
    this.#settleOpen(session, error);
    this.#finalizeClosed(session);
  }

  #reportFailure(session, error, { operation = 'read', portAlreadyClosed = false } = {}) {
    if (session.failureCycle || session.terminal) return;
    session.failureCycle = true;
    session.phase = 'error';
    this.#emitStatus(session, 'error', session.sessionId, plainError(error), operation);
    this.#flushFramer(session);
    this.#flushFrames(session);
    if (portAlreadyClosed || !session.port?.isOpen) {
      this.#finalizeClosed(session);
      return;
    }
    session.closePromise = this.#beginClose(session);
    session.closePromise.catch(() => {});
  }

  #retainFailedClose(session, error) {
    session.phase = 'error';
    if (!session.failureCycle) {
      session.failureCycle = true;
      if (!session.terminalStatusEmitted) {
        this.#emitStatus(session, 'error', session.sessionId, plainError(error), 'close');
        this.#flushFramer(session);
        this.#flushFrames(session);
      }
    }
    if (!session.port?.isOpen) this.#finalizeClosed(session);
  }

  #beginClose(session, { emitClosing = false } = {}) {
    if (session.closePromise) return session.closePromise;
    if (emitClosing && !session.terminalStatusEmitted) {
      session.phase = 'closing';
      this.#emitStatus(session, 'closing', session.sessionId, null);
      this.#flushFramer(session);
      this.#flushFrames(session);
    }
    const operation = {};
    session.closeOperation = operation;
    session.closePromise = new Promise((resolve, reject) => {
      operation.resolve = resolve;
      operation.reject = reject;
    });
    closePort(session.port).then(
      () => {
        if (session.closeOperation !== operation) return;
        session.closeOperation = null;
        this.#finalizeClosed(session);
        operation.resolve({ endpointId: session.endpointId, closed: true });
      },
      (reason) => {
        if (session.closeOperation !== operation) return;
        session.closeOperation = null;
        session.closePromise = null;
        const error = mapSerialError(reason, { open: false });
        this.#retainFailedClose(session, error);
        operation.reject(error);
      },
    );
    return session.closePromise;
  }

  #forceAbortSession(session) {
    if (session.forceAborted) return;
    session.forceAborted = true;
    session.cancelled = true;
    session.phase = 'closed';
    const cancellation = serialError('OPEN_CANCELLED', 'Serial open cancelled by process shutdown');
    session.cancellationError = plainError(cancellation);
    this.#settleOpen(session, cancellation);
    this.#cleanupSession(session);
    destroyPort(session.port);
    session.terminal = true;
    session.resourceClosed = true;
    const closeOperation = session.closeOperation;
    session.closeOperation = null;
    session.closePromise = null;
    closeOperation?.resolve({ endpointId: session.endpointId, closed: true });
    this.#settleNativeOpen(session);
    if (this.sessions.get(session.endpointId) === session) this.sessions.delete(session.endpointId);
  }

  #requestCancellation(session) {
    if (session.cancelled) return;
    session.cancelled = true;
    session.phase = 'cancelling';
    const error = serialError('OPEN_CANCELLED', 'Serial open cancelled');
    session.cancellationError = plainError(error);
    this.#settleOpen(session, error);
  }

  #finalizeClosed(session) {
    if (session.terminal) return;
    session.terminal = true;
    session.resourceClosed = true;
    session.phase = 'closed';
    this.#cleanupSession(session);
    const terminalError = session.cancelled && !session.failureCycle
      ? session.cancellationError
      : null;
    this.#emitTerminalStatus(session, terminalError);
    if (this.sessions.get(session.endpointId) === session) this.sessions.delete(session.endpointId);
  }

  #emitTerminalStatus(session, error) {
    if (session.terminalStatusEmitted) return;
    session.terminalStatusEmitted = true;
    this.#emitStatus(session, 'closed', null, error);
  }

  #settleOpen(session, error, value) {
    if (session.openSettled) return;
    session.openSettled = true;
    if (error) session.rejectOpen(error);
    else session.resolveOpen(value);
  }

  #settleNativeOpen(session, error) {
    if (session.nativeOpenSettled) return;
    session.nativeOpenSettled = true;
    if (error) session.rejectNativeOpen(error);
    else session.resolveNativeOpen();
  }

  #enqueueFrame(session, direction, value) {
    if (session.terminal) return;
    const bytes = copyBytes(value, 'frame bytes');
    session.pendingFrames.push({ direction, bytes: [...bytes], createdAt: this.clock() });
    if (session.pendingFrames.length >= FRAME_BATCH_LIMIT) {
      this.#flushFrames(session);
      return;
    }
    if (session.frameTimer !== null) return;
    session.frameTimer = this.timers.setTimeout(() => {
      session.frameTimer = null;
      this.#flushFrames(session);
    }, FRAME_BATCH_DELAY_MS);
  }

  #flushFrames(session) {
    if (session.frameTimer !== null) {
      this.timers.clearTimeout(session.frameTimer);
      session.frameTimer = null;
    }
    if (session.pendingFrames.length === 0 || session.sessionId === null) return;
    const frames = session.pendingFrames;
    session.pendingFrames = [];
    this.#publishEvent('transport:frames', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: session.sessionId,
      frames,
    });
  }

  #flushFramer(session) {
    try {
      session.framer?.flush?.();
    } catch {
      // The active failure remains the single reported failure for this cycle.
    }
  }

  #cleanupSession(session) {
    if (session.frameTimer !== null) {
      this.timers.clearTimeout(session.frameTimer);
      session.frameTimer = null;
    }
    if (session.listeners && session.port) {
      session.port.removeListener('data', session.listeners.onData);
      session.port.removeListener('error', session.listeners.onError);
      session.port.removeListener('close', session.listeners.onClose);
      session.listeners = null;
    }
    try {
      session.framer?.reset?.();
    } catch {
      // Cleanup cannot create a second failure cycle.
    }
  }

  #emitStatus(session, status, sessionId, error, operation = null) {
    const createdAt = this.clock();
    this.#publishEvent('transport:status', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId,
      status,
      error,
      createdAt,
      log: serialStatusLog(session, status, error, createdAt, operation),
    });
  }

  #publishEvent(channel, payload) {
    try {
      this.emitEvent(channel, payload);
    } catch (error) {
      try {
        this.reportEventError(error, { channel, payload });
      } catch {
        // Observer reporting is isolated from transport resource ownership.
      }
    }
  }
}

async function createDefaultFramer({ framing, emitFrame, timers }) {
  const config = normalizeFramingConfig(framing);
  const {
    createDelimiterFramer,
    createFixedLengthFramer,
    createIdleTimeoutFramer,
    createRawFramer,
  } = await import('@ineed-linklab/codecs/framers.js');
  switch (config.mode) {
    case 'raw':
      return createRawFramer(emitFrame);
    case 'delimiter':
      return createDelimiterFramer(config.delimiterBytes, emitFrame);
    case 'fixed':
      return createFixedLengthFramer(config.length, emitFrame);
    case 'idle':
      return createIdleTimeoutFramer(config.idleMs, emitFrame, {
        set: (callback, delay) => timers.setTimeout(callback, delay),
        clear: (timer) => timers.clearTimeout(timer),
      });
    default:
      throw new TypeError('framing.mode is invalid');
  }
}

function normalizeFramingConfig(framing) {
  requireExactDataRecord(framing, ['mode'], 'framing', { allowAdditional: true });
  switch (framing.mode) {
    case 'raw':
      requireExactDataRecord(framing, ['mode'], 'raw framing');
      return { mode: 'raw' };
    case 'delimiter': {
      requireExactDataRecord(framing, ['mode', 'delimiterBytes'], 'delimiter framing');
      const delimiterBytes = strictBytes(framing.delimiterBytes, 'framing.delimiterBytes');
      if (delimiterBytes.byteLength === 0) {
        throw new TypeError('framing.delimiterBytes must be nonempty');
      }
      return { mode: 'delimiter', delimiterBytes };
    }
    case 'fixed':
      requireExactDataRecord(framing, ['mode', 'length'], 'fixed framing');
      requirePositiveInteger(framing.length, 'framing.length');
      return { mode: 'fixed', length: framing.length };
    case 'idle':
      requireExactDataRecord(framing, ['mode', 'idleMs'], 'idle framing');
      requirePositiveInteger(framing.idleMs, 'framing.idleMs');
      return { mode: 'idle', idleMs: framing.idleMs };
    default:
      throw new TypeError('framing.mode is invalid');
  }
}

function requireExactDataRecord(value, fields, label, { allowAdditional = false } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || fields.some((field) => !names.includes(field))
    || (!allowAdditional && names.length !== fields.length)
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.some((field) => !Object.hasOwn(descriptors[field], 'value'))) {
    throw new TypeError(`${label} fields must be data properties`);
  }
}

function strictBytes(value, label) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a Uint8Array or byte array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(descriptors);
  if (
    Object.getOwnPropertySymbols(descriptors).length !== 0
    || names.length !== value.length + 1
  ) {
    throw new TypeError(`${label} must be a dense byte array`);
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    const byte = descriptor?.value;
    if (!descriptor?.enumerable || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`${label} contains an invalid byte`);
    }
    bytes[index] = byte;
  }
  return bytes;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function serialPortOptions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('serial endpoint config must be an object');
  }
  const path = requireId(config.path, 'config.path');
  if (!Number.isSafeInteger(config.baudRate) || config.baudRate <= 0) {
    throw new TypeError('config.baudRate must be a positive integer');
  }
  if (!DATA_BITS.has(config.dataBits)) throw new TypeError('config.dataBits is invalid');
  if (!PARITIES.has(config.parity)) throw new TypeError('config.parity is invalid');
  if (!STOP_BITS.has(config.stopBits)) throw new TypeError('config.stopBits is invalid');
  if (!FLOW_CONTROLS.has(config.flowControl)) throw new TypeError('config.flowControl is invalid');
  return {
    path,
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
    autoOpen: false,
    rtscts: config.flowControl === 'hardware',
    xon: config.flowControl === 'software',
    xoff: config.flowControl === 'software',
  };
}

function optionalString(record, field) {
  const value = Object.getOwnPropertyDescriptor(record, field)?.value;
  return typeof value === 'string' ? value : null;
}

function validateFramer(framer) {
  if (!framer || typeof framer.push !== 'function') {
    throw new TypeError('framerFactory must return a framer with push(bytes)');
  }
}

function copyBytes(value, label) {
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
    throw new TypeError(`${label} must be a Uint8Array or byte array`);
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`${label} contains an invalid byte`);
    }
    bytes[index] = byte;
  }
  return bytes;
}

function writeAndDrain(port, bytes) {
  return new Promise((resolve, reject) => {
    port.write(bytes, (writeError) => {
      if (writeError) {
        guardQueuedStreamError(port);
        reject(mapSerialError(writeError, { open: false }));
        return;
      }
      port.drain((drainError) => {
        if (drainError) reject(mapSerialError(drainError, { open: false }));
        else resolve();
      });
    });
  });
}

function guardQueuedStreamError(port) {
  const ignoreDuplicate = () => {};
  port.once('error', ignoreDuplicate);
  setImmediate(() => port.removeListener('error', ignoreDuplicate));
}

function closePort(port) {
  return new Promise((resolve, reject) => {
    if (!port?.isOpen) {
      resolve();
      return;
    }
    port.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroyPort(port) {
  if (typeof port?.destroy !== 'function') return;
  try {
    port.destroy();
  } catch {
    // Process-exit cleanup cannot wait for or retry a native destroy operation.
  }
}

function mapSerialError(reason, { open, platform = process.platform }) {
  if (reason?.code && SERIAL_ERROR_CODES.has(reason.code)) {
    return serialError(reason.code, errorMessage(reason));
  }
  const code = String(reason?.code ?? '').toUpperCase();
  const message = errorMessage(reason);
  if (code === 'ENOENT' || /not found|cannot find/i.test(message)) {
    return serialError('PORT_NOT_FOUND', message);
  }
  if (code === 'EBUSY' || /busy|resource.*used|already open/i.test(message)) {
    return serialError('PORT_BUSY', message);
  }
  if (code === 'EACCES' || code === 'EPERM' || /permission|access denied/i.test(message)) {
    return serialError('PERMISSION_DENIED', message);
  }
  if (!open && (
    (code === 'EIO' && platform !== 'win32')
    || code === 'ENODEV'
    || code === 'ENXIO'
    || /disconnected|device.*removed/i.test(message)
  )) {
    return serialError('DEVICE_REMOVED', message);
  }
  return serialError('IO_ERROR', message);
}

function errorMessage(reason) {
  if (typeof reason?.message === 'string' && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'Serial operation failed';
}

function serialError(code, message) {
  const error = new Error(message);
  error.name = 'SerialError';
  error.code = code;
  return error;
}

function plainError(error) {
  return { code: error.code, message: error.message };
}

function serialStatusLog(session, status, error, createdAt, operation) {
  if (status === 'closed' && (session.failureCycle || error !== null)) return null;
  const path = session.endpoint.config?.path;
  const base = {
    source: 'serial',
    code: null,
    details: { path },
    createdAt,
  };
  if (status === 'opening') {
    return { ...base, level: 'debug', message: `正在打开串口: ${path}` };
  }
  if (status === 'open') {
    return { ...base, level: 'info', message: `串口已打开: ${path}` };
  }
  if (status === 'closing') {
    return { ...base, level: 'debug', message: `正在关闭串口: ${path}` };
  }
  if (status === 'closed') {
    return { ...base, level: 'info', message: `串口已关闭: ${path}` };
  }
  if (status !== 'error') return null;
  if (error?.code === 'DEVICE_REMOVED') {
    return {
      ...base,
      level: 'warn',
      code: error.code,
      message: `串口意外断开: ${path}`,
    };
  }
  const intent = {
    open: '打开串口失败',
    read: '读取串口失败',
    write: '写入串口失败',
    close: '关闭串口失败',
  }[operation] ?? '串口操作失败';
  return {
    ...base,
    level: 'error',
    code: error?.code ?? null,
    message: `${intent}: ${path}`,
  };
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a nonblank string`);
  }
  return value;
}

module.exports = { SerialService, mapSerialError, serialPortOptions };
