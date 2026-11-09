import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createOpcuaWorkbench } from '../../../packages/workbench/src/model/opcuaWorkbench.js';
const require = createRequire(import.meta.url);

test('terminal OPC UA client closes release native slots after the workbench forgets the connection', async t => {
  const { OpcuaService } = require('../electron/opcuaService.cjs');
  let listener;
  let client;
  let closedSessions = 0;
  const service = new OpcuaService({ directory: '/unused', emitEvent: event => listener?.(event) });
  service.initialize = async () => {};
  service.ua = { UserTokenType: { Anonymous: 0 } };
  service.client = () => {
    const next = new EventEmitter();
    next.connect = async () => {};
    next.createSession = async () => ({ async close() { closedSessions++; } });
    next.disconnect = async () => { next.emit('close'); };
    client = next;
    return next;
  };
  const workbench = createOpcuaWorkbench({ opcua: {
    execute: request => service.execute(request),
    onEvent(callback) { listener = callback; return () => { listener = null; }; },
  } });
  t.after(async () => { await workbench.dispose(); await service.shutdown(); });
  for (let attempt = 0; attempt < 9; attempt++) {
    assert.equal(await workbench.connect(), true, workbench.state.error);
    client.emit('close', new Error('Reconnect attempts exhausted'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workbench.state.sessionId, null);
    assert.equal(workbench.state.connectionId, '');
    assert.equal(service.connections.size, 0);
    assert.equal(closedSessions, attempt + 1);
  }
});

test('a retired OPC UA client cannot close a replacement with the same connection ID', async t => {
  const { OpcuaService } = require('../electron/opcuaService.cjs');
  const clients = [];
  const service = new OpcuaService({ directory: '/unused' });
  service.initialize = async () => {};
  service.ua = { UserTokenType: { Anonymous: 0 } };
  service.client = () => {
    const client = new EventEmitter();
    client.connect = async () => {};
    client.createSession = async () => ({ async close() {} });
    client.disconnect = async () => { client.emit('close'); };
    clients.push(client);
    return client;
  };
  t.after(() => service.shutdown());
  const config = { endpointUrl: 'opc.tcp://127.0.0.1:4840' };
  const first = await service.connect('reused', config);
  const replacement = await service.connect('reused', config);
  clients[0].emit('close', new Error('Late old close'));
  assert.throws(() => service.session({ connectionId: 'reused', sessionId: first.sessionId }), /失效|expired/);
  assert.equal(service.session({ connectionId: 'reused', sessionId: replacement.sessionId }).sessionId, replacement.sessionId);
});

test('cancelled OPC UA opens still close a session returned after initial cleanup', async t => {
  const { OpcuaService } = require('../electron/opcuaService.cjs');
  let finishSession;
  let sessionClosed = 0;
  const service = new OpcuaService({ directory: '/unused' });
  service.initialize = async () => {};
  service.ua = { UserTokenType: { Anonymous: 0 } };
  const client = new EventEmitter();
  client.connect = async () => {};
  client.createSession = () => new Promise(resolve => { finishSession = resolve; });
  client.disconnect = async () => { client.emit('close'); };
  service.client = () => client;
  t.after(() => service.shutdown());
  const opening = service.connect('cancelled', { endpointUrl: 'opc.tcp://127.0.0.1:4840' });
  const rejection = assert.rejects(opening, /closed|结束/);
  await new Promise(resolve => setImmediate(resolve));
  await service.disconnect('cancelled');
  finishSession({ async close() { sessionClosed++; } });
  await rejection;
  assert.equal(sessionClosed, 1);
});

test('OPC UA native validates typed writes without losing 64 bit precision', async () => {
  const { validateWriteValue, encodeValue, decodeValue } = require('../electron/opcuaValues.cjs');
  const ua = require('node-opcua');
  assert.deepEqual(decodeValue('Int64', 'Scalar', '-9223372036854775808', ua), [0x80000000, 0]);
  assert.equal(encodeValue('Int64', [0xffffffff, 0xffffffff]), '-1');
  assert.equal(encodeValue('UInt64', [0xffffffff, 0xffffffff]), '18446744073709551615');
  assert.throws(() => validateWriteValue('UInt64', 'Scalar', '18446744073709551616'), /range|范围/);
  assert.throws(() => validateWriteValue('Int32', 'Scalar', 1.5), /integer|整数/);
  assert.throws(() => validateWriteValue('Boolean', 'Scalar', 'false'), /Boolean|布尔/);
  assert.throws(() => validateWriteValue('Double', 'Scalar', Infinity), /finite|有限/);
  assert.throws(() => validateWriteValue('DateTime', 'Scalar', '2026-02-30T00:00:00Z'), /DateTime|日期/);
  assert.throws(() => validateWriteValue('DateTime', 'Scalar', '1500-01-01T00:00:00Z'), /DateTime|日期/);
  assert.equal(validateWriteValue('DateTime', 'Scalar', '1601-01-01T00:00:00Z'), '1601-01-01T00:00:00Z');
  assert.throws(() => validateWriteValue('ByteString', 'Scalar', '%%%'), /base64/i);
  assert.deepEqual(validateWriteValue('Int16', 'Array', [1, -32768]), [1, -32768]);
});

test('OPC UA profiles redact passwords and reject invalid imports atomically', async t => {
  const { OpcuaService } = require('../electron/opcuaService.cjs');
  const dir = await mkdtemp(join(tmpdir(), 'linklab-opcua-store-'));
  const service = new OpcuaService({ directory: dir });
  t.after(async () => { await service.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const profile = { id: 'a', name: '本地服务器', config: { endpointUrl: 'opc.tcp://127.0.0.1:4840', password: 'must-not-persist' }, favorites: [] };
  const result = await service.execute({ action: 'saveProfiles', profiles: [profile] });
  assert.equal(result.profiles[0].config.password, undefined);
  await assert.rejects(service.execute({ action: 'saveProfiles', profiles: [{ ...profile, config: { endpointUrl: 'http://example.com' } }] }), /opc.tcp/);
  assert.equal((await service.execute({ action: 'profiles' })).profiles[0].name, '本地服务器');
  await assert.rejects(service.execute({ action: 'read', connectionId: 'a', sessionId: 'stale', nodeIds: ['i=2258'] }), /session|会话/i);
});

test('concurrent subscription replacements are serialized and closed sessions cannot create late monitors', async () => {
  const { OpcuaService } = require('../electron/opcuaService.cjs');
  const ua = require('node-opcua'); const service = new OpcuaService({ directory: '/unused' }); service.ua = ua;
  let release; const gate = new Promise(resolve => { release = resolve; }); let creates = 0; let active = 0; let peak = 0;
  const session = { async createSubscription2() { const id = ++creates; if (id === 1) await gate; active++; peak = Math.max(peak, active); return {subscriptionId:id, async terminate(){active--;},async monitorItems(){return {monitoredItems:[{statusCode:ua.StatusCodes.Good}],on(){}};}}; }, async close() {} };
  service.connections.set('a', {id:'a',sessionId:'s',session,subscription:null,continuation:new Set()});
  const request = {action:'subscribe',connectionId:'a',sessionId:'s',nodeIds:['i=2258'],intervalMs:100};
  const first = service.execute(request); const second = service.execute(request);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(creates,1); release();
  await Promise.all([first,second]); assert.equal(peak,1); assert.equal(active,1);
  await service.execute({action:'unsubscribe',connectionId:'a',sessionId:'s'}); assert.equal(active,0);
  await service.shutdown();
});

test('a bad monitored item rejects the whole subscription and terminates its new resources', async () => {
  const {OpcuaService}=require('../electron/opcuaService.cjs');const ua=require('node-opcua');const service=new OpcuaService({directory:'/unused'});service.ua=ua;
  let oldClosed=0,newClosed=0;
  const subscription={subscriptionId:2,async terminate(){newClosed++;},async monitorItems(){return {monitoredItems:[{statusCode:ua.StatusCodes.Good},{statusCode:ua.StatusCodes.BadNodeIdUnknown}],on(){}};}};
  const record={id:'a',sessionId:'s',session:{async createSubscription2(){return subscription;},async close(){}},subscription:{async terminate(){oldClosed++;}},continuation:new Set()};service.connections.set('a',record);
  await assert.rejects(service.execute({action:'subscribe',connectionId:'a',sessionId:'s',nodeIds:['i=2258','ns=2;s=Missing'],intervalMs:100}),/BadNodeIdUnknown/);
  assert.equal(oldClosed,1);assert.equal(newClosed,1);assert.equal(record.subscription,null);await service.shutdown();
});
test('oversized but valid profile save preserves the previous readable file', async t => {
  const {writeProfiles,readProfiles}=require('../electron/opcuaStore.cjs');const dir=await mkdtemp(join(tmpdir(),'linklab-opcua-size-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const profile={id:'original',name:'Original',config:{endpointUrl:'opc.tcp://localhost:4840'},favorites:[]};await writeProfiles(dir,[profile]);
  const profiles=Array.from({length:50},(_,i)=>({...profile,id:`p-${i}`,favorites:Array.from({length:100},(_,n)=>({nodeId:`ns=2;s=${'x'.repeat(260)}-${n}`,displayName:'Favorite'}))}));
  await assert.rejects(writeProfiles(dir,profiles),/1 MiB|过大/);assert.equal((await readProfiles(dir))[0].id,'original');
});
test('ordinary request timeout emits terminal state before retiring its session', async t => {
  const {OpcuaService}=require('../electron/opcuaService.cjs');const ua=require('node-opcua');const events=[];const service=new OpcuaService({directory:'/unused',emitEvent:event=>events.push(event)});service.ua=ua;
  let closed=0;const record={id:'a',sessionId:'s',session:{read:()=>new Promise(()=>{}),async close(){closed++;}},subscription:null,continuation:new Set()};service.connections.set('a',record);
  t.mock.timers.enable({apis:['setTimeout']});
  const reading=service.execute({action:'read',connectionId:'a',sessionId:'s',nodeIds:['i=2258']});const rejection=assert.rejects(reading,/超时/);
  t.mock.timers.tick(10000);await rejection;
  assert.equal(service.connections.size,0);assert.equal(events.at(-1)?.status,'disconnected');assert.equal(events.at(-1)?.sessionId,'s');assert.ok(closed);await service.shutdown();
});
test('matrix read metadata preserves dimensions consistently with the native runtime', () => {
  const {wireDataValue}=require('../electron/opcuaValues.cjs');const ua=require('node-opcua');
  const result=wireDataValue('ns=2;s=Matrix',{value:new ua.Variant({dataType:ua.DataType.Double,arrayType:ua.VariantArrayType.Matrix,value:[1,2,3,4],dimensions:[2,2]}),statusCode:ua.StatusCodes.Good},ua);
  assert.equal(result.arrayType,'Matrix');assert.deepEqual(result.dimensions,[2,2]);
});


test('OPC UA cursor release validates session ownership and retains failed releases for retry', async t => {
  const { OpcuaService } = require('../electron/opcuaService.cjs');
  const service = new OpcuaService({ directory: '/unused' });
  service.ua = require('node-opcua');
  let fail = true; const calls = [];
  const cp = Buffer.from('cursor').toString('base64');
  service.connections.set('owner', { id: 'owner', sessionId: 'session', continuation: new Set([cp]), session: {
    performMessageTransaction(request, callback) {
      calls.push([request.continuationPoints[0].toString(), request.releaseContinuationPoints]);
      if (fail) callback(new Error('temporary release failure'));
      else callback(null, { responseHeader: { serviceResult: { isGood: () => true } }, results: [] });
    }, async close() {},
  } });
  t.after(() => service.shutdown());
  const req = { action: 'releaseBrowse', connectionId: 'owner', sessionId: 'session', continuationPoint: cp };
  await assert.rejects(service.execute({ ...req, sessionId: 'other' }), /session|会话/);
  await assert.rejects(service.execute(req), /temporary release failure/);
  assert.equal(service.connections.get('owner').continuation.size, 1);
  fail = false; assert.deepEqual(await service.execute(req), { released: true });
  assert.deepEqual(calls, [['cursor', true], ['cursor', true]]);
  assert.equal(service.connections.get('owner').continuation.size, 0);
  await assert.rejects(service.execute(req), /分页标记已失效/);
});

test('OPC UA release accepts the protocol-defined empty result array without the SDK browseNext assertion', async t => {
  const { OpcuaService } = require('../electron/opcuaService.cjs');
  const ua = require('node-opcua');
  const service = new OpcuaService({ directory: '/unused' }); service.ua = ua;
  const cp = Buffer.from('cursor').toString('base64');
  service.connections.set('empty', { id: 'empty', sessionId: 'session', continuation: new Set([cp]), session: {
    async browseNext() { throw new Error('SDK expects nonempty results'); },
    performMessageTransaction(request, callback) {
      assert.equal(request.releaseContinuationPoints, true);
      assert.deepEqual(request.continuationPoints, [Buffer.from('cursor')]);
      callback(null, new ua.BrowseNextResponse({ responseHeader: { serviceResult: ua.StatusCodes.Good }, results: [] }));
    }, async close() {},
  } });
  t.after(() => service.shutdown());
  assert.deepEqual(await service.execute({ action: 'releaseBrowse', connectionId: 'empty', sessionId: 'session', continuationPoint: cp }), { released: true });
  assert.equal(service.connections.get('empty').continuation.size, 0);
});
