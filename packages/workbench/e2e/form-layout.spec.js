import { openWorkspaceTool } from './helpers/workspaceTools.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {expect,test} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('./fixtures/previewBridge.js',import.meta.url));
async function measure(panel) {
  return panel.evaluate(root => {
    const controls = [...root.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select')].filter(n => n.getBoundingClientRect().width > 0);
    const groups = new Map();
    return controls.map(n => { const r=n.getBoundingClientRect(); const p=n.parentElement.getBoundingClientRect(); const group=n.parentElement.parentElement; if(!groups.has(group)) groups.set(group,groups.size); return {name:n.name || n.getAttribute('aria-label') || n.parentElement.textContent.trim().slice(0,55), group:groups.get(group),tag:n.tagName,type:n.type,fill:n.parentElement.matches('.modal__field, .field-control'),x:r.x,y:r.y,w:r.width,h:r.height,parentX:p.x,parentY:p.y,parentW:p.width,overflow:n.scrollWidth > n.clientWidth+1}; });
  });
}
async function inspect(panel, info, name) {
  const bounds=await panel.boundingBox();
  if(await panel.getAttribute('role')==='dialog') {
    expect(bounds.y,'dialog top').toBeGreaterThanOrEqual(-1);
    expect(bounds.y+bounds.height,'dialog bottom').toBeLessThanOrEqual(panel.page().viewportSize().height+1);
    const footer=panel.locator(':scope > footer, :scope > .modal__footer');
    if(await footer.count()) {
      const f=await footer.boundingBox();
      expect(f.y+f.height,'footer stays inside dialog').toBeLessThanOrEqual(bounds.y+bounds.height+1);
    }
    const horizontal=await panel.evaluate(n=>n.scrollWidth-n.clientWidth);
    expect(horizontal,'no dialog horizontal overflow').toBeLessThanOrEqual(1);
  }
  const rows=await measure(panel);
  await mkdir(info.outputDir,{recursive:true});
  await writeFile(info.outputPath(name+'.json'),JSON.stringify(rows,null,2));
  await info.attach(name, {body:JSON.stringify(rows,null,2),contentType:'application/json'});
  for (const r of rows) {
    expect(r.h, r.name+' height').toBeGreaterThan(20);
    expect(r.x, r.name+' left edge').toBeGreaterThanOrEqual(r.parentX-1);
    expect(r.x+r.w, r.name+' right edge').toBeLessThanOrEqual(r.parentX+r.parentW+1);
  }
  for (let i=0;i<rows.length;i++) {
    const a=rows[i];
    if(a.fill) expect(Math.abs(a.w-a.parentW),a.name+' fills field').toBeLessThanOrEqual(1);
    for(const b of rows.slice(i+1)) {
      if(a.group===b.group && Math.abs(a.parentY-b.parentY)<1 && Math.abs(a.x-b.x)>5) {
        expect(Math.abs(a.y-b.y),a.name+' / '+b.name+' paired tops').toBeLessThanOrEqual(1);
        expect(Math.abs(a.h-b.h),a.name+' / '+b.name+' paired heights').toBeLessThanOrEqual(1);
      }
    }
  }
  return rows;
}

for(const width of [1440,1120,920]) for(const dark of [false,true]) for(const large of [false,true]) for(const collapsed of [false,true]) {
 test(`${width} dark=${dark} large=${large} collapsed=${collapsed} forms`,async({page},info)=>{
  await page.setViewportSize({width,height:width===1440?900:width===1120?720:620});
  await page.addInitScript({path:fixture});
  await page.addInitScript(()=>{
    const answer=request=>request.action==='connect'?{sessionId:'layout-fixture'}:request.action==='read'?{values:[{nodeId:'ns=1;s=Temperature',dataType:'Double',arrayType:'Scalar',value:23.5,statusCode:'Good'}]}:{};
    if(globalThis.ineedLinkLab) {const original=globalThis.ineedLinkLab.opcua.execute;globalThis.ineedLinkLab.opcua.execute=async request=>['connect','read'].includes(request.action)?{ok:true,value:answer(request)}:original(request);}
    if(globalThis.__TAURI_INTERNALS__) {const original=globalThis.__TAURI_INTERNALS__.invoke;globalThis.__TAURI_INTERNALS__.invoke=async(command,payload)=>command==='opcua_execute'&&['connect','read'].includes(payload.request.action)?{ok:true,value:answer(payload.request)}:original(command,payload);}
  });
  await page.goto('http://127.0.0.1:'+(info.project.metadata.runtime==='electron'?4173:4174)+'/');
  await page.getByRole('button',{name:'打开设置'}).click();
  const settings=page.getByRole('dialog',{name:'设置',exact:true});
  await settings.getByLabel('大字体',{exact:true}).setChecked(large);
  await settings.getByLabel('主题',{exact:true}).selectOption(dark?'dark':'light');
  await inspect(settings,info,'settings');
  const save=settings.getByRole('button',{name:'保存',exact:true});
  if(await save.isEnabled()) await save.click(); else await settings.getByRole('button',{name:'取消',exact:true}).click();
  if(collapsed) await page.getByRole('button',{name:'折叠端点列表'}).click();
  await page.getByRole('button',{name:'添加端点',exact:true}).first().click();
  const dialog=page.getByRole('dialog');
  const transport=dialog.locator('[name=endpoint-transport]');
  const values=await transport.locator('option').evaluateAll(ns=>ns.map(n=>n.value));
  for(const value of values){
   await transport.selectOption(value);
   await inspect(dialog,info,'endpoint-'+value);
   const framing=dialog.locator('[name=serial-receive-framing], [name=tcp-receive-framing]');
   if(await framing.count()) for(const mode of ['delimiter','fixed','idle']) {
    await framing.selectOption(mode);
    await inspect(dialog,info,'endpoint-'+value+'-'+mode);
   }
   if(value.endsWith('-slave') && value.startsWith('modbus')) {
    await dialog.getByRole('button',{name:'添加数据点',exact:true}).click();
    await dialog.locator('[name=modbus-point-0-type]').selectOption('ascii');
    await inspect(dialog,info,'endpoint-'+value+'-ascii-point');
   }
   await page.screenshot({path:info.outputPath('endpoint-'+value+'.png')});
  }
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  if(collapsed) await page.getByRole('button',{name:'展开端点列表'}).click();
  await page.getByRole('button',{name:'选择 锅炉主站',exact:true}).click();
  if(collapsed) await page.getByRole('button',{name:'折叠端点列表'}).click();
  await page.getByRole('tab',{name:'请求组',exact:true}).click();
  for(const name of ['编辑请求组 锅炉采集','编辑请求 保持寄存器']) {
   await page.getByRole('button',{name,exact:true}).click();
   await inspect(page.getByRole('dialog'),info,name);
   if(name==='编辑请求 保持寄存器') for(const type of ['string','boolean','float64']) {
    await page.getByRole('dialog').locator('[name=request-point-0-type]').selectOption(type);
    await inspect(page.getByRole('dialog'),info,'request-point-'+type);
   }
   await page.screenshot({path:info.outputPath(name+'.png')});
   await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  }
  await page.getByRole('tab',{name:'写入操作',exact:true}).click();
  await page.getByRole('button',{name:'新增写入指令',exact:true}).click();
  await inspect(page.getByRole('dialog'),info,'write-command');
  await page.screenshot({path:info.outputPath('write-command.png')});
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await openWorkspaceTool(page, '编码与校验');
  const toolbox=page.getByRole('dialog');
  for(const [group] of [['编码转换',['ascii','bcd']],['数值与字节',['radix','integer','float','byteOrder','bits']],['校验计算',['crc','checksum']]]) {
   await toolbox.getByRole('button',{name:group,exact:true}).click();
   const picker=toolbox.getByRole('combobox',{name:'当前工具',exact:true});
   const available=await picker.locator('option').evaluateAll(ns=>ns.map(n=>n.value));
   for(const id of available) {
    await picker.selectOption(id);
    await inspect(toolbox,info,'toolbox-'+id);
   }
  }
  await toolbox.getByRole('button',{name:'关闭工具箱'}).click();
  await openWorkspaceTool(page, '验收检查');
  await inspect(page.getByRole('dialog'),info,'acceptance');
  await page.getByRole('dialog').locator('[name=acceptance-assertion]').selectOption('range');
  await inspect(page.getByRole('dialog'),info,'acceptance-range');
  await page.getByRole('button',{name:'关闭验收检查',exact:true}).click();
  for(const transport of ['opcua-client','opcua-server','stomp-client','stomp-server']) {
   if(collapsed) await page.getByRole('button',{name:'展开端点列表'}).click();
   await page.getByRole('button',{name:'添加端点',exact:true}).first().click();
   const d=page.getByRole('dialog');
   await d.locator('[name=endpoint-transport]').selectOption(transport);
   await d.locator('[name=endpoint-name]').fill('布局-'+transport);
   await d.getByRole('button',{name:'保存端点'}).click();
   await expect(d).toHaveCount(0);
   if(collapsed) await page.getByRole('button',{name:'折叠端点列表'}).click();
   const panel=page.locator(transport.startsWith('opcua')?'.opcua-panel':'.stomp-panel').filter({visible:true});
   await inspect(panel,info,'panel-'+transport);
   if(transport==='opcua-client') {
    await panel.locator('label').filter({hasText:/^认证/}).locator('select').selectOption('username');
    await inspect(panel,info,'opcua-authentication');
    await panel.getByRole('button',{name:'连接',exact:true}).click();
    await panel.getByRole('button',{name:'节点与监视',exact:true}).click();
    await panel.getByRole('button',{name:'读取节点',exact:true}).click();
    await panel.getByRole('button',{name:'准备写入',exact:true}).click();
    await inspect(panel,info,'opcua-write-editor');
   }
   if(transport==='opcua-server') {
    await panel.locator('[name=node-mode]').selectOption('increment');
    await inspect(panel,info,'opcua-server-increment');
   }
   if(transport.startsWith('stomp')) {
    await panel.getByRole('button',{name:'消息与订阅',exact:true}).click();
    await inspect(panel,info,transport+'-subscription-composer');
   }
   await page.screenshot({path:info.outputPath('panel-'+transport+'.png')});
  }
 });
}

async function verifyScrollFocus(control, scroller, info, name, requireScroll = true) {
  const before = await scroller.evaluate(n => ({ top: n.scrollTop, height: n.clientHeight, content: n.scrollHeight }));
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await expect(control).toBeFocused();
  const field = await control.boundingBox();
  const viewport = await scroller.boundingBox();
  expect(field.y, name + ' top in scroll viewport').toBeGreaterThanOrEqual(viewport.y - 1);
  expect(field.y + field.height, name + ' bottom in scroll viewport').toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  await expect(control).toBeInViewport({ ratio: 1 });
  const after = await scroller.evaluate(n => ({ top: n.scrollTop, height: n.clientHeight, content: n.scrollHeight }));
  if (requireScroll) {
    expect(before.content, name + ' really overflows').toBeGreaterThan(before.height);
    expect(after.top, name + ' actually scrolled').toBeGreaterThan(before.top);
  }
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath(name + '.json'), JSON.stringify({ before, after, field, viewport }, null, 2));
  await control.page().screenshot({ path: info.outputPath(name + '.png') });
}
async function tabToAction(page, action, container) {
  for (let count = 0; count < 40; count += 1) {
    await page.keyboard.press('Tab');
    expect(await container.evaluate(n => n.contains(n.ownerDocument.activeElement)), 'focus remains in form').toBe(true);
    if (await action.evaluate(n => n === n.ownerDocument.activeElement)) break;
  }
  await expect(action).toBeFocused();
  await expect(action).toBeInViewport({ ratio: 1 });
}

test('focused scroll narrow large form reachability', async ({ page }, info) => {
  await page.setViewportSize({ width: 920, height: 620 });
  await page.addInitScript({ path: fixture });
  await page.goto('http://127.0.0.1:' + (info.project.metadata.runtime === 'electron' ? 4173 : 4174) + '/');
  await page.getByRole('button', { name: '打开设置' }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByLabel('大字体', { exact: true }).setChecked(true);
  await settings.getByLabel('主题', { exact: true }).selectOption('dark');
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.locator('[name=endpoint-transport]').selectOption('modbus-tcp-master');
  await verifyScrollFocus(dialog.locator('input:not([type=checkbox]):not([type=radio]):enabled:visible, select:enabled:visible').last(), dialog.locator('.endpoint-dialog__body'), info, 'endpoint-last-control');
  await tabToAction(page, dialog.getByRole('button', { name: '保存端点', exact: true }), dialog);
  await page.screenshot({ path: info.outputPath('endpoint-footer-focused.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.locator('[name=endpoint-transport]').selectOption('opcua-server');
  await dialog.locator('[name=endpoint-name]').fill('滚动验证模拟器');
  await dialog.getByRole('button', { name: '保存端点', exact: true }).click();
  const panel = page.locator('.opcua-panel').filter({ visible: true });
  await panel.locator('[name=node-mode]').selectOption('increment');
  const scroller = panel.locator('.opcua-body');
  await scroller.evaluate(n => { n.scrollTop = 0; });
  const last = panel.locator('input:not([type=checkbox]):not([type=radio]):not([type=file]):enabled:visible, select:enabled:visible').last();
  await verifyScrollFocus(last, scroller, info, 'simulator-last-control');
  // This is a normal workbench, not a modal focus trap. Verify its bottom action directly.
  const apply = panel.getByRole('button', { name: '应用初始值', exact: true });
  await apply.scrollIntoViewIfNeeded();
  await apply.focus();
  await expect(apply).toBeFocused();
  await expect(apply).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('simulator-bottom-action-focused.png') });
});
