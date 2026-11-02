import test from "node:test";
import assert from "node:assert/strict";
import {createCloudSalesAutomation,automationView} from "../src/cloud-sales-automation.js";
import {resolveSalesSources} from "../src/sales-sources.js";
import {createVercelEntry} from "../src/vercel-entry.js";
import {createCloudSales} from "../src/cloud-sales.js";

const at="2026-10-30T00:00:00.000Z",later="2026-10-30T02:00:00.000Z";
const config={accountKey:"fixture-account",sellerId:"FIXTURE",marketplaceId:"A1VC38T7YXB528"};
const event=(id,patch={})=>({id,orderId:`o-${id}`,itemId:id,asin:"B000TEST01",sellerSku:"merchant-one",delta:1,kind:"order_confirmed",fulfillment:"MERCHANT",at:later,eligibleFromAt:later,delivery:"preview",...patch});
function fixture(){
  let state={version:1,catalog:[],listings:[],links:[],events:[],logs:[],cloudMail:{status:"verified"},salesTracking:{...config,startedAt:at,trackers:[],orders:[],events:[],sync:{status:"complete"},checkedThrough:later}};
  let revision=1,clock=at,calls=0,outcome="smtp_accepted",sent=[];
  const store={read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision}={})=>{
    if(expectedRevision!==undefined&&expectedRevision!==revision)throw Object.assign(new Error("stale"),{code:"STORAGE_CONFLICT"});
    const copy=structuredClone(state),value=await fn(copy);state=copy;revision++;return value;
  }};
  const transport={send:async message=>{calls++;sent.push(message);return{status:outcome};}};
  const sales={start:async()=>{},check:async()=>{}};
  return {store,transport,sales,now:()=>clock,time:v=>clock=v,revision:()=>revision,calls:()=>calls,sent:()=>sent,outcome:v=>outcome=v};
}
async function enable(f,patch={}){const engine=createCloudSalesAutomation(f);await engine.settings({expectedRevision:f.revision(),enabled:true,fbaSales:true,merchantSales:true,errorAlerts:true,...patch});return engine;}

test("product alert IDs prevent duplicate mail after replay across the watch and mail stores",async()=>{
  const f=fixture();await enable(f,{stockAlerts:true});f.time(later);
  const engine=createCloudSalesAutomation({...f,monitoring:{run:async({enqueueAlerts})=>{await enqueueAlerts([{id:"stable-alert",category:"stockAlerts",title:"補充",asin:"B000TEST01",message:"FBA10個・手元50個"}]);return{status:"complete"};}}});
  await engine.run();await engine.run();assert.equal(f.calls(),1);assert.deepEqual((await f.store.read()).mailOutbox[0].alertIds,["stable-alert"]);
});

test("own seller SKU resolution includes merchant stock/plans without Yahoo and separates condition/SKU",()=>{
  const sources=[{sourceId:"stock:a",asin:"B000TEST01",condition:"used",title:"中古"},{sourceId:"plan:b",asin:"B000TEST02",condition:"new"}];
  const snapshot={...config,status:"complete",source:"own_seller_listings",asins:sources.map(s=>s.asin),checkedAt:at,rows:[{asin:sources[0].asin,sellerSku:"used",condition:"used_good",fulfillment:[{channel:"DEFAULT"}]},{asin:sources[0].asin,sellerSku:"new",condition:"new_new",fulfillment:[{channel:"AMAZON_JP"}]}]};
  const result=resolveSalesSources(sources,snapshot,config);
  assert.equal(result.targets.length,1);assert.deepEqual(result.targets[0].fulfillment,["MERCHANT"]);assert.equal(result.unresolved.length,1);
  assert.throws(()=>resolveSalesSources(sources,{...snapshot,sellerId:"OTHER"},config));
});
test("notifications suppress backfill and disabled category, combine duplicate observations once, and skip empty emails",async()=>{
  const f=fixture(),engine=await enable(f,{fbaSales:false});f.time(later);
  await f.store.update(s=>s.salesTracking.events.push(event("old",{eligibleFromAt:"2026-10-29T00:00:00Z"}),event("new"),event("fba",{fulfillment:"AMAZON"})));
  await engine.queueSales();await engine.queueSales();await engine.drain();await engine.drain();
  const s=await f.store.read();assert.equal(f.calls(),1);assert.equal(s.mailOutbox.length,1);assert.deepEqual(s.mailOutbox[0].eventIds,["new"]);
  assert.equal(s.salesTracking.events[0].delivery,"historical");assert.equal(s.salesTracking.events[2].delivery,"muted");assert.match(f.sent()[0].text,/自社発送/);
});
test("the one test mail uses the real durable dispatcher, never marks a sale, and cannot repeat",async()=>{
  const f=fixture(),engine=createCloudSalesAutomation(f);
  await assert.rejects(engine.test({expectedRevision:f.revision(),confirmed:false}),{status:400});
  await engine.test({expectedRevision:f.revision(),confirmed:true});await engine.test({expectedRevision:f.revision(),confirmed:true});
  assert.equal(f.calls(),1);assert.equal((await f.store.read()).salesTracking.events.length,0);assert.equal((await f.store.read()).salesAutomation,undefined);
});
test("SMTP uncertainty and stale sending records never retry; definite failure has bounded later retries",async()=>{
  for(const outcome of ["failed","uncertain"]){
    const f=fixture(),engine=await enable(f);f.time(later);f.outcome(outcome);
    await f.store.update(s=>s.salesTracking.events.push(event("one")));await engine.queueSales();await engine.drain();await engine.drain();assert.equal(f.calls(),1);
    for(let i=0;i<4;i++){f.time(new Date(Date.parse(later)+(i+1)*3600001).toISOString());await engine.drain();}
    assert.equal(f.calls(),outcome==="failed"?3:1);
  }
  const f=fixture(),engine=await enable(f);f.time(later);
  await f.store.update(s=>s.mailOutbox=[{id:"interrupted",key:"k",automation:true,status:"sending",lastAttemptAt:at,eventIds:[]}]);
  await engine.drain();assert.equal(f.calls(),0);assert.equal((await f.store.read()).mailOutbox[0].status,"uncertain");
});
test("two concurrent dispatchers claim a pending message only once",async()=>{
  const f=fixture(),engine=await enable(f);f.time(later);await f.store.update(s=>s.salesTracking.events.push(event("one")));await engine.queueSales();
  // The production row lock serializes claims. This fixture provides the same property.
  let lock=Promise.resolve();const raw=f.store.update;f.store.update=(...args)=>{const result=lock.then(()=>raw(...args));lock=result.catch(()=>{});return result;};
  await Promise.all([engine.drain(),engine.drain()]);assert.equal(f.calls(),1);
});
test("stopped settings cancel queued messages and failures notify only once per incident",async()=>{
  const f=fixture(),engine=await enable(f);f.time(later);await f.store.update(s=>s.salesTracking.events.push(event("one")));await engine.queueSales();
  await engine.settings({expectedRevision:f.revision(),enabled:false,fbaSales:true,merchantSales:true,errorAlerts:true});await engine.drain();assert.equal(f.calls(),0);assert.equal((await f.store.read()).mailOutbox[0].status,"cancelled");
  await enable(f);f.sales.start=async()=>{throw new Error("private-secret");};
  await engine.run();await engine.run();assert.equal(f.calls(),1);assert.doesNotMatch(JSON.stringify(await f.store.read()),/private-secret/);
});
test("disabled, running and interrupted jobs have explicit states; no work when disabled",async()=>{
  const f=fixture(),engine=createCloudSalesAutomation(f);let calls=0;f.sales.start=async()=>calls++;
  assert.deepEqual(await engine.run(),{status:"skipped"});assert.equal(calls,0);
  await enable(f);await f.store.update(s=>s.salesAutomationJob={status:"running",leaseUntil:later});
  assert.equal((await engine.run()).status,"skipped");
  f.time("2026-10-30T03:00:00Z");assert.equal(automationView(await f.store.read(),f.now()).job.status,"failed");
});
test("daily endpoint rejects missing/wrong secret, preview, extra query and wrong host before opening DB",async()=>{
  let calls=0;const secret="fixture-".repeat(6),env={VERCEL_ENV:"production",ASIN_PUBLIC_ORIGIN:"https://fixture.example",CRON_SECRET:secret};
  const make=(environment=env)=>createVercelEntry({environment:()=>environment,runtimeFactory:async()=>{calls++;return{runSalesAutomation:async()=>({status:"complete"})};}});
  for(const [url,header,environment] of [["https://fixture.example/api/cron/sales","",env],["https://fixture.example/api/cron/sales","Bearer wrong",env],["https://other.example/api/cron/sales",`Bearer ${secret}`,env],["https://fixture.example/api/cron/sales",`Bearer ${secret}`,{...env,VERCEL_ENV:"preview"}]])assert.equal((await make(environment)(new Request(url,{headers:{authorization:header}}))).status,401);
  assert.equal(calls,0);
  const entry=make();assert.equal((await entry(new Request("https://fixture.example/api/cron/sales?extra=1",{headers:{authorization:`Bearer ${secret}`}}))).status,401);
  assert.equal((await entry(new Request("https://fixture.example/api/inventory?__route=/cron/sales",{headers:{authorization:`Bearer ${secret}`}}))).status,200);assert.equal(calls,1);
});
test("adding merchant SKU retains old history/start and replays the missing observation period",async()=>{
  const f=fixture();await f.store.update(s=>{s.amazonAccountKey=config.accountKey;s.amazonSellerId=config.sellerId;s.salesTracking.startedAt="2026-10-25T00:00:00Z";});
  const resolved={...config,targets:[{sourceId:"stock:a",asin:"B000TEST01",sellerSku:"merchant-one",condition:"used_good"}],unresolved:[]};
  const sales=createCloudSales({...f,config,readTargets:async()=>resolved});await sales.start({expectedRevision:f.revision()});
  const state=await f.store.read();assert.equal(state.salesTracking.trackers[0].startedAt,state.salesTracking.startedAt);assert.equal(state.salesTracking.checkedThrough,state.salesTracking.startedAt);
  await sales.start({expectedRevision:f.revision()});assert.equal((await f.store.read()).salesTracking.trackers.length,1);
});
test("order page cap shortens next query without moving the cursor",async()=>{
  const f=fixture();await f.store.update(s=>{s.amazonAccountKey=config.accountKey;s.amazonSellerId=config.sellerId;s.salesTargets={...config,targets:[{sourceId:"stock:a",asin:"B000TEST01",sellerSku:"merchant-one"}]};s.salesTracking.trackers=s.salesTargets.targets;s.salesTracking.checkedThrough=at;});f.time(later);
  const sales=createCloudSales({...f,config,readOrders:async()=>{throw Object.assign(new Error("page cap"),{code:"SALES_PAGE_LIMIT"});}});
  await sales.check();const state=await f.store.read();assert.equal(state.salesTracking.checkedThrough,at);assert.ok(state.salesTracking.windowMs<7200000);assert.equal(state.salesTracking.sync.status,"failed");
});
