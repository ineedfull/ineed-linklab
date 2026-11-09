import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStompSendQueue } from '../src/model/stompSendQueue.js';
import { StompDecoder, encodeStompFrame } from '../src/model/stompCodec.js';

test('queued STOMP frames share bounded native writes and retain complete wire order', async () => {
  const writes = []; let complete;
  const first = new Promise(resolve => { complete = resolve; });
  const queue = createStompSendQueue({ isActive: () => true, send: async bytes => { writes.push(bytes); if (writes.length === 1) await first; } });
  const frame = i => encodeStompFrame('MESSAGE', { destination: '/topic/test', subscription: 's', 'message-id': String(i) }, String(i));
  const promises = [queue.write(frame(0), 'peer')];
  await Promise.resolve();
  for (let i = 1; i <= 300; i++) promises.push(queue.write(frame(i), 'peer'));
  let settled = false; Promise.all(promises).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  complete(); await Promise.all(promises);
  assert(writes.length <= 4, `expected bounded coalescing, saw ${writes.length} native writes`);
  assert(writes.every(bytes => bytes.length <= 65536));
  const decoder = new StompDecoder();
  assert.deepEqual(writes.flatMap(bytes => decoder.push(bytes)).map(frame => frame.body), Array.from({ length: 301 }, (_, i) => String(i)));
  queue.close();
});

test('coalescing never joins peers or exceeds the native batch byte bound', async () => {
  const writes = [];
  const queue = createStompSendQueue({ isActive: () => true, send: async (bytes, peerId) => { writes.push({ bytes, peerId }); } });
  const promises = [];
  for (let i = 0; i < 12; i++) for (const peer of ['a', 'b']) promises.push(queue.write(encodeStompFrame('SEND', { destination: `/topic/${peer}` }, peer.repeat(20000)), peer));
  await Promise.all(promises);
  assert(writes.length <= 8);
  for (const { bytes, peerId } of writes) {
    assert(bytes.length <= 65536);
    assert(new StompDecoder().push(bytes).every(frame => frame.body === peerId.repeat(20000)));
  }
  queue.close();
});
