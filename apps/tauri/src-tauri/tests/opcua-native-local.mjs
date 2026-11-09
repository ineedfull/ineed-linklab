// Real native SDK acceptance. Run after cargo build --bin opcua-harness.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createOpcuaTestServer} from '../../../../tooling/opcua-test/server.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'linklab-native-opcua-'));
let fixture=await createOpcuaTestServer({directory:join(directory,'server')});
const child=spawn(join(root,'apps/tauri/src-tauri/target/debug/opcua-harness'),[join(directory,'client')],{stdio:['pipe','pipe','inherit']});
const pending=new Map();const events=[];let next=1;
createInterface({input:child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line)}catch{return}if(message.event){events.push(message.event);if(process.env.OPCUA_NATIVE_DEBUG)console.error(message.event);return}const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(message.error)):p.resolve(message.result)}});
function request(request){return new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Harness timeout'))},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,request})+'\n')})}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const endpointUrl=fixture.endpointUrl;
 const discovered=await request({action:'discover',endpointUrl});assert(discovered.endpoints.some(e=>e.securityPolicy==='Basic256Sha256'));
 const config={endpointUrl,securityPolicy:'None',securityMode:'None',authentication:'anonymous'};
 let {sessionId}=await request({action:'connect',connectionId:'native',config});
 const run=(action,extra={})=>request({action,connectionId:'native',sessionId,...extra});
 const namespace=fixture.server.engine.addressSpace.getNamespace(2);
 for(let i=0;i<205;i++)namespace.addObject({componentOf:fixture.nodes.Folder,nodeId:`ns=2;s=Paged${i}`,browseName:`Paged${i}`});
 fixture.server.engine.serverCapabilities.maxBrowseContinuationPoints=2;
 for(let i=0;i<8;i++) {
   const page=await run('browse',{nodeId:fixture.nodes.Folder}); assert(page.continuationPoint);
   assert.deepEqual(await run('releaseBrowse',{continuationPoint:page.continuationPoint}),{released:true});
 }
 let browse=await run('browse',{nodeId:fixture.nodes.Folder});assert(browse.nodes.length<=100);
 const browsed=[...browse.nodes];while(browse.continuationPoint){browse=await run('browse',{nodeId:fixture.nodes.Folder,continuationPoint:browse.continuationPoint});assert(browse.nodes.length<=100);browsed.push(...browse.nodes)}
 assert(browsed.some(n=>n.nodeId===fixture.nodes.Wide));assert(browsed.length>=215);
 let result=await run('read',{nodeIds:[fixture.nodes.Wide,fixture.nodes.UnsignedWide,fixture.nodes.Bytes,fixture.nodes.Array]});
 assert.equal(result.values[0].value,'9223372036854775807');assert.equal(result.values[1].value,'18446744073709551615');assert.equal(result.values[2].value,'AP9B');assert.deepEqual(result.values[3].value,[1,-2,3]);
 await run('write',{nodeId:fixture.nodes.Wide,dataType:'Int64',arrayType:'Scalar',value:'-9223372036854775808'});
 result=await run('read',{nodeIds:[fixture.nodes.Wide]});assert.equal(result.values[0].value,'-9223372036854775808');
 await assert.rejects(run('write',{nodeId:fixture.nodes.Wide,dataType:'Int64',arrayType:'Scalar',value:123}),/Invalid/);
 await assert.rejects(run('write',{nodeId:fixture.nodes.ReadOnly,dataType:'Double',arrayType:'Scalar',value:8}),/rejected/);
 await run('subscribe',{nodeIds:[fixture.nodes.Changing],intervalMs:100});await delay(900);assert(events.some(e=>e.type==='data'&&e.values[0].nodeId===fixture.nodes.Changing));
 await run('unsubscribe');const count=events.filter(e=>e.type==='data').length;await delay(400);assert.equal(events.filter(e=>e.type==='data').length,count);
 await assert.rejects(run('subscribe',{nodeIds:[fixture.nodes.Changing,'ns=2;s=Missing'],intervalMs:100}),/rejected/);
 await request({action:'disconnect',connectionId:'native'});await assert.rejects(run('read',{nodeIds:[fixture.nodes.Wide]}),/Stale/);
 const sockets=new Set();const blackhole=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))});
 await new Promise(resolve=>blackhole.listen(0,'127.0.0.1',resolve));
 const pendingConnect=request({action:'connect',connectionId:'cancel',config:{...config,endpointUrl:`opc.tcp://127.0.0.1:${blackhole.address().port}`}});
 const cancellation=assert.rejects(pendingConnect,/cancelled/);await delay(100);const cancelStarted=Date.now();await request({action:'disconnect',connectionId:'cancel'});await cancellation;assert(Date.now()-cancelStarted<2000);
 for(const socket of sockets)socket.destroy();await new Promise(resolve=>blackhole.close(resolve));
 const secure={...config,securityPolicy:'Basic256Sha256',securityMode:'SignAndEncrypt',authentication:'username',username:'tester',password:'test-only-password'};
 await assert.rejects(request({action:'connect',connectionId:'native',config:secure}),/Untrusted server certificate/);
 const certificates=await request({action:'certificates'});assert(certificates.certificates.some(c=>!c.trusted));
 const fingerprint=discovered.endpoints.find(e=>e.securityPolicy==='Basic256Sha256').serverCertificate.fingerprint;
 await request({action:'trust',fingerprint});
 ({sessionId}=await request({action:'connect',connectionId:'native',config:secure}));
 await run('read',{nodeIds:[fixture.nodes.Counter]});
 await run('subscribe',{nodeIds:[fixture.nodes.Changing],intervalMs:100});
 const restartEvent=events.length;const port=fixture.server.endpoints[0].port;await fixture.close();await delay(1500);
 fixture=await createOpcuaTestServer({port,directory:join(directory,'server')});
 const afterRestart=events.length;const started=Date.now();let recovered=false;
 while(Date.now()-started<20000){await delay(250);if(events.slice(restartEvent).some(e=>e.type==='status'&&e.status==='reconnecting')&&events.slice(afterRestart).some(e=>e.type==='status'&&e.status==='connected')&&events.slice(afterRestart).some(e=>e.type==='data')){recovered=true;break}}
 assert(recovered,'Subscription should recover after server restart');
 await run('unsubscribe');const recoveredCount=events.filter(e=>e.type==='data').length;await delay(400);assert.equal(events.filter(e=>e.type==='data').length,recoveredCount);
 await request({action:'saveProfiles',profiles:[{id:'demo',name:'Demo',config:secure,favorites:[]}]});
 assert(!String(await readFile(join(directory,'client/opcua/profiles.json'))).includes('test-only-password'));
 await request({action:'disconnect',connectionId:'native'});
 console.log('Native OPC UA acceptance passed: discover, browse, typed read/write, subscription, trust, secure username, reconnect, profile redaction, stale sessions.');
}finally{child.stdin.end();await fixture.close();await new Promise(resolve=>child.on('exit',resolve));await rm(directory,{recursive:true,force:true})}
