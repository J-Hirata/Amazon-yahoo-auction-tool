import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {normalizeActions,actionSchedules} from "../src/planning-actions.js";
import {emptySalesPlanning,applyPlanningCommand,planningSchedule} from "../src/sales-planning.js";
import {collectProductAlerts} from "../src/product-monitoring.js";
import {productChannels} from "../src/product-channels.js";
const at="2026-11-20T02:00:00Z",action=(decision,extra={})=>({id:randomUUID(),decision,startsOn:"2026-11-20",endsOn:"2026-12-31",dependsOn:"",trigger:"always",status:"planned",outcome:"pending",note:"",...extra});
const plan=()=>({id:randomUUID(),title:"期間付きの商品",asin:"B000TEST01",sellerSku:"",condition:"used",setContents:"",source:{kind:"manual",id:""},kind:"amazon",status:"active",availableOn:"2026-11-01",adStartedOn:"",durationDays:10,reviewOn:"",note:"",salesMemo:"",decisions:["yahoo","return","replenish"]});
const row=(p,time=at)=>({title:p.title,asin:p.asin,sources:["plan"],key:"plan:"+p.id,fba:{status:"unknown"},sales:{fbaQuantity7:null},localAvailable:null,rule:{replenishEnabled:false},plans:[{...p,schedule:planningSchedule(p,time),actionSchedules:actionSchedules(p,time)}]});
const settings={reviewAlerts:true};
test("actions validate dates, references, cycles and result consistency",()=>{
 const a=action("yahoo"),b=action("return",{dependsOn:a.id,trigger:"poor"});assert.equal(normalizeActions([a,b],["yahoo","return"]).length,2);
 for(const bad of [{endsOn:"2026-11-19"},{startsOn:"2026-02-30"},{dependsOn:randomUUID()},{status:"done"},{outcome:"good"}])assert.throws(()=>normalizeActions([{...a,...bad}],["yahoo"]));
 assert.throws(()=>normalizeActions([{...a,dependsOn:b.id},b],["yahoo","return"]));assert.throws(()=>normalizeActions([a,{...b,decision:"yahoo"}],["yahoo"]));
});
test("good/poor paths wait for the previous recorded result, then only the matching branch is ready",()=>{
 const p=plan(),a=action("yahoo"),b=action("return",{dependsOn:a.id,trigger:"poor"}),c=action("replenish",{dependsOn:a.id,trigger:"good"});p.actions=[a,b,c];
 assert.deepEqual(actionSchedules(p,at).map(a=>a.stage),["start","blocked","blocked"]);
 a.status="done";a.outcome="good";assert.deepEqual(actionSchedules(p,at).map(a=>a.stage),["done","skipped","start"]);
 a.outcome="poor";assert.deepEqual(actionSchedules(p,at).map(a=>a.stage),["done","start","skipped"]);
 p.status="hold";assert.ok(actionSchedules(p,at).every(a=>!a.ready));
});
test("start and deadline notices use Japanese dates, suppress old generic review and do not repeat",()=>{
 const p=plan();p.actions=[action("yahoo")];const state={signals:{},pendingAlerts:[]};
 collectProductAlerts(state,[row(p,"2026-11-19T00:00:00Z")],settings,"2026-11-19T00:00:00Z");assert.equal(state.pendingAlerts.length,0);
 collectProductAlerts(state,[row(p)],settings,at);assert.equal(state.pendingAlerts.length,1);assert.match(state.pendingAlerts[0].message,/開始時期/);state.pendingAlerts[0].queuedAt=at;
 collectProductAlerts(state,[row(p)],settings,at);assert.equal(state.pendingAlerts.length,1);
 const deadline="2026-12-30T15:00:00Z";collectProductAlerts(state,[row(p,deadline)],settings,deadline);assert.equal(state.pendingAlerts.length,2);assert.match(state.pendingAlerts[1].message,/締切です/);
});
test("blocked followups never notify; completed results and removed actions cancel unsent notices",()=>{
 const p=plan(),a=action("yahoo"),b=action("return",{dependsOn:a.id,trigger:"poor"});p.actions=[a,b];const state={signals:{},pendingAlerts:[]};
 collectProductAlerts(state,[row(p)],settings,at);assert.equal(state.pendingAlerts.length,1);
 a.status="done";a.outcome="poor";collectProductAlerts(state,[row(p)],settings,at);assert.ok(state.pendingAlerts[0].dismissedAt);assert.equal(state.pendingAlerts.filter(a=>!a.dismissedAt).length,1);
 p.actions=[];collectProductAlerts(state,[],settings,at);assert.ok(state.pendingAlerts.every(a=>a.dismissedAt));
});
test("editing legacy plans preserves their identity; old clients cannot erase saved action periods",()=>{
 const state=emptySalesPlanning(),p=plan(),actor="fixture",command={operationId:randomUUID(),planId:p.id,kind:"create",plan:p};applyPlanningCommand(state,command,{actor,at});
 const actions=[action("yahoo")];applyPlanningCommand(state,{...command,operationId:randomUUID(),kind:"edit",plan:{...p,actions}},{actor,at});
 assert.equal(state.plans[0].id,p.id);assert.equal(state.plans[0].availableOn,p.availableOn);
 assert.throws(()=>applyPlanningCommand(state,{...command,operationId:randomUUID(),kind:"edit"},{actor,at}),{status:409});
});
const snapshot=()=>({version:1,status:"complete",source:"own_seller_listings",accountKey:"fixture",sellerId:"OWN",marketplaceId:"A1VC38T7YXB528",asins:["B000TEST01"],checkedAt:at,rows:[{asin:"B000TEST01",sellerSku:"FBA-SKU",condition:"used_good",statuses:["BUYABLE"],fulfillment:[{channel:"AMAZON_JP",quantity:0}]},{asin:"B000TEST01",sellerSku:"FBM-SKU",condition:"used_good",statuses:["BUYABLE"],fulfillment:[{channel:"DEFAULT",quantity:2}]}]});
function channels(s=snapshot(),rule={},time=at){return productChannels({asin:"B000TEST01",condition:"used",sellerSku:"",sourceKeys:["link:one"],rule,yahoo:[{verified:true,status:"ended",checkedAt:at}]},{amazonAccountKey:"fixture",amazonSellerId:"OWN",salesTargets:{listingSnapshot:s,targets:[]}}, {observations:{}},time);}
test("channel state uses own BUYABLE listings, not FBA quantity; both FBA and merchant can be active",()=>{
 const c=channels();assert.equal(c.fba.state,"active");assert.equal(c.merchant.state,"active");assert.equal(c.yahoo.state,"ended");assert.equal(c.mercari.state,"unknown");assert.equal(c.unlisted,false);
});
test("stale/failed/wrong-account listings remain unknown; missing data never means unlisted",()=>{
 for(const patch of [{status:"failed"},{accountKey:"other"},{checkedAt:"2026-10-01T00:00:00Z"}]){const c=channels({...snapshot(),...patch});assert.equal(c.fba.state,"unknown");assert.equal(c.merchant.state,"unknown");assert.equal(c.unlisted,false);}
});
test("manual Mercari and unlisted confirmations are explicit, with active conflicts exposed",()=>{
 assert.equal(channels(snapshot(),{manualListingStatus:"mercari"}).mercari.state,"active");assert.equal(channels(snapshot(),{manualListingStatus:"none"}).manualConflict,true);
 assert.equal(channels({...snapshot(),rows:[]},{manualListingStatus:"none"}).unlisted,true);
});
