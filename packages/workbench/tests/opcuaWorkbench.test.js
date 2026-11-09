import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive, watch } from 'vue';
import { createOpcuaWorkbench, parseOpcuaInput, opcuaCsv, safeOpcuaProfiles } from '../src/model/opcuaWorkbench.js';

function fixture(execute = async () => ({})) {
  let listener; const calls = [];
  return { calls, emit: event => listener(event), runtime: { opcua: { execute: async req => { calls.push(req); return execute(req); }, onEvent: fn => { listener = fn; return () => { listener = () => {}; }; } } } };
}
function scheduler() {
  let next = 0; const pending = new Map(); const callbacks = [];
  return {
    schedule(fn, delay) { assert.equal(delay, 50); callbacks.push(fn); pending.set(++next, fn); return next; },
    cancel(id) { pending.delete(id); },
    get size() { return pending.size; },
    callbacks,
    flush() { const batch = [...pending.values()]; pending.clear(); batch.forEach(fn => fn()); },
  };
}
test('OPC UA high frequency events publish bounded reactive snapshots with exact latest values and ordered history', async () => {
  const f = fixture(req => req.action === 'connect' ? { sessionId: 's' } : {});
  const clock = scheduler();
  const model = createOpcuaWorkbench(f.runtime, { reactive, schedule: clock.schedule, cancel: clock.cancel, now: () => 'received' });
  await model.connect();
  let valueUpdates = 0; let historyUpdates = 0;
  const unwatchValues = watch(() => Object.values(model.state.values).map(row => row.value), () => valueUpdates++, { flush: 'sync' });
  const unwatchHistory = watch(() => model.state.records.length, () => historyUpdates++, { flush: 'sync' });
  try {
    for (let turn = 0; turn < 10; turn++) {
      for (let offset = 0; offset < 250; offset++) {
        const value = turn * 250 + offset;
        f.emit({ type: 'data', connectionId: model.state.connectionId, sessionId: 's', values: [{ nodeId: `ns=2;s=V${value % 100}`, value }] });
      }
      clock.flush();
    }
    assert.ok(valueUpdates <= 10, `${valueUpdates} reactive value updates for 10 publication windows`);
    assert.ok(historyUpdates <= 10, `${historyUpdates} reactive history updates for 10 publication windows`);
    assert.equal(Object.keys(model.state.values).length, 100);
    for (let i = 0; i < 100; i++) assert.equal(model.state.values[`ns=2;s=V${i}`].value, 2400 + i);
    assert.deepEqual(model.state.records.map(row => row.value), Array.from({ length: 1000 }, (_, i) => 1500 + i));
    assert.ok(model.state.records.every(row => row.receivedAt === 'received'));
    assert.equal(clock.size, 0);
  } finally { unwatchValues(); unwatchHistory(); await model.dispose(); }
});
test('OPC UA export includes unpublished data and clear cannot resurrect buffered history', async () => {
  const f = fixture(req => req.action === 'connect' ? { sessionId: 's' } : req.action === 'export' ? { saved: true } : {});
  const clock = scheduler(); const model = createOpcuaWorkbench(f.runtime, { schedule: clock.schedule, cancel: clock.cancel });
  await model.connect();
  const emit = value => f.emit({ type: 'data', connectionId: model.state.connectionId, sessionId: 's', values: [{ nodeId: 'ns=2;s=Value', dataType: 'UInt64', value, statusCode: 'Good', sourceTimestamp: 'source', serverTimestamp: 'server' }] });
  emit('18446744073709551615');
  await model.exportData();
  assert.ok(f.calls.at(-1).content.includes('"18446744073709551615","Good","source","server"'));
  assert.equal(clock.size, 0);
  emit('2'); model.clearRecords(); emit('3'); clock.flush();
  assert.deepEqual(model.state.records.map(row => row.value), ['3']);
  assert.equal(model.state.values['ns=2;s=Value'].value, '3');
  emit('4'); model.clearRecords(); clock.flush();
  assert.equal(model.state.records.length, 0);
  assert.equal(model.state.values['ns=2;s=Value'].value, '4');
  await model.dispose(); assert.equal(clock.size, 0);
});
test('OPC UA pending publications end synchronously at disconnect, reconnect, and disposal', async () => {
  const f = fixture(req => req.action === 'connect' ? { sessionId: 's' } : {});
  const clock = scheduler(); const model = createOpcuaWorkbench(f.runtime, { schedule: clock.schedule, cancel: clock.cancel });
  await model.connect();
  const old = { type: 'data', connectionId: model.state.connectionId, sessionId: 's', values: [{ nodeId: 'i=2258', value: 1 }] };
  f.emit(old); assert.equal(clock.size, 1);
  await model.disconnect(); assert.equal(clock.size, 0);
  assert.equal(model.state.values['i=2258'].value, 1);
  await model.connect();
  f.emit(old); clock.callbacks.forEach(fn => fn());
  assert.deepEqual(model.state.values, {}); assert.deepEqual(model.state.records, []);
  f.emit({ ...old, connectionId: model.state.connectionId, values: [{ nodeId: 'i=2258', value: 2 }] });
  // Even a slow listener cleanup must not leave a live publication timer or session.
  const disposing = model.dispose();
  assert.equal(clock.size, 0); assert.equal(model.state.sessionId, null);
  await disposing;
  const snapshot = JSON.stringify(model.state);
  clock.callbacks.forEach(fn => fn());
  assert.equal(JSON.stringify(model.state), snapshot);
});
test('OPC UA latest values remain capped at 500 across publication windows', async () => {
  const f = fixture(req => req.action === 'connect' ? { sessionId: 's' } : {});
  const clock = scheduler(); const model = createOpcuaWorkbench(f.runtime, { schedule: clock.schedule, cancel: clock.cancel });
  await model.connect();
  for (let value = 0; value < 2000; value++) {
    f.emit({ type: 'data', connectionId: model.state.connectionId, sessionId: 's', values: [{ nodeId: `ns=2;s=V${value}`, value }] });
    if (value === 749) clock.flush();
  }
  clock.flush();
  assert.deepEqual(Object.values(model.state.values).map(row => row.value), Array.from({ length: 500 }, (_, i) => 1500 + i));
  assert.deepEqual(model.state.records.map(row => row.value), Array.from({ length: 1000 }, (_, i) => 1000 + i));
  await model.dispose();
});
test('OPC UA session endings discard browse continuation before a new session can use it', async () => {
  const f = fixture(req => req.action === 'connect' ? { sessionId: 'session' }
    : req.action === 'browse' ? { nodes: [], continuationPoint: 'old-token' } : {});
  const model = createOpcuaWorkbench(f.runtime);
  for (const ending of ['manual', 'terminal']) {
    await model.connect(); await model.browse();
    assert.equal(model.state.continuationPoint, 'old-token');
    if (ending === 'manual') await model.disconnect();
    else f.emit({ type: 'status', status: 'disconnected', connectionId: model.state.connectionId, sessionId: model.state.sessionId });
    assert.equal(model.state.continuationPoint, null);
    await model.connect();
    assert.equal(model.state.continuationPoint, null);
    await model.disconnect();
  }
  await model.dispose();
});
test('OPC UA edit values preserve wide integers and validate structured input', () => {
  assert.equal(parseOpcuaInput('Int64', 'Scalar', '-9223372036854775808'), '-9223372036854775808');
  assert.deepEqual(parseOpcuaInput('UInt64', 'Array', '["18446744073709551615"]'), ['18446744073709551615']);
  assert.throws(() => parseOpcuaInput('Int64', 'Scalar', '9223372036854775808'), /范围|range/);
  assert.throws(() => parseOpcuaInput('UInt64', 'Array', '[18446744073709551615]'), /字符串|精度/);
  assert.throws(() => parseOpcuaInput('Boolean', 'Scalar', 'no'), /true|false/);
  assert.throws(() => parseOpcuaInput('Int16', 'Scalar', '1.2'), /整数/);
});
test('OPC UA imported profiles and CSV remove passwords and spreadsheet formulas', () => {
  const profiles = safeOpcuaProfiles([{ id: 'a', name: 'A', config: { endpointUrl: 'opc.tcp://localhost:4840', password: 'secret' }, favorites: [] }]);
  assert.equal(JSON.stringify(profiles).includes('secret'), false);
  const csv = opcuaCsv([{ nodeId: 's=Test', dataType: 'String', value: '=1+2', statusCode: 'Good', sourceTimestamp: null, serverTimestamp: null }]);
  assert.ok(csv.includes("'=1+2"));
});
test('OPC UA old connect completion cannot replace state after cancel or leak its connection', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const f = fixture(req => req.action === 'connect' ? pending : Promise.resolve({}));
  const model = createOpcuaWorkbench(f.runtime);
  const connecting = model.connect(); await Promise.resolve();
  const oldId = f.calls.find(c => c.action === 'connect').connectionId;
  await model.disconnect(); resolve({ sessionId: 'old-session' }); await connecting;
  assert.equal(model.state.sessionId, null);
  assert.ok(f.calls.some(c => c.action === 'disconnect' && c.connectionId === oldId));
  await model.dispose();
});
test('OPC UA subscriptions fence old events and cap recorded changes independently of current values', async () => {
  const f = fixture(req => req.action === 'connect' ? { sessionId: 'current' } : {});
  const clock = scheduler(); const model = createOpcuaWorkbench(f.runtime, { schedule: clock.schedule, cancel: clock.cancel }); await model.connect();
  const base = { connectionId: model.state.connectionId, sessionId: 'current', type: 'data' };
  const row = { nodeId: 'ns=2;s=Value', dataType: 'Int32', value: 3, statusCode: 'Good' };
  f.emit({ ...base, sessionId: 'old', values: [row] }); assert.equal(model.state.records.length, 0);
  for (let i = 0; i < 1010; i++) f.emit({ ...base, values: [{ ...row, value: i }] });
  // Subscription updates publish on the scheduled boundary; reads remain immediate.
  clock.flush();
  assert.equal(model.state.records.length, 1000); assert.equal(model.state.values[row.nodeId].value, 1009);
  model.clearRecords(); assert.equal(model.state.values[row.nodeId].value, 1009);
  await model.disconnect(); f.emit({ ...base, values: [row] }); assert.equal(model.state.records.length, 0);
  await model.dispose();
});

test('OPC UA IPC boundary snapshots Vue reactive selections and nested profile state', async () => {
  const f = fixture(req => {
    structuredClone(req); // Electron IPC applies the same clone requirement.
    if (req.action === 'connect') return {sessionId:'reactive-session'};
    if (req.action === 'read') return {values:[]};
    if (req.action === 'subscribe') return {subscriptionId:'reactive-subscription'};
    return {};
  });
  const model=createOpcuaWorkbench(f.runtime,{reactive});await model.connect();
  const selected=reactive(['ns=2;s=Changing']);
  await model.read(selected);assert.equal(model.state.error,'');
  await model.subscribe(selected);assert.equal(model.state.error,'');assert.equal(model.state.subscriptionId,'reactive-subscription');
  selected.push('ns=2;s=Counter');assert.deepEqual(f.calls.find(c=>c.action==='subscribe').nodeIds,['ns=2;s=Changing']);
  await model.dispose();
});
test('failed OPC UA subscription replacement clears the old monitoring indicator', async () => {
  let subscriptions=0;
  const f=fixture(req=>{if(req.action==='connect')return {sessionId:'s'};if(req.action==='subscribe'){if(++subscriptions===1)return {subscriptionId:'old'};throw new Error('BadNodeIdUnknown');}return {};});
  const model=createOpcuaWorkbench(f.runtime);await model.connect();await model.subscribe(['i=2258']);assert.equal(model.state.subscriptionId,'old');
  await model.subscribe(['ns=2;s=Missing']);assert.match(model.state.error,/BadNodeIdUnknown/);assert.equal(model.state.subscriptionId,null);assert.deepEqual(model.state.monitored,[]);await model.dispose();
});
test('invalid OPC UA subscription replacement preserves the running monitor and can stop it', async () => {
  const f = fixture(req => req.action === 'connect' ? { sessionId: 's' } : req.action === 'subscribe' ? { subscriptionId: 'old' } : {});
  const model = createOpcuaWorkbench(f.runtime); await model.connect();
  await model.subscribe(['ns=2;s=Changing'], 100);
  for (const [ids, interval] of [[['ns=2;s=Changing'], 99], [['ns=2;s=Changing'], 60001], [['ns=2;s=Changing'], 100.5], [[], 100], [['invalid'], 100]]) {
    await model.subscribe(ids, interval);
    assert.ok(model.state.error);
    assert.equal(model.state.subscriptionId, 'old');
    assert.deepEqual(model.state.monitored, ['ns=2;s=Changing']);
    assert.equal(f.calls.filter(req => req.action === 'subscribe').length, 1);
  }
  await model.unsubscribe();
  assert.ok(f.calls.some(req => req.action === 'unsubscribe'));
  assert.equal(model.state.subscriptionId, null); assert.deepEqual(model.state.monitored, []);
  await model.dispose();
});
test('terminal OPC UA event clears session state while preserving values and permits reconnect', async () => {
  const f=fixture(req=>req.action==='connect'?{sessionId:'s'}:{});
  const model=createOpcuaWorkbench(f.runtime);await model.connect();model.state.subscriptionId='sub';model.state.monitored=['i=2258'];
  const base={connectionId:model.state.connectionId,sessionId:'s'};f.emit({...base,type:'data',values:[{nodeId:'i=2258',value:42}]});
  f.emit({...base,type:'status',status:'disconnected',message:'Read timed out'});
  assert.equal(model.state.sessionId,null);assert.equal(model.state.subscriptionId,null);assert.deepEqual(model.state.monitored,[]);assert.equal(model.state.status,'disconnected');assert.equal(model.state.statusMessage,'Read timed out');assert.equal(model.state.values['i=2258'].value,42);assert.equal(model.state.records.length,1);
  f.emit({...base,type:'data',values:[{nodeId:'i=2258',value:99}]});assert.equal(model.state.values['i=2258'].value,42);
  await model.connect();assert.equal(model.state.status,'connected');await model.dispose();
});


test('abandoned OPC UA pages are released before browsing and at the display limit', async () => {
  let next = 0;
  const f = fixture(req => req.action === 'connect' ? { sessionId: 's' } : req.action === 'browse' ? { nodes: Array.from({ length: 100 }, (_, i) => ({ nodeId: `i=${i}` })), continuationPoint: `cp${++next}` } : {});
  const model = createOpcuaWorkbench(f.runtime);
  await model.connect();
  await model.browse(); await model.browse();
  assert.deepEqual(f.calls.slice(-2).map(r => [r.action, r.continuationPoint]), [['releaseBrowse', 'cp1'], ['browse', undefined]]);
  for (let i = 0; i < 19; i++) await model.browse(undefined, true);
  assert.equal(model.state.nodes.length, 2000);
  assert.equal(model.state.continuationPoint, null);
  assert.equal(f.calls.at(-1).action, 'releaseBrowse');
  assert.equal(f.calls.at(-1).continuationPoint, 'cp21');
  await model.dispose();
});

test('failed OPC UA release preserves the cursor for retry and blocks a new browse', async () => {
  let fail = true;
  const f = fixture(req => {
    if (req.action === 'connect') return { sessionId: 's' };
    if (req.action === 'releaseBrowse' && fail) throw new Error('release failed');
    return { nodes: [], continuationPoint: 'cp' };
  });
  const model = createOpcuaWorkbench(f.runtime); await model.connect(); await model.browse();
  assert.equal(await model.browse(), false);
  assert.equal(model.state.error, 'release failed');
  assert.equal(model.state.continuationPoint, 'cp');
  assert.equal(f.calls.filter(r => r.action === 'browse').length, 1);
  fail = false; await model.browse();
  assert.equal(model.state.error, '');
  await model.dispose();
});
