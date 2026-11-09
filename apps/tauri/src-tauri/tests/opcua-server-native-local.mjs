// Real Node OPC UA SDK against the Rust service. Uses isolated data and loopback only.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const ua=require('node-opcua');
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'linklab-native-simulator-'));
const child=spawn(join(root,'apps/tauri/src-tauri/target/debug/opcua-harness'),[directory],{stdio:['pipe','pipe','inherit']});
const pending=new Map(),events=[];let sequence=0;
createInterface({input:child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}if(message.event){events.push(message.event);return;}const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(message.error)):p.resolve(message.result);});
function request(request){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Harness timeout: ${request.action}`));},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,request})+'\n');});}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));return port;}
const manual={mode:'manual',intervalMs:1000,min:0,max:100,step:1};
function node(id,dataType,value,extra={}){return {id,name:id,dataType,arrayType:'Scalar',value,writable:true,simulation:manual,...extra};}
const nodes=[node('Counter','Int32',1),node('Readonly','Double',7,{writable:false}),node('Wide','Int64','9223372036854775807'),node('UnsignedWide','UInt64','18446744073709551615'),node('Bytes','ByteString','AP9B'),node('Date','DateTime','2026-10-22T08:09:10+08:00'),node('Array','Int16',[1,-2,3],{arrayType:'Array'}),node('Empty','String',[],{arrayType:'Array'}),node('Auto','Int32',0,{simulation:{mode:'increment',intervalMs:100,min:0,max:2,step:1}}),node('Toggle','Boolean',false,{simulation:{mode:'toggle',intervalMs:100,min:0,max:100,step:1}})];
const typedValues=[['Boolean',true],['Int16',-123],['UInt16',65535],['Int32',-456],['UInt32',4294967295],['Int64','-9223372036854775808'],['UInt64','18446744073709551615'],['Float',1.25],['Double',2.5],['String','温度🙂'],['ByteString','AP9B'],['DateTime','2026-10-22T00:09:10Z']];
for(const [type,value] of typedValues){nodes.push(node(`Typed${type}`,type,value),node(`TypedArray${type}`,type,[value,value],{arrayType:'Array'}));}
function sdkScalar(type,value){if(type==='Int64'||type==='UInt64'){const bits=BigInt.asUintN(64,BigInt(value));return [Number(bits>>32n),Number(bits&0xffffffffn)];}if(type==='DateTime')return new Date(value);if(type==='ByteString')return Buffer.from(value,'base64');return value;}
function normalize(type,value){return type==='DateTime'?new Date(value).toISOString():value;}
const servers=[],clients=[];
async function start(id,n=nodes,overrides={}){const config={listenHost:'127.0.0.1',listenPort:await port(),path:'/LinkLab',namespaceUri:'urn:ineedfull:linklab:simulator',...overrides};const input={action:'startServer',connectionId:id,config,nodes:n};const live=await request(input);const server={id,input,...live};servers.push(server);return server;}
async function connect(server){const client=ua.OPCUAClient.create({endpointMustExist:false,securityMode:ua.MessageSecurityMode.None,securityPolicy:ua.SecurityPolicy.None,connectionStrategy:{maxRetry:0},clientCertificateManager:new ua.OPCUACertificateManager({rootFolder:join(directory,`sdk-${clients.length}`),automaticallyAcceptUnknownCertificate:false})});clients.push({client});await client.connect(server.endpointUrl);const session=await client.createSession();clients.at(-1).session=session;return session;}
const snapshot=server=>request({action:'serverSnapshot',connectionId:server.id,sessionId:server.sessionId});
const update=(server,nodeId,value)=>request({action:'setServerValue',connectionId:server.id,sessionId:server.sessionId,nodeId,value});
try {
 for(const namespaceUri of ['http://opcfoundation.org/UA/','urn:ineedfull:linklab:simulator:server','urn:ineedfull:linklab:opcua:simulator']) {
  let invalid;try{invalid=await request({action:'startServer',connectionId:'namespace-reserved',config:{listenHost:'127.0.0.1',listenPort:await port(),path:'/LinkLab',namespaceUri},nodes:[node('Probe','Int32',17)]});}catch(error){assert.match(error.message,/reserved.*namespace|namespace.*reserved/i);continue;}
  const probe=await connect({id:'namespace-reserved',...invalid});const actual=await probe.read({nodeId:invalid.nodes[0].nodeId,attributeId:ua.AttributeIds.Value});assert.fail(`Reserved namespace must be rejected: ${namespaceUri}; native SDK read returned ${actual.statusCode.name}`);
 }
 const first=await start('one');const second=await start('two',nodes,{namespaceUri:'https://example.test/UA/LinkLab'});
 assert.equal(first.nodes.length,nodes.length);assert(Number.isInteger(first.namespaceIndex));
 const ids=Object.fromEntries(first.nodes.map(n=>[n.id,n.nodeId]));assert(first.nodes.every(n=>n.nodeId.startsWith(`ns=${first.namespaceIndex};`)));
 const a=await connect(first),b=await connect(second);
 const endpoints=await clients[0].client.getEndpoints();assert(endpoints.every(e=>e.securityMode===ua.MessageSecurityMode.None));
 const folderBrowse=await a.browse('ObjectsFolder');const folder=folderBrowse.references.find(r=>r.browseName.name==='LinkLab');assert(folder,'LinkLab folder');
 const browsed=await a.browse(folder.nodeId);assert.equal(browsed.references.filter(r=>Object.values(ids).includes(r.nodeId.toString())).length,nodes.length);
 let values=await a.read(Object.values(ids).map(nodeId=>({nodeId,attributeId:ua.AttributeIds.Value})));
 assert(values.every(v=>v.statusCode.isGood()));assert.deepEqual(values[2].value.value,[0x7fffffff,0xffffffff]);assert.deepEqual(values[3].value.value,[0xffffffff,0xffffffff]);assert.equal(values[4].value.value.toString('base64'),'AP9B');assert.equal(values[5].value.value.toISOString(),'2026-10-22T00:09:10.000Z');assert.deepEqual(Array.from(values[6].value.value),[1,-2,3]);assert.equal(values[7].value.value.length,0);
 assert((await a.write({nodeId:ids.Counter,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.Int32,value:42})}})).isGood());
 assert.equal((await snapshot(first)).values.find(v=>v.nodeId===ids.Counter).value,42);
 assert.equal((await b.read({nodeId:second.nodes.find(n=>n.id==='Counter').nodeId,attributeId:ua.AttributeIds.Value})).value.value,1);
 assert.match((await a.write({nodeId:ids.Readonly,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.Double,value:8})}})).name,/BadNotWritable|BadUserAccessDenied/);
 await update(first,ids.Readonly,9);assert.equal((await a.read({nodeId:ids.Readonly,attributeId:ua.AttributeIds.Value})).value.value,9);
 assert((await a.write({nodeId:ids.Wide,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.Int64,arrayType:ua.VariantArrayType.Scalar,value:[0x80000000,0]})}})).isGood());
 assert.equal((await snapshot(first)).values.find(v=>v.nodeId===ids.Wide).value,'-9223372036854775808');
 for(const input of [node('Bad','Int64',3),node('Bad','Int16',32768),node('Bad','DateTime','2026-10-22T08:09:10'),node('Bad','ByteString','*'),node('Bad','Int16',Array(101).fill(0),{arrayType:'Array'}),node('Bad','String','x'.repeat(4097))])await assert.rejects(request({...first.input,connectionId:'invalid',nodes:[input]}));
 for(const spec of nodes.filter(n=>n.id.startsWith('Typed'))){const value=spec.arrayType==='Array'?spec.value.map(v=>sdkScalar(spec.dataType,v)):sdkScalar(spec.dataType,spec.value);const result=await a.write({nodeId:ids[spec.id],attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType[spec.dataType],arrayType:ua.VariantArrayType[spec.arrayType],value})}});assert(result.isGood(),`${spec.id}: ${result.name}`);const actual=(await snapshot(first)).values.find(v=>v.nodeId===ids[spec.id]).value;assert.deepEqual(spec.arrayType==='Array'?actual.map(v=>normalize(spec.dataType,v)):normalize(spec.dataType,actual),spec.arrayType==='Array'?spec.value.map(v=>normalize(spec.dataType,v)):normalize(spec.dataType,spec.value));}
 const unicode='温'.repeat(4096);assert((await a.write({nodeId:ids.TypedString,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.String,value:unicode})}})).isGood());assert.equal((await snapshot(first)).values.find(v=>v.nodeId===ids.TypedString).value,unicode);
 const subscription=await a.createSubscription2({requestedPublishingInterval:100,requestedLifetimeCount:100,requestedMaxKeepAliveCount:10,maxNotificationsPerPublish:100,publishingEnabled:true,priority:1});
 const changes=[];const monitored=await subscription.monitor({nodeId:ids.Counter,attributeId:ua.AttributeIds.Value},{samplingInterval:100,queueSize:10,discardOldest:true},ua.TimestampsToReturn.Both);monitored.on('changed',v=>changes.push(v.value.value));
 await delay(250);const beforeWrite=changes.length;await a.write({nodeId:ids.Counter,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.Int32,value:84})}});await delay(350);assert(changes.includes(84),'remote writes notify subscriptions');assert(changes.slice(beforeWrite).every(v=>v===84),'writes must not emit stale initial values');
 // A final change inside a sampling window must arrive even if no more writes
 // follow. Previously the SDK drained the item before its deferred sample was due.
 for(let burst=0;burst<25;burst++) {
  let expected;
  for(let i=0;i<12;i++) {
   expected=1000+burst*20+i;
   assert((await a.write({nodeId:ids.Counter,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.Int32,value:expected})}})).isGood());
   await delay(8);
  }
  assert.equal((await a.read({nodeId:ids.Counter,attributeId:ua.AttributeIds.Value})).value.value,expected);
  const until=Date.now()+1000;while(changes.at(-1)!==expected&&Date.now()<until)await delay(10);
  assert.equal(changes.at(-1),expected,`final subscription value after rapid-write burst ${burst}`);
 }
 const seenAuto=new Set(),seenToggle=new Set();for(let i=0;i<6;i++){const s=await snapshot(first);seenAuto.add(s.values.find(v=>v.nodeId===ids.Auto).value);seenToggle.add(s.values.find(v=>v.nodeId===ids.Toggle).value);await delay(115);}assert(seenAuto.size>=2);assert.equal(seenToggle.size,2);
 await update(first,ids.Auto,-10);await delay(130);assert((await snapshot(first)).values.find(v=>v.nodeId===ids.Auto).value>=0);
 assert.equal((await a.write({nodeId:ids.Counter,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.String,value:'wrong'})}})).name,'BadTypeMismatch');
 assert(!(await a.write({nodeId:ids.Counter,attributeId:ua.AttributeIds.Value,value:{value:new ua.Variant({dataType:ua.DataType.Int32,arrayType:ua.VariantArrayType.Array,value:[1,2]})}})).isGood());
 await subscription.terminate();
 await request({action:'saveServerProfiles',profiles:[{id:'profile',name:'Test',config:first.input.config,nodes}]});assert.equal(JSON.parse(await readFile(join(directory,'opcua/server-profiles.json')))[0].nodes.length,nodes.length);
 await assert.rejects(request(first.input),/already/);assert((await snapshot(first)).values.length>0);
 await start('three');await start('four');await assert.rejects(start('five'),/4/);
 const conflict=await request({action:'stopServer',connectionId:'four'});assert(conflict.stopped);
 await assert.rejects(request({...first.input,connectionId:'port-conflict'}),/listen|address|use/i);await start('five');
 await request({action:'stopServer',connectionId:'one',sessionId:first.sessionId});
 const replacement=await request(first.input);assert.notEqual(replacement.sessionId,first.sessionId);
 await request({action:'stopServer',connectionId:'one',sessionId:first.sessionId});
 await assert.rejects(snapshot(first),/Stale/);await assert.rejects(update(first,ids.Counter,12),/Stale/);
 assert((await request({action:'serverSnapshot',connectionId:'one',sessionId:replacement.sessionId})).values.length>0);
 await request({action:'stopServer',connectionId:'one'});await request({action:'stopServer',connectionId:'one'});
 assert(events.some(e=>e.type==='serverStatus'&&e.connectionId==='one'&&e.sessionId===first.sessionId&&e.status==='stopped'));
 console.log('Rust OPC UA simulator native acceptance passed: reserved namespace rejection/custom URI reads, multi-instance, browse, all value formats/empty arrays, remote/local writes, readonly, subscription, automatic changes, invalid values, profiles, capacity, conflict, stale fences, stop/restart.');
} finally {
 for(const {client,session} of clients){try{await session?.close();}catch{/* Cleanup after a stopped server is best effort. */}try{await client.disconnect();}catch{/* Cleanup after a stopped server is best effort. */}}
 for(const id of ['one','two','three','four','five','invalid','port-conflict','namespace-reserved'])try{await request({action:'stopServer',connectionId:id});}catch{/* Cleanup after a stopped server is best effort. */}
 child.stdin.end();await Promise.race([new Promise(r=>child.once('exit',r)),delay(6000).then(()=>{if(child.exitCode===null)child.kill();})]);
 await rm(directory,{recursive:true,force:true});
}
