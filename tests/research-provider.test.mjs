import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createResearchProvider,amazonPrice,keepaPrices} from '../src/research-provider.js';
import {createResearchApi} from '../src/research-api.js';
import {createCloudHandler} from '../src/cloud-handler.js';
import {signedHeaders} from '../shared/photo-bridge.mjs';
const asin='B001234567',market='A1VC38T7YXB528',at='2026-11-13T00:00:00Z',money=v=>({CurrencyCode:'JPY',Amount:v}),amazon={clientId:'id',clientSecret:'do-not-expose',refreshToken:'do-not-expose',marketplaceId:market};
const catalog={asin,summaries:[{marketplaceId:market,itemName:'メーカー AA-01',brandName:'メーカー'}],attributes:{model_number:[{value:'AA-01'}],manufacturer:[{value:'メーカー'}]},identifiers:[{marketplaceId:market,identifiers:[{identifierType:'EAN',identifier:'0491234567894'}]}]};
test('Amazon prices filter requested condition and respect JPY, shipping zero and absent prices',()=>{
 const body={payload:{ASIN:asin,ItemCondition:'New',Summary:{LowestPrices:[{condition:'used',ListingPrice:money(1),LandedPrice:money(1),Shipping:money(0)},{condition:'new',ListingPrice:money(1000),LandedPrice:money(1000),Shipping:money(0)}]}}};
 assert.equal(amazonPrice(body,asin,'new',at).total,1000);assert.equal(amazonPrice(body,asin,'used',at),null);
 assert.equal(amazonPrice({payload:{ASIN:asin,Summary:{LowestPrices:[]}}},asin,'used',at),null);
 assert.equal(amazonPrice(body,'B009999999','new',at),null);
});
test('Keepa only NEW/USED current, yen not divided100, missing never uses Amazon/list price',()=>{
 const p={domainId:5,productType:0,asin,stats:{current:[1000,-1,2500,-1,5000]},lastUpdate:100};
 const prices=keepaPrices(p,at);assert.equal(prices.length,1);assert.equal(prices[0].condition,'used');assert.equal(prices[0].item,2500);assert.equal(prices[0].total,null);
 assert.deepEqual(keepaPrices({...p,productType:5},at),[]);
});
test('provider uses existing credentials read-only, no expensive Keepa flags, manual fallback and safe errors',async()=>{
 const calls=[];let time=Date.parse(at);
 const provider=createResearchProvider({amazon,keepaKey:'private-test-key',now:()=>time,sleep:async ms=>{time+=ms;},fetchImpl:async(url,options)=>{
  calls.push([String(url),options]);if(String(url).includes('/auth/'))return Response.json({access_token:'private-token',expires_in:3600});
  if(String(url).includes('/catalog/'))return Response.json(catalog);
  if(String(url).includes('/offers'))return Response.json({payload:{ASIN:asin,Summary:{LowestPrices:[{condition:new URL(url).searchParams.get('ItemCondition').toLowerCase(),ListingPrice:money(1200),LandedPrice:money(1200),Shipping:money(0)}]}}});
  return Response.json({products:[{...catalog,domainId:5,productType:0,title:'候補',stats:{current:[1000,1100,-1]},lastUpdate:100}],tokensConsumed:1});
 }});
 const result=await provider.query({input:{asin,model:'AA-01',manufacturer:'メーカー'},settings:{},keepaBudget:1});
 assert.equal(result.candidates.length,1);assert.equal(result.prices.length,3);assert.equal(result.keepaTokens,1);
 const k=new URL(calls.find(c=>c[0].startsWith('https://api.keepa'))[0]);assert.equal(k.searchParams.get('update'),'-1');assert.equal(k.searchParams.get('history'),'0');for(const flag of ['offers','rating','buybox','stock'])assert.equal(k.searchParams.has(flag),false);
 assert.ok(!JSON.stringify(result).includes('private'));
 assert.equal(calls.filter(c=>c[1].method==='POST').length,1); // LWA authentication only
 const count=calls.length;await provider.query({input:{name:'商品'},settings:{priority:['yahoo'],compare:['yahoo']},keepaBudget:1});assert.equal(calls.length,count);
 const bad=createResearchProvider({amazon,fetchImpl:async()=>{throw Error('key=super-secret');}});
 const failed=await bad.query({input:{asin},settings:{useKeepa:false},keepaBudget:0});assert.equal(failed.status,'unavailable');assert.ok(!JSON.stringify(failed).includes('super-secret'));
});
test('signed API scopes workspace and product, replays do not repeat calls and owner auth is not bypassed',async()=>{
 const workspace=randomUUID(),key='a'.repeat(64),origin='https://inventory.example';let calls=0;
 const api=createResearchApi({workspaceId:workspace,provider:{capabilities:()=>({amazon:true}),query:async()=>{calls++;return {status:'needs_review'};}}});
 const body={protocol:'research-query/v1',operationId:randomUUID(),workspaceId:workspace,productId:randomUUID(),keepaBudget:0,input:{},settings:{}};
 const handler=createCloudHandler({config:{origin,authUrl:'https://auth.example'},photoBridgeKey:key,research:api,verifyOwner:async()=>({status:401})});
 const send=async (data,signed=true)=>{const text=JSON.stringify(data),url=origin+'/api/research/query';return handler(new Request(url,{method:'POST',headers:signed?signedHeaders(key,'POST',url,text):{'Content-Type':'application/json'},body:text}));};
 assert.equal((await send(body,false)).status,401);assert.equal((await send({...body,workspaceId:randomUUID()})).status,403);
 assert.equal((await send(body)).status,200);assert.equal((await send(body)).status,200);assert.equal(calls,1);
 assert.equal((await send({...body,keepaBudget:1})).status,409);
 assert.equal((await handler(new Request(origin+'/api/photo-listing-drafts'))).status,401);
});
