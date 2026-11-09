import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { createStompWorkbench } from '../src/model/stompWorkbench.js';
import { StompDecoder, encodeStompFrame } from '../src/model/stompCodec.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function serverFixture(send) {
  let listener;
  const disconnected = [], delivered = [];
  const identity = { sessionId: 'server-session', operationId: 'server-operation' };
  const model = createStompWorkbench({ stomp: {
    onEvent(callback) { listener = callback; return () => {}; },
    async execute(request) {
      if (request.action === 'open') return identity;
      if (request.action === 'disconnectPeer') disconnected.push(request.peerId);
      if (request.action === 'send') {
        const frames = new StompDecoder().push(request.bytes);
        await send?.(request.peerId, frames);
        delivered.push(...frames.map(frame => ({ peerId: request.peerId, ...frame })));
      }
      return {};
    },
  } });
  model.state.mode = 'server';
  model.state.config.heartbeatOutgoing = model.state.config.heartbeatIncoming = 0;
  await model.connect();
  const payload = { endpointId: model.state.connectionId, ...identity };
  const emit = (peerId, command, headers = {}, body = '') => listener({ type: 'frames', payload: {
    ...payload, frames: [{ direction: 'in', peerId, bytes: [...encodeStompFrame(command, headers, body)] }],
  } });
  for (const peerId of ['slow', 'healthy']) {
    emit(peerId, 'CONNECT', { 'accept-version': '1.2', host: 'localhost', 'heart-beat': '0,0' });
    emit(peerId, 'SUBSCRIBE', { id: peerId, destination: `/topic/${peerId}` });
  }
  await pause(0);
  return { model, emit, delivered, disconnected,
    peers: peerIds => listener({ type: 'peers', payload: { ...payload, peers: peerIds.map(id => ({ id })) } }),
  };
}

test('a saturated slow peer cannot consume the healthy peer send budget', async () => {
  const held = deferred();
  const f = await serverFixture((peerId, frames) => peerId === 'slow' && frames.some(frame => frame.command === 'MESSAGE') ? held.promise : undefined);
  try {
    for (let i = 0; i < 1000; i++) f.emit('healthy', 'SEND', { destination: '/topic/slow' }, `slow-${i}`);
    await pause(0);
    assert.equal(await f.model.send({ destination: '/topic/healthy', body: 'healthy-probe' }), true);
    await pause(0);
    assert(f.delivered.some(frame => frame.peerId === 'healthy' && frame.body === 'healthy-probe'));
    assert.equal(f.disconnected.includes('healthy'), false);
    assert.equal(f.model.state.status, 'listening');
  } finally { held.resolve(); await f.model.dispose(); }
});

test('server publication waits for native completion and exposes failed delivery accurately', async () => {
  const held = deferred();
  const f = await serverFixture((peerId, frames) => peerId === 'healthy' && frames.some(frame => frame.body === 'pending-publish') ? held.promise : undefined);
  try {
    let settled = false;
    const result = f.model.send({ destination: '/topic/healthy', body: 'pending-publish' }).then(value => { settled = true; return value; });
    await pause(0);
    assert.equal(settled, false, 'publication must not report success before the native send settles');
    assert.equal(f.model.state.messages.at(-1).status, 'sending');
    held.reject(new Error('untrusted-private-native-details'));
    assert.equal(await result, false);
    assert.equal(f.model.state.messages.at(-1).status, 'failed');
    assert(f.model.state.error);
    assert.equal(f.model.state.error.includes('untrusted-private'), false);
  } finally { held.resolve(); await f.model.dispose(); }
});

test('removing a peer cancels its queued sends without affecting a surviving peer', async () => {
  const held = deferred();
  let started = 0;
  const f = await serverFixture((peerId, frames) => {
    if (peerId === 'slow' && frames.some(frame => frame.command === 'MESSAGE')) { started++; return held.promise; }
  });
  try {
    f.peers(['slow', 'healthy']);
    for (let i = 0; i < 5; i++) f.emit('healthy', 'SEND', { destination: '/topic/slow' }, `cancel-${i}`);
    await pause(0);
    f.peers(['healthy']);
    held.resolve();
    await pause(10);
    assert.equal(started, 1, 'queued work must not be sent after the peer is removed');
    assert.equal(await f.model.send({ destination: '/topic/healthy', body: 'survived' }), true);
    assert(f.delivered.some(frame => frame.body === 'survived'));
  } finally { held.resolve(); await f.model.dispose(); }
});

test('overflow closes the slow peer without waiting for its blocked queue to drain', async () => {
  const held = deferred();
  const f = await serverFixture((peerId, frames) => peerId === 'slow' && frames.some(frame => frame.command === 'MESSAGE') ? held.promise : undefined);
  try {
    for (let i = 0; i < 1001; i++) f.emit('healthy', 'SEND', { destination: '/topic/slow' }, `overflow-${i}`);
    await pause(10);
    assert(f.disconnected.includes('slow'), 'a failed peer must not retain the blocked write queue during close');
    assert.equal(await f.model.send({ destination: '/topic/healthy', body: 'still-live' }), true);
    assert(f.delivered.some(frame => frame.body === 'still-live'));
  } finally { held.resolve(); await f.model.dispose(); }
});

test('disconnect during a client publication preserves the session-ended status', async () => {
  const held = deferred(); let listener;
  const m = createStompWorkbench({ stomp: {
    onEvent(callback) { listener = callback; return () => {}; },
    async execute(request) {
      if (request.action === 'open') return { sessionId: 'client-session' };
      if (request.action === 'send' && new StompDecoder().push(request.bytes).some(frame => frame.command === 'SEND')) await held.promise;
      return {};
    },
  } });
  try {
    await m.connect();
    listener({ type: 'frames', payload: { endpointId: m.state.connectionId, sessionId: 'client-session', frames: [{ bytes: [...encodeStompFrame('CONNECTED', { version: '1.2', 'heart-beat': '0,0' })] }] } });
    const sending = m.send({ destination: '/topic/cancel', body: 'pending-client', receipt: false });
    await pause(0); await m.disconnect();
    assert.equal(await sending, false);
    assert.equal(m.state.messages.at(-1).status, 'stale');
    assert.equal(m.state.error, '');
  } finally { held.resolve(); await m.dispose(); }
});
