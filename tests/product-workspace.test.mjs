import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyMonitor,registerPageLink} from '../src/link-monitor.js';
import {emptyPhysicalStock,applyStockCommand} from '../src/physical-stock.js';
import {emptySalesPlanning,applyPlanningCommand} from '../src/sales-planning.js';
import {productOverview,emptyProductWatch,ruleFields} from '../src/product-overview.js';
import {recordReplenishmentBaselines,replenishmentView} from '../src/replenishment.js';
import {collectProductAlerts} from '../src/product-monitoring.js';
import {createCloudStock,physicalStockView} from '../src/cloud-stock.js';
import {createCloudPlanning} from '../src/cloud-planning.js';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';

const at='2026-11-03T03:00:00.000Z',asin='B000TEST01',sku='OWN-GOOD';
function fixture(){
  const monitor=emptyMonitor(),physical=emptyPhysicalStock(),planning=emptySalesPlanning(),watch=emptyProductWatch(),stockId=randomUUID();
  Object.assign(monitor,{amazonAccountKey:'fixture',amazonSellerId:'OWN'});
  const links=['d1000000001','d1000000002'].map(id=>registerPageLink(monitor,{amazon:asin,yahoo:`https://auctions.yahoo.co.jp/jp/auction/${id}`,submitted:true},at));
  for(const l of monitor.listings)l.title='Shared monitor';
  applyStockCommand(physical,{operationId:randomUUID(),kind:'create',productId:stockId,product:{title:'Reserve monitor',asin,sellerSku:sku,condition:'used',unit:'個',fbaEligibility:'possible',linkedLinkIds:[links[0].id]},initialCounts:{container:15,home:1}},{actor:'owner',at});
  watch.observations.fba={status:'complete',complete:true,accountKey:'fixture',sellerId:'OWN',asins:[asin],checkedAt:at,items:[{asin,sellerSku:sku,condition:'UsedGood',fulfillableQuantity:8}]};
  watch.observations.yahoo=links.map((l,i)=>({listingId:l.listingId,status:'active',verified:true,quantity:i?9:5,checkedAt:at}));
  return {monitor,physical,planning,watch,stockId,links};
}
const inputs=f=>({monitor:f.monitor,physical:f.physical,planning:f.planning,watch:f.watch});
const rule=f=>ruleFields({key:'stock:'+f.stockId,tags:['watch'],replenishEnabled:true,threshold:10,minimumSales7:0,coverageDays:0,reviewDays:14,startedOn:'',note:'',baselineQuantity:20,replenishPercent:50},at);

test('one explicitly associated stock record is shared by verified same-SKU listings without duplicating balances',()=>{
  const f=fixture(),before=structuredClone(f),rows=productOverview(inputs(f),at);
  assert.equal(rows.length,1);const r=rows[0];assert.equal(r.linkIds.length,2);assert.equal(r.stockIds.length,1);
  assert.deepEqual(r.locations.map(l=>l.usable),[15,1]);assert.equal(r.fba.quantity,8);
  assert.equal(r.availability.poolRequired,14);assert.equal(r.availability.level,'danger');
  assert.match(r.availability.message,/FBAより6個多い/);assert.equal(r.workspace.stocks.length,1);
  assert.deepEqual(f,before);
});
test('unassociated same-ASIN stock stays a candidate and different SKUs are never inferred into the shared pool',()=>{
  const f=fixture();f.physical.products[0].linkedLinkIds=[];
  let rows=productOverview(inputs(f),at);assert.equal(rows.length,3);
  assert.equal(rows.find(r=>r.stockIds.length).workspace.linkCandidates.length,2);
  for(const r of rows.filter(r=>r.linkIds.length)){assert.equal(r.locations.length,0);assert.equal(r.workspace.stockCandidates.length,1);}
  f.physical.products[0].condition='parts';rows=productOverview(inputs(f),at);
  assert.equal(rows.find(r=>r.stockIds.length).workspace.linkCandidates.length,0);
  assert.ok(rows.filter(r=>r.linkIds.length).every(r=>r.workspace.stockCandidates[0].mismatch));
  f.physical.products[0].condition='used';
  f.physical.products[0].linkedLinkIds=[f.links[0].id];f.links[1].amazonSellerSku='OWN-VERY-GOOD';
  f.watch.observations.fba.items.push({asin,sellerSku:'OWN-VERY-GOOD',condition:'UsedVeryGood',fulfillableQuantity:2});
  f.links[0].amazonSellerSku=sku;
  rows=productOverview(inputs(f),at);assert.equal(rows.length,2);
  const other=rows.find(r=>r.linkIds.includes(f.links[1].id));assert.equal(other.locations.length,0);assert.equal(other.fba.quantity,2);assert.equal(other.workspace.stockCandidates[0].mismatch,true);
});
test('an existing review remains the same plan across explicit stock and same-SKU listing references',()=>{
  const f=fixture(),id=randomUUID();
  applyPlanningCommand(f.planning,{operationId:randomUUID(),kind:'create',planId:id,plan:{title:'Review this monitor',asin,sellerSku:sku,condition:'used',source:{kind:'stock',id:f.stockId},kind:'amazon',status:'active',durationDays:14,availableOn:'2026-11-01',note:'Keep my dates'}},{actor:'owner',at,sources:[{kind:'stock',id:f.stockId,asin,sellerSku:sku,condition:'used',setContents:''}]});
  const before=structuredClone(f.planning),rows=productOverview(inputs(f),at);
  assert.equal(rows.length,1);assert.equal(rows[0].workspace.plans[0].id,id);assert.equal(rows[0].workspace.links.length,2);assert.deepEqual(f.planning,before);
});
test('stock association options use the current scoped SKU instead of expired legacy FBA metadata',async()=>{
  const f=fixture();f.physical.products[0].linkedLinkIds=[];f.physical.products[0].sellerSku='';
  const view=physicalStockView({state:f.physical,revision:1},f.monitor,at,[],f.watch);
  assert.ok(view.linkOptions.every(l=>l.sellerSku===sku&&l.condition==='UsedGood'));
  let state=structuredClone(f.physical);
  const store={readSnapshot:async()=>({state:structuredClone(state),revision:1}),update:async fn=>fn(state)};
  const engine=createCloudStock({store,monitorStore:{read:async()=>f.monitor},watchStore:{read:async()=>f.watch},now:()=>at});
  const command={operationId:randomUUID(),kind:'edit',productId:f.stockId,product:{...state.products[0],sellerSku:sku,linkedLinkIds:f.links.map(l=>l.id)},reason:'Confirm existing listing'};
  const before=structuredClone(state.balances);await engine.preview(command,{expectedRevision:1,actor:'owner'});
  await engine.commit(command,{expectedRevision:1,actor:'owner',confirmed:true});assert.deepEqual(state.balances,before);assert.equal(state.products.length,1);
  const bad={...command,operationId:randomUUID(),product:{...command.product,sellerSku:'OTHER'}};
  state.products[0].linkedLinkIds=[];await assert.rejects(engine.preview(bad,{expectedRevision:1,actor:'owner'}),{status:409});
});
test('half-stock threshold needs a saved baseline and does not add reserve stock to FBA capacity',()=>{
  const f=fixture();f.watch.rules=[rule(f)];let row=productOverview(inputs(f),at)[0];
  assert.equal(row.replenishment,true);assert.equal(row.replenishmentInfo.baseline,20);assert.equal(row.replenishmentInfo.ratioPercent,40);
  f.watch.observations.fba.items[0].fulfillableQuantity=11;row=productOverview(inputs(f),at)[0];assert.equal(row.replenishment,false);
  f.watch.observations.fba.items[0].fulfillableQuantity=10;row=productOverview(inputs(f),at)[0];assert.equal(row.replenishment,true);
  const alerts=collectProductAlerts(f.watch,[row],{stockAlerts:true},at);assert.equal(alerts.length,1);assert.match(alerts[0].message,/基準20個の50%以下/);assert.match(alerts[0].message,/コンテナ：15個/);
  f.watch.observations.fba.status='failed';row=productOverview(inputs(f),at)[0];assert.equal(row.replenishment,false);assert.equal(row.fba.quantity,null);
});
test('observed larger FBA stock raises the replenishment reference but SKU or configured baseline changes do not inherit it',()=>{
  const f=fixture();f.watch.rules=[rule(f)];f.watch.observations.fba.items[0].fulfillableQuantity=40;
  recordReplenishmentBaselines(f.watch,productOverview(inputs(f),at),at);
  f.watch.observations.fba.items[0].fulfillableQuantity=20;let row=productOverview(inputs(f),at)[0];assert.equal(row.replenishmentInfo.baseline,40);assert.equal(row.replenishment,true);
  const copy={...row,fba:{...row.fba,sellerSku:'OTHER',quantity:11}};assert.equal(replenishmentView(copy,f.watch).baseline,20);assert.equal(replenishmentView(copy,f.watch).due,false);
  f.watch.rules[0].baselineQuantity=8;row=productOverview(inputs(f),at)[0];assert.equal(row.replenishmentInfo.baseline,8);assert.equal(row.replenishment,false);
});
test('replenishment cannot use reserved/unusable or FBA-ineligible stock and ratio inputs reject invented quantities',()=>{
  const f=fixture();f.watch.rules=[rule(f)];f.physical.products[0].fbaEligibility='not_possible';assert.equal(productOverview(inputs(f),at)[0].replenishment,false);
  f.physical.products[0].fbaEligibility='possible';for(const b of f.physical.balances){b.usable=0;b.reserved=10;b.unusable=3;}
  assert.equal(productOverview(inputs(f),at)[0].replenishment,false);
  for(const patch of [{baselineQuantity:null},{baselineQuantity:0},{baselineQuantity:1.5},{replenishPercent:101}])assert.throws(()=>ruleFields({...rule(f),...patch},at));
});
test('planning sources use the shared current SKU and reject a second active plan for the same explicitly linked product',async()=>{
  const f=fixture();let state=f.planning,revision=0;
  const store={read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision}={})=>{assert.equal(expectedRevision,revision);const next=structuredClone(state),result=fn(next);state=next;f.planning=state;revision++;return result;}};
  const overview={view:async()=>({rows:productOverview(inputs(f),at)})};
  const stock={view:async()=>physicalStockView({state:f.physical,revision:1},f.monitor,at,[],f.watch)};
  const engine=createCloudPlanning({store,stock,overview,monitorStore:{read:async()=>f.monitor},now:()=>at});
  let view=await engine.view();const source=view.sources.find(s=>s.kind==='link'&&s.id===f.links[0].id);
  assert.equal(source.sellerSku,sku);assert.equal(source.condition,'used');assert.deepEqual(source.locations.map(l=>l.usable),[15,1]);
  const command={operationId:randomUUID(),kind:'create',planId:randomUUID(),plan:{title:'Keep review',asin,sellerSku:sku,condition:'used',source:{kind:'link',id:f.links[0].id},kind:'amazon',status:'active',durationDays:14,availableOn:'2026-11-01',note:'Preserve'}};
  await engine.commit(command,{expectedRevision:0,actor:'owner'});
  const before=structuredClone(state);
  await assert.rejects(engine.commit({...command,operationId:randomUUID(),planId:randomUUID(),plan:{...command.plan,source:{kind:'link',id:f.links[1].id}}},{expectedRevision:1,actor:'owner'}),{status:409});
  view=await engine.view();assert.equal(view.plans[0].referenceIssue,'');assert.deepEqual(state,before);
});
test('parts stock and multi-SKU selections cannot be associated to a normal used FBA item',async()=>{
  const f=fixture();f.physical.products[0].condition='parts';
  let rows=productOverview(inputs(f),at);assert.equal(rows.find(r=>r.stockIds.length).linkIds.length,0);
  assert.ok(rows.find(r=>r.linkIds.length).workspace.stockCandidates[0].mismatch);
  f.physical.products[0].condition='used';f.physical.products[0].sellerSku='';f.physical.products[0].linkedLinkIds=[];
  f.links[1].amazonSellerSku='OTHER';f.watch.observations.fba.items.push({asin,sellerSku:'OTHER',condition:'UsedVeryGood',fulfillableQuantity:3});f.links[0].amazonSellerSku=sku;
  const engine=createCloudStock({store:{readSnapshot:async()=>({state:f.physical,revision:1})},monitorStore:{read:async()=>f.monitor},watchStore:{read:async()=>f.watch},now:()=>at});
  const command={operationId:randomUUID(),kind:'edit',productId:f.stockId,product:{...f.physical.products[0],linkedLinkIds:f.links.map(l=>l.id)},reason:'Do not mix'};
  const before=structuredClone(f.physical);await assert.rejects(engine.preview(command,{expectedRevision:1,actor:'owner'}),{status:409});assert.deepEqual(f.physical,before);
});
test('half-stock replenishment reaches the mail dispatcher once and an observed refill starts a new cycle',async()=>{
  const f=fixture();f.watch.rules=[rule(f)];
  f.monitor.salesAutomation={enabled:true,enabledAt:at,fbaSales:true,merchantSales:true,stockAlerts:true,yahooAlerts:false,reviewAlerts:false,errorAlerts:false};
  f.monitor.salesTracking={startedAt:at,checkedThrough:at,sync:{status:'complete'},events:[],orders:[]};
  const original=structuredClone(f.physical),sent=[];
  const store={read:async()=>structuredClone(f.monitor),update:async fn=>{const next=structuredClone(f.monitor),result=fn(next);f.monitor=next;return result;}};
  const engine=createCloudSalesAutomation({store,sales:{start:async()=>{},check:async()=>{}},now:()=>at,transport:{send:async m=>{sent.push(m);return {status:'smtp_accepted'};}},monitoring:{run:async({settings,enqueueAlerts})=>{
    recordReplenishmentBaselines(f.watch,productOverview(inputs(f),at),at);
    const alerts=collectProductAlerts(f.watch,productOverview(inputs(f),at),settings,at);
    if(alerts.length){await enqueueAlerts(alerts);for(const a of alerts)a.queuedAt=at;}return {status:'complete'};
  }}});
  await engine.run();await engine.run();assert.equal(sent.length,1);assert.match(sent[0].text,/基準20個の50%以下/);assert.match(sent[0].text,/コンテナ：15個/);
  f.watch.observations.fba.status='failed';await engine.run();assert.equal(sent.length,1);
  f.watch.observations.fba.status='complete';f.watch.observations.fba.items[0].fulfillableQuantity=40;await engine.run();assert.equal(sent.length,1);
  f.watch.observations.fba.items[0].fulfillableQuantity=20;await engine.run();assert.equal(sent.length,2);assert.match(sent[1].text,/基準40個の50%以下/);
  assert.deepEqual(f.physical,original);
});
