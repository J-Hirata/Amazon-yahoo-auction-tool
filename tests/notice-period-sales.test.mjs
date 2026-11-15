import test from 'node:test';import assert from 'node:assert/strict';
import {periodSales,periodSalesLine} from '../src/period-sales.js';import {alertEvidence,endedListingUrl} from '../src/alert-evidence.js';import {productAlertsHtml,productAlertsMail} from '../src/product-alert-mail.js';
const at='2026-11-16T00:00:00Z',period={startsOn:'2026-11-02',endsOn:'2026-11-12'},asin='B000TEST01',sku='OWN-FBA';
function fixture(){const row={key:'stock:one',sourceKeys:['stock:one','link:one'],linkIds:['one'],asin,sellerSku:sku,condition:'used',rule:{key:'stock:one'},plans:[]};const tracker={sourceId:'stock:one',asin,sellerSku:sku,condition:'UsedGood',startedAt:'2026-10-25T00:00:00Z'};const monitor={amazonAccountKey:'own',amazonSellerId:'OWN',salesTracking:{accountKey:'own',sellerId:'OWN',marketplaceId:'A1VC38T7YXB528',startedAt:tracker.startedAt,trackers:[tracker],orders:[],events:[],sync:{status:'complete'},checkedThrough:'2026-11-15T00:48:00Z'}};return{row,monitor,tracking:monitor.salesTracking};}
const order=(id,patch={})=>({orderId:id,itemId:'item',asin,sellerSku:sku,status:'SHIPPED',fulfillment:'AMAZON',createdAt:'2026-11-05T00:00:00Z',confirmedQuantity:1,...patch});

test('period totals use inclusive Japanese calendar days and distinct confirmed order lines',()=>{
 const f=fixture();f.tracking.orders=[order('a',{createdAt:'2026-11-01T15:00:00Z',confirmedQuantity:2}),order('b',{createdAt:'2026-11-12T14:59:59.999Z',fulfillment:'MERCHANT'}),order('before',{createdAt:'2026-11-01T14:59:59.999Z',confirmedQuantity:10}),order('after',{createdAt:'2026-11-12T15:00:00Z',confirmedQuantity:10})];const before=structuredClone(f);const result=periodSales(f.row,f.monitor,period,at);assert.equal(result.quantity,3);assert.equal(result.status,'complete');assert.deepEqual(f,before);
});

test('cancelled, pending and MCF quantities never inflate the confirmed total; duplicate receipts count once',()=>{
 const f=fixture(),sale=order('one',{confirmedQuantity:3});f.tracking.orders=[sale,{...sale},order('cancelled',{status:'CANCELLED',confirmedQuantity:20}),order('pending',{status:'PENDING',confirmedQuantity:20}),order('mcf',{fulfillment:'NON_AMAZON',confirmedQuantity:20})];f.tracking.events=[{delta:30}];const result=periodSales(f.row,f.monitor,period,at);assert.equal(result.quantity,3);assert.equal(result.pendingOrders,1);assert.match(periodSalesLine(result),/未確定注文あり/);
});

test('an absent start is not reconstructed from the due date, alert creation date or duration',()=>{
 const f=fixture();f.row.createdAt='2026-11-01';f.row.rule.reviewDays=10;f.tracking.orders=[order('one',{confirmedQuantity:3})];const result=periodSales(f.row,f.monitor,{startsOn:'',endsOn:'2026-11-12'},at);assert.equal(result.quantity,null);assert.equal(result.observedQuantity,null);assert.match(periodSalesLine(result),/開始日未設定/);
});

test('complete zero differs from no tracker, a late tracker or an unfinished download',()=>{
 const f=fixture();assert.equal(periodSales(f.row,f.monitor,period,at).quantity,0);
 f.tracking.orders=[order('one',{confirmedQuantity:3})];for(const change of ['tracker','start','sync','through']){const m=structuredClone(f.monitor);if(change==='tracker')m.salesTracking.trackers=[];if(change==='start')m.salesTracking.trackers[0].startedAt='2026-11-03T00:00:00Z';if(change==='sync')m.salesTracking.sync.status='failed';if(change==='through')m.salesTracking.checkedThrough='2026-11-10T00:00:00Z';const result=periodSales(f.row,m,period,at);assert.equal(result.quantity,null);assert.match(periodSalesLine(result),/未確認/);}
});

test('a backdated tracker does not cover missing global history and unknown orders never become zero',()=>{
 const f=fixture();f.tracking.startedAt='2026-11-05T00:00:00Z';assert.equal(periodSales(f.row,f.monitor,period,at).quantity,null);f.tracking.startedAt='2026-10-25T00:00:00Z';f.tracking.orders=[order('unknown',{status:'UNKNOWN',confirmedQuantity:5})];assert.equal(periodSales(f.row,f.monitor,period,at).quantity,null);
});

test('the same ASIN on another SKU, unrelated source or another account is excluded',()=>{
 const f=fixture();f.tracking.orders=[order('own',{confirmedQuantity:3}),order('other',{sellerSku:'OTHER',confirmedQuantity:40})];f.tracking.trackers.push({...f.tracking.trackers[0],sellerSku:'OTHER',sourceId:'stock:other'});assert.equal(periodSales(f.row,f.monitor,period,at).quantity,3);f.monitor.amazonSellerId='DIFFERENT';assert.equal(periodSales(f.row,f.monitor,period,at).quantity,null);
});

test('conflicting product references or a conflicting known condition hold the total',()=>{
 for(const change of ['reference','link','condition']){const f=fixture();f.tracking.orders=[order('one',{confirmedQuantity:3})];if(change==='reference')f.row.referenceIssue=true;if(change==='link')f.row.linkConflicts=['different'];if(change==='condition')f.tracking.trackers[0].condition='NewItem';assert.equal(periodSales(f.row,f.monitor,period,at).quantity,null);}
});

test('whole product totals require an explicit condition and retain unique related SKUs',()=>{
 const f=fixture();f.row.sellerSku='';f.tracking.trackers.push({...f.tracking.trackers[0],sourceId:'link:one'},{...f.tracking.trackers[0],sellerSku:'SECOND'},{...f.tracking.trackers[0],sellerSku:'NEW',condition:'NewItem'});f.tracking.orders=[order('first'),order('second',{sellerSku:'SECOND',confirmedQuantity:2}),order('new',{sellerSku:'NEW',confirmedQuantity:40})];assert.equal(periodSales(f.row,f.monitor,period,at).quantity,3);f.row.condition='unknown';assert.equal(periodSales(f.row,f.monitor,period,at).quantity,null);
});

test('ongoing periods show the covered timestamp and omit orders beyond that coverage',()=>{
 const f=fixture();f.tracking.orders=[order('one',{confirmedQuantity:3}),order('future',{createdAt:'2026-11-15T05:00:00Z',confirmedQuantity:20})];const result=periodSales(f.row,f.monitor,{...period,endsOn:'2026-11-20'},at);assert.equal(result.quantity,3);assert.equal(result.status,'in_progress');assert.match(periodSalesLine(result),/2026\/11\/15.*まで/);
});

test('the confirmed coverage boundary is included, while a missing order array is not a known zero',()=>{
 const f=fixture();f.tracking.orders=[order('edge',{createdAt:f.tracking.checkedThrough,confirmedQuantity:2})];assert.equal(periodSales(f.row,f.monitor,{...period,endsOn:'2026-11-20'},at).quantity,2);delete f.tracking.orders;assert.equal(periodSales(f.row,f.monitor,period,at).quantity,null);
});

test('conflicting duplicates, invalid dates and unknown fulfillment are held instead of summed',()=>{
 const f=fixture();for(const orders of [[order('one'),order('one',{confirmedQuantity:7})],[order('one',{createdAt:'bad'})],[order('one',{fulfillment:'UNKNOWN'})]]){f.tracking.orders=orders;assert.equal(periodSales(f.row,f.monitor,period,at).quantity,null);}assert.equal(periodSales(f.row,f.monitor,{startsOn:'2026-11-13',endsOn:'2026-11-12'},at).quantity,null);assert.equal(periodSales(f.row,f.monitor,{startsOn:'2026-02-30',endsOn:'2026-11-12'},at).quantity,null);
});

test('stock warnings use stored watch dates, then explicitly linked plan dates, and never invent dates',()=>{
 const f=fixture();f.row.rule.startedOn=period.startsOn;f.row.watchDue=period.endsOn;f.tracking.orders=[order('one',{confirmedQuantity:3})];let d=alertEvidence(f.row,{kind:'stock',lines:['残数警告']},f.monitor,at);assert.equal(d.periodSales[0].sales.quantity,3);assert.ok(d.lines.includes('期間中販売個数 3個（Amazon確定）'));
 delete f.row.rule.startedOn;delete f.row.watchDue;f.row.plans=[{id:'plan',status:'active',schedule:{startedOn:period.startsOn,dueOn:period.endsOn}}];d=alertEvidence(f.row,{kind:'stock',lines:[]},f.monitor,at);assert.equal(d.periodSales[0].sales.quantity,3);f.row.plans=[];d=alertEvidence(f.row,{kind:'stock',lines:[]},f.monitor,at);assert.equal(d.periodSales[0].sales.quantity,null);
});

test('different linked monitoring periods remain separate and memos preserve newlines',()=>{
 const f=fixture();f.row.rule.note='一個も売れなければ小物へ\n本人の判断を待つ';f.row.plans=[{id:'first',title:'最初の観察',status:'active',note:'既存の計画メモ',schedule:{startedOn:'2026-11-02',dueOn:'2026-11-12'}},{id:'second',title:'次の観察',status:'active',salesMemo:'次の計画',schedule:{startedOn:'2026-11-05',dueOn:'2026-11-14'}}];const before=structuredClone(f);const d=alertEvidence(f.row,{kind:'stock',lines:[]},f.monitor,at);assert.equal(d.periodSales.length,2);assert.ok(d.lines.some(l=>l.includes(f.row.rule.note)));assert.deepEqual(f,before);
});

test('a review shows its own plan and action memo without borrowing another plan',()=>{
 const f=fixture();f.row.plans=[{id:'first',status:'active',note:'今回の目的',actionSchedules:[{id:'action',note:'本人のアクションメモ'}]},{id:'other',status:'active',note:'別の目的'}];const d=alertEvidence(f.row,{kind:'review',planId:'first',actionId:'action',period,lines:['販売監視期間 2026-11-02 → 2026-11-12']},f.monitor,at);assert.ok(d.lines.some(l=>l.includes('今回の目的')));assert.ok(d.lines.some(l=>l.includes('本人のアクションメモ')));assert.ok(!d.lines.some(l=>l.includes('別の目的')));
});

test('mail links use each stored ending ID once, keep the control link and escape multiline memos',()=>{
 const f=fixture();f.row.rule.note='<script>test</script>\n次の方針';const details=alertEvidence(f.row,{kind:'relist',listingId:'w1248833062',lines:['再出品してください']},f.monitor,at),alert={id:'12bb4210-7cba-4a28-9465-a06a461dc0fa',key:'yahoo-ended:w1248833062',title:'サクサ',asin,mailDetails:details};const html=productAlertsHtml([alert],{at}),text=productAlertsMail([alert],{at});assert.equal(html.split('https://auctions.yahoo.co.jp/jp/auction/w1248833062').length-1,1);assert.match(html,/>ヤフオク!再販 ↗<\/a>/);assert.match(html,/#notice=12bb4210/);assert.match(html,/&lt;script&gt;test&lt;\/script&gt;<br>次の方針/);assert.ok(!html.includes('<script>'));assert.ok(text.includes(f.row.rule.note));assert.equal(endedListingUrl({kind:'relist',listingId:'javascript:bad'}),'');assert.equal(endedListingUrl({kind:'review',listingId:'w1248833062'}),'');
});
