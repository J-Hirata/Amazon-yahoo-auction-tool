import {emptyProductWatch,validateProductWatch} from '../src/product-overview.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyMonitor,registerPageLink} from '../src/link-monitor.js';
import {emptyPhysicalStock,applyStockCommand,validatePhysicalStock} from '../src/physical-stock.js';
import {emptySalesPlanning,validateSalesPlanning} from '../src/sales-planning.js';
import {validateMonitorState,validateDraftItems} from '../src/storage-validation.js';
import {createCloudStock} from '../src/cloud-stock.js';
import {addDrafts} from '../src/cloud-drafts.js';
const at='2026-11-10T02:00:00.000Z',actor='registration-test',asin='B000TEST01';
function fixture(){
 let docs={'physical-stock':{state:emptyPhysicalStock(),revision:0},'link-monitor':{state:emptyMonitor(),revision:0},'sales-planning':{state:emptySalesPlanning(),revision:0},'draft-items':{state:[],revision:0},'product-watch':{state:emptyProductWatch(),revision:0}};
 const validators={'physical-stock':validatePhysicalStock,'link-monitor':validateMonitorState,'sales-planning':validateSalesPlanning,'draft-items':validateDraftItems,'product-watch':validateProductWatch};
 const transaction={read:async()=>structuredClone(docs),update:async fn=>{const copy=structuredClone(docs),r=await fn(copy);for(const k of Object.keys(copy)){validators[k](copy[k].state);if(JSON.stringify(copy[k].state)!==JSON.stringify(docs[k].state))copy[k].revision++;}docs=copy;return r;}};
 const store=key=>({read:async()=>structuredClone(docs[key].state),readSnapshot:async()=>structuredClone(docs[key]),update:async(fn,{expectedRevision}={})=>transaction.update(d=>{if(expectedRevision!==undefined&&d[key].revision!==expectedRevision)throw new Error('conflict');return fn(d[key].state);})});
 const stock=createCloudStock({store:store('physical-stock'),monitorStore:store('link-monitor'),draftStore:store('draft-items'),watchStore:store('product-watch'),registrationTransaction:transaction,now:()=>at});
 return {stock,transaction,read:()=>structuredClone(docs)};
}
function command(registration={merchant:true,yahoo:true,planning:true,yahooUrl:''}){
 return {operationId:randomUUID(),kind:'create',productId:randomUUID(),product:{title:'補充と併売のテスト商品',asin,condition:'used',unit:'個',sellerSku:'TEST-SKU',setContents:'ケーブル付き',memo:'現物メモ',fbaEligibility:'possible',linkedLinkIds:[]},initialCounts:{container:50,home:null},registration};
}
async function save(f,c){const p=await f.stock.preview(c,{expectedRevision:0,actor});return f.stock.commit(c,{expectedRevision:p.revision,sourceRevisions:p.sourceRevisions,actor,confirmed:true});}
test('one confirmation atomically registers physical inventory, draft preparation and a stock-linked monitoring plan; replay never duplicates',async()=>{
 const f=fixture(),c=command(),before=f.read(),p=await f.stock.preview(c,{expectedRevision:0,actor});
 assert.deepEqual(f.read(),before);assert.equal(p.receipt.registrationSummary.length,3);
 const options={expectedRevision:p.revision,sourceRevisions:p.sourceRevisions,actor,confirmed:true};
 await f.stock.commit(c,options);const after=f.read(),product=after['physical-stock'].state.products[0],plan=after['sales-planning'].state.plans[0];
 assert.deepEqual(product.useChannels,['merchant','yahoo']);assert.equal(product.fbaEligibility,'possible');assert.equal(after['physical-stock'].state.balances[0].usable,50);assert.equal(after['physical-stock'].state.balances[1].usable,null);
 assert.equal(after['draft-items'].state[0].title,c.product.title);assert.equal(after['draft-items'].state[0].status,'waiting_for_product_data');
 assert.deepEqual(plan.source,{kind:'stock',id:product.id});assert.equal(plan.availableOn,'');assert.equal(plan.durationDays,10);assert.equal(plan.note,'現物メモ');
 assert.equal(after['link-monitor'].revision,0);
 const repeat=await f.stock.commit(c,options);assert.equal(repeat.receipt.replayed,true);assert.deepEqual(f.read(),after);
 await assert.rejects(()=>f.stock.commit({...c,product:{...c.product,memo:'違う内容'}},options),/操作ID/);
});
test('an existing draft remains byte-identical including saved status and handwritten fields',async()=>{
 const f=fixture();await f.transaction.update(async d=>{await addDrafts(d['draft-items'].state,asin,at);Object.assign(d['draft-items'].state[0],{title:'手入力タイトル',description:'手書き説明',status:'draft_saved',draftSavedAt:at});});
 const old=f.read()['draft-items'];await save(f,command());const current=f.read()['draft-items'].state[0];for(const key of Object.keys(old.state[0]))assert.deepEqual(current[key],old.state[0][key]);assert.ok(current.workspaceStockId);
});
test('a changed registration destination rejects the whole save without partial stock creation',async()=>{
 const f=fixture(),c=command(),p=await f.stock.preview(c,{expectedRevision:0,actor});
 await f.transaction.update(async d=>addDrafts(d['draft-items'].state,'B000TEST02',at));
 const before=f.read();await assert.rejects(()=>f.stock.commit(c,{expectedRevision:0,sourceRevisions:p.sourceRevisions,actor,confirmed:true}),/更新/);assert.deepEqual(f.read(),before);
});
test('invalid Yahoo URL, missing ASIN and conflicting link identity roll back all destinations',async()=>{
 for(const r of [{merchant:true,yahoo:true,planning:true,yahooUrl:'https://evil.example/item'}, {merchant:false,yahoo:true,planning:false,yahooUrl:''}]){
  const f=fixture(),c=command(r);if(!r.yahooUrl)c.product.asin='';const before=f.read();await assert.rejects(()=>save(f,c));assert.deepEqual(f.read(),before);
 }
 const f=fixture();await f.transaction.update(d=>registerPageLink(d['link-monitor'].state,{amazon:'B000OTHER1',yahoo:'https://auctions.yahoo.co.jp/jp/auction/d1000000001',submitted:true},at));const before=f.read();
 await assert.rejects(()=>save(f,command({merchant:true,yahoo:true,planning:true,yahooUrl:'https://auctions.yahoo.co.jp/jp/auction/d1000000001'})));assert.deepEqual(f.read(),before);
});
test('an entered Yahoo URL links the same stock without publishing, inventing quantities, or creating an extra draft',async()=>{
 const f=fixture(),c=command({merchant:false,yahoo:true,planning:false,yahooUrl:'https://auctions.yahoo.co.jp/jp/auction/d1000000001'});const original=structuredClone(c);await save(f,c);assert.deepEqual(c,original);const d=f.read(),link=d['link-monitor'].state.links[0];
 assert.deepEqual(d['physical-stock'].state.products[0].linkedLinkIds,[link.id]);assert.equal(d['draft-items'].state.length,0);assert.equal(d['sales-planning'].state.plans.length,0);assert.equal(d['link-monitor'].state.listings[0].observation.status,'unknown');
});
test('legacy product edits retain selected uses and do not change counts or monitoring plans',async()=>{
 const f=fixture(),c=command();await save(f,c);const d=f.read(),stock=d['physical-stock'].state,p=stock.products[0],{useChannels,...legacy}=p,before=structuredClone(stock.balances);
 applyStockCommand(stock,{operationId:randomUUID(),kind:'edit',productId:p.id,product:{...legacy,memo:'更新'}},{actor,at});
 assert.deepEqual(p.useChannels,useChannels);assert.deepEqual(stock.balances,before);
});

 test('existing inventory can add draft and monitoring in one edit without changing any physical counts; repeated edits do not duplicate',async()=>{
 const f=fixture(),c=command({merchant:true,yahoo:false,planning:false,yahooUrl:''});await save(f,c);const before=f.read()['physical-stock'].state.balances,product=f.read()['physical-stock'].state.products[0];
 for(let i=0;i<2;i++){const edit={operationId:randomUUID(),kind:'edit',productId:product.id,product:{...product,memo:'メモを保持'},registration:{merchant:false,yahoo:true,planning:true,yahooUrl:''}};const revision=f.read()['physical-stock'].revision,p=await f.stock.preview(edit,{expectedRevision:revision,actor});await f.stock.commit(edit,{expectedRevision:revision,sourceRevisions:p.sourceRevisions,actor,confirmed:true});}
 const after=f.read();assert.deepEqual(after['physical-stock'].state.balances,before);assert.equal(after['draft-items'].state.length,1);assert.equal(after['sales-planning'].state.plans.length,1);assert.deepEqual(after['physical-stock'].state.products[0].useChannels,['merchant','yahoo']);
 });

test('one stock editor save commits metadata, both quantities, FBA baseline, alarm and shipment atomically and replay never repeats',async()=>{
 const f=fixture(),c=command({merchant:false,yahoo:false,planning:false,yahooUrl:''});await save(f,c);let d=f.read();const product=d['physical-stock'].state.products[0],edit={operationId:randomUUID(),kind:'edit',productId:product.id,product:{...product,memo:'まとめて編集'},workspace:{counts:{container:40,home:2},manualFbaQuantity:78,alarmThreshold:10,incoming:[{quantity:120,sellerSku:product.sellerSku,stage:'transit',expectedOn:'2026-11-17',reference:'FBA123'}]}};
 const p=await f.stock.preview(edit,{actor,expectedRevision:d['physical-stock'].revision});assert.deepEqual(f.read(),d);const options={actor,expectedRevision:p.revision,sourceRevisions:p.sourceRevisions,confirmed:true};await f.stock.commit(edit,options);d=f.read();assert.equal(d['physical-stock'].state.products[0].memo,'まとめて編集');assert.deepEqual(d['physical-stock'].state.balances.map(b=>b.usable),[40,2]);assert.equal(d['link-monitor'].state.inventoryReviews[0].manualFbaQuantity,78);assert.equal(d['link-monitor'].state.fbaIncoming[0].quantity,120);assert.equal(d['product-watch'].state.rules[0].lowStock.threshold,10);assert.equal((await f.stock.commit(edit,options)).receipt.replayed,true);assert.deepEqual(f.read(),d);
});
test('stale alarm revision or invalid incoming data rolls back the entire unified product edit',async()=>{
 for(const invalid of [false,true]){const f=fixture(),c=command({merchant:false,yahoo:false,planning:false,yahooUrl:''});await save(f,c);const d=f.read(),product=d['physical-stock'].state.products[0],edit={operationId:randomUUID(),kind:'edit',productId:product.id,product:{...product,memo:'保存してはいけない'},workspace:{counts:{container:0},manualFbaQuantity:1,alarmThreshold:0,...(invalid?{incoming:[{quantity:120,stage:'transit',expectedOn:'2026-02-31',reference:''}]}:{})}};
 if(invalid){await assert.rejects(()=>f.stock.preview(edit,{actor,expectedRevision:d['physical-stock'].revision}),/予定日/);assert.deepEqual(f.read(),d);}
 else{const p=await f.stock.preview(edit,{actor,expectedRevision:d['physical-stock'].revision});await f.transaction.update(d=>d['product-watch'].state.rules.push({key:'stock:'+product.id,tags:['watch']}));const before=f.read();await assert.rejects(()=>f.stock.commit(edit,{actor,expectedRevision:p.revision,sourceRevisions:p.sourceRevisions,confirmed:true}),/更新/);assert.deepEqual(f.read(),before);}}
});
test('unchanged FBA baseline and incoming plans keep their timestamps when only the memo or location quantity changes',async()=>{
 const f=fixture(),c=command({merchant:false,yahoo:false,planning:false,yahooUrl:''});c.workspace={manualFbaQuantity:97,incoming:[{quantity:120,stage:'packing',expectedOn:'',reference:''}]};await save(f,c);const d=f.read(),m=structuredClone(d['link-monitor'].state),product=d['physical-stock'].state.products[0],edit={operationId:randomUUID(),kind:'edit',productId:product.id,product:{...product,memo:'メモのみ'},workspace:{counts:{home:1}}};const p=await f.stock.preview(edit,{actor,expectedRevision:d['physical-stock'].revision});await f.stock.commit(edit,{actor,expectedRevision:p.revision,sourceRevisions:p.sourceRevisions,confirmed:true});assert.deepEqual(f.read()['link-monitor'].state,m);
});
test('choosing a registered Yahoo link reuses its listing URL without a manual URL or a duplicate draft',async()=>{const f=fixture();let link;await f.transaction.update(d=>{link=registerPageLink(d['link-monitor'].state,{amazon:asin,yahoo:'https://auctions.yahoo.co.jp/jp/auction/h1248825083',submitted:true},at);});const c=command({merchant:false,yahoo:true,planning:false,yahooUrl:''});c.product.linkedLinkIds=[link.id];const result=await save(f,c),d=f.read();assert.equal(d['draft-items'].state.length,0);assert.equal(d['link-monitor'].state.links.length,1);assert.deepEqual(d['physical-stock'].state.products[0].linkedLinkIds,[link.id]);assert.deepEqual(result.receipt.yahooUrls,['https://auctions.yahoo.co.jp/jp/auction/h1248825083']);});
test('the stock API accepts a complete pasted ASIN and never shortens an incomplete ASIN to save it',async()=>{const f=fixture(),c=command({merchant:false,yahoo:false,planning:false,yahooUrl:''});c.product.asin='　Ｂ０Ｂ８ＸＹ１Ｑ７Ｖ　';await save(f,c);assert.equal(f.read()['physical-stock'].state.products[0].asin,'B0B8XY1Q7V');const bad=command({merchant:false,yahoo:false,planning:false,yahooUrl:''});bad.product.asin='B0B8XY1Q7';const before=f.read();await assert.rejects(()=>f.stock.preview(bad,{expectedRevision:before['physical-stock'].revision,actor}),/現在9文字/);assert.deepEqual(f.read(),before);});
