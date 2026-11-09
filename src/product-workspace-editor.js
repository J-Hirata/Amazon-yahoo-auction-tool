import {createHash} from 'node:crypto';
import {emptyPhysicalStock,applyStockCommand,stockTotals,stockCommandDigest} from './physical-stock.js';
import {applyPlanningCommand} from './sales-planning.js';
import {registerPageLink} from './link-monitor.js';
import {applyStockWorkspace} from './stock-workspace.js';
import {productOverview,emptyProductWatch} from './product-overview.js';
import {conditionFamily,resolvedLinkSku,resolvedLinkCondition} from './product-workspace.js';
import {addDrafts} from './cloud-drafts.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v||'');
const family=v=>v==='parts'?'parts':conditionFamily(v);
const child=(id,suffix)=>{const h=createHash('sha256').update(id+suffix).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
const rows=(docs,at)=>productOverview({monitor:docs['link-monitor'].state,physical:docs['physical-stock'].state,planning:docs['sales-planning'].state,watch:docs['product-watch']?.state||emptyProductWatch(),drafts:[]},at);
function origin(docs,key){
 const match=typeof key==='string'&&key.match(/^(link|stock|plan):([0-9a-f-]{36})$/i);
 if(!match)throw fail('対象商品を選び直してください');
 const [,kind,id]=match,state=docs[kind==='link'?'link-monitor':kind==='stock'?'physical-stock':'sales-planning'].state;
 const item=(kind==='link'?state.links:kind==='stock'?state.products:state.plans).find(p=>p.id===id);
 if(!item)throw fail('対象商品が更新されました。一覧を確認してください',409);
 return {kind,id,item};
}
export function workspaceDescriptor(docs,key,row,at=new Date().toISOString()){
 const s=origin(docs,key);row||=rows(docs,at).find(r=>r.sourceKeys.includes(key));
 if(!row)throw fail('対象商品の関連付けを確認してください',409);
 const stock=row.stockIds.length===1?docs['physical-stock'].state.products.find(p=>p.id===row.stockIds[0]):null;
 const local={...s.item,...s.item.workspaceProduct};
 const p=stock||local;
 return {stockId:stock?.id||'',ambiguousStock:row.stockIds.length>1,
  product:{title:p.title||row.title,asin:p.asin||row.asin,sellerSku:p.sellerSku||row.availability?.sku||row.sellerSku||'',condition:stock?stock.condition:[p.condition,row.availability?.condition,row.amazonCondition,row.fba?.condition,row.condition].map(family).find(c=>c!=='unknown')||'unknown',setContents:p.setContents||row.setContents||'',memo:stock?.memo??((s.kind==='plan'?s.item.note:s.item.userMemo)||''),imageUrl:p.imageUrl||row.imageUrl||'',unit:p.unit||'個',fbaEligibility:p.fbaEligibility||'unknown',catalogTask:p.catalogTask||'none',reviewDate:p.reviewDate||'',useChannels:p.useChannels||[]},
  counts:stock?Object.fromEntries(stockTotals(docs['physical-stock'].state,stock.id).locations.map(l=>[l.locationId,l.usable])):{container:null,home:null},
  candidates:row.workspace.stockCandidates.filter(p=>!p.mismatch),linkIds:[...row.linkIds],
  plans:row.plans.map(p=>({id:p.id,status:p.status})),
  yahooUrls:row.linkIds.map(id=>docs['link-monitor'].state.links.find(l=>l.id===id)).filter(Boolean).map(l=>'https://auctions.yahoo.co.jp/jp/auction/'+l.listingId),
  sources:row.sourceKeys};
}
function identity(p,q){
 return p.asin===q.asin&&(!p.sellerSku||!q.sellerSku||p.sellerSku===q.sellerSku)&&
 (family(p.condition)==='unknown'||family(q.condition)==='unknown'||family(p.condition)===family(q.condition))&&
 (!p.setContents||!q.setContents||p.setContents===q.setContents);
}
// One preview/transaction for every destination. No marketplace or mail operations.
export async function applyProductWorkspaceEdit(docs,command,{actor,at=new Date().toISOString(),expectedRevision,sourceRevisions}={}){
 if(!uuid(command?.operationId)||command.kind!=='workspace'||!actor)throw fail('保存用の操作IDと本人を確認してください');
 const monitor=docs['link-monitor'].state,digest=stockCommandDigest(command),receipts=monitor.productLinkReceipts||[],old=receipts.find(r=>r.id===command.operationId);
 if(old){if(old.actor!==actor||old.digest!==digest)throw fail('同じ操作IDの内容が異なります',409);return {...old,replayed:true};}
 if(expectedRevision!==docs['link-monitor'].revision||Object.keys(docs).some(k=>sourceRevisions?.[k]!==docs[k].revision))throw fail('ほかの編集・自動確認が保存されました。入力を残して最新の内容を確認し直してください',409);
 if(receipts.length>=10000)throw fail('商品編集の保存履歴の上限です',409);
 const s=origin(docs,command.key),before=workspaceDescriptor(docs,command.key,undefined,at),reg=command.registration;
 if(!reg||['stock','merchant','yahoo','planning'].some(k=>typeof reg[k]!=='boolean')||typeof reg.yahooUrl!=='string'||reg.yahooUrl.length>2048||reg.yahooUrl&&!reg.yahoo)throw fail('登録先を確認してください');
 if(!command.product||Array.isArray(command.product)||Object.keys(command.product).some(k=>!['title','asin','sellerSku','condition','setContents','memo','imageUrl','fbaEligibility'].includes(k)))throw fail('商品情報の入力を確認してください');
 // Reuse the stock field validator without persisting a physical-stock record.
 const scratch=emptyPhysicalStock();
 const memo=Object.hasOwn(command.product,'memo')?command.product.memo:before.product.memo;
 if(typeof memo!=='string'||memo.length>(reg.stock?500:1000))throw fail(reg.stock?'在庫へ保存するメモは500文字以内にしてください':'メモは1000文字以内にしてください');
 applyStockCommand(scratch,{operationId:child(command.operationId,':validate'),kind:'create',productId:child(command.operationId,':validation-product'),product:{...before.product,...command.product,memo:'',linkedLinkIds:before.linkIds},initialCounts:{container:null,home:null}},{actor,at});
 const product={...Object.fromEntries(Object.keys(before.product).map(k=>[k,scratch.products[0][k]??before.product[k]])),memo},stockState=docs['physical-stock'].state,planning=docs['sales-planning'].state;
 if(before.ambiguousStock)throw fail('複数の実在庫が関連付けされています。対象の在庫を確認してください',409);
 if(before.linkIds.length&&product.asin!==before.product.asin)throw fail('紐付け済み商品のASINは変更できません。別商品を混ぜず確認してください',409);
 if(before.product.sellerSku&&before.product.sellerSku!==product.sellerSku)throw fail('登録済みSKUを別の商品へ変更できません',409);
 let stock=before.stockId?stockState.products.find(p=>p.id===before.stockId):null;
 if(!reg.stock&&stock)throw fail('登録済み在庫はチェックを外して削除できません');
 if(reg.stock&&!stock&&command.stockId){
  stock=stockState.products.find(p=>p.id===command.stockId);
  if(!stock||!before.candidates.some(p=>p.id===stock.id)||!identity(product,stock))throw fail('選択した在庫とASIN・SKU・状態・セット内容が一致しません',409);
 }
 if(reg.stock&&!stock&&before.candidates.length)throw fail('同じ商品の在庫候補があります。登録済みの在庫を選んでください',409);
 if(!reg.stock&&command.workspace?.counts&&Object.keys(command.workspace.counts).length)throw fail('場所別数量を登録する場合はコンテナ・自社在庫を選んでください');
 const selected=[...new Set([...before.linkIds,...(command.linkIds||[])])];
 if(!Array.isArray(command.linkIds)||selected.length>10||selected.some(id=>!uuid(id)))throw fail('紐付け先を確認してください');
 for(const id of selected){
  const link=monitor.links.find(l=>l.id===id);
  if(!link||!link.verified||link.observationConflict||!identity(product,{asin:link.asin||monitor.catalog.find(c=>c.id===link.catalogId)?.asin,sellerSku:resolvedLinkSku(link,monitor,docs['product-watch']?.state,at),condition:resolvedLinkCondition(link,monitor,docs['product-watch']?.state,at),setContents:link.workspaceProduct?.setContents||monitor.catalog.find(c=>c.id===link.catalogId)?.setContents||''}))throw fail('紐付け先とASIN・SKU・状態・セット内容を確認してください',409);
 }
 const summary=[],workspace=structuredClone(command.workspace||{});
 let linkIds=[...selected];
 if(reg.yahoo&&reg.yahooUrl){const link=registerPageLink(monitor,{amazon:product.asin,yahoo:reg.yahooUrl,submitted:true},at);if(!linkIds.includes(link.id))linkIds.push(link.id);summary.push('ヤフオク出品URLを関連付け');}
 else if(reg.yahoo&&!linkIds.length){
  if(!product.asin)throw fail('ヤフオク下書きへの追加にはASINを入力してください');
  const drafts=docs['draft-items'].state,existing=drafts.find(d=>d.asin===product.asin);await addDrafts(drafts,product.asin,at);
  if(!existing){const d=drafts.find(d=>d.asin===product.asin);d.title=product.title;d.description=product.setContents;if(product.imageUrl)d.imageUrls=[product.imageUrl];}
  summary.push(existing?'登録済みの下書きを利用（文面・状態を保持）':'ヤフオク下書きに追加');
 }
 if(reg.stock){
  const stockCommand={operationId:child(command.operationId,':stock'),kind:stock?'edit':'create',productId:stock?.id||child(command.operationId,':stock-product'),product:{...(stock?{...stock,...command.product,sellerSku:stock.sellerSku||product.sellerSku}:product),unit:stock?.unit||product.unit,linkedLinkIds:[...new Set([...(stock?.linkedLinkIds||[]),...linkIds])],useChannels:[...new Set([...(stock?.useChannels||[]),...(reg.merchant?['merchant']:[]),...(reg.yahoo?['yahoo']:[])])]},reason:'商品情報・販路編集'};
  if(!stock){stockCommand.initialCounts={container:workspace.counts?.container??null,home:workspace.counts?.home??null};for(const [id,q]of Object.entries(stockCommand.initialCounts))summary.push((id==='container'?'コンテナ':'自宅・会社')+'：'+(q===null?'未確認':q+product.unit));delete workspace.counts;}
  applyStockCommand(stockState,stockCommand,{actor,at});stock=stockState.products.find(p=>p.id===stockCommand.productId);summary.push(before.stockId?'登録済みの在庫を更新':'コンテナ・自社在庫へ関連登録');
 }
 if(s.kind==='link'){
  s.item.workspaceProduct={...product,useChannels:[...new Set([...(s.item.workspaceProduct?.useChannels||[]),...(reg.merchant?['merchant']:[]),...(reg.yahoo?['yahoo']:[])])]};
  if(Object.hasOwn(command.product,'memo'))s.item.userMemo=product.memo;
  if(product.sellerSku)s.item.amazonSellerSku=product.sellerSku;
 }
 if(s.kind==='plan'){
  const plan={...s.item,...Object.fromEntries(['title','asin','sellerSku','condition','setContents','imageUrl'].map(k=>[k,product[k]])),linkedLinkIds:linkIds};
  if(Object.hasOwn(command.product,'memo'))plan.note=product.memo;
  if(stock)plan.workspaceStockId=stock.id;
  const source={...product,...plan.source};
  applyPlanningCommand(planning,{operationId:child(command.operationId,':plan-edit'),kind:'edit',planId:s.id,plan},{actor,at,sources:[source]});
  Object.assign(planning.plans.find(p=>p.id===s.id),{workspaceProduct:{fbaEligibility:product.fbaEligibility,useChannels:[...new Set([...(s.item.workspaceProduct?.useChannels||[]),...(reg.merchant?['merchant']:[]),...(reg.yahoo?['yahoo']:[])])]}});
  summary.push('販売監視の方針・日付を保持して更新');
 }
 if(reg.planning&&!before.plans.some(p=>p.status!=='closed')&&s.kind!=='plan'){
  const source=stock?{kind:'stock',id:stock.id}:{kind:s.kind,id:s.id},planId=child(command.operationId,':plan');
  applyPlanningCommand(planning,{operationId:child(command.operationId,':plan-create'),kind:'create',planId,plan:{...product,source,kind:'amazon',status:'active',durationDays:10,availableOn:'',reviewOn:'',note:'',decisions:['undecided'],linkedLinkIds:linkIds}},{actor,at,sources:[{...product,...source}]});summary.push('販売監視に追加（方針・日付は未設定）');
 }else if(reg.planning)summary.push('登録済みの販売監視を利用');
 const target=stock||product,receipt={id:command.operationId,digest,actor,at,key:command.key,kind:'workspace',stockId:stock?.id||null};
 if(reg.merchant)summary.push('Amazon自社発送の用途に登録');
 await applyStockWorkspace(docs,{operationId:command.operationId,kind:'edit',workspace},target,receipt,{actor,at,summary,key:stock?'stock:'+stock.id:command.key});
 receipt.registrationSummary=summary;receipts.push(receipt);monitor.productLinkReceipts=receipts;monitor.logs.push({kind:'product_workspace_saved',at,actor,key:command.key});
 return receipt;
}
