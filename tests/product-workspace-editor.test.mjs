import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyMonitor,registerPageLink} from '../src/link-monitor.js';
import {emptyPhysicalStock,applyStockCommand,validatePhysicalStock} from '../src/physical-stock.js';
import {emptySalesPlanning,applyPlanningCommand,validateSalesPlanning} from '../src/sales-planning.js';
import {emptyProductWatch,validateProductWatch,productOverview} from '../src/product-overview.js';
import {validateMonitorState,validateDraftItems} from '../src/storage-validation.js';
import {createProductLinkEditor} from '../src/product-link-editor.js';
import {createProductOverview} from '../src/product-overview.js';
import {collectProductAlerts} from '../src/product-alerts.js';
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

async function alarmFixture(){
 const f=fixture(),c=cmd('plan:'+f.planId,{workspace:{counts:{container:50,home:2},manualFbaQuantity:97},registration:{stock:true,merchant:false,yahoo:true,planning:true,yahooUrl:'https://auctions.yahoo.co.jp/jp/auction/h1248825083'}});
 await f.editor.save(c,options(f.read()));const d=f.read(),stockId=d['physical-stock'].state.products[0].id,linkId=d['link-monitor'].state.links[0].id;
 return {...f,stockId,linkId,keys:['stock:'+stockId,'link:'+linkId,'plan:'+f.planId],reg:c.registration};
}
const alarmRule=(key,n)=>({key,tags:[],replenishEnabled:false,threshold:10,minimumSales7:0,coverageDays:0,reviewDays:10,startedOn:'',note:'保存済みのメモ',...(n===undefined?{}:{lowStock:{source:'fba',threshold:n}})});
test('a general stock rule never hides the linked FBA threshold and all three editors read the same value',async()=>{
 const f=await alarmFixture();await f.transaction.update(d=>{d['product-watch'].state.rules.push({...alarmRule(f.keys[0]),tags:['heavy']},alarmRule(f.keys[1],8));});
 const before=f.read(),entries=(await f.editor.list()).entries;for(const key of f.keys)assert.equal(entries[key].live.alarmThreshold,8);
 await f.editor.save(cmd(f.keys[2],{registration:f.reg,workspace:{alarmThreshold:4}}),options(before));const after=f.read();
 for(const key of f.keys)assert.equal((await f.editor.list()).entries[key].live.alarmThreshold,4);
 assert.deepEqual(after['product-watch'].state.rules[0].tags,['heavy']);assert.equal(after['product-watch'].state.rules[0].note,'保存済みのメモ');
 assert.deepEqual(after['physical-stock'].state.balances,before['physical-stock'].state.balances);assert.deepEqual(after['link-monitor'].state.inventoryReviews,before['link-monitor'].state.inventoryReviews);
 assert.equal(after['product-watch'].state.lowStockHistory.length,2);
});
test('conflicting saved thresholds are visible in every editor and neither guessed alerts nor zero-stock fallback are sent',async()=>{
 const f=await alarmFixture();await f.transaction.update(d=>{for(const [i,k]of f.keys.entries())d['product-watch'].state.rules.push(alarmRule(k,[4,8,2][i]));});
 const entries=(await f.editor.list()).entries;for(const k of f.keys){assert.equal(entries[k].live.alarmThreshold,null);assert.equal(entries[k].live.sharedLowStock.conflict,true);}
 const d=f.read(),r=productOverview({monitor:d['link-monitor'].state,physical:d['physical-stock'].state,planning:d['sales-planning'].state,watch:d['product-watch'].state},at).find(r=>r.sourceKeys.includes(f.keys[0]));
 const mock={...r,fba:{status:'complete',quantity:0,sellerSku:'SKU',checkedAt:at}};assert.equal(collectProductAlerts(emptyProductWatch(),[mock],{stockAlerts:true},at).filter(a=>/low-stock:|fba-zero:/.test(a.key)).length,0);
 await f.editor.save(cmd(f.keys[2],{registration:f.reg,product:{memo:'メモだけ'}}),options(d));assert.deepEqual(f.read()['product-watch'],d['product-watch']);
 const before=f.read(),c=cmd(f.keys[1],{registration:f.reg,workspace:{alarmThreshold:5}});await f.editor.save(c,options(before));
 for(const k of f.keys){const e=(await f.editor.list()).entries[k];assert.equal(e.live.alarmThreshold,5);assert.equal(e.live.sharedLowStock.conflict,false);}
 const after=f.read();assert.equal(after['product-watch'].state.lowStockHistory.length,3);await f.editor.save(c,options(before));assert.deepEqual(f.read(),after);
});
test('clearing the shared threshold leaves no old linked threshold to reappear and preserves an unlinked same-ASIN stock setting',async()=>{
 const f=await alarmFixture(),other=randomUUID();await f.transaction.update(d=>{
  for(const k of f.keys)d['product-watch'].state.rules.push(alarmRule(k,8));
  applyStockCommand(d['physical-stock'].state,{operationId:randomUUID(),kind:'create',productId:other,product:{title:'同ASINだが未連携の現物',asin,sellerSku:'OTHER',condition:'used',unit:'個'},initialCounts:{container:3,home:0}},{actor,at});
  d['product-watch'].state.rules.push(alarmRule('stock:'+other,99));
 });
 await f.editor.save(cmd(f.keys[0],{registration:f.reg,workspace:{alarmThreshold:null}}),options(f.read()));const d=f.read();
 for(const k of f.keys){const e=(await f.editor.list()).entries[k];assert.equal(e.live.alarmThreshold,null);assert.equal(e.live.sharedLowStock.conflict,false);}
 assert.equal(d['product-watch'].state.rules.find(r=>r.key==='stock:'+other).lowStock.threshold,99);
 assert.equal(d['link-monitor'].state.inventoryReviews[0].manualFbaQuantity,97);
});
test('overview edits use the same threshold and an unrelated note edit cannot overwrite it; transaction replay is stable',async()=>{
 const f=await alarmFixture();await f.transaction.update(d=>{for(const k of f.keys)d['product-watch'].state.rules.push(alarmRule(k,8));});
 const read=k=>({read:async()=>f.read()[k].state,readSnapshot:async()=>f.read()[k]});
 const overview=createProductOverview({monitorStore:read('link-monitor'),stockStore:read('physical-stock'),planningStore:read('sales-planning'),draftStore:read('draft-items'),watchStore:read('product-watch'),ruleTransaction:f.transaction,now:()=>at});
 let view=await overview.view(),r=view.rows.find(r=>r.sourceKeys.includes(f.keys[0]));
 await overview.commit({operationId:randomUUID(),rule:{...r.rule,note:'監視メモの修正',lowStock:{source:'',threshold:null}},lowStockUpdate:false},{expectedRevision:view.revision,actor});
 for(const k of f.keys)assert.equal((await f.editor.list()).entries[k].live.alarmThreshold,8);
 view=await overview.view();r=view.rows.find(r=>r.sourceKeys.includes(f.keys[0]));const c={operationId:randomUUID(),rule:{...r.rule,lowStock:{source:'fba',threshold:9}},lowStockUpdate:true};
 await overview.commit(c,{expectedRevision:view.revision,actor});const after=f.read();for(const k of f.keys)assert.equal((await f.editor.list()).entries[k].live.alarmThreshold,9);
 await overview.commit(c,{expectedRevision:view.revision,actor});assert.deepEqual(f.read(),after);
 await assert.rejects(()=>overview.commit({...c,operationId:randomUUID()},{expectedRevision:view.revision,actor}),{status:409});assert.deepEqual(f.read(),after);
});
