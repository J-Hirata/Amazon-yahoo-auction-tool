import test from 'node:test';
import assert from 'node:assert/strict';
import {attachAvailability,stockDisplay,yahooAvailability,conditionName} from '../src/product-availability.js';
import {parseYahooPage} from '../src/yahoo-observation.js';

const at='2026-11-03T04:00:00Z',asin='B000TEST01';
const observation=(patch={})=>({listingId:'d1000000001',verified:true,status:'active',quantity:3,saleType:'fixed',checkedAt:at,...patch});
const row=(patch={})=>({asin,sellerSku:'USED-GOOD',condition:'used',sourceKeys:['link:fixture'],attention:[],fba:{quantity:5,status:'complete',sellerSku:'USED-GOOD',checkedAt:at},yahoo:[observation()],...patch});

test('ended listings sell zero even when old page metadata retains a positive quantity',()=>{
 const y=yahooAvailability(observation({status:'ended',quantity:6}),at);
 assert.equal(y.state,'ended');assert.equal(y.quantity,0);
 const r=attachAvailability([row({yahoo:[observation({status:'ended',quantity:6})]})],{},at)[0];
 assert.equal(r.availability.level,'danger');assert.match(r.availability.message,/再出品/);
});

test('unverified, failed and stale reads remain unknown rather than ended or zero',()=>{
 for(const patch of [{verified:false},{status:'unknown'},{checkedAt:'2026-10-01T00:00:00Z'}]){
  const y=yahooAvailability(observation(patch),at);assert.equal(y.state,'unknown');assert.equal(y.quantity,null);
 }
});

test('only explicitly identified auctions may use one when the page has no quantity',()=>{
 assert.equal(yahooAvailability(observation({quantity:null,saleType:'auction'}),at).quantity,1);
 assert.equal(yahooAvailability(observation({quantity:0,saleType:'auction'}),at).quantity,0);
 for(const saleType of ['fixed','unknown'])assert.equal(yahooAvailability(observation({quantity:null,saleType}),at).quantity,null);
});

test('public page quantity and sale type are parsed without interpreting bids as inventory',()=>{
 for(const [quantity,isFleaMarket,expected] of [[0,true,0],[7,false,7],[-1,true,null],['7',true,null],[undefined,undefined,null]]){
  const item={auctionId:'d1000000001',status:'open',title:'隔離確認',description:[],quantity,isFleaMarket,bids:12};
  const html=`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{initialState:{item:{detail:{item}}}}}})}</script>`;
  const result=parseYahooPage(html,'https://auctions.yahoo.co.jp/jp/auction/d1000000001',at);
  assert.equal(result.observation.quantity,expected);
  assert.equal(result.observation.saleType,isFleaMarket===true?'fixed':isFleaMarket===false?'auction':'unknown');
 }
});

test('all unique Yahoo listings that share an FBA SKU are compared together, including sets',()=>{
 const a=row({yahoo:[observation({quantity:2,unitsPerListing:2})]}),b=row({sourceKeys:['link:other'],yahoo:[observation({listingId:'d1000000002',quantity:2})]}),duplicate=row();
 duplicate.yahoo=a.yahoo;
 const rows=attachAvailability([a,b,duplicate],{},at);
 for(const r of rows){assert.equal(r.availability.poolRequired,6);assert.equal(r.availability.poolListings,2);assert.equal(r.availability.level,'danger');assert.match(r.availability.message,/合計.*1個多い/);}
});

test('separate seller SKUs never share FBA stock even if their ASIN is the same',()=>{
 const rows=attachAvailability([row(),row({sellerSku:'USED-VERY-GOOD',fba:{quantity:1},yahoo:[observation({listingId:'d1000000002',quantity:2})]})],{},at);
 assert.equal(rows[0].availability.level,'ok');assert.equal(rows[1].availability.level,'danger');
 assert.equal(conditionName('used_very_good'),'中古・非常に良い');assert.equal(conditionName('UsedGood'),'中古・良い');
 assert.equal(conditionName('NewItem'),'新品');
});

test('a known partial overage warns even with another unknown listing; unknown does not imply safe',()=>{
 let a=attachAvailability([row({yahoo:[observation({quantity:6}),observation({listingId:'d1000000002',verified:false})]})],{},at)[0].availability;
 assert.equal(a.level,'danger');assert.equal(a.poolComplete,false);
 a=attachAvailability([row({yahoo:[observation(),observation({listingId:'d1000000002',verified:false})]})],{},at)[0].availability;
 assert.equal(a.level,'warning');
});

test('manual fallback preserves zero, expires, and never overrides an actual Amazon zero',()=>{
 const monitor={inventoryReviews:[{key:'link:fixture',asin,sellerSku:'USED-GOOD',manualFbaQuantity:0,checkedAt:at}]};
 let a=stockDisplay(row({fba:{quantity:null,status:'unknown'}}),monitor,at);assert.equal(a.fba.quantity,0);assert.equal(a.fba.source,'manual');
 monitor.inventoryReviews[0].manualFbaQuantity=9;
 a=stockDisplay(row({fba:{quantity:0,status:'complete'}}),monitor,at);assert.equal(a.fba.quantity,0);assert.equal(a.fba.source,'amazon');
 monitor.inventoryReviews[0].checkedAt='2026-10-01T00:00:00Z';assert.equal(stockDisplay(row({fba:{}}),monitor,at).fba.quantity,null);
});

test('manual stock cannot resolve multiple grades until a SKU is selected',()=>{
 const monitor={inventoryReviews:[{key:'link:fixture',asin,sellerSku:'',manualFbaQuantity:10,checkedAt:at}]};
 assert.equal(stockDisplay(row({sellerSku:'',fba:{quantity:null,status:'ambiguous'}}),monitor,at).fba.quantity,null);
 monitor.inventoryReviews[0].sellerSku='ANOTHER';assert.equal(stockDisplay(row({fba:{quantity:null}}),monitor,at).fba.quantity,null);
});

test('a manual count saved without a SKU cannot carry over to a subsequently selected SKU',()=>{
 const monitor={inventoryReviews:[{key:'link:fixture',asin,sellerSku:'',manualFbaQuantity:12,checkedAt:at}]};
 assert.equal(stockDisplay(row({sellerSku:'',fba:{quantity:null,status:'unknown'}}),monitor,at).fba.quantity,12);
 assert.equal(stockDisplay(row({sellerSku:'USED-GOOD',fba:{quantity:null,status:'unknown'}}),monitor,at).fba.quantity,null);
});

test('an intentionally unlisted product is informational, not an inventory alert',()=>{
 const r=attachAvailability([row({yahoo:[]})],{},at)[0];
 assert.equal(r.availability.level,'none');assert.deepEqual(r.attention,[]);
});
