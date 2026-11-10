import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {riskSettings,stockRisk,riskQuantity,relistingAssessment} from '../src/stock-risk.js';
import {collectProductAlerts} from '../src/product-alerts.js';
import {createProductMonitoring} from '../src/product-monitoring.js';
import {createProductOverview,ruleFields,emptyProductWatch} from '../src/product-overview.js';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';
import {createCloudHandler} from '../src/cloud-handler.js';
const at='2026-11-07T01:00:00.000Z',settings={enabled:true,stockAlerts:true,yahooAlerts:true,errorAlerts:true,reviewAlerts:true},sku='OWN-USED',asin='B000TEST01';
const rule=(patch={})=>({key:'stock:one',tags:[],replenishEnabled:false,threshold:10,minimumSales7:1000,coverageDays:0,reviewDays:10,startedOn:'',note:'',...patch});
function row(patch={}){return {key:'stock:one',title:'警告用モニター',asin,sellerSku:sku,condition:'used',unit:'台',sourceKeys:['stock:one'],sources:['stock'],stockIds:['one'],locations:[{locationId:'home',usable:2,reserved:9,unusable:4,checkedAt:at},{locationId:'container',usable:0,reserved:4,checkedAt:at}],localAvailable:2,fba:{status:'complete',sellerSku:sku,quantity:5,checkedAt:at},channels:{merchant:{state:'active',quantity:3,skus:['OWN-MERCHANT'],checkedAt:at}},plans:[],tags:[],yahoo:[],replenishment:false,sales:{fbaQuantity7:null},rule:rule({lowStock:{source:'fba',threshold:5}}),...patch};}
function memory(initial){let state=structuredClone(initial),revision=0;return{read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision}={})=>{if(expectedRevision!==undefined&&expectedRevision!==revision)throw Object.assign(new Error('conflict'),{code:'STORAGE_CONFLICT'});const copy=structuredClone(state),r=await fn(copy);state=copy;revision++;return r;}};}
const clone=v=>structuredClone(v);
function service(){const physical={version:1,products:[{id:'one',title:'警告用モニター',asin,sellerSku:sku,condition:'used',unit:'台',linkedLinkIds:[]}],balances:[{productId:'one',locationId:'home',usable:2,reserved:0,unusable:0,checkedAt:at}],transfers:[],events:[],receipts:[]};const monitor={amazonAccountKey:'fixture',amazonSellerId:'OWN',links:[],catalog:[],listings:[],events:[],logs:[],mailOutbox:[],salesAutomation:{...settings,enabledAt:at},salesTracking:{checkedThrough:at,sync:{status:'complete'},events:[],orders:[],trackers:[]}};const watch=emptyProductWatch();watch.rules=[rule({lowStock:{source:'home',threshold:3}})];const stores={monitorStore:memory(monitor),stockStore:memory(physical),planningStore:memory({plans:[]}),watchStore:memory(watch)};return{...stores,overview:createProductOverview({...stores,now:()=>at}),now:()=>at};}

test('risk settings distinguish blank, zero, positive and partially configured values without defaults',()=>{
 for(const source of ['','fba','merchant','home','container'])for(const threshold of [null,0,5])assert.deepEqual(riskSettings({source,threshold}),{source,threshold});
 for(const bad of [null,{},[],{source:'all',threshold:5},{source:'fba',threshold:-1},{source:'fba',threshold:0.5},{source:'fba',threshold:1000001}])assert.throws(()=>riskSettings(bad));
 const original=rule(),copy=clone(original);assert.equal(ruleFields(original,at).lowStock,undefined);assert.deepEqual(original,copy);
 for(const lowStock of [{source:'',threshold:5},{source:'fba',threshold:null}])assert.equal(stockRisk(row({rule:rule({lowStock})}),at).configured,false);
});
test('low remaining stock ignores replenishment source stock and sales minimums',()=>{
 const r=row({localAvailable:0}),watch=emptyProductWatch(),alerts=collectProductAlerts(watch,[r],settings,at);
 assert.equal(alerts.length,1);assert.match(alerts[0].key,/^low-stock:/);assert.match(alerts[0].message,/5個以下/);assert.match(alerts[0].message,/OWN-USED/);assert.match(alerts[0].message,/Amazon取得値/);
});
test('custom FBA zero emits one notification instead of both legacy zero and custom threshold',()=>{
 const r=row();r.fba.quantity=0;r.rule.lowStock.threshold=0;const alerts=collectProductAlerts(emptyProductWatch(),[r],settings,at);assert.equal(alerts.length,1);assert.match(alerts[0].key,/low-stock:/);
 delete r.rule.lowStock;assert.match(collectProductAlerts(emptyProductWatch(),[r],settings,at)[0].key,/fba-zero:/);
});
test('repeat, unknown, recovery and re-entry have stable distinct notification identities',()=>{
 const r=row(),w=emptyProductWatch();let a=collectProductAlerts(w,[r],settings,at);assert.equal(a.length,1);a[0].queuedAt=at;const first=a[0].id;
 assert.equal(collectProductAlerts(w,[r],settings,at).length,0);r.fba.status='failed';assert.equal(collectProductAlerts(w,[r],settings,at).length,0);
 r.fba.status='complete';assert.equal(collectProductAlerts(w,[r],settings,at).length,0);r.fba.quantity=6;collectProductAlerts(w,[r],settings,at);r.fba.quantity=5;a=collectProductAlerts(w,[r],settings,at);assert.equal(a.length,1);assert.notEqual(a[0].id,first);
});
test('a pending warning is held on unknown and dismissed on recovery or setting change',()=>{
 const r=row(),w=emptyProductWatch();const first=collectProductAlerts(w,[r],settings,at)[0];r.fba.status='failed';assert.deepEqual(collectProductAlerts(w,[r],settings,at),[]);assert.equal(first.dismissedAt,undefined);
 r.fba.status='complete';r.fba.quantity=6;assert.deepEqual(collectProductAlerts(w,[r],settings,at),[]);assert.ok(first.dismissedAt);
 r.fba.quantity=5;r.rule.lowStock.threshold=3;assert.deepEqual(collectProductAlerts(w,[r],settings,at),[]);r.rule.lowStock.threshold=5;assert.equal(collectProductAlerts(w,[r],settings,at).length,1);
});
test('failed, stale, ambiguous, future and SKU-less API quantities never become zero',()=>{
 for(const patch of [{status:'failed'},{status:'ambiguous'},{checkedAt:'2026-11-01T00:00:00Z'},{checkedAt:'2026-11-08T00:00:00Z'},{sellerSku:''},{quantity:null}]){const r=row();Object.assign(r.fba,patch);if(patch.sellerSku==='')r.sellerSku='';assert.equal(riskQuantity(r,'fba',at).quantity,null);assert.equal(collectProductAlerts(emptyProductWatch(),[r],settings,at).length,0);}
});
test('merchant offered quantity requires a single verified fresh SKU and is labelled non-physical',()=>{
 const r=row(),q=riskQuantity(r,'merchant',at);assert.equal(q.quantity,3);assert.equal(q.sku,'OWN-MERCHANT');assert.match(q.basis,/現物残数ではありません/);
 for(const patch of [{skus:['a','b']},{checkedAt:'2026-11-01T00:00:00Z'},{quantity:null},{state:'absent'}]){const r2=clone(r);Object.assign(r2.channels.merchant,patch);assert.equal(riskQuantity(r2,'merchant',at).quantity,null);}
});
test('physical quantities use usable stock only, retain zero and old ledger timestamp without inventing current stock',()=>{
 const r=row();r.locations[0].checkedAt='2026-10-01T00:00:00Z';assert.equal(riskQuantity(r,'home',at).quantity,2);assert.equal(riskQuantity(r,'home',at).status,'recorded');assert.equal(riskQuantity(r,'container',at).quantity,0);r.locations[0].usable=null;assert.equal(riskQuantity(r,'home',at).quantity,null);r.stockIds=[];assert.equal(riskQuantity(r,'container',at).quantity,null);
});
test('same shared rule and references produce one warning, not one per page reference',()=>{
 const r=row(),w=emptyProductWatch();assert.equal(collectProductAlerts(w,[r,clone(r)],settings,at).length,1);
});
test('relisting instruction uses verified end and selected remaining stock without assuming an unsold outcome',()=>{
 const r=row();r.rule.relistStockSource='home';const y={listingId:'d1000000001',status:'ended',verified:true,reason:'unsold',checkedAt:at};r.yahoo=[y];let a=collectProductAlerts(emptyProductWatch(),[r],settings,at).find(p=>p.category==='yahooAlerts');assert.match(a.message,/再出品してください/);assert.match(a.message,/2台/);assert.match(a.message,/台帳と実数/);
 y.reason='unknown';assert.equal(relistingAssessment(r,y,at).candidate,true);r.locations[0].usable=0;assert.equal(relistingAssessment(r,y,at).candidate,false);r.locations[0].usable=null;assert.equal(relistingAssessment(r,y,at).candidate,false);
});
test('active related successor suppresses relisting proposal and missing/unverified listing never means ended',()=>{
 const r=row();r.rule.relistStockSource='merchant';const y={listingId:'d1000000001',status:'ended',verified:true,reason:'unsold',checkedAt:at};r.yahoo=[y,{listingId:'d1000000002',status:'active',verified:true,checkedAt:at}];assert.equal(relistingAssessment(r,y,at).candidate,false);assert.match(relistingAssessment(r,y,at).message,/重複再出品/);
 y.verified=false;r.yahoo=[y];assert.equal(collectProductAlerts(emptyProductWatch(),[r],settings,at).filter(p=>p.category==='yahooAlerts').length,0);
});
test('relisting selector does not infer FBA or offer stock as physical inventory',()=>{
 assert.throws(()=>ruleFields(rule({relistStockSource:'fba'}),at));assert.equal(ruleFields(rule({relistStockSource:''}),at).relistStockSource,'');assert.equal(relistingAssessment(row(),{listingId:'d1000000001'},at).candidate,false);
});
test('configuration save/read/replay and older callers preserve new settings, quantities and dates',async()=>{
 const f=service(),before=await f.stockStore.read(),p=rule({lowStock:{source:'container',threshold:0},relistStockSource:'home'}),command={operationId:randomUUID(),rule:p};
 let view=await f.overview.commit(command,{expectedRevision:0,actor:'owner'});assert.deepEqual(view.rows[0].rule.lowStock,p.lowStock);assert.equal(view.rows[0].rule.relistStockSource,'home');view=await f.overview.commit(command,{expectedRevision:0,actor:'owner'});assert.equal(view.revision,1);
 await assert.rejects(f.overview.commit({operationId:randomUUID(),rule:p},{expectedRevision:0,actor:'owner'}),{code:'STORAGE_CONFLICT'});
 const old=rule({note:'既存画面から更新'});view=await f.overview.commit({operationId:randomUUID(),rule:old},{expectedRevision:1,actor:'owner'});assert.deepEqual(view.rows[0].rule.lowStock,p.lowStock);assert.deepEqual(await f.stockStore.read(),before);
});
test('non-sending preview uses saved inputs only and never changes any document, revision or signal',async()=>{
 const f=service(),before=await Promise.all([f.watchStore.readSnapshot(),f.monitorStore.readSnapshot(),f.stockStore.readSnapshot()]);const result=await f.overview.previewRisks();assert.equal(result.nonSending,true);assert.equal(result.daytimeSchedule,'未設定');assert.equal(result.quantities[0].low,true);assert.equal(result.alerts.length,1);assert.deepEqual(await Promise.all([f.watchStore.readSnapshot(),f.monitorStore.readSnapshot(),f.stockStore.readSnapshot()]),before);
});
test('preview API retains owner and origin protection and allows read-only preview',async()=>{
 const f=service(),origin='https://fixture.example',make=()=>createCloudHandler({config:{origin,authUrl:'https://auth.example',readOnly:true},overview:f.overview,verifyOwner:async r=>({status:r.headers.get('authorization')==='Bearer owner'?200:401,userId:'owner'})});const url=origin+'/api/product-overview/risk-preview';assert.equal((await make()(new Request(url))).status,401);assert.equal((await make()(new Request(url,{headers:{authorization:'Bearer owner',origin:'https://foreign.example'}}))).status,403);assert.equal((await make()(new Request(url,{headers:{authorization:'Bearer owner'}}))).status,200);
});
test('daytime path is disabled for dispatch by default and does not retrieve or queue sales',async()=>{
 const f=service(),calls={sales:0,send:0,monitor:0};const engine=createCloudSalesAutomation({store:f.monitorStore,now:f.now,sales:{start:async()=>calls.sales++,check:async()=>calls.sales++},monitoring:{run:async options=>{calls.monitor++;assert.equal(options.settings.reviewAlerts,false);assert.equal(options.refreshListings,true);assert.equal(options.enqueueAlerts,undefined);return{status:'complete'};}},transport:{send:async()=>{calls.send++;return{status:'smtp_accepted'};}}});const before=await f.monitorStore.readSnapshot();await assert.rejects(engine.runRisks({send:true}),{status:409});assert.deepEqual(await f.monitorStore.readSnapshot(),before);await engine.runRisks();assert.deepEqual(calls,{sales:0,send:0,monitor:1});assert.equal((await f.monitorStore.read()).mailOutbox.length,0);
});
test('isolated enabled risk path dispatches risk mail only, leaving pending daily sales untouched',async()=>{
 const f=service(),sent=[];await f.monitorStore.update(s=>s.mailOutbox.push({id:'daily-sale',key:'daily',kind:'sales',notificationMode:'daily',automation:true,status:'pending',attempts:0,eventIds:[]}));
 const engine=createCloudSalesAutomation({store:f.monitorStore,now:f.now,riskExecutionEnabled:true,sales:{start:async()=>assert.fail('no orders in risk path')},monitoring:{run:async({enqueueAlerts})=>{await enqueueAlerts([{id:'risk-one',category:'stockAlerts',title:'残数警告',asin,message:'残り1個'}]);return{status:'complete'};}},transport:{send:async m=>{sent.push(m);return{status:'smtp_accepted'};}}});await engine.runRisks({send:true});await engine.runRisks({send:true});assert.equal(sent.length,1);assert.match(sent[0].subject,/在庫・出品の警告/);assert.equal((await f.monitorStore.read()).mailOutbox[0].status,'pending');
});
test('daily/risk leases serialize overlapping execution and do not change the other job record',async()=>{
 const f=service();await f.monitorStore.update(s=>s.salesAutomationJob={status:'running',jobId:'daily',leaseUntil:'2026-11-07T02:00:00Z'});const before=await f.monitorStore.read();const e=createCloudSalesAutomation({store:f.monitorStore,now:f.now});assert.deepEqual(await e.runRisks(),{status:'skipped'});assert.deepEqual(await f.monitorStore.read(),before);
});
test('dispatcher holds unknown risk records and cancels resolved ones without sending stale warnings',async()=>{
 const f=service();let states={a:null};const sent=[];await f.monitorStore.update(s=>s.mailOutbox.push({id:'risk-mail',key:'a',kind:'product_alerts',notificationMode:'risk',automation:true,status:'pending',attempts:0,alertIds:['a'],eventIds:[]}));const e=createCloudSalesAutomation({store:f.monitorStore,now:f.now,readAlertStates:async()=>states,transport:{send:async m=>{sent.push(m);return{status:'smtp_accepted'};}}});await e.drain();assert.equal(sent.length,0);states={a:false};await e.drain();const record=(await f.monitorStore.read()).mailOutbox[0];assert.equal(record.status,'cancelled');assert.equal(record.cancelledFor,'conditions_changed');assert.deepEqual(record.cancelledAlertIds,['a']);assert.equal(sent.length,0);
});
test('monitoring reconciles condition-cancelled batches, requeues active members and never revives resolved IDs',async()=>{
 const f=service(),r=(await f.overview.view()).rows[0],key=`low-stock:${r.rule.key}:${r.risk.signature}`;
 await f.watchStore.update(w=>{w.pendingAlerts=[{id:'gone',key:'low-stock:removed',eventKey:'product:gone',queuedAt:at,category:'stockAlerts'},{id:'active',key,eventKey:'product:active',queuedAt:at,category:'stockAlerts'}];w.signals={'low-stock:removed':{active:false,known:true},[key]:{active:true,known:true}};});
 await f.monitorStore.update(s=>s.mailOutbox.push({status:'cancelled',cancelledFor:'conditions_changed',alertIds:['gone','active'],cancelledAlertIds:['gone']}));
 let dispatched=[];const m=createProductMonitoring({overview:f.overview,watchStore:f.watchStore,config:{accountKey:'fixture',sellerId:'OWN'},now:f.now,readInventory:async()=>({complete:true,status:'complete',accountKey:'fixture',sellerId:'OWN',asins:[asin],checkedAt:at,items:[]})});
 await m.run({settings,enqueueAlerts:async alerts=>{dispatched=alerts.map(a=>a.id);return {acceptedAlertIds:dispatched};}});const w=await f.watchStore.read();assert.ok(w.pendingAlerts[0].dismissedAt);assert.deepEqual(dispatched,['active']);assert.ok(w.pendingAlerts[1].queuedAt);assert.equal((await m.alertStates()).active,true);
});

test('conflicting product references never turn recorded stock into a relisting recommendation',()=>{
 const r=row();r.rule.relistStockSource='home';r.referenceIssue=true;const a=relistingAssessment(r,{listingId:'d1000000001',reason:'unsold',status:'ended',verified:true,checkedAt:at},at);assert.equal(a.candidate,false);assert.match(a.message,/紐付けの不一致/);
});
test('master notification off still previews quantities but does not claim queued delivery',async()=>{
 const f=service();await f.monitorStore.update(s=>s.salesAutomation.enabled=false);const preview=await f.overview.previewRisks();assert.equal(preview.notificationEnabled,false);assert.equal(preview.quantities[0].low,true);assert.equal(preview.alerts.length,0);
});
test('SMTP failure cannot retry a stock warning after known recovery',async()=>{
 const f=service(),sent=[];let time=at,states={a:true};await f.monitorStore.update(s=>s.mailOutbox.push({id:'a',key:'a',kind:'product_alerts',notificationMode:'risk',automation:true,status:'pending',attempts:0,alertIds:['a'],eventIds:[]}));const e=createCloudSalesAutomation({store:f.monitorStore,now:()=>time,readAlertStates:async()=>states,transport:{send:async m=>{sent.push(m);return{status:'failed'};}}});await e.drain();assert.equal(sent.length,1);time='2026-11-07T03:00:00Z';states={a:false};await e.drain();assert.equal(sent.length,1);assert.equal((await f.monitorStore.read()).mailOutbox[0].status,'cancelled');
});

test('temporary loss of an inferred SKU does not rearm a warning, but a confirmed different SKU does',()=>{
 const r=row(),w=emptyProductWatch();r.sellerSku='';const first=collectProductAlerts(w,[r],settings,at)[0];first.queuedAt=at;const signature=stockRisk(r,at).signature;
 r.fba={status:'failed',quantity:null,checkedAt:at};assert.equal(stockRisk(r,at).signature,signature);assert.equal(collectProductAlerts(w,[r],settings,at).length,0);
 r.fba={status:'complete',sellerSku:sku,quantity:5,checkedAt:at};assert.equal(collectProductAlerts(w,[r],settings,at).length,0);
 r.fba.sellerSku='DIFFERENT-SKU';const next=collectProductAlerts(w,[r],settings,at);assert.equal(next.length,1);assert.notEqual(next[0].id,first.id);assert.ok(first.dismissedAt);assert.match(next[0].message,/DIFFERENT-SKU/);
});
