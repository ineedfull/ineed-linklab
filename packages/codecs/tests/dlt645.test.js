import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDlt645ErrorResponse,
  buildDlt645Frame,
  buildDlt645ReadRequest,
  buildDlt645ReadResponse,
  decodeDlt645Bcd,
  encodeDlt645Bcd,
  extractDlt645Frames,
  formatDlt645Hex,
  parseDlt645Frame,
} from '../src/dlt645.js';

test('builds the documented DL/T 645-2007 read frame with wake-up bytes', () => {
  const frame = buildDlt645ReadRequest({
    address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4,
  });

  assert.equal(
    formatDlt645Hex(frame),
    'FE FE FE FE 68 12 90 78 56 34 12 68 11 04 33 34 34 35 6B 16',
  );
});

test('parses a normal response and exposes protocol flags and frame segments', () => {
  const response = buildDlt645Frame({
    address: '123456789012', control: 0x91,
    data: [0x00, 0x01, 0x01, 0x02, 0x34, 0x22], wakeUpBytes: 2,
  });
  const parsed = parseDlt645Frame(response);

  assert.equal(parsed.address, '123456789012');
  assert.equal(parsed.response, true);
  assert.equal(parsed.abnormal, false);
  assert.equal(parsed.functionCode, 0x11);
  assert.equal(parsed.dataIdentifier, '02010100');
  assert.deepEqual([...parsed.valueBytes], [0x34, 0x22]);
  assert.deepEqual(parsed.segments.map(({ key }) => key), [
    'wake', 'start1', 'address', 'start2', 'control', 'length', 'data', 'checksum', 'end',
  ]);
});

test('rejects bad checksums and decodes abnormal response flags', () => {
  const abnormal = buildDlt645Frame({ address: '000000000001', control: 0xd1, data: [0x06] });
  assert.deepEqual(parseDlt645Frame(abnormal).errorFlags, ['无请求数据', '密码错误或未授权']);

  abnormal[abnormal.length - 2] ^= 0xff;
  assert.throws(() => parseDlt645Frame(abnormal), { code: 'CHECKSUM_MISMATCH' });
});

test('extracts concatenated frames while retaining an incomplete tail', () => {
  const first = buildDlt645ReadRequest({ address: '000000000001', dataIdentifier: '00000000' });
  const second = buildDlt645ReadRequest({ address: '000000000002', dataIdentifier: '02010100' });
  const stream = Uint8Array.of(0x55, ...first, ...second.slice(0, -3));
  const result = extractDlt645Frames(stream);

  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].address, '000000000001');
  assert.deepEqual([...result.remainder], [...second.slice(0, -3)]);
});

test('decodes low-byte-first packed BCD values with scale', () => {
  assert.equal(decodeDlt645Bcd([0x34, 0x12], 1), 123.4);
  assert.equal(decodeDlt645Bcd([0x34, 0x92], 1, { signed: true }), -123.4);
  assert.equal(decodeDlt645Bcd([0xfa], 0), null);
});

test('builds and parses normal meter read responses from business values', () => {
  const bytes = buildDlt645ReadResponse({
    address: '123456789012',
    dataIdentifier: '02010100',
    value: 230.1,
    decimals: 1,
    byteLength: 2,
  });
  const parsed = parseDlt645Frame(bytes);

  assert.equal(parsed.control, 0x91);
  assert.equal(parsed.response, true);
  assert.equal(parsed.abnormal, false);
  assert.equal(parsed.address, '123456789012');
  assert.equal(parsed.dataIdentifier, '02010100');
  assert.deepEqual([...parsed.valueBytes], [0x01, 0x23]);
  assert.equal(decodeDlt645Bcd(parsed.valueBytes, 1), 230.1);
});

test('encodes signed BCD and builds missing-data abnormal responses', () => {
  const signed = encodeDlt645Bcd(-1.2345, 4, 3, { signed: true });
  assert.equal(decodeDlt645Bcd(signed, 4, { signed: true }), -1.2345);

  const parsed = parseDlt645Frame(buildDlt645ErrorResponse({
    address: '123456789012',
    requestControl: 0x11,
    errorCode: 0x02,
  }));
  assert.equal(parsed.control, 0xd1);
  assert.equal(parsed.response, true);
  assert.equal(parsed.abnormal, true);
  assert.deepEqual(parsed.errorFlags, ['无请求数据']);
});


test('signed BCD reserves the sign bit after rounding while unsigned magnitudes remain supported', () => {
  for (const value of [79.9999, -79.9999]) {
    const bytes = encodeDlt645Bcd(value, 4, 3, { signed: true });
    assert.equal(decodeDlt645Bcd(bytes, 4, { signed: true }), value);
  }
  for (const value of [80, -80, 89.1234, -89.1234, 79.99995, -79.99995]) {
    assert.throws(() => encodeDlt645Bcd(value, 4, 3, { signed: true }), RangeError);
  }
  assert.deepEqual([...encodeDlt645Bcd(80, 4, 3)], [0, 0, 0x80]);
});

test('a corrupted length cannot swallow the next complete valid DL/T frame', () => {
  const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0 });
  const damaged = Uint8Array.from(valid);
  damaged[9] = 20;
  const result = extractDlt645Frames(Uint8Array.of(...damaged, ...valid));
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].dataIdentifier, '02010100');
  assert.equal(result.remainder.length, 0);
});

test('fragmented damaged candidates recover valid successors without dropping genuine partial frames', () => {
  const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4 });
  const damaged = Uint8Array.from(valid);
  damaged[damaged.length - 2] ^= 0xff;
  const first = extractDlt645Frames(Uint8Array.of(0x55, ...damaged, ...valid.slice(0, -3)));
  assert.equal(first.frames.length, 0);
  assert.deepEqual([...first.remainder], [...valid.slice(0, -3)]);
  const second = extractDlt645Frames(Uint8Array.of(...first.remainder, ...valid.slice(-3)));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].address, '123456789012');
  assert.equal(second.frames[0].wakeUpBytes, 4);
});

test('DL/T partial-frame retention stays bounded after an excessive wake-up noise prefix', () => {
  const result = extractDlt645Frames(Uint8Array.of(...new Uint8Array(10000).fill(0xfe), 0x68, 0x12));
  assert.ok(result.remainder.length <= 18);
  assert.deepEqual([...result.remainder].slice(-2), [0x68, 0x12]);
});

test('resynchronization skips an incomplete false header inside a rejected complete candidate', () => {
  const damaged = new Uint8Array(32);
  damaged[0] = damaged[7] = 0x68;
  damaged[9] = 20;
  damaged.set([0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255], 10);
  for (const wakeUpBytes of [0, 4]) {
    const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes });
    const result = extractDlt645Frames(Uint8Array.of(...damaged, ...valid));
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].dataIdentifier, '02010100');
    assert.equal(result.frames[0].wakeUpBytes, wakeUpBytes);
    assert.equal(result.remainder.length, 0);
  }
});

test('resynchronization retains the earliest incomplete candidate when no valid successor exists', () => {
  const damaged = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0 });
  damaged[damaged.length - 2] ^= 0xff;
  const earliest = Uint8Array.of(0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255);
  const later = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0 }).slice(0, -3);
  const result = extractDlt645Frames(Uint8Array.of(...damaged, ...new Uint8Array(10000).fill(0xfe), ...earliest, ...later));
  assert.equal(result.frames.length, 0);
  assert.deepEqual([...result.remainder], [...new Uint8Array(16).fill(0xfe), ...earliest, ...later]);
});

test('an ordinary incomplete frame keeps its body even when it contains a complete frame', () => {
  const inner = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0 });
  const partial = Uint8Array.of(0x68, 0, 0, 0, 0, 0, 0, 0x68, 0x11, 40, ...inner);
  const result = extractDlt645Frames(partial);
  assert.equal(result.frames.length, 0);
  assert.deepEqual([...result.remainder], [...partial]);
});

test('resynchronization continues across chunks after retaining an incomplete false header', () => {
  const damaged = new Uint8Array(32);
  damaged[0] = damaged[7] = 0x68;
  damaged[9] = 20;
  damaged.set([0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255], 10);
  const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4 });
  const first = extractDlt645Frames(Uint8Array.of(...damaged, ...valid.slice(0, -3)));
  assert.equal(first.frames.length, 0);
  assert.deepEqual([...first.remainder], [...damaged.slice(10), ...valid.slice(0, -3)]);
  const second = extractDlt645Frames(Uint8Array.of(...first.remainder, ...valid.slice(-3)), first);
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].wakeUpBytes, 4);
  assert.equal(second.remainder.length, 0);
});
