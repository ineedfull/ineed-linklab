import assert from 'node:assert/strict';
import test from 'node:test';

const stateModule = await import('../src/model/sendPanelState.js').catch(() => null);

test('TCP server target falls back when a selected peer disappears', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const endpoint = { id: 'server-1', transport: 'tcp-server' };

  assert.equal(stateModule.normalizeSendTarget({
    endpoint,
    peers: [{ id: 'peer-b' }, { id: 'peer-c' }],
    activePeerId: null,
    target: 'peer-a',
  }), 'peer-b');
  assert.equal(stateModule.normalizeSendTarget({
    endpoint,
    peers: [],
    activePeerId: null,
    target: 'peer-a',
  }), '');
});

test('broadcast remains selected when the sidebar has an active peer', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const endpoint = { id: 'server-1', transport: 'tcp-server' };
  const peers = [{ id: 'peer-a' }, { id: 'peer-b' }];

  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers, activePeerId: 'peer-a', target: 'all',
  }), 'all');
});

test('explicit peer target wins over a different sidebar active peer', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const endpoint = { id: 'server-1', transport: 'tcp-server' };
  const peers = [{ id: 'peer-a' }, { id: 'peer-b' }];

  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers, activePeerId: 'peer-a', target: 'peer-b',
  }), 'peer-b');
});

test('empty target falls back to the current sidebar peer', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const endpoint = { id: 'server-1', transport: 'tcp-server' };
  const peers = [{ id: 'peer-a' }, { id: 'peer-b' }];

  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers, activePeerId: 'peer-b', target: '',
  }), 'peer-b');
});

test('removed target falls back to active peer, then first peer, then empty', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const endpoint = { id: 'server-1', transport: 'tcp-server' };

  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers: [{ id: 'peer-a' }, { id: 'peer-b' }],
    activePeerId: 'peer-b', target: 'removed-peer',
  }), 'peer-b');
  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers: [{ id: 'peer-a' }], activePeerId: null, target: 'removed-peer',
  }), 'peer-a');
  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers: [], activePeerId: 'peer-b', target: 'removed-peer',
  }), '');
});

test('send eligibility requires matching active endpoint, session, status, payload, and target', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const context = connectedContext();

  assert.equal(stateModule.canSendPayload(context), true);
  assert.equal(stateModule.canSendPayload({ ...context, activeEndpointId: 'other' }), false);
  assert.equal(stateModule.canSendPayload({ ...context, payloadValid: false }), false);
  assert.equal(stateModule.canSendPayload({ ...context, target: 'missing-peer' }), false);
  assert.equal(stateModule.canSendPayload({ ...context, operation: null }), false);
  assert.equal(stateModule.canSendPayload({ ...context, statusEvent: null }), false);
  assert.equal(stateModule.canSendPayload({
    ...context,
    statusEvent: { ...context.statusEvent, sessionId: 'stale-session' },
  }), false);
  for (const status of ['connected', 'listening', 'open']) {
    assert.equal(stateModule.canSendPayload({
      ...context,
      statusEvent: { ...context.statusEvent, status },
    }), true, status);
  }
});

test('stale sessions cannot send in non-open states', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  for (const status of ['closed', 'closing', 'disconnected', 'error', 'opening']) {
    assert.equal(stateModule.canSendPayload({
      ...connectedContext(),
      statusEvent: { ...connectedContext().statusEvent, status },
    }), false, status);
  }
});

test('UDP server requires a complete valid default target before sending', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const invalidConfigs = [
    {},
    { targetHost: '127.0.0.1' },
    { targetPort: 9000 },
    { targetHost: ' ', targetPort: 9000 },
    { targetHost: '127.0.0.1', targetPort: 0 },
    { targetHost: '127.0.0.1', targetPort: 65536 },
    { targetHost: '127.0.0.1', targetPort: 1.5 },
    { targetHost: '127.0.0.1', targetPort: '9000' },
  ];

  for (const status of ['connected', 'listening']) {
    for (const config of invalidConfigs) {
      const context = udpServerContext(config);
      const eligibility = stateModule.getSendEligibility({
        ...context,
        statusEvent: { ...context.statusEvent, status },
      });
      assert.deepEqual(eligibility, {
        canSend: false,
        reason: 'UDP 服务端未配置有效的默认发送目标',
      });
    }

    const context = udpServerContext({ targetHost: ' 127.0.0.1 ', targetPort: 9000 });
    assert.deepEqual(stateModule.getSendEligibility({
      ...context,
      statusEvent: { ...context.statusEvent, status },
    }), { canSend: true, reason: '' });
  }
});

test('UDP server eligibility still requires payload and a sendable running session', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const context = udpServerContext({ targetHost: '127.0.0.1', targetPort: 9000 });

  assert.deepEqual(stateModule.getSendEligibility({
    ...context,
    payloadValid: false,
    payloadError: '发送内容为空',
  }), { canSend: false, reason: '发送内容为空' });
  assert.deepEqual(stateModule.getSendEligibility({
    ...context,
    statusEvent: { ...context.statusEvent, status: 'closed' },
  }), { canSend: false, reason: '当前端点未处于可发送状态' });
  assert.equal(stateModule.getSendEligibility({
    ...context,
    payloadValid: false,
    payloadError: '发送内容为空',
    statusEvent: { ...context.statusEvent, status: 'closed' },
  }).canSend, false);
});

test('client transports and serial retain endpoint-based send eligibility', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  for (const transport of ['serial', 'tcp-client', 'udp-client']) {
    const context = connectedContext();
    assert.deepEqual(stateModule.getSendEligibility({
      ...context,
      endpoint: { id: 'server-1', transport, config: {} },
      target: 'endpoint',
    }), { canSend: true, reason: '' }, transport);
    assert.deepEqual(stateModule.getSendEligibility({
      ...context,
      endpoint: { id: 'server-1', transport, config: {} },
      target: 'peer-x',
    }), { canSend: false, reason: '请选择有效的发送目标' }, transport);
  }
});

test('UDP server requires endpoint target and TCP server requires a valid peer target', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const udpContext = udpServerContext({ targetHost: '127.0.0.1', targetPort: 9000 });

  assert.equal(stateModule.isValidSendTarget(udpContext), true);
  assert.equal(stateModule.isValidSendTarget({ ...udpContext, target: 'peer-x' }), false);

  const tcpContext = connectedContext();
  assert.equal(stateModule.isValidSendTarget(tcpContext), true);
  assert.equal(stateModule.isValidSendTarget({ ...tcpContext, target: 'peer-x' }), false);
  assert.equal(stateModule.isValidSendTarget({ ...tcpContext, target: 'endpoint' }), false);
});

test('TCP server validates explicit broadcast and multi-peer target contracts', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const context = {
    endpoint: { id: 'server-1', transport: 'tcp-server' },
    peers: [{ id: 'peer-a' }, { id: 'peer-b' }, { id: 'peer-c' }],
  };

  assert.equal(stateModule.isValidSendTarget({
    ...context, target: { type: 'broadcast' },
  }), true);
  assert.equal(stateModule.isValidSendTarget({
    ...context, target: { type: 'peer', peerIds: ['peer-a', 'peer-c'] },
  }), true);
  for (const target of [
    { type: 'peer', peerIds: [] },
    { type: 'peer', peerIds: ['peer-a', 'peer-a'] },
    { type: 'peer', peerIds: ['peer-a', 'missing'] },
  ]) {
    assert.equal(stateModule.isValidSendTarget({ ...context, target }), false);
  }
  assert.equal(stateModule.isValidSendTarget({
    ...context, peers: [], target: { type: 'broadcast' },
  }), false);
});

test('UDP server supports discovered peer, broadcast, and optional default targets', () => {
  assert.ok(stateModule, 'send panel state module must exist');
  const endpoint = {
    id: 'udp-server-1',
    transport: 'udp-server',
    config: { targetHost: '127.0.0.1', targetPort: 9000 },
  };
  const peers = [{ id: 'udp-peer-a' }, { id: 'udp-peer-b' }];

  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers, activePeerId: 'udp-peer-b', target: '',
  }), 'udp-peer-b');
  assert.equal(stateModule.isValidSendTarget({ endpoint, peers, target: 'udp-peer-a' }), true);
  assert.equal(stateModule.isValidSendTarget({ endpoint, peers, target: 'all' }), true);
  assert.equal(stateModule.isValidSendTarget({ endpoint, peers, target: 'endpoint' }), true);
  assert.equal(stateModule.normalizeSendTarget({
    endpoint: { ...endpoint, config: {} }, peers: [], activePeerId: null, target: '',
  }), '');
  assert.equal(stateModule.normalizeSendTarget({
    endpoint, peers, activePeerId: 'udp-peer-b', target: 'endpoint', preferActivePeer: true,
  }), 'udp-peer-b');
});

function connectedContext() {
  return {
    endpoint: { id: 'server-1', transport: 'tcp-server' },
    activeEndpointId: 'server-1',
    operation: { endpointId: 'server-1', operationId: 'op-1', sessionId: 'session-1' },
    statusEvent: {
      endpointId: 'server-1', operationId: 'op-1', sessionId: 'session-1', status: 'listening',
    },
    peers: [{ id: 'peer-a' }],
    target: 'peer-a',
    payloadValid: true,
  };
}

function udpServerContext(config) {
  return {
    ...connectedContext(),
    endpoint: { id: 'server-1', transport: 'udp-server', config },
    peers: [],
    target: 'endpoint',
  };
}
