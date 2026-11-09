import { STOMP_LIMITS } from './stompCodec.js';

const ended = () => new Error('STOMP 会话已结束');

/** Ordered writes belong to one native peer, including their admission and cancellation. */
export function createStompSendQueue({ send, isActive }) {
  const lanes = new Map();
  let closed = false;

  function cancel(lane, error = ended()) {
    lane.closed = true;
    lane.items = [];
    for (const item of [...lane.pending]) item.finish(error);
    if (lanes.get(lane.id) === lane) lanes.delete(lane.id);
  }

  async function flush(lane) {
    try {
      while (lane.items.length && !lane.closed) {
        if (closed || !isActive()) { cancel(lane); break; }
        const batch = [lane.items.shift()];
        let size = batch[0].bytes.length;
        // STOMP is a byte stream: reuse one native round trip for adjacent frames
        // already waiting for this peer, without delaying a new frame to fill a batch.
        while (lane.items.length && batch.length < 128 && size + lane.items[0].bytes.length <= 65536) {
          const item = lane.items.shift(); batch.push(item); size += item.bytes.length;
        }
        const bytes = batch.length === 1 ? batch[0].bytes : new Uint8Array(size);
        if (batch.length > 1) { let offset = 0; for (const item of batch) { bytes.set(item.bytes, offset); offset += item.bytes.length; } }
        try {
          await send(bytes, lane.peerId);
          for (const item of batch) item.finish(lane.closed || closed || !isActive() ? ended() : null);
        } catch (error) { cancel(lane, error); }
      }
    } finally {
      lane.running = false;
      if (!lane.pending.size && lanes.get(lane.id) === lane) lanes.delete(lane.id);
    }
  }

  return {
    write(bytes, peerId) {
      if (closed || !isActive()) return Promise.reject(ended());
      const id = peerId ?? 'client';
      let lane = lanes.get(id);
      if (!lane) { lane = { id, peerId, items: [], pending: new Set(), bytes: 0, running: false, closed: false }; lanes.set(id, lane); }
      // A peer may hold one maximum-size frame, but never borrow another peer's quota.
      // With the broker's 64-peer cap this also bounds aggregate encoded payloads to 64 MiB.
      const byteLimit = peerId ? STOMP_LIMITS.frameBytes : STOMP_LIMITS.storedBytes;
      if (lane.pending.size >= STOMP_LIMITS.pending || lane.bytes + bytes.length > byteLimit) {
        const error = new Error('STOMP peer 发送队列已满'); error.code = 'STOMP_SEND_QUEUE_FULL';
        return Promise.reject(error);
      }
      let item;
      const result = new Promise((resolve, reject) => {
        item = { bytes, finish(error) {
          if (!lane.pending.delete(item)) return;
          lane.bytes -= bytes.length;
          error ? reject(error) : resolve();
        } };
        lane.pending.add(item); lane.bytes += bytes.length; lane.items.push(item);
      });
      item.result = result;
      if (!lane.running) { lane.running = true; void Promise.resolve().then(() => flush(lane)); }
      return result;
    },
    drain(peerId) { return Promise.allSettled([...(lanes.get(peerId ?? 'client')?.pending ?? [])].map(item => item.result)); },
    cancelPeer(peerId) { const lane = lanes.get(peerId); if (lane) cancel(lane); },
    close() { closed = true; for (const lane of [...lanes.values()]) cancel(lane); },
  };
}
