// Shared, read-only counter. A baseline is never destructively decremented.
const valid=v=>Number.isFinite(Date.parse(v));
const count=v=>Number.isSafeInteger(v)&&v>=0;
const fresh=(v,at)=>valid(v)&&Date.parse(at)-Date.parse(v)>=-60000&&Date.parse(at)-Date.parse(v)<=26*3600000;
export function manualFbaCounter(row,review,monitor,at){
 if(!review||!count(review.manualFbaQuantity)||!valid(review.checkedAt)||Date.parse(review.checkedAt)>Date.parse(at))return null;
 const t=monitor.salesTracking,scopes=(t?.trackers||[]).filter(s=>s.asin===row.asin&&(row.sourceKeys||[]).includes(s.sourceId)&&(!s.fulfillment||s.fulfillment.includes('AMAZON'))&&(!review.sellerSku||s.sellerSku===review.sellerSku));
 const skus=[...new Set(scopes.map(s=>s.sellerSku).filter(Boolean))];
 const covered=skus.length&&t?.sync?.status==='complete'&&valid(t.checkedThrough)&&Date.parse(t.checkedThrough)>=Date.parse(review.checkedAt)&&skus.every(s=>scopes.some(x=>x.sellerSku===s&&valid(x.startedAt)&&Date.parse(x.startedAt)<=Date.parse(review.checkedAt)));
 if(!covered)return {status:'incomplete',baseline:review.manualFbaQuantity,baselineAt:review.checkedAt,quantity:null,sales:null,checkedAt:t?.checkedThrough||null,skus};
 const events=[...new Map((t.events||[]).map(e=>[e.id,e])).values()];
 const sales=events.filter(e=>e.asin===row.asin&&skus.includes(e.sellerSku)&&e.fulfillment==='AMAZON'&&e.delta>0&&Date.parse(e.eligibleFromAt)>Date.parse(review.checkedAt)&&Date.parse(e.eligibleFromAt)<=Date.parse(t.checkedThrough)).reduce((n,e)=>n+e.delta,0);
 const quantity=review.manualFbaQuantity-sales;
 return {status:quantity<0?'negative':fresh(t.checkedThrough,at)?'estimated':'stale',quantity,sales,baseline:review.manualFbaQuantity,baselineAt:review.checkedAt,checkedAt:t.checkedThrough,skus};
}
export function effectiveFba(row,review,monitor,at){
 const raw=row.fba||{quantity:null,status:'unknown'};if(raw.status==='not_fba'||row.channels?.fba?.state==='absent'&&['active','inactive'].includes(row.channels?.merchant?.state))return null;const counter=manualFbaCounter(row,review,monitor,at);
 let api=raw;
 // A whole-product reference may sum distinct SKUs only within an explicit condition family.
 if(raw.status==='ambiguous'&&!row.sellerSku&&row.condition==='new'&&raw.variants?.length&&new Set(raw.variants.map(v=>v.sellerSku)).size===raw.variants.length&&raw.variants.every(v=>v.sellerSku&&count(v.quantity)))api={...raw,quantity:raw.variants.reduce((n,v)=>n+v.quantity,0),status:'complete',sellerSku:'',sellerSkus:raw.variants.map(v=>v.sellerSku),scope:'product'};
 if(api.status==='complete'&&count(api.quantity)&&fresh(api.checkedAt,at)&&(!review||Date.parse(api.checkedAt)>=Date.parse(review.checkedAt)))return {...api,source:'amazon',counter};
 if(counter&&['estimated','stale'].includes(counter.status))return {...raw,quantity:counter.quantity,status:'estimated',source:'estimate',stale:counter.status==='stale',checkedAt:counter.checkedAt,sellerSku:review.sellerSku||'',sellerSkus:counter.skus,scope:review.sellerSku?'sku':'product',counter,autoStatus:raw.status};
 return null;
}
export function alertFba(row){
 const raw=row.fba,f=row.availability?.fba,review=row.availability?.review;
 if(review&&Number.isFinite(Date.parse(raw?.checkedAt))&&Date.parse(review.checkedAt)>Date.parse(raw.checkedAt))return f?.source==='estimate'&&!f.stale&&f.counter?.status==='estimated'?{...f,status:'complete'}:{...raw,quantity:null,status:'unknown'};
 if(raw?.status==='complete')return raw;
 if(f?.source==='amazon'&&raw?.status!=='ambiguous')return raw;
 return f&&((f.source==='amazon'&&f.status==='complete')||(f.source==='estimate'&&!f.stale&&f.counter?.status==='estimated'))?{...f,status:'complete'}:raw;
}
