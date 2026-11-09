import { StompDecoder, encodeStompFrame, STOMP_LIMITS, stompDestination, stompHeartbeat } from './stompCodec.js';

/** Ephemeral exact-destination test broker. It owns no socket and never records CONNECT. */
export function createStompBroker({ config = {}, credentials = {}, send, close, cancelPending = () => {}, onMessage = () => {}, onError = () => {}, now = Date.now } = {}) {
  const peers = new Map(); const queues = new Map();
  let sequence = 0; let storedBytes = 0; let pendingCount = 0; let disposed = false;
  const heartbeat = [config.heartbeatOutgoing ?? 10000, config.heartbeatIncoming ?? 10000];
  const bytesOf = message => new TextEncoder().encode(message.body).length + new TextEncoder().encode(message.destination + message.contentType).length + 128;
  function observeDelivery(peer, result) {
    if (!result || typeof result.then !== 'function') return result;
    const completion = Promise.resolve(result).catch(error => {
      const reason = error?.code === 'STOMP_SEND_QUEUE_FULL' ? 'Broker peer send queue limit exceeded' : 'Broker native delivery failed';
      fail(peer, reason);
      throw new Error(reason);
    });
    // Protocol receive/tick are synchronous; local publication also awaits this completion.
    completion.catch(() => {});
    return completion;
  }
  function transmit(peer, command, headers = {}, body = '') {
    peer.lastOut = now(); return observeDelivery(peer, send(peer.id, encodeStompFrame(command, headers, body)));
  }
  function publication(deliveries, queued = false) {
    const completion = Promise.allSettled(deliveries).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new Error('STOMP 消息投递失败，请检查连接状态与发送队列');
      return { deliveries: results.length, queued };
    });
    completion.catch(() => {});
    return completion;
  }
  function release(message) {
    storedBytes -= message.size;
    if (message.queue) message.queue.count--;
  }
  function retain(message, queue = null) {
    message.size = bytesOf(message); message.queue = queue;
    if (storedBytes + message.size > STOMP_LIMITS.storedBytes || queue && queue.count >= STOMP_LIMITS.queueMessages) throw new Error('Broker queue storage limit exceeded');
    storedBytes += message.size; if (queue) queue.count++;
    return message;
  }
  function queueFor(destination) {
    let queue = queues.get(destination);
    if (!queue) {
      if (queues.size >= 1000) throw new Error('Broker destination limit exceeded');
      queue = { destination, messages: [], cursor: 0, count: 0 }; queues.set(destination, queue);
    }
    return queue;
  }
  function subscribers(destination) {
    const result = [];
    for (const peer of peers.values()) if (peer.connected) for (const subscription of peer.subscriptions.values()) if (subscription.destination === destination) result.push({ peer, subscription });
    return result;
  }
  function deliver(peer, subscription, message) {
    const headers = { destination: message.destination, subscription: subscription.id, 'message-id': `message-${++sequence}`, 'content-type': message.contentType, ...(message.redelivered ? { redelivered: 'true' } : {}) };
    if (subscription.ack !== 'auto') {
      if (pendingCount >= STOMP_LIMITS.pending) throw new Error('Broker unacknowledged message limit exceeded');
      const ackId = `ack-${++sequence}`; headers.ack = ackId;
      peer.pending.set(ackId, { message, subscription }); pendingCount++;
    }
    const completion = transmit(peer, 'MESSAGE', headers, message.body);
    message.delivery = { completion };
    if (subscription.ack === 'auto' && message.size !== undefined) release(message);
    return completion;
  }
  function drain(queue) {
    const available = () => subscribers(queue.destination).filter(target => target.subscription.ack === 'auto' || pendingCount < STOMP_LIMITS.pending);
    let targets = available();
    while (queue.messages.length && targets.length) {
      const target = targets[queue.cursor % targets.length]; queue.cursor++;
      const message = queue.messages.shift();
      try { deliver(target.peer, target.subscription, message); }
      catch { if (!target.peer.pending.size || ![...target.peer.pending.values()].some(row => row.message === message)) queue.messages.unshift(message); fail(target.peer, 'Broker delivery failed'); }
      targets = available();
    }
  }
  function removePending(peer, predicate, redeliver) {
    const recovered = [];
    for (const [ackId, item] of peer.pending) if (predicate(ackId, item)) {
      peer.pending.delete(ackId); pendingCount--;
      if (redeliver && item.message.queue) { item.message.redelivered = true; recovered.push(item.message); }
      else release(item.message);
    }
    // Original delivery order survives an unsubscription or disconnect.
    for (const message of recovered.reverse()) message.queue.messages.unshift(message);
  }
  function removePeer(id) {
    const peer = peers.get(id); if (!peer) return;
    peers.delete(id); peer.connected = false;
    removePending(peer, () => true, true);
    for (const queue of queues.values()) drain(queue);
  }
  function fail(peer, reason) {
    if (peers.get(peer.id) !== peer || peer.retired) return;
    // Keep a closing peer registered until its native removal notification.
    // Trailing frames/snapshots cannot revive it; ownership stays within 64 peers.
    peer.retired = true; peer.connected = false;
    cancelPending(peer.id);
    // All messages are controlled constants; never reflect auth, headers or body.
    try { transmit(peer, 'ERROR', { message: reason }, reason); } catch { /* Socket may already be gone. */ }
    onError({ peerId: peer.id, message: reason });
    removePending(peer, () => true, true); peer.subscriptions.clear();
    for (const queue of queues.values()) drain(queue);
    close(peer.id);
  }
  function route(destination, body, contentType = 'text/plain') {
    stompDestination(destination, true);
    if (typeof body !== 'string' || typeof contentType !== 'string' || contentType.length > 256) throw new Error('Invalid STOMP message');
    encodeStompFrame('SEND', { destination, 'content-type': contentType }, body);
    // Reserve worst-case delivery metadata before accepting retained data or touching consumers.
    const preflight = subscription => encodeStompFrame('MESSAGE', { destination, subscription, 'message-id': 'message-9007199254740991', ack: 'ack-9007199254740991', redelivered: 'true', 'content-type': contentType }, body);
    if (destination.startsWith('/queue/')) {
      preflight('界'.repeat(128));
      const queue = queueFor(destination); const message = retain({ destination, body, contentType }, queue); queue.messages.push(message); drain(queue);
      return publication(message.delivery ? [message.delivery.completion] : [], !message.delivery);
    } else {
      const targets = subscribers(destination);
      for (const target of targets) preflight(target.subscription.id);
      const waiting = targets.filter(target => target.subscription.ack !== 'auto');
      const size = bytesOf({ destination, body, contentType });
      if (pendingCount + waiting.length > STOMP_LIMITS.pending || storedBytes + size * waiting.length > STOMP_LIMITS.storedBytes) throw new Error('Broker unacknowledged message limit exceeded');
      const deliveries = [];
      for (const { peer, subscription } of targets) {
        const message = { destination, body, contentType };
        if (subscription.ack !== 'auto') retain(message);
        try { deliveries.push(deliver(peer, subscription, message)); }
        catch { fail(peer, 'Broker delivery failed'); deliveries.push(Promise.reject(new Error('Broker delivery failed'))); }
      }
      return publication(deliveries);
    }
  }
  function process(peer, frame) {
    const { command, headers, body } = frame;
    if (!command) return;
    if (!peer.connected) {
      if (!['CONNECT', 'STOMP'].includes(command)) throw new Error('CONNECT required');
      if (!headers['accept-version']?.split(',').includes('1.2')) throw new Error('STOMP 1.2 required');
      if (headers.host !== (config.host ?? 'localhost')) throw new Error('Virtual host rejected');
      if (credentials.requireAuthentication && (headers.login !== credentials.login || headers.passcode !== credentials.passcode)) throw new Error('Authentication rejected');
      const [outgoing, incoming] = stompHeartbeat(headers['heart-beat']);
      peer.sendInterval = heartbeat[0] && incoming ? Math.max(heartbeat[0], incoming) : 0;
      peer.receiveInterval = heartbeat[1] && outgoing ? Math.max(heartbeat[1], outgoing) : 0;
      peer.connected = true; transmit(peer, 'CONNECTED', { version: '1.2', session: peer.id, server: 'Ineed-LinkLab', 'heart-beat': heartbeat.join(',') }); return;
    }
    if (headers.transaction !== undefined || ['BEGIN', 'COMMIT', 'ABORT'].includes(command)) throw new Error('Transactions are unsupported');
    if (headers.receipt !== undefined && (!headers.receipt || headers.receipt.length > 256)) throw new Error('Invalid receipt');
    switch (command) {
      case 'SEND': {
        route(headers.destination, body, headers['content-type']);
        onMessage({ body, destination: headers.destination, peerId: peer.id, direction: 'in' }); break;
      }
      case 'SUBSCRIBE': {
        const id = headers.id; const ack = headers.ack ?? 'auto'; stompDestination(headers.destination, true);
        if (!id || id.length > 128 || peer.subscriptions.has(id) || !['auto', 'client', 'client-individual'].includes(ack)) throw new Error('Invalid subscription');
        if (peer.subscriptions.size >= STOMP_LIMITS.subscriptions) throw new Error('Subscription limit exceeded');
        peer.subscriptions.set(id, { id, ack, destination: headers.destination });
        const queue = queues.get(headers.destination); if (queue) drain(queue); break;
      }
      case 'UNSUBSCRIBE': {
        if (!peer.subscriptions.has(headers.id)) throw new Error('Unknown subscription');
        peer.subscriptions.delete(headers.id); removePending(peer, (_id, item) => item.subscription.id === headers.id, true);
        for (const queue of queues.values()) drain(queue); break;
      }
      case 'ACK': case 'NACK': {
        const item = peer.pending.get(headers.id); if (!item) throw new Error('Unknown acknowledgement');
        const selected = new Set();
        for (const [id, pending] of peer.pending) {
          if (id === headers.id || item.subscription.ack === 'client' && pending.subscription.id === item.subscription.id) selected.add(id);
          if (id === headers.id) break;
        }
        const topicRetries = command === 'NACK' ? [...peer.pending].filter(([id, pending]) => selected.has(id) && !pending.message.queue).map(([, pending]) => pending) : [];
        removePending(peer, id => selected.has(id), command === 'NACK');
        for (const pending of topicRetries) { const retry = retain({ ...pending.message, redelivered: true }); deliver(peer, pending.subscription, retry); }
        for (const queue of queues.values()) drain(queue); break;
      }
      case 'DISCONNECT': if (headers.receipt) transmit(peer, 'RECEIPT', { 'receipt-id': headers.receipt }); removePeer(peer.id); close(peer.id); return;
      default: throw new Error('Unsupported STOMP command');
    }
    if (headers.receipt) transmit(peer, 'RECEIPT', { 'receipt-id': headers.receipt });
  }
  return {
    addPeer(id) {
      if (disposed || peers.has(id)) return;
      if (peers.size >= STOMP_LIMITS.peers) { close(id); return; }
      peers.set(id, { id, decoder: new StompDecoder(), subscriptions: new Map(), pending: new Map(), connected: false, lastIn: now(), lastOut: now(), openedAt: now(), sendInterval: 0, receiveInterval: 0 });
    },
    removePeer,
    receive(id, bytes) {
      if (disposed) return;
      this.addPeer(id); const peer = peers.get(id); if (!peer || peer.retired) return; peer.lastIn = now();
      try { for (const frame of peer.decoder.push(bytes)) { if (peers.get(id) !== peer || peer.retired) break; process(peer, frame); } }
      catch (error) { fail(peer, error instanceof Error && /^(?:Invalid|Unknown|Unsupported|CONNECT|STOMP|Virtual|Authentication|Transactions|Subscription|Local broker|Broker)/.test(error.message) ? error.message : 'Invalid STOMP frame'); }
    },
    send({ destination, body = '', contentType = 'text/plain' }) { if (disposed) throw new Error('Broker stopped'); return route(destination, body, contentType); },
    tick() {
      const time = now();
      for (const peer of peers.values()) {
        if (peer.retired) continue;
        if (!peer.connected && time - peer.openedAt > 10000 || peer.receiveInterval && time - peer.lastIn > peer.receiveInterval * 2) { fail(peer, 'STOMP heartbeat or handshake timeout'); continue; }
        if (peer.sendInterval && time - peer.lastOut >= peer.sendInterval) { peer.lastOut = time; try { observeDelivery(peer, send(peer.id, Uint8Array.of(10))); } catch { fail(peer, 'Broker delivery failed'); } }
      }
    },
    dispose() { disposed = true; peers.clear(); queues.clear(); storedBytes = 0; pendingCount = 0; },
  };
}
