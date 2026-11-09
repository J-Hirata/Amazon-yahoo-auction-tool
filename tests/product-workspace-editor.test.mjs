import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyMonitor,registerPageLink} from '../src/link-monitor.js';
import {emptyPhysicalStock,applyStockCommand,validatePhysicalStock} from '../src/physical-stock.js';
import {emptySalesPlanning,applyPlanningCommand,validateSalesPlanning} from '../src/sales-planning.js';
import {emptyProductWatch,validateProductWatch,productOverview} from '../src/product-overview.js';
import {validateMonitorState,validateDraftItems} from '../src/storage-validation.js';
import {createProductLinkEditor} from '../src/product-link-editor.js';
const at='2026-11-10T04:00:00.000Z',actor='workspace-test',asin='B000TEST01';
function fixture(){
 let docs={'link-monitor':{state:emptyMonitor(),revision:0},'physical-stock':{state:emptyPhysicalStock(),revision:0},'sales-planning':{state:emptySalesPlanning(),revision:0},'product-watch':{state:emptyProductWatch(),revision:0},'draft-items':{state:[],revision:0}};
 const validators={'link-monitor':validateMonitorState,'physical-stock':validatePhysicalStock,'sales-planning':validateSalesPlanning,'product-watch':validateProductWatch,'draft-items':validateDraftItems};
 const transaction={read:async()=>structuredClone(docs),update:async fn=>{const copy=structuredClone(docs),r=await fn(copy);for(const [k,d]of Object.entries(copy)){validators[k](d.state);if(JSON.stringify(d.state)!==JSON.stringify(docs[k].state))d.revision++;}docs=copy;return r;}};
 const planId=randomUUID();applyPlanningCommand(docs['sales-planning'].state,{operationId:randomUUID(),kind:'create',planId,plan:{title:'監視から登録する商品',asin,sellerSku:'SKU',condition:'used',setContents:'ケーブル付き',source:{kind:'manual',id:''},kind:'amazon',status:'active',durationDays:10,availableOn:'2026-11-01',decisions:['advertising','yahoo'],note:'元の判断メモ'}},{actor,at});
 const editor=createProductLinkEditor({transaction,overview:{view:async()=>({rows:[]})}});
 return {editor,transaction,planId,read:()=>structuredClone(docs)};
}
function cmd(key,extra={}){return {operationId:randomUUID(),kind:'workspace',key,product:{},workspace:{},linkIds:[],registration:{stock:false,merchant:false,yahoo:false,planning:true,yahooUrl:''},...extra};}
function options(d){return {actor,at,confirmed:true,expectedRevision:d['link-monitor'].revision,sourceRevisions:Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v.revision]))};}
test('monitoring editor adds stock and Yahoo URL atomically while retaining the same plan, policy, dates and memo',async()=>{
 const f=fixture(),before=f.read(),plan=before['sales-planning'].state.plans[0],c=cmd('plan:'+f.planId,{workspace:{counts:{container:50,home:2},manualFbaQuantity:20,alarmThreshold:10,incoming:[{quantity:120,stage:'transit',expectedOn:'2026-11-17',reference:'FBA120'}]},registration:{stock:true,merchant:true,yahoo:true,planning:true,yahooUrl:'https://auctions.yahoo.co.jp/jp/auction/h1248825083'}});
 const p=await f.editor.preview(c,options(before));assert.ok(p.receipt.stockId);assert.deepEqual(f.read(),before);
 await f.editor.save(c,options(before));const d=f.read(),saved=d['sales-planning'].state.plans[0],stock=d['physical-stock'].state.products[0];
 assert.equal(d['sales-planning'].state.plans.length,1);for(const k of ['id','source','decisions','availableOn','durationDays','note','createdAt'])assert.deepEqual(saved[k],plan[k]);
 assert.equal(saved.workspaceStockId,stock.id);assert.deepEqual(d['physical-stock'].state.balances.map(b=>b.usable),[50,2]);assert.equal(stock.linkedLinkIds.length,1);assert.equal(d['product-watch'].state.rules[0].lowStock.threshold,10);assert.equal(d['link-monitor'].state.fbaIncoming[0].quantity,120);
 const entries=(await f.editor.list()).entries;assert.equal(entries[c.key].editor.stockId,stock.id);assert.equal(entries['link:'+stock.linkedLinkIds[0]].editor.stockId,stock.id);
 assert.equal((await f.editor.save(c,options(before))).replayed,true);assert.deepEqual(f.read(),d);
});
test('link editor adds stock and monitoring without duplicating either on subsequent edits',async()=>{
 const f=fixture();let link;await f.transaction.update(d=>{link=registerPageLink(d['link-monitor'].state,{amazon:'B000TEST02',yahoo:'https://auctions.yahoo.co.jp/jp/auction/h1248825084',submitted:true},at);});
 const c=cmd('link:'+link.id,{product:{title:'紐付けから登録',memo:'棚のメモ'},workspace:{counts:{container:20}},registration:{stock:true,merchant:true,yahoo:true,planning:true,yahooUrl:''}});
 await f.editor.save(c,options(f.read()));let d=f.read();assert.equal(d['physical-stock'].state.products.length,1);assert.equal(d['sales-planning'].state.plans.length,2);assert.equal(d['draft-items'].state.length,0);
 const baseline=structuredClone(d['physical-stock'].state.balances),second=cmd(c.key,{product:{memo:'メモのみ更新'},registration:c.registration});await f.editor.save(second,options(d));d=f.read();assert.equal(d['physical-stock'].state.products.length,1);assert.equal(d['sales-planning'].state.plans.length,2);assert.deepEqual(d['physical-stock'].state.balances,baseline);assert.equal(d['physical-stock'].state.products[0].memo,'メモのみ更新');
});
test('monitoring can edit FBA alarm and incoming without creating physical inventory',async()=>{
 const f=fixture(),c=cmd('plan:'+f.planId,{workspace:{manualFbaQuantity:78,alarmThreshold:20,incoming:[{quantity:120,stage:'packing',expectedOn:'',reference:''}]}});
 await f.editor.save(c,options(f.read()));const d=f.read();assert.equal(d['physical-stock'].state.products.length,0);assert.equal(d['link-monitor'].state.inventoryReviews[0].key,c.key);assert.equal(d['product-watch'].state.rules[0].key,c.key);assert.equal(d['link-monitor'].state.fbaIncoming[0].quantity,120);
});
test('all changes roll back on invalid inbound date, mismatched existing stock or concurrent edit',async()=>{
 for(const kind of ['date','mismatch','conflict']){
  const f=fixture();let stockId;
  if(kind==='mismatch')await f.transaction.update(d=>{stockId=randomUUID();applyStockCommand(d['physical-stock'].state,{operationId:randomUUID(),kind:'create',productId:stockId,product:{title:'異なるSKU',asin,sellerSku:'OTHER',condition:'used',unit:'個'},initialCounts:{container:null,home:null}},{actor,at});});
  const c=cmd('plan:'+f.planId,{stockId,product:{title:'保存してはいけない'},registration:{stock:true,merchant:true,yahoo:true,planning:true,yahooUrl:'https://auctions.yahoo.co.jp/jp/auction/h1248825085'},workspace:kind==='date'?{incoming:[{quantity:1,stage:'transit',expectedOn:'2026-02-31',reference:''}]}:{}}),o=options(f.read());
  if(kind==='conflict')await f.transaction.update(d=>{d['product-watch'].state.rules.push({key:'plan:'+f.planId,tags:['watch']});});
  const before=f.read();await assert.rejects(()=>f.editor.save(c,o));assert.deepEqual(f.read(),before);
 }
});
test('matching existing stock requires explicit selection and reuses quantities without resetting',async()=>{
 const f=fixture(),stockId=randomUUID();await f.transaction.update(d=>applyStockCommand(d['physical-stock'].state,{operationId:randomUUID(),kind:'create',productId:stockId,product:{title:'既存の現物',asin,sellerSku:'SKU',condition:'used',unit:'台',setContents:'ケーブル付き'},initialCounts:{container:30,home:5}},{actor,at}));
 const c=cmd('plan:'+f.planId,{registration:{stock:true,merchant:false,yahoo:false,planning:true,yahooUrl:''}}),before=f.read();
 await assert.rejects(()=>f.editor.save(c,options(before)),/登録済みの在庫/);assert.deepEqual(f.read(),before);
 await f.editor.save({...c,stockId},options(before));const d=f.read();assert.equal(d['physical-stock'].state.products.length,1);assert.deepEqual(d['physical-stock'].state.balances,before['physical-stock'].state.balances);assert.equal(d['sales-planning'].state.plans[0].workspaceStockId,stockId);for(const k of ['title','memo','unit','catalogTask','fbaEligibility','setContents'])assert.equal(d['physical-stock'].state.products[0][k],before['physical-stock'].state.products[0][k]);
});
test('monitor-only merchant use and a long existing note persist without manufacturing physical stock',async()=>{
 const f=fixture(),note='監視の判断メモ。'.repeat(75);
 await f.transaction.update(d=>{d['sales-planning'].state.plans[0].note=note;});
 const c=cmd('plan:'+f.planId,{product:{fbaEligibility:'possible'},registration:{stock:false,merchant:true,yahoo:false,planning:true,yahooUrl:''},workspace:{alarmThreshold:10}});
 await f.editor.save(c,options(f.read()));const d=f.read(),entry=(await f.editor.list()).entries[c.key];
 assert.equal(d['physical-stock'].state.products.length,0);assert.equal(d['sales-planning'].state.plans[0].note,note);assert.equal(entry.editor.product.fbaEligibility,'possible');assert.deepEqual(entry.editor.product.useChannels,['merchant']);
});
test('editing only a note from a linked product preserves an existing baseline and location count timestamps',async()=>{
 const f=fixture();let link;await f.transaction.update(d=>{link=registerPageLink(d['link-monitor'].state,{amazon:'B000TEST03',yahoo:'https://auctions.yahoo.co.jp/jp/auction/h1248825086',submitted:true},at);});
 const key='link:'+link.id,r={stock:true,merchant:false,yahoo:true,planning:true,yahooUrl:''};await f.editor.save(cmd(key,{registration:r,workspace:{manualFbaQuantity:97,counts:{container:150}}}),options(f.read()));
 const before=f.read();await f.editor.save(cmd(key,{registration:r,product:{memo:'メモの修正'}}),options(before));const after=f.read();
 assert.deepEqual(after['link-monitor'].state.inventoryReviews,before['link-monitor'].state.inventoryReviews);assert.deepEqual(after['physical-stock'].state.balances,before['physical-stock'].state.balances);
});
