import net from 'node:net';
import { once } from 'node:events';

// Independent small TCP peer: registers 0/1 are 321/654; address 100 is slow,
// address 999 returns an exception. Reject every write, record all requests.
export async function createAcceptanceModbusServer({ holdSlowReads = false } = {}) {
  const sockets = new Set();
  const timers = new Set();
  const requests = [];
  const held = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      for (const item of held) if (item.socket === socket) held.delete(item);
    });
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 6) {
        const length = pending.readUInt16BE(4);
        if (length < 2 || length > 254) { socket.destroy(); return; }
        if (pending.length < length + 6) return;
        const request = Buffer.from(pending.subarray(0, length + 6));
        pending = pending.subarray(length + 6);
        const code = request[7];
        const address = request.length >= 12 ? request.readUInt16BE(8) : 0;
        const quantity = request.length >= 12 ? request.readUInt16BE(10) : 0;
        requests.push({ code, address, quantity });
        let pdu;
        if (![1, 2, 3, 4].includes(code) || request.length !== 12 || !quantity) {
          pdu = Buffer.from([code | 0x80, 1]);
        } else if (address === 999 || quantity > (code <= 2 ? 2000 : 125)) {
          pdu = Buffer.from([code | 0x80, 2]);
        } else if (code <= 2) {
          const count = Math.ceil(quantity / 8);
          pdu = Buffer.alloc(count + 2);
          pdu[0] = code; pdu[1] = count;
          for (let i = 0; i < quantity; i++) if ((address + i) % 2 === 0) pdu[2 + Math.floor(i / 8)] |= 1 << (i % 8);
        } else {
          pdu = Buffer.alloc(2 + quantity * 2); pdu[0] = code; pdu[1] = quantity * 2;
          for (let i = 0; i < quantity; i++) pdu.writeUInt16BE((address + i) % 2 === 0 ? 321 : 654, 2 + i * 2);
        }
        const response = Buffer.alloc(7 + pdu.length);
        request.copy(response, 0, 0, 4); response.writeUInt16BE(pdu.length + 1, 4); response[6] = request[6];
        pdu.copy(response, 7);
        if (address === 100 && holdSlowReads) {
          held.add({ socket, response });
          continue;
        }
        const timer = setTimeout(() => { timers.delete(timer); if (!socket.destroyed) socket.write(response); }, address === 100 ? 500 : 0);
        timers.add(timer);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, requests,
    pendingSlowReads: () => held.size,
    releaseSlowReads() {
      const count = held.size;
      for (const item of held) if (!item.socket.destroyed) item.socket.write(item.response);
      held.clear();
      return count;
    },
    async close() {
      held.clear();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
