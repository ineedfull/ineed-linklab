import { snapshotPlainJson } from './workbenchSnapshots.js';

// SendPanel, templates and scheduled jobs hold logical bytes. Only the shared
// command calls this boundary; native transports receive complete wire bytes.
export function createSendWireRequest(request) {
  const framing = request.framing ?? 'none';
  const payload = request.bytes;
  let bytes;
  // DL/T master/simulator already build complete protocol frames. Its existing
  // marker is metadata, so those bytes must pass through without extra framing.
  if (framing === 'none' || framing === 'datagram' || framing === 'dlt645' || framing === 'websocket') {
    bytes = new Uint8Array(payload);
  } else if (framing === 'line') {
    const last = payload.at(-1);
    const appendLf = last !== 10 && last !== 13;
    bytes = new Uint8Array(payload.length + Number(appendLf));
    bytes.set(payload);
    if (appendLf) bytes[payload.length] = 10;
  } else if (framing === 'length-prefix') {
    if (payload.length > 0xffff_ffff) throw new RangeError('Payload exceeds unsigned 32-bit length');
    bytes = new Uint8Array(payload.length + 4);
    new DataView(bytes.buffer).setUint32(0, payload.length, false);
    bytes.set(payload, 4);
  } else {
    throw new TypeError(`Unsupported send framing: ${framing}`);
  }
  return {
    endpointId: request.endpointId,
    bytes,
    target: request.target === undefined ? null : snapshotPlainJson(request.target, 'send target'),
    framing,
    ...(request.messageType === undefined ? {} : { messageType: request.messageType }),
  };
}
