import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRANSPORT_TYPES,
  createEndpointProfile,
  createPeer,
  createSession,
  createTransferFrame,
  createTransportError,
} from '../src/models.js';

const VALID_TRANSPORTS = [
  'serial',
  'tcp-client',
  'tcp-server',
  'udp-client',
  'udp-server',
  'dlt645-master',
  'dlt645-slave',
  'modbus-tcp-master',
  'modbus-tcp-slave',
  'modbus-rtu-master',
  'modbus-rtu-slave',
];

test('TRANSPORT_TYPES contains exactly the supported transport names', () => {
  assert.deepEqual([...TRANSPORT_TYPES], VALID_TRANSPORTS);
});

test('createEndpointProfile accepts every supported transport and freezes the result', () => {
  for (const transport of VALID_TRANSPORTS) {
    const config = {};
    const endpoint = createEndpointProfile({
      id: `endpoint-${transport}`,
      name: transport,
      transport,
      config,
    });

    assert.deepEqual(endpoint, {
      id: `endpoint-${transport}`,
      name: transport,
      transport,
      config,
    });
    assert.equal(Object.isFrozen(endpoint), true);
  }
});

test('createEndpointProfile rejects blank identity, unsupported transports, and non-object config', () => {
  const valid = { id: 'ep-1', name: 'COM3', transport: 'serial', config: {} };

  for (const id of [undefined, '', '   ']) {
    assert.throws(() => createEndpointProfile({ ...valid, id }), /id/i);
  }
  for (const name of [undefined, '', '   ']) {
    assert.throws(() => createEndpointProfile({ ...valid, name }), /name/i);
  }
  for (const transport of [undefined, 'bluetooth', 'SERIAL']) {
    assert.throws(() => createEndpointProfile({ ...valid, transport }), /transport/i);
  }
  for (const config of [undefined, null, [], new Date(), 'serial']) {
    assert.throws(() => createEndpointProfile({ ...valid, config }), /config/i);
  }
});

test('createSession uses explicit IDs and endpoint identity in an immutable initial session', () => {
  const endpoint = createEndpointProfile({
    id: 'ep-1',
    name: 'COM3',
    transport: 'serial',
    config: {},
  });
  const session = createSession(endpoint, { sessionId: 's-1', operationId: 'op-1' });

  assert.deepEqual(session, {
    id: 's-1',
    endpointId: 'ep-1',
    transport: 'serial',
    operationId: 'op-1',
  });
  assert.equal(Object.isFrozen(session), true);
});

test('createSession requires explicit nonblank session and operation IDs', () => {
  const endpoint = createEndpointProfile({
    id: 'ep-1',
    name: 'COM3',
    transport: 'serial',
    config: {},
  });

  for (const sessionId of [undefined, '', '   ']) {
    assert.throws(() => createSession(endpoint, { sessionId, operationId: 'op-1' }), /sessionId/i);
  }
  for (const operationId of [undefined, '', '   ']) {
    assert.throws(() => createSession(endpoint, { sessionId: 's-1', operationId }), /operationId/i);
  }
});

test('createPeer validates identity and returns immutable peer data', () => {
  const peer = createPeer({ id: 'peer-1', endpointId: 'ep-1', sessionId: 's-1' });

  assert.deepEqual(peer, { id: 'peer-1', endpointId: 'ep-1', sessionId: 's-1' });
  assert.equal(Object.isFrozen(peer), true);

  for (const field of ['id', 'endpointId', 'sessionId']) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => createPeer({ id: 'peer-1', endpointId: 'ep-1', sessionId: 's-1', [field]: value }), new RegExp(field, 'i'));
    }
  }
});

test('createTransferFrame preserves binary bytes and records an immutable timestamped frame', () => {
  const bytes = Uint8Array.of(1, 3);
  const frame = createTransferFrame({
    endpointId: 'ep-1',
    sessionId: 's-1',
    direction: 'in',
    bytes,
  });

  assert.equal(frame.endpointId, 'ep-1');
  assert.equal(frame.sessionId, 's-1');
  assert.equal(frame.direction, 'in');
  assert.equal(frame.bytes, bytes);
  assert.equal(Number.isFinite(frame.createdAt), true);
  assert.equal(Number.isInteger(frame.createdAt), true);
  assert.equal(Object.isFrozen(frame), true);
});

test('createTransferFrame validates IDs, direction, bytes, and supplied timestamps', () => {
  const valid = {
    endpointId: 'ep-1',
    sessionId: 's-1',
    direction: 'out',
    bytes: Uint8Array.of(2),
  };

  for (const field of ['endpointId', 'sessionId']) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => createTransferFrame({ ...valid, [field]: value }), new RegExp(field, 'i'));
    }
  }
  for (const direction of [undefined, 'incoming', 'IN']) {
    assert.throws(() => createTransferFrame({ ...valid, direction }), /direction/i);
  }
  for (const bytes of [undefined, [1, 2], '01']) {
    assert.throws(() => createTransferFrame({ ...valid, bytes }), /Uint8Array/);
  }
  for (const createdAt of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 'now']) {
    assert.throws(() => createTransferFrame({ ...valid, createdAt }), /createdAt/i);
  }
});

test('createTransportError supplies conservative defaults in an immutable structured record', () => {
  const error = createTransportError({ code: 'OPEN_FAILED', message: 'Could not open' });

  assert.deepEqual(error, {
    code: 'OPEN_FAILED',
    message: 'Could not open',
    protocol: null,
    phase: null,
    source: null,
    rawReason: null,
    remoteAddress: null,
    retryable: false,
  });
  assert.equal(Object.isFrozen(error), true);
});

test('createTransportError validates required fields and preserves supplied context', () => {
  for (const field of ['code', 'message']) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => createTransportError({ code: 'FAILED', message: 'Failed', [field]: value }), new RegExp(field, 'i'));
    }
  }

  const error = createTransportError({
    code: 'SEND_FAILED',
    message: 'Write failed',
    protocol: 'tcp',
    phase: 'send',
    source: 'native',
    rawReason: { errno: 54 },
    remoteAddress: '127.0.0.1:9000',
    retryable: true,
  });
  assert.deepEqual(error, {
    code: 'SEND_FAILED',
    message: 'Write failed',
    protocol: 'tcp',
    phase: 'send',
    source: 'native',
    rawReason: { errno: 54 },
    remoteAddress: '127.0.0.1:9000',
    retryable: true,
  });
});
