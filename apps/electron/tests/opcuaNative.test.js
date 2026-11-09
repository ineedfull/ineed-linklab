import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createOpcuaTestServer } from '../../../tooling/opcua-test/server.mjs';
const { OpcuaService } = createRequire(import.meta.url)('../electron/opcuaService.cjs');

test('real OPC UA client discovers, browses, reads, writes, monitors and fences closed sessions', { timeout: 60000 }, async t => {
  const fixture = await createOpcuaTestServer();
  const directory = await mkdtemp(join(tmpdir(), 'linklab-opcua-client-'));
  const events = []; const client = new OpcuaService({ directory, emitEvent: event => events.push(event) });
  t.after(async () => { await client.shutdown(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const discovery = await client.execute({ action: 'discover', endpointUrl: fixture.endpointUrl });
  assert.ok(discovery.endpoints.some(e => e.securityPolicy === 'Basic256Sha256' && e.securityMode === 'SignAndEncrypt'));
  const { sessionId } = await client.execute({ action: 'connect', connectionId: 'test', config: { endpointUrl: fixture.endpointUrl } });
  const call = (action, body = {}) => client.execute({ action, connectionId: 'test', sessionId, ...body });
  const browse = await call('browse', { nodeId: fixture.nodes.Folder });
  assert.ok(browse.nodes.some(n => n.nodeId === fixture.nodes.Temperature));
  const data = await call('read', { nodeIds: [fixture.nodes.Wide, fixture.nodes.UnsignedWide, fixture.nodes.Bytes, fixture.nodes.Array] });
  assert.deepEqual(data.values.map(x => x.value), ['9223372036854775807', '18446744073709551615', 'AP9B', [1, -2, 3]]);
  await call('write', { nodeId: fixture.nodes.Wide, dataType: 'Int64', value: '-9223372036854775808' });
  assert.equal((await call('read', { nodeIds: [fixture.nodes.Wide] })).values[0].value, '-9223372036854775808');
  await assert.rejects(call('write', { nodeId: fixture.nodes.ReadOnly, dataType: 'Double', value: 11 }), /BadNotWritable|BadUserAccessDenied/);
  await call('subscribe', { nodeIds: [fixture.nodes.Changing], intervalMs: 100 });
  for (let i = 0; i < 40 && !events.some(e => e.type === 'data'); i++) await delay(100);
  assert.ok(events.some(e => e.type === 'data' && e.values[0].nodeId === fixture.nodes.Changing));
  await client.execute({ action: 'disconnect', connectionId: 'test' });
  await assert.rejects(call('read', { nodeIds: [fixture.nodes.Counter] }), /session|会话/);
  const length = events.length; await delay(200); assert.equal(events.length, length);
});

test('secure OPC UA rejects unknown certificates until explicit fingerprint trust and authenticates username', { timeout: 60000 }, async t => {
  const fixture = await createOpcuaTestServer();
  const directory = await mkdtemp(join(tmpdir(), 'linklab-opcua-secure-'));
  const client = new OpcuaService({ directory });
  t.after(async () => { await client.shutdown(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const config = { endpointUrl: fixture.endpointUrl, securityPolicy: 'Basic256Sha256', securityMode: 'SignAndEncrypt', authentication: 'username', username: 'tester', password: 'test-only-password' };
  await assert.rejects(client.execute({ action: 'connect', connectionId: 'secure', config }), /证书|certificate/i);
  const { certificates } = await client.execute({ action: 'certificates' });
  assert.ok(certificates.length);
  await client.execute({ action: 'trust', fingerprint: certificates[0].fingerprint });
  const result = await client.execute({ action: 'connect', connectionId: 'secure', config });
  assert.ok(result.sessionId);
  await client.execute({ action: 'disconnect', connectionId: 'secure' });
  await assert.rejects(client.execute({ action: 'connect', connectionId: 'secure', config: { ...config, password: 'incorrect' } }), /BadIdentity|BadUserAccess|BadSession|password|identity/i);
});

test('real OPC UA subscriptions resume after server restart without duplicate monitors', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linklab-opcua-recovery-'));
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(directory,'server'));
  let fixture = await createOpcuaTestServer({directory:join(directory,'server')});
  const events = []; const client = new OpcuaService({directory:join(directory,'client'),emitEvent:event=>events.push(event)});
  t.after(async()=> {await client.shutdown(); await fixture.close(); await rm(directory,{recursive:true,force:true});});
  const {sessionId}=await client.execute({action:'connect',connectionId:'recovery',config:{endpointUrl:fixture.endpointUrl}});
  await client.execute({action:'subscribe',connectionId:'recovery',sessionId,nodeIds:[fixture.nodes.Changing],intervalMs:100});
  for(let n=0;n<50&&!events.some(e=>e.type==='data');n++) await delay(100);
  assert.ok(events.some(e=>e.type==='data'));
  const port=Number(new URL(fixture.endpointUrl).port); await fixture.close();
  const cut=events.length; fixture=await createOpcuaTestServer({port,directory:join(directory,'server')});
  for(let n=0;n<200&&!events.slice(cut).some(e=>e.type==='data');n++) await delay(100);
  assert.ok(events.slice(cut).some(e=>e.type==='data'),'data resumes after server restart');
  await client.execute({action:'unsubscribe',connectionId:'recovery',sessionId});
  const count=events.filter(e=>e.type==='data').length;await delay(400);
  assert.equal(events.filter(e=>e.type==='data').length,count);
});


test('repeated real folder browsing releases abandoned cursors and preserves next-page browsing', { timeout: 60000 }, async t => {
  const { createOpcuaWorkbench } = await import('../../../packages/workbench/src/model/opcuaWorkbench.js');
  const fixture = await createOpcuaTestServer();
  const directory = await mkdtemp(join(tmpdir(), 'linklab-browse-release-'));
  const service = new OpcuaService({ directory });
  const model = createOpcuaWorkbench({ opcua: { execute: request => service.execute(request) } });
  t.after(async () => { await model.dispose(); await service.shutdown(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  fixture.server.engine.serverCapabilities.maxBrowseContinuationPoints = 2;
  const ns = fixture.server.engine.addressSpace.getOwnNamespace();
  const folder = ns.addObject({ organizedBy: fixture.server.engine.addressSpace.rootFolder.objects, browseName: 'PagedFolder' });
  for (let i = 0; i < 205; i++) ns.addObject({ organizedBy: folder, browseName: `Child${i}` });
  model.state.config.endpointUrl = fixture.endpointUrl;
  assert.equal(await model.connect(), true, model.state.error);
  for (let i = 0; i < 8; i++) {
    await model.browse({ nodeId: folder.nodeId.toString(), displayName: 'PagedFolder' });
    assert.equal(model.state.error, '');
    assert.equal(model.state.nodes.length, 100);
    assert.equal([...service.connections.values()][0].continuation.size, 1);
  }
  await model.browse(undefined, true); await model.browse(undefined, true);
  assert.equal(model.state.error, '');
  assert.equal(model.state.nodes.length, 206);
  assert.equal(model.state.continuationPoint, null);
  assert.equal([...service.connections.values()][0].continuation.size, 0);
});
