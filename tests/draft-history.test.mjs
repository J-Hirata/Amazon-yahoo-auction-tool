import test from 'node:test';
import assert from 'node:assert/strict';
import {patchDraft,batchDraftAction} from '../src/cloud-drafts.js';
import {boardItems,draftHistory,draftEventLabel} from '../public/draft-board.js';
import {splitDraftQueue} from '../src/queue.js';
import {createCloudHandler} from '../src/cloud-handler.js';
const old='2026-10-20T01:02:03.000Z',now='2026-11-10T01:02:03.000Z',later='2026-11-11T01:02:03.000Z';
const item=(asin='B000TEST01',status='draft_saved')=>({asin,status,title:'手入力の商品名',description:'手入力の状態・付属品・説明',imageUrls:['https://m.media-amazon.com/images/I/original.jpg'],usedLowestPrice:5000,startPrice:4000,stalePrice:4250,draftSavedAt:old,createdAt:old,updatedAt:old,workPriority:17,sku:'元のSKU',notes:'自由なメモ'});
const content=i=>Object.fromEntries(['asin','title','description','imageUrls','usedLowestPrice','startPrice','stalePrice','draftSavedAt','listedAt','soldAt','createdAt','workPriority','sku','notes'].filter(k=>Object.hasOwn(i,k)).map(k=>[k,i[k]]));

test('legacy saved records keep all content and are excluded from preparation without changing stored data',()=>{
 const records=[item(),item('B000TEST02','ready_for_draft'),item('B000TEST03','waiting_for_product_data')],before=structuredClone(records);
 assert.deepEqual(boardItems(records).map(i=>i.asin),['B000TEST02','B000TEST03']);assert.equal(splitDraftQueue(records).active[0].asin,'B000TEST02');
 assert.equal(boardItems(records,'saved').length,0);assert.equal(boardItems(records,'input').length,1);assert.deepEqual(records,before);
 const events=draftHistory(records[0]);assert.deepEqual(events,[{at:old,to:'draft_saved',kind:'status',source:'legacy'}]);assert.match(draftEventLabel(events[0]),/貼り付け完了.*保存未照合/);
});

test('archive and restore return ready, incomplete, saved, listed and sold items to their exact prior state',()=>{
 for(const status of ['ready_for_draft','waiting_for_product_data','input_done','draft_saved','listed','sold']){
  const original={...item('B000TEST01',status),listedAt:old,soldAt:old},records=[structuredClone(original)];
  patchDraft(records,original.asin,{status:'archived'},now);assert.equal(records[0].status,'archived');assert.equal(records[0].archivedFromStatus,status);assert.deepEqual(content(records[0]),content(original));
  const archived=structuredClone(records);patchDraft(records,original.asin,{status:'archived'},later);assert.deepEqual(records,archived);
  patchDraft(records,original.asin,{restore:true},later);assert.equal(records[0].status,status);assert.deepEqual(content(records[0]),content(original));
  assert.ok(draftHistory(records[0]).some(e=>e.at===old&&e.to==='draft_saved'));assert.ok(draftHistory(records[0]).some(e=>e.kind==='restore'&&e.to===status));
 }
});

test('form input and legacy paste records are never treated as confirmed Yahoo draft saves',()=>{
 const records=[item('B000TEST01','ready_for_draft'),item('B000TEST02')];
 patchDraft(records,'B000TEST01',{status:'input_done'},now);assert.equal(boardItems(records,'input').length,2);assert.equal(boardItems(records,'saved').length,0);assert.equal(splitDraftQueue(records).active.length,0);assert.equal(records[0].draftSaveConfirmedAt,undefined);
 patchDraft(records,'B000TEST01',{status:'draft_saved',saveConfirmed:true},later);assert.equal(boardItems(records,'saved').length,1);assert.equal(records[0].draftSaveConfirmedAt,later);
 patchDraft(records,'B000TEST02',{status:'draft_saved',saveConfirmed:true},later);assert.equal(boardItems(records,'saved').length,2);assert.equal(records[1].draftSaveConfirmedAt,later);
 const history=draftHistory(records[1]);assert.ok(history.some(e=>e.at===old&&/貼り付け完了/.test(draftEventLabel(e))));assert.ok(history.some(e=>e.at===later&&/下書き保存済み/.test(draftEventLabel(e))));
});

test('an old extension cannot confirm a pasted form or undo a saved, listed or archived product',()=>{
 const records=[item('B000TEST01','ready_for_draft'),item('B000TEST02'),{...item('B000TEST03'),draftSaveConfirmedAt:old},item('B000TEST04','listed'),item('B000TEST05','archived')],before=structuredClone(records);
 patchDraft(records,'B000TEST01',{status:'draft_saved'},now);assert.equal(records[0].status,'input_done');assert.equal(records[0].draftSaveConfirmedAt,undefined);
 for(const i of records.slice(1))patchDraft(records,i.asin,{status:'draft_saved'},now);
 assert.deepEqual(records.slice(1),before.slice(1));assert.equal(boardItems(records,'saved').length,1);
 for(const patch of [{saveConfirmed:true},{status:'input_done',saveConfirmed:true},{status:'draft_saved',saveConfirmed:false}])assert.throws(()=>patchDraft(records,'B000TEST01',patch,now));
});

test('returning a saved draft to preparation preserves old timestamps even with the legacy clear-timestamp request',()=>{
 const records=[item()],before=content(records[0]);patchDraft(records,records[0].asin,{status:'ready_for_draft',draftSavedAt:null},now);
 assert.deepEqual(content(records[0]),before);assert.equal(records[0].status,'ready_for_draft');assert.equal(boardItems(records,'saved').length,0);assert.equal(boardItems(records,'history').length,1);
 patchDraft(records,records[0].asin,{status:'draft_saved',saveConfirmed:true},later);const events=draftHistory(records[0]);
 assert.equal(records[0].draftSavedAt,later);assert.equal(events.filter(e=>e.to==='draft_saved').length,2);assert.ok(events.some(e=>e.at===old));
 const snapshot=structuredClone(records);patchDraft(records,records[0].asin,{status:'draft_saved',saveConfirmed:true},'2026-11-12T01:00:00Z');assert.deepEqual(records,snapshot);
});

test('batch archive affects only selected products and rejects a bad restore atomically',()=>{
 const records=[item(),item('B000TEST02','listed'),item('B000TEST03','ready_for_draft')],before=structuredClone(records);
 batchDraftAction(records,{asins:['B000TEST01','B000TEST02'],action:'archive'},now);assert.deepEqual(records[2],before[2]);assert.equal(records.length,3);
 const archived=structuredClone(records);assert.throws(()=>batchDraftAction(records,{asins:['B000TEST01','B000TEST03'],action:'restore'},later));assert.deepEqual(records,archived);
 for(const input of [{asins:[],action:'archive'},{asins:['B000TEST01','B000TEST01'],action:'archive'},{asins:['B000OTHER1'],action:'archive'},{asins:['B000TEST01'],action:'delete'}]){assert.throws(()=>batchDraftAction(records,input,later));assert.deepEqual(records,archived);}
 batchDraftAction(records,{asins:['B000TEST01','B000TEST02'],action:'restore'},later);for(let i=0;i<3;i++){assert.equal(records[i].status,before[i].status);assert.deepEqual(content(records[i]),content(before[i]));}
});

test('archive without old status falls back to incomplete preparation and never fabricates a saved or listing date',()=>{
 const records=[{asin:'B000TEST01',status:'archived'}];patchDraft(records,'B000TEST01',{restore:true},now);assert.equal(records[0].status,'waiting_for_product_data');assert.equal(records[0].draftSavedAt,undefined);assert.equal(records[0].listedAt,undefined);
 assert.equal(draftHistory({asin:'B000TEST02',status:'listed'}).length,0);
 for(const patch of [{restore:true,status:'listed'},{restore:false},{draftSavedAt:later},{archivedFromStatus:'listed'},{workHistory:[]}])assert.throws(()=>patchDraft(records,'B000TEST01',patch,later));
});

test('unrelated text or status edits preserve both auction prices and all original content',()=>{
 const records=[item()],before=content(records[0]);patchDraft(records,'B000TEST01',{title:'変更した商品名'},now);assert.deepEqual(content(records[0]),{...before,title:'変更した商品名'});
 patchDraft(records,'B000TEST01',{status:'listed'},later);assert.equal(records[0].startPrice,4000);assert.equal(records[0].stalePrice,4250);assert.equal(records[0].description,before.description);assert.equal(records[0].draftSavedAt,old);
});

test('archive route enforces owner, origin, readonly, JSON and optimistic revision without partial writes',async()=>{
 for(const readOnly of [false,true]){
  let records=[item(),item('B000TEST02')],revision=0,writes=0;
  const store={read:async()=>structuredClone(records),readSnapshot:async()=>({state:structuredClone(records),revision}),update:async(fn,{expectedRevision})=>{if(expectedRevision!==revision)throw Object.assign(new Error('conflict'),{code:'STORAGE_CONFLICT'});const next=structuredClone(records);await fn(next);records=next;revision++;writes++;}};
  const origin='https://fixture.example',handler=createCloudHandler({config:{origin,authUrl:'https://fixture.invalid',readOnly},draftStore:store,verifyOwner:async req=>({status:req.headers.has('authorization')?200:401,userId:'owner'})});
  const send=(headers={},body={asins:['B000TEST01'],action:'archive'})=>handler(new Request(origin+'/api/drafts/actions',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}));
  assert.equal((await send()).status,401);assert.equal((await send({Authorization:'fixture',Origin:'https://evil.example'})).status,403);
  assert.equal((await send({Authorization:'fixture'})).status,readOnly?403:428);assert.equal((await send({Authorization:'fixture','If-Match':'"0"','Content-Type':'text/plain'})).status,readOnly?403:415);assert.equal(writes,0);
  if(readOnly)continue;
  assert.equal((await send({Authorization:'fixture','If-Match':'"0"'})).status,200);assert.equal(writes,1);assert.equal(records[0].status,'archived');assert.equal(records[1].status,'draft_saved');
  const snapshot=structuredClone(records);assert.equal((await send({Authorization:'fixture','If-Match':'"0"'})).status,409);assert.equal(writes,1);assert.deepEqual(records,snapshot);
 }
});
