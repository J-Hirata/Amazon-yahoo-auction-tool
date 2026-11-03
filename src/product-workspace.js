import {current} from './product-availability.js';
import {stockTotals} from './physical-stock.js';

export const conditionFamily=value=>/^(new|新品)/i.test(value||'')?'new':/^(used|中古)/i.test(value||'')?'used':'unknown';
const stockCondition=value=>value==='parts'?'parts':conditionFamily(value);
const compatibleCondition=(a,b)=>a==='unknown'||b==='unknown'||a===b;
function linkFbaRows(link,monitor,watch,at){
  const snapshot=watch?.observations?.fba;
  if(snapshot?.status!=='complete'||!snapshot.complete||snapshot.accountKey!==monitor.amazonAccountKey||snapshot.sellerId!==monitor.amazonSellerId||!snapshot.asins?.includes(link.asin)||!current(snapshot.checkedAt,at))return [];
  const selected=link.amazonSellerSku||monitor.catalog.find(p=>p.id===link.catalogId)?.sellerSku;
  return snapshot.items.filter(p=>p.asin===link.asin&&(!selected||p.sellerSku===selected));
}
export function resolvedLinkSku(link,monitor,watch,at){
  const catalog=monitor.catalog.find(p=>p.id===link.catalogId);
  const selected=link.amazonSellerSku||catalog?.sellerSku;
  if(selected)return selected;
  const rows=linkFbaRows(link,monitor,watch,at);
  return rows.length===1?rows[0].sellerSku||'':'';
}
export function resolvedLinkCondition(link,monitor,watch,at){
  const rows=linkFbaRows(link,monitor,watch,at);
  if(rows.length===1)return rows[0].condition||'unknown';
  const p=monitor.catalog.find(p=>p.id===link.catalogId);
  return (!link.amazonSellerSku||link.amazonSellerSku===p?.sellerSku)&&p?.condition||'unknown';
}
export function productWorkspace(row,{physical,monitor,watch,at}){
  const stocks=(row.stockIds||[]).map(id=>physical.products.find(p=>p.id===id)).filter(Boolean);
  const sku=row.sellerSku||row.fba?.sellerSku||'';
  const stockCandidates=physical.products.filter(p=>row.asin&&p.asin===row.asin&&!stocks.some(s=>s.id===p.id)).map(p=>{
    const family=stockCondition(row.condition==='parts'?'parts':row.fba?.condition||row.condition);
    const mismatch=Boolean(sku&&p.sellerSku&&sku!==p.sellerSku||!compatibleCondition(family,stockCondition(p.condition)));
    return {id:p.id,title:p.title,sellerSku:p.sellerSku,condition:p.condition,unit:p.unit,locations:stockTotals(physical,p.id).locations,mismatch};
  });
  return {key:row.key,sourceKeys:row.sourceKeys,stocks:stocks.map(p=>({id:p.id,title:p.title,sellerSku:p.sellerSku,unit:p.unit})),stockCandidates,
    links:row.linkIds.map(id=>monitor.links.find(l=>l.id===id)).filter(Boolean).map(l=>({id:l.id,listingId:l.listingId})),
    linkCandidates:monitor.links.filter(l=>l.verified&&!l.observationConflict&&!row.linkIds.includes(l.id)&&(l.asin||monitor.catalog.find(p=>p.id===l.catalogId)?.asin)===row.asin&&(!sku||!resolvedLinkSku(l,monitor,watch,at)||sku===resolvedLinkSku(l,monitor,watch,at))&&compatibleCondition(stockCondition(row.condition),stockCondition(resolvedLinkCondition(l,monitor,watch,at)))).map(l=>({id:l.id,listingId:l.listingId})),
    plans:row.plans.map(p=>({id:p.id,title:p.title,status:p.status,stage:p.schedule.stage,dueOn:p.schedule.dueOn})),replenishment:row.replenishmentInfo};
}
