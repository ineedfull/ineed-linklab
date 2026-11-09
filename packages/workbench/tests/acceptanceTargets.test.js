import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptanceTargets } from '../src/model/acceptanceTargets.js';
import { createModbusMasterScheduler } from '../src/model/modbusMasterScheduler.js';
import { plan } from './acceptanceFixtures.js';

function fixture() {
  const endpoint = {
    id: 'm',
    name: 'Master',
    transport: 'modbus-tcp-master',
    config: { host: '127.0.0.1', port: 502, scheduler: { minGapMs: 0 } },
  };
  const model = {
    state: {
      endpoints: [endpoint],
      operations: new Map([['m', { sessionId: 's' }]]),
      statuses: new Map([['m', { status: 'connected' }]]),
    },
  };
  let reply = (request) => ({
    ...request,
    sessionId: request.expectedSessionId,
    success: true,
    values: [7],
  });
  const calls = [];
  model.modbusMasterScheduler = createModbusMasterScheduler({
    execute: async (request) => {
      calls.push(request);
      return reply(request);
    },
  });
  const api = {
    state: {
      status: 'connected',
      sessionId: 'o-s',
      connectionId: 'o-c',
      config: { endpointUrl: 'opc.tcp://user:password@127.0.0.1:4840' },
    },
  };
  const catalog = {
    endpoints: [{ id: 'o', name: 'Client', transport: 'opcua-client' }],
    state: { instances: new Map([['o', api]]) },
  };
  let opcReply = {
    values: [
      {
        nodeId: 'ns=1;s=value',
        value: 8,
        statusCode: 'Good (0x00000000)',
        dataType: 'Int32',
      },
    ],
  };
  const runtime = {
    opcua: {
      execute: async (request) => {
        calls.push(request);
        return opcReply;
      },
    },
  };
  return {
    model,
    api,
    calls,
    targets: createAcceptanceTargets({
      model,
      getCatalog: () => catalog,
      runtime,
    }),
    setReply: (value) => {
      reply = value;
    },
    setOpc: (value) => {
      opcReply = value;
    },
  };
}
test('connected read-only targets capture independent config and share the actual Modbus scheduler', async () => {
  const f = fixture();
  assert.deepEqual(
    f.targets.list().map((t) => t.endpointId),
    ['m', 'o'],
  );
  const captured = f.targets.captureTarget('m', 'modbus');
  f.model.state.endpoints[0].config.host = 'changed';
  assert.equal(captured.config.host, '127.0.0.1');
  const result = await f.targets.read(captured, plan().checks[0]);
  assert.deepEqual(result.actual, [7]);
  assert.equal(result.quality, 'Good');
  assert.equal(f.calls[0].expectedSessionId, 's');
  f.model.state.statuses.get('m').status = 'closed';
  assert.equal(f.targets.isCurrent(captured), false);
  assert.throws(() => f.targets.captureTarget('m', 'modbus'));
  assert.equal(f.targets.list().length, 1);
});
test('Modbus rejects wrong endpoint/session and write functions before any unsafe read', async () => {
  const f = fixture();
  const target = f.targets.captureTarget('m', 'modbus');
  for (const override of [
    { endpointId: 'other' },
    { sessionId: 'old' },
    { success: false },
  ]) {
    f.setReply((request) => ({
      ...request,
      sessionId: 's',
      success: true,
      values: [7],
      ...override,
    }));
    await assert.rejects(f.targets.read(target, plan().checks[0]));
  }
  const count = f.calls.length;
  await assert.rejects(
    f.targets.read(target, {
      ...plan().checks[0],
      query: { ...plan().checks[0].query, functionCode: 6 },
    }),
  );
  assert.equal(f.calls.length, count);
});
test('OPC UA reads fresh captured session and rejects wrong/missing node/value without leaking credentials', async () => {
  const f = fixture();
  const target = f.targets.captureTarget('o', 'opcua');
  assert.equal(target.identity.includes('password'), false);
  assert.equal(target.identity.includes('user'), false);
  const result = await f.targets.read(target, plan('opcua').checks[0]);
  assert.equal(result.actual, 8);
  assert.equal(result.quality, 'Good');
  assert.deepEqual(f.calls[0], {
    action: 'read',
    connectionId: 'o-c',
    sessionId: 'o-s',
    nodeIds: ['ns=1;s=value'],
  });
  for (const values of [
    [{ nodeId: 'wrong', value: 7 }],
    [{ nodeId: 'ns=1;s=value' }],
    [],
  ]) {
    f.setOpc({ values });
    await assert.rejects(f.targets.read(target, plan('opcua').checks[0]));
  }
  f.api.state.sessionId = 'new';
  await assert.rejects(f.targets.read(target, plan('opcua').checks[0]));
});
