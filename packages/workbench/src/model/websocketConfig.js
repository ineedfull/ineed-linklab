const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export function isWebSocketTransport(transport) {
  return transport === 'websocket-client' || transport === 'websocket-server';
}
export function normalizeWebSocketConfig(config = {}, transport = 'websocket-client') {
  return {
    ...(transport === 'websocket-server'
      ? { listenHost: config.listenHost ?? '127.0.0.1', listenPort: config.listenPort ?? 9000, path: config.path ?? '/' }
      : { url: config.url ?? 'ws://127.0.0.1:9000/', autoReconnect: config.autoReconnect ?? false }),
    subprotocols: config.subprotocols ?? [],
    messageType: config.messageType ?? 'text',
    heartbeat: { enabled: false, intervalMs: 30000, timeoutMs: 10000, ...config.heartbeat },
  };
}
export function validateWebSocketConfig(config, transport) {
  const errors = {};
  const common = ['subprotocols', 'messageType', 'heartbeat'];
  const keys = transport === 'websocket-client' ? ['url', 'autoReconnect', ...common] : ['listenHost', 'listenPort', 'path', ...common];
  if (Object.keys(config).some(key => !keys.includes(key))) errors.websocket = 'WebSocket 配置包含不支持的字段；请求头仅保存在当前会话。';
  const value = normalizeWebSocketConfig(config, transport);
  if (transport === 'websocket-client') {
    try {
      const url = new URL(value.url);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || String(value.url).includes('#')) throw new Error();
    } catch { errors.url = '请输入有效的 ws:// 或 wss:// URL，不允许用户名、密码或片段。'; }
    if (typeof value.autoReconnect !== 'boolean') errors.autoReconnect = '自动重连必须为布尔值。';
  } else {
    if (typeof value.listenHost !== 'string' || !value.listenHost.trim()) errors.listenHost = '请输入监听地址。';
    if (!Number.isInteger(value.listenPort) || value.listenPort < 1 || value.listenPort > 65535) errors.listenPort = '监听端口必须为 1 到 65535 的整数。';
    if (typeof value.path !== 'string' || !value.path.startsWith('/') || /[\r\n?#]/.test(value.path)) errors.websocketPath = '路径必须以 / 开始，不能包含查询、片段或换行。';
  }
  if (!Array.isArray(value.subprotocols) || value.subprotocols.length > 16 || value.subprotocols.some(protocol => typeof protocol !== 'string' || protocol.length > 128 || !token.test(protocol)) || new Set(value.subprotocols).size !== value.subprotocols.length) errors.subprotocols = '子协议最多 16 项，每项为不超过 128 字节且不重复的 HTTP token。';
  if (!['text', 'binary'].includes(value.messageType)) errors.messageType = '请选择文本或二进制消息类型。';
  if (config.heartbeat !== undefined && (config.heartbeat === null || typeof config.heartbeat !== 'object' || Array.isArray(config.heartbeat) || Object.keys(config.heartbeat).some(key => !['enabled', 'intervalMs', 'timeoutMs'].includes(key)))) errors.heartbeat = '心跳配置无效。';
  if (typeof value.heartbeat.enabled !== 'boolean' || ['intervalMs', 'timeoutMs'].some(key => !Number.isInteger(value.heartbeat[key]) || value.heartbeat[key] < 1000 || value.heartbeat[key] > 60000)) errors.heartbeat = '心跳间隔与超时必须为 1000 到 60000 毫秒的整数。';
  return errors;
}
export function snapshotWebSocketHeaders(headers = []) {
  if (!Array.isArray(headers) || headers.length > 32) throw new TypeError('请求头最多 32 项。');
  const names = new Set(); let total = 0;
  const encoder = new TextEncoder();
  return headers.map(header => {
    const name = header?.name; const value = header?.value;
    if (typeof name !== 'string' || !token.test(name) || typeof value !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(value) || ['host', 'connection', 'upgrade'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('sec-websocket-') || names.has(name.toLowerCase())) throw new TypeError('请求头格式无效、重复或使用了握手保留名称。');
    names.add(name.toLowerCase());
    const size = encoder.encode(value).length;
    total += encoder.encode(name).length + size;
    if (size > 4096 || total > 16384) throw new TypeError('请求头超过大小限制。');
    return Object.freeze({ name, value });
  });
}
export function safeWebSocketAddress(value) {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return 'WebSocket'; }
}
