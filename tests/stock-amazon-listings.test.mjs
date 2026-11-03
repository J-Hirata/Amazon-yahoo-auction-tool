import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readOwnAmazonListings,stockAmazonView,createStockAmazonRefresh} from "../src/stock-amazon-listings.js";
import {emptyPhysicalStock,applyStockCommand,validatePhysicalStock} from "../src/physical-stock.js";
const at="2026-10-26T12:00:00Z",marketplaceId="A1VC38T7YXB528",asin="B0971ML5MD";
const config={sellerId:"OWNSELLER",accountKey:"own-account",marketplaceId,clientId:"fixture",clientSecret:"secret-fixture",refreshToken:"refresh-fixture"};
const account={amazonSellerId:config.sellerId,amazonAccountKey:config.accountKey};
const item=(patch={})=>({sku:"own-used",summaries:[{asin,marketplaceId,status:["BUYABLE","DISCOVERABLE"],conditionType:"used_good"}],fulfillmentAvailability:[{fulfillmentChannelCode:"DEFAULT",quantity:1}],...patch});
const listingSnapshot=(rows=[{asin,sellerSku:"own-used",condition:"used_good",statuses:["BUYABLE"],fulfillment:[{channel:"DEFAULT",quantity:1}]}])=>({version:1,status:"complete",source:"own_seller_listings",asins:[asin],rows,sellerId:config.sellerId,accountKey:config.accountKey,marketplaceId,checkedAt:at});
const product={asin,condition:"used",sellerSku:""};
async function read(data,extra={}){let n=0;return readOwnAmazonListings({asins:[asin],config,now:()=>Date.parse(at),wait:async()=>{},fetchImpl:async(url,options)=>{
  if(++n===1){assert.equal(options.method,"POST");return Response.json({access_token:"not-for-output"});}
  const u=new URL(url);assert.equal(options.method,"GET");assert.equal(options.redirect,"error");assert.equal(u.pathname,"/listings/2021-08-01/items/OWNSELLER");assert.equal(u.searchParams.get("identifiers"),asin);assert.equal(u.searchParams.get("identifiersType"),"ASIN");assert.equal(u.searchParams.has("withStatus"),false);assert.equal(u.searchParams.get("includedData"),"summaries,fulfillmentAvailability");
  return typeof data === "function" ? data(n,u) : Response.json(data);
},...extra});}
test("own listing reader scopes to the authenticated seller and registered ASIN, not a rival's cart",async()=>{
  const r=await read({numberOfResults:1,items:[item()]});assert.equal(r.rows[0].sellerSku,"own-used");assert.equal(r.rows[0].fulfillment[0].quantity,1);assert.equal(r.sellerId,"OWNSELLER");assert.doesNotMatch(JSON.stringify(r),/not-for-output|secret-fixture/);
});
test("new and used own listings remain separate; FBA and merchant quantities are not merged",async()=>{
  const r=await read({numberOfResults:2,items:[item(),item({sku:"own-new",summaries:[{asin,marketplaceId,status:["BUYABLE"],conditionType:"new_new"}],fulfillmentAvailability:[{fulfillmentChannelCode:"AMAZON_JP"}]})]});
  const v=stockAmazonView(product,r,at,account);assert.equal(v.status,"buyable");assert.deepEqual(v.matchingSkus,["own-used"]);assert.equal(v.offers.length,2);assert.equal(v.offers[1].shippingLabel,"FBA");assert.equal(v.offers[1].fulfillment[0].quantity,null);
});
test("a new Amazon offer for a used registration is visible but flagged, never auto-corrected or silently linked",()=>{
  const snapshot=listingSnapshot([{asin,sellerSku:"new-only",condition:"new_new",statuses:["BUYABLE"],fulfillment:[{channel:"AMAZON_JP",quantity:null}]}]);
  const p={...product},view=stockAmazonView(p,snapshot,at,account);assert.equal(view.status,"variant_mismatch");assert.equal(view.offers[0].buyable,true);assert.match(view.variantWarning,/中古/);assert.equal(p.condition,"used");assert.equal(view.matchingSkus.length,0);
});
test("SKU differences are not guessed, and DISCOVERABLE alone is not reported as buyable",()=>{
  const s=listingSnapshot();assert.equal(stockAmazonView({...product,sellerSku:"other"},s,at,account).status,"variant_mismatch");s.rows[0].statuses=["DISCOVERABLE"];
  assert.equal(stockAmazonView(product,s,at,account).status,"present");assert.equal(stockAmazonView(product,s,at,account).offers[0].buyable,false);
});
test("stale, failed, wrong account, unchecked ASIN and empty results stay distinct from unavailable stock",()=>{
  assert.equal(stockAmazonView(product,listingSnapshot(),"2026-10-26T14:00:00Z",account).status,"stale");
  assert.equal(stockAmazonView(product,{...listingSnapshot(),status:"failed"},at,account).status,"unknown");
  assert.equal(stockAmazonView(product,{...listingSnapshot(),sellerId:"RIVAL"},at,account).offers.length,0);
  assert.equal(stockAmazonView({...product,asin:"B000OTHER1"},listingSnapshot(),at,account).status,"unknown");
  assert.equal(stockAmazonView(product,listingSnapshot([]),at,account).status,"not_found");assert.equal(stockAmazonView({asin:""},null,at,account).status,"no_asin");
});
test("invalid identity/marketplace/results, incomplete pagination, repeated pages and HTTP errors never become no offers",async()=>{
  for(const data of [{items:[]},{numberOfResults:2,items:[item()]},{numberOfResults:1,items:[item({summaries:[{asin:"B000OTHER1",marketplaceId,status:["BUYABLE"]}]})]},{numberOfResults:1,items:[item({summaries:[{asin,marketplaceId:"OTHER",status:["BUYABLE"]}]})]},{numberOfResults:1,items:[item({summaries:[{asin,marketplaceId}]})]},{numberOfResults:2,items:[item()],pagination:{nextToken:"repeat"}}])await assert.rejects(read(data));
  await assert.rejects(read(()=>new Response("private",{status:403})),/HTTP 403/);
  await assert.rejects(read({numberOfResults:0,items:[]},{config:{...config,sellerId:""}}));
});
test("pagination keeps the same scope and reads all own SKUs",async()=>{
  const r=await read((n,u)=>Response.json({numberOfResults:2,items:[item({sku:n===2?"first":"second"})],...(n===2?{pagination:{nextToken:"next"}}:{})}));assert.equal(r.rows.length,2);
});
function fixture(){let state=emptyPhysicalStock(),revision=1;
  applyStockCommand(state,{operationId:randomUUID(),kind:"create",product:{title:"在庫",condition:"used",asin},initialCounts:{container:3,home:1}},{actor:"owner",at});
  return {store:{read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision})=>{if(revision!==expectedRevision)throw Object.assign(new Error("conflict"),{code:"STORAGE_CONFLICT"});const next=structuredClone(state);await fn(next);validatePhysicalStock(next);state=next;revision++;}},monitorStore:{read:async()=>account}};
}
test("refresh stores observations only and never touches products, stock balances, receipts or Yahoo links",async()=>{
  const f=fixture(),before=(await f.store.readSnapshot()).state;
  const update=createStockAmazonRefresh({...f,config,now:()=>at,readListings:async()=>listingSnapshot()});await update({expectedRevision:1,actor:"owner"});
  const after=await f.store.read();const {amazonListings,...core}=after;assert.deepEqual(core,before);assert.equal(amazonListings.status,"complete");await assert.rejects(update({expectedRevision:1,actor:"owner"}),{status:409});
});
test("fetch failure preserves previous evidence but exposes an unknown state, not zero or not listed",async()=>{
  const f=fixture();await createStockAmazonRefresh({...f,config,now:()=>at,readListings:async()=>listingSnapshot()})({expectedRevision:1,actor:"owner"});
  const update=createStockAmazonRefresh({...f,config,now:()=>at,readListings:async()=>{throw new Error("secret upstream message");}});await update({expectedRevision:2,actor:"owner"});
  const s=await f.store.read();assert.equal(s.amazonListings.rows.length,1);assert.equal(stockAmazonView(product,s.amazonListings,at,account).offers.length,0);assert.doesNotMatch(JSON.stringify(s),/secret upstream/);assert.equal(s.balances[0].usable,3);
});

test("failed first reads record their current ASIN scope without inventing empty offers",async()=>{
  const f=fixture();await createStockAmazonRefresh({...f,config,now:()=>at,readListings:async()=>{throw new Error('unavailable');}})({expectedRevision:1,actor:'owner'});
  const state=await f.store.read();assert.deepEqual(state.amazonListings.asins,[asin]);assert.equal(state.amazonListings.status,'failed');assert.equal(state.amazonListings.rows,undefined);
});
test("an account mismatch fails before sending any Amazon request",async()=>{
  const f=fixture();let called=false;await assert.rejects(createStockAmazonRefresh({...f,config:{...config,sellerId:"RIVAL"},readListings:async()=>{called=true;}})({expectedRevision:1,actor:"owner"}),{status:409});assert.equal(called,false);
});

test("a larger scope is never silently truncated and an untrusted source is never accepted as complete",async()=>{
  const f=fixture();let called=false;
  const many={...f,store:{...f.store,readSnapshot:async()=>({revision:1,state:{products:Array.from({length:21},(_,i)=>({asin:String(i).padStart(10,"0")}))}})}};
  await assert.rejects(createStockAmazonRefresh({...many,config,readListings:async()=>{called=true;}})({expectedRevision:1,actor:"owner"}),/20 ASIN/);assert.equal(called,false);
  await createStockAmazonRefresh({...f,config,readListings:async()=>({...listingSnapshot(),source:"retail_cart"})})({expectedRevision:1,actor:"owner"});
  assert.equal((await f.store.read()).amazonListings.status,"failed");
});
