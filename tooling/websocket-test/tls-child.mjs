// Isolated process so NODE_EXTRA_CA_CERTS is applied before Node initializes TLS.
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {WebSocketServer}=require('ws');
const {WebSocketService}=require('../../apps/electron/electron/websocketService.cjs');
const options={key:readFileSync(new URL('./fixtures/localhost-key.pem',import.meta.url)),cert:readFileSync(new URL('./fixtures/localhost-cert.pem',import.meta.url))};
const service=new WebSocketService({emitEvent:()=>{}});
async function check(host,ok){
  const server=https.createServer(options);const ws=new WebSocketServer({server});
  server.listen(0,host);await once(server,'listening');
  try{
    const promise=service.open({id:host,transport:'websocket-client',config:{url:`wss://${host.includes(':')?'['+host+']':host}:${server.address().port}`}},{operationId:'tls'});
    if(ok) {await promise;await service.close(host);} else await assert.rejects(promise,/handshake|connect/i);
  }finally{for(const socket of ws.clients)socket.terminate();await new Promise(resolve=>ws.close(resolve));await new Promise(resolve=>server.close(resolve));}
}
try{await check('127.0.0.1',true);await check('::1',false);console.log('trusted WSS and hostname mismatch passed');}
finally{await service.shutdown();}
