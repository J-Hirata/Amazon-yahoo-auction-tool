import {createHash} from "node:crypto";
import {asinFromInput,registerPageLink,observeListing} from "./link-monitor.js";
import {yahooListingUrl} from "./yahoo-observation.js";
import {applyStockCommand} from "./physical-stock.js";
import {applyPlanningCommand} from "./sales-planning.js";
import {resolvedLinkSku,resolvedLinkCondition,conditionFamily} from './product-workspace.js';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v||"");
function source(docs,key){
 const match=typeof key==="string"&&key.match(/^(link|stock|plan):([0-9a-f-]{36})$/i);if(!match)throw fail("対象商品を選び直してください");
 const [,kind,id]=match,m=docs['link-monitor'].state,s=docs['physical-stock'].state,p=docs['sales-planning'].state;
 const item=kind==="link"?m.links.find(p=>p.id===id):kind==="stock"?s.products.find(p=>p.id===id):p.plans.find(p=>p.id===id);if(!item)throw fail("対象商品が見つかりません。一覧を更新してください",409);
 const catalog=kind==="link"?m.catalog.find(p=>p.id===item.catalogId):null;
 const stock=kind==="stock"?item:kind==="plan"&&item.source.kind==="stock"?s.products.find(p=>p.id===item.source.id):null;
 const linkIds=[...new Set(kind==="link"?[id]:[...(stock?.linkedLinkIds||[]),...(item.linkedLinkIds||[]),...(kind==="plan"&&item.source.kind==="link"?[item.source.id]:[])])];
 return {kind,id,item,stock,asin:item.asin||catalog?.asin||"",linkIds,title:item.title||catalog?.title||m.listings.find(y=>y.listingId===item.listingId)?.title||item.asin||"商品"};
}
const inventoryKey=s=>s.kind==='plan'&&s.stock?'stock:'+s.stock.id:s.kind==='plan'&&s.item.source.kind==='link'?'link:'+s.item.source.id:`${s.kind}:${s.id}`;
export function productLinkInfo(docs,key){const s=source(docs,key),m=docs['link-monitor'].state;return {key,title:s.title,asin:s.asin,sellerSku:s.kind==='link'?s.item.amazonSellerSku||m.catalog.find(p=>p.id===s.item.catalogId)?.sellerSku||'':s.stock?.sellerSku||s.item.sellerSku||'',manualReview:(m.inventoryReviews||[]).find(r=>r.key===inventoryKey(s))||null,revision:docs['link-monitor'].revision,sourceRevisions:Object.fromEntries(Object.entries(docs).map(([k,d])=>[k,d.revision])),yahoo:s.linkIds.map(id=>m.links.find(l=>l.id===id)).filter(Boolean).map(l=>({linkId:l.id,listingId:l.listingId,url:`https://auctions.yahoo.co.jp/jp/auction/${l.listingId}`}))};}
function associationIdentity(s,docs,watch,at){
 const m=docs['link-monitor'].state,catalog=m.catalog.find(p=>p.id===s.item.catalogId);
 return s.kind==='link'?{asin:s.asin,sellerSku:resolvedLinkSku(s.item,m,watch,at),condition:resolvedLinkCondition(s.item,m,watch,at),setContents:catalog?.setContents||''}:{asin:s.asin,sellerSku:s.item.sellerSku||'',condition:s.item.condition,setContents:s.item.setContents||''};
}
function checkAssociation(s,target,docs,watch,at){
 if(!s.asin||s.asin!==target.asin)throw fail('同じASINの商品を選んでください。数量は変更していません',409);
 const m=docs['link-monitor'].state,link=target.kind==='link'?target:s.kind==='link'?s:null;
 if(!link||!link.item.verified||link.item.observationConflict)throw fail('確認済みの紐付け商品を選んでください',409);
 const identities=[s,target].map(p=>associationIdentity(p,docs,watch,at));
 const stock=s.stock||target.stock;
 if(stock)identities.push({sellerSku:stock.sellerSku,condition:stock.condition,setContents:stock.setContents});
 for(const id of new Set([...s.linkIds,...target.linkIds,...(stock?.linkedLinkIds||[])])){const item=m.links.find(l=>l.id===id);if(item)identities.push(associationIdentity(source(docs,'link:'+id),docs,watch,at));}
 const skus=new Set(identities.map(p=>p.sellerSku).filter(Boolean)),families=new Set(identities.map(p=>p.condition==='parts'?'parts':conditionFamily(p.condition)).filter(c=>c!=='unknown'));
 const rank=v=>String(v||'').replace(/[_ -]/g,'').toLowerCase(),ranks=new Set(identities.map(p=>rank(p.condition)).filter(c=>/^used(likenew|verygood|good|acceptable)$/.test(c)));
 const sets=new Set(identities.map(p=>p.setContents?.trim()).filter(Boolean));
 if(skus.size>1||families.size>1||ranks.size>1||sets.size>1)throw fail('SKU・状態・セット内容が異なる商品は関連付けできません。元の商品情報を確認してください',409);
}
export function applyProductLinkEdit(docs,command,{actor,at=new Date().toISOString(),expectedRevision,sourceRevisions,watch}={}){
 if(!uuid(command?.operationId)||!actor)throw fail("保存する操作と本人を確認してください");
 const m=docs['link-monitor'].state,digest=createHash('sha256').update(JSON.stringify(command)).digest('hex'),receipts=m.productLinkReceipts||[],old=receipts.find(r=>r.id===command.operationId);
 if(old){if(old.digest!==digest||old.actor!==actor)throw fail("同じ操作IDの内容が異なります",409);return {...old,replayed:true};}
 if(receipts.length>=10000)throw fail("URL変更履歴の保存上限です",409);
 const s=source(docs,command.key),primary=s.kind==="plan"?'sales-planning':s.kind==="stock"?'physical-stock':'link-monitor';
 if(expectedRevision!==docs['link-monitor'].revision||![primary,...(s.stock?['physical-stock']:[])].every(k=>sourceRevisions?.[k]===docs[k].revision))throw fail("ほかの編集・自動確認が保存されました。URL入力を残したまま最新の内容を読み直してください",409);
 if(command.kind==='associate-existing'){
  if(command.confirmed!==true)throw fail('選んだ商品の関連付けを確認してください');
  const target=source(docs,command.targetKey),targetDocument=target.kind==='stock'?'physical-stock':target.kind==='plan'?'sales-planning':'link-monitor';
  if(sourceRevisions?.[targetDocument]!==docs[targetDocument].revision)throw fail('選択先の商品が更新されました。最新の内容で選び直してください',409);
  if(s.kind==='link'?target.kind!=='stock':target.kind!=='link')throw fail('登録済みの出品と在庫・計画の組み合わせを選んでください');
  checkAssociation(s,target,docs,watch,at);
  const stock=s.stock||target.stock,linkId=s.kind==='link'?s.id:target.id;
  if(stock&&!stock.linkedLinkIds.includes(linkId))applyStockCommand(docs['physical-stock'].state,{operationId:command.operationId,kind:'edit',productId:stock.id,product:{...stock,linkedLinkIds:[...stock.linkedLinkIds,linkId]},reason:'登録済みの出品と在庫を関連付け'},{actor,at});
  if(s.kind==='plan'&&!s.stock&&!s.linkIds.includes(linkId))applyPlanningCommand(docs['sales-planning'].state,{operationId:command.operationId,kind:'edit',planId:s.id,plan:{...s.item,linkedLinkIds:[...(s.item.linkedLinkIds||[]),linkId]}},{actor,at});
  const receipt={id:command.operationId,digest,actor,at,key:command.key,targetKey:command.targetKey,linkId,kind:command.kind};receipts.push(receipt);m.productLinkReceipts=receipts;m.logs.push({kind:'product_association_saved',at,actor,key:command.key,targetKey:command.targetKey});return receipt;
 }
 if(command.kind==='inventory'||command.kind==='manual-fba'){
  const manualOnly=command.kind==='manual-fba',sku=command.sellerSku??(manualOnly?productLinkInfo(docs,command.key).sellerSku:undefined),q=command.manualFbaQuantity;
  if(typeof sku!=='string'||sku.length>200||/[\x00-\x1f]/.test(sku)||q!==null&&(!Number.isSafeInteger(q)||q<0||q>1000000))throw fail('SKUと手入力のFBA在庫数を確認してください');
  if(!s.asin)throw fail('先にAmazonの商品URLを登録してください');
  const sellerSku=sku.trim(),storedSku=productLinkInfo(docs,command.key).sellerSku;
  if(manualOnly&&storedSku&&storedSku!==sellerSku)throw fail('商品のSKUが更新されました。入力を残して最新の内容を確認してください',409);
  const catalog=m.catalog.find(p=>p.id===s.item.catalogId),condition=s.stock?.condition||(s.kind==='plan'?s.item.condition:/^new/i.test(catalog?.condition||'')?'new':/^used/i.test(catalog?.condition||'')?'used':'unknown');
  const review={key:inventoryKey(s),asin:s.asin,sellerSku,manualFbaQuantity:q,checkedAt:at,actor,condition,...(manualOnly?{mode:'manual'}:{})};
  const targetLink=s.kind==='link'?s.item:s.kind==='plan'&&s.item.source.kind==='link'?m.links.find(l=>l.id===s.item.source.id):null;
  if(targetLink&&!manualOnly){const from=targetLink.amazonSellerSku||'';targetLink.amazonSellerSku=sellerSku;(targetLink.history||=[]).push({kind:'sku_selected',at,actor,from,to:sellerSku});}
  if(s.stock&&!manualOnly)applyStockCommand(docs['physical-stock'].state,{operationId:command.operationId,kind:'edit',productId:s.stock.id,product:{...s.stock,sellerSku},reason:'比較対象のAmazon SKUを確認'},{actor,at});
  if(s.kind==='plan'&&!manualOnly){
   const catalog=m.catalog.find(p=>p.id===targetLink?.catalogId),origin=s.stock?{kind:'stock',...s.stock}:targetLink?{kind:'link',id:targetLink.id,asin:targetLink.asin||catalog?.asin||'',sellerSku:targetLink.amazonSellerSku||catalog?.sellerSku||'',condition:targetLink.matchBy==='asin'?'unknown':/^new/i.test(catalog?.condition||'')?'new':/^used/i.test(catalog?.condition||'')?'used':'unknown',setContents:catalog?.setContents||''}:null;
   applyPlanningCommand(docs['sales-planning'].state,{operationId:command.operationId,kind:'edit',planId:s.id,plan:{...s.item,sellerSku}},{actor,at,sources:origin?[origin]:[]});
  }
  const previous=(m.inventoryReviews||[]).find(r=>r.key===review.key);
  if(previous)(m.inventoryReviewHistory||=[]).push({...previous,replacedAt:at});
  m.inventoryReviews=[...(m.inventoryReviews||[]).filter(r=>r.key!==review.key),review];
  const receipt={id:command.operationId,digest,actor,at,key:command.key,kind:command.kind};receipts.push(receipt);m.productLinkReceipts=receipts;m.logs.push({kind:'inventory_review_saved',at,actor,key:command.key});return receipt;
 }
 let asin;try{asin=asinFromInput(command.amazon);}catch(e){throw fail(e.message);}if(s.asin&&s.asin!==asin)throw fail("登録済みの商品とASINが異なります。商品情報の訂正から確認してください",409);
 if(s.stock?.asin&&s.stock.asin!==asin)throw fail("元の在庫と計画の商品が異なります。商品情報を揃えてからURLを登録してください",409);
 if(!s.asin&&s.kind==="plan"&&s.item.source.kind!=="manual")throw fail("先に元の在庫商品のASINを登録してください",409);
 if(typeof command.yahoo!=="string"||command.yahoo.length>2048)throw fail("ヤフオクの商品URLを入力してください");
 let identity;try{identity=command.yahoo.trim()?yahooListingUrl(command.yahoo):null;}catch{throw fail("ヤフオクの出品IDがあるHTTPS商品URLを入力してください");}
 if(!identity&&s.asin===asin)throw fail("追加・変更するヤフオクURLを入力してください");
 let linkId=command.replaceLinkId||"";
 if(linkId&&!s.linkIds.includes(linkId))throw fail("この商品に登録された出品を選んでください",409);
 if(identity){
  if(s.kind==="link")linkId=s.id;
  if(linkId){
   const link=m.links.find(l=>l.id===linkId),other=m.links.find(l=>l.listingId===identity.listingId&&l.id!==linkId);
   if(other)throw fail("このURLは別の紐付けとして登録済みです。既存の出品から関連付けてください",409);
   let listing=m.listings.find(l=>l.listingId===identity.listingId);
   if(!listing)listing=observeListing(m,{...identity,title:"",seller:"",references:[],observation:{status:"unknown",verified:false,checkedAt:at,source:"page_link",evidence:"本人がURLを登録。自動確認の結果はまだ取得していません"}});
   if((listing.references||[]).some(r=>r.kind==="asin"&&r.value!==asin))throw fail("URL先の管理番号とASINが一致しません",409);
   if(link.listingId!==identity.listingId){const previousListing=m.listings.find(l=>l.listingId===link.listingId);link.previousListingTitle=previousListing?.title||link.previousListingTitle||"";link.previousListingImageUrl=previousListing?.imageUrl||link.previousListingImageUrl||"";(link.history||=[]).push({at,kind:"url_changed",fromListingId:link.listingId,toListingId:identity.listingId,actor});link.listingId=identity.listingId;link.verified=true;link.observationConflict=false;link.reviewedAt=at;link.referenceFingerprint=JSON.stringify(listing.references||[]);}
  }else{
   const existing=m.links.find(l=>l.listingId===identity.listingId),existingAsin=existing?.asin||m.catalog.find(p=>p.id===existing?.catalogId)?.asin;
   if(existing){if(existingAsin!==asin)throw fail("別のASINに登録されているURLです",409);linkId=existing.id;}
   else linkId=registerPageLink(m,{amazon:asin,yahoo:identity.url,submitted:true},at).id;
  }
 }
 if(s.kind!=="link"){
  const linked=linkId?[...new Set([...s.linkIds,linkId])]:s.linkIds;
  const linkedItem=m.links.find(l=>l.id===linkId),catalog=m.catalog.find(p=>p.id===linkedItem?.catalogId),selectedSku=linkedItem?.amazonSellerSku||catalog?.sellerSku,family=/^new/i.test(catalog?.condition||"")?"new":/^used/i.test(catalog?.condition||"")?"used":"unknown";
  if(linkId&&!s.linkIds.includes(linkId)&&(family!=="unknown"&&["new","used"].includes(s.item.condition)&&s.item.condition!==family||s.item.sellerSku&&selectedSku&&s.item.sellerSku!==selectedSku))throw fail("出品と在庫・計画の状態やSKUが異なります",409);
  if(s.stock)applyStockCommand(docs['physical-stock'].state,{operationId:command.operationId,kind:"edit",productId:s.stock.id,product:{...s.stock,asin,linkedLinkIds:linked},reason:"タイルから出品URLを登録・変更"},{actor,at});
  if(s.kind==="plan"&&!s.stock){
   const sources=s.item.source.kind==="link"?[{kind:"link",id:s.item.source.id,asin,sellerSku:s.item.sellerSku,condition:s.item.condition,setContents:s.item.setContents}]:[];
   applyPlanningCommand(docs['sales-planning'].state,{operationId:command.operationId,kind:"edit",planId:s.id,plan:{...s.item,asin,linkedLinkIds:linked}},{actor,at,sources});
  }
 }
 const receipt={id:command.operationId,digest,actor,at,key:command.key,linkId};receipts.push(receipt);m.productLinkReceipts=receipts;m.logs.push({at,kind:"product_url_saved",actor,key:command.key});return receipt;
}
export function createProductLinkEditor({transaction,overview,refresh}){
 return {async list(){const [docs,view]=await Promise.all([transaction.read(),overview.view()]);const entries={};for(const row of view.rows)for(const key of row.sourceKeys)if(/^(link|stock|plan):/.test(key)){try{const s=source(docs,key);entries[key]={...productLinkInfo(docs,key),imageUrl:row.imageUrl||'',condition:s.kind==='link'?row.amazonCondition||row.fba.condition||row.condition:s.item.condition,setContents:s.item.setContents||docs['link-monitor'].state.catalog.find(c=>c.id===s.item.catalogId)?.setContents||'',memo:s.stock?.memo||s.item.userMemo||s.item.note||'',resolvedSku:row.availability.sku||'',live:{fba:row.fba,channels:row.channels,yahoo:row.yahoo||[],availability:row.availability,skuOptions:row.skuOptions||[],workspace:row.workspace}};}catch{}}return {entries};},async save(command,options){const watch=command?.kind==='associate-existing'?(await overview.inputs()).watch:undefined;return transaction.update(docs=>applyProductLinkEdit(docs,command,{...options,watch}));},refresh};
}
