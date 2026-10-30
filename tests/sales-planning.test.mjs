import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {emptySalesPlanning,applyPlanningCommand,planningSchedule,planningToday,validateSalesPlanning} from "../src/sales-planning.js";
import {createCloudPlanning} from "../src/cloud-planning.js";
import {emptyMonitor} from "../src/link-monitor.js";
import {createCloudHandler} from "../src/cloud-handler.js";

const at="2026-10-27T03:00:00.000Z",actor="planning-owner";
const plan=()=>({title:"販売テスト用モニター",asin:"B000TEST01",sellerSku:"USED-ONE",condition:"used",setContents:"スタンドなし",source:{kind:"manual",id:""},kind:"amazon",status:"active",availableOn:"",availabilityNote:"",adStartedOn:"",durationDays:14,reviewOn:"",decision:"undecided",note:"",salesMemo:""});
const command=values=>({operationId:randomUUID(),planId:randomUUID(),kind:"create",plan:{...plan(),...values}});
function memory(state){let value=structuredClone(state),revision=0;return{read:async()=>structuredClone(value),readSnapshot:async()=>({state:structuredClone(value),revision}),update:async(fn,options={})=>{if(options.expectedRevision!==undefined&&options.expectedRevision!==revision)throw Object.assign(new Error("更新競合"),{code:"STORAGE_CONFLICT"});const copy=structuredClone(value),result=await fn(copy);value=copy;revision++;return result;}};}
const setup=()=>{const store=memory(emptySalesPlanning()),monitorStore=memory(emptyMonitor()),stock={view:async()=>({products:[]})};return{store,monitorStore,planning:createCloudPlanning({store,stock,monitorStore,now:()=>at})};};

test("registration and shipment dates never start a sales test; unknown availability remains waiting",()=>{
  const state=emptySalesPlanning(),input=command();applyPlanningCommand(state,input,{actor,at});
  assert.equal(planningSchedule(state.plans[0],at).stage,"waiting");assert.equal(planningSchedule(state.plans[0],at).dueOn,"");
  assert.equal(state.plans[0].createdAt,at);assert.equal(state.plans[0].availableOn,"");
  assert.equal(planningToday("2026-10-26T16:00:00Z"),"2026-10-27");
});
test("actual availability and individual period determine the review date in Japan calendar days",()=>{
  const input={...plan(),availableOn:"2026-10-01",availabilityNote:"対象中古SKUが販売可能",durationDays:14};
  assert.deepEqual(planningSchedule(input,at),{stage:"due",dueOn:"2026-10-15",startedOn:"2026-10-01",remainingDays:-12});
  input.durationDays=30;assert.equal(planningSchedule(input,at).dueOn,"2026-10-31");
  input.availableOn="2026-10-27";input.durationDays=1;assert.equal(planningSchedule(input,at).remainingDays,1);
});
test("advertising has a separate actual start date; hold and completed plans never imply executing ads",()=>{
  const p={...plan(),kind:"advertising",availableOn:"2026-10-01",availabilityNote:"販売可能"};
  assert.equal(planningSchedule(p,at).stage,"waiting");p.adStartedOn="2026-10-20";
  assert.equal(planningSchedule(p,at).dueOn,"2026-11-03");p.status="hold";p.reviewOn="2026-11-10";assert.equal(planningSchedule(p,at).stage,"hold");
  p.status="closed";assert.equal(planningSchedule(p,at).dueOn,"");
  const scheduled={...plan(),kind:"review",reviewOn:"2026-11-03"};assert.equal(planningSchedule(scheduled,at).stage,"scheduled");assert.equal(planningSchedule(scheduled,at).dueOn,"2026-11-03");
});
test("invalid/future dates and unsupported periods cannot be saved; evidence text is optional",()=>{
  for(const values of [{availableOn:"2026-02-30",availabilityNote:"確認"},{availableOn:"2026-11-01",availabilityNote:"予定"},{durationDays:0},{durationDays:1.5},{durationDays:366},{adStartedOn:"2026-10-01"}])assert.throws(()=>applyPlanningCommand(emptySalesPlanning(),command(values),{actor,at}));
  const state=emptySalesPlanning();applyPlanningCommand(state,command({availableOn:"2026-10-01",availabilityNote:"",durationDays:10}),{actor,at});
  assert.equal(planningSchedule(state.plans[0],at).dueOn,"2026-10-11");
});
test("ASIN-only registration remains waiting and saves catalog images without inventing stock",()=>{
  const state=emptySalesPlanning(),input=command({title:"",sellerSku:"",condition:"unknown",setContents:"",imageUrl:"https://m.media-amazon.com/images/I/fixture.jpg"});
  applyPlanningCommand(state,input,{actor,at});assert.equal(state.plans[0].title,"B000TEST01");assert.equal(state.plans[0].imageSource,"amazon_catalog");assert.equal(planningSchedule(state.plans[0],at).stage,"waiting");
  const edit={...input,kind:"edit",operationId:randomUUID(),plan:{...input.plan,title:"本人の商品名"}};delete edit.plan.imageUrl;
  applyPlanningCommand(state,edit,{actor,at});assert.equal(state.plans[0].imageUrl,"https://m.media-amazon.com/images/I/fixture.jpg");assert.equal(state.plans.length,1);
  assert.throws(()=>applyPlanningCommand(emptySalesPlanning(),command({title:"",asin:""}),{actor,at}),/ASINまたは商品名/);
  assert.throws(()=>applyPlanningCommand(emptySalesPlanning(),command({imageUrl:"https://other.invalid/a.png"}),{actor,at}),/画像/);
});
test("multiple next actions persist together, preserve history and reject old-client loss",()=>{
  const state=emptySalesPlanning(),input=command({decisions:["amazon","advertising","yahoo","rakuten","catalog","replenish"]});
  applyPlanningCommand(state,input,{actor,at});assert.equal(state.plans[0].decisions.length,6);assert.equal(state.plans[0].decision,"amazon");
  const next={...input,kind:"edit",operationId:randomUUID(),plan:{...input.plan,note:"追加納品も検討"}};applyPlanningCommand(state,next,{actor,at});assert.equal(state.events[1].before.decisions.length,6);
  const old={...next,operationId:randomUUID(),plan:{...next.plan}};delete old.plan.decisions;assert.throws(()=>applyPlanningCommand(state,old,{actor,at}),/複数の方針/);
  for(const decisions of [[],["undecided","amazon"],["amazon","amazon"],["invalid"]])assert.throws(()=>applyPlanningCommand(emptySalesPlanning(),command({decisions}),{actor,at}));
});
test("catalog lookup is owner-only, read-only, validates ASIN and leaves documents unchanged",async()=>{
  const {store,monitorStore}=setup(),stock={view:async()=>({products:[]})},calls=[];
  const planning=createCloudPlanning({store,stock,monitorStore,readCatalog:async asin=>{calls.push(asin);return{asin,title:"取得した名前",imageUrl:""};}});
  const base="https://inventory.example",handle=createCloudHandler({config:{origin:base,authUrl:"https://auth.example",readOnly:false},store:monitorStore,planning,verifyOwner:async req=>({status:req.headers.get("authorization")==="Bearer owner"?200:401,userId:actor})});
  const req=(asin,headers={})=>new Request(base+"/api/sales-planning/catalog",{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify({asin})});
  assert.equal((await handle(req("B000TEST01"))).status,401);
  assert.equal((await handle(req("bad",{Authorization:"Bearer owner"}))).status,400);
  assert.equal((await handle(req("B000TEST01",{Authorization:"Bearer owner",Origin:"https://other.invalid"}))).status,403);
  const before=await store.readSnapshot(),result=await handle(req("B000TEST01",{Authorization:"Bearer owner"}));assert.equal(result.status,200);assert.equal((await result.json()).title,"取得した名前");assert.deepEqual(await store.readSnapshot(),before);assert.deepEqual(calls,["B000TEST01"]);
});
test("plans never merge same-ASIN condition/SKU variants or replace identity during review",()=>{
  const state=emptySalesPlanning(),first=command();applyPlanningCommand(state,first,{actor,at});
  const second=command({condition:"new",sellerSku:"NEW-ONE"});applyPlanningCommand(state,second,{actor,at});assert.equal(state.plans.length,2);
  assert.throws(()=>applyPlanningCommand(state,{...first,operationId:randomUUID(),kind:"edit",plan:{...first.plan,condition:"new"}},{actor,at}),/別の商品/);
});
test("provisional ASIN-only plans can fill unknown identity once without resetting the registration",()=>{
  const state=emptySalesPlanning(),input=command({sellerSku:"",condition:"unknown",setContents:""});applyPlanningCommand(state,input,{actor,at});
  applyPlanningCommand(state,{...input,kind:"edit",operationId:randomUUID(),plan:{...input.plan,sellerSku:"USED-ONE",condition:"used",setContents:"欠品なし"}},{actor,at});
  assert.equal(state.plans.length,1);assert.equal(state.plans[0].createdAt,at);assert.equal(state.plans[0].condition,"used");
});
test("explicit source references check condition and set contents; no new physical quantities are saved",()=>{
  const source={kind:"stock",id:randomUUID(),title:"商品",asin:"B000TEST01",sellerSku:"USED-ONE",condition:"used",setContents:"スタンドなし"},input=command({source:{kind:source.kind,id:source.id}}),state=emptySalesPlanning();
  assert.throws(()=>applyPlanningCommand(state,input,{actor,at,sources:[]}),/参照先/);
  applyPlanningCommand(state,input,{actor,at,sources:[source]});assert.equal(Object.hasOwn(state.plans[0],"quantity"),false);
  assert.throws(()=>applyPlanningCommand(state,command({source:input.plan.source}),{actor,at,sources:[source]}),/既存の計画/);
  assert.throws(()=>applyPlanningCommand(emptySalesPlanning(),command({source:input.plan.source,condition:"new"}),{actor,at,sources:[source]}),/状態/);
  applyPlanningCommand(state,{...input,operationId:randomUUID(),kind:"edit",plan:{...input.plan,status:"closed"}},{actor,at,sources:[]});assert.equal(state.plans[0].status,"closed");
});
test("receipts deduplicate identical operations and keep before/after decision history",()=>{
  const state=emptySalesPlanning(),input=command();applyPlanningCommand(state,input,{actor,at});
  assert.equal(applyPlanningCommand(state,input,{actor,at}).replayed,true);assert.equal(state.events.length,1);
  assert.throws(()=>applyPlanningCommand(state,{...input,plan:{...input.plan,title:"別"}},{actor,at}),/同じ操作ID/);
  applyPlanningCommand(state,{...input,operationId:randomUUID(),kind:"edit",plan:{...input.plan,status:"hold",decision:"yahoo",reviewOn:"2026-11-01",note:"併売を検討"}},{actor,at});
  assert.equal(state.events[1].before.decision,"undecided");assert.equal(state.events[1].after.decision,"yahoo");assert.equal(state.plans[0].createdAt,at);validateSalesPlanning(state);
});
test("planning store changes never write stock/monitor; stale writes reject and accepted retries reconcile",async()=>{
  const {planning,store,monitorStore}=setup(),before=await monitorStore.read(),input=command();
  await planning.commit(input,{expectedRevision:0,actor});const retry=await planning.commit(input,{expectedRevision:0,actor});assert.equal(retry.receipt.replayed,true);
  await assert.rejects(planning.commit(command(),{expectedRevision:0,actor}),{code:"STORAGE_CONFLICT"});
  assert.deepEqual(await monitorStore.read(),before);assert.equal((await store.read()).plans.length,1);assert.equal((await planning.operation(input.operationId,actor)).planId,input.planId);
  await assert.rejects(planning.operation(input.operationId,"other"),error=>error.status===404);
});
test("planning API enforces owner, origin, revision, content type and read-only access",async()=>{
  const {planning,monitorStore}=setup(),base="https://inventory.example",config={origin:base,authUrl:"https://auth.example",readOnly:false};
  const make=(readOnly=false)=>createCloudHandler({config:{...config,readOnly},store:monitorStore,planning,verifyOwner:async req=>({status:req.headers.get("authorization")==="Bearer owner"?200:401,userId:actor})});
  const request=(path="",options={})=>new Request(base+"/api/sales-planning"+path,options),headers={Authorization:"Bearer owner","Content-Type":"application/json","If-Match":'"0"'},body=JSON.stringify({command:command()});
  assert.equal((await make()(request())).status,401);assert.equal((await make()(request("",{headers}))).status,200);
  assert.equal((await make()(request("/operations",{method:"POST",headers:{...headers,Origin:"https://other.example"},body}))).status,403);
  assert.equal((await make(true)(request("/operations",{method:"POST",headers,body}))).status,403);
  assert.equal((await make()(request("/operations",{method:"POST",headers:{...headers,"Content-Type":"text/plain"},body}))).status,415);
  const missing={...headers};delete missing["If-Match"];assert.equal((await make()(request("/operations",{method:"POST",headers:missing,body}))).status,428);
  assert.equal((await make()(request("/operations",{method:"POST",headers,body}))).status,200);
  assert.equal((await make()(request("/operations",{method:"POST",headers,body:JSON.stringify({command:command()})}))).status,409);
});
