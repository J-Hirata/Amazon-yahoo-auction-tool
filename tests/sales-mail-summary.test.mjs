import test from 'node:test';
import assert from 'node:assert/strict';
import {salesMailSummary} from '../src/sales-mail-summary.js';
import {createCloudSalesAutomation} from '../src/cloud-sales-automation.js';
const at='2026-11-06T01:00:00Z',base='2026-11-03T05:51:00Z',asin='4056116334',sku='book-new';
const event=(id,patch={})=>({id,orderId:id,itemId:id,asin,sellerSku:sku,fulfillment:'AMAZON',delta:1,eligibleFromAt:'2026-11-05T03:00:00Z',updatedAt:'2026-11-05T04:00:00Z',delivery:'preview',...patch});
function fixture(){
 const events=Array.from({length:5},(_,i)=>event(String(i)));
 const tracker={asin,sellerSku:sku,sourceId:'stock:book',title:'学研 スーパーのりものデラックス',startedAt:'2026-10-25T00:00:00Z'};
 const state={salesTracking:{trackers:[tracker,{...tracker,sellerSku:'old-zero'}],events,orders:[],checkedThrough:at,sync:{status:'complete'}},salesAutomation:{enabled:true,enabledAt:'2026-11-01T00:00:00Z',fbaSales:true,merchantSales:true},mailOutbox:[]};
 const row={asin,sourceKeys:['stock:book'],stockIds:['book'],locations:[{locationId:'container',usable:150,checkedAt:base},{locationId:'home',usable:null,checkedAt:null}],fba:{status:'ambiguous',checkedAt:at,variants:[{sellerSku:sku,quantity:87},{sellerSku:'old-zero',quantity:0}]},availability:{review:{manualFbaQuantity:97,sellerSku:'',checkedAt:base}}};
 return {state,events,inventory:{rows:[row]},at};
}
test('five separate orders become one product section and retain all unit counts',()=>{
 const f=fixture(),r=salesMailSummary(f);assert.equal(r.text.split('学研 スーパーのりものデラックス').length-1,1);assert.match(r.text,/FBA ／ 注文確定 5個/);assert.match(r.text,/2026-11-05：注文日の確定販売 5個/);assert.equal(r.targets.length,1);
});
test('inventory shows exact SKU API and cumulative manual product projection across notifications',()=>{
 const f=fixture();f.state.salesTracking.events.push(event('previous',{delta:4,delivery:'smtp_accepted',sellerSku:'old-zero'}));
 const text=salesMailSummary(f).text;assert.match(text,/このSKU）：87個/);assert.match(text,/商品全体・SKU未指定）：88個/);assert.match(text,/97個 − 基準後のAmazon確定販売9個/);assert.match(text,/コンテナ：150個/);assert.match(text,/自社・自宅：数量未入力/);assert.match(text,/他販路の販売は自動反映しません/);
});
test('observed API quantity is never decreased a second time; missing baseline does not invent an estimate',()=>{
 const f=fixture();delete f.inventory.rows[0].availability.review;const text=salesMailSummary(f).text;
 assert.match(text,/このSKU）：87個/);assert.doesNotMatch(text,/82個|FBA推定残数/);
});
test('different SKU and fulfillment remain separate and corrections are not hidden as net sales',()=>{
 const f=fixture();f.events.push(event('merchant',{fulfillment:'MERCHANT'}),event('other',{sellerSku:'other'}),event('cancel',{delta:-1}));
 const r=salesMailSummary(f);assert.equal(r.targets.length,3);assert.match(r.text,/注文確定 5個 ／ 取消・訂正 1個 ／ 差引 4個/);assert.match(r.text,/自社発送 ／ 注文確定 1個/);
});
test('Japanese midnight splits order dates and a stale backlog is not called yesterday',()=>{
 const f=fixture();f.events=[event('a',{eligibleFromAt:'2026-11-05T14:59:00Z'}),event('b',{eligibleFromAt:'2026-11-05T15:01:00Z'}),event('c',{eligibleFromAt:'2026-11-02T15:01:00Z'})];
 const r=salesMailSummary(f);assert.match(r.text,/2026-11-05：注文日の確定販売 1個/);assert.match(r.text,/2026-11-06：注文日の確定販売 1個/);assert.match(r.text,/2026-11-03：注文日の確定販売 1個/);assert.doesNotMatch(r.text,/昨日/);
});
test('duplicate event IDs and duplicate source rows never multiply sales, FBA or physical quantities',()=>{
 const f=fixture();f.events.push(f.events[0]);f.inventory.rows.push(structuredClone(f.inventory.rows[0]));
 const text=salesMailSummary(f).text;assert.match(text,/注文確定 5個/);assert.match(text,/97個 − 基準後のAmazon確定販売5個/);assert.match(text,/コンテナ：150個/);assert.doesNotMatch(text,/コンテナ：300/);
});
test('unknown, unlinked and zero remain distinct, even if a foreign row has the same ASIN/SKU',()=>{
 const f=fixture();f.inventory.rows[0].sourceKeys=['stock:unrelated'];f.inventory.rows[0].sellerSku=sku;
 assert.match(salesMailSummary(f).text,/コンテナ：在庫台帳の関連付けなし/);
 f.inventory.rows[0].sourceKeys=['stock:book'];f.inventory.rows[0].locations[1].usable=0;
 assert.match(salesMailSummary(f).text,/自社・自宅：0個/);
});
test('incomplete baseline coverage, future baselines and conflicting API values cannot become known stock',()=>{
 const f=fixture();f.state.salesTracking.trackers[0].startedAt=at;assert.match(salesMailSummary(f).text,/計算保留/);
 f.state.salesTracking.trackers[0].startedAt=base;f.inventory.rows[0].availability.review.checkedAt='2026-11-07T00:00:00Z';assert.match(salesMailSummary(f).text,/計算保留/);
 const r=structuredClone(f.inventory.rows[0]);r.fba.variants[0].quantity=99;f.inventory.rows.push(r);assert.match(salesMailSummary(f).text,/このSKU）：取得値なし/);
});
test('negative projections remain explicit and cancelled orders never restore physical stock automatically',()=>{
 const f=fixture();f.inventory.rows[0].availability.review.manualFbaQuantity=2;f.state.salesTracking.events.push(event('cancel',{delta:-1}));
 const text=salesMailSummary(f).text;assert.match(text,/推定残数.*-3個（基準数を要確認）/);assert.match(text,/取消による在庫復帰/);
});
test('read-only formatting leaves events, quantities and dates byte-identical',()=>{
 const f=fixture(),before=JSON.stringify(f);salesMailSummary(f);assert.equal(JSON.stringify(f),before);
});
test('daily run uses refreshed inventory and durable replay/retry keeps the original grouped mail',async()=>{
 const f=fixture();let rows=[],sent=[],revision=0;const store={read:async()=>structuredClone(f.state),update:async fn=>{const copy=structuredClone(f.state);const r=await fn(copy);f.state=copy;revision++;return r;}};
 const engine=createCloudSalesAutomation({store,now:()=>at,sales:{start:async()=>{},check:async()=>{}},monitoring:{run:async()=>{rows=f.inventory.rows;return{status:'complete'};}},readInventory:async()=>({rows}),transport:{send:async mail=>{sent.push(structuredClone(mail));return{status:'smtp_accepted'};}}});
 await engine.run();await engine.run();assert.equal(sent.length,1);assert.match(sent[0].text,/注文確定 5個/);assert.match(sent[0].text,/このSKU）：87個/);assert.equal(f.state.mailOutbox[0].eventIds.length,5);assert.equal(f.state.mailOutbox[0].targets.length,1);
});
test('inventory read failure preserves sale notification with explicit missing counts',async()=>{
 const f=fixture(),sent=[];const store={read:async()=>structuredClone(f.state),update:async fn=>fn(f.state)};
 const engine=createCloudSalesAutomation({store,now:()=>at,readInventory:async()=>{throw new Error('private failure');},transport:{send:async m=>{sent.push(m);return{status:'smtp_accepted'};}}});await engine.queueSales();await engine.drain();assert.equal(sent.length,1);assert.match(sent[0].text,/取得値なし/);assert.match(sent[0].text,/在庫情報の読取に失敗/);assert.doesNotMatch(sent[0].text,/private failure|関連付けなし/);
});
