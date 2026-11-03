import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {emptyMonitor,registerPageLink} from '../src/link-monitor.js';import {emptyPhysicalStock,applyStockCommand,validatePhysicalStock} from '../src/physical-stock.js';import {emptySalesPlanning,applyPlanningCommand,validateSalesPlanning} from '../src/sales-planning.js';import {applyProductLinkEdit,productLinkInfo} from '../src/product-link-editor.js';import {createDocumentTransaction} from '../src/postgres-document-store.js';import {validateMonitorState} from '../src/storage-validation.js';import {createCloudHandler} from '../src/cloud-handler.js';
import {createProductMonitoring} from '../src/product-monitoring.js';import {emptyProductWatch} from '../src/product-overview.js';import {productChannels} from '../src/product-channels.js';
const at='2026-11-02T08:00:00Z',actor='fixture',asin='B000TEST01',url='https://page.auctions.yahoo.co.jp/jp/auction/d1000000002';
export function linkFixture(){const m=emptyMonitor(),s=emptyPhysicalStock(),p=emptySalesPlanning(),link=registerPageLink(m,{amazon:asin,yahoo:'https://auctions.yahoo.co.jp/jp/auction/d1000000001',submitted:true},at),stockId=randomUUID(),planId=randomUUID();
 applyStockCommand(s,{operationId:randomUUID(),kind:'create',productId:stockId,product:{asin,title:'隔離テスト・モニター',condition:'used',unit:'台',linkedLinkIds:[link.id]},initialCounts:{container:50,home:1}},{actor,at});
 applyPlanningCommand(p,{operationId:randomUUID(),kind:'create',planId,plan:{title:'隔離テスト・見直し',asin,condition:'used',source:{kind:'manual',id:''},kind:'amazon',status:'active',durationDays:10,availableOn:'2026-11-01',decisions:['yahoo'],note:'保持するメモ'}},{actor,at});
 return {docs:{'link-monitor':{state:m,revision:4},'physical-stock':{state:s,revision:2},'sales-planning':{state:p,revision:1}},stockId,planId,link};}
function edit(f,key,extra={}){const command={operationId:randomUUID(),key,amazon:asin,yahoo:url,replaceLinkId:'',...extra},options={actor,at,expectedRevision:4,sourceRevisions:Object.fromEntries(Object.entries(f.docs).map(([k,d])=>[k,d.revision]))};return {command,options};}
test('stock URL registration preserves quantities, product ID, and existing associations',()=>{const f=linkFixture(),before=structuredClone(f.docs['physical-stock'].state),e=edit(f,'stock:'+f.stockId);const r=applyProductLinkEdit(f.docs,e.command,e.options);assert.equal(f.docs['physical-stock'].state.products[0].id,f.stockId);assert.deepEqual(f.docs['physical-stock'].state.balances,before.balances);assert.equal(f.docs['physical-stock'].state.products[0].linkedLinkIds.length,2);assert.ok(productLinkInfo(f.docs,e.command.key).yahoo.some(y=>y.linkId===r.linkId));});
test('replacing an ended URL preserves the link ID, stock relationship, memo and old listing evidence',()=>{const f=linkFixture();f.link.userMemo='本人のメモ';f.docs['link-monitor'].state.listings[0].title='元の商品名';const e=edit(f,'link:'+f.link.id,{replaceLinkId:f.link.id});applyProductLinkEdit(f.docs,e.command,e.options);const m=f.docs['link-monitor'].state;assert.equal(m.links.length,1);assert.equal(m.links[0].id,f.link.id);assert.equal(m.links[0].listingId,'d1000000002');assert.equal(m.links[0].userMemo,'本人のメモ');assert.equal(m.links[0].previousListingTitle,'元の商品名');assert.equal(m.listings.length,2);assert.deepEqual(f.docs['physical-stock'].state.products[0].linkedLinkIds,[f.link.id]);});
test('manual plan URL registration preserves observation dates, decisions and plan identity',()=>{const f=linkFixture(),old=structuredClone(f.docs['sales-planning'].state.plans[0]),e=edit(f,'plan:'+f.planId);applyProductLinkEdit(f.docs,e.command,e.options);const p=f.docs['sales-planning'].state.plans[0];assert.equal(p.id,old.id);assert.equal(p.availableOn,old.availableOn);assert.deepEqual(p.decisions,old.decisions);assert.equal(p.note,old.note);assert.equal(p.linkedLinkIds.length,1);});
test('missing ASIN can be filled without manufacturing any physical quantity',()=>{const f=linkFixture(),s=f.docs['physical-stock'].state;s.products[0].asin='';s.products[0].linkedLinkIds=[];const before=structuredClone(s.balances),e=edit(f,'stock:'+f.stockId,{yahoo:''});applyProductLinkEdit(f.docs,e.command,e.options);assert.equal(s.products[0].asin,asin);assert.deepEqual(s.balances,before);});
test('retries return the same receipt before revision checks and different payloads cannot reuse an ID',()=>{const f=linkFixture(),e=edit(f,'plan:'+f.planId),r=applyProductLinkEdit(f.docs,e.command,e.options);f.docs['link-monitor'].revision++;assert.equal(applyProductLinkEdit(f.docs,e.command,e.options).linkId,r.linkId);assert.throws(()=>applyProductLinkEdit(f.docs,{...e.command,yahoo:url+'bad'},e.options),{status:409});});
test('rejects changed ASIN, foreign hosts, credentials, conflicting links and stale edits',()=>{for(const patch of [{amazon:'B000OTHER1'},{yahoo:'https://example.com/auction/d1000000002'},{yahoo:'https://user:password@auctions.yahoo.co.jp/jp/auction/d1000000002'},{replaceLinkId:randomUUID()}]){const f=linkFixture(),e=edit(f,'stock:'+f.stockId,patch);assert.throws(()=>applyProductLinkEdit(f.docs,e.command,e.options));}const f=linkFixture(),e=edit(f,'plan:'+f.planId);assert.throws(()=>applyProductLinkEdit(f.docs,e.command,{...e.options,expectedRevision:3}),{status:409});});

test('URL association checks a selected link SKU even without a legacy catalog record',()=>{
 const f=linkFixture(),s=f.docs['physical-stock'].state.products[0];s.linkedLinkIds=[];s.sellerSku='OWN-GOOD';f.link.amazonSellerSku='OWN-VERY-GOOD';
 const e=edit(f,'stock:'+f.stockId,{yahoo:'https://auctions.yahoo.co.jp/jp/auction/'+f.link.listingId});
 assert.throws(()=>applyProductLinkEdit(f.docs,e.command,e.options),{status:409});
});
function fakePool(f,{failSecond=false,commitUnknown=false}={}){let saved=structuredClone(f.docs),working,updates=0;return {state:()=>saved,async connect(){return{release(){},async query(sql,args){if(sql==='BEGIN'){working=structuredClone(saved);return{};}if(sql.startsWith('SET LOCAL'))return{};if(sql.startsWith('SELECT'))return{rows:Object.entries(working||saved).sort().map(([k,d])=>({document_key:k,payload:structuredClone(d.state),revision:d.revision}))};if(sql.startsWith('UPDATE')){if(failSecond&&++updates===2)throw Object.assign(new Error('injected write failure'),{code:'XX000'});working[args[0]]={state:JSON.parse(args[1]),revision:working[args[0]].revision+1};return{};}if(sql==='COMMIT'){saved=working;working=null;if(commitUnknown)throw Object.assign(new Error('lost response'),{code:'08006'});return{};}if(sql==='ROLLBACK'){working=null;return{};}throw new Error('unexpected SQL');}};}};}
const validators={'link-monitor':validateMonitorState,'physical-stock':validatePhysicalStock,'sales-planning':validateSalesPlanning};
test('multi-document URL save rolls back both the new link and source metadata if a write fails',async()=>{const f=linkFixture(),pool=fakePool(f,{failSecond:true}),tx=createDocumentTransaction({pool,validators}),e=edit(f,'stock:'+f.stockId),before=structuredClone(pool.state());await assert.rejects(tx.update(d=>applyProductLinkEdit(d,e.command,e.options)));assert.deepEqual(pool.state(),before);});
test('a lost commit response can be replayed without creating duplicate listings or links',async()=>{const f=linkFixture(),pool=fakePool(f,{commitUnknown:true}),tx=createDocumentTransaction({pool,validators}),e=edit(f,'plan:'+f.planId);await assert.rejects(tx.update(d=>applyProductLinkEdit(d,e.command,e.options)),{code:'STORAGE_COMMIT_UNKNOWN'});const saved=await tx.read();assert.equal(saved['link-monitor'].state.links.length,2);assert.equal(applyProductLinkEdit(saved,e.command,e.options).replayed,true);});
test('URL editing requires owner authentication, same origin, revision and write access',async()=>{const origin='https://fixture.example',editor={list:async()=>({entries:{}}),save:async()=>({saved:true})},make=readOnly=>createCloudHandler({config:{origin,authUrl:origin,readOnly},productLinks:editor,verifyOwner:async r=>({status:r.headers.get('authorization')==='Bearer owner'?200:401,userId:actor})});const req=(headers={},method='POST')=>new Request(origin+'/api/product-links/operations',{method,headers:{'Content-Type':'application/json',...headers},body:'{}'});assert.equal((await make(false)(req())).status,401);assert.equal((await make(false)(req({authorization:'Bearer owner'}))).status,428);assert.equal((await make(true)(req({authorization:'Bearer owner','If-Match':'"4"'}))).status,403);assert.equal((await make(false)(req({authorization:'Bearer owner',origin:'https://other.example','If-Match':'"4"'}))).status,403);});
test('quiet refresh retrieves own listing status without producing mail; newer failed reads stay unknown',async()=>{
 const f=linkFixture(),config={accountKey:'fixture',sellerId:'OWN',marketplaceId:'A1VC38T7YXB528'};Object.assign(f.docs['link-monitor'].state,{amazonAccountKey:config.accountKey,amazonSellerId:config.sellerId});let w=emptyProductWatch();
 const watchStore={read:async()=>structuredClone(w),update:async fn=>{const copy=structuredClone(w),r=await fn(copy);w=copy;return r;}},overview={inputs:async()=>({monitor:f.docs['link-monitor'].state,physical:f.docs['physical-stock'].state,planning:f.docs['sales-planning'].state,drafts:[],watch:structuredClone(w)})};
 let failListings=false;const monitoring=createProductMonitoring({overview,watchStore,config,now:()=>at,readInventory:async({asins})=>({status:'complete',complete:true,...config,asins,items:[],checkedAt:at}),readYahoo:async()=>({listingId:f.link.listingId,references:[],observation:{verified:true,status:'active',checkedAt:at}}),readListings:async({asins})=>{if(failListings)throw new Error('unavailable');return{status:'complete',source:'own_seller_listings',...config,asins,checkedAt:at,rows:[{asin,sellerSku:'MERCHANT',condition:'used_good',statuses:['BUYABLE'],fulfillment:[{channel:'DEFAULT',quantity:1}]}]};}});
 await monitoring.run({refreshListings:true,settings:{stockAlerts:false,yahooAlerts:false,reviewAlerts:false,errorAlerts:false}});assert.equal(w.observations.listings.rows.length,1);assert.equal(w.pendingAlerts.length,0);
 const row={asin,condition:'used',sourceKeys:['stock:'+f.stockId],rule:{}};assert.equal(productChannels(row,f.docs['link-monitor'].state,w,at).merchant.state,'active');delete w.observations.listings;failListings=true;
 await monitoring.run({refreshListings:true,settings:{stockAlerts:false,yahooAlerts:false,reviewAlerts:false,errorAlerts:false}});
 assert.equal(w.observations.listings.status,'failed');assert.deepEqual(w.observations.listings.asins,[asin]);assert.equal(productChannels(row,f.docs['link-monitor'].state,w,at).merchant.state,'unknown');assert.equal(w.pendingAlerts.length,0);
});

test('manual FBA zero and SKU save without changing physical counts, links or memos; replay is idempotent',()=>{
 const f=linkFixture(),s=f.docs['physical-stock'].state,before=structuredClone(s.balances);s.products[0].memo='本人が入力したメモ';
 const e=edit(f,'stock:'+f.stockId,{kind:'inventory',sellerSku:'OWN-GOOD',manualFbaQuantity:0});
 applyProductLinkEdit(f.docs,e.command,e.options);
 assert.deepEqual(s.balances,before);assert.equal(s.products[0].memo,'本人が入力したメモ');assert.deepEqual(s.products[0].linkedLinkIds,[f.link.id]);assert.equal(s.products[0].sellerSku,'OWN-GOOD');
 assert.equal(productLinkInfo(f.docs,e.command.key).manualReview.manualFbaQuantity,0);
 assert.equal(applyProductLinkEdit(f.docs,e.command,e.options).replayed,true);assert.equal(f.docs['link-monitor'].state.inventoryReviews.length,1);
 const clear=edit(f,e.command.key,{kind:'inventory',sellerSku:'OWN-GOOD',manualFbaQuantity:null});applyProductLinkEdit(f.docs,clear.command,clear.options);
 assert.equal(productLinkInfo(f.docs,e.command.key).manualReview.manualFbaQuantity,null);assert.equal(f.docs['link-monitor'].state.inventoryReviewHistory[0].manualFbaQuantity,0);
});

test('quantity-only manual confirmation needs no SKU and does not rewrite products, plans, links or physical counts',()=>{
 for(const kind of ['stock','plan','link']){
  const f=linkFixture(),before=structuredClone(f.docs),key=kind+':'+(kind==='stock'?f.stockId:kind==='plan'?f.planId:f.link.id);
  const e=edit(f,key,{kind:'manual-fba',sellerSku:'',manualFbaQuantity:92});applyProductLinkEdit(f.docs,e.command,e.options);
  assert.deepEqual(f.docs['physical-stock'],before['physical-stock']);assert.deepEqual(f.docs['sales-planning'],before['sales-planning']);assert.deepEqual(f.docs['link-monitor'].state.links,before['link-monitor'].state.links);
  const review=productLinkInfo(f.docs,key).manualReview;assert.equal(review.manualFbaQuantity,92);assert.equal(review.sellerSku,'');assert.equal(review.mode,'manual');
  assert.equal(applyProductLinkEdit(f.docs,e.command,e.options).replayed,true);
  const zero=edit(f,key,{kind:'manual-fba',sellerSku:'',manualFbaQuantity:0});applyProductLinkEdit(f.docs,zero.command,zero.options);assert.equal(productLinkInfo(f.docs,key).manualReview.manualFbaQuantity,0);
  const clear=edit(f,key,{kind:'manual-fba',sellerSku:'',manualFbaQuantity:null});applyProductLinkEdit(f.docs,clear.command,clear.options);assert.equal(productLinkInfo(f.docs,key).manualReview.manualFbaQuantity,null);
  assert.equal(f.docs['link-monitor'].state.inventoryReviewHistory.length,2);
 }
});

test('quantity-only confirmation cannot replace an existing SKU and rejects stale sources and invalid quantities',()=>{
 const f=linkFixture();f.docs['physical-stock'].state.products[0].sellerSku='EXISTING';
 const e=edit(f,'stock:'+f.stockId,{kind:'manual-fba',sellerSku:'OTHER',manualFbaQuantity:92});assert.throws(()=>applyProductLinkEdit(f.docs,e.command,e.options),{status:409});
 for(const q of [-1,1.5,undefined,1000001]){const input=edit(f,e.command.key,{kind:'manual-fba',sellerSku:'EXISTING',manualFbaQuantity:q});assert.throws(()=>applyProductLinkEdit(f.docs,input.command,input.options));}
 const valid=edit(f,e.command.key,{kind:'manual-fba',sellerSku:'EXISTING',manualFbaQuantity:92});assert.throws(()=>applyProductLinkEdit(f.docs,valid.command,{...valid.options,sourceRevisions:{...valid.options.sourceRevisions,'physical-stock':0}}),{status:409});
 applyProductLinkEdit(f.docs,valid.command,valid.options);assert.equal(f.docs['physical-stock'].state.products[0].sellerSku,'EXISTING');
});

test('manual and referenced plans retain dates, actions and notes when confirming an empty SKU',()=>{
 for(const kind of ['manual','stock','link']){
  const f=linkFixture(),p=f.docs['sales-planning'].state.plans[0];p.source={kind,id:kind==='stock'?f.stockId:kind==='link'?f.link.id:''};
  const before=structuredClone(p),e=edit(f,'plan:'+f.planId,{kind:'inventory',sellerSku:'OWN-GOOD',manualFbaQuantity:3});
  applyProductLinkEdit(f.docs,e.command,e.options);
  assert.equal(p.sellerSku,'OWN-GOOD');for(const k of ['id','availableOn','durationDays','decisions','actions','note','source'])assert.deepEqual(p[k],before[k]);
  assert.equal(productLinkInfo(f.docs,e.command.key).manualReview.manualFbaQuantity,3);
  if(kind==='link')assert.equal(f.link.amazonSellerSku,'OWN-GOOD');
  if(kind==='stock')assert.equal(f.docs['physical-stock'].state.products[0].sellerSku,'OWN-GOOD');
 }
});

test('inventory corrections reject stale or invalid values and roll back if a referenced plan has another SKU',async()=>{
 for(const patch of [{manualFbaQuantity:-1},{manualFbaQuantity:1.5},{manualFbaQuantity:undefined},{sellerSku:'bad\nSKU'}]){
  const f=linkFixture(),e=edit(f,'link:'+f.link.id,{kind:'inventory',sellerSku:'OWN',manualFbaQuantity:0,...patch});assert.throws(()=>applyProductLinkEdit(f.docs,e.command,e.options));
 }
 const f=linkFixture(),p=f.docs['sales-planning'].state.plans[0];p.source={kind:'stock',id:f.stockId};p.sellerSku='EXISTING';
 const pool=fakePool(f),tx=createDocumentTransaction({pool,validators}),before=structuredClone(pool.state()),e=edit(f,'plan:'+f.planId,{kind:'inventory',sellerSku:'OTHER',manualFbaQuantity:0});
 await assert.rejects(tx.update(d=>applyProductLinkEdit(d,e.command,e.options)),{status:409});assert.deepEqual(pool.state(),before);
 assert.throws(()=>applyProductLinkEdit(f.docs,e.command,{...e.options,expectedRevision:3}),{status:409});
});

test('choosing a registered listing attaches its existing ID without copying stock, URLs, SKU or memo',()=>{
 const f=linkFixture(),stock=f.docs['physical-stock'].state.products[0];stock.linkedLinkIds=[];stock.memo='コンテナ確認 脚なしか？ あれば補充';
 const before=structuredClone(f.docs),e=edit(f,'stock:'+f.stockId,{kind:'associate-existing',targetKey:'link:'+f.link.id,confirmed:true});
 const receipt=applyProductLinkEdit(f.docs,e.command,e.options);
 assert.equal(receipt.linkId,f.link.id);assert.deepEqual(stock.linkedLinkIds,[f.link.id]);assert.equal(stock.sellerSku,before['physical-stock'].state.products[0].sellerSku);assert.equal(stock.memo,before['physical-stock'].state.products[0].memo);
 assert.deepEqual(f.docs['physical-stock'].state.balances,before['physical-stock'].state.balances);assert.deepEqual(f.docs['link-monitor'].state.links,before['link-monitor'].state.links);assert.deepEqual(f.docs['sales-planning'],before['sales-planning']);
 assert.equal(applyProductLinkEdit(f.docs,e.command,e.options).replayed,true);assert.equal(f.docs['physical-stock'].state.events.length,before['physical-stock'].state.events.length+1);
});

test('a listing can choose existing stock in reverse and a plan can reuse existing listing IDs without resetting dates',()=>{
 for(const kind of ['link','plan','stock-plan']){
  const f=linkFixture(),stock=f.docs['physical-stock'].state.products[0];stock.linkedLinkIds=[];
  const p=f.docs['sales-planning'].state.plans[0];if(kind==='stock-plan')p.source={kind:'stock',id:f.stockId};const before=structuredClone(p),balances=structuredClone(f.docs['physical-stock'].state.balances);
  const e=edit(f,kind==='link'?'link:'+f.link.id:'plan:'+f.planId,{kind:'associate-existing',targetKey:kind==='link'?'stock:'+f.stockId:'link:'+f.link.id,confirmed:true});
  applyProductLinkEdit(f.docs,e.command,e.options);
  assert.deepEqual(f.docs['physical-stock'].state.balances,balances);
  if(kind==='plan')assert.deepEqual(p.linkedLinkIds,[f.link.id]);else assert.deepEqual(stock.linkedLinkIds,[f.link.id]);
  for(const key of ['id','createdAt','source','note','availableOn','reviewOn','decisions','actions'])assert.deepEqual(p[key],before[key]);assert.equal(f.docs['link-monitor'].state.links.length,1);
 }
});

test('existing associations reject other ASINs, SKUs, conditions, sets, unverified listings and missing confirmation',()=>{
 for(const mutate of [
  f=>{f.docs['physical-stock'].state.products[0].asin='B000OTHER1';},
  f=>{f.docs['physical-stock'].state.products[0].sellerSku='OTHER';f.link.amazonSellerSku='OWN';},
  f=>{f.docs['physical-stock'].state.products[0].condition='new';f.docs['link-monitor'].state.catalog.push({id:'fixture-catalog',asin,condition:'UsedGood'});f.link.catalogId='fixture-catalog';},
  f=>{f.docs['physical-stock'].state.products[0].setContents='スタンドなし';f.docs['link-monitor'].state.catalog.push({id:'fixture-catalog',asin,condition:'UsedGood',setContents:'スタンド付き'});f.link.catalogId='fixture-catalog';},
  f=>{f.link.verified=false;},f=>{f.link.observationConflict=true;}
 ]){
  const f=linkFixture();f.docs['physical-stock'].state.products[0].linkedLinkIds=[];mutate(f);const before=structuredClone(f.docs),e=edit(f,'stock:'+f.stockId,{kind:'associate-existing',targetKey:'link:'+f.link.id,confirmed:true});
  assert.throws(()=>applyProductLinkEdit(f.docs,e.command,e.options),{status:409});assert.deepEqual(f.docs,before);
 }
 const f=linkFixture(),e=edit(f,'stock:'+f.stockId,{kind:'associate-existing',targetKey:'link:'+f.link.id});assert.throws(()=>applyProductLinkEdit(f.docs,e.command,e.options),{status:400});
});

test('adding a second listing cannot combine distinct SKUs or used ranks on stock with an unselected SKU',()=>{
 for(const mode of ['sku','rank']){
  const f=linkFixture(),m=f.docs['link-monitor'].state,second=registerPageLink(m,{amazon:asin,yahoo:url,submitted:true},at);
  for(const [l,condition] of [[f.link,'UsedGood'],[second,'UsedVeryGood']]){const id=randomUUID();m.catalog.push({id,asin,condition});l.catalogId=id;l.amazonSellerSku=mode==='sku'?condition:'';}
  const e=edit(f,'stock:'+f.stockId,{kind:'associate-existing',targetKey:'link:'+second.id,confirmed:true});assert.throws(()=>applyProductLinkEdit(f.docs,e.command,e.options),{status:409});
 }
});

test('existing selection checks the destination revision and transaction rollback preserves both documents',async()=>{
 const f=linkFixture();f.docs['physical-stock'].state.products[0].linkedLinkIds=[];const e=edit(f,'link:'+f.link.id,{kind:'associate-existing',targetKey:'stock:'+f.stockId,confirmed:true});
 assert.throws(()=>applyProductLinkEdit(f.docs,e.command,{...e.options,sourceRevisions:{...e.options.sourceRevisions,'physical-stock':0}}),{status:409});
 const pool=fakePool(f,{failSecond:true}),tx=createDocumentTransaction({pool,validators}),before=structuredClone(pool.state());await assert.rejects(tx.update(d=>applyProductLinkEdit(d,e.command,e.options)));assert.deepEqual(pool.state(),before);
});

test('URL plus review is one transaction using the original stock reference and never copying quantity or starting a sales test',()=>{
 const f=linkFixture(),before=structuredClone(f.docs),e=edit(f,'stock:'+f.stockId,{review:{planId:randomUUID(),reviewOn:'2026-12-01',note:'2週間後に検討'}});
 const receipt=applyProductLinkEdit(f.docs,e.command,e.options),p=f.docs['sales-planning'].state.plans.find(p=>p.id===receipt.review.id);
 assert.equal(f.docs['link-monitor'].state.links.length,2);assert.equal(p.source.kind,'stock');assert.equal(p.source.id,f.stockId);assert.equal(p.reviewOn,'2026-12-01');assert.equal(p.availableOn,'');assert.equal(p.kind,'review');assert.equal(Object.hasOwn(p,'locations'),false);assert.deepEqual(f.docs['physical-stock'].state.balances,before['physical-stock'].state.balances);assert.deepEqual(f.docs['sales-planning'].state.plans[0],before['sales-planning'].state.plans[0]);
 assert.equal(applyProductLinkEdit(f.docs,e.command,e.options).review.id,p.id);assert.equal(f.docs['sales-planning'].state.plans.length,2);validateSalesPlanning(f.docs['sales-planning'].state);validateMonitorState(f.docs['link-monitor'].state);
});

test('existing listing plus review reuses its ID; review-only from a card needs no Yahoo URL',()=>{
 for(const mode of ['associate-existing','register-review']){
  const f=linkFixture(),stock=f.docs['physical-stock'].state.products[0];stock.linkedLinkIds=[];stock.memo='元のメモ';const before=structuredClone(f.docs),e=edit(f,'stock:'+f.stockId,{kind:mode,targetKey:'link:'+f.link.id,confirmed:true,review:{planId:randomUUID(),reviewOn:'',note:''}});delete e.command.yahoo;delete e.command.amazon;
  const r=applyProductLinkEdit(f.docs,e.command,e.options),p=f.docs['sales-planning'].state.plans.find(p=>p.id===r.review.id);assert.ok(p);assert.equal(p.source.id,f.stockId);assert.equal(p.availableOn,'');assert.equal(p.reviewOn,'');assert.equal(stock.memo,'元のメモ');assert.equal(f.docs['link-monitor'].state.links.length,1);assert.deepEqual(f.docs['physical-stock'].state.balances,before['physical-stock'].state.balances);
 }
});

test('quick review reuses a related active plan and keeps its dates, actions and memo unchanged',()=>{
 const f=linkFixture(),p=f.docs['sales-planning'].state.plans[0];p.source={kind:'stock',id:f.stockId};const before=structuredClone(f.docs['sales-planning']),e=edit(f,'stock:'+f.stockId,{kind:'register-review',review:{planId:randomUUID(),reviewOn:'2026-12-02',note:'上書きしない'}});
 const r=applyProductLinkEdit(f.docs,e.command,e.options);assert.equal(r.review.existing,true);assert.equal(r.review.id,p.id);assert.deepEqual(f.docs['sales-planning'],before);
});

test('a stale planning revision or invalid review rolls back the URL and stock association together',async()=>{
 for(const patch of [{revision:0},{reviewOn:'2026-02-30'},{note:'x'.repeat(1001)}]){
  const f=linkFixture(),pool=fakePool(f),tx=createDocumentTransaction({pool,validators}),e=edit(f,'stock:'+f.stockId,{review:{planId:randomUUID(),reviewOn:patch.reviewOn||'',note:patch.note||''}}),before=structuredClone(pool.state());if(patch.revision===0)e.options.sourceRevisions['sales-planning']=0;
  await assert.rejects(tx.update(d=>applyProductLinkEdit(d,e.command,e.options)));assert.deepEqual(pool.state(),before);
 }
});

test('a lost combined commit replays once without duplicate product, plan or quantity events',async()=>{
 const f=linkFixture(),pool=fakePool(f,{commitUnknown:true}),tx=createDocumentTransaction({pool,validators}),e=edit(f,'stock:'+f.stockId,{review:{planId:randomUUID(),reviewOn:'',note:'保持'}});
 await assert.rejects(tx.update(d=>applyProductLinkEdit(d,e.command,e.options)),{code:'STORAGE_COMMIT_UNKNOWN'});const docs=await tx.read(),before=structuredClone(docs);assert.equal(applyProductLinkEdit(docs,e.command,e.options).replayed,true);assert.deepEqual(docs,before);assert.equal(docs['sales-planning'].state.plans.length,2);assert.equal(docs['link-monitor'].state.links.length,2);
});
