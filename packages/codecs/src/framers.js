export const MAX_PENDING_FRAME_BYTES = 1024 * 1024;

export function createRawFramer(emit) {
  validateEmit(emit);

  return createSurface(
    (bytes) => {
      if (bytes.byteLength > 0) emit(bytes);
    },
    () => {},
    () => {},
  );
}

export function createDelimiterFramer(delimiterBytes, emit) {
  if (!(delimiterBytes instanceof Uint8Array)) {
    throw new TypeError('delimiterBytes must be a Uint8Array');
  }
  if (delimiterBytes.byteLength === 0) {
    throw new TypeError('delimiterBytes must be nonempty');
  }
  validateEmit(emit);

  const delimiter = new Uint8Array(delimiterBytes);
  const prefixTable = buildPrefixTable(delimiter);
  let buffer = new Uint8Array();
  let pendingStart = 0;
  let pendingEnd = 0;
  let scanIndex = 0;
  let matchedLength = 0;

  function clearPending() {
    buffer = new Uint8Array();
    pendingStart = 0;
    pendingEnd = 0;
    scanIndex = 0;
    matchedLength = 0;
  }

  function append(bytes) {
    if (pendingStart === pendingEnd) {
      pendingStart = 0;
      pendingEnd = 0;
      scanIndex = 0;
      matchedLength = 0;
    }

    if (buffer.byteLength - pendingEnd < bytes.byteLength) {
      const pendingLength = pendingEnd - pendingStart;
      if (pendingStart >= buffer.byteLength / 2
        && pendingLength + bytes.byteLength <= buffer.byteLength) {
        buffer.copyWithin(0, pendingStart, pendingEnd);
        scanIndex -= pendingStart;
        pendingStart = 0;
        pendingEnd = pendingLength;
      } else {
        const capacity = Math.min(MAX_PENDING_FRAME_BYTES, Math.max(
          16,
          pendingLength + bytes.byteLength,
          buffer.byteLength * 2,
        ));
        const expanded = new Uint8Array(capacity);
        expanded.set(buffer.subarray(pendingStart, pendingEnd));
        buffer = expanded;
        scanIndex -= pendingStart;
        pendingStart = 0;
        pendingEnd = pendingLength;
      }
    }

    buffer.set(bytes, pendingEnd);
    pendingEnd += bytes.byteLength;
  }

  function commitConsumedBytes() {
    if (pendingStart === pendingEnd) {
      clearPending();
      return;
    }
    if (pendingStart < buffer.byteLength / 2) return;

    const pendingLength = pendingEnd - pendingStart;
    const compacted = new Uint8Array(pendingLength);
    compacted.set(buffer.subarray(pendingStart, pendingEnd));
    buffer = compacted;
    pendingStart = 0;
    pendingEnd = pendingLength;
    scanIndex = 0;
  }

  function drainCompleteFrames() {
    while (scanIndex < pendingEnd) {
      const byte = buffer[scanIndex];
      while (matchedLength > 0 && byte !== delimiter[matchedLength]) {
        matchedLength = prefixTable[matchedLength - 1];
      }
      if (byte === delimiter[matchedLength]) matchedLength += 1;
      scanIndex += 1;

      if (matchedLength === delimiter.byteLength) {
        const frameEnd = scanIndex - delimiter.byteLength;
        const frame = buffer.slice(pendingStart, frameEnd);
        pendingStart = scanIndex;
        matchedLength = 0;
        commitConsumedBytes();
        emit(frame);
      }
    }
  }

  return createSurface(
    (bytes) => {
      if (bytes.byteLength === 0) return;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const available = MAX_PENDING_FRAME_BYTES - (pendingEnd - pendingStart);
        if (available === 0) {
          clearPending();
          throw pendingFrameOverflow();
        }
        const end = Math.min(bytes.byteLength, offset + available);
        append(bytes.subarray(offset, end));
        drainCompleteFrames();
        offset = end;
      }
    },
    () => {
      drainCompleteFrames();
      if (pendingStart === pendingEnd) {
        clearPending();
        return;
      }
      const frame = buffer.slice(pendingStart, pendingEnd);
      clearPending();
      emit(frame);
    },
    clearPending,
  );
}

export function createFixedLengthFramer(length, emit) {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new TypeError('length must be a positive integer');
  }
  validateEmit(emit);

  let pending = new Uint8Array();

  function drainCompleteFrames() {
    while (pending.byteLength >= length) {
      const frame = pending.slice(0, length);
      pending = pending.subarray(length);
      try {
        emit(frame);
      } catch (error) {
        pending = compactView(pending);
        throw error;
      }
    }
    pending = compactView(pending);
  }

  return createSurface(
    (bytes) => {
      if (bytes.byteLength === 0) return;
      pending = concatenate(pending, bytes);
      drainCompleteFrames();
    },
    () => {
      drainCompleteFrames();
      if (pending.byteLength === 0) return;
      const frame = pending.slice();
      pending = new Uint8Array();
      emit(frame);
    },
    () => {
      pending = new Uint8Array();
    },
  );
}

export function createIdleTimeoutFramer(idleMs, emit, scheduler = defaultScheduler) {
  if (!Number.isSafeInteger(idleMs) || idleMs <= 0) {
    throw new TypeError('idleMs must be a positive integer');
  }
  validateEmit(emit);
  if (scheduler === null || typeof scheduler !== 'object'
    || typeof scheduler.set !== 'function' || typeof scheduler.clear !== 'function') {
    throw new TypeError('scheduler must provide set and clear functions');
  }

  let pending = new Uint8Array();
  let timer = null;

  function clearTimer() {
    if (timer === null) return;
    const current = timer;
    timer = null;
    scheduler.clear(current);
  }

  function flush() {
    clearTimer();
    if (pending.byteLength === 0) return;
    const frame = pending.slice();
    pending = new Uint8Array();
    emit(frame);
  }

  function scheduleFlush() {
    clearTimer();
    const scheduledTimer = scheduler.set(() => {
      if (timer !== scheduledTimer) return;
      timer = null;
      if (pending.byteLength === 0) return;
      const frame = pending.slice();
      pending = new Uint8Array();
      emit(frame);
    }, idleMs);
    timer = scheduledTimer;
  }

  return createSurface(
    (bytes) => {
      if (bytes.byteLength === 0) return;
      if (bytes.byteLength > MAX_PENDING_FRAME_BYTES - pending.byteLength) {
        clearTimer();
        pending = new Uint8Array();
        throw pendingFrameOverflow();
      }
      pending = concatenate(pending, bytes);
      scheduleFlush();
    },
    flush,
    () => {
      clearTimer();
      pending = new Uint8Array();
    },
  );
}

const defaultScheduler = {
  set(callback, delay) {
    return globalThis.setTimeout(callback, delay);
  },
  clear(timer) {
    globalThis.clearTimeout(timer);
  },
};

function createSurface(push, flush, reset) {
  return {
    push(bytes) {
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('push bytes must be a Uint8Array');
      }
      push(new Uint8Array(bytes));
    },
    flush,
    reset,
  };
}

function validateEmit(emit) {
  if (typeof emit !== 'function') throw new TypeError('emit must be a function');
}

function concatenate(first, second) {
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first);
  combined.set(second, first.byteLength);
  return combined;
}

function compactView(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
  return new Uint8Array(bytes);
}

function buildPrefixTable(delimiter) {
  const prefixTable = new Uint32Array(delimiter.byteLength);
  let matchedLength = 0;

  for (let index = 1; index < delimiter.byteLength; index += 1) {
    while (matchedLength > 0 && delimiter[index] !== delimiter[matchedLength]) {
      matchedLength = prefixTable[matchedLength - 1];
    }
    if (delimiter[index] === delimiter[matchedLength]) {
      matchedLength += 1;
    }
    prefixTable[index] = matchedLength;
  }

  return prefixTable;
}

function pendingFrameOverflow() {
  const error = new Error(`Receive pending frame exceeds ${MAX_PENDING_FRAME_BYTES} bytes; connection must be reopened`);
  error.code = 'IO_ERROR';
  return error;
}
