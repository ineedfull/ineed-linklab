import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDirectionPredicate,
  createFramePredicate,
  createKeywordPredicate,
  createPeerPredicate,
  filterFrames,
} from '../src/model/messageFilters.js';

const frames = [
  {
    id: 'frame-1', endpointId: 'tcp-server', sessionId: 'session-1', peerId: 'peer-a',
    direction: 'in', text: 'Hello device', hex: '48 65 6c 6c 6f', bytes: Uint8Array.of(72),
  },
  {
    id: 'frame-2', endpointId: 'tcp-server', sessionId: 'session-1', peerId: 'peer-b',
    direction: 'out', text: 'ACK', hex: '41 43 4b', bytes: Uint8Array.of(65),
  },
  {
    id: 'frame-3', endpointId: 'serial-1', sessionId: 'session-2',
    direction: 'in', message: 'temperature=21', bytes: Uint8Array.of(21),
  },
];

test('direction predicate supports all, inbound, and outbound frames', () => {
  assert.deepEqual(frames.filter(createDirectionPredicate('all')), frames);
  assert.deepEqual(frames.filter(createDirectionPredicate('in')).map(({ id }) => id), ['frame-1', 'frame-3']);
  assert.deepEqual(frames.filter(createDirectionPredicate('out')).map(({ id }) => id), ['frame-2']);
});

test('Peer predicate supports all peers and exact Peer selection', () => {
  assert.deepEqual(frames.filter(createPeerPredicate('all')), frames);
  assert.deepEqual(frames.filter(createPeerPredicate('peer-b')).map(({ id }) => id), ['frame-2']);
});

test('keyword searches practical visible fields case-insensitively', () => {
  for (const [keyword, expected] of [
    ['hello', ['frame-1']],
    ['41 43', ['frame-2']],
    ['SERIAL-1', ['frame-3']],
    ['temperature', ['frame-3']],
    ['peer-b', ['frame-2']],
  ]) {
    assert.deepEqual(frames.filter(createKeywordPredicate(keyword)).map(({ id }) => id), expected);
  }
});

test('keyword filtering does not inspect arbitrary nested object fields', () => {
  const frame = { ...frames[0], metadata: { secret: 'needle' } };
  assert.equal(createKeywordPredicate('needle')(frame), false);
});

test('keyword filtering searches raw bytes when formatted fields are absent', () => {
  const frame = { bytes: Uint8Array.of(0x41, 0xff) };
  assert.equal(createKeywordPredicate('41 FF')(frame), true);
  assert.equal(createKeywordPredicate('41FF')(frame), true);
});

test('keyword filtering uses Unicode canonical equivalence', () => {
  const frame = { text: 'Caf\u00e9' };
  assert.equal(createKeywordPredicate('Cafe\u0301')(frame), true);
});

test('composed frame filtering applies direction, Peer, and keyword together', () => {
  const filters = { direction: 'in', peerId: 'peer-a', keyword: 'device' };
  assert.deepEqual(filterFrames(frames, filters).map(({ id }) => id), ['frame-1']);
  assert.equal(createFramePredicate(filters)(frames[0]), true);
  assert.equal(createFramePredicate(filters)(frames[1]), false);
});


test('raw UTF-8 search reaches the full payload and matches long cross-chunk Unicode content', () => {
  const text = 'x'.repeat(4094) + '你好 Cafe\u0301' + 'q'.repeat(12000) + 'THE END';
  const frame = { bytes: new TextEncoder().encode(text) };
  for (const keyword of ['你好 CAFÉ', 'q'.repeat(9000), 'the end']) {
    assert.equal(createKeywordPredicate(keyword)(frame), true, keyword.slice(0, 30));
  }
  assert.equal(createKeywordPredicate('absent')(frame), false);
});

test('native search preserves UTF-8 and normalization across boundaries with bounded decoder input', () => {
  const bytes = new TextEncoder().encode('x'.repeat(4095) + 'Cafe\u0301你好' + 'x'.repeat(100_000) + 'tail');
  const decode = TextDecoder.prototype.decode;
  const sizes = [];
  TextDecoder.prototype.decode = function(input, options) {
    sizes.push(input?.byteLength ?? 0);
    return decode.call(this, input, options);
  };
  try {
    assert.equal(createKeywordPredicate('CAFÉ你好')({ bytes }), true);
    assert.equal(createKeywordPredicate('tail')({ bytes }), true);
    assert.equal(createKeywordPredicate('not-here')({ bytes }), false);
    assert.ok(sizes.length > 1);
    assert.ok(Math.max(...sizes) <= 8192, 'decoder must not copy the complete payload');
  } finally { TextDecoder.prototype.decode = decode; }
});

test('raw HEX search crosses boundaries without a full byte array conversion', () => {
  const bytes = new Uint8Array(100_000).fill(0xaa);
  bytes.set([0x41, 0xff, 0x42], 4095);
  const from = Array.from;
  Array.from = function(value, ...args) {
    assert.notEqual(value, bytes, 'do not expand a whole payload into an array');
    return from.call(this, value, ...args);
  };
  try {
    assert.equal(createKeywordPredicate('41 FF 42')({ bytes }), true);
    assert.equal(createKeywordPredicate('41ff42')({ bytes }), true);
    assert.equal(createKeywordPredicate('41 ff 43')({ bytes }), false);
  } finally { Array.from = from; }
});


test('a chunk boundary cannot expose an unnormalized trailing base character', () => {
  const bytes = new TextEncoder().encode('x'.repeat(4092) + 'Cafe\u0301 fin');
  assert.equal(createKeywordPredicate('cafe')({ bytes }), false);
  assert.equal(createKeywordPredicate('café fin')({ bytes }), true);
});


test('absent one-nibble HEX search keeps temporary strings bounded', () => {
  const bytes = new Uint8Array(100_000).fill(0xbb);
  const includes = String.prototype.includes;
  let largest = 0;
  String.prototype.includes = function(needle, ...rest) {
    largest = Math.max(largest, this.length);
    return includes.call(this, needle, ...rest);
  };
  try {
    assert.equal(createKeywordPredicate('f')({ bytes }), false);
    assert.ok(largest <= 12_288, `HEX window grew to ${largest}`);
  } finally { String.prototype.includes = includes; }
});

test('long nonstarter input is scanned to the end using bounded normalization windows', () => {
  const bytes = new TextEncoder().encode('a' + '\u0301'.repeat(20_000) + ' distant-end');
  const normalize = String.prototype.normalize;
  let largest = 0;
  String.prototype.normalize = function(...args) {
    largest = Math.max(largest, this.length);
    return normalize.apply(this, args);
  };
  try {
    assert.equal(createKeywordPredicate('distant-end')({ bytes }), true);
    assert.ok(largest <= 8192, `normalization window grew to ${largest}`);
  } finally { String.prototype.normalize = normalize; }
});

test('raw Greek search keeps nonfinal sigma context across a byte chunk', () => {
  const bytes = new TextEncoder().encode('x'.repeat(4088) + 'ΟΣΑΒΓΔ');
  assert.equal(createKeywordPredicate('οσαβγδ')({ bytes }), true);
  assert.equal(createKeywordPredicate('ος')({ bytes }), false);
});

test('raw Greek search does not expose a premature final sigma match', () => {
  const bytes = new TextEncoder().encode('x'.repeat(4088) + 'ΟΣΑΒΓΔ');
  assert.equal(createKeywordPredicate('ος')({ bytes }), false);
});

test('raw sigma casing follows preceding and following letters through ignorable context', () => {
  for (const [suffix, queries] of [
    ['ΟΣ\u0301\'ΑΒΓΔ', ['οσ\u0301\'αβγδ', 'ος']],
    ['ΟΣ\u0301\'!ΑΒΓΔ', ['ος\u0301\'!', 'οσ']],
    ['Ο\u0301\'ΣΑΒΓΔ', ['σ', 'ς']],
    ['!\u0301\'Σ!ΑΒΓΔ', ['σ', 'ς']],
    ['ΟΣ\u0301\'', ['ος', 'οσ']],
  ]) {
    const text = 'x'.repeat(4088) + suffix;
    const bytes = new TextEncoder().encode(text);
    const normalized = text.normalize('NFC').toLowerCase();
    for (const query of queries) {
      assert.equal(createKeywordPredicate(query)({ bytes }),
        normalized.includes(query.normalize('NFC').toLowerCase()), `${suffix}: ${query}`);
    }
  }
});

test('contextual sigma search stays bounded across long case-ignorable runs', () => {
  const text = 'x'.repeat(4088) + 'ΟΣ' + "'".repeat(40_000) + 'Α tail';
  const bytes = new TextEncoder().encode(text);
  const normalize = String.prototype.normalize;
  const lower = String.prototype.toLowerCase;
  let largest = 0;
  String.prototype.normalize = function(...args) {
    largest = Math.max(largest, this.length);
    return normalize.apply(this, args);
  };
  String.prototype.toLowerCase = function(...args) {
    largest = Math.max(largest, this.length);
    return lower.apply(this, args);
  };
  try {
    assert.equal(createKeywordPredicate('ος')({ bytes }), false);
    assert.equal(createKeywordPredicate('οσ')({ bytes }), true);
    assert.equal(createKeywordPredicate('α tail')({ bytes }), true);
    assert.ok(largest <= 8192, `casing/normalization window grew to ${largest}`);
  } finally {
    String.prototype.normalize = normalize;
    String.prototype.toLowerCase = lower;
  }
});
