// Display stock counts separately from orders, reservations and physical locations.
export const current = (date, at) => {const age=Date.parse(at)-Date.parse(date);return Number.isFinite(age)&&age>=-60000&&age<=26*3600000;};
export const count = v => Number.isSafeInteger(v)&&v>=0?v:null;
export const conditionName = v => ({newnew:'新品',newitem:'新品',new:'新品',usedlikenew:'中古・ほぼ新品',usedverygood:'中古・非常に良い',usedgood:'中古・良い',usedacceptable:'中古・可',used:'中古',unknown:'状態未確認'})[String(v||'').replace(/[_ -]/g,'').toLowerCase()]||v||'状態未確認';
export function yahooAvailability(y,at){
 const valid=y?.verified&&current(y.checkedAt,at);
 if(!valid)return {...y,state:'unknown',quantity:null,quantitySource:'unknown'};
 if(y.status==='ended')return {...y,state:'ended',quantity:0,quantitySource:'ended'};
 if(y.status!=='active')return {...y,state:'unknown',quantity:null,quantitySource:'unknown'};
 const quantity=count(y.quantity);
 return {...y,state:'active',quantity:quantity??(y.saleType==='auction'?1:null),quantitySource:quantity!==null?'yahoo':y.saleType==='auction'?'single_auction':'unknown'};
}
export function reviewFor(row,monitor){
 return (monitor.inventoryReviews||[]).filter(r=>row.sourceKeys.includes(r.key)&&r.asin===row.asin&&(r.sellerSku||'')===(row.sellerSku||row.fba?.sellerSku||'')).sort((a,b)=>String(b.checkedAt).localeCompare(String(a.checkedAt)))[0];
}
export function ownListingSnapshot(row,monitor,watch,extra){
 return [monitor.salesTargets?.listingSnapshot,watch?.observations?.listings,extra].filter(s=>s?.asins?.includes(row.asin)).sort((a,b)=>Date.parse(b.attemptedAt||b.checkedAt)-Date.parse(a.attemptedAt||a.checkedAt))[0];
}
export function skuOptions(row,monitor,watch,at,extra){
 const s=ownListingSnapshot(row,monitor,watch,extra);
 if(s?.status!=='complete'||s.source!=='own_seller_listings'||s.accountKey!==monitor.amazonAccountKey||s.sellerId!==monitor.amazonSellerId||s.marketplaceId!=='A1VC38T7YXB528'||!s.asins?.includes(row.asin)||!current(s.checkedAt,at))return [];
 const fba=watch?.observations?.fba,validFba=fba?.status==='complete'&&fba.complete&&fba.accountKey===monitor.amazonAccountKey&&fba.sellerId===monitor.amazonSellerId&&fba.asins?.includes(row.asin)&&current(fba.checkedAt,at);
 return s.rows.filter(p=>p.asin===row.asin).map(p=>{
  const stocks=validFba?fba.items.filter(i=>i.asin===p.asin&&i.sellerSku===p.sellerSku):[],merchant=p.fulfillment.filter(f=>f.channel==='DEFAULT');
  return {sellerSku:p.sellerSku,condition:conditionName(p.condition),conditionKey:p.condition,shipping:[...new Set(p.fulfillment.map(f=>f.channel.startsWith('AMAZON')?'FBA':f.channel==='DEFAULT'?'自社発送':'未確認'))].join('・'),fba:p.fulfillment.some(f=>f.channel.startsWith('AMAZON')),merchant:merchant.length>0,sellable:p.statuses.includes('BUYABLE'),fbaQuantity:stocks.length===1?count(stocks[0].fulfillableQuantity):null,merchantQuantity:merchant.length===1?count(merchant[0].quantity):null};
 });
}
export function stockDisplay(row,monitor,at){
 const review=reviewFor(row,monitor),manual=count(review?.manualFbaQuantity),original=row.fba||{quantity:null,status:'unknown'};
 const merchantOnly=original.status==='not_fba'||row.channels?.fba?.state==='absent'&&['active','inactive'].includes(row.channels?.merchant?.state);
 const fba=count(original.quantity)!==null?{...original,source:'amazon'}:!merchantOnly&&manual!==null&&current(review.checkedAt,at)&&!(original.status==='ambiguous'&&!row.sellerSku)?{...original,quantity:manual,status:'manual',source:'manual',checkedAt:review.checkedAt,sellerSku:review.sellerSku||row.sellerSku||''}:{...original,quantity:null,source:'unknown'};
 const yahoo=(row.yahoo||[]).map(y=>yahooAvailability(y,at));
 const known=yahoo.filter(y=>y.quantity!==null),required=known.reduce((n,y)=>n+y.quantity*(count(y.unitsPerListing)||1),0);
 return {fba,yahoo,yahooQuantity:yahoo.length&&known.length===yahoo.length?known.reduce((n,y)=>n+y.quantity,0):null,knownRequired:required,sku:row.sellerSku||fba.sellerSku||'',condition:conditionName(row.amazonCondition||fba.condition||row.condition),
  locations:row.locations||[],unit:row.unit||'個',linkConflicts:row.linkConflicts||[],review:review||null};
}
export function attachAvailability(rows,monitor,at){
 for(const row of rows)row.availability=stockDisplay(row,monitor,at);
 const pools=new Map();
 for(const row of rows){const a=row.availability;if(!a.sku||!row.asin)continue;const key=JSON.stringify([row.asin,a.sku]);const p=pools.get(key)||{quantities:new Set(),listings:new Map()};if(a.fba.quantity!==null)p.quantities.add(a.fba.quantity);for(const y of a.yahoo)p.listings.set(y.listingId,y);pools.set(key,p);}
 for(const row of rows){
  const a=row.availability,p=a.sku?pools.get(JSON.stringify([row.asin,a.sku])):null;
  const items=p?[...p.listings.values()]:a.yahoo,known=items.filter(y=>y.quantity!==null),required=known.reduce((n,y)=>n+y.quantity*(count(y.unitsPerListing)||1),0);
  a.poolRequired=required;a.poolListings=items.length;a.poolComplete=known.length===items.length;
  const ended=a.yahoo.length&&a.yahoo.every(y=>y.state==='ended');
  if(p?.quantities.size>1){a.level='warning';a.message='同じSKUの在庫記録が不一致';}
  else if(a.fba.quantity!==null&&required>a.fba.quantity){a.level='danger';a.message=`${items.length>1?'同じSKUのヤフオク合計':'ヤフオク'}がFBAより${required-a.fba.quantity}個多い`;}
  else if(ended){a.level='danger';a.message=a.fba.quantity>0?'出品終了・再出品を確認':'ヤフオク出品終了';}
  else if(a.linkConflicts.length){a.level='warning';a.message='紐付け先のSKU・商品情報を確認';}
  else if(!a.yahoo.length){a.level='none';a.message='ヤフオクURL未登録';}
  else if(a.fba.quantity===null||!a.sku||!a.poolComplete||a.yahoo.some(y=>y.state==='unknown')){a.level='warning';a.message=!a.sku?'SKU・在庫の確認が必要':'在庫数・出品状態を確認';}
  else {a.level='ok';a.message=required===a.fba.quantity?'在庫数一致':'ヤフオク販売数はFBA在庫以内';}
  if(['warning','danger'].includes(a.level)&&!row.attention.includes(a.message))row.attention.push(a.message);
 }
 return rows;
}
