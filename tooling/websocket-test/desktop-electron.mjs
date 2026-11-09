import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { createWebSocketFixture } from './server.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(import.meta.url);const {expect}=require('@playwright/test');const {WebSocket}=require('ws');
const out=await mkdtemp(path.join(tmpdir(),'linklab-websocket-electron-'));const data=path.join(out,'profile');await mkdir(data);
const bootstrap=path.join(out,'main.cjs');
await writeFile(bootstrap,`const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(data)});app.setPath('sessionData',${JSON.stringify(data)});require(${JSON.stringify(path.join(root,'apps/electron/electron/main.cjs'))});`);
const fixture=await createWebSocketFixture();let app;const clients=[];
try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
  app=await require('@playwright/test')._electron.launch({executablePath:await prepareElectronExecutable(),args:[bootstrap],env,timeout:30000});
  const page=await app.firstWindow();await page.waitForFunction(()=>!!globalThis.ineedLinkLab);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function create(transport,name,port){
    await page.getByRole('button',{name:'添加端点',exact:true}).first().click();const form=page.getByRole('dialog',{name:'新建端点'});
    await form.locator('[name="endpoint-transport"]').selectOption(transport);await form.locator('[name="endpoint-name"]').fill(name);
    if(transport.endsWith('client')){
      await form.locator('[name="websocket-url"]').fill(fixture.url);await form.locator('[name="websocket-subprotocols"]').fill('linklab');
      await form.locator('[name="websocket-header-name-0"]').fill('Authorization');await form.locator('[name="websocket-header-value-0"]').fill('Bearer desktop-only');
    }else await form.locator('[name="websocket-listen-port"]').fill(String(port));
    await form.getByRole('button',{name:'保存端点',exact:true}).click();await expect(form).toHaveCount(0);
    const row=page.locator('.endpoint-row').filter({hasText:name});await row.getByRole('button',{name:`选择 ${name}`}).click();await row.getByRole('button',{name:'打开端点'}).click();
    await expect(page.locator('.session-state')).toHaveText(transport.endsWith('client')?'已打开':'监听中');return row;
  }
  const row=await create('websocket-client','WS native client');
  await page.getByRole('textbox',{name:'发送内容'}).fill('native desktop text');
  await page.locator('.send-panel__footer').getByRole('button',{name:'发送',exact:true}).click();await expect.poll(()=>fixture.received.length).toBe(1);
  await expect(page.locator('.frame-direction small').filter({hasText:'TXT'}).first()).toBeVisible();
  await page.getByRole('radio',{name:'HEX',exact:true}).click();await page.getByRole('textbox',{name:'发送内容'}).fill('00 FF 01');
  await page.locator('.send-panel__footer').getByRole('button',{name:'发送',exact:true}).click();await expect.poll(()=>fixture.received.length).toBe(2);
  assert.deepEqual(fixture.received[1],{bytes:[0,255,1],messageType:'binary'});
  const endpoint=await page.evaluate(async()=>{const result=await globalThis.ineedLinkLab.endpoint.list();const endpoints=result.value??result;return endpoints.find(e=>e.name==='WS native client');});
  assert(!JSON.stringify(endpoint).includes('desktop-only'));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const serverRow=await create('websocket-server','WS native server',port);
  clients.push(new WebSocket(`ws://127.0.0.1:${port}`),new WebSocket(`ws://127.0.0.1:${port}`));await Promise.all(clients.map(c=>once(c,'open')));
  await expect(page.locator('.endpoint-tree__peers[aria-label="WebSocket 服务端连接"] button')).toHaveCount(2);
  const deliveries=clients.map(()=>[]);clients.forEach((c,n)=>c.on('message',b=>deliveries[n].push([...b])));
  await page.getByRole('textbox',{name:'发送内容'}).fill('broadcast');await page.locator('.send-panel__footer').getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>deliveries[0].length+deliveries[1].length).toBe(2);
  await page.screenshot({path:path.join(out,'desktop.png')});
  await serverRow.getByRole('button',{name:'关闭端点'}).click();await row.getByRole('button',{name:'关闭端点'}).click();assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,out,checks:['native branded startup','UI client+memory authorization+protocol','text echo','binary echo','typed frames','headers excluded from saved profile','UI server','native peers and broadcast','close']}));
}finally{for(const c of clients)c.terminate();await app?.close();await fixture.close();}
