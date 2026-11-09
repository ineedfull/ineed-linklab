import assert from 'node:assert/strict';
import test from 'node:test';
import { createModbusSlaveSimulation, validateSimulationSettings } from '../src/model/modbusSlaveSimulation.js';
import { readModbusDataPoint } from '../src/model/modbusDataPoints.js';

const points = [
  { id: 'f', name: '模数', dataType: 'float32', area: 'holdingRegisters', address: 5000, scale: 1 },
  { id: 't', name: '温度', dataType: 'int16', area: 'holdingRegisters', address: 5002, scale: 0.5 },
  { id: 'id', name: '编号', dataType: 'ascii', area: 'holdingRegisters', address: 5003, length: 5 },
];
const settings = { intervalMs: 100, rules: [
  { pointId: 'f', min: 10, max: 11, step: 0.5 },
  { pointId: 't', min: -1, max: 0, step: 0.5 },
] };
function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return { pending,
    setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimeout(key) { pending.delete(key); },
    async next() {
      const entry = pending.entries().next().value;
      if (!entry) return;
      pending.delete(entry[0]); entry[1].fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}
function setup(writeMap = async () => {}) {
  const timers = fakeTimers();
  const manager = createModbusSlaveSimulation({ writeMap, timers });
  manager.configure('slave', points, settings);
  return { timers, manager, start: (sessionId = 's1') => manager.start({ endpointId: 'slave', sessionId, points }) };
}

test('default off, cycles encoded business values, leaves fixed fields untouched and stops without timers', async () => {
  const calls = [];
  const { manager, timers, start } = setup(async (request) => { calls.push(request); });
  assert.equal(manager.getStatus('slave').active, false);
  assert.equal(timers.pending.size, 0);
  start();
  for (let i = 0; i < 4; i++) await timers.next();
  assert.deepEqual(calls.map((request) => readModbusDataPoint(
    points[request.address === 5000 ? 0 : 1],
    { areas: { holdingRegisters: { start: request.address, values: request.values } } },
  ).value), [10, -1, 10.5, -0.5, 11, 0, 10, -1]);
  assert.ok(calls.every((request) => request.expectedSessionId === 's1' && request.address < 5003));
  manager.stop('slave');
  assert.equal(timers.pending.size, 0);
  manager.dispose();
});

test('rejects empty selection, ASCII, invalid range, fractional integer and floating overflow before writing', () => {
  for (const bad of [
    { ...settings, rules: [] }, { ...settings, intervalMs: '' }, { ...settings, intervalMs: 99 },
    ...[{ pointId: 'id', min: 0, max: 10, step: 1 },
      { pointId: 'f', min: 0, max: 1e39, step: 1 },
      { pointId: 't', min: 0, max: 1, step: 0.1 },
      { pointId: 'f', min: 0, max: 1, step: 2 },
      { pointId: 'f', min: '', max: 1, step: 1 },
    ].map((rule) => ({ ...settings, rules: [rule] })),
  ]) assert.throws(() => validateSimulationSettings(points, bad));
});

test('in-flight stop and restart serialize writes and abandon remaining old points', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { manager, timers, start } = setup(async (request) => {
    calls.push(request);
    if (calls.length === 1) await pending;
  });
  start(); await timers.next();
  start('s2'); await timers.next();
  assert.equal(calls.length, 1);
  release();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.deepEqual(calls.map((request) => [request.expectedSessionId, request.address]), [
    ['s1', 5000], ['s2', 5000], ['s2', 5002],
  ]);
  assert.equal(timers.pending.size, 1);
  manager.dispose(); assert.equal(timers.pending.size, 0);
});

test('page/selection reconciliation keeps simulation; session change, removal, reset and write failure stop it', async () => {
  const { manager, start, timers } = setup();
  const context = { endpoints: [{ id: 'slave', transport: 'modbus-rtu-slave', config: { dataPoints: points } }],
    operations: new Map([['slave', { sessionId: 's1' }]]), statuses: new Map() };
  start(); manager.reconcile(context);
  assert.equal(manager.getStatus('slave').active, true);
  manager.reconcile({ ...context, operations: new Map() });
  assert.equal(manager.getStatus('slave').active, false);
  assert.equal(timers.pending.size, 0);
  assert.ok(manager.getStatus('slave').settings);
  start(); manager.reconcile({ ...context, endpoints: [] });
  assert.equal(manager.getStatus('slave').settings, null);
  manager.configure('slave', points, settings); start();
  manager.reconcile({ ...context, reset: true });
  assert.equal(manager.getStatus('slave').settings, null);
  const failed = setup(async () => { throw new Error('connection lost'); });
  failed.start(); await failed.timers.next();
  assert.equal(failed.manager.getStatus('slave').active, false);
  assert.match(failed.manager.getStatus('slave').error, /connection lost/);
  assert.equal(failed.timers.pending.size, 0);
});

test('endpoints run independently and do not restart after stop', async () => {
  const { manager, start, timers } = setup();
  manager.configure('other', points, settings);
  start(); manager.start({ endpointId: 'other', sessionId: 'other-session', points });
  manager.stop('slave');
  assert.equal(manager.getStatus('other').active, true);
  await timers.next();
  assert.equal(manager.getStatus('slave').active, false);
  manager.dispose();
});

test('decimal integer scaling cycles without precision failures and preserves byte/word order', async () => {
  const scaled = [{ ...points[1], scale: 0.1, byteOrder: 'little-endian', wordOrder: 'low-first' }];
  const calls = [], timers = fakeTimers();
  const manager = createModbusSlaveSimulation({ timers, writeMap: async (request) => { calls.push(request); } });
  manager.configure('scaled', scaled, { intervalMs: 100, rules: [{ pointId: 't', min: 0, max: 1, step: 0.1 }] });
  manager.start({ endpointId: 'scaled', sessionId: 's', points: scaled });
  for (let i = 0; i < 13; i++) await timers.next();
  assert.equal(manager.getStatus('scaled').error, '');
  assert.deepEqual(calls.map(({ values }) => values[0]), [...Array.from({ length: 11 }, (_, i) => i << 8), 0, 256]);
  manager.dispose();
});

test('tiny float64 ranges wrap rather than sticking to the maximum', async () => {
  const tiny = [{ ...points[0], dataType: 'float64' }];
  const calls = [], timers = fakeTimers();
  const manager = createModbusSlaveSimulation({ timers, writeMap: async (request) => { calls.push(request); } });
  manager.configure('tiny', tiny, { intervalMs: 100, rules: [{ pointId: 'f', min: 0, max: 2e-20, step: 1e-20 }] });
  manager.start({ endpointId: 'tiny', sessionId: 's', points: tiny });
  for (let i = 0; i < 4; i++) await timers.next();
  const values = calls.map((request) => readModbusDataPoint(tiny[0], { areas: { holdingRegisters: { start: 5000, values: request.values } } }).value);
  assert.deepEqual(values, [0, 1e-20, 2e-20, 0]);
  manager.dispose();
});
