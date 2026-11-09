import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDlt645ReadRequest, buildDlt645ReadResponse, parseDlt645Frame } from '@ineed-linklab/codecs/dlt645.js';
import { createUnavailableRuntimeAdapter } from '../../runtime-contract/src/index.js';
import { createWorkbenchModel } from '../src/model/createWorkbenchModel.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

async function fixture(t, responseDelayMs = 0) {
  const endpoint = { id: 'simulator', name: 'Meter', transport: 'dlt645-slave', config: {
    path: '/dev/tty.test', responseDelayMs, wakeUpBytes: 0,
    meters: [{ id: 'meter', address: '123456789012', enabled: true, tasks: [{
      id: 'voltage', identifier: '02010100', enabled: true, value: 230.1,
      byteLength: 2, decimals: 1, signed: false,
    }] }],
  } };
  const adapter = createUnavailableRuntimeAdapter('test');
  const timers = createFakeTimers();
  const sent = [];
  const historyRecords = [];
  let onFrames;
  let sequence = 0;
  adapter.endpoint.list = async () => [endpoint];
  adapter.transport.onFrames = (listener) => { onFrames = listener; return () => {}; };
  adapter.transport.open = async () => ({ sessionId: `session-${++sequence}` });
  adapter.transport.close = async () => ({});
  adapter.transport.send = async (request) => { sent.push({ ...request, sessionId: `session-${sequence}` }); return { sessionId: `session-${sequence}` }; };
  adapter.sendHistory.record = async (record) => { historyRecords.push(record); return {}; };
  const model = createWorkbenchModel(adapter, { timers });
  t.after(() => model.dispose());
  await model.commands.loadEndpoints();
  await model.commands.open('simulator', 'open-1');
  const receive = (session = sequence, bytes = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100' })) => onFrames({
    endpointId: 'simulator', operationId: `open-${session}`, sessionId: `session-${session}`,
    frames: [{ endpointId: 'simulator', operationId: `open-${session}`, sessionId: `session-${session}`,
      direction: 'in', bytes, createdAt: timers.now }],
  });
  return { model, timers, receive, sent, historyRecords };
}
async function drain() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test('a connected simulator answers fresh frames without a mounted or selected view', async (t) => {
  const f = await fixture(t);
  f.model.selectEndpoint(null);
  f.receive(); await drain();
  assert.equal(f.sent.length, 1);
  assert.equal(parseDlt645Frame(f.sent[0].bytes).dataIdentifier, '02010100');
  f.model.selectEndpoint('simulator'); f.model.selectEndpoint(null);
  await drain(); assert.equal(f.sent.length, 1);
  f.receive(); await drain(); assert.equal(f.sent.length, 2);
});

test('close and reopen cancel delayed and queued replies; stale frames cannot restart them', async (t) => {
  const f = await fixture(t, 1000);
  f.receive(); f.receive(); await drain();
  assert.equal(f.timers.pendingCount(), 1);
  await f.model.commands.close('simulator');
  await f.model.commands.open('simulator', 'open-2');
  await drain();
  assert.equal(f.timers.pendingCount(), 0);
  assert.equal(f.sent.length, 0);
  f.receive(1); await drain(); assert.equal(f.timers.pendingCount(), 0);
  f.receive(2); await drain(); await f.timers.runNext(); await drain();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].sessionId, 'session-2');
});

test('dispose clears the simulator delay and parser remainder', async (t) => {
  const f = await fixture(t, 1000);
  f.receive(); await drain();
  f.model.dispose(); await drain();
  assert.equal(f.timers.pendingCount(), 0);
  assert.equal(f.sent.length, 0);
});


test('a damaged-length request cannot prevent a subsequent valid simulator request from being answered', async (t) => {
  const f = await fixture(t);
  const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0 });
  const damaged = Uint8Array.from(valid);
  damaged[9] = 20;
  f.receive(1, Uint8Array.of(...damaged, ...valid.slice(0, 8)));
  await drain();
  assert.equal(f.sent.length, 0);
  f.receive(1, valid.slice(8));
  await drain();
  assert.equal(f.sent.length, 1);
  assert.equal(parseDlt645Frame(f.sent[0].bytes).dataIdentifier, '02010100');
});

test('a false long header inside a rejected request does not hide a complete simulator request', async (t) => {
  const f = await fixture(t);
  const damaged = new Uint8Array(32);
  damaged[0] = damaged[7] = 0x68;
  damaged[9] = 20;
  damaged.set([0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255], 10);
  const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0 });
  f.receive(1, Uint8Array.of(...damaged, ...valid));
  await drain();
  assert.equal(f.sent.length, 1);
  assert.equal(parseDlt645Frame(f.sent[0].bytes).dataIdentifier, '02010100');
});

test('simulator recovery continues across chunks after an incomplete false header', async (t) => {
  const f = await fixture(t);
  const damaged = new Uint8Array(32);
  damaged[0] = damaged[7] = 0x68;
  damaged[9] = 20;
  damaged.set([0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255], 10);
  const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4 });
  f.receive(1, Uint8Array.of(...damaged, ...valid.slice(0, -3)));
  await drain();
  assert.equal(f.sent.length, 0);
  f.receive(1, valid.slice(-3));
  await drain();
  assert.equal(f.sent.length, 1);
  assert.equal(parseDlt645Frame(f.sent[0].bytes).dataIdentifier, '02010100');
});

test('simulator reconnect clears recovery state and partial bytes', async (t) => {
  const f = await fixture(t);
  const damaged = new Uint8Array(32);
  damaged[0] = damaged[7] = 0x68;
  damaged[9] = 20;
  damaged.set([0x68, 0, 0, 0, 0, 0, 0, 0x68, 0, 255], 10);
  const valid = buildDlt645ReadRequest({ address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0 });
  f.receive(1, Uint8Array.of(...damaged, ...valid.slice(0, -3)));
  await drain();
  await f.model.commands.close('simulator');
  await f.model.commands.open('simulator', 'open-2');
  f.receive(2, valid.slice(-3));
  f.receive(2, Uint8Array.of(0x68, 0, 0, 0, 0, 0, 0, 0x68, 0x11, 255, ...valid));
  await drain();
  assert.equal(f.sent.length, 0);
});


test('controller responses preserve the existing DL/T protocol marker through model wire and logical history', async (t) => {
  const f = await fixture(t);
  f.receive();
  await drain();
  const expected = buildDlt645ReadResponse({ address: '123456789012', dataIdentifier: '02010100',
    value: 230.1, byteLength: 2, decimals: 1, signed: false, wakeUpBytes: 0 });
  assert.equal(f.sent.length, 1);
  const { sessionId, ...wire } = f.sent[0];
  assert.equal(sessionId, 'session-1');
  assert.deepEqual(Object.keys(wire).sort(), ['bytes', 'endpointId', 'framing', 'target']);
  assert.deepEqual(wire.bytes, expected);
  assert.equal(wire.framing, 'dlt645');
  assert.deepEqual(wire.target, { endpointId: 'simulator', expectedSessionId: 'session-1' });
  assert.equal(f.historyRecords.length, 1);
  assert.equal(f.historyRecords[0].framing, 'dlt645');
  assert.equal(f.historyRecords[0].format, 'text');
  assert.equal(f.historyRecords[0].payloadBase64, Buffer.from(expected).toString('base64'));
});
