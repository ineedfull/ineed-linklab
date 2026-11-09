import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readMigration, SCHEMA_VERSION } from '../../../packages/persistence-contract/src/schema.js';
import { createRequire } from 'node:module';
import test from 'node:test';
const require=createRequire(import.meta.url);
const {openConfigurationDatabase}=require('../electron/database.cjs');
test('WebSocket migration6 retains existing endpoints and child history with foreign keys',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    for(let n=1;n<=5;n++)db.exec(await readMigration(n));
    db.exec(`INSERT INTO endpoint_profiles VALUES ('old','old','tcp-client','{}',1,2);
      INSERT INTO transfer_frames(endpoint_id,session_id,direction,format,framing,payload,byte_count,created_at) VALUES('old','session','in','hex','raw',X'00FF',2,3);`);
    assert.equal(SCHEMA_VERSION,6);db.exec(await readMigration(6));
    assert.equal(db.prepare('SELECT count(*) AS n FROM transfer_frames').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec(`INSERT INTO endpoint_profiles VALUES ('new','ws','websocket-client','{}',4,5);`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM endpoint_profiles').get().n,2);
  }finally{db.close();}
});
test('WebSocket profiles round trip while transient handshake headers are rejected at native persistence boundary',()=>{
  const db=openConfigurationDatabase(':memory:');
  try{
    const p={id:'ws',name:'WS',transport:'websocket-client',config:{url:'ws://127.0.0.1:9000',subprotocols:[]}};
    db.saveEndpoint(p);assert.equal(db.listEndpoints()[0].transport,'websocket-client');
    for(const key of ['headers','websocketHeaders'])assert.throws(()=>db.saveEndpoint({...p,config:{...p.config,[key]:[{name:'Authorization',value:'private'}]}}),/header|session|memory/i);
    assert(!JSON.stringify(db.exportWorkspace()).includes('private'));
  }finally{db.close();}
});
