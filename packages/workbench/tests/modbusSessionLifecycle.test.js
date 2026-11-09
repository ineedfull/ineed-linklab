import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnavailableRuntimeAdapter } from '../../runtime-contract/src/index.js';
import { createWorkbenchModel } from '../src/model/createWorkbenchModel.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

function fixture({ autoStart = false, minGapMs = 0 } = {}) {
  const timers = createFakeTimers();
  const read = { id: 'read', name: 'Read', enabled: true, order: 0, functionCode: 3,
    startAddress: 0, quantity: 1, intervalMs: 1000, dataPoints: [] };
  const endpoint = { id: 'master', name: 'Master', transport: 'modbus-tcp-master', config: {
    host: '127.0.0.1', port: 502, enabled: true, timeoutMs: 1000,
    retryCount: 0, retryIntervalMs: 0, scheduler: { autoStart, minGapMs },
    requestGroups: [{ id: 'group', name: 'Read', enabled: true, unitId: 1,
      requests: [read, { ...read, id: 'read2', order: 1 }] }],
  } };
  const adapter = createUnavailableRuntimeAdapter('test');
  let session = null;
  let sequence = 0;
  const sent = [];
  adapter.endpoint.list = async () => [endpoint];
  adapter.transport.open = async () => ({ sessionId: (session = `session-${++sequence}`) });
  adapter.transport.close = async () => { session = null; };
  adapter.modbus.execute = async (command) => {
    sent.push({ sessionId: session, functionCode: command.functionCode });
    return { ...command, sessionId: session, origin: 'master', values: [9],
      success: true, createdAt: timers.now, durationMs: 0 };
  };
  const model = createWorkbenchModel(adapter, { timers, clock: () => timers.now });
  return { model, timers, endpoint, sent };
}
async function drain() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
async function open(f) {
  await f.model.commands.loadEndpoints();
  assert.equal((await f.model.commands.open('master', 'open-1')).ok, true);
  return { endpointId: 'master', sessionId: 'session-1', config: f.endpoint.config };
}

test('automatic polling stays stopped through model notifications until a new connection', async (t) => {
  const f = fixture({ autoStart: true });
  t.after(() => f.model.dispose());
  await open(f);
  f.model.modbusMasterScheduler.stop('master');
  f.model.selectEndpoint('master');
  f.model.setFrameFilters({ keyword: 'read' });
  assert.equal(f.model.modbusMasterScheduler.getStatus('master').active, false);
  assert.equal(f.timers.pendingCount(), 0);
  await f.model.commands.close('master');
  await f.model.commands.open('master', 'open-2');
  assert.equal(f.model.modbusMasterScheduler.getStatus('master').active, true);
});

test('closing a manually running group cancels its next request and old result publication', async (t) => {
  const f = fixture({ minGapMs: 1000 });
  t.after(() => f.model.dispose());
  const context = await open(f);
  const pending = f.model.modbusMasterScheduler.runGroup({ ...context, groupId: 'group' });
  await drain();
  assert.equal(f.sent.length, 1);
  await f.model.commands.close('master');
  await f.model.commands.open('master', 'open-2');
  if (f.timers.pendingCount()) await f.timers.runNext();
  assert.equal(await pending, null);
  assert.deepEqual(f.sent, [{ sessionId: 'session-1', functionCode: 3 }]);
});

test('closing while a confirmed write waits for the request gap prevents sending into the new session', async (t) => {
  const f = fixture({ minGapMs: 1000 });
  t.after(() => f.model.dispose());
  const context = await open(f);
  await f.model.modbusMasterScheduler.runRequest({ ...context, groupId: 'group', requestId: 'read' });
  const pending = f.model.modbusMasterScheduler.executeImmediate({ ...context,
    request: { functionCode: 6, unitId: 1, address: 0, quantity: 1, values: [42] } });
  await drain();
  await f.model.commands.close('master');
  await f.model.commands.open('master', 'open-2');
  if (f.timers.pendingCount()) await f.timers.runNext();
  assert.equal(await pending, null);
  assert.deepEqual(f.sent, [{ sessionId: 'session-1', functionCode: 3 }]);
});

for (const termination of ['error', 'closed', 'deleted', 'replaced']) {
  test(`${termination} invalidates a manual group even without an automatic polling job`, async (t) => {
    const f = fixture({ minGapMs: 1000 });
    t.after(() => f.model.dispose());
    const context = await open(f);
    const pending = f.model.modbusMasterScheduler.runGroup({ ...context, groupId: 'group' });
    await drain();
    const operations = new Map([['master', { sessionId: termination === 'replaced' ? 'session-2' : 'session-1' }]]);
    f.model.modbusMasterScheduler.reconcile({ endpoints: termination === 'deleted' ? [] : [f.endpoint],
      operations, statuses: new Map([['master', { status: ['error', 'closed'].includes(termination) ? termination : 'open' }]]) });
    await drain();
    assert.equal(await pending, null);
    assert.equal(f.timers.pendingCount(), 0);
    assert.equal(f.sent.length, 1);
  });
}
