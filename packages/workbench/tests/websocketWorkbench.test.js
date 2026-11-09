import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnavailableRuntimeAdapter } from '@ineed-linklab/runtime-contract';
import { validateEndpointDraft, generateEndpointName } from '../src/model/endpointDraft.js';
import { createWorkbenchModel } from '../src/model/createWorkbenchModel.js';
import { isValidSendTarget } from '../src/model/sendPanelState.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const client = { id: 'ws', name: 'WS', transport: 'websocket-client', config: { url: 'ws://127.0.0.1:9000/socket?token=secret', autoReconnect: true } };
const server = { id: 'wss', name: 'Server', transport: 'websocket-server', config: { listenHost: '127.0.0.1', listenPort: 9000, path: '/' } };
function runtime() {
  const adapter = createUnavailableRuntimeAdapter('test');
  adapter.endpoint.list = async () => [client, server];
  adapter.endpoint.save = async (draft) => draft;
  adapter.sendHistory.record = async () => null;
  return adapter;
}
test('WebSocket drafts validate strict URL, subprotocol, heartbeat and secret boundaries', () => {
  assert.deepEqual(validateEndpointDraft(client), {});
  assert.deepEqual(validateEndpointDraft(server), {});
  for (const config of [
    { url: 'http://localhost' }, { url: 'ws://user:secret@localhost' }, { url: 'ws://localhost/#fragment' },
    { url: 'ws://localhost', subprotocols: ['ok', 'ok'] }, { url: 'ws://localhost', subprotocols: ['not a token'] },
    { url: 'ws://localhost', heartbeat: { enabled: true, intervalMs: 999, timeoutMs: 1000 } },
    { url: 'ws://localhost', headers: { Authorization: 'secret' } },
    { url: 'ws://localhost', websocketHeaders: [] }, { url: 'ws://localhost', receiveFraming: { mode: 'raw' } },
  ]) assert.ok(Object.keys(validateEndpointDraft({ ...client, config })).length, JSON.stringify(config));
  assert.ok(validateEndpointDraft({ ...server, config: { ...server.config, listenPort: 0 } }).listenPort);
  assert.equal(generateEndpointName(client), 'WS_CLIENT_127.0.0.1_9000');
  assert.equal(generateEndpointName(server), 'WS_SERVER_9000');
});
test('WS server supports broadcast and selected peers using the existing target contract', () => {
  const context = { endpoint: server, peers: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(isValidSendTarget({ ...context, target: { type: 'peer', peerIds: ['a', 'b'] } }), true);
  assert.equal(isValidSendTarget({ ...context, target: { type: 'broadcast' } }), true);
  assert.equal(isValidSendTarget({ ...context, target: { type: 'peer', peerIds: ['missing'] } }), false);
});
test('headers stay in memory through save and reconnect, then clear on workspace reset', async () => {
  const adapter = runtime(); const calls = []; let saved;
  adapter.endpoint.save = async draft => { saved = draft; return draft; };
  adapter.transport.open = async (id, options) => { calls.push({ id, options }); throw new Error('offline'); };
  const timers = createFakeTimers();
  const model = createWorkbenchModel(adapter, { timers, clock: () => timers.now, createReconnectOperationId: () => 'retry' });
  assert.equal((await model.commands.loadEndpoints()).ok, true);
  const headers = [{ name: 'Authorization', value: 'Bearer secret' }];
  assert.equal((await model.commands.save(client, { websocketHeaders: headers })).ok, true);
  headers[0].value = 'changed';
  assert.equal(JSON.stringify(saved).includes('Bearer'), false);
  await model.commands.open('ws', 'initial');
  assert.equal(model.reconnectStateFor('ws').phase, 'waiting');
  await timers.runNext();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.options.websocketHeaders), Array(2).fill([{ name: 'Authorization', value: 'Bearer secret' }]));
  model.resetWorkspaceState();
  assert.deepEqual(model.websocketHeadersForEndpoint('ws'), []);
  model.dispose();
});
test('WebSocket sends preserve message type and message boundaries in native requests and history', async () => {
  const adapter = runtime(); let wire; let history;
  adapter.transport.send = async request => { wire = request; return {}; };
  adapter.sendHistory.record = async request => { history = request; };
  const model = createWorkbenchModel(adapter);
  await model.commands.loadEndpoints();
  const result = await model.commands.send({ endpointId: 'ws', bytes: Uint8Array.of(0, 255), format: 'hex', framing: 'websocket', messageType: 'binary' });
  assert.equal(result.ok, true);
  assert.deepEqual([...wire.bytes], [0, 255]);
  assert.equal(wire.messageType, 'binary');
  assert.equal(history.framing, 'websocket');
  assert.equal(history.format, 'hex');
  model.dispose();
});
test('WS commands cannot add byte-stream framing and history retains the explicit message type', async () => {
  const adapter = runtime(); let wire; let history;
  adapter.transport.send = async request => { wire = request; return {}; };
  adapter.sendHistory.record = async record => { history = record; };
  const model = createWorkbenchModel(adapter); await model.commands.loadEndpoints();
  assert.equal((await model.commands.send({ endpointId: 'ws', bytes: Uint8Array.of(104, 105), framing: 'length-prefix', format: 'text', messageType: 'binary' })).ok, true);
  assert.equal(wire.framing, 'websocket'); assert.deepEqual([...wire.bytes], [104, 105]);
  assert.equal(history.format, 'hex');
  model.dispose();
});
test('canceled or failed imports retain transient headers and successful imports clear them', async () => {
  const adapter = runtime();
  adapter.modbusHistory.flush = async () => ({});
  const model = createWorkbenchModel(adapter); await model.commands.loadEndpoints();
  await model.commands.save(client, { websocketHeaders: [{ name: 'Authorization', value: 'secret' }] });
  adapter.workspace.import = async () => ({ canceled: true }); await model.importWorkspace();
  assert.equal(model.websocketHeadersForEndpoint('ws').length, 1);
  adapter.workspace.import = async () => { throw new Error('invalid workspace'); };
  await assert.rejects(model.importWorkspace(), /invalid workspace/);
  assert.equal(model.websocketHeadersForEndpoint('ws').length, 1);
  adapter.workspace.import = async () => ({ canceled: false, endpointCount: 1 }); await model.importWorkspace();
  assert.deepEqual(model.websocketHeadersForEndpoint('ws'), []);
  model.dispose();
});
test('remote WebSocket close retains bounded close details and schedules one retry', async () => {
  const adapter = runtime(); let status;
  adapter.transport.onStatus = callback => { status = callback; return () => {}; };
  adapter.transport.open = async () => ({ sessionId: 'current' });
  const timers = createFakeTimers(); const model = createWorkbenchModel(adapter, { timers, clock: () => timers.now });
  await model.commands.loadEndpoints(); await model.commands.open('ws', 'open');
  status({ endpointId: 'ws', operationId: 'open', sessionId: null, status: 'closed', error: null, createdAt: 1000, log: { source: 'websocket', level: 'warn', code: null, message: 'Remote closed', details: { closeCode: 1001, closeReason: 'server stopping' }, createdAt: 1000 } });
  assert.equal(model.state.statuses.get('ws').log.details.closeCode, 1001);
  assert.equal(model.reconnectStateFor('ws').attempt, 1);
  assert.equal(timers.pendingCount(), 1);
  await model.commands.close('ws');
  assert.equal(timers.pendingCount(), 0);
  model.dispose();
});
test('transient headers enforce HTTP tokens, value bytes and bounded case-insensitive uniqueness', async () => {
  const { snapshotWebSocketHeaders } = await import('../src/model/websocketConfig.js');
  assert.deepEqual(snapshotWebSocketHeaders([{ name: 'Authorization', value: 'Bearer secret' }]), [{ name: 'Authorization', value: 'Bearer secret' }]);
  for (const headers of [
    [{ name: 'Host', value: 'localhost' }], [{ name: 'Sec-WebSocket-Protocol', value: 'chat' }],
    [{ name: 'A', value: '1' }, { name: 'a', value: '2' }], [{ name: 'bad name', value: 'v' }],
    [{ name: 'Authorization', value: 'a\r\nb' }], [{ name: 'Authorization', value: '\u0000' }],
    [{ name: 'Authorization', value: '凭据' }], [{ name: 'Authorization', value: 'a'.repeat(4097) }],
    Array.from({ length: 33 }, (_, i) => ({ name: `X-${i}`, value: '' })),
    Array.from({ length: 5 }, (_, i) => ({ name: `X-${i}`, value: 'a'.repeat(4096) })),
  ]) assert.throws(() => snapshotWebSocketHeaders(headers), TypeError);
});
test('WebSocket subprotocol list has bounded tokens', () => {
  for (const subprotocols of [Array.from({ length: 17 }, (_, i) => `p${i}`), ['p'.repeat(129)]]) {
    assert.ok(validateEndpointDraft({ ...client, config: { url: 'ws://localhost', subprotocols } }).subprotocols);
  }
});
