const time=value=>Date.parse(value);
const valid=value=>Number.isFinite(time(value));
const day=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&valid(value+'T00:00:00Z')&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const family=value=>/^new/i.test(value||'')?'new':/^used/i.test(value||'')?'used':'unknown';
const confirmed=new Set(['UNSHIPPED','PARTIALLY_SHIPPED','SHIPPED']);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const stamp=value=>valid(value)?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'日時未確認';

// Saved, deduplicated Amazon order lines only. No order reads or inventory writes.
export function periodSales(row,monitor={},period={},at,{sellerSku}={}){
 const result={source:'amazon_confirmed_orders',startsOn:period.startsOn||'',endsOn:period.endsOn||'',quantity:null,observedQuantity:null,status:'unknown',reason:'',checkedThrough:monitor.salesTracking?.checkedThrough||null,skus:[]};
 const unknown=reason=>({...result,reason});
 if(!day(result.startsOn))return unknown('開始日未設定');
 if(!day(result.endsOn))return unknown('終了日未設定');
 const start=time(result.startsOn+'T00:00:00+09:00'),end=time(result.endsOn+'T00:00:00+09:00')+86400000,now=time(at);
 if(!Number.isFinite(now)||end<=start)return unknown('監視期間を確認');
 if(start>now)return unknown('監視開始前');
 const tracking=monitor.salesTracking;
 if(!tracking)return unknown('販売履歴未取得');
 if(!Array.isArray(tracking.orders)||!Array.isArray(tracking.trackers))return unknown('販売履歴未取得');
 if(!monitor.amazonAccountKey||!monitor.amazonSellerId||tracking.accountKey!==monitor.amazonAccountKey||tracking.sellerId!==monitor.amazonSellerId||tracking.marketplaceId!=='A1VC38T7YXB528')return unknown('販売履歴の接続先を確認');
 const selectedSku=sellerSku||row.sellerSku||'',keys=new Set(row.sourceKeys||[]),links=new Set(row.linkIds||[]);
 if(!selectedSku&&!['new','used'].includes(row.condition))return unknown('対象SKU・状態未確定');
 const targets=(tracking.trackers||[]).filter(t=>t.asin===row.asin&&(keys.has(t.sourceId)||links.has(t.linkId))&&(selectedSku?t.sellerSku===selectedSku:family(t.condition)===row.condition));
 const skus=[...new Set(targets.map(t=>t.sellerSku).filter(Boolean))];result.skus=skus;
 if(!skus.length)return unknown('対象SKU未追跡');
 const through=time(tracking.checkedThrough),until=Math.min(end,now,through);
 if(!Number.isFinite(through)||through>now+60000||until<start)return unknown('監視期間の販売履歴未取得');
 const scoped=(tracking.orders||[]).filter(o=>o.asin===row.asin&&skus.includes(o.sellerSku));
 const orders=new Map();let uncertain=false,pending=0;
 for(const order of scoped){
  if(order.fulfillment==='NON_AMAZON')continue;
  if(!valid(order.createdAt)){uncertain=true;continue;}
  const created=time(order.createdAt);if(created<start||created>=end||created>now||created>through)continue;
  if(!order.orderId||!order.itemId){uncertain=true;continue;}
  const key=JSON.stringify([order.orderId,order.itemId]),previous=orders.get(key);
  if(previous){if(JSON.stringify([previous.createdAt,previous.status,previous.confirmedQuantity,previous.fulfillment])!==JSON.stringify([order.createdAt,order.status,order.confirmedQuantity,order.fulfillment]))uncertain=true;continue;}
  orders.set(key,order);
 }
 let observed=0;
 for(const order of orders.values()){
  if(!['AMAZON','MERCHANT'].includes(order.fulfillment)||order.status==='UNKNOWN'){uncertain=true;continue;}
  if(confirmed.has(order.status)){if(count(order.confirmedQuantity))observed+=order.confirmedQuantity;else uncertain=true;}
  else if(['PENDING','PENDING_AVAILABILITY'].includes(order.status))pending++;
  else if(!['CANCELLED','UNFULFILLABLE'].includes(order.status))uncertain=true;
 }
 result.observedQuantity=observed;result.pendingOrders=pending;
 const startsCovered=valid(tracking.startedAt)&&time(tracking.startedAt)<=start&&skus.every(sku=>targets.some(t=>t.sellerSku===sku&&valid(t.startedAt)&&time(t.startedAt)<=start));
 if(!startsCovered)return unknown('追跡開始前の期間あり');
 if(tracking.sync?.status!=='complete')return unknown('注文取得が未完了');
 if(uncertain)return unknown('数量・注文状態に未確認あり');
 if(end<=now&&through<end)return unknown('終了日までの取得が未完了');
 return {...result,quantity:observed,status:end<=now?'complete':'in_progress',reason:'',countedThrough:new Date(until).toISOString()};
}

export function periodSalesLine(value){
 if(value.quantity===null)return `期間中販売個数 未確認（${value.reason}${value.observedQuantity===null?'':`／取得済み分 ${value.observedQuantity}個`}）`;
 return `期間中販売個数 ${value.quantity}個（Amazon確定${value.status==='in_progress'?`・${stamp(value.countedThrough)}まで`:''}${value.pendingOrders?'・未確定注文あり':''}）`;
}
