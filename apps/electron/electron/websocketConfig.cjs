const { isUtf8 } = require('node:buffer');
const MAX_MESSAGE = 1024 * 1024;
const MAX_PENDING = 4 * MAX_MESSAGE;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;

function wsError(code, message) { return Object.assign(new Error(message), { name: 'WebSocketError', code }); }
function configFor(endpoint, options) {
  const config = endpoint?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw wsError('IO_ERROR', 'Invalid WebSocket config');
  if (Object.hasOwn(config, 'headers') || Object.hasOwn(config, 'websocketHeaders')) throw wsError('IO_ERROR', 'WebSocket headers must remain session-only');
  const type = config.messageType ?? 'text';
  if (!['text', 'binary'].includes(type)) throw wsError('IO_ERROR', 'Invalid WebSocket messageType');
  const protocols = config.subprotocols ?? [];
  if (!Array.isArray(protocols) || protocols.length > 16 || new Set(protocols).size !== protocols.length
    || protocols.some(p => typeof p !== 'string' || p.length > 128 || !TOKEN.test(p))) throw wsError('IO_ERROR', 'Invalid WebSocket subprotocols');
  const heartbeat = config.heartbeat ?? {};
  if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)
    || (heartbeat.enabled !== undefined && typeof heartbeat.enabled !== 'boolean')) throw wsError('IO_ERROR', 'Invalid WebSocket heartbeat');
  const intervalMs = heartbeat.intervalMs ?? 30000;
  const timeoutMs = heartbeat.timeoutMs ?? 10000;
  if (![intervalMs, timeoutMs].every(v => Number.isInteger(v) && v >= 1000 && v <= 60000)) throw wsError('IO_ERROR', 'Heartbeat timing must be 1000..60000ms');
  const common = { messageType: type, protocols, heartbeat: { enabled: heartbeat.enabled === true, intervalMs, timeoutMs } };
  if (endpoint.transport === 'websocket-client') {
    let url;
    try { url = new URL(config.url); } catch { throw wsError('IO_ERROR', 'Invalid WebSocket URL'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash
      || url.href.length > 8192 || /[\r\n]/.test(config.url)) throw wsError('IO_ERROR', 'Invalid WebSocket URL');
    if (config.autoReconnect !== undefined && typeof config.autoReconnect !== 'boolean') throw wsError('IO_ERROR', 'Invalid autoReconnect');
    return { ...common, url: url.href, safeUrl: `${url.protocol}//${url.host}${url.pathname}`, headers: headersFor(options?.websocketHeaders) };
  }
  if (endpoint.transport !== 'websocket-server') throw wsError('IO_ERROR', 'Not a WebSocket endpoint');
  const host = config.listenHost ?? '127.0.0.1';
  const port = config.listenPort ?? 9000;
  const path = config.path ?? '/';
  if (typeof host !== 'string' || !host.trim() || host.length > 255 || /[\s/]/.test(host)) throw wsError('IO_ERROR', 'Invalid listenHost');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw wsError('IO_ERROR', 'Invalid listenPort');
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 2048 || /[\s?#]/.test(path)) throw wsError('IO_ERROR', 'Invalid WebSocket path');
  if ((options?.websocketHeaders?.length ?? 0) !== 0) throw wsError('IO_ERROR', 'Headers are only supported by WebSocket clients');
  return { ...common, host, port, path };
}
function headersFor(list = []) {
  if (!Array.isArray(list) || list.length > 32) throw wsError('IO_ERROR', 'WebSocket headers limit is 32');
  const seen = new Set(); const result = Object.create(null); let size = 0;
  for (const item of list) {
    const name = item?.name; const value = item?.value;
    if (typeof name !== 'string' || !TOKEN.test(name)
      || typeof value !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(value)
      || Buffer.byteLength(value) > 4096 || /^(host|connection|upgrade|sec-websocket-.*)$/i.test(name)
      || seen.has(name.toLowerCase())) throw wsError('IO_ERROR', 'Invalid or reserved WebSocket header');
    seen.add(name.toLowerCase()); size += Buffer.byteLength(name + value);
    if (size > 16384) throw wsError('IO_ERROR', 'WebSocket headers limit is 16KiB');
    result[name] = value;
  }
  return result;
}
function payloadFor(value, type) {
  if (!['text', 'binary'].includes(type)) throw wsError('IO_ERROR', 'Invalid WebSocket messageType');
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) throw wsError('IO_ERROR', 'bytes must be a byte array');
  if (value.length > MAX_MESSAGE) throw wsError('IO_ERROR', 'WebSocket message limit is 1 MiB');
  if (Array.isArray(value) && value.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw wsError('IO_ERROR', 'Invalid WebSocket bytes');
  const bytes = Buffer.from(value);
  if (type === 'text' && !isUtf8(bytes)) throw wsError('IO_ERROR', 'WebSocket text requires valid UTF-8');
  return bytes;
}
module.exports = { configFor, headersFor, payloadFor, wsError, MAX_MESSAGE, MAX_PENDING };
