import test from 'node:test';
import assert from 'node:assert/strict';
import {reorderDrafts,orderedDrafts} from '../src/draft-order.js';
import {boardItems,draftStage,draftHints} from '../public/draft-board.js';
import {splitDraftQueue} from '../src/queue.js';
import {createDraftCatalog} from '../src/draft-catalog.js';
import {createCloudHandler} from '../src/cloud-handler.js';
const asin='B000TEST01',photo='https://m.media-amazon.com/images/I/test.jpg',at='2026-11-10T04:00:00.000Z';
const item=(id,status='ready_for_draft')=>({asin:id,title:id,status,description:'手入力説明',imageUrls:[],startPrice:1000,usedLowestPrice:1250,createdAt:at,updatedAt:at});
function memory(initial){let state=structuredClone(initial),revision=0;return {read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision}={})=>{if(expectedRevision!==undefined&&expectedRevision!==revision)throw Object.assign(new Error('別の編集が保存されました'),{status:409});const copy=structuredClone(state),r=await fn(copy);state=copy;revision++;return r;}};}
test('the board shows all ready products beyond the old ten-slot queue and each saved product once beyond twenty history entries',()=>{
 const ready=Array.from({length:25},(_,i)=>item('R'+String(i).padStart(9,'0'))),saved=Array.from({length:25},(_,i)=>({...item('S'+String(i).padStart(9,'0'),'draft_saved'),draftSavedAt:at}));
 const all=[...ready,...saved,item('N000000001','waiting_for_product_data'),item('L000000001','listed')];
 assert.equal(splitDraftQueue(all).active.length,10);assert.equal(boardItems(all,'ready').length,25);assert.equal(boardItems(all,'input').length,25);assert.equal(boardItems(all,'saved').length,0);
 const pending=boardItems(all);assert.equal(pending.length,26);assert.equal(new Set(pending.map(p=>p.asin)).size,26);assert.ok(pending.every(i=>i.status!=='draft_saved'));
 assert.equal(draftStage(saved[0]),'input');assert.deepEqual(draftHints({...saved[0],title:'手入力タイトル',displayImageUrl:photo}),[]);
});
test('saved work order controls the next draft; filtered reorder keeps hidden positions and never edits product content or dates',()=>{
 const items=['A000000001','B000000001','C000000001','D000000001'].map(id=>item(id)),before=structuredClone(items);
 reorderDrafts(items,[items[3].asin,items[0].asin]);
 assert.deepEqual(orderedDrafts(items).map(p=>p.asin),['D000000001','B000000001','C000000001','A000000001']);
 assert.equal(splitDraftQueue(items).active[0].asin,'D000000001');
 for(let i=0;i<items.length;i++){const {workPriority,...rest}=items[i];assert.deepEqual(rest,before[i]);}
 const snapshot=structuredClone(items);reorderDrafts(items,['D000000001','A000000001']);assert.deepEqual(items,snapshot);
 for(const order of [[],['MISSING001'],['A000000001','A000000001']])assert.throws(()=>reorderDrafts(items,order));assert.deepEqual(items,snapshot);
});
test('ASIN catalog filling changes only missing title and photo, preserving price, handwritten text, status and saved timestamp',async()=>{
 const original={...item(asin,'draft_saved'),title:'手入力の商品名',draftSavedAt:at,stalePrice:800},store=memory([original]),service=createDraftCatalog({store,readCatalog:async a=>({asin:a,title:'Amazon標準名',imageUrl:photo}),now:()=>at});
 const result=await service.fill([asin],{expectedRevision:0}),actual=(await store.read())[0];
 assert.deepEqual(actual,{...original,imageUrls:[photo]});assert.equal(result.items[0].displayImageUrl,photo);
 const before=await store.readSnapshot();await service.fill([asin],{expectedRevision:before.revision});assert.deepEqual(await store.readSnapshot(),before);
});
test('cached Amazon photos are shown without writes; Yahoo actual-product photos and other ASINs are not substituted',async()=>{
 const store=memory([item(asin)]),before=await store.readSnapshot(),monitorStore=memory({amazonInventory:{items:[{asin,listingInfo:{title:'Amazon名',catalogImageUrl:photo}}]}}),service=createDraftCatalog({store,monitorStore,stockStore:memory({products:[{asin,imageSource:'manual',imageUrl:'https://auctions.c.yimg.jp/a.jpg'}]})});
 const view=await service.view();assert.equal(view.items[0].displayImageUrl,photo);assert.equal(view.items[0].displayTitle,'Amazon名');assert.deepEqual(await store.readSnapshot(),before);assert.deepEqual((await service.draftItem(asin)).imageUrls,[photo]);assert.equal((await service.draftItem(asin)).title,'Amazon名');assert.deepEqual(await store.readSnapshot(),before);
 const noMatch=createDraftCatalog({store,monitorStore:memory({amazonInventory:{items:[{asin:'B000OTHER1',listingInfo:{catalogImageUrl:photo}}]}}),readCatalog:async()=>({asin:'B000OTHER1',title:'別商品',imageUrl:photo})});
 const result=await noMatch.fill([asin],{expectedRevision:0});assert.equal(result.results[0].ok,false);assert.deepEqual(await store.readSnapshot(),before);
});
test('failed metadata lookup and stale save leave existing drafts intact; one batch is bounded to five registered ASINs',async()=>{
 const store=memory([item(asin)]),before=await store.readSnapshot(),service=createDraftCatalog({store,readCatalog:async()=>{throw new Error('private upstream diagnostic');}});
 const result=await service.fill([asin],{expectedRevision:0});assert.equal(result.results[0].ok,false);assert.doesNotMatch(JSON.stringify(result),/private upstream/);assert.deepEqual(await store.readSnapshot(),before);
 for(const ids of [[],[asin,asin],['B000OTHER1'],Array.from({length:6},(_,i)=>'B'+String(i).padStart(9,'0'))])await assert.rejects(()=>service.fill(ids,{expectedRevision:0}));
 const stale=createDraftCatalog({store,readCatalog:async a=>{await store.update(items=>{items[0].title='並行編集';});return{asin:a,title:'上書きしない',imageUrl:photo};}});
 await assert.rejects(()=>stale.fill([asin],{expectedRevision:0}),/別の編集/);assert.equal((await store.read())[0].title,'並行編集');assert.deepEqual((await store.read())[0].imageUrls,[]);
});
test('new work-order and catalog endpoints enforce owner, same origin, read-only, JSON and revision before calling services',async()=>{
 for(const readOnly of [false,true]){
  let calls=0;const store=memory([item(asin)]),origin='https://fixture.example',handler=createCloudHandler({config:{origin,authUrl:'https://fixture.invalid',readOnly},draftStore:store,draftCatalog:{fill:async()=>{calls++;return{};}},verifyOwner:async req=>({status:req.headers.has('authorization')?200:401,userId:'owner'})});
  for(const path of ['/api/drafts/order','/api/drafts/catalog']){
   const send=(headers={})=>handler(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({asins:[asin],order:[asin]})}));
   assert.equal((await send()).status,401);assert.equal((await send({Authorization:'fixture',Origin:'https://evil.example'})).status,403);assert.equal((await send({Authorization:'fixture'})).status,readOnly?403:428);assert.equal((await send({Authorization:'fixture','If-Match':'"0"','Content-Type':'text/plain'})).status,readOnly?403:415);
  }
  assert.equal(calls,0);
 }
});
