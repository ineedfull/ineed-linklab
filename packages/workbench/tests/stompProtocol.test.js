import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StompDecoder, encodeStompFrame, STOMP_LIMITS } from '../src/model/stompCodec.js';
import { createStompBroker } from '../src/model/stompBroker.js';

const text = value => new TextEncoder().encode(value);
function fixture(config = {}, credentials = {}) {
  const frames = new Map(); const closed = []; const messages = [];
  const broker = createStompBroker({ config: { host: 'localhost', heartbeatOutgoing: 0, heartbeatIncoming: 0, ...config }, credentials,
    send(id, bytes) { if (!frames.has(id)) frames.set(id, []); frames.get(id).push(...new StompDecoder().push(bytes).filter(f => f.command)); },
    close: id => closed.push(id), onMessage: row => messages.push(row) });
  const write = (id, command, headers = {}, body = '') => broker.receive(id, encodeStompFrame(command, headers, body));
  const connect = (id, extra = {}) => { broker.addPeer(id); write(id, 'CONNECT', { 'accept-version': '1.2', host: 'localhost', 'heart-beat': '0,0', ...extra }); };
  const take = id => { const result = frames.get(id) ?? []; frames.set(id, []); return result; };
  return { broker, write, connect, take, closed, messages };
}
test('STOMP byte codec preserves Unicode/NULL, escaping, split and concatenated frames', () => {
  const bytes = encodeStompFrame('SEND', { destination: '/topic/a', 'x:key': 'a\nb\rc\\d' }, '你\0🙂');
  const decoder = new StompDecoder(); const frames = [];
  for (const byte of bytes) frames.push(...decoder.push(Uint8Array.of(byte)));
  assert.equal(frames[0].body, '你\0🙂'); assert.equal(frames[0].headers['x:key'], 'a\nb\rc\\d');
  assert.equal(frames[0].headers['content-length'], '8');
  assert.equal(new StompDecoder().push(text('\n' + new TextDecoder().decode(bytes).repeat(2))).filter(f => f.command).length, 2);
});
test('STOMP decoder rejects invalid escapes, UTF-8, lengths and frame overflow', () => {
  for (const bytes of [text('SEND\nx:a\\t\n\n\0'), text('SEND\ncontent-length:1\n\nab\0'), Uint8Array.from([...text('SEND\n\n'), 255, 0])]) assert.throws(() => new StompDecoder().push(bytes));
  assert.throws(() => new StompDecoder().push(text('SEND\n\n' + 'x'.repeat(STOMP_LIMITS.frameBytes))), /limit|large|exceed/i);
});
test('local broker negotiates 1.2 and rejects version, virtual host and credentials without reflecting input', () => {
  const f = fixture({}, { requireAuthentication: true, login: 'user', passcode: 'secret' });
  f.connect('good', { login: 'user', passcode: 'secret' }); assert.equal(f.take('good')[0].command, 'CONNECTED');
  for (const [id, fields] of [['version', { 'accept-version': '1.1' }], ['host', {host:'other'}], ['auth', {login:'user',passcode:'WRONG-SECRET'}]]) {
    f.connect(id, fields); assert.equal(f.take(id)[0].command, 'ERROR'); assert.ok(f.closed.includes(id));
  }
  assert.equal(JSON.stringify(f.messages).includes('secret'), false); f.broker.dispose();
});
test('broker exact topics broadcast and queues distribute fairly with receipts', () => {
  const f = fixture(); f.connect('a'); f.connect('b'); f.take('a'); f.take('b');
  for (const id of ['a','b']) { f.write(id,'SUBSCRIBE',{id:'topic',destination:'/topic/a',ack:'auto'}); f.write(id,'SUBSCRIBE',{id:'queue',destination:'/queue/a',ack:'auto'}); }
  f.write('a','SEND',{destination:'/topic/a',receipt:'r1'},'你好');
  assert.equal(f.take('a').filter(v=>v.command==='MESSAGE').length,1); assert.equal(f.take('b')[0].body,'你好');
  for (let i=0;i<4;i++) f.write('a','SEND',{destination:'/queue/a'},String(i));
  assert.deepEqual(f.take('a').map(v=>v.body),['0','2']); assert.deepEqual(f.take('b').map(v=>v.body),['1','3']);
  f.write('a','SEND',{destination:'/topic/a',receipt:'r2'},'receipt'); assert.ok(f.take('a').some(v=>v.command==='RECEIPT'&&v.headers['receipt-id']==='r2')); f.broker.dispose();
});
test('broker client ACK is cumulative, individual ACK is isolated and NACK redelivers', () => {
  const f=fixture(); f.connect('a'); f.take('a'); f.write('a','SUBSCRIBE',{id:'q',destination:'/queue/q',ack:'client'});
  for(let i=0;i<3;i++) f.write('a','SEND',{destination:'/queue/q'},String(i));
  const received=f.take('a'); f.write('a','ACK',{id:received[1].headers.ack});
  f.write('a','NACK',{id:received[2].headers.ack}); const again=f.take('a')[0]; assert.equal(again.body,'2'); assert.equal(again.headers.redelivered,'true');
  f.write('a','ACK',{id:again.headers.ack}); f.broker.removePeer('a'); f.connect('b'); f.take('b'); f.write('b','SUBSCRIBE',{id:'q',destination:'/queue/q',ack:'client-individual'}); assert.equal(f.take('b').length,0);
  for(let i=0;i<2;i++) f.write('b','SEND',{destination:'/queue/q'},String(i)); const pair=f.take('b'); f.write('b','ACK',{id:pair[1].headers.ack}); f.broker.removePeer('b');
  f.connect('c');f.take('c');f.write('c','SUBSCRIBE',{id:'q',destination:'/queue/q'});assert.deepEqual(f.take('c').map(v=>v.body),['0']);f.broker.dispose();
});
test('broker rejects transactions/wildcards, bounds retained queues and cleans failed peers', () => {
  const f=fixture();f.connect('a');f.take('a');f.write('a','BEGIN',{transaction:'t'});assert.ok(f.closed.includes('a'));
  f.connect('b');f.take('b');f.write('b','SUBSCRIBE',{id:'s',destination:'/topic/*'});assert.ok(f.closed.includes('b'));
  f.connect('c');f.take('c');for(let i=0;i<1001;i++)f.write('c','SEND',{destination:'/queue/retained'},'x');assert.ok(f.closed.includes('c'));
  f.connect('d');f.take('d');f.write('d','SUBSCRIBE',{id:'q',destination:'/queue/retained'});assert.equal(f.take('d').length,1000);f.broker.dispose();
});
test('broker heartbeat negotiation sends LF and closes silent peers while listener survives', () => {
  let now=100;const sent=[];const closed=[];
  const b=createStompBroker({config:{host:'localhost',heartbeatOutgoing:1000,heartbeatIncoming:1000},now:()=>now,send:(id,bytes)=>sent.push({id,bytes}),close:id=>closed.push(id)});
  b.addPeer('a');b.receive('a',encodeStompFrame('STOMP',{'accept-version':'1.2',host:'localhost','heart-beat':'1000,1000'}));
  now=1101;b.tick();assert.ok(sent.some(row=>row.bytes.length===1&&row.bytes[0]===10));
  now=2201;b.tick();assert.deepEqual(closed,['a']);b.addPeer('b');b.receive('b',encodeStompFrame('CONNECT',{'accept-version':'1.2',host:'localhost'}));assert.equal(new StompDecoder().push(sent.at(-1).bytes)[0].command,'CONNECTED');b.dispose();
});
test('topic NACK redelivers to the same subscription and unknown ACK closes only that peer',()=>{
  const f=fixture();f.connect('a');f.connect('b');f.take('a');f.take('b');f.write('a','SUBSCRIBE',{id:'t',destination:'/topic/t',ack:'client-individual'});f.write('b','SEND',{destination:'/topic/t'},'retry');
  const first=f.take('a')[0];f.write('a','NACK',{id:first.headers.ack});const second=f.take('a')[0];assert.equal(second?.body,'retry');assert.equal(second.headers.redelivered,'true');assert.notEqual(second.headers.ack,first.headers.ack);
  f.write('a','ACK',{id:'unknown'});assert.ok(f.closed.includes('a'));f.write('b','SEND',{destination:'/queue/q',receipt:'still-live'},'ok');assert.equal(f.take('b')[0].command,'RECEIPT');f.broker.dispose();
});
test('heartbeat floods coalesce and oversized batches fail before allocating unlimited frame objects',()=>{
  assert.equal(new StompDecoder().push(text('\n'.repeat(1048576))).length,1);
  assert.throws(()=>new StompDecoder().push(text('SEND\n\n\0'.repeat(1001))),/batch limit/);
});
test('broker enforces peer/subscription limits and aggregate retained-byte budget',()=>{
  const f=fixture();for(let i=0;i<65;i++)f.broker.addPeer(`peer-${i}`);assert.ok(f.closed.includes('peer-64'));f.broker.dispose();
  const s=fixture();s.connect('subscriber');s.take('subscriber');for(let i=0;i<101;i++)s.write('subscriber','SUBSCRIBE',{id:String(i),destination:'/topic/t'});assert.ok(s.closed.includes('subscriber'));s.broker.dispose();
  const memory=fixture();memory.connect('publisher');memory.take('publisher');for(let i=0;i<10;i++)memory.write('publisher','SEND',{destination:'/queue/large'},'x'.repeat(900000));assert.ok(memory.closed.includes('publisher'));memory.broker.dispose();
});
test('STOMP preserves a leading BOM in opaque bodies and applies escapes to STOMP command headers',()=>{
  const [frame]=new StompDecoder().push(encodeStompFrame('SEND',{destination:'/topic/t'},'\uFEFFhello'));assert.equal(frame.body,'\uFEFFhello');
  const [stomp]=new StompDecoder().push(encodeStompFrame('STOMP',{login:'user:name',passcode:'back\\slash'}));assert.equal(stomp.headers.login,'user:name');assert.equal(stomp.headers.passcode,'back\\slash');assert.match(new TextDecoder().decode(encodeStompFrame('STOMP',{login:'user:name'})),/user\\cname/);
});
test('manual pending saturation cannot stall unrelated auto-ack queue consumers',()=>{
  const f=fixture();f.connect('manual');f.connect('auto');f.take('manual');f.take('auto');f.write('manual','SUBSCRIBE',{id:'m',destination:'/topic/manual',ack:'client'});f.write('auto','SUBSCRIBE',{id:'a',destination:'/queue/free',ack:'auto'});
  for(let i=0;i<1000;i++)f.write('manual','SEND',{destination:'/topic/manual'},'pending');f.take('manual');f.write('auto','SEND',{destination:'/queue/free'},'free');assert.equal(f.take('auto')[0]?.body,'free');f.broker.dispose();
});
test('broker rejects a SEND whose delivered MESSAGE would exceed the frame limit without closing subscribers',()=>{
  const f=fixture();f.connect('publisher');f.connect('subscriber');f.take('publisher');f.take('subscriber');f.write('subscriber','SUBSCRIBE',{id:'s',destination:'/topic/large',ack:'auto'});
  f.write('publisher','SEND',{destination:'/topic/large',receipt:'large'},'x'.repeat(1048576-100));assert.ok(f.closed.includes('publisher'));assert.equal(f.closed.includes('subscriber'),false);assert.equal(f.take('subscriber').length,0);assert.ok(f.take('publisher').some(frame=>frame.command==='ERROR'));f.broker.dispose();
});

test('late transport rejection cannot close a replacement peer with a reused id', async () => {
  let rejectSend; const closed = [];
  const broker = createStompBroker({ config: { heartbeatOutgoing: 0, heartbeatIncoming: 0 },
    send(_id, bytes) { if (new StompDecoder().push(bytes).some(frame => frame.command === 'MESSAGE')) return new Promise((_resolve, reject) => { rejectSend = reject; }); },
    close: id => closed.push(id),
  });
  const write = (command, headers) => broker.receive('reused', encodeStompFrame(command, headers));
  const connect = () => { broker.addPeer('reused'); write('CONNECT', { 'accept-version': '1.2', host: 'localhost' }); };
  connect(); write('SUBSCRIBE', { id: 'sub', destination: '/topic/test' });
  const publication = broker.send({ destination: '/topic/test', body: 'old' });
  broker.removePeer('reused'); connect();
  rejectSend(new Error('old native failure'));
  await assert.rejects(publication);
  assert.deepEqual(closed, []);
  broker.dispose();
});

test('failed peer ignores trailing frames and stale native peer snapshots until actual removal', async () => {
  const failures = [], closed = [];
  const broker = createStompBroker({ config: { heartbeatOutgoing: 0, heartbeatIncoming: 0 },
    send() {}, close: id => closed.push(id), onError: error => failures.push(error.message),
  });
  broker.addPeer('peer');
  broker.receive('peer', encodeStompFrame('CONNECT', { 'accept-version': '1.2', host: 'localhost' }));
  broker.receive('peer', encodeStompFrame('BEGIN'));
  broker.addPeer('peer'); // Native snapshot can still include a peer being closed.
  broker.receive('peer', encodeStompFrame('SEND', { destination: '/topic/test' }, 'late'));
  broker.tick();
  assert.deepEqual(failures, ['Transactions are unsupported']);
  assert.deepEqual(closed, ['peer']);
  broker.removePeer('peer'); broker.addPeer('peer');
  broker.receive('peer', encodeStompFrame('CONNECT', { 'accept-version': '1.2', host: 'localhost' }));
  assert.deepEqual(failures, ['Transactions are unsupported']);
  broker.dispose();
});
