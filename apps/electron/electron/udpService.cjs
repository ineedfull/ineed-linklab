const dgram = require('node:dgram');

const FRAME_BATCH_MILLIS = 200;
const FRAME_BATCH_LIMIT = 200;

class UdpService {
  constructor({
    clock = Date.now,
    emitEvent,
    timers = globalThis,
    reportEventError = () => {},
    dgramModule = dgram,
  } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (typeof emitEvent !== 'function') throw new TypeError('emitEvent is required');
    if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
      throw new TypeError('timers must provide setTimeout and clearTimeout');
    }
    if (typeof reportEventError !== 'function') throw new TypeError('reportEventError must be a function');
    if (typeof dgramModule?.createSocket !== 'function') {
      throw new TypeError('dgramModule must provide createSocket');
    }
    this.clock = clock;
    this.emitEvent = emitEvent;
    this.timers = timers;
    this.reportEventError = reportEventError;
    this.dgram = dgramModule;
    this.sessions = new Map();
    this.nextSessionId = 1;
    this.stopped = false;
  }

  async open(endpoint, { operationId } = {}) {
    requireNonblankString(operationId, 'operationId');
    if (this.stopped) throw udpError('IO_ERROR', 'UDP service is shut down');
    if (endpoint?.transport === 'udp-client') return this.openClient(endpoint, operationId);
    if (endpoint?.transport === 'udp-server') return this.openServer(endpoint, operationId);
    throw udpError('IO_ERROR', `Endpoint ${endpoint?.id ?? ''} is not a UDP endpoint`);
  }

  async openClient(endpoint, operationId) {
    const endpointId = requireNonblankString(endpoint?.id, 'endpoint.id');
    if (this.sessions.has(endpointId)) throw udpError('PORT_BUSY', `Endpoint ${endpointId} is already open`);
    const config = udpClientOptions(endpoint.config);
    const session = this.createSession('client', endpoint, operationId);
    session.target = { host: config.targetHost, port: config.targetPort };
    this.sessions.set(endpointId, session);
    session.batcher = createFrameBatcher(this, session);
    try {
      throwIfCancelled(session);
      this.emitStatus(session, 'opening', {
        level: 'debug',
        message: `Binding UDP client: ${config.bindHost}:${config.bindPort}`,
        details: { bindHost: config.bindHost, bindPort: config.bindPort },
      });

      const socket = this.dgram.createSocket({ type: 'udp4' });
      session.socket = socket;
      await bindSocket(session, socket, config.bindHost, config.bindPort);
      throwIfCancelled(session);
      session.phase = 'open';
      attachSocketReaders(this, session, socket);
      this.emitStatus(session, 'open', {
        message: `UDP client ready: ${config.bindHost}:${socket.address().port}`,
        details: { bindHost: config.bindHost, bindPort: socket.address().port, targetHost: config.targetHost, targetPort: config.targetPort },
      });
      return { sessionId: session.sessionId };
    } catch (reason) {
      if (isOpenCancelled(reason)) {
        destroySocket(session.socket);
        cleanupSession(session);
        if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
        throw reason;
      }
      const error = mapUdpError(reason);
      if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
      destroySocket(session.socket);
      cleanupSession(session);
      this.emitStatus(session, 'error', {
        error: plainError(error),
        code: error.code,
        message: `UDP client bind failed: ${config.bindHost}:${config.bindPort}`,
        details: { bindHost: config.bindHost, bindPort: config.bindPort },
      });
      throw error;
    }
  }

  async openServer(endpoint, operationId) {
    const endpointId = requireNonblankString(endpoint?.id, 'endpoint.id');
    if (this.sessions.has(endpointId)) throw udpError('PORT_BUSY', `Endpoint ${endpointId} is already open`);
    const config = udpServerOptions(endpoint.config);
    const session = this.createSession('server', endpoint, operationId);
    if (config.targetHost) session.target = { host: config.targetHost, port: config.targetPort };
    this.sessions.set(endpointId, session);
    session.batcher = createFrameBatcher(this, session);
    session.peers = new Map();
    session.nextPeerId = 1;
    try {
      throwIfCancelled(session);
      this.emitStatus(session, 'opening', {
        level: 'debug',
        message: `Binding UDP server: ${config.bindHost}:${config.bindPort}`,
        details: { bindHost: config.bindHost, bindPort: config.bindPort },
      });

      const socket = this.dgram.createSocket({ type: 'udp4' });
      session.socket = socket;
      await bindSocket(session, socket, config.bindHost, config.bindPort);
      throwIfCancelled(session);
      session.phase = 'listening';
      attachSocketReaders(this, session, socket);
      this.emitStatus(session, 'listening', {
        message: `UDP server listening: ${config.bindHost}:${socket.address().port}`,
        details: { bindHost: config.bindHost, bindPort: socket.address().port },
      });
      return { sessionId: session.sessionId };
    } catch (reason) {
      if (isOpenCancelled(reason)) {
        destroySocket(session.socket);
        cleanupSession(session);
        if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
        throw reason;
      }
      const error = mapUdpError(reason);
      if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
      destroySocket(session.socket);
      cleanupSession(session);
      this.emitStatus(session, 'error', {
        error: plainError(error),
        code: error.code,
        message: `UDP server bind failed: ${config.bindHost}:${config.bindPort}`,
        details: { bindHost: config.bindHost, bindPort: config.bindPort },
      });
      throw error;
    }
  }

  createSession(kind, endpoint, operationId) {
    const session = {
      kind,
      endpoint,
      endpointId: endpoint.id,
      operationId,
      sessionId: `udp-${this.nextSessionId}`,
      service: this,
      phase: 'opening',
      cancelled: false,
      closing: false,
      closed: false,
      socket: null,
      batcher: null,
      target: null,
      peers: null,
      nextPeerId: 0,
      listeners: null,
    };
    session.cancelPromise = new Promise((resolve, reject) => {
      session.resolveCancel = resolve;
      session.rejectCancel = reject;
    });
    session.cancelPromise.catch(() => {});
    this.nextSessionId += 1;
    return session;
  }

  async send(request) {
    const session = this.requireSession(request?.endpointId);
    if (session.kind === 'client') return this.sendClient(session, request.bytes);
    return this.sendServer(session, request);
  }

  async sendClient(session, value) {
    const bytes = copyBytes(value, 'request.bytes');
    if (session.phase !== 'open' || !session.socket) {
      throw udpError('IO_ERROR', `Endpoint ${session.endpointId} is not open`);
    }
    try {
      await sendDatagram(session.socket, bytes, session.target);
    } catch (reason) {
      const error = mapUdpError(reason);
      reportSocketFailure(this, session, error);
      throw error;
    }
    session.batcher.enqueue('out', bytes, null);
    return { endpointId: session.endpointId, sessionId: session.sessionId, byteCount: bytes.byteLength };
  }

  async sendServer(session, request) {
    if (session.phase !== 'listening') {
      throw udpError('IO_ERROR', `Endpoint ${session.endpointId} is not listening`);
    }
    const bytes = copyBytes(request?.bytes, 'request.bytes');
    const targets = serverSendTargets(session, request);
    try {
      await Promise.all(targets.map((peer) => sendDatagram(session.socket, bytes, peer.address)));
    } catch (reason) {
      const error = mapUdpError(reason);
      reportSocketFailure(this, session, error);
      throw error;
    }
    for (const peer of targets) session.batcher.enqueue('out', bytes, peer.id);
    return {
      endpointId: session.endpointId,
      sessionId: session.sessionId,
      byteCount: bytes.byteLength,
      peerCount: targets.length,
    };
  }

  async disconnectPeer() {
    throw udpError('IO_ERROR', 'UDP peers cannot be disconnected; they are passive and derived from incoming traffic');
  }

  async cancelOpen(endpointId, { operationId } = {}) {
    requireNonblankString(operationId, 'operationId');
    const session = this.sessions.get(endpointId);
    const cancelled = session?.operationId === operationId;
    if (cancelled) await this.close(endpointId);
    return { endpointId, operationId, cancelled };
  }

  async close(endpointId) {
    const session = this.sessions.get(endpointId);
    if (!session) return { closed: true, endpointId };
    this.sessions.delete(endpointId);
    this.emitStatus(session, 'closing', {
      level: 'debug',
      message: `Closing UDP endpoint: ${endpointId}`,
      details: { endpointId },
    });
    await closeSession(session);
    this.emitStatus(session, 'closed', {
      message: `UDP endpoint closed: ${endpointId}`,
      details: { endpointId },
    });
    this.emitPeers(session);
    return { closed: true, endpointId };
  }

  async closeAll() {
    let firstError = null;
    for (const endpointId of [...this.sessions.keys()]) {
      try {
        await this.close(endpointId);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  async shutdown() {
    this.stopped = true;
    await this.closeAll();
  }

  forceShutdown() {
    this.stopped = true;
    for (const session of this.sessions.values()) {
      this.emitStatus(session, 'closing', {
        level: 'debug',
        message: `Closing UDP endpoint: ${session.endpointId}`,
        details: { endpointId: session.endpointId },
      });
      forceCloseSession(session);
      this.emitStatus(session, 'closed', {
        message: `UDP endpoint closed: ${session.endpointId}`,
        details: { endpointId: session.endpointId },
      });
    }
    this.sessions.clear();
    return [];
  }

  requireSession(endpointId) {
    const session = this.sessions.get(endpointId);
    if (!session) throw udpError('PORT_NOT_FOUND', `Endpoint ${endpointId} is not open`);
    return session;
  }

  emitStatus(session, status, {
    error = null,
    level = status === 'error' ? 'error' : 'info',
    code = null,
    message,
    details = null,
    peerId = null,
  } = {}) {
    const createdAt = this.clock();
    const log = message ? {
      level,
      source: 'udp',
      ...(peerId === null ? {} : { peerId }),
      code,
      message,
      details,
      createdAt,
    } : null;
    this.publishEvent('transport:status', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: status === 'opening' || status === 'closed' ? null : session.sessionId,
      status,
      error,
      createdAt,
      log,
    });
  }

  emitFrames(session, frames) {
    if (frames.length === 0) return;
    this.publishEvent('transport:frames', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: session.sessionId,
      frames,
    });
  }

  emitPeers(session) {
    const peers = session.kind === 'server'
      ? [...session.peers.values()].map(({ id, remoteAddress, connectedAt }) => ({ id, remoteAddress, connectedAt }))
      : [];
    this.publishEvent('transport:peers', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: session.sessionId,
      peers,
    });
  }

  publishEvent(channel, payload) {
    try {
      this.emitEvent(channel, payload);
    } catch (error) {
      try {
        this.reportEventError(error, { channel, payload });
      } catch {
        // Observer reporting is isolated from transport resource ownership.
      }
    }
  }
}

function attachSocketReaders(service, session, socket) {
  const onMessage = (chunk, rinfo) => {
    try {
      const bytes = copyBytes(chunk, 'udp input');
      if (session.kind === 'server') {
        const peerId = ensurePeer(session, rinfo);
        session.batcher.enqueue('in', bytes, peerId);
      } else {
        session.batcher.enqueue('in', bytes, null);
      }
    } catch (reason) {
      reportSocketFailure(service, session, mapUdpError(reason));
    }
  };
  const onError = (reason) => {
    if (session.closing || session.closed) return;
    reportSocketFailure(service, session, mapUdpError(reason));
  };
  const onClose = () => {
    if (session.closing || session.closed) return;
    service.sessions.delete(session.endpointId);
    cleanupSession(session);
    service.emitStatus(session, 'closed', {
      message: `UDP endpoint closed: ${session.endpointId}`,
      details: { endpointId: session.endpointId },
    });
  };
  socket.on('message', onMessage);
  socket.on('error', onError);
  socket.on('close', onClose);
  session.listeners = { onMessage, onError, onClose };
}

function ensurePeer(session, rinfo) {
  const remoteAddress = `${rinfo.address}:${rinfo.port}`;
  for (const peer of session.peers.values()) {
    if (peer.address.host === rinfo.address && peer.address.port === rinfo.port) {
      return peer.id;
    }
  }
  const peerId = `udp-peer-${session.nextPeerId}`;
  session.nextPeerId += 1;
  session.peers.set(peerId, {
    id: peerId,
    remoteAddress,
    address: { host: rinfo.address, port: rinfo.port },
    connectedAt: session.service.clock(),
  });
  session.service.emitPeers(session);
  session.service.emitStatus(session, 'listening', {
    message: `UDP peer discovered: ${remoteAddress}`,
    details: { peerId, remoteAddress },
    peerId,
  });
  return peerId;
}

function reportSocketFailure(service, session, error) {
  if (session.closed || session.closing) return;
  service.emitStatus(session, 'error', {
    error: plainError(error),
    code: error.code,
    message: `UDP I/O failed: ${session.endpointId}`,
    details: { endpointId: session.endpointId },
  });
  void service.close(session.endpointId).catch(() => {});
}

async function closeSession(session) {
  if (session.closed) return;
  if (session.phase === 'opening' && session.cancelled === false) {
    session.cancelled = true;
    session.rejectCancel?.(udpError('OPEN_CANCELLED', 'UDP open cancelled'));
  }
  session.closing = true;
  cleanupSession(session, { flush: true });
  if (session.phase === 'opening') {
    destroySocket(session.socket);
  } else if (session.socket) {
    await closeSocket(session.socket);
  }
  if (session.peers) session.peers.clear();
  session.closed = true;
  session.closing = false;
}

function forceCloseSession(session) {
  if (session.closed) return;
  if (session.phase === 'opening' && session.cancelled === false) {
    session.cancelled = true;
    session.rejectCancel?.(udpError('OPEN_CANCELLED', 'UDP open cancelled'));
  }
  session.closing = true;
  cleanupSession(session, { flush: true });
  destroySocket(session.socket);
  session.closed = true;
  session.closing = false;
}

function cleanupSession(session) {
  session.batcher?.clear();
  if (session.listeners && session.socket) {
    session.socket.removeListener('message', session.listeners.onMessage);
    session.socket.removeListener('error', session.listeners.onError);
    session.socket.removeListener('close', session.listeners.onClose);
  }
  session.listeners = null;
}

function createFrameBatcher(service, session) {
  let timer = null;
  let pending = [];
  const flush = () => {
    if (timer !== null) {
      service.timers.clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const frames = pending;
    pending = [];
    service.emitFrames(session, frames);
  };
  return {
    enqueue(direction, value, peerId = null) {
      const bytes = copyBytes(value, 'frame bytes');
      pending.push({ direction, peerId, bytes: [...bytes], createdAt: service.clock() });
      if (pending.length >= FRAME_BATCH_LIMIT) {
        flush();
        return;
      }
      if (timer !== null) return;
      timer = service.timers.setTimeout(flush, FRAME_BATCH_MILLIS);
    },
    flush,
    clear() {
      flush();
      if (timer !== null) {
        service.timers.clearTimeout(timer);
        timer = null;
      }
      pending = [];
    },
  };
}

function serverSendTargets(session, request) {
  if (request?.target?.broadcast || request?.broadcast) {
    const peers = [...session.peers.values()];
    if (peers.length === 0) throw udpError('PORT_NOT_FOUND', `Endpoint ${session.endpointId} has no known peers`);
    return peers;
  }
  const peerId = request?.peerId ?? request?.target?.peerId;
  if (peerId) {
    requireNonblankString(peerId, 'request.peerId');
    const peer = session.peers.get(peerId);
    if (!peer) throw udpError('PORT_NOT_FOUND', `UDP peer ${peerId} is not known`);
    return [peer];
  }
  if (session.target) {
    return [{ id: null, address: session.target }];
  }
  throw udpError('IO_ERROR', 'No send target specified and no default target configured');
}

function bindSocket(session, socket, host, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeListener('listening', onListening);
      socket.removeListener('error', onError);
      session.cancelPromise.catch(() => {});
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onListening = () => settle(resolve);
    const onError = (error) => settle(reject, mapUdpError(error));
    socket.once('listening', onListening);
    socket.once('error', onError);
    session.cancelPromise.catch((error) => settle(reject, error));
    socket.bind(port, host);
  });
}

function sendDatagram(socket, bytes, target) {
  return new Promise((resolve, reject) => {
    socket.send(bytes, target.port, target.host, (error) => {
      if (error) reject(mapUdpError(error));
      else resolve();
    });
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket) { resolve(); return; }
    socket.once('close', resolve);
    try { socket.close(); } catch { resolve(); }
  });
}

function destroySocket(socket) {
  if (!socket) return;
  try { socket.close(); } catch { /* best effort */ }
}

function udpClientOptions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('udp endpoint config must be an object');
  }
  const bindHost = requireNonblankString(config.bindHost ?? '0.0.0.0', 'config.bindHost');
  if (!Number.isSafeInteger(config.bindPort) || config.bindPort < 0 || config.bindPort > 65535) {
    throw new TypeError('config.bindPort must be a UDP port');
  }
  const targetHost = requireNonblankString(config.targetHost, 'config.targetHost');
  if (!Number.isSafeInteger(config.targetPort) || config.targetPort < 1 || config.targetPort > 65535) {
    throw new TypeError('config.targetPort must be a UDP port');
  }
  return { bindHost, bindPort: config.bindPort, targetHost, targetPort: config.targetPort };
}

function udpServerOptions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('udp endpoint config must be an object');
  }
  const bindHost = requireNonblankString(config.bindHost ?? '0.0.0.0', 'config.bindHost');
  if (!Number.isSafeInteger(config.bindPort) || config.bindPort < 0 || config.bindPort > 65535) {
    throw new TypeError('config.bindPort must be a UDP port');
  }
  const result = { bindHost, bindPort: config.bindPort };
  if (config.targetHost !== undefined && config.targetHost !== null) {
    result.targetHost = requireNonblankString(config.targetHost, 'config.targetHost');
    if (!Number.isSafeInteger(config.targetPort) || config.targetPort < 1 || config.targetPort > 65535) {
      throw new TypeError('config.targetPort must be a UDP port');
    }
    result.targetPort = config.targetPort;
  }
  return result;
}

function copyBytes(value, label) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) {
    if (value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new TypeError(`${label} must contain bytes 0-255`);
    }
    return new Uint8Array(value);
  }
  throw new TypeError(`${label} must be a Uint8Array or byte array`);
}

function requireNonblankString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonblank string`);
  }
  return value.trim();
}

function mapUdpError(reason) {
  if (reason?.name === 'UdpError') return reason;
  if (reason?.code === 'EADDRINUSE') return udpError('PORT_BUSY', errorMessage(reason));
  if (reason?.code === 'EACCES' || reason?.code === 'EPERM') {
    return udpError('PERMISSION_DENIED', errorMessage(reason));
  }
  return udpError('IO_ERROR', errorMessage(reason));
}

function errorMessage(reason) {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function plainError(error) {
  return { code: error.code, message: error.message };
}

function throwIfCancelled(session) {
  if (session.cancelled) throw udpError('OPEN_CANCELLED', 'UDP open cancelled');
}

function isOpenCancelled(reason) {
  return reason?.name === 'UdpError' && reason.code === 'OPEN_CANCELLED';
}

function udpError(code, message) {
  const error = new Error(message);
  error.name = 'UdpError';
  error.code = code;
  return error;
}

module.exports = { UdpService, udpError };
