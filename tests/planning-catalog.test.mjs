import test from "node:test";
import assert from "node:assert/strict";
import {readPlanningCatalog} from "../src/planning-catalog.js";

const asin="B000TEST01",config={marketplaceId:"A1VC38T7YXB528",clientId:"fixture",clientSecret:"fixture-secret",refreshToken:"fixture-refresh"};
const response=value=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
test("catalog reads only the requested Japanese ASIN name and main photo",async()=>{
  const calls=[];const fetchImpl=async(url,options)=>{calls.push({url:String(url),options});return calls.length===1?response({access_token:"fixture-token"}):response({asin,summaries:[{marketplaceId:"other",itemName:"別市場"},{marketplaceId:config.marketplaceId,itemName:"対象の商品名"}],images:[{marketplaceId:config.marketplaceId,images:[{variant:"PT01",link:"https://m.media-amazon.com/side.jpg",width:999},{variant:"MAIN",link:"https://evil.invalid/a.jpg",width:999},{variant:"MAIN",link:"https://m.media-amazon.com/main.jpg",width:500}]}]});};
  const result=await readPlanningCatalog({asin,config,fetchImpl});assert.equal(result.title,"対象の商品名");assert.equal(result.imageUrl,"https://m.media-amazon.com/main.jpg");assert.equal(calls.length,2);
  const url=new URL(calls[1].url);assert.equal(url.pathname,"/catalog/2022-04-01/items/"+asin);assert.equal(url.searchParams.get("includedData"),"summaries,images");assert.equal(calls[1].options.method,"GET");assert.equal(calls[1].options.redirect,"error");
});
test("missing catalog metadata is not inferred and wrong ASIN is rejected",async()=>{
  let n=0;const fetchImpl=async()=>++n%2?response({access_token:"token"}):response({asin});
  assert.deepEqual(await readPlanningCatalog({asin,config,fetchImpl}),{asin,title:"",imageUrl:"",imageSource:""});
  n=0;await assert.rejects(readPlanningCatalog({asin,config,fetchImpl:async()=>++n%2?response({access_token:"token"}):response({asin:"B000OTHER1"})}),/ASIN/);
});
test("malformed inputs make no request and upstream failures do not leak secrets",async()=>{
  await assert.rejects(readPlanningCatalog({asin:"bad",config,fetchImpl:()=>assert.fail("unexpected fetch")}),/ASIN/);
  await assert.rejects(readPlanningCatalog({asin,config,fetchImpl:async()=>{throw new Error(config.clientSecret);}}),error=>!error.message.includes(config.clientSecret)&&error.message.includes("ASINのまま"));
});
