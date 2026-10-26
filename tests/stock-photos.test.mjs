import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readCatalogPhotos, createStockPhotoRefresh} from "../src/cloud-stock-photos.js";
import {stockImageUrl} from "../src/stock-images.js";
import {emptyPhysicalStock, applyStockCommand} from "../src/physical-stock.js";
import {physicalStockView} from "../src/cloud-stock.js";
import {emptyMonitor} from "../src/link-monitor.js";
import {demoMonitor, advanceDemo} from "../src/link-monitor-demo.js";

const config = {marketplaceId:"A1VC38T7YXB528", clientId:"fixture", clientSecret:"private-test-only", refreshToken:"test-refresh"};
const image = "https://m.media-amazon.com/images/I/fixture.jpg", actor = "photo-owner";
function storeFixture() {
  let state = emptyPhysicalStock(), revision = 0;
  applyStockCommand(state, {operationId: randomUUID(), kind:"create", product:{title:"写真用の商品",condition:"used",asin:"B000TEST01",fbaEligibility:"not_possible"},initialCounts:{container:3,home:1}}, {actor});
  return {read:async()=>structuredClone(state), readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision})=>{
    if(expectedRevision!==revision)throw Object.assign(new Error("conflict"),{code:"STORAGE_CONFLICT"}); const next=structuredClone(state);const r=await fn(next);state=next;revision++;return r;
  }};
}
test("stock image URLs accept only safe Amazon/Yahoo image hosts",()=>{
  assert.equal(stockImageUrl(image),image);
  for(const value of ["http://m.media-amazon.com/x","https://m.media-amazon.com.evil.example/x","https://user@m.media-amazon.com/x","https://m.media-amazon.com:444/x","file:///x","javascript:alert(1)","https://127.0.0.1/x"]) assert.equal(stockImageUrl(value),"");
});
test("catalog photo reads are scoped GETs and choose the Japanese MAIN image, never a guessed ASIN image",async()=>{
  const calls=[];
  const r=await readCatalogPhotos({asins:["B000TEST01"],config,wait:async()=>{},fetchImpl:async(url,options)=>{
    calls.push({url:String(url),method:options.method});assert.equal(options.redirect,"error");
    if(calls.length===1)return Response.json({access_token:"private-fixture-token"});
    const u=new URL(url);assert.equal(u.pathname,"/catalog/2022-04-01/items/B000TEST01");assert.equal(u.searchParams.get("includedData"),"images");
    return Response.json({asin:"B000TEST01",images:[{marketplaceId:config.marketplaceId,images:[{variant:"PT01",link:image,width:900},{variant:"MAIN",link:image,width:500}]},{marketplaceId:"OTHER",images:[{variant:"MAIN",link:"https://m.media-amazon.com/wrong.jpg",width:999}]}]});
  }});
  assert.deepEqual(calls.map(c=>c.method),["POST","GET"]);assert.equal(r.photos[0].imageUrl,image);assert.doesNotMatch(JSON.stringify(r),/private-fixture-token/);
});
test("catalog mismatch, unavailable image and upstream denial stay errors without replacing a photo or any count",async()=>{
  for(const kind of ["mismatch","missing","denied"]){let n=0;const r=await readCatalogPhotos({asins:["B000TEST01"],config,wait:async()=>{},fetchImpl:async()=>{
    if(++n===1)return Response.json({access_token:"fixture"});if(kind==="denied")return new Response("private response",{status:403});
    return Response.json({asin:kind==="mismatch"?"B000OTHER1":"B000TEST01",images:[]});
  }});assert.equal(r.photos.length,0);assert.equal(r.errors.length,1);assert.doesNotMatch(JSON.stringify(r),/private response/);}
});
test("photo refresh audits only image metadata, preserves stock and purpose and is idempotent",async()=>{
  const store=storeFixture(),before=await store.read();let reads=0;
  const update=createStockPhotoRefresh({store,config,readPhotos:async({asins})=>{reads++;assert.deepEqual(asins,["B000TEST01"]);return {photos:[{asin:asins[0],imageUrl:image}],errors:[]};}});
  assert.equal((await update({expectedRevision:0,actor})).updated,1);
  const after=await store.read();assert.deepEqual(after.balances,before.balances);assert.equal(after.products[0].fbaEligibility,"not_possible");assert.equal(after.events.length,before.events.length+1);
  assert.equal(after.products[0].imageUrl,image);assert.equal((await update({expectedRevision:1,actor})).updated,0);assert.equal(reads,1);
  await assert.rejects(update({expectedRevision:0,actor}),{status:409});assert.equal(reads,1);
});
test("reference image matching by ASIN does not silently link marketplace records or sum FBA stock",async()=>{
  const state=await storeFixture().read(),monitor=emptyMonitor();
  monitor.links.push({id:randomUUID(),asin:"B000TEST01",matchBy:"asin",listingId:"x123456789",verified:true,referenceFingerprint:"[]"});
  monitor.listings.push({listingId:"x123456789",references:[],imageUrl:"https://auctions.c.yimg.jp/example.jpg"});
  const p=physicalStockView({state,revision:0},monitor).products[0];assert.equal(p.linked.length,0);assert.equal(p.linkCandidates.length,1);assert.equal(p.fba.quantity,null);assert.match(p.photo.label,/未確認/);
  assert.deepEqual(state.products[0].linkedLinkIds,[]);
});
test("correcting an ASIN clears its old automatic catalog image without changing quantities",async()=>{
  const state=await storeFixture().read(),p=state.products[0];p.imageUrl=image;p.imageSource="amazon_catalog";
  const balances=structuredClone(state.balances);
  applyStockCommand(state,{operationId:randomUUID(),kind:"edit",productId:p.id,product:{...p,asin:"B000OTHER1"}},{actor});
  assert.equal(p.imageUrl,"");assert.deepEqual(state.balances,balances);
});
test("stock decrease alone is not a sale; zero, failure and repeated-zero notification previews remain distinct",()=>{
  const at="2026-10-26T00:00:00Z",less=demoMonitor(at);advanceDemo(less,"decreased",at);assert.equal(less.events.length,0);
  const zero=demoMonitor(at);advanceDemo(zero,"zero",at);assert.ok(zero.events.some(e=>e.kind==="inventory_zero"));
  const repeat=demoMonitor(at);advanceDemo(repeat,"repeat",at);assert.equal(repeat.events.length,zero.events.length);
  const failed=demoMonitor(at);advanceDemo(failed,"failed",at);assert.ok(failed.events.some(e=>e.kind==="inventory_unknown"));assert.equal(failed.events.some(e=>e.kind==="inventory_zero"),false);
});
