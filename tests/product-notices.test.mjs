import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {activateNoticePolicy,noticeSchedule,dueProductNotices,validateNoticePolicy} from '../src/product-notice-policy.js';
import {createProductNotices} from '../src/product-notices.js';
import {emptyProductWatch,createProductOverview} from '../src/product-overview.js';
import {createProductMonitoring} from '../src/product-monitoring.js';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';
import {productAlertsMail,productAlertsHtml} from '../src/product-alert-mail.js';
import {createCloudHandler} from '../src/cloud-handler.js';
import {createCloudMailTransport} from '../src/cloud-mail.js';

const initialAt='2026-11-12T00:51:21.000Z',asin='B000TEST01',sku='SKU-TEST';
function memory(value){let state=structuredClone(value),revision=0;return {read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,options={})=>{if(options.expectedRevision!==undefined&&options.expectedRevision!==revision)throw Object.assign(new Error('revision'),{status:409});const next=structuredClone(state),result=await fn(next);if(JSON.stringify(next)!==JSON.stringify(state)){state=next;revision++;}return result;}};}
function fixture(kind='stock'){
  let clock=initialAt,quantity=17,inventoryFailure=false,outcome='smtp_accepted',beforeDrain;
  const linkId=randomUUID(),listingId='d1000000001',settings={enabled:true,fbaSales:false,merchantSales:false,errorAlerts:false,stockAlerts:kind==='stock',yahooAlerts:kind==='yahoo',reviewAlerts:true};
  const monitor=memory({amazonAccountKey:'own',amazonSellerId:'OWN',links:[{id:linkId,asin,listingId,amazonSellerSku:sku,verified:true}],catalog:[],listings:[{listingId,title:'試験用商品',seller:'OWN'}],salesAutomation:settings,salesTracking:{startedAt:initialAt,checkedThrough:initialAt,sync:{status:'complete'},events:[],orders:[],trackers:[]},mailOutbox:[],events:[],logs:[]});
  const watch=emptyProductWatch();activateNoticePolicy(watch,initialAt);
  if(kind==='stock')watch.rules=[{key:'link:'+linkId,tags:[],replenishEnabled:false,lowStock:{source:'fba',threshold:30}}];
  if(kind==='review')watch.rules=[{key:'link:'+linkId,tags:[],replenishEnabled:false,startedOn:'2026-11-02',reviewDays:10}];
  const watchStore=memory(watch),stockStore=memory({products:[],balances:[],transfers:[]}),planningStore=memory({plans:[]}),draftStore=memory([]);
  const overview=createProductOverview({monitorStore:monitor,watchStore,stockStore,planningStore,draftStore,now:()=>clock});
  const monitoring=createProductMonitoring({overview,watchStore,config:{accountKey:'own',sellerId:'OWN'},now:()=>clock,
    readInventory:async({asins})=>{if(inventoryFailure)throw Error('offline');return {complete:true,status:'complete',accountKey:'own',sellerId:'OWN',asins,checkedAt:clock,items:[{asin,sellerSku:sku,condition:'UsedGood',fulfillableQuantity:quantity}]};},
    readYahoo:async url=>({listingId:url.split('/').at(-1),seller:'OWN',references:[],observation:{status:'ended',verified:true,reason:'unknown',checkedAt:clock}})});
  const sales={start:async()=>{},check:async()=>monitor.update(m=>{m.salesTracking.checkedThrough=clock;})};
  const sent=[],engine=createCloudSalesAutomation({store:monitor,sales,monitoring,riskExecutionEnabled:true,now:()=>clock,readAlertContext:async()=>{await beforeDrain?.();return monitoring.deliveryContext();},transport:{send:async message=>{sent.push(structuredClone(message));return {status:outcome};}}});
  const notices=createProductNotices({overview,watchStore,now:()=>clock});
  return {monitor,watchStore,stockStore,planningStore,overview,monitoring,notices,engine,sent,linkId,settings,time:at=>clock=at,quantity:n=>quantity=n,failure:v=>inventoryFailure=v,outcome:v=>outcome=v,beforeDrain:fn=>beforeDrain=fn,run:()=>engine.runRisks({send:true})};
}
async function toggle(f,alertId,stopped){const view=await f.notices.view();return f.notices.commit({operationId:randomUUID(),alertId,stopped},{actor:'owner',expectedRevision:view.revision});}

test('the reminder is due on the third Japanese calendar day, independent of clock minutes',()=>{
 const alert={id:randomUUID(),key:'low-stock:test',queuedAt:initialAt},watch=activate({}),monitor={mailOutbox:[{id:'receipt',kind:'product_alerts',alertIds:[alert.id],status:'smtp_accepted',finishedAt:initialAt}]};
 function activate(w){activateNoticePolicy(w,initialAt);return w;}
 assert.equal(noticeSchedule(alert,monitor,watch,'2026-11-14T00:00:00Z').eligible,false);
 const due=noticeSchedule(alert,monitor,watch,'2026-11-15T00:00:00Z');assert.equal(due.eligible,true);assert.equal(due.notificationNumber,2);assert.equal(due.nextOn,'2026-11-15');
 assert.equal(noticeSchedule(alert,monitor,watch,'2026-11-14T15:00:00Z').eligible,true);
});
test('queued, failed and uncertain deliveries never count as received notifications',()=>{
 const alert={id:randomUUID(),key:'low-stock:test',queuedAt:initialAt},watch={};activateNoticePolicy(watch,initialAt);
 for(const status of ['pending','failed','sending','uncertain']){const n=noticeSchedule(alert,{mailOutbox:[{id:'x',kind:'product_alerts',alertIds:[alert.id],status,finishedAt:initialAt,attempts:1}]},watch,'2026-11-18T00:00:00Z');assert.equal(n.deliveredCount,0);assert.equal(n.eligible,false);}
});
test('activation gives old accepted incidents three days without rewriting their count or receipt',()=>{
 const alert={id:randomUUID(),key:'yahoo-ended:x',queuedAt:initialAt},watch={};activateNoticePolicy(watch,initialAt);
 const monitor={mailOutbox:[{id:'old',kind:'product_alerts',alertIds:[alert.id],status:'smtp_accepted',finishedAt:'2026-11-01T00:00:00Z'}]},before=structuredClone(monitor);
 const n=noticeSchedule(alert,monitor,watch,initialAt);assert.equal(n.nextOn,'2026-11-15');assert.equal(n.notificationNumber,2);assert.equal(n.eligible,false);assert.deepEqual(monitor,before);
 assert.equal(noticeSchedule(alert,monitor,{},'2026-11-18T00:00:00Z').eligible,false);
});
test('missing or future accepted timestamps are held, and non-recurring quantity changes stay one-shot',()=>{
 const alert={id:randomUUID(),key:'yahoo-quantity:x',queuedAt:initialAt},watch={};activateNoticePolicy(watch,initialAt);
 for(const finishedAt of [null,'2026-12-01T00:00:00Z',initialAt]){const n=noticeSchedule(alert,{mailOutbox:[{id:'old',kind:'product_alerts',alertIds:[alert.id],status:'smtp_accepted',finishedAt}]},watch,'2026-11-18T00:00:00Z');assert.equal(n.eligible,false);}
});
test('stock notifications are sent as first, second and third deliveries on days 0, 3 and 6',async()=>{
 const f=fixture();await f.run();assert.equal(f.sent.length,1);assert.equal(Object.values(f.sent[0].noticeNumbers)[0],1);
 f.time('2026-11-13T00:00:00Z');await f.run();assert.equal(f.sent.length,1);
 f.time('2026-11-15T00:00:00Z');await f.run();await f.run();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/再案内（3日ごと）/);assert.match(f.sent[1].text,/通知2回目/);assert.match(f.sent[1].html,/通知2回目/);
 f.time('2026-11-18T00:00:00Z');await f.run();assert.equal(f.sent.length,3);assert.match(f.sent[2].text,/通知3回目/);assert.equal((await f.watchStore.read()).pendingAlerts.length,1);
 assert.equal((await f.notices.view()).notices[0].nextOn,'2026-11-21');
});
test('stopping and resuming affects only the current incident and preserves stock and plans',async()=>{
 const f=fixture();await f.run();const id=f.sent[0].alertIds[0],stock=await f.stockStore.read(),plans=await f.planningStore.read();
 await toggle(f,id,true);f.time('2026-11-15T00:00:00Z');await f.run();assert.equal(f.sent.length,1);assert.equal((await f.notices.view()).notices[0].stopped,true);
 await toggle(f,id,false);await f.run();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/通知2回目/);assert.deepEqual(await f.stockStore.read(),stock);assert.deepEqual(await f.planningStore.read(),plans);
});
test('a stop after queuing but before delivery cancels the message and can be resumed',async()=>{
 const f=fixture();await f.run();const id=f.sent[0].alertIds[0];f.time('2026-11-15T00:00:00Z');let stopped=false;
 f.beforeDrain(async()=>{if(!stopped){stopped=true;await toggle(f,id,true);}});await f.run();assert.equal(f.sent.length,1);
 const records=(await f.monitor.read()).mailOutbox;assert.equal(records[1].status,'cancelled');assert.deepEqual(records[1].stoppedAlertIds,[id]);
 f.beforeDrain(null);await toggle(f,id,false);await f.run();assert.equal(f.sent.length,2);assert.equal((await f.watchStore.read()).pendingAlerts.find(a=>a.id===id).dismissedAt,undefined);
});
test('minor decreases remain stopped but a confirmed decrease to zero starts a new first notice',async()=>{
 const f=fixture();await f.run();const first=f.sent[0].alertIds[0];await toggle(f,first,true);
 f.time('2026-11-13T00:00:00Z');f.quantity(16);await f.run();assert.equal(f.sent.length,1);
 f.quantity(0);await f.run();assert.equal(f.sent.length,2);assert.notEqual(f.sent[1].alertIds[0],first);assert.equal(Object.values(f.sent[1].noticeNumbers)[0],1);assert.doesNotMatch(f.sent[1].text,/通知2回目/);
});
test('recovery followed by a new shortage is a separate incident even if the old one was stopped',async()=>{
 const f=fixture();await f.run();const first=f.sent[0].alertIds[0];await toggle(f,first,true);f.quantity(40);await f.run();f.quantity(17);await f.run();assert.equal(f.sent.length,2);assert.notEqual(f.sent[1].alertIds[0],first);
});
test('a stopped legacy signal without a saved last quantity can still rearm on zero',async()=>{
 const f=fixture();await f.run();const first=f.sent[0].alertIds[0];await f.watchStore.update(w=>{for(const signal of Object.values(w.signals))delete signal.lastQuantity;});await toggle(f,first,true);
 assert.equal((await f.watchStore.read()).noticeControls[first].quantityWhenStopped,17);f.quantity(0);await f.run();assert.equal(f.sent.length,2);assert.notEqual(f.sent[1].alertIds[0],first);
});
test('activation baselines also detect zero for legacy incidents before their next normal observation',async()=>{
 const f=fixture();await f.run();const first=f.sent[0].alertIds[0];await f.watchStore.update(w=>{for(const signal of Object.values(w.signals))delete signal.lastQuantity;w.noticePolicy.baselineQuantities={[first]:17};});f.quantity(0);await f.run();assert.equal(f.sent.length,2);assert.notEqual(f.sent[1].alertIds[0],first);
});
test('review dates repeat after three days, can be stopped, and a new date starts a new first notice',async()=>{
 const f=fixture('review');await f.engine.run();assert.equal(f.sent.length,1);const first=f.sent[0].alertIds[0];f.time('2026-11-15T00:00:00Z');await f.engine.run();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/通知2回目/);await toggle(f,first,true);f.time('2026-11-18T00:00:00Z');await f.engine.run();assert.equal(f.sent.length,2);
 await f.watchStore.update(w=>{w.rules[0].reviewDays=20;});f.time('2026-11-22T00:00:00Z');await f.engine.run();assert.equal(f.sent.length,3);assert.notEqual(f.sent[2].alertIds[0],first);assert.equal(Object.values(f.sent[2].noticeNumbers)[0],1);
});
test('unknown stock holds reminders and does not manufacture a recovery or new incident',async()=>{
 const f=fixture();await f.run();const id=f.sent[0].alertIds[0];f.time('2026-11-15T00:00:00Z');f.failure(true);await f.run();assert.equal(f.sent.length,1);f.failure(false);await f.run();assert.equal(f.sent.length,2);assert.equal(f.sent[1].alertIds[0],id);
});
test('an uncertain SMTP result never triggers an automatic reminder or counter increment',async()=>{
 const f=fixture();f.outcome('uncertain');await f.run();f.time('2026-11-18T00:00:00Z');await f.run();assert.equal(f.sent.length,1);const n=(await f.notices.view()).notices[0];assert.equal(n.deliveredCount,0);assert.equal(n.blocked,true);
});
test('failed delivery retries keep the same first-notice number until accepted',async()=>{
 const f=fixture();f.outcome('failed');await f.run();assert.equal((await f.notices.view()).notices[0].deliveredCount,0);f.outcome('smtp_accepted');f.time('2026-11-12T02:00:00Z');await f.run();assert.equal(f.sent.length,2);assert.equal(Object.values(f.sent[1].noticeNumbers)[0],1);assert.equal((await f.notices.view()).notices[0].deliveredCount,1);
});
test('a changed threshold does not inherit the stop on the previous threshold',async()=>{
 const f=fixture();await f.run();const id=f.sent[0].alertIds[0];await toggle(f,id,true);await f.watchStore.update(w=>{w.rules[0].lowStock.threshold=10;});await f.run();assert.equal(f.sent.length,1);f.quantity(10);await f.run();assert.equal(f.sent.length,2);assert.notEqual(f.sent[1].alertIds[0],id);
});
test('an ended listing repeats after three days and its stop does not suppress a new listing ID',async()=>{
 const f=fixture('yahoo');await f.run();f.time('2026-11-15T00:00:00Z');await f.run();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/通知2回目/);const first=f.sent[0].alertIds[0];await toggle(f,first,true);
 await f.monitor.update(m=>{m.links[0].listingId='d1000000002';m.listings=[{listingId:'d1000000002',title:'新しい出品',seller:'OWN'}];});await f.run();assert.equal(f.sent.length,3);assert.notEqual(f.sent[2].alertIds[0],first);
});
test('notice views are read-only, operations replay once, and stale or conflicting commands are rejected',async()=>{
 const f=fixture();await f.run();const view=await f.notices.view(),before=await f.watchStore.readSnapshot();await f.notices.view();assert.deepEqual(await f.watchStore.readSnapshot(),before);
 const command={operationId:randomUUID(),alertId:view.notices[0].id,stopped:true};await f.notices.commit(command,{actor:'owner',expectedRevision:view.revision});const saved=await f.watchStore.readSnapshot();await f.notices.commit(command,{actor:'owner',expectedRevision:view.revision});assert.deepEqual(await f.watchStore.readSnapshot(),saved);
 await assert.rejects(f.notices.commit({...command,stopped:false},{actor:'owner',expectedRevision:view.revision}),{status:409});
 await assert.rejects(f.notices.commit({...command,operationId:randomUUID()},{actor:'owner',expectedRevision:view.revision}),{status:409});
 await assert.rejects(f.notices.commit({...command,operationId:randomUUID(),alertId:randomUUID()},{actor:'owner',expectedRevision:saved.revision}),{status:409});
});
test('notice API preserves owner, Origin, read-only and revision protection; GET never acknowledges',async()=>{
 let writes=0;const verify=async request=>request.headers.get('authorization')?{status:200,userId:'owner'}:{status:401};const make=(readOnly=false)=>createCloudHandler({config:{origin:'https://example.test',authUrl:'https://auth.test',readOnly},store:memory({}),notices:{view:async()=>({notices:[]}),commit:async()=>{writes++;return {};}},verifyIdentity:verify,verifyOwner:verify});
 const req=(method='GET',headers={},body)=>new Request('https://example.test/api/product-overview/notices',{method,headers,...(body?{body}:{} )});
 assert.equal((await make()(req())).status,401);assert.equal((await make()(req('GET',{authorization:'Bearer qa'}))).status,200);assert.equal(writes,0);
 const headers={authorization:'Bearer qa','Content-Type':'application/json'};assert.equal((await make()(req('POST',headers,'{}'))).status,428);assert.equal((await make(true)(req('POST',{...headers,'If-Match':'"0"'},'{}'))).status,403);assert.equal((await make()(req('POST',{...headers,Origin:'https://other.test','If-Match':'"0"'},'{}'))).status,403);
 assert.equal((await make()(req('POST',{...headers,'If-Match':'"0"'},'{"command":{}}'))).status,200);assert.equal(writes,1);
});
test('mixed mail puts same categories together and all reminders below fresh notices',()=>{
 const alert=(kind,title,extra={})=>({id:randomUUID(),key:kind==='relist'?'yahoo-ended:x':kind==='review'?'review-plan:x':'low-stock:x',title,asin,at:initialAt,mailDetails:{kind,lines:['現在の数と次の操作']},...extra});
 const alerts=[alert('relist','再出品A'),alert('stock','残数A'),alert('review','見直しA'),alert('relist','再出品B'),alert('stock','再案内A',{isReminder:true,notificationNumber:2,lastSentAt:initialAt})];
 const text=productAlertsMail(alerts,{at:'2026-11-15T00:00:00Z'});assert.ok(text.indexOf('再出品B')<text.indexOf('残数A'));assert.ok(text.indexOf('見直しA')<text.indexOf('【再案内'));assert.ok(text.indexOf('【再案内')<text.indexOf('再案内A'));assert.equal(text.split('確認：').length-1,1);assert.match(text,/通知2回目/);
 const html=productAlertsHtml([{...alerts[0],title:'<script>alert(1)</script>'}],{at:initialAt});assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/#notice=/);
});
test('SMTP gets a multipart alternative while keeping the fixed recipient and Message-ID',async()=>{
 let captured;const transport=createCloudMailTransport({user:'qa',password:'qa'},{createTransport:()=>({sendMail:async value=>{captured=value;return {accepted:[value.to],rejected:[]};},close(){}})});await transport.send({attemptId:'attempt',subject:'subject',text:'plain',html:'<p>html</p>'});assert.equal(captured.text,'plain');assert.equal(captured.html,'<p>html</p>');assert.equal(captured.messageId,'<attempt@amazon-yahoo-inventory.vercel.app>');assert.equal(captured.from,captured.to);
});
test('notice policy validation is optional for old documents and rejects malformed controls',()=>{
 assert.deepEqual(validateNoticePolicy({}),{});assert.throws(()=>validateNoticePolicy({noticePolicy:{version:1,intervalDays:7,enabledAt:initialAt}}));assert.throws(()=>validateNoticePolicy({noticeControls:{wrong:{stopped:true,at:initialAt}}}));
});
