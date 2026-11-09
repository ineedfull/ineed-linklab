import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PayloadValidationError,
  encodeJson,
  encodeText,
  formatFrame,
  parseHex,
} from '../src/payloadCodec.js';

const decoder = new TextDecoder();

test('codecs consumer imports execute through the public industrial subpaths', async () => {
  const { parseToolHex } = await import('@ineed-linklab/codecs/industrial/bytes.js');
  const { decodeInteger } = await import('@ineed-linklab/codecs/industrial/numbers.js');
  const { decodeBcd } = await import('@ineed-linklab/codecs/industrial/text.js');
  const { calculateChecksum } = await import('@ineed-linklab/codecs/industrial/checksums.js');
  assert.deepEqual([...parseToolHex('01 FF')], [1, 255]);
  assert.equal(decodeInteger('FF', 8, 'normal').signed, '-1');
  assert.equal(decodeBcd('00 12', 0, 'big'), '0012');
  assert.equal(calculateChecksum(Uint8Array.of(1, 2), 'sum8').hex, '03');
});

test('PayloadValidationError exposes stable structured fields', () => {
  const error = new PayloadValidationError('bad payload', 'BAD_PAYLOAD', { field: 'payload' });

  assert.equal(error instanceof Error, true);
  assert.equal(error.name, 'PayloadValidationError');
  assert.equal(error.message, 'bad payload');
  assert.equal(error.code, 'BAD_PAYLOAD');
  assert.deepEqual(error.details, { field: 'payload' });
});

test('encodeText produces UTF-8 bytes with each exact line ending', () => {
  const expected = new Map([
    ['none', [0x68, 0xc3, 0xa9]],
    ['cr', [0x68, 0xc3, 0xa9, 0x0d]],
    ['lf', [0x68, 0xc3, 0xa9, 0x0a]],
    ['crlf', [0x68, 0xc3, 0xa9, 0x0d, 0x0a]],
  ]);

  for (const [lineEnding, bytes] of expected) {
    assert.deepEqual([...encodeText('hé', lineEnding)], bytes);
  }
});

test('encodeText rejects invalid text and line-ending modes structurally', () => {
  assertPayloadError(() => encodeText(42), 'INVALID_TEXT');
  assertPayloadError(() => encodeText('hello', 'native'), 'INVALID_LINE_ENDING', {
    lineEnding: 'native',
  });
});

test('parseHex accepts empty, continuous, and byte-separated input', () => {
  assert.deepEqual([...parseHex('')], []);
  assert.deepEqual([...parseHex('  \n\t ')], []);
  assert.deepEqual([...parseHex('00aBff')], [0x00, 0xab, 0xff]);
  assert.deepEqual([...parseHex('00 AB\nff')], [0x00, 0xab, 0xff]);
  assert.deepEqual([...parseHex('00AB ff')], [0x00, 0xab, 0xff]);
});

test('parseHex rejects non-hex, odd nibbles, and whitespace inside a byte without partial output', () => {
  assertPayloadError(() => parseHex('AA GG 01'), 'INVALID_HEX');
  assertPayloadError(() => parseHex('ABC'), 'ODD_HEX_NIBBLES');
  assertPayloadError(() => parseHex('A A'), 'ODD_HEX_NIBBLES');
  assertPayloadError(() => parseHex(null), 'INVALID_HEX_TEXT');
});

test('parseHex returns fresh bytes on every call', () => {
  const first = parseHex('0102');
  const second = parseHex('0102');

  first[0] = 0xff;
  assert.deepEqual([...second], [1, 2]);
});

test('encodeJson preserves scalar, array, and object semantics in pretty UTF-8 JSON', () => {
  const cases = [
    ['null', 'null'],
    ['true', 'true'],
    ['3', '3'],
    ['"value"', '"value"'],
    ['[1,{"x":"é"}]', '[\n  1,\n  {\n    "x": "é"\n  }\n]'],
    ['{"b":2,"a":1}', '{\n  "b": 2,\n  "a": 1\n}'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(decoder.decode(encodeJson(input)), expected);
  }
});

test('encodeJson rejects malformed JSON with a safe structured message', () => {
  assert.throws(
    () => encodeJson('{"password":"secret",}'),
    (error) => {
      assert.equal(error instanceof PayloadValidationError, true);
      assert.equal(error.code, 'INVALID_JSON');
      assert.equal(error.message, 'JSON payload is malformed');
      assert.doesNotMatch(JSON.stringify(error.details), /secret/);
      return true;
    },
  );
  assertPayloadError(() => encodeJson(1), 'INVALID_JSON_TEXT');
});

test('formatFrame renders text and uppercase spaced hex within display limits', () => {
  const bytes = Uint8Array.of(0x48, 0x69, 0x21);

  assert.deepEqual(formatFrame(bytes), {
    text: 'Hi!',
    totalBytes: 3,
    truncated: false,
  });
  assert.deepEqual(formatFrame(bytes, 'hex', { maxDisplayBytes: 2 }), {
    text: '48 69',
    totalBytes: 3,
    truncated: true,
  });
});

test('formatFrame formats valid JSON and reports invalid or skipped JSON safely', () => {
  const valid = new TextEncoder().encode('{"a":1}');
  const invalid = new TextEncoder().encode('{"token":"secret",}');

  assert.deepEqual(formatFrame(valid, 'json'), {
    text: '{\n  "a": 1\n}',
    totalBytes: 7,
    truncated: false,
    json: { valid: true, formatted: true },
  });
  assert.deepEqual(formatFrame(invalid, 'json'), {
    text: '{"token":"secret",}',
    totalBytes: 19,
    truncated: false,
    json: { valid: false, formatted: false },
  });
  assert.deepEqual(formatFrame(valid, 'json', { maxFormatBytes: 6 }), {
    text: '{"a":1}',
    totalBytes: 7,
    truncated: false,
    json: { valid: null, formatted: false },
  });
});

test('formatFrame bounds formatted JSON output bytes and never aliases input', () => {
  const bytes = new TextEncoder().encode('{"long":"value"}');
  const result = formatFrame(bytes, 'json', { maxDisplayBytes: 5 });

  bytes.fill(0);
  assert.equal(result.text, '{\n  "');
  assert.equal(result.totalBytes, 16);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.json, { valid: true, formatted: true });
});

test('formatFrame omits an incomplete two-byte UTF-8 code point at the display limit', () => {
  const bytes = new TextEncoder().encode('AéB');

  assert.deepEqual(formatFrame(bytes, 'text', { maxDisplayBytes: 2 }), {
    text: 'A',
    totalBytes: 4,
    truncated: true,
  });
});

test('formatFrame omits an incomplete four-byte UTF-8 code point at the display limit', () => {
  const bytes = new TextEncoder().encode('🙂x');

  assert.deepEqual(formatFrame(bytes, 'text', { maxDisplayBytes: 3 }), {
    text: '',
    totalBytes: 5,
    truncated: true,
  });
});

test('formatFrame rejects invalid bytes, formats, and limits', () => {
  assertPayloadError(() => formatFrame([1, 2]), 'INVALID_FRAME_BYTES');
  assertPayloadError(() => formatFrame(Uint8Array.of(1), 'binary'), 'UNSUPPORTED_FORMAT');

  for (const limits of [null, [], { maxDisplayBytes: 0 }, { maxDisplayBytes: 1.5 },
    { maxDisplayBytes: null }, { maxFormatBytes: '10' }, { maxFormatBytes: -1 },
    { maxFormatBytes: Number.POSITIVE_INFINITY }]) {
    assertPayloadError(() => formatFrame(Uint8Array.of(1), 'text', limits), 'INVALID_LIMITS');
  }
});

function assertPayloadError(operation, code, details) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof PayloadValidationError, true);
    assert.equal(error.name, 'PayloadValidationError');
    assert.equal(error.code, code);
    assert.equal(typeof error.details, 'object');
    if (details) assert.deepEqual(error.details, details);
    return true;
  });
}
