import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {mkdtemp,mkdir} from 'node:fs/promises';import path from 'node:path';
test('local draft UI assets, non-destructive duplicate entry and saved priority work without touching business files',async()=>{
 const output=path.resolve('output');await mkdir(output,{recursive:true});const directory=await mkdtemp(path.join(output,'draft-local-test-'));
 const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:'0',ASIN_STORAGE_BACKEND:'json',ASIN_BIND_HOST:'127.0.0.1',ASIN_DATA_DIR:directory,LINK_MONITOR_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
 let base;try{
  base=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('local server timeout')),15000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timeout);resolve('http://127.0.0.1:'+match[1]);}});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('local server stopped'));});});
  const send=async(url,data,method='POST')=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200);return r.json();};
  for(const name of ['app.js','draft-board.js','draft-workbench.css','catalog-view.js','catalog-sortable.js','tile-size.js'])assert.equal((await fetch(base+'/'+name)).status,200);
  const ids=['B000TEST01','B000TEST02'];await send('/api/asins',{asins:ids.join('\n')});
  await send('/api/items/'+ids[0],{title:'手入力名',description:'手入力説明',usedLowestPrice:5000,status:'ready_for_draft'},'PATCH');
  const first=(await (await fetch(base+'/api/items')).json()).items[0];await send('/api/asins',{asins:ids[0]});const after=(await (await fetch(base+'/api/items')).json()).items.find(i=>i.asin===ids[0]);assert.deepEqual(after,first);
  await send('/api/items/'+ids[1],{status:'ready_for_draft'},'PATCH');await send('/api/drafts/order',{order:[ids[1],ids[0]]});assert.equal((await (await fetch(base+'/api/next-draft')).json()).item.asin,ids[1]);
 }finally{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}
});
