const net = require('node:net');

const FRAME_BATCH_MILLIS = 200;
const FRAME_BATCH_LIMIT = 200;
const WRITE_TIMEOUT_MILLIS = 2000;

class TcpService {
  constructor({
    clock = Date.now,
    emitEvent,
    timers = globalThis,
    reportEventError = () => {},
    netModule = net,
  } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (typeof emitEvent !== 'function') throw new TypeError('emitEvent is required');
    if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
      throw new TypeError('timers must provide setTimeout and clearTimeout');
    }
    if (typeof reportEventError !== 'function') throw new TypeError('reportEventError must be a function');
    if (typeof netModule?.createConnection !== 'function' || typeof netModule?.createServer !== 'function') {
      throw new TypeError('netModule must provide createConnection and createServer');
    }
    this.clock = clock;
    this.emitEvent = emitEvent;
    this.timers = timers;
    this.reportEventError = reportEventError;
    this.net = netModule;
    this.sessions = new Map();
    this.nextSessionId = 1;
    this.stopped = false;
  }

  async open(endpoint, { operationId } = {}) {
    requireNonblankString(operationId, 'operationId');
    if (this.stopped) throw tcpError('IO_ERROR', 'TCP service is shut down');
    if (endpoint?.transport === 'tcp-client') return this.openClient(endpoint, operationId);
    if (endpoint?.transport === 'tcp-server') return this.openServer(endpoint, operationId);
    throw tcpError('IO_ERROR', `Endpoint ${endpoint?.id ?? ''} is not a TCP endpoint`);
  }

  async openClient(endpoint, operationId) {
    const endpointId = requireNonblankString(endpoint?.id, 'endpoint.id');
    if (this.sessions.has(endpointId)) throw tcpError('PORT_BUSY', `Endpoint ${endpointId} is already open`);
    const config = tcpClientOptions(endpoint.config);
    const session = this.createSession('client', endpoint, operationId);
    this.sessions.set(endpointId, session);
    session.batcher = createFrameBatcher(this, session);
    try {
      session.framer = await createDefaultFramer({
        framing: endpoint.config?.receiveFraming ?? { mode: 'raw' },
        emitFrame: (bytes) => session.batcher.enqueue('in', bytes, null),
        timers: this.timers,
      });
      throwIfCancelled(session);
      this.emitStatus(session, 'opening', {
        level: 'debug',
        message: `Opening TCP client: ${config.host}:${config.port}`,
        details: { host: config.host, port: config.port },
      });

      const socket = this.net.createConnection({ host: config.host, port: config.port });
      session.socket = socket;
      await waitForOpeningSocket(session, socket, 'connect');
      throwIfCancelled(session);
      configureConnectedSocket(socket, config.keepAlive);
      session.phase = 'open';
      attachSocketReaders(this, session, socket);
      this.emitStatus(session, 'open', {
        message: `TCP client connected: ${config.host}:${config.port}`,
        details: { host: config.host, port: config.port },
      });
      return { sessionId: session.sessionId };
    } catch (reason) {
      if (isOpenCancelled(reason)) {
        cleanupSession(session);
        if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
        throw reason;
      }
      const error = mapTcpError(reason);
      if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
      destroySocket(session.socket);
      cleanupSession(session);
      this.emitStatus(session, 'error', {
        error: plainError(error),
        code: error.code,
        message: `TCP client connection failed: ${config.host}:${config.port}`,
        details: { host: config.host, port: config.port },
      });
      throw error;
    }
  }

  async openServer(endpoint, operationId) {
    const endpointId = requireNonblankString(endpoint?.id, 'endpoint.id');
    if (this.sessions.has(endpointId)) throw tcpError('PORT_BUSY', `Endpoint ${endpointId} is already open`);
    const config = tcpServerOptions(endpoint.config);
    const session = this.createSession('server', endpoint, operationId);
    this.sessions.set(endpointId, session);
    session.batcher = createFrameBatcher(this, session);
    session.peers = new Map();
    session.nextPeerId = 1;
    session.keepAlive = config.keepAlive;
    try {
      this.emitStatus(session, 'opening', {
        level: 'debug',
        message: `Opening TCP server: ${config.host}:${config.port}`,
        details: { host: config.host, port: config.port },
      });

      const server = this.net.createServer((socket) => {
        void acceptPeer(this, session, socket);
      });
      session.server = server;
      await listenServer(session, server, config);
      throwIfCancelled(session);
      session.phase = 'listening';
      const address = server.address();
      this.emitStatus(session, 'listening', {
        message: `TCP server listening: ${config.host}:${address.port}`,
        details: { host: config.host, port: address.port },
      });
      return { sessionId: session.sessionId };
    } catch (reason) {
      if (isOpenCancelled(reason)) {
        cleanupSession(session);
        if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
        throw reason;
      }
      const error = mapTcpError(reason);
      if (this.sessions.get(endpointId) === session) this.sessions.delete(endpointId);
      await closeServer(session.server).catch(() => {});
      cleanupSession(session);
      this.emitStatus(session, 'error', {
        error: plainError(error),
        code: error.code,
        message: `TCP server listen failed: ${config.host}:${config.port}`,
        details: { host: config.host, port: config.port },
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
      sessionId: `tcp-${this.nextSessionId}`,
      service: this,
      phase: 'opening',
      cancelled: false,
      closing: false,
      closed: false,
    };
    session.cancelPromise = new Promise((resolve, reject) => {
      session.resolveCancel = resolve;
      session.rejectCancel = reject;
    });
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
    if (session.phase !== 'open' || !session.socket || session.socket.destroyed) {
      throw tcpError('IO_ERROR', `Endpoint ${session.endpointId} is not open`);
    }
    await writeSocket(session.socket, Buffer.from(bytes), this.timers);
    session.batcher.enqueue('out', bytes, null);
    return { endpointId: session.endpointId, sessionId: session.sessionId, byteCount: bytes.byteLength };
  }

  async sendServer(session, request) {
    if (session.phase !== 'listening') {
      throw tcpError('IO_ERROR', `Endpoint ${session.endpointId} is not listening`);
    }
    const bytes = copyBytes(request?.bytes, 'request.bytes');
    const targets = serverSendTargets(session, request);
    const peerResults = await Promise.all(targets.map(async (peer) => {
      try {
        await writeSocket(peer.socket, Buffer.from(bytes), this.timers);
        session.batcher.enqueue('out', bytes, peer.id);
        return { peerId: peer.id, ok: true, byteCount: bytes.byteLength };
      } catch (reason) {
        return { peerId: peer.id, ok: false, error: plainError(mapTcpError(reason)) };
      }
    }));
    const successCount = peerResults.filter(({ ok }) => ok).length;
    return {
      endpointId: session.endpointId,
      sessionId: session.sessionId,
      byteCount: bytes.byteLength,
      peerCount: targets.length,
      successCount,
      failureCount: targets.length - successCount,
      peerResults,
    };
  }

  async disconnectPeer(endpointId, peerId) {
    const session = this.requireSession(endpointId);
    if (session.kind !== 'server') throw tcpError('IO_ERROR', 'Only TCP server peers can be disconnected');
    return closePeer(session, peerId);
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
    await closeSession(session);
    this.emitStatus(session, 'closed', {
      message: `TCP endpoint closed: ${endpointId}`,
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
      forceCloseSession(session);
      this.emitStatus(session, 'closed', {
        message: `TCP endpoint closed: ${session.endpointId}`,
        details: { endpointId: session.endpointId },
      });
    }
   this.sessions.clear();
   return [];
 }

  requireSession(endpointId) {
    const session = this.sessions.get(endpointId);
    if (!session) throw tcpError('PORT_NOT_FOUND', `Endpoint ${endpointId} is not open`);
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
      source: 'tcp',
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

async function acceptPeer(service, session, socket) {
  if (session.closed || session.closing) {
    socket.destroy();
    return;
  }
  const peer = {
    id: `tcp-peer-${session.nextPeerId}`,
    socket,
    remoteAddress: `${socket.remoteAddress}:${socket.remotePort}`,
    connectedAt: service.clock(),
    closed: false,
    framer: null,
  };
  session.nextPeerId += 1;
  let setup = 'keepalive';
  try {
    socket.pause();
    configureConnectedSocket(socket, session.keepAlive);
    setup = 'framing';
    peer.framer = await createDefaultFramer({
      framing: session.endpoint.config?.receiveFraming ?? { mode: 'raw' },
      emitFrame: (bytes) => session.batcher.enqueue('in', bytes, peer.id),
      timers: service.timers,
    });
  } catch {
    cleanupPeer(peer, session);
    socket.destroy();
    service.emitStatus(session, 'listening', {
      level: 'warn',
      message: `TCP peer ${setup} setup failed: ${peer.remoteAddress}`,
      details: { peerId: peer.id, remoteAddress: peer.remoteAddress },
      peerId: peer.id,
    });
    return;
  }
  if (session.closed || session.closing) {
    cleanupPeer(peer, session);
    socket.destroy();
    return;
  }
  session.peers.set(peer.id, peer);
  attachSocketReaders(service, session, socket, peer);
  service.emitPeers(session);
  service.emitStatus(session, 'listening', {
    message: `TCP peer connected: ${peer.remoteAddress}`,
    details: { peerId: peer.id, remoteAddress: peer.remoteAddress },
    peerId: peer.id,
  });
  socket.resume();
}

function attachSocketReaders(service, session, socket, peer = null) {
  const onData = (chunk) => {
    try {
      const bytes = copyBytes(chunk, 'tcp input');
      (peer?.framer ?? session.framer).push(bytes);
    } catch (reason) {
      if (peer) {
        void closeFailedPeer(service, session, peer, reason);
      } else {
        reportSocketFailure(service, session, mapTcpError(reason));
      }
    }
  };
  const onError = (reason) => {
    if (session.closing || session.closed || peer?.closed) return;
    if (peer) {
      void closeFailedPeer(service, session, peer, reason);
      return;
    }
    reportSocketFailure(service, session, mapTcpError(reason));
  };
  const onClose = () => {
    if (peer) {
      if (peer.closed) return;
      peer.closed = true;
      cleanupPeer(peer, session);
      if (session.peers.delete(peer.id)) service.emitPeers(session);
      service.emitStatus(session, 'listening', {
        level: 'warn',
        message: `TCP peer disconnected unexpectedly: ${peer.remoteAddress}`,
        details: { peerId: peer.id, remoteAddress: peer.remoteAddress },
        peerId: peer.id,
      });
      return;
    }
    if (session.closing || session.closed) return;
    service.sessions.delete(session.endpointId);
    cleanupSession(session);
    service.emitStatus(session, 'closed', {
      message: `TCP endpoint closed: ${session.endpointId}`,
      details: { endpointId: session.endpointId },
    });
  };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  const listeners = { onData, onError, onClose };
  if (peer) peer.listeners = listeners;
  else session.listeners = listeners;
}

function reportSocketFailure(service, session, error) {
  if (session.closed || session.closing) return;
  service.emitStatus(session, 'error', {
    error: plainError(error),
    code: error.code,
    message: `TCP I/O failed: ${session.endpointId}: ${error.message}`,
    details: { endpointId: session.endpointId },
  });
  session.discardTail = true;
  void service.close(session.endpointId).catch(() => {});
}

async function closeFailedPeer(service, session, peer, reason) {
  if (peer.closed) return;
  peer.closed = true;
  peer.discardTail = true;
  if (session.peers.delete(peer.id)) service.emitPeers(session);
  cleanupPeer(peer, session);
  destroySocket(peer.socket);
  const error = reason ? mapTcpError(reason) : null;
  service.emitStatus(session, 'listening', {
    level: 'warn',
    message: error
      ? `TCP peer disconnected: ${peer.remoteAddress}: ${error.code}: ${error.message}`
      : `TCP peer disconnected unexpectedly: ${peer.remoteAddress}`,
    details: {
      peerId: peer.id, remoteAddress: peer.remoteAddress,
      ...(error ? { error: plainError(error) } : {}),
    },
    peerId: peer.id,
  });
}

async function closeSession(session) {
  if (session.closed) return;
  if (session.phase === 'opening' && session.cancelled === false) {
    session.cancelled = true;
    const cancellation = tcpError('OPEN_CANCELLED', 'TCP open cancelled');
    session.rejectCancel?.(cancellation);
  }
  session.closing = true;
  if (session.kind === 'server') {
    await Promise.allSettled([...session.peers.keys()].map((peerId) => closePeer(session, peerId)));
    await closeServer(session.server);
  } else {
    if (session.phase === 'opening') destroySocket(session.socket);
    else await closeSocket(session.socket);
  }
  cleanupSession(session);
  session.closed = true;
  session.closing = false;
}

function forceCloseSession(session) {
  if (session.phase === 'opening' && session.cancelled === false) {
    session.cancelled = true;
    session.rejectCancel?.(tcpError('OPEN_CANCELLED', 'TCP open cancelled'));
  }
  session.closing = true;
  if (session.kind === 'server') {
    for (const peer of session.peers.values()) {
      peer.closed = true;
      cleanupPeer(peer, session);
      destroySocket(peer.socket);
    }
    session.peers.clear();
    try {
      session.server?.close?.(() => {});
    } catch {
      // Force shutdown is best-effort; process teardown will reclaim a non-running server handle.
    }
  } else {
    destroySocket(session.socket);
  }
  cleanupSession(session);
  session.closed = true;
  session.closing = false;
}

async function closePeer(session, peerId) {
  requireNonblankString(peerId, 'peerId');
  const peer = session.peers.get(peerId);
  if (!peer) throw tcpError('PORT_NOT_FOUND', `TCP peer ${peerId} is not connected`);
  session.peers.delete(peerId);
  peer.closed = true;
  cleanupPeer(peer, session);
  session.service.emitPeers(session);
  await closeSocket(peer.socket);
  session.service.emitStatus(session, 'listening', {
    message: `TCP peer disconnected: ${peer.remoteAddress}`,
    details: { peerId, remoteAddress: peer.remoteAddress },
    peerId,
  });
  return { disconnected: true, endpointId: session.endpointId, peerId };
}

function cleanupSession(session) {
  try {
    if (!session.discardTail) session.framer?.flush?.();
    session.framer?.reset?.();
  } catch {
    // Cleanup cannot report a second transport failure.
  }
  session.batcher?.clear();
  if (session.listeners && session.socket) {
    session.socket.removeListener('data', session.listeners.onData);
    session.socket.removeListener('error', session.listeners.onError);
    session.socket.removeListener('close', session.listeners.onClose);
  }
  session.listeners = null;
}

function cleanupPeer(peer, session) {
  try {
    if (!peer.discardTail) peer.framer?.flush?.();
    peer.framer?.reset?.();
  } catch {
    // Cleanup cannot report a second transport failure.
  }
  session.batcher?.flush();
  if (peer.listeners) {
    peer.socket.removeListener('data', peer.listeners.onData);
    peer.socket.removeListener('error', peer.listeners.onError);
    peer.socket.removeListener('close', peer.listeners.onClose);
  }
  peer.listeners = null;
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
  const target = request?.target;
  if (target?.type === 'broadcast' || target?.broadcast || request?.broadcast) {
    const peers = [...session.peers.values()].filter((peer) => !peer.socket.destroyed);
    if (peers.length === 0) throw tcpError('PORT_NOT_FOUND', `Endpoint ${session.endpointId} has no connected peers`);
    return peers;
  }
  if (target?.type === 'peer') {
    if (!Array.isArray(target.peerIds) || target.peerIds.length === 0) {
      throw new TypeError('request.target.peerIds must be a nonempty array');
    }
    const peerIds = target.peerIds.map((peerId) => requireNonblankString(
      peerId,
      'request.target.peerIds[]',
    ));
    if (new Set(peerIds).size !== peerIds.length) {
      throw new TypeError('request.target.peerIds must not contain duplicates');
    }
    return peerIds.map((peerId) => {
      const peer = session.peers.get(peerId);
      if (!peer || peer.socket.destroyed) {
        throw tcpError('PORT_NOT_FOUND', `TCP peer ${peerId} is not connected`);
      }
      return peer;
    });
  }
  const peerId = request?.peerId ?? target?.peerId;
  requireNonblankString(peerId, 'request.peerId');
  const peer = session.peers.get(peerId);
  if (!peer || peer.socket.destroyed) throw tcpError('PORT_NOT_FOUND', `TCP peer ${peerId} is not connected`);
  return [peer];
}

function listenServer(session, server, { host, port }) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      session.cancelPromise.catch(() => {});
    };
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onListening = () => settle(resolve);
    const onError = (error) => settle(reject, error);
    server.once('listening', onListening);
    server.once('error', onError);
    session.cancelPromise.catch((error) => settle(reject, error));
    server.listen(port, host);
  });
}

function waitForOpeningSocket(session, socket, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener(event, onEvent);
      socket.removeListener('error', onError);
      session.cancelPromise.catch(() => {});
    };
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onEvent = () => settle(resolve);
    const onError = (error) => settle(reject, error);
    socket.once(event, onEvent);
    socket.once('error', onError);
    session.cancelPromise.catch((error) => settle(reject, error));
  });
}

function writeSocket(socket, bytes, timers) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.destroyed || !socket.writable) {
      reject(tcpError('IO_ERROR', 'TCP socket is not writable'));
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      socket.removeListener('close', closed);
      socket.removeListener('error', failed);
      if (error) reject(mapTcpError(error)); else resolve();
    };
    const closed = () => finish(tcpError('IO_ERROR', 'TCP socket closed before write completed'));
    const failed = (error) => finish(error);
    const timer = timers.setTimeout(() => {
      finish(tcpError('IO_ERROR', 'TCP write timed out'));
      // The bytes may be partly written. Retire only this socket so a later
      // request cannot continue after an incomplete payload on the same stream.
      destroySocket(socket);
    }, WRITE_TIMEOUT_MILLIS);
    socket.once('close', closed);
    socket.once('error', failed);
    try { socket.write(bytes, finish); } catch (error) { finish(error); }
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket || socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', resolve);
    socket.end();
    socket.setTimeout(100, () => socket.destroy());
  });
}

function destroySocket(socket) {
  if (!socket || socket.destroyed) return;
  if (typeof socket.destroy === 'function') {
    socket.destroy();
    return;
  }
  socket.end?.();
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    try {
      server.close((error) => {
        if (error) reject(mapTcpError(error));
        else resolve();
      });
    } catch (reason) {
      reject(mapTcpError(reason));
    }
  });
}

async function createDefaultFramer({ framing, emitFrame, timers }) {
  const config = normalizeFramingConfig(framing);
  const {
    createDelimiterFramer,
    createFixedLengthFramer,
    createIdleTimeoutFramer,
    createRawFramer,
  } = await import('@ineed-linklab/codecs/framers.js');
  switch (config.mode) {
    case 'raw':
      return createRawFramer(emitFrame);
    case 'delimiter':
      return createDelimiterFramer(config.delimiterBytes, emitFrame);
    case 'fixed':
      return createFixedLengthFramer(config.length, emitFrame);
    case 'idle':
      return createIdleTimeoutFramer(config.idleMs, emitFrame, {
        set: (callback, delay) => timers.setTimeout(callback, delay),
        clear: (timer) => timers.clearTimeout(timer),
      });
    default:
      throw new TypeError('framing.mode is invalid');
  }
}

function normalizeFramingConfig(framing) {
  requireExactDataRecord(framing, ['mode'], 'framing', { allowAdditional: true });
  switch (framing.mode) {
    case 'raw':
      requireExactDataRecord(framing, ['mode'], 'raw framing');
      return { mode: 'raw' };
    case 'delimiter': {
      requireExactDataRecord(framing, ['mode', 'delimiterBytes'], 'delimiter framing');
      const delimiterBytes = strictBytes(framing.delimiterBytes, 'framing.delimiterBytes');
      if (delimiterBytes.byteLength === 0) throw new TypeError('framing.delimiterBytes must be nonempty');
      return { mode: 'delimiter', delimiterBytes };
    }
    case 'fixed':
      requireExactDataRecord(framing, ['mode', 'length'], 'fixed framing');
      requirePositiveInteger(framing.length, 'framing.length');
      return { mode: 'fixed', length: framing.length };
    case 'idle':
      requireExactDataRecord(framing, ['mode', 'idleMs'], 'idle framing');
      requirePositiveInteger(framing.idleMs, 'framing.idleMs');
      return { mode: 'idle', idleMs: framing.idleMs };
    default:
      throw new TypeError('framing.mode is invalid');
  }
}

function tcpClientOptions(config) {
  const options = tcpBaseOptions(config);
  if (options.port === 0) throw new TypeError('config.port must be greater than zero');
  return options;
}

function tcpServerOptions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('tcp endpoint config must be an object');
  }
  const host = requireNonblankString(config.listenHost ?? '127.0.0.1', 'config.listenHost');
  if (!Number.isSafeInteger(config.listenPort) || config.listenPort < 0 || config.listenPort > 65535) {
    throw new TypeError('config.listenPort must be a TCP port');
  }
  return { host, port: config.listenPort, keepAlive: tcpKeepAliveOptions(config) };
}

function tcpBaseOptions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('tcp endpoint config must be an object');
  }
  const host = requireNonblankString(config.host ?? '127.0.0.1', 'config.host');
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new TypeError('config.port must be a TCP port');
  }
  return {
    host,
    port: config.port,
    keepAlive: tcpKeepAliveOptions(config),
  };
}

function tcpKeepAliveOptions(config) {
  const descriptor = Object.getOwnPropertyDescriptor(config, 'keepAlive');
  if (!descriptor) return { enabled: true, initialDelaySeconds: 30 };
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('config.keepAlive must be a plain object');
  }
  const keepAlive = descriptor.value;
  const descriptors = requireExactDataRecord(
    keepAlive,
    ['enabled', 'initialDelaySeconds'],
    'config.keepAlive',
  );
  try {
    structuredClone(keepAlive);
  } catch {
    throw new TypeError('config.keepAlive must be a plain object');
  }
  const enabled = descriptors.enabled.value;
  const initialDelaySeconds = descriptors.initialDelaySeconds.value;
  if (typeof enabled !== 'boolean') {
    throw new TypeError('config.keepAlive.enabled must be a boolean');
  }
  if (
    !Number.isSafeInteger(initialDelaySeconds)
    || initialDelaySeconds < 1
    || initialDelaySeconds > 3600
  ) {
    throw new TypeError('config.keepAlive.initialDelaySeconds must be an integer from 1 to 3600');
  }
  return {
    enabled,
    initialDelaySeconds,
  };
}

function configureConnectedSocket(socket, keepAlive) {
  socket.setNoDelay(true);
  socket.setKeepAlive(keepAlive.enabled, keepAlive.initialDelaySeconds * 1000);
}

function requireExactDataRecord(value, fields, label, { allowAdditional = false } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || fields.some((field) => !names.includes(field))
    || (!allowAdditional && names.length !== fields.length)
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.some((field) => !Object.hasOwn(descriptors[field], 'value'))) {
    throw new TypeError(`${label} fields must be data properties`);
  }
  return descriptors;
}

function strictBytes(value, label) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a Uint8Array or byte array`);
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`${label} contains an invalid byte`);
    }
    bytes[index] = byte;
  }
  return bytes;
}

function copyBytes(value, label) {
  if (!(value instanceof Uint8Array) && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be a Uint8Array or byte array`);
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`${label} contains an invalid byte`);
    }
    bytes[index] = byte;
  }
  return bytes;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function requireNonblankString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonblank string`);
  }
  return value;
}

function mapTcpError(reason) {
  if (reason?.code === 'ECONNREFUSED' || reason?.code === 'ENOENT') {
    return tcpError('PORT_NOT_FOUND', errorMessage(reason));
  }
  if (reason?.code === 'EADDRINUSE') return tcpError('PORT_BUSY', errorMessage(reason));
  return tcpError('IO_ERROR', errorMessage(reason));
}

function errorMessage(reason) {
  if (typeof reason?.message === 'string' && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'TCP operation failed';
}

function plainError(error) {
  return { code: error.code, message: error.message };
}

function throwIfCancelled(session) {
  if (session.cancelled) throw tcpError('OPEN_CANCELLED', 'TCP open cancelled');
}

function isOpenCancelled(reason) {
  return reason?.name === 'TcpError' && reason.code === 'OPEN_CANCELLED';
}

function tcpError(code, message) {
  const error = new Error(message);
  error.name = 'TcpError';
  error.code = code;
  return error;
}

module.exports = { TcpService, tcpError };
