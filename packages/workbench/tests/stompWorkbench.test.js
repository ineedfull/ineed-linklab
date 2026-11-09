import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createStompWorkbench, safeStompProfiles } from '../src/model/stompWorkbench.js';
import { StompDecoder, encodeStompFrame } from '../src/model/stompCodec.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=3000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('Timed out');await pause(10);}}
async function wireFixture(handler) {
  const wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening');const commands=[];const sockets=[];
  wss.on('connection',ws=>{sockets.push(ws);const decoder=new StompDecoder();ws.on('message',bytes=>{for(const frame of decoder.push(bytes))if(frame.command){commands.push(frame);handler?.(ws,frame);}});});
  let listener=()=>{};let socket;let count=0;const calls=[];const saved=[];
  const runtime={settings:{getAll:async()=>({}),save:async(key,value)=>{saved.push({key,value});}},stomp:{onEvent:fn=>{listener=fn;return()=>{listener=()=>{};};},execute:async request=>{
    calls.push(request);if(request.action==='open'){const ws=new WebSocket(request.config.url);socket=ws;const sessionId=`s${++count}`;const identity={endpointId:request.connectionId,sessionId,operationId:sessionId};ws.on('message',bytes=>listener({type:'frames',payload:{...identity,frames:[{direction:'in',bytes:[...bytes],messageType:'binary'}]}}));ws.on('close',()=>listener({type:'status',payload:{...identity,status:'closed'}}));await once(ws,'open');return identity;}
    if(request.action==='send'){socket.send(Buffer.from(request.bytes));return {};}
    if(request.action==='close'){socket?.terminate();return {};}
    throw new Error('Unexpected action');
  }}};
  return{runtime,calls,commands,saved,sockets,url:`ws://127.0.0.1:${wss.address().port}/stomp`,emit:event=>listener(event),close:async()=>{for(const ws of sockets)ws.terminate();socket?.terminate();await new Promise(resolve=>wss.close(resolve));}};
}
const connected=(ws,frame)=>{if(['CONNECT','STOMP'].includes(frame.command))ws.send(encodeStompFrame('CONNECTED',{version:'1.2','heart-beat':'0,0'}));if(frame.command==='SUBSCRIBE'&&frame.headers.receipt)ws.send(encodeStompFrame('RECEIPT',{'receipt-id':frame.headers.receipt}));};
test('STOMP controller real WebSocket negotiates, subscribes, sends Unicode/NULL, receives and acknowledges with receipts',async()=>{
  const f=await wireFixture((ws,frame)=>{connected(ws,frame);if(frame.command==='SEND')ws.send(encodeStompFrame('RECEIPT',{'receipt-id':frame.headers.receipt}));});const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;
  try{await m.connect();await until(()=>m.state.status==='connected');await m.subscribe({id:'sub',destination:'/app/custom',ack:'client-individual'});await m.send({destination:'/app/custom',body:'你\0🙂'});await until(()=>f.commands.some(v=>v.command==='SEND'));assert.equal(f.commands.find(v=>v.command==='SEND').body,'你\0🙂');await until(()=>m.state.messages.some(v=>v.status==='confirmed'));
    f.sockets[0].send(encodeStompFrame('MESSAGE',{subscription:'sub',destination:'/app/custom','message-id':'external-message',ack:'external-ack'},'incoming'));await until(()=>m.state.messages.some(v=>v.body==='incoming'));const row=m.state.messages.find(v=>v.body==='incoming');await m.ack(row.id);await until(()=>f.commands.some(v=>v.command==='ACK'));assert.equal(f.commands.find(v=>v.command==='ACK').headers.id,'external-ack');assert.equal(m.state.messages.find(v=>v.id===row.id).status,'acknowledged');
  }finally{await m.dispose();await f.close();}
});
test('STOMP saved settings whitelist excludes all temporary auth, headers and unknown fields',async()=>{
  const f=await wireFixture(connected);const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;m.state.credentials={login:'PRIVATE-LOGIN',passcode:'PRIVATE-PASS',headers:[{name:'Authorization',value:'PRIVATE-TOKEN'}],requireAuthentication:true};m.state.config.extraSecret='PRIVATE-EXTRA';m.state.name='saved';
  try{await m.saveProfile();assert.equal(m.state.profiles.length,1);assert.equal(f.saved[0].key,'stompProfiles');assert.equal(JSON.stringify(f.saved).includes('PRIVATE'),false);m.selectProfile(m.state.profileId);assert.equal(m.state.credentials.passcode,'');
    assert.throws(()=>safeStompProfiles([{id:'p',name:'p',mode:'client',config:{url:'ws://user:pass@localhost:61614'}}]));assert.throws(()=>safeStompProfiles([{id:'p',name:'p',mode:'client',config:{url:'ws://localhost:61614?token=x'}}]));
  }finally{await m.dispose();await f.close();}
});
test('STOMP client rejects invalid protocol responses and never exposes ERROR body or authentication',async()=>{
  const f=await wireFixture((ws,frame)=>{if(frame.command==='CONNECT')ws.send(encodeStompFrame('ERROR',{message:'echo-PASSWORD'},'echo-PASSWORD'));});const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;m.state.config.autoReconnect=false;m.state.credentials.passcode='echo-PASSWORD';
  try{await m.connect();await until(()=>m.state.status==='disconnected');assert.ok(m.state.error);assert.equal(JSON.stringify(m.state.messages).includes('echo-PASSWORD'),false);assert.equal(m.state.error.includes('echo-PASSWORD'),false);}
  finally{await m.dispose();await f.close();}
});
test('STOMP reconnect uses a new native identity, restores subscriptions and ignores old events',async()=>{
  const f=await wireFixture(connected);const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;
  try{await m.connect();await until(()=>m.state.status==='connected');await m.subscribe({id:'restore',destination:'/topic/r',ack:'auto'});await until(()=>f.commands.some(v=>v.command==='SUBSCRIBE'));const first=f.calls.find(r=>r.action==='open');f.sockets[0].terminate();await until(()=>f.calls.filter(r=>r.action==='open').length===2);await until(()=>m.state.status==='connected');await until(()=>f.commands.filter(v=>v.command==='SUBSCRIBE').length===2);assert.notEqual(f.calls.filter(r=>r.action==='open')[1].connectionId,first.connectionId);
    f.emit({type:'frames',payload:{endpointId:first.connectionId,sessionId:'s1',operationId:'s1',frames:[{bytes:[...encodeStompFrame('MESSAGE',{subscription:'restore',destination:'/topic/r','message-id':'old'},'stale')]}]}});assert.equal(m.state.messages.some(v=>v.body==='stale'),false);assert.equal(m.state.subscriptions.length,1);
  }finally{await m.dispose();await f.close();}
});
test('STOMP cancel fences late native open and closes only the cancelled connection',async()=>{
  let resolveOpen;const calls=[];let listener;const runtime={stomp:{onEvent:fn=>{listener=fn;return()=>{};},execute:async req=>{calls.push(req);if(req.action==='open')return new Promise(resolve=>{resolveOpen=resolve;});return {};}}};const m=createStompWorkbench(runtime);const opening=m.connect();await pause(0);const old=calls[0].connectionId;await m.disconnect();resolveOpen({sessionId:'late',operationId:'late'});await opening;listener({type:'status',payload:{endpointId:old,sessionId:'late',status:'connected'}});assert.equal(m.state.status,'disconnected');assert.ok(calls.filter(r=>r.action==='close'&&r.connectionId===old).length>=1);await m.dispose();
});
test('STOMP negotiated heartbeat sends LF, silent broker expires and manual disconnect stops reconnect',async()=>{
  const raw=[];const f=await wireFixture((ws,frame)=>{if(frame.command==='CONNECT'){ws.on('message',bytes=>raw.push([...bytes]));ws.send(encodeStompFrame('CONNECTED',{version:'1.2','heart-beat':'1000,1000'}));}});const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;m.state.config.autoReconnect=false;m.state.config.heartbeatOutgoing=1000;m.state.config.heartbeatIncoming=1000;
  try{await m.connect();await until(()=>m.state.status==='connected');await until(()=>raw.some(bytes=>bytes.length===1&&bytes[0]===10),1800);await until(()=>m.state.status==='disconnected',2000);assert.match(m.state.error,/heartbeat|心跳/i);await m.disconnect();const count=f.calls.length;await pause(50);assert.equal(f.calls.length,count);}
  finally{await m.dispose();await f.close();}
});
test('STOMP subscription exists before a retained MESSAGE can beat native send acknowledgement',async()=>{
  const f=await wireFixture((ws,frame)=>{connected(ws,frame);if(frame.command==='SUBSCRIBE')ws.send(encodeStompFrame('MESSAGE',{subscription:frame.headers.id,destination:'/queue/retained','message-id':'retained',ack:'ack-retained'},'retained'));});
  const execute=f.runtime.stomp.execute;f.runtime.stomp.execute=async request=>{const result=await execute(request);if(request.action==='send'&&new StompDecoder().push(request.bytes)[0]?.command==='SUBSCRIBE')await pause(30);return result;};
  const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;try{await m.connect();await until(()=>m.state.status==='connected');await m.subscribe({id:'q',destination:'/queue/retained',ack:'client-individual'});assert.equal(m.state.status,'connected');assert.ok(m.state.messages.some(row=>row.body==='retained'));}finally{await m.dispose();await f.close();}
});
test('STOMP cancel permits a new connection before old native open resolves',async()=>{
  let resolveOld;let opens=0;const calls=[];const runtime={stomp:{onEvent:()=>()=>{},execute:async request=>{calls.push(request);if(request.action==='open'){if(++opens===1)return new Promise(resolve=>{resolveOld=resolve;});return {sessionId:'new-session'};}return {};}}};const m=createStompWorkbench(runtime);const first=m.connect();await pause(0);await m.disconnect();const second=await m.connect();assert.equal(second,true);const currentId=m.state.connectionId;resolveOld({sessionId:'old-session'});await first;assert.equal(m.state.connectionId,currentId);assert.equal(m.state.sessionId,'new-session');await m.dispose();
});
test('STOMP displayed messages bound bytes and rows and old ACK controls expire after unsubscribe/disconnect',async()=>{
  const f=await wireFixture(connected);const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;
  try{await m.connect();await until(()=>m.state.status==='connected');await m.subscribe({id:'a',destination:'/topic/a',ack:'client'});await m.subscribe({id:'b',destination:'/topic/b',ack:'client-individual'});
    const ws=f.sockets[0];ws.send(encodeStompFrame('MESSAGE',{subscription:'a',destination:'/topic/a','message-id':'one',ack:'ack-one'},'one'));ws.send(encodeStompFrame('MESSAGE',{subscription:'b',destination:'/topic/b','message-id':'two',ack:'ack-two'},'two'));await until(()=>m.state.messages.length===2);await m.unsubscribe('a');assert.equal(m.state.messages.find(row=>row.body==='one').status,'unsubscribed');await m.disconnect();assert.equal(m.state.messages.find(row=>row.body==='two').status,'stale');
    await m.connect();await until(()=>m.state.status==='connected');await m.subscribe({id:'large',destination:'/topic/large',ack:'auto'});await until(()=>f.commands.filter(row=>row.command==='SUBSCRIBE').length>=4);
    for(let i=0;i<12;i++)f.sockets.at(-1).send(encodeStompFrame('MESSAGE',{subscription:'large',destination:'/topic/large','message-id':`large-${i}`},String(i)+'x'.repeat(900000)));await until(()=>m.state.messages.at(-1)?.messageId==='large-11');assert.ok(m.state.messages.length<12);assert.ok(m.state.messages.reduce((sum,row)=>sum+new TextEncoder().encode(row.body).length,0)<=8388608);m.clearMessages();assert.equal(m.state.messages.length,0);
  }finally{await m.dispose();await f.close();}
});
test('STOMP server serializes each peer independently so one slow send cannot block another peer',async()=>{
  let listener;const sent=[];const connection={sessionId:'server-session',operationId:'server-operation'};let finishSlow;
  const runtime={stomp:{onEvent:fn=>{listener=fn;return()=>{};},execute:async request=>{if(request.action==='open')return connection;if(request.action==='send'){sent.push(request);if(request.peerId==='slow')await new Promise(resolve=>{finishSlow=resolve;});}return {};}}};const m=createStompWorkbench(runtime);m.state.mode='server';await m.connect();const payload={endpointId:m.state.connectionId,...connection};
  listener({type:'frames',payload:{...payload,frames:['slow','fast'].map(peerId=>({direction:'in',peerId,bytes:[...encodeStompFrame('CONNECT',{'accept-version':'1.2',host:'localhost'})]}))}});await pause(20);assert.deepEqual(sent.map(row=>row.peerId),['slow','fast']);finishSlow?.();await m.dispose();
});
test('cumulative NACK releases pending capacity before redelivery can beat native acknowledgement',async()=>{
  const batch=(ws,prefix)=>{for(let i=0;i<1000;i++)ws.send(encodeStompFrame('MESSAGE',{subscription:'cumulative',destination:'/queue/cumulative','message-id':`${prefix}-${i}`,ack:`${prefix}-ack-${i}`},`${prefix}-${i}`));};
  const f=await wireFixture((ws,frame)=>{connected(ws,frame);if(frame.command==='SUBSCRIBE')batch(ws,'first');if(frame.command==='NACK')batch(ws,'retry');});
  const execute=f.runtime.stomp.execute;f.runtime.stomp.execute=async request=>{const result=await execute(request);if(request.action==='send'&&new StompDecoder().push(request.bytes)[0]?.command==='NACK')await pause(100);return result;};
  const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;try{await m.connect();await until(()=>m.state.status==='connected');await m.subscribe({id:'cumulative',destination:'/queue/cumulative',ack:'client'});await until(()=>m.state.messages.at(-1)?.body==='first-999');const last=m.state.messages.at(-1);await m.nack(last.id);await until(()=>m.state.messages.at(-1)?.body==='retry-999');assert.equal(m.state.status,'connected');}finally{await m.dispose();await f.close();}
});
test('STOMP restored subscriptions wait for broker receipts before reporting connected',async()=>{
  const f=await wireFixture((ws,frame)=>{if(frame.command==='CONNECT')ws.send(encodeStompFrame('CONNECTED',{version:'1.2','heart-beat':'0,0'}));});const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;m.state.subscriptions=[{id:'restore',destination:'/topic/restore',ack:'auto'}];
  try{await m.connect();await until(()=>f.commands.some(row=>row.command==='SUBSCRIBE'));assert.equal(m.state.status,'connecting');const subscribe=f.commands.find(row=>row.command==='SUBSCRIBE');assert.ok(subscribe.headers.receipt);f.sockets[0].send(encodeStompFrame('RECEIPT',{'receipt-id':subscribe.headers.receipt}));await until(()=>m.state.status==='connected');}finally{await m.dispose();await f.close();}
});
test('local STOMP server reports controlled authentication failures without retaining the peer CONNECT frame',async()=>{
  let listener;const runtime={stomp:{onEvent:fn=>{listener=fn;return()=>{};},execute:async request=>request.action==='open'?{sessionId:'server'}:{}}};const m=createStompWorkbench(runtime);m.state.mode='server';m.state.credentials={login:'user',passcode:'PRIVATE-SERVER-PASS',headers:[],requireAuthentication:true};
  try{await m.connect();listener({type:'frames',payload:{endpointId:m.state.connectionId,sessionId:'server',frames:[{direction:'in',peerId:'bad-peer',bytes:[...encodeStompFrame('CONNECT',{'accept-version':'1.2',host:'localhost',login:'user',passcode:'PRIVATE-WRONG-PASS'})]}]}});assert.match(m.state.error,/Authentication/);assert.equal(m.state.messages.length,0);assert.equal(m.state.error.includes('PRIVATE'),false);}finally{await m.dispose();}
});
test('pending ACK metadata survives clearing history and supports acknowledgement by the original displayed id',async()=>{
  const f=await wireFixture(connected);const m=createStompWorkbench(f.runtime);m.state.config.url=f.url;try{await m.connect();await until(()=>m.state.status==='connected');await m.subscribe({id:'pending',destination:'/queue/pending',ack:'client-individual'});f.sockets[0].send(encodeStompFrame('MESSAGE',{subscription:'pending',destination:'/queue/pending','message-id':'pending-message',ack:'pending-ack'},'pending-body'));await until(()=>m.state.messages.length===1);const id=m.state.messages[0].id;m.clearMessages();assert.equal(m.state.pendingMessages?.length,1);assert.equal(JSON.stringify(m.state.pendingMessages).includes('pending-body'),false);assert.equal(await m.ack(id),true);await until(()=>f.commands.some(frame=>frame.command==='ACK'));assert.equal(m.state.pendingMessages.length,0);}finally{await m.dispose();await f.close();}
});
test('profile writes hold a busy lock and prevent another save, selection or connect from racing persistence',async()=>{
  let complete;const writes=[];const m=createStompWorkbench({settings:{save:async(key,value)=>{writes.push({key,value});await new Promise(resolve=>{complete=resolve;});}},stomp:{onEvent:()=>()=>{},execute:async()=>{throw new Error('Connect must be blocked');}}});const first=m.saveProfile('first');await pause(0);assert.ok(m.state.busy);assert.equal(await m.saveProfile('second'),false);assert.equal(await m.connect(),false);m.selectProfile('other');assert.equal(m.state.profileId,'');complete();assert.equal(await first,true);assert.equal(writes.length,1);assert.equal(m.state.profiles[0].name,'first');assert.equal(m.state.busy,'');await m.dispose();
});
