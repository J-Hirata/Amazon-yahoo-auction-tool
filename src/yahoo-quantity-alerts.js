import {randomUUID} from 'node:crypto';

const prefix='yahoo-quantity:';
const valid=(y,at)=>y?.verified&&y.status==='active'&&Number.isSafeInteger(y.quantity)&&y.quantity>=0&&
  Number.isFinite(Date.parse(y.checkedAt))&&Date.parse(at)-Date.parse(y.checkedAt)>=-60000&&Date.parse(at)-Date.parse(y.checkedAt)<=26*3600000;

// Public listing quantity is evidence of a display change, never an order or a
// movement in the physical-stock ledger. Unknown observations keep the baseline.
export function collectYahooQuantityAlerts(state,rows,settings,at,previousYahoo=[]){
  const signals=state.signals ||= {},pending=state.pendingAlerts ||= [],seen=new Set();
  for(const row of rows)for(const y of row.yahoo||[]){
    if(seen.has(y.listingId))continue;seen.add(y.listingId);
    const baselineKey=`yahoo-quantity-base:${y.listingId}`,saved=signals[baselineKey];
    const previous=saved||previousYahoo.find(p=>p.listingId===y.listingId&&p.verified&&p.status==='active'&&Number.isSafeInteger(p.quantity)&&p.quantity>=0);
    const current=valid(y,at)&&(!previous||Date.parse(y.checkedAt)>=Date.parse(previous.checkedAt));
    for(const p of pending.filter(p=>p.key?.startsWith(prefix)&&p.listingId===y.listingId)){
      const known=current||y.verified&&y.status==='ended';
      const active=current&&p.quantityTo===y.quantity;
      signals[p.key]={...signals[p.key],known:Boolean(known),...(known?{active:Boolean(active)}:{}),at};
      if(known&&!active&&!p.queuedAt)p.dismissedAt ||= at;
    }
    if(!current)continue;
    if(settings.yahooAlerts&&previous&&Date.parse(y.checkedAt)>Date.parse(previous.checkedAt)&&previous.quantity!==y.quantity){
      const id=randomUUID(),key=`${prefix}${y.listingId}:${y.checkedAt}`;
      pending.push({id,key,eventKey:`product:${key}:${id}`,category:'yahooAlerts',at,title:row.title||y.listingId,asin:row.asin||'',listingId:y.listingId,
        quantityFrom:previous.quantity,quantityTo:y.quantity,message:`ヤフオクの表示数量が ${previous.quantity}個 → ${y.quantity}個 に変わりました。落札・販売の確定数ではありません。在庫台帳と出品数量を確認してください。\nhttps://auctions.yahoo.co.jp/jp/auction/${y.listingId}`});
      signals[key]={active:true,known:true,at};
    }
    signals[baselineKey]={quantity:y.quantity,checkedAt:y.checkedAt,active:false,known:true,at};
  }
  for(const p of pending.filter(p=>p.key?.startsWith(prefix)&&!seen.has(p.listingId))){signals[p.key]={active:false,known:true,at};if(!p.queuedAt)p.dismissedAt ||= at;}
  if(pending.length>5000)throw new Error('通知履歴の保存上限を確認してください');
  return pending.filter(p=>p.key?.startsWith(prefix)&&!p.queuedAt&&!p.dismissedAt&&signals[p.key]?.known&&signals[p.key]?.active);
}
