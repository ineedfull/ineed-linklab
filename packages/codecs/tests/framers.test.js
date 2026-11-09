import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createDelimiterFramer,
  createFixedLengthFramer,
  createIdleTimeoutFramer,
  createRawFramer,
} from '../src/framers.js';

test('raw framer emits a fresh copy for every nonempty push', () => {
  const emitted = [];
  const framer = createRawFramer((bytes) => emitted.push(bytes));
  const input = Uint8Array.of(1, 2);

  assertFramerSurface(framer);
  framer.push(input);
  framer.push(Uint8Array.of(3));
  input[0] = 9;

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1, 2], [3]]);
  assert.notEqual(emitted[0], input);
});

test('raw framer ignores zero-byte pushes and flush and reset are no-ops', () => {
  const emitted = [];
  const framer = createRawFramer((bytes) => emitted.push(bytes));

  framer.push(new Uint8Array());
  framer.flush();
  framer.reset();
  assert.deepEqual(emitted, []);
});

test('raw framer copies Buffer input without preserving its aliasing slice behavior', () => {
  const emitted = [];
  const framer = createRawFramer((bytes) => emitted.push(bytes));
  const input = Buffer.from([1, 2]);

  framer.push(input);
  input[0] = 9;

  assert.deepEqual([...emitted[0]], [1, 2]);
  assert.equal(Buffer.isBuffer(emitted[0]), false);

  emitted[0][1] = 8;
  assert.deepEqual([...input], [9, 2]);
});

test('delimiter framer handles split delimiters, multiple frames, and fresh copies', () => {
  const emitted = [];
  const framer = createDelimiterFramer(Uint8Array.of(0xaa, 0xbb), (bytes) => emitted.push(bytes));
  const first = Uint8Array.of(1, 0xaa);

  framer.push(first);
  first[0] = 9;
  framer.push(Uint8Array.of(0xbb, 2, 0xaa, 0xbb, 3));

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1], [2]]);
});

test('delimiter framer emits empty frames between consecutive delimiters', () => {
  const emitted = [];
  const framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => emitted.push(bytes));

  framer.push(Uint8Array.of(0, 0, 1, 0));

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[], [], [1]]);
  assert.notEqual(emitted[0], emitted[1]);
});

test('LF delimiter preserves CR in CRLF input as payload', () => {
  const emitted = [];
  const framer = createDelimiterFramer(Uint8Array.of(0x0a), (bytes) => emitted.push(bytes));

  framer.push(new TextEncoder().encode('one\r\ntwo\n'));

  assert.deepEqual(emitted.map((bytes) => new TextDecoder().decode(bytes)), ['one\r', 'two']);
});

test('delimiter flush emits an incomplete remainder once while zero push does nothing', () => {
  const emitted = [];
  const framer = createDelimiterFramer(Uint8Array.of(0x0a), (bytes) => emitted.push(bytes));

  framer.push(new Uint8Array());
  framer.push(Uint8Array.of(1, 2));
  framer.flush();
  framer.flush();

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1, 2]]);
});

test('delimiter framer preserves a remainder after emitting a complete frame', () => {
  const emitted = [];
  const framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => emitted.push(bytes));

  framer.push(Uint8Array.of(1, 0, 2, 3));
  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1]]);

  framer.flush();
  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1], [2, 3]]);
});

test('delimiter reset drops incomplete bytes and delimiter input cannot be aliased', () => {
  const emitted = [];
  const delimiter = Uint8Array.of(0xff);
  const framer = createDelimiterFramer(delimiter, (bytes) => emitted.push(bytes));

  delimiter[0] = 0;
  framer.push(Uint8Array.of(1));
  framer.reset();
  framer.push(Uint8Array.of(2, 0xff));

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[2]]);
});

test('delimiter framer copies Buffer delimiters and Buffer pushes before queuing', () => {
  const emitted = [];
  const delimiter = Buffer.from([0xff]);
  const framer = createDelimiterFramer(delimiter, (bytes) => emitted.push(bytes));
  const input = Buffer.from([1, 0xff, 2]);

  delimiter[0] = 0;
  framer.push(input);
  input.fill(9);

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1]]);
  emitted[0][0] = 8;
  framer.flush();
  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[8], [2]]);
});

test('delimiter framer commits delivered bytes before a throwing emit callback', () => {
  const emitted = [];
  let shouldThrow = true;
  const framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => {
    emitted.push([...bytes]);
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('stop delivery');
    }
  });

  assert.throws(() => framer.push(Uint8Array.of(1, 0, 2)), /stop delivery/);
  framer.flush();

  assert.deepEqual(emitted, [[1], [2]]);
});

test('delimiter flush preserves complete frames and recovers after another emit failure', () => {
  const emitted = [];
  let throwsRemaining = 2;
  const framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => {
    emitted.push([...bytes]);
    if (throwsRemaining > 0) {
      throwsRemaining -= 1;
      throw new Error('stop delivery');
    }
  });

  assert.throws(() => framer.push(Uint8Array.of(1, 0, 2, 0, 3)), /stop delivery/);
  assert.throws(() => framer.flush(), /stop delivery/);
  framer.flush();

  assert.deepEqual(emitted, [[1], [2], [3]]);
});

test('delimiter framer commits delivered bytes before a reentrant push', () => {
  const emitted = [];
  let reentered = false;
  let framer;
  framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => {
    emitted.push([...bytes]);
    if (!reentered) {
      reentered = true;
      framer.push(Uint8Array.of(2, 0));
    }
  });

  framer.push(Uint8Array.of(1, 0));

  assert.deepEqual(emitted, [[1], [2]]);
});

test('delimiter framer preserves queued remainder order during a reentrant push', () => {
  const emitted = [];
  let reentered = false;
  let framer;
  framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => {
    emitted.push([...bytes]);
    if (!reentered) {
      reentered = true;
      framer.push(Uint8Array.of(4, 0));
    }
  });

  framer.push(Uint8Array.of(1, 0, 2, 0, 3));

  assert.deepEqual(emitted, [[1], [2], [3, 4]]);
});

test('delimiter framer preserves ordinary and large remainders during reentrant pushes', () => {
  for (const remainderLength of [3, 4096]) {
    const frameLength = remainderLength + 16;
    const input = new Uint8Array(frameLength + 1 + remainderLength);
    input.fill(1, 0, frameLength);
    input[frameLength] = 0;
    input.fill(2, frameLength + 1);
    const emitted = [];
    let reentered = false;
    let framer;
    framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => {
      emitted.push({
        length: bytes.byteLength,
        first: bytes[0],
        last: bytes[bytes.byteLength - 1],
      });
      if (!reentered) {
        reentered = true;
        framer.push(Uint8Array.of(3, 0));
      }
    });

    framer.push(input);

    assert.deepEqual(emitted, [
      { length: frameLength, first: 1, last: 1 },
      { length: remainderLength + 1, first: 2, last: 3 },
    ]);
  }
});

test('delimiter framer incrementally matches overlapping prefixes across chunks', () => {
  const encoder = new TextEncoder();
  const delimiter = encoder.encode('abab');
  const payload = encoder.encode('aba'.repeat(512));
  const blockLength = payload.byteLength + delimiter.byteLength;
  const input = new Uint8Array(blockLength * 2);
  input.set(payload);
  input.set(delimiter, payload.byteLength);
  input.set(payload, blockLength);
  input.set(delimiter, blockLength + payload.byteLength);
  const emitted = [];
  const framer = createDelimiterFramer(delimiter, (bytes) => emitted.push(bytes));

  for (const byte of input) framer.push(Uint8Array.of(byte));

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[...payload], [...payload]]);
});

test('delimiter framer handles long partial-prefix fallback without rescanning chunks', () => {
  const delimiter = Uint8Array.of(0x61, 0x61, 0x61, 0x61, 0x61, 0x62);
  const payloadLength = 4096;
  const blockLength = payloadLength + delimiter.byteLength;
  const input = new Uint8Array(blockLength * 2);
  input.fill(0x61);
  input[payloadLength + delimiter.byteLength - 1] = 0x62;
  input[input.byteLength - 1] = 0x62;
  const emitted = [];
  const framer = createDelimiterFramer(delimiter, (bytes) => emitted.push(bytes));

  for (const byte of input) framer.push(Uint8Array.of(byte));

  assert.deepEqual(emitted.map((bytes) => bytes.byteLength), [payloadLength, payloadLength]);
  assert.ok(emitted.every((bytes) => bytes.every((byte) => byte === 0x61)));
});

test('delimiter framer keeps copied bytes linear across single-byte pushes', () => {
  const inputLength = 20_000;
  const framer = createDelimiterFramer(Uint8Array.of(0), () => {});

  const copiedBytes = countSetBytes(() => {
    for (let index = 0; index < inputLength; index += 1) {
      framer.push(Uint8Array.of(1));
    }
  });

  assert.ok(copiedBytes <= inputLength * 4, `copied ${copiedBytes} bytes`);
});

test('delimiter framer keeps copied bytes linear for a large multi-frame push', () => {
  const frameCount = 2000;
  const input = new Uint8Array(frameCount * 2);
  for (let index = 0; index < frameCount; index += 1) {
    input[index * 2] = 1;
    input[index * 2 + 1] = 0;
  }
  let emitted = 0;
  const framer = createDelimiterFramer(Uint8Array.of(0), () => { emitted += 1; });

  let setBytes = 0;
  const sliceBytes = countSliceBytes(() => {
    setBytes = countSetBytes(() => framer.push(input));
  });

  assert.equal(emitted, frameCount);
  assert.ok(sliceBytes <= input.byteLength * 2, `slice copied ${sliceBytes} bytes`);
  assert.ok(setBytes <= input.byteLength * 2, `set copied ${setBytes} bytes`);
});

test('delimiter framer releases its backing buffer after a complete drain', () => {
  const frameLength = 1024 * 1024 - 1;
  const [probe] = runDelimiterMemoryProbe(frameLength);

  assert.deepEqual(probe.emitted, [{ length: frameLength, first: 1 }]);
  assert.ok(
    probe.retainedBytes <= 64 * 1024,
    `drained framer retained ${probe.retainedBytes} array-buffer bytes`,
  );
});

test('delimiter framer compacts a sparse remainder after a large frame', () => {
  const frameLength = 1024 * 1024 - 1;
  const samples = runDelimiterMemoryProbe(frameLength, { remainderByte: 2, repetitions: 3 });

  for (const sample of samples) {
    assert.deepEqual(sample.emitted, [
      { length: frameLength, first: 1 },
      { length: 1, first: 2 },
    ]);
    assert.ok(
      sample.retainedBytes <= 64 * 1024,
      `sparse framer retained ${sample.retainedBytes} array-buffer bytes`,
    );
  }
});

test('fixed-length framer emits exact chunks and retains split remainders', () => {
  const emitted = [];
  const framer = createFixedLengthFramer(3, (bytes) => emitted.push(bytes));
  const input = Uint8Array.of(1, 2, 3, 4);

  framer.push(input);
  input.fill(9);
  framer.push(Uint8Array.of(5, 6, 7, 8));

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1, 2, 3], [4, 5, 6]]);
});

test('fixed-length flush emits the short remainder once and reset drops it', () => {
  const emitted = [];
  const framer = createFixedLengthFramer(3, (bytes) => emitted.push(bytes));

  framer.push(new Uint8Array());
  framer.push(Uint8Array.of(1, 2));
  framer.flush();
  framer.flush();
  framer.push(Uint8Array.of(3));
  framer.reset();
  framer.flush();

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1, 2]]);
});

test('fixed-length framer isolates queued and emitted bytes from Buffer mutation', () => {
  const emitted = [];
  const framer = createFixedLengthFramer(3, (bytes) => emitted.push(bytes));
  const first = Buffer.from([1, 2]);
  const second = Buffer.from([3, 4]);

  framer.push(first);
  first.fill(9);
  framer.push(second);
  second.fill(8);

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1, 2, 3]]);
  emitted[0].fill(7);
  framer.flush();
  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[7, 7, 7], [4]]);
});

test('fixed-length framer commits delivered bytes before a throwing emit callback', () => {
  const emitted = [];
  let shouldThrow = true;
  const framer = createFixedLengthFramer(2, (bytes) => {
    emitted.push([...bytes]);
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('stop delivery');
    }
  });

  assert.throws(() => framer.push(Uint8Array.of(1, 2, 3)), /stop delivery/);
  framer.flush();

  assert.deepEqual(emitted, [[1, 2], [3]]);
});

test('fixed-length flush preserves complete frames and recovers after another emit failure', () => {
  const emitted = [];
  let throwsRemaining = 2;
  const framer = createFixedLengthFramer(2, (bytes) => {
    emitted.push([...bytes]);
    if (throwsRemaining > 0) {
      throwsRemaining -= 1;
      throw new Error('stop delivery');
    }
  });

  assert.throws(() => framer.push(Uint8Array.of(1, 2, 3, 4, 5)), /stop delivery/);
  assert.throws(() => framer.flush(), /stop delivery/);
  framer.flush();

  assert.deepEqual(emitted, [[1, 2], [3, 4], [5]]);
});

test('fixed-length framer commits delivered bytes before a reentrant push', () => {
  const emitted = [];
  let reentered = false;
  let framer;
  framer = createFixedLengthFramer(2, (bytes) => {
    emitted.push([...bytes]);
    if (!reentered) {
      reentered = true;
      framer.push(Uint8Array.of(3, 4));
    }
  });

  framer.push(Uint8Array.of(1, 2));

  assert.deepEqual(emitted, [[1, 2], [3, 4]]);
});

test('fixed-length framer keeps copied bytes linear for a large multi-frame push', () => {
  const frameCount = 2000;
  const input = new Uint8Array(frameCount);
  input.fill(1);
  let emitted = 0;
  const framer = createFixedLengthFramer(1, () => { emitted += 1; });

  const copiedBytes = countSliceBytes(() => framer.push(input));

  assert.equal(emitted, frameCount);
  assert.ok(copiedBytes <= input.byteLength * 2, `copied ${copiedBytes} bytes`);
});

test('idle-timeout framer resets its timer and emits accumulated bytes on timeout', () => {
  const emitted = [];
  const scheduler = createScheduler();
  const framer = createIdleTimeoutFramer(50, (bytes) => emitted.push(bytes), scheduler);
  const input = Uint8Array.of(1);

  framer.push(input);
  const firstTimer = scheduler.scheduled[0];
  framer.push(Uint8Array.of(2));
  input[0] = 9;

  assert.deepEqual(scheduler.cleared, [firstTimer.id]);
  assert.equal(scheduler.scheduled[1].delay, 50);
  scheduler.scheduled[1].callback();
  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[1, 2]]);
});

test('idle-timeout flush emits immediately and clears the timer', () => {
  const emitted = [];
  const scheduler = createScheduler();
  const framer = createIdleTimeoutFramer(10, (bytes) => emitted.push(bytes), scheduler);

  framer.push(Uint8Array.of(4));
  framer.flush();
  framer.flush();

  assert.deepEqual(emitted.map((bytes) => [...bytes]), [[4]]);
  assert.deepEqual(scheduler.cleared, [scheduler.scheduled[0].id]);
});

test('idle-timeout reset drops pending bytes and zero push schedules nothing', () => {
  const emitted = [];
  const scheduler = createScheduler();
  const framer = createIdleTimeoutFramer(10, (bytes) => emitted.push(bytes), scheduler);

  framer.push(new Uint8Array());
  assert.equal(scheduler.scheduled.length, 0);
  framer.push(Uint8Array.of(4));
  framer.reset();
  scheduler.scheduled[0].callback();

  assert.deepEqual(emitted, []);
  assert.deepEqual(scheduler.cleared, [scheduler.scheduled[0].id]);
});

test('idle-timeout framer isolates queued and emitted bytes from Buffer mutation', () => {
  const emitted = [];
  const scheduler = createScheduler();
  const framer = createIdleTimeoutFramer(10, (bytes) => emitted.push(bytes), scheduler);
  const input = Buffer.from([1, 2]);

  framer.push(input);
  input.fill(9);
  scheduler.scheduled[0].callback();

  assert.deepEqual([...emitted[0]], [1, 2]);
  emitted[0].fill(8);
  assert.deepEqual([...input], [9, 9]);
});

test('framers reject invalid construction arguments', () => {
  assert.throws(() => createRawFramer(null), /emit/i);
  assert.throws(() => createDelimiterFramer([], () => {}), /delimiterBytes.*Uint8Array/i);
  assert.throws(() => createDelimiterFramer(new Uint8Array(), () => {}), /nonempty/i);
  assert.throws(() => createFixedLengthFramer(0, () => {}), /positive integer/i);
  assert.throws(() => createFixedLengthFramer(1.5, () => {}), /positive integer/i);
  assert.throws(() => createIdleTimeoutFramer(0, () => {}, createScheduler()), /positive integer/i);
  assert.throws(() => createIdleTimeoutFramer(1, () => {}, {}), /scheduler/i);
});

test('every framer rejects non-Uint8Array pushes', () => {
  const scheduler = createScheduler();
  const framers = [
    createRawFramer(() => {}),
    createDelimiterFramer(Uint8Array.of(0), () => {}),
    createFixedLengthFramer(1, () => {}),
    createIdleTimeoutFramer(1, () => {}, scheduler),
  ];

  for (const framer of framers) {
    assert.throws(() => framer.push([1]), /Uint8Array/);
  }
});

function assertFramerSurface(framer) {
  assert.deepEqual(Object.keys(framer).sort(), ['flush', 'push', 'reset']);
  assert.equal(typeof framer.push, 'function');
  assert.equal(typeof framer.flush, 'function');
  assert.equal(typeof framer.reset, 'function');
}

function countSliceBytes(operation) {
  const originalSlice = Uint8Array.prototype.slice;
  let copiedBytes = 0;
  Uint8Array.prototype.slice = function (...args) {
    const result = Reflect.apply(originalSlice, this, args);
    copiedBytes += result.byteLength;
    return result;
  };

  try {
    operation();
  } finally {
    Uint8Array.prototype.slice = originalSlice;
  }
  return copiedBytes;
}

function countSetBytes(operation) {
  const originalSet = Uint8Array.prototype.set;
  let copiedBytes = 0;
  Uint8Array.prototype.set = function (...args) {
    copiedBytes += args[0].byteLength;
    return Reflect.apply(originalSet, this, args);
  };

  try {
    operation();
  } finally {
    Uint8Array.prototype.set = originalSet;
  }
  return copiedBytes;
}

function runDelimiterMemoryProbe(
  frameLength,
  { remainderByte = null, repetitions = 1 } = {},
) {
  const moduleUrl = new URL('../src/framers.js', import.meta.url).href;
  const script = `
    import { createDelimiterFramer } from ${JSON.stringify(moduleUrl)};

    const collect = () => {
      for (let index = 0; index < 8; index += 1) global.gc();
    };

    const samples = [];
    for (let repetition = 0; repetition < ${repetitions}; repetition += 1) {
      collect();
      const before = process.memoryUsage().arrayBuffers;
      const emitted = [];
      const framer = createDelimiterFramer(Uint8Array.of(0), (frame) => {
        emitted.push({ length: frame.byteLength, first: frame[0] });
      });
      const hasRemainder = ${remainderByte !== null};
      let input = new Uint8Array(${frameLength} + 1 + Number(hasRemainder));
      input.fill(1);
      input[${frameLength}] = 0;
      if (hasRemainder) input[${frameLength} + 1] = ${remainderByte};
      framer.push(input);
      input = null;
      collect();
      const after = process.memoryUsage().arrayBuffers;
      framer.flush();
      samples.push({
        before,
        after,
        retainedBytes: after - before,
        emitted,
      });
    }
    console.log(JSON.stringify(samples));
  `;
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--input-type=module', '--eval', script],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function createScheduler() {
  let nextId = 0;
  const scheduled = [];
  const cleared = [];

  return {
    scheduled,
    cleared,
    set(callback, delay) {
      const timer = { id: nextId, callback, delay };
      nextId += 1;
      scheduled.push(timer);
      return timer.id;
    },
    clear(id) {
      cleared.push(id);
    },
  };
}

const PENDING_FRAME_LIMIT = 1024 * 1024;

for (const mode of ['delimiter', 'idle']) {
  test(`${mode} framer rejects a continuous unfinished frame beyond 1 MiB and releases it`, () => {
    const emitted = [];
    const tasks = new Map();
    const scheduler = {
      set(callback) { const id = {}; tasks.set(id, callback); return id; },
      clear(id) { tasks.delete(id); },
    };
    const framer = mode === 'delimiter'
      ? createDelimiterFramer(Uint8Array.of(0), (bytes) => emitted.push(bytes))
      : createIdleTimeoutFramer(50, (bytes) => emitted.push(bytes), scheduler);
    for (let n = 0; n < 128; n += 1) framer.push(new Uint8Array(8192).fill(1));
    assert.throws(() => framer.push(Uint8Array.of(1)), /pending.*1048576.*bytes/i);
    framer.flush();
    assert.equal(emitted.length, 0);
    assert.equal(tasks.size, 0);
    framer.push(mode === 'delimiter' ? Uint8Array.of(2, 0) : Uint8Array.of(2));
    framer.flush();
    assert.deepEqual(emitted.map((bytes) => [...bytes]), [[2]]);
  });
}

test('delimiter framer accepts an encoded frame exactly at the bound with a split delimiter', () => {
  const emitted = [];
  const framer = createDelimiterFramer(Uint8Array.of(0, 0), (bytes) => emitted.push(bytes));
  framer.push(new Uint8Array(PENDING_FRAME_LIMIT - 2).fill(1));
  framer.push(Uint8Array.of(0));
  framer.push(Uint8Array.of(0));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].length, PENDING_FRAME_LIMIT - 2);
});

test('idle framer accepts exactly 1 MiB when the timeout completes the frame', () => {
  const emitted = [];
  let callback;
  const framer = createIdleTimeoutFramer(50, (bytes) => emitted.push(bytes), {
    set(task) { callback = task; return 1; }, clear() {},
  });
  framer.push(new Uint8Array(PENDING_FRAME_LIMIT).fill(1));
  callback();
  assert.equal(emitted[0].length, PENDING_FRAME_LIMIT);
});

test('delimiter framer accepts one chunk of many completed frames exceeding the pending bound', () => {
  let frames = 0;
  const framer = createDelimiterFramer(Uint8Array.of(0), (bytes) => {
    assert.equal(bytes.length, 8191);
    frames += 1;
  });
  const chunk = new Uint8Array(PENDING_FRAME_LIMIT * 2).fill(1);
  for (let n = 8191; n < chunk.length; n += 8192) chunk[n] = 0;
  framer.push(chunk);
  assert.equal(frames, 256);
});
