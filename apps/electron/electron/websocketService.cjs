const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { configFor, payloadFor, wsError, MAX_MESSAGE, MAX_PENDING } = require('./websocketConfig.cjs');
const HANDSHAKE_MS = 15000;
const WRITE_MS = 10000;
const MAX_PEERS = 64;

class WebSocketService {
  constructor({ emitEvent, clock = Date.now, reportEventError = () => {} } = {}) {
    if (typeof emitEvent !== 'function') throw new TypeError('emitEvent is required');
    this.emitEvent = emitEvent; this.clock = clock; this.reportEventError = reportEventError;
    this.sessions = new Map(); this.stopped = false;
  }
  async open(endpoint, options = {}) {
    if (this.stopped) throw wsError('IO_ERROR', 'WebSocket service is shut down');
    if (typeof endpoint?.id !== 'string' || !endpoint.id || typeof options.operationId !== 'string' || !options.operationId) throw wsError('IO_ERROR', 'Endpoint and operation identities are required');
    const config = configFor(endpoint, options);
    if (this.sessions.has(endpoint.id)) throw wsError('PORT_BUSY', 'WebSocket endpoint is already open');
    const session = {
      endpointId: endpoint.id, operationId: options.operationId, sessionId: `ws-${randomUUID()}`,
      config, phase: 'opening', active: true, peers: new Map(), rawSockets: new Set(),
      frames: [], frameBytes: 0, frameTimer: null, rejectOpening: null, handshakeTimers: new Map(),
      // Only retained until this session closes; never forwarded to logs/history.
      redactions: [...Object.values(config.headers ?? {})],
      suppressCloseReason: Object.keys(config.headers ?? {}).length > 0 || !!(config.url && new URL(config.url).search),
    };
    if (config.url) for (const value of new URL(config.url).searchParams.values()) if (value) session.redactions.push(value);
    this.sessions.set(endpoint.id, session);
    this.status(session, 'opening', 'Opening WebSocket endpoint');
    try {
      if (config.url) await this.openClient(session);
      else await this.openServer(session);
      if (!session.active) throw wsError('OPEN_CANCELLED', 'WebSocket open cancelled');
      session.phase = config.url ? 'open' : 'listening';
      this.status(session, session.phase, config.url ? 'WebSocket connected' : 'WebSocket listening', {
        ...(config.url ? { url: config.safeUrl, protocol: session.socket.protocol } : { host: config.host, port: session.server.address().port, path: config.path }),
      });
      return { endpointId: session.endpointId, operationId: session.operationId, sessionId: session.sessionId };
    } catch (reason) {
      if (session.active) {
        this.status(session, 'error', 'WebSocket connection or handshake failed', null, wsError('IO_ERROR', 'WebSocket connection or handshake failed'));
        await this.retire(session);
      }
      if (reason.code === 'OPEN_CANCELLED') throw reason;
      throw wsError('IO_ERROR', 'WebSocket connection or handshake failed');
    }
  }
  openClient(session) {
    const { config } = session;
    const socket = new WebSocket(config.url, config.protocols, {
      headers: config.headers, maxPayload: MAX_MESSAGE, perMessageDeflate: false,
      handshakeTimeout: HANDSHAKE_MS, followRedirects: false,
    });
    session.socket = socket;
    this.attach(session, { id: null, socket, pendingBytes: 0 });
    return opening(session, socket, 'open');
  }
  openServer(session) {
    const { config } = session;
    const server = http.createServer((_request, response) => response.writeHead(426).end());
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false,
      handleProtocols: offered => config.protocols.find(p => offered.has(p)) || false,
    });
    session.server = server; session.wss = wss;
    server.on('connection', socket => {
      if (!session.active || session.rawSockets.size >= MAX_PEERS) { socket.destroy(); return; }
      session.rawSockets.add(socket);
      const deadline = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
      session.handshakeTimers.set(socket, deadline);
      socket.on('error', () => {});
      socket.once('close', () => {
        clearTimeout(deadline); session.handshakeTimers.delete(socket); session.rawSockets.delete(socket);
      });
    });
    server.on('upgrade', (request, socket, head) => {
      if (!session.active || !session.rawSockets.has(socket)) { socket.destroy(); return; }
      let path; try { path = new URL(request.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
      const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
      const key = request.headers['sec-websocket-key'];
      const keyCount = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'sec-websocket-key').length;
      // A nonce is exactly 16 bytes encoded as canonical Base64 (RFC 6455).
      const nonce = typeof key === 'string' ? Buffer.from(key, 'base64') : Buffer.alloc(0);
      const validKey = keyCount === 1 && nonce.length === 16 && nonce.toString('base64') === key;
      if (!validKey || path !== config.path || (config.protocols.length && !config.protocols.some(p => offered.includes(p)))) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      try {
        wss.handleUpgrade(request, socket, head, ws => {
          if (!session.active || session.peers.size >= MAX_PEERS) { ws.terminate(); return; }
          clearTimeout(session.handshakeTimers.get(socket)); session.handshakeTimers.delete(socket);
          const peer = { id: `ws-peer-${randomUUID()}`, socket: ws, pendingBytes: 0,
            remoteAddress: `${socket.remoteAddress}:${socket.remotePort}`, connectedAt: this.clock() };
          session.peers.set(peer.id, peer); this.attach(session, peer); this.peers(session);
        });
      } catch { socket.destroy(); }
    });
    const ready = opening(session, server, 'listening');
    server.listen(config.port, config.host);
    return ready;
  }
  attach(session, peer) {
    const socket = peer.socket;
    socket.on('message', (bytes, binary) => {
      if (!session.active || (peer.id && session.peers.get(peer.id) !== peer)) return;
      this.frame(session, 'in', bytes, binary ? 'binary' : 'text', peer.id);
    });
    socket.on('error', () => {
      if (!session.active || session.phase === 'opening') return;
      this.status(session, peer.id ? 'listening' : 'error', 'WebSocket protocol or I/O error', { peerId: peer.id },
        peer.id ? null : wsError('IO_ERROR', 'WebSocket protocol or I/O error'));
      if (socket.readyState === WebSocket.CLOSING) {
        // Let the SDK transmit its RFC close code (1007/1009), with a bound
        // for peers that never acknowledge the close handshake.
        peer.protocolCloseTimer = setTimeout(() => socket.terminate(), 500);
      } else socket.terminate();
    });
    socket.once('close', (code, reason) => {
      this.stopHeartbeat(peer);
      clearTimeout(peer.protocolCloseTimer);
      if (!session.active) return;
      const details = { closeCode: code, closeReason: redact(session, reason?.toString() ?? ''), peerId: peer.id };
      if (peer.id) {
        if (session.peers.delete(peer.id)) { this.peers(session); this.status(session, 'listening', 'WebSocket peer closed', details); }
      } else {
        this.flushFrames(session); session.active = false;
        if (this.sessions.get(session.endpointId) === session) this.sessions.delete(session.endpointId);
        this.status(session, 'closed', 'WebSocket connection closed', details);
        session.redactions.length = 0;
      }
    });
    const startHeartbeat = () => {
      if (!session.active || !session.config.heartbeat.enabled) return;
      const { intervalMs, timeoutMs } = session.config.heartbeat;
      socket.on('pong', () => { clearTimeout(peer.pongTimer); peer.pongTimer = null; });
      peer.pingTimer = setInterval(() => {
        if (!session.active || socket.readyState !== WebSocket.OPEN || peer.pongTimer) return;
        try { socket.ping(); } catch { socket.terminate(); return; }
        peer.pongTimer = setTimeout(() => {
          peer.pongTimer = null;
          if (!session.active) return;
          const error = wsError('IO_ERROR', 'WebSocket heartbeat timed out');
          this.status(session, peer.id ? 'listening' : 'error', error.message, { peerId: peer.id }, peer.id ? null : error, 'HEARTBEAT_TIMEOUT');
          socket.terminate();
        }, timeoutMs);
        peer.pongTimer.unref?.();
      }, intervalMs); peer.pingTimer.unref?.();
    };
    if (socket.readyState === WebSocket.OPEN) startHeartbeat();
    else socket.once('open', startHeartbeat);
    if (!peer.id) session.clientPeer = peer;
  }
  stopHeartbeat(peer) { clearInterval(peer?.pingTimer); clearTimeout(peer?.pongTimer); }
  async send(request) {
    const session = this.requireSession(request?.endpointId);
    const type = request.messageType ?? session.config.messageType;
    const bytes = payloadFor(request.bytes, type);
    const targets = session.config.url ? [session.clientPeer] : this.targets(session, request.target);
    const results = await Promise.all(targets.map(async peer => {
      try {
        await this.write(session, peer, bytes, type);
        this.frame(session, 'out', bytes, type, peer.id);
        return { peerId: peer.id, ok: true, byteCount: bytes.length };
      } catch (error) { return { peerId: peer.id, ok: false, error: { code: error.code ?? 'IO_ERROR', message: 'WebSocket send failed' } }; }
    }));
    if (session.config.url && !results[0].ok) throw wsError('IO_ERROR', 'WebSocket send failed');
    return { endpointId: session.endpointId, sessionId: session.sessionId, byteCount: bytes.length,
      ...(session.config.url ? {} : { peerCount: results.length, successCount: results.filter(r => r.ok).length,
        failureCount: results.filter(r => !r.ok).length, peerResults: results }) };
  }
  targets(session, target) {
    if (session.phase !== 'listening') throw wsError('IO_ERROR', 'WebSocket server is not listening');
    const ids = target?.type === 'broadcast' ? [...session.peers.keys()] : target?.type === 'peer' ? target.peerIds : [target?.peerId];
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PEERS || new Set(ids).size !== ids.length) throw wsError('IO_ERROR', 'Select valid WebSocket peers');
    if (ids.some(id => typeof id !== 'string' || !id.trim())) throw wsError('IO_ERROR', 'Invalid WebSocket peer ID');
    return ids.map(id => {
      const peer = session.peers.get(id);
      // Peer loss can race a multi-target send. Keep a per-target failure
      // while allowing the remaining selected peers to receive their message.
      return peer ?? { id, socket: null, pendingBytes: 0 };
    });
  }
  write(session, peer, bytes, type) {
    const socket = peer?.socket;
    if (!session.active || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(wsError('IO_ERROR', 'WebSocket is not open'));
    if (peer.pendingBytes + socket.bufferedAmount + bytes.length > MAX_PENDING) return Promise.reject(wsError('IO_ERROR', 'WebSocket pending send limit exceeded'));
    peer.pendingBytes += bytes.length;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer); peer.pendingBytes -= bytes.length;
        socket.off('close', closed);
        if (error || !session.active) reject(wsError('IO_ERROR', 'WebSocket send failed')); else resolve();
      };
      const closed = () => finish(true);
      const timer = setTimeout(() => { socket.terminate(); finish(true); }, WRITE_MS);
      socket.once('close', closed);
      try { socket.send(bytes, { binary: type === 'binary' }, finish); } catch { finish(true); }
    });
  }
  async disconnectPeer(endpointId, peerId) {
    const session = this.requireSession(endpointId); const peer = session.peers.get(peerId);
    if (!peer) throw wsError('PORT_NOT_FOUND', 'WebSocket peer is not connected');
    await closeSocket(peer.socket); return { endpointId, peerId, disconnected: true };
  }
  async cancelOpen(endpointId, { operationId } = {}) {
    const session = this.sessions.get(endpointId);
    const cancelled = !!session && session.phase === 'opening' && session.operationId === operationId;
    if (cancelled) await this.close(endpointId);
    return { endpointId, operationId, cancelled };
  }
  async close(endpointId) {
    const session = this.sessions.get(endpointId);
    if (session) {
      await this.retire(session);
      this.status(session, 'closed', 'WebSocket endpoint closed', { closeCode: 1000, closeReason: 'User closed' });
      this.peers(session);
    }
    return { endpointId, closed: true };
  }
  async retire(session) {
    session.active = false;
    if (this.sessions.get(session.endpointId) === session) this.sessions.delete(session.endpointId);
    session.rejectOpening?.(wsError('OPEN_CANCELLED', 'WebSocket open cancelled'));
    session.rejectOpening = null;
    this.stopHeartbeat(session.clientPeer);
    for (const peer of session.peers.values()) this.stopHeartbeat(peer);
    this.flushFrames(session);
    await Promise.allSettled([session.socket, ...[...session.peers.values()].map(p => p.socket)].filter(Boolean).map(closeSocket));
    session.peers.clear();
    for (const timer of session.handshakeTimers.values()) clearTimeout(timer); session.handshakeTimers.clear();
    for (const socket of session.rawSockets) socket.destroy(); session.rawSockets.clear();
    if (session.server) await new Promise(resolve => { try { session.server.close(() => resolve()); } catch { resolve(); } });
    session.wss?.close(); session.redactions.length = 0;
  }
  closeAll() { return Promise.all([...this.sessions.keys()].map(id => this.close(id))); }
  shutdown() { this.stopped = true; return this.closeAll(); }
  forceShutdown() { return this.shutdown(); }
  requireSession(id) { const s = this.sessions.get(id); if (!s) throw wsError('PORT_NOT_FOUND', 'WebSocket endpoint is not open'); return s; }
  frame(session, direction, bytes, messageType, peerId) {
    if (!session.active) return;
    const frame = { direction, bytes: [...bytes], messageType, framing: 'websocket', createdAt: this.clock(), ...(peerId ? { peerId } : {}) };
    session.frames.push(frame); session.frameBytes += bytes.length;
    if (session.frames.length >= 200 || session.frameBytes >= MAX_PENDING) this.flushFrames(session);
    else if (!session.frameTimer) session.frameTimer = setTimeout(() => this.flushFrames(session), 200);
  }
  flushFrames(session) {
    clearTimeout(session.frameTimer); session.frameTimer = null;
    if (!session.frames.length) return;
    const frames = session.frames; session.frames = []; session.frameBytes = 0;
    this.publish('transport:frames', { ...identity(session), frames });
  }
  status(session, status, message, details = null, error = null, code = null) {
    const createdAt = this.clock();
    if (code) details = { ...details, reason: code };
    this.publish('transport:status', { ...identity(session), sessionId: ['opening', 'closed'].includes(status) ? null : session.sessionId,
      status, error: error ? { code: error.code, message: error.message } : null, createdAt,
      log: { source: 'websocket', level: error ? 'error' : ['opening', 'closing'].includes(status) ? 'debug' : 'info', code: error?.code ?? null, message, details, createdAt } });
  }
  peers(session) {
    this.publish('transport:peers', { ...identity(session), peers: [...session.peers.values()].map(({id,remoteAddress,connectedAt}) => ({id,remoteAddress,connectedAt})) });
  }
  publish(channel, payload) { try { this.emitEvent(channel, payload); } catch (error) { try { this.reportEventError(error, {channel}); } catch { /* Observer isolation. */ } } }
}
function identity(session) { return { endpointId: session.endpointId, operationId: session.operationId, sessionId: session.sessionId }; }
function redact(session, text) {
  if (session.suppressCloseReason) return text ? '[redacted: session has headers or query parameters]' : '';
  let clean = text.slice(0, 512);
  for (const value of session.redactions) if (value) clean = clean.split(value).join('[redacted]');
  return clean;
}
function opening(session, resource, readyEvent) {
  return new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timer); session.rejectOpening = null;
      resource.off(readyEvent, ready); resource.off('error', failed); resource.off('close', closed);
      if (error) reject(error); else resolve();
    };
    const ready = () => done(); const failed = () => done(wsError('IO_ERROR', 'WebSocket handshake failed'));
    const closed = () => done(wsError('IO_ERROR', 'WebSocket closed during handshake'));
    const timer = setTimeout(failed, HANDSHAKE_MS);
    session.rejectOpening = done;
    resource.once(readyEvent, ready); resource.once('error', failed); resource.once('close', closed);
  });
}
function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  if (socket.readyState === WebSocket.CONNECTING) { socket.terminate(); return Promise.resolve(); }
  return new Promise(resolve => {
    const timer = setTimeout(() => { socket.terminate(); resolve(); }, 500);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    try { socket.close(1000, 'LinkLab closed'); } catch { clearTimeout(timer); socket.terminate(); resolve(); }
  });
}
module.exports = { WebSocketService };
