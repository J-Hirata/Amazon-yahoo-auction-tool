import test from 'node:test';
import assert from 'node:assert/strict';
import {catchUpSales} from '../src/sales-catchup.js';
import {createCloudSales} from '../src/cloud-sales.js';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';
import {collectYahooQuantityAlerts} from '../src/yahoo-quantity-alerts.js';

const at='2026-11-10T00:50:46.978Z',start='2026-10-25T16:21:27.134Z';
const config={accountKey:'fixture-account',sellerId:'FIXTURE',marketplaceId:'A1VC38T7YXB528'};
function memory(initial){let state=structuredClone(initial);return {read:async()=>structuredClone(state),update:async(fn)=>{const copy=structuredClone(state),v=await fn(copy);state=copy;return v;}};}

test('daily completion catches up beyond two weekly windows and dispatches the new sale once',async()=>{
 const target={sourceId:'stock:a',asin:'B000TEST01',sellerSku:'sku-a',startedAt:start},sent=[];let calls=0;
 const store=memory({version:1,catalog:[],links:[],listings:[],logs:[],salesTargets:{...config,targets:[target]},amazonAccountKey:config.accountKey,amazonSellerId:config.sellerId,
  salesAutomation:{enabled:true,enabledAt:'2026-11-02T00:00:00Z',fbaSales:true,merchantSales:true,errorAlerts:true},
  salesTracking:{...config,startedAt:start,trackers:[target],orders:[],events:[],checkedThrough:start,sync:{status:'complete'}}});
 const sales=createCloudSales({store,config,now:()=>at,readTargets:async()=>({...config,targets:[target]}),readOrders:async({after,before})=>{
  calls++;return {...config,after,before,complete:true,pages:1,rows:calls===3?[{orderId:'fixture-sale',itemId:'fixture-item',asin:target.asin,sellerSku:target.sellerSku,createdAt:'2026-11-09T04:23:03.695Z',updatedAt:'2026-11-09T04:30:00Z',status:'SHIPPED',quantity:1,fulfillment:'AMAZON'}]:[]};
 }});
 const engine=createCloudSalesAutomation({store,sales,now:()=>at,transport:{send:async m=>{sent.push(m);return {status:'smtp_accepted'};}}});
 assert.deepEqual(await engine.run(),{status:'complete'});assert.equal(calls,3);assert.equal(sent.length,1);assert.match(sent[0].subject,/販売/);assert.doesNotMatch(sent[0].subject,/止まっています/);
 const result=await store.read();assert.equal(result.salesAutomationJob.sales.passes,3);assert.ok(Date.parse(result.salesTracking.checkedThrough)>=Date.parse(at)-15*60000);
 await engine.run();assert.equal(sent.length,1);
});

test('adding a stock or plan alias for an already tracked SKU does not rewind or lose history',async()=>{
 const old={sourceId:'stock:a',asin:'B000TEST01',sellerSku:'same',startedAt:start},through='2026-11-09T00:00:00Z';
 const store=memory({version:1,catalog:[],links:[],listings:[],logs:[],amazonAccountKey:config.accountKey,amazonSellerId:config.sellerId,
  salesTracking:{...config,startedAt:start,checkedThrough:through,trackers:[old],orders:[],events:[{id:'existing',delivery:'smtp_accepted'}],sync:{status:'complete'}}});
 const sales=createCloudSales({store,config,now:()=>at,readTargets:async()=>({...config,targets:[old,{...old,sourceId:'plan:b'}]})});
 await sales.start({});const state=await store.read();assert.equal(state.salesTracking.checkedThrough,through);assert.equal(state.salesTracking.trackers.length,2);assert.equal(state.salesTracking.events[0].delivery,'smtp_accepted');
});

test('a bounded incomplete catch-up is partial with a retained cursor, not a false API failure',async()=>{
 let tracking={checkedThrough:start,sync:{status:'complete'}},calls=0;
 const result=await catchUpSales({sales:{start:async()=>{},check:async()=>{calls++;tracking.checkedThrough=new Date(Date.parse(tracking.checkedThrough)+86400000).toISOString();}},readState:async()=>({salesTracking:tracking}),now:()=>at,elapsed:()=>0,maxPasses:2});
 assert.equal(result.status,'partial');assert.equal(calls,2);assert.equal(result.checkedThrough,tracking.checkedThrough);assert.match(result.note,/補完中/);
 let clock=0;calls=0;const timed=await catchUpSales({sales:{start:async()=>{clock=120001;},check:async()=>calls++},readState:async()=>({salesTracking:tracking}),now:()=>at,elapsed:()=>clock});assert.equal(timed.status,'partial');assert.equal(calls,0);
});

test('page limits narrow the range and can resume within the same cycle; real errors still fail',async()=>{
 let calls=0,tracking={checkedThrough:start,sync:{status:'complete'}};
 const result=await catchUpSales({sales:{start:async()=>{},check:async()=>{calls++;tracking=calls===1?{...tracking,windowMs:86400000,sync:{status:'failed',errorCode:'SALES_PAGE_LIMIT'}}:{...tracking,checkedThrough:at,sync:{status:'complete'}};}},readState:async()=>({salesTracking:tracking}),now:()=>at,elapsed:()=>0});assert.equal(result.status,'complete');assert.equal(calls,2);
 tracking.sync={status:'failed'};await assert.rejects(catchUpSales({sales:{start:async()=>{},check:async()=>{}},readState:async()=>({salesTracking:tracking}),now:()=>at}),/販売取得/);
});

const id='a1234567890',previousAt='2026-11-09T00:00:00Z',currentAt='2026-11-10T00:00:00Z';
const listing=(quantity,patch={})=>({listingId:id,status:'active',verified:true,quantity,checkedAt:currentAt,...patch});
const row=y=>({title:'Fixture monitor',asin:'B000TEST01',yahoo:[y]});
const qty=(state,y,enabled=true,old=[])=>collectYahooQuantityAlerts(state,[row(y)],{yahooAlerts:enabled},currentAt,old);

test('Yahoo display quantity changes are recorded once and are not represented as confirmed sales',()=>{
 const state={signals:{},pendingAlerts:[]},old=[listing(4,{checkedAt:previousAt})];
 const alerts=qty(state,listing(3),true,old);assert.equal(alerts.length,1);assert.match(alerts[0].message,/4個 → 3個/);assert.match(alerts[0].message,/販売の確定数ではありません/);
 state.pendingAlerts[0].queuedAt=currentAt;assert.equal(qty(state,listing(3)).length,0);assert.equal(state.pendingAlerts.length,1);
 const increased=qty(state,listing(5,{checkedAt:'2026-11-10T00:00:01Z'}));assert.equal(increased.length,1);assert.match(increased[0].message,/3個 → 5個/);assert.equal(state.signals[state.pendingAlerts[0].key].active,false);
});

test('unknown, stale and out-of-order Yahoo values do not become zero or erase the known baseline',()=>{
 const state={signals:{},pendingAlerts:[]};qty(state,listing(4));
 for(const bad of [listing(null,{verified:false}),listing(0,{checkedAt:'2026-11-07T00:00:00Z'}),listing(0,{checkedAt:'2026-11-09T23:00:00Z'}),listing(0,{checkedAt:'2026-11-11T00:00:00Z'})])assert.equal(qty(state,bad).length,0);
 assert.equal(state.signals[`yahoo-quantity-base:${id}`].quantity,4);
 const alert=qty(state,listing(2,{checkedAt:'2026-11-10T00:00:01Z'}));assert.equal(alert.length,1);assert.equal(alert[0].quantityFrom,4);
});

test('first observations and disabled Yahoo notices seed a baseline without retrospective notices',()=>{
 const state={signals:{},pendingAlerts:[]};assert.equal(qty(state,listing(8)).length,0);assert.equal(qty(state,listing(6,{checkedAt:'2026-11-10T00:00:01Z'}),false).length,0);assert.equal(qty(state,listing(6,{checkedAt:'2026-11-10T00:00:02Z'})).length,0);assert.equal(state.pendingAlerts.length,0);
});

test('Yahoo fetch failures hold a queued quantity notice, while a confirmed end invalidates it',()=>{
 const state={signals:{},pendingAlerts:[]};qty(state,listing(3),true,[listing(4,{checkedAt:previousAt})]);const p=state.pendingAlerts[0];p.queuedAt=currentAt;
 qty(state,listing(null,{verified:false,status:'unknown',checkedAt:'2026-11-10T00:00:01Z'}));assert.equal(state.signals[p.key].known,false);
 qty(state,listing(3,{status:'ended',checkedAt:'2026-11-10T00:00:02Z'}));assert.equal(state.signals[p.key].active,false);assert.equal(state.signals[p.key].known,true);
});

test('a Yahoo quantity change reaches the durable notification dispatcher once without a stock mutation',async()=>{
 const initial={version:1,catalog:[],links:[],listings:[],logs:[],physicalQuantity:24,salesAutomation:{enabled:true,enabledAt:start,yahooAlerts:true,errorAlerts:true},
  salesTracking:{...config,startedAt:start,checkedThrough:currentAt,sync:{status:'complete'},trackers:[],orders:[],events:[]}};
 const store=memory(initial),watch={signals:{},pendingAlerts:[]},sent=[];
 const engine=createCloudSalesAutomation({store,now:()=>currentAt,sales:{start:async()=>{},check:async()=>{}},transport:{send:async m=>{sent.push(m);return {status:'smtp_accepted'};}},
  monitoring:{run:async({settings,enqueueAlerts})=>{const alerts=qty(watch,listing(3),settings.yahooAlerts,[listing(4,{checkedAt:previousAt})]);if(alerts.length){await enqueueAlerts(alerts);alerts.forEach(p=>p.queuedAt=currentAt);}return {status:'complete'};}},readAlertStates:async()=>Object.fromEntries(watch.pendingAlerts.map(p=>[p.id,watch.signals[p.key]?.active]))});
 await engine.run();await engine.run();assert.equal(sent.length,1);assert.match(sent[0].text,/4個 → 3個/);const final=await store.read();assert.equal(final.physicalQuantity,24);assert.equal(final.salesTracking.orders.length,0);assert.equal(final.mailOutbox[0].status,'smtp_accepted');
});
