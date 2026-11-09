import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import test from 'node:test';
import { createRequire } from 'node:module';
import { normalizeTransportStatusEvent, normalizeTransportFrameBatch } from '../../../packages/runtime-contract/src/serialWireNormalizer.js';
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
const { WebSocketService } = require('../electron/websocketService.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n=0;n<200;n++) { if (check()) return; await pause(10); } assert.fail('condition deadline'); }
function fixture(t) {
  const events=[];
  const service=new WebSocketService({ emitEvent:(channel,payload)=>events.push({channel,...payload}) });
  t.after(()=>service.shutdown());
  return {service,events};
}
test('native WebSocket client sends complete text/binary messages with transient headers and protocol', async t=>{
  let headers;
  const server=new WebSocketServer({host:'127.0.0.1',port:0,handleProtocols:p=>p.has('linklab')?'linklab':false});
  await once(server,'listening');t.after(()=>{for(const s of server.clients)s.terminate();server.close();});
  server.on('connection',(socket,request)=>{headers=request.headers;socket.on('message',(data,binary)=>socket.send(data,{binary}));});
  const {service,events}=fixture(t);
  await service.open({id:'c',transport:'websocket-client',config:{url:`ws://127.0.0.1:${server.address().port}/?secret=hidden`,subprotocols:['linklab']}},{operationId:'op',websocketHeaders:[{name:'Authorization',value:'Bearer private-test'}]});
  await service.send({endpointId:'c',bytes:[104,105],messageType:'text'});
  await service.send({endpointId:'c',bytes:[0,255],messageType:'binary'});
  await until(()=>events.filter(e=>e.channel==='transport:frames').flatMap(e=>e.frames).filter(f=>f.direction==='in').length===2);
  assert.equal(headers.authorization,'Bearer private-test');
  const incoming=events.filter(e=>e.channel==='transport:frames').flatMap(e=>e.frames).filter(f=>f.direction==='in');
  assert.deepEqual(incoming.map(f=>[f.messageType,f.bytes]),[['text',[104,105]],['binary',[0,255]]]);
  await assert.rejects(service.send({endpointId:'c',bytes:[255],messageType:'text'}),/UTF-8/i);
  await assert.rejects(service.send({endpointId:'c',bytes:new Uint8Array(1048577),messageType:'binary'}),/limit|1 MiB/i);
  assert(!JSON.stringify(events.filter(e=>e.channel==='transport:status')).includes('hidden'));
  assert(!JSON.stringify(events).includes('private-test'));
  for(const event of events) {
    const {channel,...wire}=event;
    if(channel==='transport:status') normalizeTransportStatusEvent(wire);
    if(channel==='transport:frames') normalizeTransportFrameBatch(wire);
  }
});
test('WebSocket server selects peers, broadcasts and leaves listener alive after peer disconnect',async t=>{
  const {service,events}=fixture(t);
  await service.open({id:'s',transport:'websocket-server',config:{listenHost:'127.0.0.1',listenPort:0,path:'/test',subprotocols:['linklab']}},{operationId:'op'});
  const listening=events.find(e=>e.status==='listening');const port=listening.log.details.port;
  const clients=[new WebSocket(`ws://127.0.0.1:${port}/test`,'linklab'),new WebSocket(`ws://127.0.0.1:${port}/test`,'linklab')];
  t.after(()=>clients.forEach(s=>s.terminate()));await Promise.all(clients.map(s=>once(s,'open')));
  await until(()=>events.some(e=>e.peers?.length===2));
  const peers=events.filter(e=>e.peers).at(-1).peers;
  const received=clients.map(()=>[]);clients.forEach((s,n)=>s.on('message',data=>received[n].push(data.toString())));
  const one=await service.send({endpointId:'s',bytes:[65],messageType:'text',target:{type:'peer',peerIds:[peers[0].id]}});
  assert.equal(one.successCount,1);
  const all=await service.send({endpointId:'s',bytes:[66],messageType:'text',target:{type:'broadcast'}});assert.equal(all.successCount,2);
  await until(()=>received[0].length+received[1].length===3);
  await service.disconnectPeer('s',peers[0].id);await until(()=>events.filter(e=>e.peers).at(-1).peers.length===1);
  const partial=await service.send({endpointId:'s',bytes:[67],messageType:'text',target:{type:'peer',peerIds:peers.map(p=>p.id)}});
  assert.equal(partial.successCount,1);assert.equal(partial.failureCount,1);
  assert.equal(service.sessions.get('s').phase,'listening');
  const bad=new WebSocket(`ws://127.0.0.1:${port}/wrong`,'linklab');bad.on('error',()=>{});await new Promise(resolve=>bad.once('close',resolve));
});
test('WebSocket cancellation retires pending handshake and fences late callbacks',async t=>{
  const sockets=new Set();const blackhole=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  blackhole.listen(0,'127.0.0.1');await once(blackhole,'listening');t.after(()=>{for(const s of sockets)s.destroy();blackhole.close();});
  const {service,events}=fixture(t);
  const opening=service.open({id:'c',transport:'websocket-client',config:{url:`ws://127.0.0.1:${blackhole.address().port}`}},{operationId:'op'});
  const failed=assert.rejects(opening,e=>e.code==='OPEN_CANCELLED');await pause(20);
  assert.equal((await service.cancelOpen('c',{operationId:'other'})).cancelled,false);
  const started=Date.now();assert.equal((await service.cancelOpen('c',{operationId:'op'})).cancelled,true);await failed;
  assert(Date.now()-started<1000);assert(!events.some(e=>e.status==='open'));assert.equal(service.sessions.size,0);
});
test('WebSocket validates reserved headers and heartbeat timeout, records close code without leaking URL',async t=>{
  const {service,events}=fixture(t);
  const endpoint={id:'c',transport:'websocket-client',config:{url:'ws://127.0.0.1:1'}};
  for(const header of [{name:'Host',value:'override'},{name:'Authorization',value:'a\r\nb'},{name:'Sec-WebSocket-Key',value:'invalid'}]) {
    await assert.rejects(service.open(endpoint,{operationId:'op',websocketHeaders:[header]}));
  }
  const server=new WebSocketServer({host:'127.0.0.1',port:0,autoPong:false});await once(server,'listening');
  t.after(()=>{for(const s of server.clients)s.terminate();server.close();});
  await service.open({...endpoint,config:{url:`ws://127.0.0.1:${server.address().port}`,heartbeat:{enabled:true,intervalMs:1000,timeoutMs:1000}}},{operationId:'heartbeat'});
  await until(()=>events.some(e=>e.status==='open'));
  for(let n=0;n<400&&!events.some(e=>e.status==='closed');n++) await pause(10);
  assert(events.some(e=>e.status==='error'&&e.log.details.reason==='HEARTBEAT_TIMEOUT'));
  assert.equal(service.sessions.size,0);
});
test('WebSocket coordinator routes lifecycle including shutdown',async()=>{
  const {TransportCoordinator}=require('../electron/transportCoordinator.cjs');
  const calls=[];const service=Object.fromEntries(['open','send','close','cancelOpen','closeAll','shutdown','forceShutdown','disconnectPeer'].map(method=>[method,async()=>{calls.push(method);return {closed:true};}]));
  const native=new TransportCoordinator({serialService:{closeAll:async()=>{},shutdown:async()=>{}},websocketService:service,database:{listEndpoints:()=>[{id:'ws',transport:'websocket-client'}]}});
  await native.open('ws',{operationId:'o'});await native.send({endpointId:'ws',bytes:[]});await native.close('ws');await native.closeAll();await native.shutdown();
  assert.deepEqual(calls,['open','send','close','closeAll','shutdown']);
});
test('unknown endpoint cleanup reaches WebSocket even when UDP reports an idempotent close',async()=>{
  const {TransportCoordinator}=require('../electron/transportCoordinator.cjs');let closed=false;
  const native=new TransportCoordinator({serialService:{close:async()=>({closed:true})},udpService:{close:async()=>({closed:true})},
    websocketService:{close:async()=>{closed=true;return {closed:true};}},database:{listEndpoints:()=>[]}});
  await native.close('removed');assert.equal(closed,true);
});
test('handshake failure reports only controlled diagnostics',async t=>{
  const server=http.createServer((_req,res)=>res.writeHead(401).end('secret response'));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const {service,events}=fixture(t);
  await assert.rejects(service.open({id:'c',transport:'websocket-client',config:{url:`ws://127.0.0.1:${server.address().port}/?token=secret-query`}},{operationId:'op'}),/handshake|connect/i);
  assert(!JSON.stringify(events).includes('secret-query'));assert(!JSON.stringify(events).includes('secret response'));
});
test('WSS rejects untrusted certificates and retains hostname verification with an explicitly trusted test CA',async t=>{
  const cert=fileURLToPath(new URL('../../../tooling/websocket-test/fixtures/localhost-cert.pem',import.meta.url));
  const key=fileURLToPath(new URL('../../../tooling/websocket-test/fixtures/localhost-key.pem',import.meta.url));
  const server=https.createServer({cert:readFileSync(cert),key:readFileSync(key)});const wss=new WebSocketServer({server});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{wss.close();server.close();});
  const {service}=fixture(t);
  await assert.rejects(service.open({id:'tls',transport:'websocket-client',config:{url:`wss://127.0.0.1:${server.address().port}`}},{operationId:'tls'}),/handshake|connect/i);
  const child=fileURLToPath(new URL('../../../tooling/websocket-test/tls-child.mjs',import.meta.url));
  const {stdout}=await promisify(execFile)(process.execPath,[child],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:20000});
  assert.match(stdout,/trusted WSS and hostname mismatch passed/);
});
test('oversized messages are rejected without losing the listener, and queued sends are bounded',async t=>{
  const {service,events}=fixture(t);
  await service.open({id:'s',transport:'websocket-server',config:{listenHost:'127.0.0.1',listenPort:0}},{operationId:'op'});
  const port=events.find(e=>e.status==='listening').log.details.port;
  const bad=new WebSocket(`ws://127.0.0.1:${port}`);bad.on('error',()=>{});await once(bad,'open');
  const closed=new Promise(resolve=>bad.once('close',(code)=>resolve(code)));bad.send(Buffer.alloc(1048577));
  assert.equal(await closed,1009);assert.equal(service.sessions.get('s').phase,'listening');
  const good=new WebSocket(`ws://127.0.0.1:${port}`);await once(good,'open');t.after(()=>good.terminate());
  await until(()=>events.filter(e=>e.peers).at(-1).peers.length===1);
  good._socket.pause();
  const sends=await Promise.all(Array.from({length:12},()=>service.send({endpointId:'s',bytes:new Uint8Array(1048576),messageType:'binary',target:{type:'broadcast'}})));
  assert(sends.some(result=>result.failureCount>0));good._socket.resume();
});
test('authenticated server close reasons cannot echo credential fragments into logs',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  t.after(()=>{for(const s of server.clients)s.terminate();server.close();});
  server.on('connection',socket=>setTimeout(()=>socket.close(1008,'Invalid token topsecret'),20));
  const {service,events}=fixture(t);
  await service.open({id:'c',transport:'websocket-client',config:{url:`ws://127.0.0.1:${server.address().port}`}},{operationId:'op',websocketHeaders:[{name:'Authorization',value:'Bearer topsecret'}]});
  await until(()=>events.some(e=>e.status==='closed'));
  assert(!JSON.stringify(events).includes('topsecret'));
  assert.equal(events.find(e=>e.status==='closed').log.details.closeCode,1008);
  await service.open({id:'opaque',transport:'websocket-client',config:{url:`ws://127.0.0.1:${server.address().port}/?topsecret`}},{operationId:'opaque'});
  await until(()=>events.some(e=>e.endpointId==='opaque'&&e.status==='closed'));
  assert(!JSON.stringify(events).includes('topsecret'));
});
test('server handshake deadline is absolute even when an incomplete client keeps sending bytes',async t=>{
  const {service,events}=fixture(t);
  await service.open({id:'s',transport:'websocket-server',config:{listenHost:'127.0.0.1',listenPort:0}},{operationId:'op'});
  const port=events.find(e=>e.status==='listening').log.details.port;
  const raw=net.connect(port,'127.0.0.1');raw.on('error',()=>{});await once(raw,'connect');t.after(()=>raw.destroy());
  raw.write('GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
  const timer=setInterval(()=>raw.write('a'),500);t.after(()=>clearInterval(timer));
  await pause(15500);
  assert.equal(raw.destroyed,true);
  assert.equal(service.sessions.get('s').rawSockets.size,0);
});

test('server rejects noncanonical and duplicate WebSocket handshake keys before upgrade', async t => {
  const {service,events}=fixture(t);
  await service.open({id:'s',transport:'websocket-server',config:{listenHost:'127.0.0.1',listenPort:0}},{operationId:'op'});
  const port=events.find(e=>e.status==='listening').log.details.port;
  for(const key of ['invalid','', 'YQ==','AAAAAAAAAAAAAAAAAAAAAAA=', 'dGhlIHNhbXBsZSBub25jZR==', 'dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']) {
    const response=await new Promise((resolve,reject)=>{
      const socket=net.connect(port,'127.0.0.1');let received='';
      socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('handshake response deadline'));});
      socket.on('error',reject);socket.on('data',bytes=>{received+=bytes.toString();if(received.includes('\r\n\r\n')){socket.destroy();resolve(received);}});
      socket.on('connect',()=>socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`));
    });
    assert.match(response,/^HTTP\/1\.1 400 /);
  }
  assert.equal(service.sessions.get('s').peers.size,0);
  const valid=new WebSocket(`ws://127.0.0.1:${port}`);await once(valid,'open');t.after(()=>valid.terminate());
  assert.equal(service.sessions.get('s').peers.size,1);
});
