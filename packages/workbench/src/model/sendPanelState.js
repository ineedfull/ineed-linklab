const sendableStatuses = new Set(['connected', 'listening', 'open']);

export function normalizeSendTarget({
  endpoint,
  peers = [],
  activePeerId = null,
  target,
  preferActivePeer = false,
}) {
  if (!endpoint || !isPeerServer(endpoint)) return endpoint ? 'endpoint' : '';

  const peerIds = validPeerIds(peers);
  if (preferActivePeer && peerIds.includes(activePeerId)) return activePeerId;
  if (endpoint.transport === 'udp-server' && target === 'endpoint' && hasUdpDefaultTarget(endpoint.config)) {
    return 'endpoint';
  }
  if (target === 'all' && peerIds.length > 0) return 'all';
  if (peerIds.includes(target)) return target;
  if (peerIds.includes(activePeerId)) return activePeerId;
  if (peerIds.length > 0) return peerIds[0];
  return endpoint.transport === 'udp-server' && hasUdpDefaultTarget(endpoint.config)
    ? 'endpoint'
    : '';
}

export function hasActiveSendSession({ endpoint, activeEndpointId, operation, statusEvent }) {
  if (!endpoint || activeEndpointId !== endpoint.id) return false;
  if (
    operation?.endpointId !== endpoint.id
    || typeof operation.sessionId !== 'string'
    || operation.sessionId.trim() === ''
  ) return false;
  return statusEvent?.endpointId === endpoint.id
    && statusEvent.operationId === operation.operationId
    && statusEvent.sessionId === operation.sessionId
    && sendableStatuses.has(statusEvent.status);
}

export function isValidSendTarget({ endpoint, peers = [], target }) {
  if (!endpoint) return false;
  if (endpoint.transport === 'udp-server') {
    const peerIds = validPeerIds(peers);
    if (target === 'endpoint') return hasUdpDefaultTarget(endpoint.config);
    return target === 'all' ? peerIds.length > 0 : peerIds.includes(target);
  }
  if (!['tcp-server', 'websocket-server'].includes(endpoint.transport)) return target === 'endpoint';
  const peerIds = validPeerIds(peers);
  if (target?.type === 'broadcast') return peerIds.length > 0;
  if (target?.type === 'peer') {
    if (!Array.isArray(target.peerIds) || target.peerIds.length === 0) return false;
    const selectedPeerIds = target.peerIds;
    return new Set(selectedPeerIds).size === selectedPeerIds.length
      && selectedPeerIds.every((peerId) => (
        typeof peerId === 'string' && peerIds.includes(peerId)
      ));
  }
  return target === 'all' ? peerIds.length > 0 : peerIds.includes(target);
}

export function canSendPayload(context) {
  return getSendEligibility(context).canSend;
}

export function getSendEligibility(context) {
  if (!hasActiveSendSession(context)) {
    return blocked('当前端点未处于可发送状态');
  }
  if (!isValidSendTarget(context)) {
    return blocked(context.endpoint?.transport === 'udp-server'
      ? 'UDP 服务端未配置有效的默认发送目标'
      : '请选择有效的发送目标');
  }
  if (context.payloadValid !== true) {
    return blocked(context.payloadError || '发送内容无效');
  }
  return { canSend: true, reason: '' };
}

function validPeerIds(peers) {
  return peers.flatMap((peer) => (
    typeof peer?.id === 'string' && peer.id.trim() !== '' ? [peer.id] : []
  ));
}

function isPeerServer(endpoint) {
  return ['tcp-server', 'websocket-server', 'udp-server'].includes(endpoint.transport);
}

function hasUdpDefaultTarget(config) {
  return typeof config?.targetHost === 'string'
    && config.targetHost.trim() !== ''
    && Number.isInteger(config.targetPort)
    && config.targetPort >= 1
    && config.targetPort <= 65535;
}

function blocked(reason) {
  return { canSend: false, reason };
}
