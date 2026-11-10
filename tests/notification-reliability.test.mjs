import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyProductWatch,productOverview} from '../src/product-overview.js';
import {collectProductAlerts} from '../src/product-alerts.js';
import {productAlertsMail} from '../src/product-alert-mail.js';
import {createProductMonitoring} from '../src/product-monitoring.js';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';
import {productAlertContext} from '../src/product-alert-context.js';
const at='2026-11-11T00:00:00.000Z',asin='B000TEST01',sku='OWN-GOOD';
function memory(initial){let state=structuredClone(initial);return {read:async()=>structuredClone(state),update:async fn=>{const copy=structuredClone(state),r=await fn(copy);state=copy;return r;}};}
function fixture(kind='ended'){
 let clock=at;const id=randomUUID(),settings={enabled:true,enabledAt:at,fbaSales:true,merchantSales:true,stockAlerts:kind==='stock',yahooAlerts:kind==='ended',reviewAlerts:false,errorAlerts:false};
 const monitor={amazonAccountKey:'own',amazonSellerId:'OWN',links:[{id,asin,listingId:'d1000000001',amazonSellerSku:sku,verified:true}],catalog:[],listings:[{listingId:'d1000000001',title:'通知対象のモニター',seller:'owner'}],events:[],logs:[],mailOutbox:[],salesAutomation:settings,salesTracking:{events:[],orders:[],trackers:[],sync:{status:'complete'},checkedThrough:at}};
 const watch=emptyProductWatch();watch.observations.fba={status:'complete',complete:true,accountKey:'own',sellerId:'OWN',asins:[asin],checkedAt:at,items:[{asin,sellerSku:sku,condition:'UsedGood',fulfillableQuantity:kind==='stock'?2:8}]};
 watch.observations.yahoo=[{listingId:'d1000000001',status:kind==='ended'?'ended':'active',reason:'unsold',verified:true,checkedAt:at,quantity:1}];
 if(kind==='stock')watch.rules=[{key:'link:'+id,tags:[],replenishEnabled:false,lowStock:{source:'fba',threshold:5}}];
 const fixed={physical:{products:[],balances:[],transfers:[]},planning:{plans:[]},drafts:[]},initial={monitor,watch,...fixed};
 const alerts=collectProductAlerts(watch,productOverview(initial,at),settings,at);assert.equal(alerts.length,1);alerts[0].queuedAt=at;
 monitor.mailOutbox.push({id:'mail',key:'mail',kind:'product_alerts',automation:true,notificationMode:'daily',status:'pending',attempts:0,eventIds:[],alertIds:[alerts[0].id],subject:'通知',text:productAlertsMail(alerts,{at}),createdAt:at});
 const store=memory(monitor),watchStore=memory(watch),inputs=async()=>({monitor:await store.read(),watch:await watchStore.read(),...structuredClone(fixed)}),overview={inputs},monitoring=createProductMonitoring({overview,watchStore,config:{accountKey:'own',sellerId:'OWN'},now:()=>clock});
 const sent=[];let outcome='smtp_accepted';const engine=createCloudSalesAutomation({store,monitoring,readAlertContext:monitoring.deliveryContext,transport:{send:async m=>{sent.push(m);return{status:outcome};}},now:()=>clock});
 return {store,watchStore,inputs,monitoring,overview,engine,sent,id,settings,alertId:alerts[0].id,time:v=>clock=v,outcome:v=>outcome=v};
}
test('a queued ending notice uses current FBA stock on retry instead of its old relisting instruction',async()=>{
 const f=fixture();f.outcome('failed');await f.engine.drain();assert.match(f.sent[0].text,/在庫8個.*再出品してください/);
 f.time('2026-11-11T01:01:00.000Z');await f.watchStore.update(w=>{w.observations.fba.checkedAt='2026-11-11T01:00:00.000Z';w.observations.fba.items[0].fulfillableQuantity=0;});
 f.outcome('smtp_accepted');await f.engine.drain();await f.engine.drain();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/0個.*補充/);assert.doesNotMatch(f.sent[1].text,/在庫8個|ヤフオクへ再出品してください/);
 const m=(await f.store.read()).mailOutbox[0];assert.equal(m.status,'smtp_accepted');assert.equal(m.attempts,2);assert.ok(m.contentHistory.some(h=>h.text.includes('在庫8個')));
});
test('observation-only stock recovery cancels queued low-stock mail even if saved signals still say active',async()=>{
 const f=fixture('stock');await f.watchStore.update(w=>w.observations.fba.items[0].fulfillableQuantity=20);const before=await f.inputs();
 assert.equal((await f.monitoring.deliveryContext()).states[f.alertId],false);assert.deepEqual(await f.inputs(),before);await f.engine.drain();assert.equal(f.sent.length,0);assert.equal((await f.store.read()).mailOutbox[0].cancelledFor,'conditions_changed');
});
test('failed or stale stock is held, never recovered, zero, or delivered from an old active signal',async()=>{
 for(const patch of [{status:'failed',complete:false},{checkedAt:'2026-11-01T00:00:00Z'}]){const f=fixture('stock');await f.watchStore.update(w=>Object.assign(w.observations.fba,patch));await f.engine.drain();assert.equal(f.sent.length,0);assert.equal((await f.store.read()).mailOutbox[0].status,'pending');}
});
test('a removed threshold or a different SKU cannot release an obsolete queued stock alert',async()=>{
 for(const changed of ['rule','sku']){const f=fixture('stock');if(changed==='rule')await f.watchStore.update(w=>w.rules=[]);else{await f.store.update(m=>m.links[0].amazonSellerSku='OTHER');await f.watchStore.update(w=>w.observations.fba.items[0].sellerSku='OTHER');}const context=await f.monitoring.deliveryContext();assert.equal(context.states[f.alertId],false);await f.engine.drain();assert.equal(f.sent.length,0);}
});
test('a concurrent disable is not acknowledged as queued; a later accepted retry keeps the same alert ID',async()=>{
 const f=fixture('stock');await f.store.update(m=>m.mailOutbox=[]);await f.watchStore.update(w=>{delete w.pendingAlerts[0].queuedAt;});
 const monitoring=createProductMonitoring({overview:f.overview,watchStore:f.watchStore,config:{accountKey:'own',sellerId:'OWN'},now:()=>at,readInventory:async()=>({...((await f.watchStore.read()).observations.fba)}),readYahoo:async()=>({listingId:'d1000000001',seller:'owner',references:[],observation:{verified:true,status:'active',checkedAt:at}})});
 await monitoring.run({settings:f.settings,enqueueAlerts:async()=>({acceptedAlertIds:[]})});assert.equal((await f.watchStore.read()).pendingAlerts[0].queuedAt,undefined);
 let accepted;await monitoring.run({settings:f.settings,enqueueAlerts:async alerts=>{accepted=alerts.map(a=>a.id);return{acceptedAlertIds:accepted};}});assert.deepEqual(accepted,[f.alertId]);assert.ok((await f.watchStore.read()).pendingAlerts[0].queuedAt);
});

test('recovery and a new shortage while old mail waits deliver only the current incident',async()=>{
 const f=fixture('stock');
 for(const [time,quantity]of [['2026-11-11T00:05:00.000Z',20],['2026-11-11T00:10:00.000Z',2]]){f.time(time);await f.watchStore.update(async w=>{w.observations.fba.items[0].fulfillableQuantity=quantity;const input=await f.inputs();collectProductAlerts(w,productOverview({...input,watch:w},time),f.settings,time);});}
 const watch=await f.watchStore.read(),current=watch.pendingAlerts.find(a=>a.id!==f.alertId);assert.ok(current);
 await f.store.update(m=>m.mailOutbox.push({...m.mailOutbox[0],id:'new-mail',key:'new-mail',alertIds:[current.id],text:productAlertsMail([current],{at})}));
 await f.engine.drain();await f.engine.drain();assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].alertIds,[current.id]);assert.equal((await f.store.read()).mailOutbox[0].status,'cancelled');
});
