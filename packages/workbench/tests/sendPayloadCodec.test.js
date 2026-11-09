import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeJson } from '@ineed-linklab/codecs/payloadCodec.js';

const codecModule = await import('../src/model/sendPayloadCodec.js').catch(() => null);

test('JSON payload bytes use the shared canonical encoder', () => {
  assert.ok(codecModule, 'send payload codec module must exist');
  const source = '{"b":1,"a":[2,3]}';
  const result = codecModule.encodeSendPayload({ mode: 'json', payload: source });

  assert.equal(result.ok, true);
  assert.deepEqual(result.bytes, encodeJson(source));
});

test('formatted and compact JSON produce equivalent canonical bytes', () => {
  assert.ok(codecModule, 'send payload codec module must exist');
  const compact = codecModule.encodeSendPayload({ mode: 'json', payload: '{"value":1}' });
  const formatted = codecModule.encodeSendPayload({
    mode: 'json', payload: '{\n  "value": 1\n}',
  });

  assert.deepEqual(compact.bytes, formatted.bytes);
});

test('HEX requires at least one byte and accepts valid byte input', () => {
  assert.ok(codecModule, 'send payload codec module must exist');
  for (const payload of ['', ' ', '\n\t']) {
    const result = codecModule.encodeSendPayload({ mode: 'hex', payload });
    assert.equal(result.ok, false);
    assert.equal(result.bytes, null);
  }
  const valid = codecModule.encodeSendPayload({ mode: 'hex', payload: '01 ff A0' });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.bytes, Uint8Array.of(0x01, 0xff, 0xa0));
});

test('Text mode explicitly rejects empty source and preserves CRLF encoding', () => {
  assert.ok(codecModule, 'send payload codec module must exist');
  assert.equal(codecModule.encodeSendPayload({ mode: 'text', payload: '' }).ok, false);
  const result = codecModule.encodeSendPayload({
    mode: 'text', payload: 'ping', appendCrlf: true,
  });
  assert.equal(new TextDecoder().decode(result.bytes), 'ping\r\n');
});
