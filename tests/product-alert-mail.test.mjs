import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {yahooEndMessage,productAlertsMail} from '../src/product-alert-mail.js';
import {relistingAssessment} from '../src/stock-risk.js';
import {collectProductAlerts} from '../src/product-alerts.js';
import {emptyProductWatch,productOverview,createProductOverview} from '../src/product-overview.js';
import {createProductMonitoring} from '../src/product-monitoring.js';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';

const at='2026-11-09T00:51:01.000Z',asin='B000TEST01',sku='OWN-USED';
const settings={enabled:true,yahooAlerts:true,stockAlerts:false,reviewAlerts:false,errorAlerts:true,fbaSales:true,merchantSales:true};
const ended=(patch={})=>({listingId:'d1000000001',status:'ended',verified:true,reason:'sold',unitsPerListing:1,checkedAt:at,...patch});
function row(){const y=ended();return {key:'link:logos',title:'再出品テスト用チェア',asin,sellerSku:sku,condition:'used',sources:['link'],sourceKeys:['link:logos'],stockIds:[],linkConflicts:[],locations:[],unit:'個',rule:{key:'link:logos'},fba:{status:'complete',quantity:8,sellerSku:sku,checkedAt:at},yahoo:[y],plans:[],tags:[],sales:{},localAvailable:null};}
const memory=initial=>{let state=structuredClone(initial);return {read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision:0}),update:async fn=>fn(state)};};

test('ended-listing example says sold ending, eight FBA units and relist, with one inventory link per section',()=>{
 const r=row(),before=structuredClone(r),message=yahooEndMessage(r,r.yahoo[0],at);
 assert.match(message,/終了しました（落札あり）/);assert.match(message,/Amazon FBAに在庫8個あります。ヤフオクへ再出品してください/);
 for(const suffix of ['overview','stock','planning'])assert.equal(message.split('?view='+suffix).length-1,1);
 assert.match(message,/コンテナ・自社在庫：記載なし/);assert.match(message,/販売の監視・見直し：記載なし/);assert.match(message,/取得 2026\/11\/9 9:51:01/);assert.match(message,new RegExp(sku));
 assert.doesNotMatch(message,/再出品するか|売れ残り|最終終了|自動再出品の残り/);assert.deepEqual(r,before);
});
test('unknown auction outcome remains neutral; bids do not turn into a claimed sale',()=>{
 const r=row();for(const reason of ['unknown','unsold']){const message=yahooEndMessage(r,ended({reason,bidCount:1}),at);assert.match(message,/在庫8個/);assert.equal(message.includes('落札あり'),false);assert.equal(message.includes('落札なし'),reason==='unsold');}
});
test('FBA zero, failure, stale, ambiguous and future data never receive the positive eight-unit instruction',()=>{
 for(const patch of [{quantity:0},{status:'unknown'},{status:'failed'},{status:'ambiguous'},{sellerSku:''},{checkedAt:'2026-11-01T00:00:00Z'},{checkedAt:'2026-11-10T00:00:00Z'}]){
  const r=row();Object.assign(r.fba,patch);if(patch.sellerSku==='')r.sellerSku='';const a=relistingAssessment(r,r.yahoo[0],at);assert.equal(a.candidate,false);assert.doesNotMatch(a.message,/在庫8個あります/);
 }
});
test('fresh manual number is labelled but does not manufacture an API-backed relisting instruction',()=>{
 const r=row();r.fba.status='failed';r.availability={fba:{source:'manual',quantity:8,checkedAt:at}};const message=yahooEndMessage(r,r.yahoo[0],at);
 assert.match(message,/FBA在庫を再取得/);assert.match(message,/取得値なし.*手入力8個/);assert.doesNotMatch(message,/FBAに在庫8個あります/);
});
test('another active or unresolved related listing prevents duplicate relisting advice',()=>{
 for(const patch of [{status:'active',verified:true},{status:'unknown',verified:false},{status:'ended',verified:true,checkedAt:'2026-11-01T00:00:00Z'}]){
  const r=row();r.yahoo.push(ended({listingId:'d1000000002',...patch}));const a=relistingAssessment(r,r.yahoo[0],at);assert.equal(a.candidate,false);assert.match(a.message,/重複再出品/);
 }
});
test('explicit stock source and units per listing are respected instead of falling back to a different pool',()=>{
 const r=row();r.stockIds=['one'];r.rule.relistStockSource='container';r.locations=[{locationId:'container',usable:0,checkedAt:at}];
 assert.equal(relistingAssessment(r,r.yahoo[0],at).candidate,false);r.locations[0].usable=2;assert.match(relistingAssessment(r,r.yahoo[0],at).message,/台帳と実数/);
 delete r.rule.relistStockSource;r.yahoo[0].unitsPerListing=9;assert.equal(relistingAssessment(r,r.yahoo[0],at).candidate,false);
});
test('physical zero, missing quantity, unregistered stock and review records are distinct',()=>{
 const r=row();r.stockIds=['one'];r.locations=[{locationId:'container',usable:0,checkedAt:at},{locationId:'home',usable:null}];
 r.plans=[{id:'existing-plan',schedule:{dueOn:'2026-11-20'},actionSchedules:[]}];const message=yahooEndMessage(r,r.yahoo[0],at);
 assert.match(message,/コンテナ 0個/);assert.match(message,/自社・自宅 数量未入力/);assert.match(message,/登録1件／次回 2026-11-20/);assert.match(message,/#id=existing-plan/);assert.doesNotMatch(message,/記載なし/);
});
test('unverified or future endings do not create alerts and repeated endings keep one ID',()=>{
 const r=row(),watch=emptyProductWatch();for(const patch of [{verified:false},{checkedAt:'2026-11-10T00:00:00Z'}])assert.equal(collectProductAlerts(watch,[{...r,yahoo:[ended(patch)]}],settings,at).length,0);
 const alerts=collectProductAlerts(watch,[r],settings,at);assert.equal(alerts.length,1);const first=alerts[0].id;assert.equal(collectProductAlerts(watch,[r],settings,at)[0].id,first);assert.equal(alerts[0].mailFormat,'yahoo-ended-v1');
});
test('grouped mail removes boilerplate and keeps legacy message contents',()=>{
 const r=row(),alert=collectProductAlerts(emptyProductWatch(),[r],settings,at)[0],message=productAlertsMail([alert],{at});assert.match(message,new RegExp(asin));assert.equal(message.split('確認：').length-1,1);assert.doesNotMatch(message,/日次確認で対応|数量・出品・広告は/);
 const mixed=productAlertsMail([alert,{title:'見直し',at,message:'期限11/20'}],{at});assert.match(mixed,/期限11\/20/);
 const legacy=productAlertsMail([{title:'従来の警告',at,message:'FBA0'}],{at});assert.match(legacy,/FBA0/);assert.doesNotMatch(legacy,/日次確認で対応/);
});
test('mocked daily monitoring queues the concise observed inventory once and leaves business records unchanged',async()=>{
 const linkId=randomUUID(),watch=emptyProductWatch(),monitor={amazonAccountKey:'fixture',amazonSellerId:'OWN',links:[{id:linkId,asin,listingId:'d1000000001',amazonSellerSku:sku,verified:true}],catalog:[],listings:[{listingId:'d1000000001',title:row().title,seller:'owner'}],salesAutomation:settings,salesTracking:{events:[],orders:[],trackers:[],sync:{status:'complete'},checkedThrough:at},mailOutbox:[],events:[],logs:[]};
 const stockStore=memory({products:[],balances:[],transfers:[]}),planningStore=memory({plans:[]}),watchStore=memory(watch),monitorStore=memory(monitor),beforeStock=await stockStore.read(),beforePlans=await planningStore.read();
 const overview=createProductOverview({monitorStore,watchStore,stockStore,planningStore,now:()=>at});
 const monitoring=createProductMonitoring({overview,watchStore,config:{accountKey:'fixture',sellerId:'OWN'},now:()=>at,readInventory:async()=>({status:'complete',complete:true,accountKey:'fixture',sellerId:'OWN',asins:[asin],checkedAt:at,items:[{asin,sellerSku:sku,condition:'UsedGood',fulfillableQuantity:8}]}),readYahoo:async()=>({listingId:'d1000000001',seller:'owner',references:[],observation:{...ended(),checkedAt:at}})});
 const deliveries=[],engine=createCloudSalesAutomation({store:monitorStore,monitoring,readInventory:()=>overview.view(),readAlertStates:monitoring.alertStates,sales:{start:async()=>{},check:async()=>{}},transport:{send:async message=>{deliveries.push(message);return{status:'smtp_accepted'};}},now:()=>at});
 assert.equal((await engine.run()).status,'complete');assert.equal((await engine.run()).status,'complete');assert.equal(deliveries.length,1);assert.match(deliveries[0].text,/在庫8個.*再出品してください/);assert.match(deliveries[0].text,/落札あり/);assert.equal((await monitorStore.read()).mailOutbox.length,1);assert.deepEqual(await stockStore.read(),beforeStock);assert.deepEqual(await planningStore.read(),beforePlans);assert.deepEqual((await monitorStore.read()).salesTracking,monitor.salesTracking);
 const before=await overview.inputs();const rows=productOverview(before,at);assert.equal(rows[0].fba.quantity,8);assert.equal(rows[0].yahoo[0].status,'ended');
});
