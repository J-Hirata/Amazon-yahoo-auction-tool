import test from 'node:test';
import assert from 'node:assert/strict';
import {attachAvailability,stockDisplay,yahooAvailability,conditionName,skuOptions} from '../src/product-availability.js';
import {productChannels} from '../src/product-channels.js';
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
 a=stockDisplay(row({fba:{quantity:0,status:'complete',checkedAt:at}}),monitor,at);assert.equal(a.fba.quantity,0);assert.equal(a.fba.source,'amazon');
 monitor.inventoryReviews[0].checkedAt='2026-10-01T00:00:00Z';assert.equal(stockDisplay(row({fba:{}}),monitor,at).fba.quantity,null);
});

test('manual stock displays without a selected SKU but does not resolve automatic grade comparison',()=>{
 const monitor={inventoryReviews:[{key:'link:fixture',asin,sellerSku:'',manualFbaQuantity:10,checkedAt:at}]};
 const r=row({sellerSku:'',fba:{quantity:null,status:'ambiguous'}}),a=attachAvailability([r],monitor,at)[0].availability;
 assert.equal(a.fba.quantity,10);assert.equal(a.fba.source,'manual');assert.equal(a.fba.autoStatus,'ambiguous');assert.equal(r.fba.status,'ambiguous');assert.equal(a.level,'warning');assert.match(a.message,/比較は未確認/);
 monitor.inventoryReviews[0].sellerSku='ANOTHER';assert.equal(stockDisplay(row({fba:{quantity:null}}),monitor,at).fba.quantity,null);
});

test('explicit manual confirmation persists as a dated reference; stale or changed-condition counts are not trusted for comparisons',()=>{
 const monitor={inventoryReviews:[{key:'link:fixture',asin,sellerSku:'',condition:'used',mode:'manual',manualFbaQuantity:92,checkedAt:'2026-11-01T04:00:00Z'}]};
 const r=row({sellerSku:'',fba:{quantity:null,status:'ambiguous'}}),a=attachAvailability([r],monitor,at)[0].availability;
 assert.equal(a.fba.quantity,92);assert.equal(a.fba.stale,true);assert.match(a.message,/確認日が古い/);assert.equal(r.fba.quantity,null);
 assert.equal(stockDisplay({...r,condition:'new'},monitor,at).fba.quantity,null);
 monitor.inventoryReviews[0].manualFbaQuantity=0;assert.equal(stockDisplay(r,monitor,at).fba.quantity,0);
 monitor.inventoryReviews[0].manualFbaQuantity=null;assert.equal(stockDisplay(r,monitor,at).fba.quantity,null);
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

const ownSnapshot=()=>({status:'complete',source:'own_seller_listings',accountKey:'fixture',sellerId:'OWN',marketplaceId:'A1VC38T7YXB528',asins:[asin],checkedAt:at,rows:[
 {asin,sellerSku:'NEW-ACTIVE',condition:'new_new',statuses:['BUYABLE','DISCOVERABLE'],fulfillment:[{channel:'AMAZON_JP',quantity:0}]},
 {asin,sellerSku:'NEW-OLD',condition:'new_new',statuses:['DISCOVERABLE'],fulfillment:[{channel:'AMAZON_JP',quantity:0}]},
 {asin,sellerSku:'USED-OTHER',condition:'used_like_new',statuses:['BUYABLE'],fulfillment:[{channel:'AMAZON_JP',quantity:0}]}
]});
const ownMonitor=()=>({amazonAccountKey:'fixture',amazonSellerId:'OWN',salesTargets:{listingSnapshot:ownSnapshot(),targets:[]}});
const ownWatch=()=>({observations:{fba:{status:'complete',complete:true,accountKey:'fixture',sellerId:'OWN',asins:[asin],checkedAt:at,items:[
 {asin,sellerSku:'NEW-ACTIVE',fulfillableQuantity:97},{asin,sellerSku:'NEW-OLD',fulfillableQuantity:0},{asin,sellerSku:'USED-OTHER',fulfillableQuantity:6}
]}}});

test('SKU candidates retain separate ranks, BUYABLE state and exact FBA counts, not listing quantity',()=>{
 const options=skuOptions(row({condition:'new',sellerSku:''}),ownMonitor(),ownWatch(),at);
 assert.deepEqual(options.map(o=>[o.sellerSku,o.condition,o.sellable,o.fbaQuantity]),[
  ['NEW-ACTIVE','新品',true,97],['NEW-OLD','新品',false,0],['USED-OTHER','中古・ほぼ新品',true,6]
 ]);assert.ok(options.every(o=>o.merchantQuantity===null));
});

test('FBA candidate quantity stays unknown for failed, stale, foreign and duplicate inventory observations',()=>{
 const invalid=[{status:'failed'},{complete:false},{accountKey:'foreign'},{sellerId:'OTHER'},{checkedAt:'2026-10-01T00:00:00Z'},{asins:['B000OTHER1']}];
 for(const patch of invalid){const watch=ownWatch();Object.assign(watch.observations.fba,patch);assert.ok(skuOptions(row(),ownMonitor(),watch,at).every(o=>o.fbaQuantity===null));}
 const watch=ownWatch();watch.observations.fba.items.push({...watch.observations.fba.items[0]});assert.equal(skuOptions(row(),ownMonitor(),watch,at)[0].fbaQuantity,null);
});

test('listing candidates reject stale or foreign scope and failed newest reads instead of using old success',()=>{
 for(const patch of [{status:'failed'},{accountKey:'other'},{sellerId:'OTHER'},{marketplaceId:'OTHER'},{checkedAt:'2026-10-01T00:00:00Z'}]){
  const monitor=ownMonitor();Object.assign(monitor.salesTargets.listingSnapshot,patch);assert.deepEqual(skuOptions(row(),monitor,ownWatch(),at),[]);
 }
 const monitor=ownMonitor(),watch=ownWatch();watch.observations.listings={...ownSnapshot(),status:'failed',attemptedAt:'2026-11-03T04:00:30Z'};
 assert.deepEqual(skuOptions(row(),monitor,watch,at),[]);assert.equal(productChannels({...row(),rule:{}},monitor,watch,at).fba.state,'unknown');
});

test('the newest listing read is selected per ASIN, including the existing physical-stock refresh',()=>{
 const monitor=ownMonitor(),watch=ownWatch(),r={...row({sellerSku:'',condition:'new'}),rule:{}};
 watch.observations.listings={...ownSnapshot(),checkedAt:'2026-11-03T04:00:30Z',asins:['B000OTHER1'],rows:[]};
 assert.equal(productChannels(r,monitor,watch,at).fba.state,'active');assert.equal(skuOptions(r,monitor,watch,at).length,3);
 const physical={...ownSnapshot(),checkedAt:'2026-11-03T04:00:40Z',rows:[]};
 assert.equal(productChannels(r,monitor,watch,at,physical).fba.state,'absent');assert.deepEqual(skuOptions(r,monitor,watch,at,physical),[]);
});

test('merchant quantity is a single-SKU live listing count, separate from FBA and physical inventory',()=>{
 const monitor=ownMonitor();monitor.salesTargets.listingSnapshot.rows=[{asin,sellerSku:'FBM',condition:'used_good',statuses:['BUYABLE'],fulfillment:[{channel:'DEFAULT',quantity:2}]}];
 const r={...row({sellerSku:'',fba:{quantity:null,status:'not_fba'}}),rule:{}},channels=productChannels(r,monitor,ownWatch(),at);
 assert.equal(channels.merchant.state,'active');assert.equal(channels.merchant.quantity,2);assert.equal(channels.fba.state,'absent');assert.equal(channels.fba.quantity,null);
 const option=skuOptions(r,monitor,ownWatch(),at)[0];assert.equal(option.merchant,true);assert.equal(option.fba,false);assert.equal(option.merchantQuantity,2);
 monitor.inventoryReviews=[{key:'link:fixture',asin,sellerSku:'',manualFbaQuantity:11,checkedAt:at}];
 assert.equal(stockDisplay({...r,channels},monitor,at).fba.quantity,null);
 monitor.salesTargets.listingSnapshot.rows.push({...monitor.salesTargets.listingSnapshot.rows[0],sellerSku:'FBM-OTHER'});
 assert.equal(productChannels(r,monitor,ownWatch(),at).merchant.quantity,null);
 assert.equal(productChannels({...r,sellerSku:'FBM'},monitor,ownWatch(),at).merchant.quantity,2);
 monitor.salesTargets.listingSnapshot.rows[0].fulfillment.push({channel:'DEFAULT',quantity:5});assert.equal(productChannels({...r,sellerSku:'FBM'},monitor,ownWatch(),at).merchant.quantity,null);
});
