import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import net from 'node:net';
import test from 'node:test';
import { REQUIRED_RUNTIME_METHODS } from '@ineed-linklab/runtime-contract';

import { createWorkbenchModel } from '../src/model/createWorkbenchModel.js';
import { encodeSendPayload } from '../src/model/sendPayloadCodec.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const require = createRequire(import.meta.url);
const { TcpService } = require('../../../apps/electron/electron/tcpService.cjs');

function adapterWith(send, records = []) {
  const adapter = { runtimeName: 'wire-test' };
  for (const method of REQUIRED_RUNTIME_METHODS) {
    const [scope, name] = method.split('.');
    adapter[scope] ??= {};
    adapter[scope][name] = name.startsWith('on') ? () => () => {} : async () => null;
  }
  adapter.transport.send = send;
  adapter.sendHistory.record = async (record) => { records.push(structuredClone(record)); return record; };
  return adapter;
}

const ping = new TextEncoder().encode('ping');
const cases = [
  ['none', ping, '70696e67'],
  ['datagram', ping, '70696e67'],
  ['dlt645', ping, '70696e67'],
  ['line', ping, '70696e670a'],
  ['length-prefix', ping, '0000000470696e67'],
  ['line', new TextEncoder().encode('ping\r'), '70696e670d'],
  ['line', new TextEncoder().encode('ping\n'), '70696e670a'],
  ['line', new TextEncoder().encode('ping\r\n'), '70696e670d0a'],
  ['length-prefix', new TextEncoder().encode('你好'), '00000006e4bda0e5a5bd'],
];

for (const [framing, bytes, hex] of cases) {
  test(`shared command sends ${framing} wire ${hex} and keeps logical history`, async () => {
    const wire = [];
    const records = [];
    const model = createWorkbenchModel(adapterWith(async (request) => {
      wire.push(request);
      return { sessionId: 's1', byteCount: request.bytes.length };
    }, records));
    const target = { type: 'peer', peerIds: ['peer-a'], expectedSessionId: 's1' };
    const request = { endpointId: 'tcp-1', bytes: bytes.slice(), target, format: 'text', framing };
    const before = structuredClone(request);
    const result = await model.commands.send(request);
    assert.equal(result.ok, true);
    assert.equal(Buffer.from(wire[0].bytes).toString('hex'), hex);
    assert.deepEqual(Object.keys(wire[0]).sort(), ['bytes', 'endpointId', 'framing', 'target']);
    assert.deepEqual(wire[0].target, target);
    assert.deepEqual(request, before);
    assert.equal(records[0].payloadBase64, Buffer.from(bytes).toString('base64'));
    assert.equal(records[0].format, 'text');
    assert.equal(records[0].framing, framing);
    assert.equal(records[0].sessionId, 's1');
    model.dispose();
  });
}

for (const [mode, payload, appendCrlf, framing, hex] of [
  ['hex', '70 69 6e 67', false, 'length-prefix', '0000000470696e67'],
  ['json', '{"a":1}', false, 'length-prefix', '0000000c7b0a20202261223a20310a7d'],
  ['text', 'ping', true, 'line', '70696e670d0a'],
]) {
  test(`content ${mode} with CRLF=${appendCrlf} uses the same wire boundary`, async () => {
    let wire;
    const records = [];
    const model = createWorkbenchModel(adapterWith(async (request) => { wire = request.bytes; return {}; }, records));
    const logical = encodeSendPayload({ mode, payload, appendCrlf });
    assert.equal(logical.ok, true);
    await model.commands.send({ endpointId: 'ep', bytes: logical.bytes, format: mode, framing });
    assert.equal(Buffer.from(wire).toString('hex'), hex);
    assert.equal(records[0].payloadBase64, Buffer.from(logical.bytes).toString('base64'));
    model.dispose();
  });
}

test('scheduled repetitions and history resend each encode the logical prefix once', async () => {
  const timers = createFakeTimers();
  const wires = [];
  const records = [];
  const model = createWorkbenchModel(adapterWith(async (request) => {
    wires.push(Buffer.from(request.bytes).toString('hex'));
    return { sessionId: 's1' };
  }, records), { timers });
  model.scheduledSender.start({ endpointId: 'ep', sessionId: 's1', count: 3, intervalMs: 100,
    request: { endpointId: 'ep', bytes: ping, framing: 'length-prefix', format: 'text' } });
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (index < 2) await timers.runNext();
  }
  assert.equal(model.scheduledSender.getStatus('ep').sentCount, 3);
  const row = records[0];
  await model.commands.send({ endpointId: row.endpointId,
    bytes: new Uint8Array(Buffer.from(row.payloadBase64, 'base64')), format: row.format, framing: row.framing });
  assert.deepEqual(wires, Array(4).fill('0000000470696e67'));
  assert.ok(records.every(({ payloadBase64 }) => payloadBase64 === 'cGluZw=='));
  model.dispose();
});

test('caller mutation while native send awaits does not alter logical history or native envelope', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let wire;
  const records = [];
  const model = createWorkbenchModel(adapterWith(async (request) => { wire = request; await pending; return {}; }, records));
  const request = { endpointId: 'ep', bytes: ping.slice(), format: 'text', framing: 'none', target: { peerId: 'A' } };
  const sending = model.commands.send(request);
  request.bytes.fill(0);
  request.target.peerId = 'B';
  release();
  await sending;
  assert.equal(Buffer.from(wire.bytes).toString('hex'), '70696e67');
  assert.equal(wire.target.peerId, 'A');
  assert.equal(records[0].payloadBase64, 'cGluZw==');
  assert.equal(records[0].target.peerId, 'A');
  model.dispose();
});

test('real Electron TCP socket receives framed model wire bytes', { timeout: 10_000 }, async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const service = new TcpService({ emitEvent: () => {} });
  const model = createWorkbenchModel(adapterWith((request) => service.send(request)));
  let remote;
  try {
    await service.open({ id: 'tcp-1', transport: 'tcp-client', config: {
      host: '127.0.0.1', port: server.address().port, receiveFraming: { mode: 'raw' },
    } }, { operationId: 'op1' });
    [remote] = await accepted;
    for (const [framing, bytes, hex] of cases) {
      const received = receiveBytes(remote, hex.length / 2);
      const result = await model.commands.send({ endpointId: 'tcp-1', bytes, framing, format: 'text' });
      assert.equal(result.ok, true);
      assert.equal((await received).toString('hex'), hex);
    }
  } finally {
    model.dispose();
    await service.shutdown();
    remote?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

function receiveBytes(socket, expected) {
  return new Promise((resolve) => {
    const chunks = [];
    let count = 0;
    const finish = () => { clearTimeout(timer); socket.off('data', onData); resolve(Buffer.concat(chunks)); };
    const onData = (data) => { chunks.push(data); count += data.length; if (count >= expected) finish(); };
    const timer = setTimeout(finish, 500);
    socket.on('data', onData);
  });
}


test('unsupported wire framing still rejects before native send', async () => {
  let nativeCalls = 0;
  const model = createWorkbenchModel(adapterWith(async () => { nativeCalls += 1; return {}; }));
  const result = await model.commands.send({ endpointId: 'ep', bytes: ping, framing: 'unexpected' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Unsupported send framing/);
  assert.equal(nativeCalls, 0);
  model.dispose();
});
