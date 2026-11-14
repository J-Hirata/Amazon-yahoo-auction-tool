import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';
import {createProductOverview,emptyProductWatch} from '../src/product-overview.js';
import {createProductMonitoring} from '../src/product-monitoring.js';
import {createProductNotices} from '../src/product-notices.js';
import {activateNoticePolicy,noticeSchedule} from '../src/product-notice-policy.js';
import {dailyMail} from '../src/daily-mail.js';
import {matchesOverviewFilters,overviewLinkFilter} from '../public/overview-filters.js';
const at='2026-11-14T00:51:00Z',asin='B000TEST01',sku='OWN-TEST';
function memory(value){let state=structuredClone(value),revision=0;return {read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn)=>{const copy=structuredClone(state),result=await fn(copy);state=copy;revision++;return result;}};}
function fixture(){
 let clock=at,quantity=17,inventoryFailure=false,outcome='smtp_accepted',hook;
 const linkId=randomUUID(),listingId='d1000000001',settings={enabled:true,enabledAt:'2026-11-01T00:00:00Z',fbaSales:true,merchantSales:true,errorAlerts:false,stockAlerts:true,yahooAlerts:false,reviewAlerts:true};
 const event={id:'e1',orderId:'o1',itemId:'i1',asin,sellerSku:sku,fulfillment:'AMAZON',delta:2,delivery:'preview',eligibleFromAt:at,at};
 const monitor=memory({version:1,amazonAccountKey:'own',amazonSellerId:'OWN',links:[{id:linkId,asin,listingId,amazonSellerSku:sku,verified:true}],catalog:[],listings:[{listingId,title:'検証モニター',seller:'OWN'}],salesAutomation:settings,salesTracking:{startedAt:settings.enabledAt,checkedThrough:at,sync:{status:'complete'},events:[event],orders:[],trackers:[{sourceId:'link:'+linkId,asin,sellerSku:sku,title:'検証モニター',startedAt:settings.enabledAt}]},mailOutbox:[],events:[],logs:[]});
 const watch=emptyProductWatch();activateNoticePolicy(watch,at);watch.rules=[{key:'link:'+linkId,tags:[],replenishEnabled:false,lowStock:{source:'fba',threshold:30}}];
 const watchStore=memory(watch),stockStore=memory({products:[],balances:[],transfers:[]}),planningStore=memory({plans:[]}),draftStore=memory([]);
 const overview=createProductOverview({monitorStore:monitor,watchStore,stockStore,planningStore,draftStore,now:()=>clock});
 const monitoring=createProductMonitoring({overview,watchStore,config:{accountKey:'own',sellerId:'OWN'},now:()=>clock,readInventory:async({asins})=>{if(inventoryFailure)throw Error('unavailable');return{complete:true,status:'complete',accountKey:'own',sellerId:'OWN',asins,checkedAt:clock,items:[{asin,sellerSku:sku,fulfillableQuantity:quantity,condition:'UsedGood'}]};},readYahoo:async()=>({listingId,seller:'OWN',references:[],observation:{status:'active',verified:true,checkedAt:clock}})});
 const sales={start:async()=>{},check:async()=>monitor.update(m=>{m.salesTracking.checkedThrough=clock;})};
 const sent=[],engine=createCloudSalesAutomation({store:monitor,sales,monitoring,readInventory:()=>overview.view(),now:()=>clock,readAlertContext:async()=>{await hook?.();return monitoring.deliveryContext();},transport:{send:async m=>{sent.push(structuredClone(m));return{status:outcome};}}});
 const notices=createProductNotices({overview,watchStore,now:()=>clock});
 return{monitor,watchStore,stockStore,planningStore,overview,notices,engine,sales,sent,event,linkId,time:x=>clock=x,quantity:x=>quantity=x,outcome:x=>outcome=x,hook:x=>hook=x,failure:x=>inventoryFailure=x};
}
async function toggle(f,id,stopped){await f.notices.commit({operationId:randomUUID(),alertId:id,stopped},{actor:'owner',expectedRevision:(await f.notices.view()).revision});}
test('daily sales and alerts use one SMTP message while preserving both durable receipt sets',async()=>{
 const f=fixture(),stock=await f.stockStore.read(),plans=await f.planningStore.read();await f.engine.run();await f.engine.run();
 assert.equal(f.sent.length,1);const mail=f.sent[0];assert.match(mail.subject,/確認 2026-11-14/);assert.match(mail.text,/注文確定 2個 ／ FBA在庫 17個/);assert.match(mail.text,/警告設定 30個以下/);assert.match(mail.html,/#alerts=active/);assert.equal(mail.eventIds.length,1);assert.equal(mail.alertIds.length,1);
 const state=await f.monitor.read();assert.equal(state.salesTracking.events[0].delivery,'smtp_accepted');assert.equal(state.mailOutbox.filter(r=>r.status==='smtp_accepted').length,1);assert.ok(state.mailOutbox.some(r=>r.cancelledFor==='merged_into_digest'));assert.equal((await f.notices.view()).notices[0].deliveredCount,1);assert.deepEqual(await f.stockStore.read(),stock);assert.deepEqual(await f.planningStore.read(),plans);
});
test('a merged first mail still permits the third-day second reminder without re-sending sales',async()=>{
 const f=fixture();await f.engine.run();f.time('2026-11-17T00:50:00Z');await f.engine.run();await f.engine.run();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/通知2回目/);assert.doesNotMatch(f.sent[1].text,/注文確定 2個/);assert.equal((await f.notices.view()).notices[0].deliveredCount,2);
});
test('stopping an alert after aggregation does not suppress the confirmed sale or count the removed alert',async()=>{
 const f=fixture();let id;f.hook(async()=>{if(!id){id=(await f.notices.view()).notices[0].id;await toggle(f,id,true);}});await f.engine.run();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/注文確定 2個/);assert.equal(f.sent[0].alertIds.length,0);assert.equal((await f.notices.view()).notices[0].deliveredCount,0);
 f.hook(null);await toggle(f,id,false);await f.engine.run();assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].alertIds,[id]);assert.equal(Object.values(f.sent[1].noticeNumbers)[0],1);assert.equal((await f.monitor.read()).salesTracking.events[0].delivery,'smtp_accepted');
});
test('temporarily unknown alert data holds that alert while sales go through and its original ID can resume',async()=>{
 const f=fixture();let id;f.hook(async()=>{if(!id){id=(await f.notices.view()).notices[0].id;await f.watchStore.update(w=>{w.observations.fba.status='failed';w.observations.fba.complete=false;});}});await f.engine.run();assert.equal(f.sent.length,1);assert.equal(f.sent[0].alertIds.length,0);assert.match(f.sent[0].text,/注文確定 2個/);
 f.hook(null);await f.engine.run();assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].alertIds,[id]);assert.equal(f.sent[0].alertIds.length,0);assert.equal((await f.notices.view()).notices[0].deliveredCount,1);
});
test('a resolved queued alert is removed from a combined mail but confirmed sales remain',async()=>{
 const f=fixture();f.hook(()=>f.watchStore.update(w=>{w.observations.fba.items[0].fulfillableQuantity=40;}));await f.engine.run();assert.equal(f.sent.length,1);assert.equal(f.sent[0].alertIds.length,0);assert.match(f.sent[0].text,/注文確定 2個/);assert.doesNotMatch(f.sent[0].text,/警告設定/);
});
test('SMTP uncertainty never retries or increases a reminder count',async()=>{
 const f=fixture();f.outcome('uncertain');await f.engine.run();f.time('2026-11-17T00:51:00Z');await f.engine.run();assert.equal(f.sent.length,1);assert.equal((await f.notices.view()).notices[0].deliveredCount,0);assert.equal((await f.notices.view()).notices[0].blocked,true);
});
test('a clear SMTP rejection retries the combined message once and counts each component once',async()=>{
 const f=fixture();f.outcome('failed');await f.engine.run();f.outcome('smtp_accepted');f.time('2026-11-14T02:51:00Z');await f.engine.run();await f.engine.run();assert.equal(f.sent.length,2);assert.equal(f.sent[0].id,f.sent[1].id);assert.equal((await f.notices.view()).notices[0].deliveredCount,1);assert.equal((await f.monitor.read()).salesTracking.events[0].delivery,'smtp_accepted');
});
test('alert badges use the actual alert predicate and are independent of reminder pause',async()=>{
 const f=fixture();await f.engine.run();let row=(await f.overview.view()).rows[0];assert.equal(row.alerts.length,1);assert.equal(row.alerts[0].field,'fba');assert.equal(matchesOverviewFilters(row,['alert']),true);await toggle(f,row.alerts[0].id,true);assert.equal((await f.overview.view()).rows[0].alerts.length,1);
 f.quantity(40);await f.engine.run();row=(await f.overview.view()).rows[0];assert.equal(row.alerts.length,0);assert.equal(row.risk.configured,true);assert.equal(matchesOverviewFilters(row,['alert']),false);
});
test('unknown or disabled category does not paint a false stock alert',async()=>{
 const f=fixture();await f.engine.run();f.failure(true);await f.engine.run();let row=(await f.overview.view()).rows[0];assert.equal(row.alerts.length,0);assert.ok(row.alertUnknown.length);await f.monitor.update(m=>{m.salesAutomation.stockAlerts=false;});assert.equal((await f.overview.view()).rows[0].alerts.length,0);
});
test('review alerts show both the stored actual start and due date',async()=>{
 const f=fixture();await f.watchStore.update(w=>{w.rules=[{key:'link:'+f.linkId,tags:[],replenishEnabled:false,startedOn:'2026-10-31',reviewDays:14}];});await f.engine.run();assert.match(f.sent[0].text,/見直し期間 2026-10-31 → 2026-11-14/);assert.match(f.sent[0].html,/見直し期間 2026-10-31 → 2026-11-14/);const review=(await f.overview.view()).rows[0].alerts.find(a=>a.kind==='review');assert.deepEqual(review.period,{startsOn:'2026-10-31',endsOn:'2026-11-14'});
});
test('a dated manual review does not manufacture a missing start date',async()=>{
 const f=fixture();await f.planningStore.update(s=>s.plans.push({id:randomUUID(),source:{kind:'link',id:f.linkId},title:'手動見直し',asin,sellerSku:sku,condition:'unknown',status:'active',kind:'review',availableOn:'',reviewOn:'2026-11-14',durationDays:14}));await f.engine.run();assert.match(f.sent[0].text,/見直し期間 開始日未設定 → 2026-11-14/);
});
test('mail links explicitly select active alerts and disregard unrelated old filters',()=>{
 assert.deepEqual(overviewLinkFilter('#alerts=active'),{keys:['alert'],mode:'all',sort:'alert'});assert.equal(overviewLinkFilter('#alerts=old'),null);assert.equal(overviewLinkFilter('#notice=test'),null);assert.equal(matchesOverviewFilters({alerts:[],attention:['未確認']},['alert']),false);
});
test('compact HTML uses Amazon quantity and preserves missing, zero and HTML escaping',()=>{
 const sale={title:'商品 <script>x</script>',asin,positive:1,negative:0,sellerSku:'SKU<&',fulfillment:'AMAZON',stock:{api:{quantity:70},estimate:{quantity:75},home:{quantity:null,status:'unconfirmed'},container:{quantity:0,unit:'個'}}};const result=dailyMail({at,sales:[sale]});assert.match(result.text,/FBA在庫 70個/);assert.doesNotMatch(result.text,/75個/);assert.match(result.text,/自社・自宅：数量未入力 ／ コンテナ：0個/);assert.ok(!result.html.includes('<script>'));assert.match(result.html,/SKU&lt;&amp;/);
});

test('an alert-only mail is held while its source is unknown and resumes with the original ID',async()=>{
 const f=fixture();await f.monitor.update(m=>{m.salesTracking.events[0].delivery='historical';});
 f.hook(()=>f.watchStore.update(w=>{w.observations.fba.status='failed';w.observations.fba.complete=false;}));
 await f.engine.run();assert.equal(f.sent.length,0);
 const pending=(await f.monitor.read()).mailOutbox.find(r=>r.status==='pending'),id=pending.alertIds[0];
 f.hook(null);await f.engine.run();assert.equal(f.sent.length,1);assert.equal(f.sent[0].id,pending.id);assert.deepEqual(f.sent[0].alertIds,[id]);assert.equal((await f.notices.view()).notices[0].deliveredCount,1);
 f.time('2026-11-17T00:51:00Z');f.hook(()=>f.watchStore.update(w=>{w.observations.fba.status='failed';w.observations.fba.complete=false;}));
 await f.engine.run();assert.equal(f.sent.length,1);assert.equal((await f.notices.view()).notices[0].deliveredCount,1);
 f.hook(null);await f.engine.run();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/通知2回目/);assert.equal((await f.notices.view()).notices[0].deliveredCount,2);
});

test('opening the overview does not consume signals, write a reminder receipt or change stored documents',async()=>{
 const f=fixture();await f.engine.run();const stores=[f.monitor,f.watchStore,f.stockStore,f.planningStore],before=await Promise.all(stores.map(s=>s.readSnapshot()));
 await f.overview.view();await f.overview.view();assert.deepEqual(await Promise.all(stores.map(s=>s.readSnapshot())),before);
});

test('operational errors and product alerts share the daily message without inventing a sale',async()=>{
 const f=fixture();await f.monitor.update(m=>{m.salesTracking.events[0].delivery='historical';m.salesAutomation.errorAlerts=true;});f.sales.check=async()=>{throw Error('注文確認を取得できません');};
 await f.engine.run();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/確認できない項目/);assert.doesNotMatch(f.sent[0].text,/注文確定 0個/);assert.ok(f.sent[0].alertIds.length);assert.equal((await f.monitor.read()).mailOutbox.filter(r=>r.status==='smtp_accepted').length,1);
});
