/* global window, document, MouseEvent */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';
import { createOpcuaTestServer } from './server.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=await mkdtemp(path.join(tmpdir(),'linklab-opcua-tauri-desktop-'));
const fixture=await createOpcuaTestServer();
for(const event of ['create_session','session_activated','session_closed']) fixture.server.on(event,()=>console.log('[opcua-test-server]',event));
let child;let reportUrl;let finish;
const completed=new Promise(resolve=>{finish=resolve;});
async function workload(config){
  const pause=ms=>new Promise(resolve=>window.setTimeout(resolve,ms));
  const wait=async(check,label)=>{for(let n=0;n<200;n++){if(check())return;await pause(100);}throw new Error(label+' timed out: '+document.body.innerText);};
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
  const click=async text=>{await wait(()=>button(text)&&!button(text).disabled,text);button(text).dispatchEvent(new MouseEvent('click',{bubbles:true}));await pause(100);};
  const input=async(label,value)=>{const el=[...document.querySelectorAll('.opcua-panel label')].find(l=>l.firstChild?.textContent.trim()===label)?.querySelector('input,textarea');if(!el)throw new Error('Missing input '+label);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));await pause(50);};
  await wait(()=>document.querySelector('[aria-label="添加端点"]'),'Endpoint tree');
  document.querySelector('[aria-label="添加端点"]').click();await pause(100);
  const dialog=document.querySelector('.endpoint-dialog');
  const field=(name,value)=>{const el=dialog.querySelector(`[name="${name}"]`);el.value=value;el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  field('endpoint-transport','opcua-client');await pause(100);field('endpoint-name','UA native acceptance');field('opcua-endpoint-url',config.endpointUrl);
  await click('保存端点');await wait(()=>!document.querySelector('.endpoint-dialog'),'Endpoint saved');

  await input('Endpoint URL',config.endpointUrl);await click('连接');await wait(()=>document.querySelector('.opcua-status')?.textContent==='已连接','connect');
  await click('节点与监视');await input('NodeId',config.nodes.Folder);await click('浏览');await wait(()=>document.body.innerText.includes('Temperature'),'browse');
  await input('NodeId',config.nodes.Wide);await click('读取节点');await wait(()=>document.body.innerText.includes('9223372036854775807'),'lossless read');
  await input('NodeId',config.nodes.Temperature);await click('读取节点');await wait(()=>document.body.innerText.includes('23.5'),'temperature');
  const row=[...document.querySelectorAll('.opcua-table tr')].find(tr=>tr.textContent.includes(config.nodes.Temperature)&&tr.textContent.includes('23.5'));row.querySelector('button').click();await pause(100);
  await input('新值','31.5');const confirm=document.querySelector('[name="write-confirm"]');confirm.click();await pause(100);await click('确认写入');await wait(()=>document.body.innerText.includes('写入成功'),'write');
  await click('读取节点');await wait(()=>document.body.innerText.includes('31.5'),'write readback');
  document.querySelector('[aria-label="选择 Changing"]').click();await click('监视所选（1/100）');
  await wait(()=>[...document.querySelectorAll('.opcua-table code')].filter(el=>el.textContent===config.nodes.Changing).length>=2,'native subscription data');
  await input('采样间隔（毫秒）','99');await click('监视所选（1/100）');await wait(()=>document.body.innerText.includes('100..60000'),'invalid replacement error');
  if(button('停止监视').disabled||!document.body.innerText.includes('当前监视 1 个节点'))throw new Error('Invalid input lost active monitor');
  document.querySelector('[aria-label="打开工具箱"]').click();await pause(100);document.querySelector('[aria-label="选择 UA native acceptance"]').click();await pause(100);await wait(()=>document.body.innerText.includes('当前监视 1 个节点'),'preserved session');
  await click('停止监视');await click('断开');await wait(()=>document.querySelector('.opcua-status')?.textContent==='未连接','disconnect');
  return {passed:true,checks:['real Tauri WebView','browse','Int64','confirmed write/readback','native subscription data','invalid replacement preserves Stop','navigation retention','unsubscribe','disconnect']};
}
const web=http.createServer(async(req,res)=>{
 try{
  if(req.method==='POST'&&req.url==='/report'){let body='';for await(const part of req)body+=part;finish(JSON.parse(body));res.end('ok');return;}
  if(req.url==='/opcua-test.js'){res.setHeader('content-type','application/javascript');res.end(`(${workload.toString()})(${JSON.stringify({endpointUrl:fixture.endpointUrl,nodes:fixture.nodes})}).then(result=>fetch(${JSON.stringify(reportUrl)},{method:'POST',body:JSON.stringify(result)})).catch(error=>fetch(${JSON.stringify(reportUrl)},{method:'POST',body:JSON.stringify({passed:false,error:error.message+'; '+error.stack})}));`);return;}
  const relative=req.url==='/'?'index.html':req.url.split('?')[0].slice(1);if(relative.includes('..'))throw new Error('Invalid path');
  let bytes=await readFile(path.join(root,'apps/tauri/dist',relative));if(relative==='index.html')bytes=Buffer.from(bytes.toString().replace('</body>','<script type="module" src="/opcua-test.js"></script></body>'));
  res.setHeader('content-type',relative.endsWith('.js')?'application/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.svg')?'image/svg+xml':'text/html');res.end(bytes);
 }catch{res.statusCode=404;res.end();}
});
try{
 web.listen(0,'127.0.0.1');await once(web,'listening');const url=`http://127.0.0.1:${web.address().port}`;reportUrl=url+'/report';
 const identifier='com.ineedfull.linklab.opcuatest'+Date.now();const override=path.join(out,'tauri-config.json');
 await writeFile(override,JSON.stringify({identifier,build:{beforeDevCommand:'',devUrl:url},app:{security:{devCsp:`default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${url}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'`}}}));
 await writeFile(path.join(out,'isolation.json'),JSON.stringify({identifier,dataPath:path.join(process.env.HOME,'Library/Application Support',identifier),url}));
 child=spawn(path.join(root,'node_modules/.bin/tauri'),tauriDevArguments(['--no-watch','--config',override]),{cwd:path.join(root,'apps/tauri'),stdio:['ignore','pipe','pipe'],detached:true});
 for(const stream of[child.stdout,child.stderr])stream.on('data',part=>process.stdout.write(part));
 child.on('exit',(code)=>finish({passed:false,error:'Tauri exited before acceptance: '+code}));
 const timeout=setTimeout(()=>finish({passed:false,error:'Tauri desktop acceptance deadline'}),180000);
 let result;try{result=await completed;}finally{clearTimeout(timeout);}
 await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,out}));assert.equal(result.passed,true,result.error);
}finally{
 if(child){try{process.kill(-child.pid,'SIGTERM');}catch{/* Already exited. */}}
 await fixture.close();await new Promise(resolve=>web.close(resolve));
}
