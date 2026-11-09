import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
export async function createWebSocketFixture() {
  const received=[];
  const server=new WebSocketServer({host:'127.0.0.1',port:0,
    handleProtocols: protocols=>protocols.has('linklab')?'linklab':false,
    verifyClient: info=>info.req.headers.authorization==='Bearer desktop-only',
  });
  await once(server,'listening');
  server.on('connection',socket=>socket.on('message',(bytes,binary)=>{
    received.push({bytes:[...bytes],messageType:binary?'binary':'text'});
    socket.send(bytes,{binary});
  }));
  return {url:`ws://127.0.0.1:${server.address().port}/echo`,received,
    async close(){for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));}};
}
