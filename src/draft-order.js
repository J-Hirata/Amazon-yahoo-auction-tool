export function orderedDrafts(items){
  return items.map((item,index)=>({item,index})).sort((a,b)=>
    (Number.isSafeInteger(a.item.workPriority)?a.item.workPriority:Infinity)-(Number.isSafeInteger(b.item.workPriority)?b.item.workPriority:Infinity)||
    (Date.parse(a.item.createdAt)||0)-(Date.parse(b.item.createdAt)||0)||a.index-b.index).map(x=>x.item);
}
// Replace only the visible slots; filtering must never move hidden products arbitrarily.
export function reorderDrafts(items,order){
  if(!Array.isArray(order)||!order.length||order.length>5000||new Set(order).size!==order.length||order.some(id=>typeof id!=='string'||!items.some(item=>item.asin===id)))throw Object.assign(new Error('並べ替える商品を読み直してください'),{status:400});
  const selected=new Set(order);let index=0;
  const ids=orderedDrafts(items).map(item=>selected.has(item.asin)?order[index++]:item.asin);
  const ranks=new Map(ids.map((id,i)=>[id,i]));for(const item of items)item.workPriority=ranks.get(item.asin);
}
