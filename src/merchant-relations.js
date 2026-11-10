import {current,ownListingSnapshot,count} from './product-availability.js';
import {stockImageUrl} from './stock-images.js';
const family=v=>/^new/i.test(v||'')?'new':/^used/i.test(v||'')?'used':v==='parts'?'parts':'unknown';
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
export function ownedListingSnapshot(s,monitor){
 return s?.status==='complete'&&s.source==='own_seller_listings'&&Boolean(monitor.amazonAccountKey)&&Boolean(monitor.amazonSellerId)&&s.accountKey===monitor.amazonAccountKey&&s.sellerId===monitor.amazonSellerId&&s.marketplaceId==='A1VC38T7YXB528'&&Array.isArray(s.asins)&&Array.isArray(s.rows);
}
export function merchantSnapshot(asin,monitor,watch,extra){
 return [ownListingSnapshot({asin},monitor,watch,extra),...(monitor.merchantListingSnapshots||[])].filter(s=>s?.asins?.includes(asin)).sort((a,b)=>Date.parse(b.attemptedAt||b.checkedAt)-Date.parse(a.attemptedAt||a.checkedAt))[0];
}
export function merchantAssociation(row,monitor){
 const refs=(monitor.merchantLinks||[]).filter(r=>row.sourceKeys.includes(r.key)&&r.asin===row.asin&&r.accountKey===monitor.amazonAccountKey&&r.sellerId===monitor.amazonSellerId),skus=[...new Set(refs.map(r=>r.sellerSku))];
 return {refs,conflict:skus.length>1,sellerSku:skus.length===1?skus[0]:''};
}
export function merchantCatalog(docs,at=new Date().toISOString()){
 const m=docs['link-monitor'].state,watch=docs['product-watch']?.state,physical=docs['physical-stock'].state;
 const snapshots=[m.salesTargets?.listingSnapshot,watch?.observations?.listings,physical.amazonListings,...(m.merchantListingSnapshots||[])],asins=[...new Set(snapshots.flatMap(s=>s?.asins||[]))],choices=[];
 for(const asin of asins){
  const s=merchantSnapshot(asin,m,watch,physical.amazonListings);if(!ownedListingSnapshot(s,m))continue;
  const references=[...physical.products,...docs['sales-planning'].state.plans,...(docs['draft-items']?.state||[]),...m.catalog].filter(p=>p.asin===asin);
  for(const r of s.rows.filter(r=>r.asin===asin&&typeof r.sellerSku==='string'&&r.sellerSku&&r.fulfillment?.some(f=>f.channel==='DEFAULT'))){
   const own=r.fulfillment.filter(f=>f.channel==='DEFAULT'),fresh=current(s.checkedAt,at),qty=own.length===1?count(own[0].quantity):null;
   choices.push({id:JSON.stringify([asin,r.sellerSku]),asin,sellerSku:r.sellerSku,title:r.title||references.find(p=>p.title)?.title||asin,imageUrl:stockImageUrl(r.imageUrl)||references.flatMap(p=>[p.imageUrl,...(p.imageUrls||[])]).find(stockImageUrl)||'',condition:family(r.condition),quantity:qty,sellable:r.statuses?.includes('BUYABLE')||false,checkedAt:s.checkedAt,unavailableReason:fresh?'':'出品情報の確認日時が古いため、Amazonの出品情報を更新してください',detail:'Amazon自社発送 ／ '+(r.statuses?.includes('BUYABLE')?'出品中':'販売停止・販売不可')+' ／ 出品数 '+(fresh&&qty!==null?qty+'個':'再取得が必要')});
  }
 }
 return choices;
}
export function saveMerchantAssociation(docs,command,row,{actor,at}){
 if(!Object.hasOwn(command,'merchantSellerSku'))return false; // Old clients can still retain their legacy purpose flag.
 const sku=command.merchantSellerSku;if(typeof sku!=='string'||sku.length>200||sku&&!sku.trim())throw fail('Amazon自社発送の出品SKUを選んでください',400);
 const m=docs['link-monitor'].state,before=merchantAssociation(row,m);
 if(!command.registration.merchant){
  if(sku)throw fail('Amazon自社発送の紐付けを選んでください',400);
  return false; // Associating an existing stock must not erase that stock's merchant reference.
 }
 if(!sku)throw fail('Amazon自社発送の登録済み出品を選んでください',400);
 const candidate=merchantCatalog(docs,at).find(c=>c.asin===row.asin&&c.sellerSku===sku),retained=!before.conflict&&before.sellerSku===sku;
 if(!retained&&(!candidate||candidate.unavailableReason))throw fail('選んだ自社発送出品を確認できません。Amazonの出品情報を更新して選び直してください');
 if(candidate&&family(row.condition)!=='unknown'&&candidate.condition!=='unknown'&&family(row.condition)!==candidate.condition)throw fail('Amazon自社発送の新品・中古が異なります');
 const saved=before.refs.find(r=>r.sellerSku===sku),record={asin:row.asin,sellerSku:sku,accountKey:m.amazonAccountKey,sellerId:m.amazonSellerId,condition:candidate?.condition||saved?.condition||'unknown',checkedAt:candidate?.checkedAt||saved?.checkedAt,linkedAt:retained?saved.linkedAt:at,actor:retained?saved.actor:actor};
 m.merchantLinks=[...(m.merchantLinks||[]).filter(r=>!row.sourceKeys.includes(r.key)),...row.sourceKeys.map(key=>({key,...record}))];
 return 'Amazon自社発送へ紐付け：'+sku+' ／ '+row.asin+(before.conflict?' ／ 既存の異なるSKU '+[...new Set(before.refs.map(r=>r.sellerSku))].join('・')+' をこのSKUに統一':'')+'（FBAのSKU・数量は保持）';
}
export function withMerchantSalesSources(sources,monitor,drafts=[]){
 const result=[...sources];
 for(const ref of monitor.merchantLinks||[]){
  if(ref.accountKey!==monitor.amazonAccountKey||ref.sellerId!==monitor.amazonSellerId)continue;
  const source=sources.find(s=>s.sourceId===ref.key&&s.asin===ref.asin),draft=ref.key==='draft:'+ref.asin&&drafts.find(d=>d.asin===ref.asin);
  if(!source&&!draft)continue;
  if(source&&family(source.condition)!=='unknown'&&ref.condition!=='unknown'&&family(source.condition)!==ref.condition)continue;
  result.push({...source,sourceId:ref.key,asin:ref.asin,sellerSku:ref.sellerSku,title:source?.title||draft.title,condition:ref.condition,merchantOnly:true});
 }
 return result;
}
export async function refreshMerchantListings({transaction,readListings,config,resolveSource,now=()=>new Date().toISOString()},command,options){
 if(!readListings||!config)throw fail('Amazonの自社出品取得の接続設定が必要です',503);
 const docs=await transaction.read(),m=docs['link-monitor'].state,source=resolveSource(docs,command.key),asin=command.asin;
 const check=d=>{if(d['link-monitor'].revision!==options.expectedRevision||Object.keys(d).some(k=>d[k].revision!==options.sourceRevisions?.[k]))throw fail('ほかの編集が保存されています。入力内容を残して最新の商品情報を確認してください');};check(docs);
 if(!/^[A-Z0-9]{10}$/.test(asin||'')||source.asin&&source.asin!==asin||!source.asin&&![...docs['physical-stock'].state.products,...docs['sales-planning'].state.plans,...(docs['draft-items']?.state||[])].some(p=>p.asin===asin))throw fail('この商品のASINを確認してください',400);
 if(config.accountKey!==m.amazonAccountKey||!m.amazonSellerId||config.sellerId&&config.sellerId!==m.amazonSellerId)throw fail('接続済みAmazonアカウントを確認してください');
 let snapshot;try{snapshot=await readListings({asins:[asin],config:{...config,sellerId:m.amazonSellerId}});}catch{throw fail('Amazonの自社発送出品を取得できませんでした。接続を確認し、取得・更新をもう一度押してください。',503);}
 if(!ownedListingSnapshot(snapshot,m)||snapshot.asins.length!==1||snapshot.asins[0]!==asin||!current(snapshot.checkedAt,now())||snapshot.rows.some(r=>r.asin!==asin||typeof r.sellerSku!=='string'||!Array.isArray(r.statuses)||!Array.isArray(r.fulfillment)))throw fail('Amazonの出品情報を最後まで取得できませんでした。既存の紐付けは保持しています');
 await transaction.update(d=>{check(d);const state=d['link-monitor'].state,remaining=(state.merchantListingSnapshots||[]).filter(s=>!s.asins.includes(asin));if(remaining.length>=100)throw fail('出品取得の保存上限です');state.merchantListingSnapshots=[...remaining,{...snapshot,actor:options.actor,attemptedAt:now()}];});
 return {checkedAt:snapshot.checkedAt,offers:snapshot.rows.filter(r=>r.fulfillment.some(f=>f.channel==='DEFAULT')).length};
}
