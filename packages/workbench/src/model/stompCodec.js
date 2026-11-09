export const STOMP_LIMITS = Object.freeze({ frameBytes: 1048576, headerBytes: 65536, messages: 500, subscriptions: 100, peers: 64, pending: 1000, queueMessages: 1000, storedBytes: 8388608 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const plainHeaders = command => ['CONNECT', 'CONNECTED'].includes(command);
const escape = value => value.replaceAll('\\', '\\\\').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll(':', '\\c');
function unescape(value) {
  return value.replace(/\\(.)|\\$/g, (whole, char) => {
    if (char === 'r') return '\r'; if (char === 'n') return '\n'; if (char === 'c') return ':'; if (char === '\\') return '\\';
    throw new Error('Invalid STOMP header escape');
  });
}
export function encodeStompFrame(command, headers = {}, body = '') {
  if (!/^[A-Z]+$/.test(command) || typeof body !== 'string') throw new Error('Invalid STOMP frame');
  const content = encoder.encode(body);
  const entries = Object.entries({ ...headers, 'content-length': content.length });
  if (entries.length > 100) throw new Error('STOMP header limit exceeded');
  const lines = entries.map(([name, input]) => {
    const value = String(input);
    if (!name || /\0/.test(name + value) || plainHeaders(command) && /[\r\n:]|\r|\n/.test(name) || plainHeaders(command) && /[\r\n]/.test(value)) throw new Error('Invalid STOMP header');
    return `${plainHeaders(command) ? name : escape(name)}:${plainHeaders(command) ? value : escape(value)}`;
  });
  const head = encoder.encode(`${command}\n${lines.join('\n')}\n\n`);
  if (head.length > STOMP_LIMITS.headerBytes || head.length + content.length + 1 > STOMP_LIMITS.frameBytes) throw new Error('STOMP frame limit exceeded (1 MiB)');
  const bytes = new Uint8Array(head.length + content.length + 1); bytes.set(head); bytes.set(content, head.length); return bytes;
}

/** Incremental byte parser: content-length measures encoded bytes, including embedded NULL. */
export class StompDecoder {
  constructor() { this.buffer = new Uint8Array(); }
  push(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const frames = [];
    // Bound each accumulation even when a WebSocket message contains many complete frames.
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      const joined = new Uint8Array(this.buffer.length + Math.min(65536, bytes.length - offset)); joined.set(this.buffer); joined.set(bytes.subarray(offset, offset + 65536), this.buffer.length); this.buffer = joined;
      this.drain(frames);
      if (this.buffer.length > STOMP_LIMITS.frameBytes) throw new Error('STOMP frame limit exceeded (1 MiB)');
    }
    return frames;
  }
  drain(frames) {
    let start = 0;
    while (start < this.buffer.length) {
      if (this.buffer[start] === 10) { if (frames.at(-1)?.command !== null) frames.push({ command: null }); start++; continue; }
      if (this.buffer[start] === 13) {
        if (start + 1 === this.buffer.length) break;
        if (this.buffer[start + 1] !== 10) throw new Error('Invalid STOMP line ending');
        if (frames.at(-1)?.command !== null) frames.push({ command: null }); start += 2; continue;
      }
      let position = start; const lines = []; let complete = false;
      while (position < this.buffer.length) {
        const end = this.buffer.indexOf(10, position);
        if (end < 0) break;
        const stop = end > position && this.buffer[end - 1] === 13 ? end - 1 : end;
        const line = decoder.decode(this.buffer.subarray(position, stop));
        if (line.includes('\r') || line.includes('\0')) throw new Error('Invalid STOMP header');
        position = end + 1;
        if (!line) { complete = true; break; }
        lines.push(line);
        if (lines.length > 101) throw new Error('STOMP header limit exceeded');
      }
      if (position - start > STOMP_LIMITS.headerBytes || !complete && this.buffer.length - start > STOMP_LIMITS.headerBytes) throw new Error('STOMP header limit exceeded');
      if (!complete) break;
      const command = lines.shift(); if (!command || !/^[A-Z]+$/.test(command)) throw new Error('Invalid STOMP command');
      const headers = Object.create(null);
      for (const line of lines) {
        const colon = line.indexOf(':'); if (colon < 1) throw new Error('Invalid STOMP header');
        const name = plainHeaders(command) ? line.slice(0, colon) : unescape(line.slice(0, colon));
        const value = plainHeaders(command) ? line.slice(colon + 1) : unescape(line.slice(colon + 1));
        if (!Object.hasOwn(headers, name)) headers[name] = value;
      }
      let end;
      if (headers['content-length'] !== undefined) {
        if (!/^\d+$/.test(headers['content-length'])) throw new Error('Invalid STOMP content-length');
        const length = Number(headers['content-length']);
        if (!Number.isSafeInteger(length) || position - start + length + 1 > STOMP_LIMITS.frameBytes) throw new Error('STOMP frame limit exceeded (1 MiB)');
        end = position + length;
        if (end >= this.buffer.length) break;
        if (this.buffer[end] !== 0) throw new Error('Invalid STOMP content-length terminator');
      } else { end = this.buffer.indexOf(0, position); if (end < 0) break; }
      if (end + 1 - start > STOMP_LIMITS.frameBytes) throw new Error('STOMP frame limit exceeded (1 MiB)');
      if (frames.length >= 1000) throw new Error('STOMP frame batch limit exceeded');
      frames.push({ command, headers, body: decoder.decode(this.buffer.subarray(position, end)) }); start = end + 1;
    }
    if (start) this.buffer = this.buffer.slice(start);
  }
}

export function stompHeartbeat(value = '0,0') {
  if (typeof value !== 'string' || !/^\d+,\d+$/.test(value)) throw new Error('Invalid STOMP heartbeat');
  const values = value.split(',').map(Number);
  if (values.some(n => !Number.isSafeInteger(n) || n < 0 || n > 3600000)) throw new Error('Invalid STOMP heartbeat');
  return values;
}
export function stompDestination(value, local = false) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error('Invalid STOMP destination');
  if (local && (!/^\/(topic|queue)\/.+/.test(value) || /[*#>]/.test(value))) throw new Error('Local broker supports exact /topic/ or /queue/ destinations only; wildcards are unsupported');
  return value;
}
