import { StompDecoder, encodeStompFrame, STOMP_LIMITS, stompDestination, stompHeartbeat } from './stompCodec.js';
import { createStompBroker } from './stompBroker.js';
import { snapshotWebSocketHeaders } from './websocketConfig.js';
import { createStompSendQueue } from './stompSendQueue.js';

export const STOMP_DEFAULT_CONFIG = Object.freeze({ url: 'ws://127.0.0.1:61614/stomp', host: 'localhost', autoReconnect: true, heartbeatOutgoing: 10000, heartbeatIncoming: 10000, listenHost: '127.0.0.1', listenPort: 61614, path: '/stomp' });
const copy = value => JSON.parse(JSON.stringify(value));
const newId = () => globalThis.crypto.randomUUID();
const emptyCredentials = () => ({ login: '', passcode: '', headers: [], requireAuthentication: false });
function safeConfig(source = {}, mode = 'client') {
  const config = Object.fromEntries(Object.entries(STOMP_DEFAULT_CONFIG).map(([key, value]) => [key, source[key] ?? value]));
  if (!['client', 'server'].includes(mode)) throw new Error('请选择客户端或服务端');
  let url;
  if (typeof config.url !== 'string' || config.url.length > 4096) throw new Error('连接地址最多 4096 字符');
  try { url = new URL(config.url); } catch { throw new Error('请输入有效的 ws/wss 地址'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /[?#]/.test(config.url)) throw new Error('连接地址不能包含凭据、查询或片段');
  if (typeof config.host !== 'string' || !config.host || config.host.length > 255 || /[\0\r\n]/.test(config.host)) throw new Error('Virtual host 格式无效');
  if (typeof config.listenHost !== 'string' || !config.listenHost || config.listenHost.length > 255 || /[\0\r\n]/.test(config.listenHost)) throw new Error('监听地址格式无效');
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) throw new Error('监听端口必须为 1..65535');
  if (typeof config.path !== 'string' || !config.path.startsWith('/') || config.path.length > 1024 || /[\0\r\n?#]/.test(config.path)) throw new Error('监听路径格式无效');
  if (typeof config.autoReconnect !== 'boolean' || ['heartbeatOutgoing', 'heartbeatIncoming'].some(key => !Number.isInteger(config[key]) || config[key] !== 0 && (config[key] < 1000 || config[key] > 60000))) throw new Error('心跳为 0（禁用）或 1000..60000ms，自动重连须为布尔值');
  return config;
}
function safeSubscription(source) {
  const destination = stompDestination(source?.destination); const id = source.id || newId(); const ack = source.ack ?? 'auto';
  if (typeof id !== 'string' || !id || id.length > 128 || /[\0\r\n]/.test(id) || !['auto', 'client', 'client-individual'].includes(ack)) throw new Error('订阅 ID 或 ACK 模式无效');
  return { id, destination, ack };
}
export function safeStompProfiles(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('最多保存 50 个 STOMP 配置');
  const ids = new Set();
  return input.map(source => {
    if (typeof source?.id !== 'string' || !/^[\w-]{1,80}$/.test(source.id) || ids.has(source.id) || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 100) throw new Error('STOMP 配置名称或 ID 无效');
    ids.add(source.id);
    const mode = source.mode ?? 'client'; const config = safeConfig(source.config, mode);
    const subscriptions = source.subscriptions ?? [];
    if (!Array.isArray(subscriptions) || subscriptions.length > STOMP_LIMITS.subscriptions) throw new Error('最多 100 个订阅');
    const rows = subscriptions.map(safeSubscription);
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('订阅 ID 重复');
    return { id: source.id, name: source.name.trim(), mode, config, subscriptions: rows };
  });
}

/** Shared client and broker controller over the dedicated, non-persistent native bridge. */
export function createStompWorkbench(runtime, { reactive = value => value, now = Date.now } = {}) {
  const state = reactive({ mode: 'client', config: { ...STOMP_DEFAULT_CONFIG }, credentials: emptyCredentials(), name: '新 STOMP 连接', profileId: '', profiles: [], status: 'disconnected', error: '', feedback: '', busy: '', subscriptions: [], messages: [], pendingMessages: [], peers: [], connectionId: '', sessionId: null });
  let disposed = false; let revision = 0; let current = null; let retryTimer; let tickTimer; let reconnectCount = 0; let pendingOpen = null; let displayBytes = 0;
  const displaySizes = new Map();
  const execute = request => runtime?.stomp?.execute ? runtime.stomp.execute(copy(request)) : Promise.reject(new Error('当前环境不支持 STOMP，请使用新版桌面应用'));
  const ignore = promise => Promise.resolve(promise).catch(() => {});
  const active = attempt => !disposed && current === attempt && attempt.revision === revision;
  function message(row) {
    const result = { id: newId(), body: '', destination: '', subscription: '', messageId: '', ackId: '', ack: 'auto', direction: 'in', status: 'received', createdAt: new Date(now()).toISOString(), ...row };
    const size = new TextEncoder().encode(result.body + result.destination + result.subscription + result.messageId + result.ackId).length + 256;
    displaySizes.set(result.id, size); displayBytes += size; state.messages.push(result);
    while (state.messages.length > STOMP_LIMITS.messages || displayBytes > STOMP_LIMITS.storedBytes) { const old = state.messages.shift(); displayBytes -= displaySizes.get(old.id) ?? 0; displaySizes.delete(old.id); }
    return result;
  }
  function updateMessage(id, changes) { const row = state.messages.find(item => item.id === id); if (row) Object.assign(row, changes); }
  function write(attempt, bytes, peerId) {
    if (!active(attempt) || !attempt.sessionId) return Promise.reject(new Error('STOMP 会话已结束'));
    return attempt.writes.write(bytes, peerId);
  }
  function sendFrame(attempt, command, headers = {}, body = '', peerId) { return write(attempt, encodeStompFrame(command, headers, body), peerId); }
  function stopAttempt(attempt) { attempt?.broker?.dispose(); attempt?.writes.close(); if (attempt) { for (const pending of attempt.pending.values()) updateMessage(pending.id, { status: 'stale' }); for (const receipt of attempt.receipts.values()) updateMessage(receipt.messageId, { status: 'receipt-timeout' }); attempt.receipts.clear(); attempt.pending.clear(); } for (const row of state.messages) if (row.direction === 'out' && row.status === 'sending') row.status = 'stale'; state.pendingMessages = []; }
  function terminal(attempt, reason, reconnect = true) {
    if (!active(attempt)) return;
    stopAttempt(attempt); current = null; state.sessionId = null; state.peers = []; state.busy = ''; state.error = reason;
    ignore(execute({ action: 'close', connectionId: attempt.id }));
    if (reconnect && attempt.mode === 'client' && attempt.config.autoReconnect && !disposed) {
      state.status = 'reconnecting';
      const delay = Math.min(1000 * 2 ** reconnectCount++, 15000);
      retryTimer = setTimeout(() => { retryTimer = null; if (!disposed && state.status === 'reconnecting') ignore(open(attempt.config, attempt.credentials, 'client')); }, delay);
    } else state.status = 'disconnected';
  }
  function tick() {
    if (disposed) return;
    const attempt = current;
    if (attempt?.sessionId && active(attempt)) {
      if (attempt.mode === 'server') attempt.broker?.tick();
      else {
        if (state.status === 'connecting' && now() - attempt.openedAt > 10000) terminal(attempt, 'STOMP 握手超时');
        else if (attempt.receiveInterval && now() - attempt.lastIn > attempt.receiveInterval * 2) terminal(attempt, 'STOMP 心跳超时');
        else if (attempt.protocolConnected && attempt.sendInterval && now() - attempt.lastOut >= attempt.sendInterval) ignore(write(attempt, Uint8Array.of(10)).catch(() => terminal(attempt, 'STOMP 心跳发送失败')));
        for (const [id, receipt] of attempt.receipts) if (now() - receipt.createdAt > 10000) { if (receipt.kind === 'subscription') { terminal(attempt, 'STOMP 订阅恢复回执超时'); break; } attempt.receipts.delete(id); updateMessage(receipt.messageId, { status: 'receipt-timeout' }); state.error = 'STOMP 回执超时'; }
      }
    }
    tickTimer = setTimeout(tick, 250); tickTimer.unref?.();
  }
  function ready(attempt) { if (!active(attempt)) return; state.status = 'connected'; state.busy = ''; state.error = ''; state.feedback = 'STOMP 1.2 已连接'; reconnectCount = 0; }
  function clientFrame(attempt, frame) {
    if (!frame.command) return;
    const { command, headers, body } = frame;
    if (command === 'ERROR') { terminal(attempt, 'STOMP 服务端拒绝请求（ERROR）', false); return; }
    if (!attempt.protocolConnected) {
      if (command !== 'CONNECTED' || headers.version !== '1.2') throw new Error('STOMP 1.2 协商失败');
      const [outgoing, incoming] = stompHeartbeat(headers['heart-beat']);
      attempt.sendInterval = incoming && attempt.config.heartbeatOutgoing ? Math.max(incoming, attempt.config.heartbeatOutgoing) : 0;
      attempt.receiveInterval = outgoing && attempt.config.heartbeatIncoming ? Math.max(outgoing, attempt.config.heartbeatIncoming) : 0;
      attempt.protocolConnected = true;
      if (!state.subscriptions.length) ready(attempt);
      else {
        state.feedback = 'STOMP 已连接，正在恢复订阅';
        for (const subscription of state.subscriptions) {
          const receipt = newId(); attempt.receipts.set(receipt, { kind: 'subscription', createdAt: now() });
          ignore(sendFrame(attempt, 'SUBSCRIBE', { ...subscription, receipt }).catch(() => terminal(attempt, '订阅恢复失败')));
        }
      }
      return;
    }
    if (command === 'RECEIPT') {
      const receipt = attempt.receipts.get(headers['receipt-id']);
      if (!receipt) return;
      attempt.receipts.delete(headers['receipt-id']);
      if (receipt.kind === 'subscription') { if (![...attempt.receipts.values()].some(item => item.kind === 'subscription')) ready(attempt); return; }
      updateMessage(receipt.messageId, { status: 'confirmed' }); state.feedback = 'STOMP 回执已确认'; return;
    }
    if (command !== 'MESSAGE') throw new Error('STOMP 服务端返回了不支持的命令');
    const subscription = state.subscriptions.find(row => row.id === headers.subscription);
    if (!subscription || !headers['message-id'] || headers['message-id'].length > 256 || subscription.ack !== 'auto' && (!headers.ack || headers.ack.length > 1024)) throw new Error('STOMP MESSAGE 缺少有效的订阅或确认标识');
    stompDestination(headers.destination);
    if (subscription.ack !== 'auto' && (attempt.pending.size >= STOMP_LIMITS.pending || attempt.pending.has(headers.ack))) throw new Error('STOMP 待确认消息超过限制或 ID 重复');
    const row = message({ body, destination: headers.destination, subscription: headers.subscription, messageId: headers['message-id'], ackId: headers.ack ?? '', ack: subscription.ack, direction: 'in' });
    if (subscription.ack !== 'auto') {
      const pending = { id: row.id, subscription: subscription.id, ack: subscription.ack, ackId: row.ackId, messageId: row.messageId, destination: row.destination, createdAt: row.createdAt };
      attempt.pending.set(headers.ack, pending); state.pendingMessages.push(copy(pending));
    }
  }
  function handleEvent(event) {
    const attempt = current; const payload = event?.payload;
    if (!attempt || !payload || !active(attempt) || payload.endpointId !== attempt.id) return;
    if (attempt.operationId && payload.operationId && attempt.operationId !== payload.operationId || attempt.sessionId && payload.sessionId && attempt.sessionId !== payload.sessionId) return;
    if (!attempt.sessionId) {
      if (attempt.early.length < 128) attempt.early.push(copy(event));
      else terminal(attempt, 'STOMP 原生事件队列超过限制', false);
      return;
    }
    if (event.type === 'peers' && attempt.mode === 'server') {
      const peers = Array.isArray(payload.peers) ? payload.peers.slice(0, STOMP_LIMITS.peers) : [];
      const ids = new Set(peers.map(row => row.id));
      for (const peer of state.peers) if (!ids.has(peer.id)) { attempt.writes.cancelPeer(peer.id); attempt.broker.removePeer(peer.id); }
      for (const peer of peers) attempt.broker.addPeer(peer.id);
      state.peers = peers; return;
    }
    if (event.type === 'status') {
      if (attempt.mode === 'server' && payload.log?.details?.peerId) return;
      if (['error', 'closed', 'disconnected'].includes(payload.status)) terminal(attempt, payload.status === 'error' ? 'STOMP WebSocket 连接失败' : 'STOMP WebSocket 已断开');
      return;
    }
    if (event.type !== 'frames' || !Array.isArray(payload.frames)) return;
    for (const frame of payload.frames.slice(0, 200)) {
      if (!active(attempt)) break;
      if (frame.direction && !['in', 'inbound', 'rx'].includes(frame.direction)) continue;
      const bytes = frame.bytes instanceof Uint8Array ? frame.bytes : new Uint8Array(frame.bytes);
      if (attempt.mode === 'server') {
        if (typeof frame.peerId === 'string') attempt.broker.receive(frame.peerId, bytes);
      } else {
        attempt.lastIn = now();
        try { for (const result of attempt.decoder.push(bytes)) { if (!active(attempt)) break; clientFrame(attempt, result); } }
        catch { terminal(attempt, 'STOMP 协议报文无效或超过限制', false); }
      }
    }
  }
  const unsubscribeEvents = runtime?.stomp?.onEvent?.(handleEvent);
  tick();
  async function open(config, credentials, mode) {
    if (disposed) return false;
    const attempt = { id: newId(), revision, config: copy(config), credentials: copy(credentials), mode, sessionId: null, operationId: null, protocolConnected: false, decoder: new StompDecoder(), receipts: new Map(), pending: new Map(), early: [], lastIn: now(), lastOut: now(), openedAt: now(), sendInterval: 0, receiveInterval: 0 };
    attempt.writes = createStompSendQueue({ isActive: () => active(attempt), send: async (bytes, peerId) => {
      await execute({ action: 'send', connectionId: attempt.id, bytes: [...bytes], messageType: 'binary', ...(peerId ? { peerId } : {}) });
      attempt.lastOut = now();
    } });
    current = attempt; state.connectionId = attempt.id; state.status = 'connecting'; state.busy = 'connect';
    const native = mode === 'client' ? { url: config.url, autoReconnect: false } : { listenHost: config.listenHost, listenPort: config.listenPort, path: config.path };
    Object.assign(native, { subprotocols: ['v12.stomp'], messageType: 'binary', heartbeat: { enabled: false, intervalMs: 30000, timeoutMs: 10000 } });
    try {
      const result = await execute({ action: 'open', connectionId: attempt.id, mode, config: native, ...(mode === 'client' ? { headers: snapshotWebSocketHeaders(credentials.headers) } : {}) });
      if (!active(attempt)) { await ignore(execute({ action: 'close', connectionId: attempt.id })); return false; }
      if (!result?.sessionId) throw new Error('Native session missing');
      attempt.sessionId = result.sessionId; attempt.operationId = result.operationId; state.sessionId = result.sessionId; attempt.openedAt = attempt.lastIn = now();
      if (mode === 'server') {
        attempt.broker = createStompBroker({ config, credentials, now,
          send: (peerId, bytes) => write(attempt, bytes, peerId),
          cancelPending: peerId => attempt.writes.cancelPeer(peerId),
          close: peerId => { ignore(attempt.writes.drain(peerId).then(() => { attempt.writes.cancelPeer(peerId); return active(attempt) && execute({ action: 'disconnectPeer', connectionId: attempt.id, peerId }); })); },
          onMessage: row => message(row),
          onError: error => { if (active(attempt)) state.error = `STOMP peer：${error.message}`; },
        });
        state.status = 'listening'; state.busy = ''; state.feedback = 'STOMP 本地测试 broker 正在监听';
      } else {
        await sendFrame(attempt, 'CONNECT', { 'accept-version': '1.2', host: config.host, 'heart-beat': `${config.heartbeatOutgoing},${config.heartbeatIncoming}`, ...(credentials.login ? { login: credentials.login } : {}), ...(credentials.passcode ? { passcode: credentials.passcode } : {}) });
      }
      for (const event of attempt.early) handleEvent(event); attempt.early = [];
      return true;
    } catch { if (active(attempt)) terminal(attempt, 'STOMP 连接失败，请检查地址、TLS、认证和运行环境', mode === 'client'); return false; }
  }
  async function operation(callback) {
    if (disposed) return false; state.error = ''; state.feedback = '';
    const token = revision;
    try { await callback(); return true; } catch (error) { if (!disposed && token === revision) state.error = error.message; return false; }
  }
  async function profileOperation(label, callback) {
    if (disposed || state.busy || state.status !== 'disconnected') return false;
    const token = ++revision; state.busy = label;
    try { return await operation(() => callback(() => !disposed && token === revision)); }
    finally { if (!disposed && token === revision) state.busy = ''; }
  }
  function connectedClient() { if (!current || current.mode !== 'client' || state.status !== 'connected') throw new Error('请先连接 STOMP 服务端'); return current; }
  async function acknowledge(messageId, command) {
    return operation(async () => {
      const attempt = connectedClient(); const match = [...attempt.pending].find(([, pending]) => pending.id === messageId);
      if (!match) throw new Error('该消息不在当前待确认列表');
      const [ackId, item] = match;
      const selected = new Map();
      for (const [id, pending] of attempt.pending) {
        if (id === ackId || item.ack === 'client' && pending.subscription === item.subscription) { selected.set(id, pending); attempt.pending.delete(id); updateMessage(pending.id, { status: command === 'ACK' ? 'acknowledged' : 'rejected' }); }
        if (id === ackId) break;
      }
      state.pendingMessages = state.pendingMessages.filter(pending => !selected.has(pending.ackId));
      try { await sendFrame(attempt, command, { id: ackId }); }
      catch (error) { if (active(attempt)) { for (const pending of selected.values()) updateMessage(pending.id, { status: 'stale' }); terminal(attempt, 'STOMP 确认发送失败'); } throw error; }
    });
  }
  const api = {
    state,
    async initialize() { return profileOperation('profiles', async active => { const settings = await runtime?.settings?.getAll?.() ?? {}; if (active()) state.profiles = safeStompProfiles(settings.stompProfiles ?? []); }); },
    async connect() {
      if (disposed || current || pendingOpen || state.busy || state.status !== 'disconnected') return false;
      state.error = ''; state.feedback = '';
      let opening;
      try {
        const config = safeConfig(state.config, state.mode); const credentials = copy(state.credentials);
        if (typeof credentials.login !== 'string' || credentials.login.length > 256 || typeof credentials.passcode !== 'string' || credentials.passcode.length > 4096 || /[\0\r\n]/.test(credentials.login + credentials.passcode) || typeof credentials.requireAuthentication !== 'boolean' || state.mode === 'server' && credentials.requireAuthentication && (!credentials.login || !credentials.passcode)) throw new Error('临时认证值无效；启用服务端认证需要填写账号和密码');
        snapshotWebSocketHeaders(credentials.headers); reconnectCount = 0; revision++;
        opening = open(config, credentials, state.mode); pendingOpen = opening; return await opening;
      } catch (error) { state.error = error.message; return false; }
      finally { if (pendingOpen === opening) pendingOpen = null; }
    },
    async disconnect() {
      clearTimeout(retryTimer); retryTimer = null; revision++; pendingOpen = null;
      const attempt = current; current = null; stopAttempt(attempt); state.status = 'disconnected'; state.busy = ''; state.sessionId = null; state.peers = [];
      if (attempt) await ignore(execute({ action: 'close', connectionId: attempt.id }));
      state.feedback = 'STOMP 已断开';
    },
    subscribe(subscription) { return operation(async () => { const attempt = connectedClient(); const row = safeSubscription(subscription); if (state.subscriptions.length >= STOMP_LIMITS.subscriptions || state.subscriptions.some(item => item.id === row.id)) throw new Error('订阅已达 100 个或 ID 重复'); state.subscriptions.push(row); try { await sendFrame(attempt, 'SUBSCRIBE', row); } catch (error) { if (active(attempt)) state.subscriptions = state.subscriptions.filter(item => item.id !== row.id); throw error; } }); },
    unsubscribe(id) { return operation(async () => { const attempt = connectedClient(); if (!state.subscriptions.some(row => row.id === id)) throw new Error('订阅不存在'); await sendFrame(attempt, 'UNSUBSCRIBE', { id }); if (active(attempt)) { state.subscriptions = state.subscriptions.filter(row => row.id !== id); for (const [ackId, pending] of attempt.pending) if (pending.subscription === id) { updateMessage(pending.id, { status: 'unsubscribed' }); attempt.pending.delete(ackId); } state.pendingMessages = state.pendingMessages.filter(pending => pending.subscription !== id); } }); },
    send({ destination, body = '', contentType = 'text/plain', receipt = true }) { return operation(async () => {
      stompDestination(destination, state.mode === 'server'); if (typeof body !== 'string' || typeof contentType !== 'string' || contentType.length > 256 || typeof receipt !== 'boolean') throw new Error('消息正文或内容类型无效');
      const attempt = current; if (!attempt || !['connected', 'listening'].includes(state.status)) throw new Error('请先连接或启动监听');
      if (attempt.mode === 'server') {
        const row = message({ destination, body, direction: 'out', status: 'sending' });
        try {
          const result = await attempt.broker.send({ destination, body, contentType });
          if (active(attempt)) {
            updateMessage(row.id, { status: result.queued ? 'queued' : result.deliveries ? 'sent' : 'no-subscribers' });
            if (!result.deliveries) state.feedback = result.queued ? '消息已入队，等待消费者' : '当前目的地没有订阅者，消息未投递';
          }
        } catch (error) { if (active(attempt)) updateMessage(row.id, { status: 'failed' }); throw error; }
        return;
      }
      if (receipt && attempt.receipts.size >= STOMP_LIMITS.pending) throw new Error('STOMP 待回执请求超过限制');
      const receiptId = receipt ? newId() : ''; const row = message({ destination, body, direction: 'out', status: 'sending' });
      if (receipt) attempt.receipts.set(receiptId, { messageId: row.id, createdAt: now() });
      try { await sendFrame(attempt, 'SEND', { destination, 'content-type': contentType, ...(receipt ? { receipt: receiptId } : {}) }, body); if (active(attempt) && state.messages.find(item => item.id === row.id)?.status === 'sending') updateMessage(row.id, { status: 'sent' }); }
      catch (error) { attempt.receipts.delete(receiptId); if (active(attempt)) updateMessage(row.id, { status: 'failed' }); throw error; }
    }); },
    ack: id => acknowledge(id, 'ACK'), nack: id => acknowledge(id, 'NACK'),
    clearMessages() { state.messages = []; displaySizes.clear(); displayBytes = 0; },
    async saveProfile(name = state.name) { return profileOperation('saveProfile', async active => {
      if (!runtime?.settings?.save) throw new Error('当前运行环境不支持保存配置');
      const id = state.profileId || newId(); const profiles = safeStompProfiles([...state.profiles.filter(item => item.id !== id), { id, name, mode: state.mode, config: state.config, subscriptions: state.subscriptions }]);
      await runtime.settings.save('stompProfiles', copy(profiles)); if (active()) { state.profiles = profiles; state.profileId = id; state.feedback = 'STOMP 配置已保存；账号、密码和请求头仅在当前会话使用'; }
    }); },
    async deleteProfile(id = state.profileId) { return profileOperation('deleteProfile', async active => { if (!runtime?.settings?.save) throw new Error('当前运行环境不支持保存配置'); const profiles = state.profiles.filter(item => item.id !== id); await runtime.settings.save('stompProfiles', copy(profiles)); if (active()) { state.profiles = profiles; if (state.profileId === id) state.profileId = ''; state.feedback = '配置已删除'; } }); },
    selectProfile(id) { if (state.status !== 'disconnected' || state.busy) return; const profile = state.profiles.find(item => item.id === id); state.profileId = profile?.id ?? ''; state.name = profile?.name ?? '新 STOMP 连接'; state.mode = profile?.mode ?? 'client'; state.config = { ...STOMP_DEFAULT_CONFIG, ...copy(profile?.config ?? {}) }; state.subscriptions = copy(profile?.subscriptions ?? []); state.credentials = emptyCredentials(); state.error = ''; state.feedback = ''; },
    async dispose() { if (disposed) return; disposed = true; clearTimeout(tickTimer); clearTimeout(retryTimer); await unsubscribeEvents?.(); await api.disconnect(); },
  };
  return api;
}
