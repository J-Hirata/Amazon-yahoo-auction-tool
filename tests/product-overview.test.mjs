import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {productOverview,emptyProductWatch,createProductOverview,ruleFields} from "../src/product-overview.js";
import {collectProductAlerts,createProductMonitoring} from "../src/product-monitoring.js";
import {createCloudHandler} from "../src/cloud-handler.js";
import {parseYahooPage} from "../src/yahoo-observation.js";

const at="2026-11-02T06:00:00.000Z",stockId=randomUUID(),linkId=randomUUID(),planId=randomUUID(),asin="B000TEST01",sku="OWN-USED";
function fixture(){
  const physical={version:1,products:[{id:stockId,title:"大きなテストモニター",asin,sellerSku:sku,condition:"used",linkedLinkIds:[linkId]}],balances:[{productId:stockId,locationId:"container",usable:50,reserved:0,unusable:0,checkedAt:at}],transfers:[],events:[],receipts:[]};
  const monitor={version:1,amazonAccountKey:"fixture",amazonSellerId:"OWN",links:[{id:linkId,asin,matchBy:"asin",verified:true,listingId:"d1000000001"}],catalog:[],listings:[{listingId:"d1000000001",title:"モニター",seller:"owner"}],events:[],logs:[],
    salesTargets:{targets:[{sourceId:`stock:${stockId}`,asin,sellerSku:sku,fulfillment:["AMAZON"]}]},
    salesTracking:{startedAt:"2026-10-01T00:00:00Z",sync:{status:"complete"},checkedThrough:at,trackers:[{sourceId:`stock:${stockId}`,asin,sellerSku:sku,startedAt:"2026-10-01T00:00:00Z"}],orders:[{asin,sellerSku:sku,createdAt:"2026-11-01T00:00:00Z",confirmedQuantity:7,status:"SHIPPED",fulfillment:"AMAZON"}]}};
  const planning={plans:[{id:planId,title:"同じモニター",asin,sellerSku:sku,condition:"used",source:{kind:"stock",id:stockId},kind:"amazon",status:"active",availableOn:"2026-10-23",durationDays:10}]};
  const watch=emptyProductWatch();watch.observations.fba={status:"complete",complete:true,accountKey:"fixture",sellerId:"OWN",checkedAt:at,asins:[asin],items:[{asin,sellerSku:sku,condition:"UsedGood",fulfillableQuantity:10,reservedQuantity:0}]};watch.observations.yahoo=[{listingId:"d1000000001",verified:true,status:"active",checkedAt:at}];
  watch.rules=[ruleFields({key:`stock:${stockId}`,tags:["watch","large"],replenishEnabled:true,threshold:10,minimumSales7:1,coverageDays:14,startedOn:"",reviewDays:10,note:""},at)];return {physical,monitor,planning,watch,drafts:[]};
}
const settings={stockAlerts:true,yahooAlerts:true,reviewAlerts:true,errorAlerts:true};
test("closed public auctions with explicitly zero bids are unsold; bids do not prove a completed sale",()=>{
  for(const bids of [0,2,undefined]){const item={auctionId:"d1000000001",status:"closed",bids,title:"試験",description:[]},html=`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialState:{item:{detail:{item}}}}}})}</script>`;assert.equal(parseYahooPage(html,"https://auctions.yahoo.co.jp/jp/auction/d1000000001",at).observation.reason,bids===0?"unsold":"unknown");}
});
test("overview merges only explicit references, preserves separate locations, and computes FBA coverage",()=>{
  const f=fixture(),before=structuredClone(f),rows=productOverview(f,at);assert.equal(rows.length,1);const r=rows[0];assert.deepEqual(r.sources,["stock","link","plan"]);assert.equal(r.localAvailable,50);assert.equal(r.fba.quantity,10);assert.equal(r.sales.quantity7,7);assert.equal(r.daysRemaining,10);assert.equal(r.replenishment,true);assert.ok(r.badges.includes("container"));assert.deepEqual(f,before);
});

test('a tracked baseline is projected and alerts explicitly say estimated without manufacturing an Amazon read',()=>{
 const f=fixture();f.planning.plans=[];f.watch.observations.fba.status='failed';f.watch.observations.fba.complete=false;
 f.monitor.inventoryReviews=[{key:'stock:'+stockId,asin,sellerSku:sku,condition:'used',mode:'manual',manualFbaQuantity:0,checkedAt:at}];
 const rows=productOverview(f,at);assert.equal(rows[0].availability.fba.quantity,0);assert.equal(rows[0].availability.fba.source,'estimate');assert.equal(rows[0].fba.quantity,null);assert.equal(rows[0].fba.status,'unknown');
 const alerts=collectProductAlerts(f.watch,rows,{...settings,reviewAlerts:false},at);assert.equal(alerts.length,2);assert.ok(alerts.every(a=>/推定残数/.test(a.message)));
});
test("same ASIN is not enough to merge unlinked stock, manual plans, drafts or different conditions",()=>{
  const f=fixture();f.planning.plans.push({...f.planning.plans[0],id:randomUUID(),source:{kind:"manual",id:""},condition:"new"});f.drafts=[{asin,title:"下書き"}];f.physical.products.push({...f.physical.products[0],id:randomUUID(),condition:"new",linkedLinkIds:[]});assert.equal(productOverview(f,at).length,4);
});

test('selected seller SKU overrides old broad sales targets and exposes the precise condition',()=>{
 const f=fixture();f.physical.products=[];f.planning.plans=[];f.monitor.links[0].amazonSellerSku='VERY-GOOD';
 f.monitor.salesTargets.targets=[{sourceId:'link:'+linkId,sellerSku:sku,fulfillment:['AMAZON']}];
 f.watch.observations.fba.items.push({asin,sellerSku:'VERY-GOOD',condition:'UsedVeryGood',fulfillableQuantity:2});
 const r=productOverview(f,at)[0];assert.equal(r.fba.quantity,2);assert.equal(r.availability.sku,'VERY-GOOD');assert.equal(r.availability.condition,'中古・非常に良い');
});

test('one physical item without a SKU is not assigned arbitrarily to two different linked grades',()=>{
 const f=fixture();f.planning.plans=[];f.physical.products[0].sellerSku='';f.monitor.links[0].amazonSellerSku=sku;
 const second={...f.monitor.links[0],id:randomUUID(),listingId:'d1000000002',amazonSellerSku:'VERY-GOOD'};f.monitor.links.push(second);f.physical.products[0].linkedLinkIds.push(second.id);
 f.monitor.listings.push({listingId:second.listingId,title:'別のグレード'});
 const rows=productOverview(f,at);assert.equal(rows.length,3);const stock=rows.find(r=>r.key==='stock:'+stockId);assert.equal(stock.sellerSku,'');assert.equal(stock.linkConflicts.length,2);assert.match(stock.availability.message,/紐付け先/);
 assert.deepEqual(rows.filter(r=>r.sources.includes('link')).map(r=>r.sellerSku).sort(),['VERY-GOOD',sku].sort());
});

test('newer failed Yahoo reads replace old successful observations and preserve quantity unknown',()=>{
 const f=fixture();f.monitor.listings[0].observation={status:'active',verified:true,quantity:7,checkedAt:'2026-11-02T05:00:00Z'};
 f.watch.observations.yahoo[0]={listingId:'d1000000001',status:'unknown',verified:false,checkedAt:at};
 assert.equal(productOverview(f,at)[0].availability.yahoo[0].quantity,null);
});

test('known plan SKUs stay separate from an unresolved source SKU and preserve physical counts',()=>{
 const f=fixture();f.physical.products[0].sellerSku='';f.physical.products[0].linkedLinkIds=[];f.monitor.links=[];
 f.planning.plans.push({...f.planning.plans[0],id:randomUUID(),sellerSku:'VERY-GOOD'});
 const before=structuredClone(f),rows=productOverview(f,at),stock=rows.find(r=>r.key==='stock:'+stockId);
 assert.equal(rows.length,3);assert.equal(stock.sellerSku,'');assert.equal(stock.plans.length,0);assert.equal(stock.localAvailable,50);
 assert.deepEqual(rows.filter(r=>r.plans.length).map(r=>r.sellerSku).sort(),['VERY-GOOD',sku].sort());
 assert.ok(rows.filter(r=>r.plans.length).every(r=>r.referenceIssue&&r.locations.length===0));assert.deepEqual(f,before);
});

test('a draft does not inherit another record\'s FBA SKU, stock warning or required action',()=>{
 const f=fixture();f.drafts=[{asin,title:'未出品の下書き'}];f.watch.observations.fba.items[0].fulfillableQuantity=0;
 const draft=productOverview(f,at).find(r=>r.sources.every(s=>s==='draft'));
 assert.equal(draft.fba.quantity,null);assert.equal(draft.availability.sku,'');assert.equal(draft.availability.level,'none');assert.deepEqual(draft.attention,[]);
});
test("unknown, failed, stale and missing FBA are never presented as quantity zero",()=>{
  for(const patch of [{status:"failed"},{checkedAt:"2026-10-01T00:00:00Z"},{items:[]},{accountKey:"other"}]){const f=fixture();Object.assign(f.watch.observations.fba,patch);const r=productOverview(f,at)[0];assert.equal(r.fba.quantity,null);assert.equal(r.replenishment,false);collectProductAlerts(f.watch,[r],settings,at);assert.ok(!(f.watch.pendingAlerts||[]).some(a=>a.key.startsWith("fba-zero")));}
});
test("seven-day estimates need full coverage and use FBA sales, not merchant shipments",()=>{
  const f=fixture();f.monitor.salesTracking.orders[0].fulfillment="MERCHANT";let r=productOverview(f,at)[0];assert.equal(r.sales.quantity7,7);assert.equal(r.sales.fbaQuantity7,0);assert.equal(r.daysRemaining,null);assert.equal(r.replenishment,false);
  f.monitor.salesTracking.trackers[0].startedAt="2026-11-01T00:00:00Z";r=productOverview(f,at)[0];assert.equal(r.sales.quantity7,null);assert.equal(r.daysRemaining,null);
});
test("replenishment threshold and watch due date are configurable, dates cannot be invented",()=>{
  const f=fixture(),rule=f.watch.rules[0];rule.minimumSales7=0;rule.coverageDays=0;rule.threshold=9;assert.equal(productOverview(f,at)[0].replenishment,false);rule.threshold=10;rule.startedOn="2026-10-23";assert.equal(productOverview(f,at)[0].watchDue,"2026-11-02");
  assert.throws(()=>ruleFields({...rule,startedOn:"2026-11-03"},at));assert.throws(()=>ruleFields({...rule,startedOn:"2026-02-30"},at));assert.throws(()=>ruleFields({...rule,minimumSales7:-1},at));
});
test("zero/low alerts recur only after recovery; unknown does not reset active warnings",()=>{
  const f=fixture();f.watch.observations.fba.items[0].fulfillableQuantity=0;
  collectProductAlerts(f.watch,productOverview(f,at),settings,at);const count=f.watch.pendingAlerts.length;collectProductAlerts(f.watch,productOverview(f,at),settings,at);assert.equal(f.watch.pendingAlerts.length,count);
  f.watch.observations.fba.status="failed";collectProductAlerts(f.watch,productOverview(f,at),settings,at);assert.equal(f.watch.pendingAlerts.length,count);
  f.watch.observations.fba.status="complete";f.watch.observations.fba.items[0].fulfillableQuantity=30;collectProductAlerts(f.watch,productOverview(f,at),settings,at);
  f.watch.observations.fba.items[0].fulfillableQuantity=0;collectProductAlerts(f.watch,productOverview(f,at),settings,at);assert.equal(f.watch.pendingAlerts.length,count+2);
});
test("verified Yahoo end notifies once; unavailable pages never mean ended or unsold",()=>{
  const f=fixture(),y=f.watch.observations.yahoo[0];y.status="unknown";y.verified=false;collectProductAlerts(f.watch,productOverview(f,at),settings,at);assert.ok(!f.watch.pendingAlerts.some(p=>p.category==="yahooAlerts"));
  y.status="ended";y.verified=true;collectProductAlerts(f.watch,productOverview(f,at),settings,at);assert.equal(f.watch.pendingAlerts.filter(p=>p.category==="yahooAlerts").length,1);const message=f.watch.pendingAlerts.find(p=>p.category==="yahooAlerts").message;assert.match(message,/FBAに在庫10個.*再出品してください/);assert.doesNotMatch(message,/落札なし|売れ残り/);
});
test("review notification uses saved dates, excludes waiting/closed and deduplicates linked plans",()=>{
  const f=fixture();collectProductAlerts(f.watch,productOverview(f,at),settings,at);assert.equal(f.watch.pendingAlerts.filter(p=>p.category==="reviewAlerts").length,1);collectProductAlerts(f.watch,productOverview(f,at),settings,at);assert.equal(f.watch.pendingAlerts.filter(p=>p.category==="reviewAlerts").length,1);
  const g=fixture();g.planning.plans[0].availableOn="";collectProductAlerts(g.watch,productOverview(g,at),settings,at);assert.equal(g.watch.pendingAlerts.filter(p=>p.category==="reviewAlerts").length,0);
});
function memory(initial){let state=structuredClone(initial),revision=0;return {read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision}={})=>{if(expectedRevision!==undefined&&expectedRevision!==revision)throw Object.assign(new Error("stale"),{code:"STORAGE_CONFLICT"});const copy=structuredClone(state),result=await fn(copy);state=copy;revision++;return result;}};}
function service(){const f=fixture(),watchStore=memory(f.watch),monitorStore=memory(f.monitor);const overview=createProductOverview({watchStore,monitorStore,stockStore:memory(f.physical),planningStore:memory(f.planning),now:()=>at});return{f,watchStore,monitorStore,overview};}
test("watch-only products can be added without manufacturing stock or altering existing products",async()=>{
  const {overview}=service(),before=await overview.view(),rule={...before.rows[0].rule,key:"watch:"+randomUUID(),asin:"B000NEW001",title:"在庫過多の監視",condition:"new",sellerSku:"",imageUrl:"",replenishEnabled:false};
  const result=await overview.commit({operationId:randomUUID(),rule},{expectedRevision:before.revision,actor:"owner"});assert.equal(result.rows.length,2);assert.equal(result.rows[1].localAvailable,null);assert.equal(result.rows[1].fba.quantity,null);
  await assert.rejects(overview.commit({operationId:randomUUID(),rule},{expectedRevision:before.revision,actor:"owner"}),{code:"STORAGE_CONFLICT"});
});
test("pending product alerts survive a mail-store failure and replay the same alert IDs",async()=>{
  const {overview,watchStore,f}=service(),config={accountKey:"fixture",sellerId:"OWN"};let ids;
  const monitoring=createProductMonitoring({overview,watchStore,config,now:()=>at,readInventory:async()=>f.watch.observations.fba,readYahoo:async()=>({listingId:"d1000000001",seller:"owner",references:[],observation:{verified:true,status:"ended",checkedAt:at}})});
  await assert.rejects(monitoring.run({settings,enqueueAlerts:async alerts=>{ids=alerts.map(a=>a.id);throw new Error("mail storage failed");}}));
  let repeated;await monitoring.run({settings,enqueueAlerts:async alerts=>{repeated=alerts.map(a=>a.id);return {acceptedAlertIds:repeated};}});assert.deepEqual(repeated,ids);assert.ok((await watchStore.read()).pendingAlerts.every(a=>a.queuedAt));
});
test("overview API requires owner, same origin, revision and write permission",async()=>{
  const {overview,monitorStore}=service(),origin="https://fixture.example";
  const make=(readOnly=false)=>createCloudHandler({config:{origin,authUrl:"https://fixture.invalid",readOnly},overview,store:monitorStore,verifyOwner:async r=>({status:r.headers.get("authorization")==="Bearer owner"?200:401,userId:"owner"})});
  assert.equal((await make()(new Request(origin+"/api/product-overview"))).status,401);assert.equal((await make()(new Request(origin+"/api/product-overview",{headers:{authorization:"Bearer owner"}}))).status,200);
  const req=(headers={})=>new Request(origin+"/api/product-overview/operations",{method:"POST",headers:{authorization:"Bearer owner","Content-Type":"application/json",...headers},body:"{}"});
  assert.equal((await make()(req())).status,428);assert.equal((await make(true)(req({"If-Match":'"0"'}))).status,403);assert.equal((await make()(req({Origin:"https://other.example"}))).status,403);
});
