import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at,asin} from './relations-fixture.mjs';
import {createProductMonitoring} from '../src/product-monitoring.js';
import {productOverview} from '../src/product-overview.js';
import {createCloudHandler} from '../src/cloud-handler.js';
import {fbaStatus} from '../public/fba-status.js';
test('Amazon-only refresh updates actual FBA observations without Yahoo, mail, alert transitions, or business record edits',async()=>{
 const f=fixture();await f.transaction.update(d=>{d['link-monitor'].state.amazonAccountKey='own';d['link-monitor'].state.amazonSellerId='OWN';});
 const read=()=>{const d=f.read();return {monitor:d['link-monitor'].state,physical:d['physical-stock'].state,planning:d['sales-planning'].state,drafts:d['draft-items'].state,watch:d['product-watch'].state};};
 const before=read();let external=0;
 const m=createProductMonitoring({overview:{inputs:async()=>read()},watchStore:{update:fn=>f.transaction.update(d=>fn(d['product-watch'].state))},config:{accountKey:'own',sellerId:'OWN'},now:()=>at,
 readInventory:async({asins})=>({status:'complete',complete:true,asins,accountKey:'own',sellerId:'OWN',checkedAt:at,items:[{asin,sellerSku:'SKU1',condition:'UsedGood',fulfillableQuantity:0}]}),
 readYahoo:async()=>{external++;throw new Error('must not run');},followRelistings:async()=>{external++;},readListings:async({asins})=>({status:'complete',source:'own_seller_listings',asins,accountKey:'own',sellerId:'OWN',marketplaceId:'A1VC38T7YXB528',checkedAt:at,rows:[]})});
 const result=await m.run({inventoryOnly:true,refreshListings:true,settings:{},enqueueAlerts:async()=>{external++;}}),after=read();
 assert.equal(result.status,'complete');assert.equal(external,0);
 for(const k of ['monitor','physical','planning','drafts'])assert.deepEqual(after[k],before[k]);
 for(const k of ['pendingAlerts','signals','rules'])assert.deepEqual(after.watch[k],before.watch[k]);
 assert.deepEqual(after.watch.observations.yahoo,before.watch.observations.yahoo);assert.equal(after.watch.observations.fba.items[0].fulfillableQuantity,0);
 assert.equal(productOverview(after,at).find(r=>r.stockIds.includes(f.stockId)).availability.fba.quantity,0);
});
test('FBA refresh requires owner, same origin and write permission; it is distinct from normal monitoring',async()=>{
 let calls=[];const origin='https://fixture.example';
 const handler=readOnly=>createCloudHandler({config:{origin,readOnly,authUrl:'https://auth.fixture.invalid'},verifyOwner:async r=>({status:r.headers.has('authorization')?200:401}),productLinks:{refresh:async o=>{calls.push(o);return {status:'complete'};}}});
 const request=(extra={})=>new Request(origin+'/api/product-links/fba-refresh',{method:'POST',headers:{origin,'content-type':'application/json',authorization:'fixture',...extra},body:'{}'});
 const anon=new Request(origin+'/api/product-links/fba-refresh',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
 assert.equal((await handler(false)(anon)).status,401);assert.equal((await handler(false)(request({origin:'https://elsewhere.invalid'}))).status,403);assert.equal((await handler(true)(request())).status,403);assert.equal(calls.length,0);
 assert.equal((await handler(false)(request())).status,200);assert.deepEqual(calls,[{inventoryOnly:true}]);
});
test('unknown FBA explanations distinguish ambiguity, mismatches, stale reads and real zero',()=>{
 for(const [status,word,needsSku]of [['ambiguous','複数',true],['not_found','一致',true],['stale','時間',false],['unknown','取得できて',false]]){const r=fbaStatus({availability:{fba:{status,quantity:null}}});assert.match(r.message,new RegExp(word));assert.equal(r.needsSku,needsSku);}
 assert.equal(fbaStatus({availability:{fba:{status:'complete',quantity:0}}}).needsSku,false);
});
