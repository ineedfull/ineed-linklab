// Dedicated transient WebSocket sessions. Never attach this service to transport persistence.
const { randomUUID } = require('node:crypto');
const { WebSocketService } = require('./websocketService.cjs');
const { configFor, wsError } = require('./websocketConfig.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG_KEYS = new Set(['url', 'listenHost', 'listenPort', 'path', 'subprotocols', 'messageType', 'heartbeat', 'autoReconnect']);
class InboundWebSocketService extends WebSocketService {
  frame(session, direction, ...rest) {
    if (direction !== 'in') return;
    super.frame(session, direction, ...rest);
    // Protocol ACKs must reach the broker before a following peer-close notification.
    this.flushFrames(session);
  }
}
class StompTransport {
  constructor({ emitEvent } = {}) {
    if (typeof emitEvent !== 'function') throw new TypeError('emitEvent is required');
    this.emitEvent = emitEvent; this.connections = new Map(); this.stopped = false;
    this.service = new InboundWebSocketService({ emitEvent: (channel, payload) => this.forward(channel, payload) });
  }
  async execute(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || !UUID.test(request.connectionId)) throw wsError('IO_ERROR', 'A STOMP connection UUID is required');
    const { action, connectionId } = request;
    if (!['open', 'send', 'close', 'disconnectPeer'].includes(action)) throw wsError('IO_ERROR', 'Unknown STOMP transport action');
    if (action === 'close') {
      const record = this.connections.get(connectionId);
      if (record) {
        // Retire identity before await: late events cannot revive it or affect a replacement.
        this.connections.delete(connectionId);
        await this.service.close(record.nativeId);
      }
      return { endpointId: connectionId, closed: true };
    }
    if (this.stopped) throw wsError('IO_ERROR', 'STOMP transport is shut down');
    if (action === 'open') return this.open(request);
    const record = this.connections.get(connectionId);
    if (!record) throw wsError('PORT_NOT_FOUND', 'STOMP transport is not open');
    if (action === 'disconnectPeer') {
      peerIdentity(request.peerId);
      return { ...await this.service.disconnectPeer(record.nativeId, request.peerId), endpointId: connectionId };
    }
    if (!['text', 'binary'].includes(request.messageType)) throw wsError('IO_ERROR', 'STOMP messageType must be text or binary');
    if (record.mode === 'server') peerIdentity(request.peerId);
    else if (request.peerId !== undefined) throw wsError('IO_ERROR', 'Client sends cannot specify a peer');
    const ack = await this.service.send({ endpointId: record.nativeId, bytes: request.bytes, messageType: request.messageType,
      ...(record.mode === 'server' ? { target: { type: 'peer', peerIds: [request.peerId] } } : {}) });
    if (ack.failureCount) throw wsError('IO_ERROR', 'STOMP peer send failed');
    return { ...ack, endpointId: connectionId };
  }
  async open(request) {
    const { connectionId, mode, config, headers } = request;
    if (headers !== undefined && (!Array.isArray(headers) || headers.length > 32
      || headers.some(h => /^(content-length|transfer-encoding)$/i.test(h?.name)))) throw wsError('IO_ERROR', 'Invalid STOMP WebSocket headers');
    if (!['client', 'server'].includes(mode) || !config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !CONFIG_KEYS.has(key))) throw wsError('IO_ERROR', 'Invalid STOMP transport configuration');
    if (config.heartbeat && Object.keys(config.heartbeat).some(key => !['enabled', 'intervalMs', 'timeoutMs'].includes(key))) throw wsError('IO_ERROR', 'Invalid STOMP transport heartbeat');
    if (mode === 'client') {
      let url; try { url = new URL(config.url); } catch { throw wsError('IO_ERROR', 'Invalid STOMP WebSocket URL'); }
      if (url.username || url.password || url.search || url.hash || String(config.url).includes('?') || String(config.url).includes('#')) throw wsError('IO_ERROR', 'STOMP URL cannot contain credentials, query or fragment');
    }
    const nativeId = `stomp-${randomUUID()}`; const operationId = randomUUID();
    const endpoint = { id: nativeId, transport: `websocket-${mode}`, config };
    // Validate first, reserving capacity only for usable requests.
    configFor(endpoint, { websocketHeaders: headers });
    if (this.connections.has(connectionId)) throw wsError('PORT_BUSY', 'STOMP connection is already active');
    if (this.connections.size >= 4) throw wsError('IO_ERROR', 'STOMP native session limit is 4');
    const record = { nativeId, operationId, mode, connectionId };
    this.connections.set(connectionId, record);
    try {
      const ack = await this.service.open(endpoint, { operationId, websocketHeaders: headers });
      if (this.connections.get(connectionId) !== record || this.stopped) {
        await this.service.close(nativeId);
        throw wsError('OPEN_CANCELLED', 'STOMP open cancelled');
      }
      return { ...ack, endpointId: connectionId };
    } catch (error) {
      if (this.connections.get(connectionId) === record) this.connections.delete(connectionId);
      throw error;
    }
  }
  forward(channel, payload) {
    const record = [...this.connections.values()].find(r => r.nativeId === payload.endpointId && r.operationId === payload.operationId);
    if (!record) return;
    const type = channel.replace('transport:', '');
    if (!['status', 'frames', 'peers'].includes(type)) return;
    const safe = { ...payload, endpointId: record.connectionId };
    if (type === 'frames') { safe.frames = payload.frames.filter(f => f.direction === 'in'); if (!safe.frames.length) return; }
    // STOMP credentials can be echoed in arbitrary remote close reasons; never expose them.
    if (type === 'status' && payload.log) safe.log = { ...payload.log, details: payload.log.details ? { ...payload.log.details, closeReason: '' } : null };
    if (type === 'status' && ['closed', 'error'].includes(payload.status)) this.connections.delete(record.connectionId);
    try { this.emitEvent({ type, payload: safe }); } catch { /* Observer isolation; no frame logging. */ }
  }
  async shutdown() { this.stopped = true; this.connections.clear(); await this.service.shutdown(); }
}
function peerIdentity(peerId) { if (typeof peerId !== 'string' || !peerId.trim() || peerId.length > 256) throw wsError('IO_ERROR', 'A valid STOMP peer ID is required'); }
module.exports = { StompTransport };
