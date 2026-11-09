import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  appendRealtimeItem,
  appendRealtimeItemsByEndpoint,
  createRealtimeItemId,
  normalizeLimit,
  trimRealtimeItems,
  trimRealtimeItemsByEndpoint,
} from '../src/lib/realtimeItems.js';

test('normalizeLimit defaults invalid values to 300, floors fractions, and clamps at 50000', () => {
  assert.equal(normalizeLimit(undefined), 300);
  assert.equal(normalizeLimit('bad'), 300);
  assert.equal(normalizeLimit(0), 300);
  assert.equal(normalizeLimit(-1, 25), 25);
  assert.equal(normalizeLimit(10.9), 10);
  assert.equal(normalizeLimit('12'), 12);
  assert.equal(normalizeLimit(100000), 50000);
  assert.equal(normalizeLimit(1, Number.NaN), 1);
  assert.equal(normalizeLimit('bad', Number.NaN), 300);
});

test('appendRealtimeItem retains the newest N items', () => {
  const original = [{ id: 1 }, { id: 2 }];
  const next = appendRealtimeItem(original, { id: 3 }, 2);

  assert.deepEqual(next, [{ id: 2 }, { id: 3 }]);
  assert.deepEqual(trimRealtimeItems([...original, { id: 3 }], 2), next);
  assert.deepEqual(original, [{ id: 1 }, { id: 2 }]);
});

test('endpoint retention keeps newest items independently in stable global order', () => {
  const items = [
    { id: 'a1', endpointId: 'a' },
    { id: 'b1', endpointId: 'b' },
    { id: 'a2', endpointId: 'a' },
    { id: 'b2', endpointId: 'b' },
    { id: 'a3', endpointId: 'a' },
  ];

  assert.deepEqual(
    trimRealtimeItemsByEndpoint(items, 2).map((item) => item.id),
    ['b1', 'a2', 'b2', 'a3'],
  );
});

test('appending endpoint items trims busy endpoints without clearing quiet endpoints', () => {
  const items = [
    { id: 'quiet-1', endpointId: 'quiet' },
    { id: 'busy-1', endpointId: 'busy' },
    { id: 'busy-2', endpointId: 'busy' },
  ];
  const additions = [
    { id: 'busy-3', endpointId: 'busy' },
    { id: 'quiet-2', endpointId: 'quiet' },
  ];

  const next = appendRealtimeItemsByEndpoint(items, additions, 2);

  assert.deepEqual(next.map((item) => item.id), ['quiet-1', 'busy-2', 'busy-3', 'quiet-2']);
  assert.notEqual(next, items);
});

test('changing the limit trims every endpoint and leaves the input untouched', () => {
  const items = [
    { id: 'a1', endpointId: 'a' },
    { id: 'b1', endpointId: 'b' },
    { id: 'a2', endpointId: 'a' },
    { id: 'b2', endpointId: 'b' },
  ];

  const trimmed = trimRealtimeItemsByEndpoint(items, 1);

  assert.deepEqual(trimmed.map((item) => item.id), ['a2', 'b2']);
  assert.equal(items.length, 4);
});

test('empty append returns the original list and missing endpoint IDs share an independent bucket', () => {
  const items = [{ id: 'known', endpointId: 'a' }];
  assert.equal(appendRealtimeItemsByEndpoint(items, [], 1), items);

  const next = appendRealtimeItemsByEndpoint(items, [{ id: 'x' }, { id: 'y' }], 1);
  assert.deepEqual(next.map((item) => item.id), ['known', 'y']);
});

test('createRealtimeItemId is unique in one millisecond with injected time', () => {
  const now = () => 123456;
  const first = createRealtimeItemId('frame', now);
  const second = createRealtimeItemId('frame', now);

  assert.match(first, /^frame-123456-\d+$/);
  assert.match(second, /^frame-123456-\d+$/);
  assert.notEqual(first, second);
});

test('owned source contains no legacy protocol or connection vocabulary', async () => {
  const sourceUrls = [
    new URL('../../codecs/src/payloadCodec.js', import.meta.url),
    new URL('../../codecs/src/framers.js', import.meta.url),
    new URL('../../persistence-contract/src/batchedPersistence.js', import.meta.url),
    new URL('../src/lib/realtimeItems.js', import.meta.url),
  ];
  const prohibited = [
    ['legacy connection identifier', /connId/i],
    ['legacy protocol name', /m[q][t][t]/i],
    ['publish-subscribe channel term', /t[o][p][i][c]/i],
    ['delivery-level abbreviation', /q[o][s]/i],
    ['publish persistence verb', /r[e][t][a][i][n]/i],
  ];

  for (const sourceUrl of sourceUrls) {
    const source = await readFile(sourceUrl, 'utf8');
    for (const [label, pattern] of prohibited) {
      assert.doesNotMatch(source, pattern, `${sourceUrl.pathname}: ${label}`);
    }
  }
});
