import {applyStockWorkspace,workspaceDocuments} from './stock-workspace.js';
import {createHash} from 'node:crypto';
import {applyStockCommand,stockCommandDigest} from './physical-stock.js';
import {registerPageLink} from './link-monitor.js';
import {associateDraft,relationIssue} from './product-relations.js';
import {applyPlanningCommand} from './sales-planning.js';
import {productOverview,emptyProductWatch} from './product-overview.js';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function registration(command){
  const value=command.registration||{merchant:false,yahoo:false,planning:false,yahooUrl:''};
  if(!['create','edit'].includes(command.kind)||!value||Array.isArray(value)||Object.keys(value).some(k=>!['merchant','yahoo','planning','yahooUrl','draft'].includes(k))||['merchant','yahoo','planning'].some(k=>typeof value[k]!=='boolean')||typeof value.yahooUrl!=='string'||value.yahooUrl.length>2048||value.yahooUrl&&!value.yahoo)throw fail('同時登録する販路・監視を確認してください');
  if(value.yahoo&&!command.product?.asin)throw fail('ヤフオクの同時登録にはASINを入力してください');
  if(value.draft!==undefined&&typeof value.draft!=='boolean')throw fail('下書きの登録先を確認してください');
  return value;
}
export function registrationDocuments(command){
  const r=registration(command);
  return [...new Set(['physical-stock',...workspaceDocuments(command.workspace),...(r.yahoo?[r.yahooUrl||command.product?.linkedLinkIds?.length?'link-monitor':'draft-items']:[]),...(r.planning?['sales-planning']:[]),...(r.draft?['draft-items','link-monitor']:[])])];
}
function planId(id){const hex=createHash('sha256').update(id+':planning').digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);}
// Executed on an isolated preview or under one database transaction. No marketplace writes.
export async function applyStockRegistration(docs,command,{actor,at,expectedRevision,sourceRevisions}){
  const r=registration(command),state=docs['physical-stock'].state,old=state.receipts.find(x=>x.id===command.operationId);
  if(old){if(old.actor!==actor||old.digest!==stockCommandDigest(command))throw fail('操作IDと内容が一致しません',409);return {...old,replayed:true};}
  if(command.kind==='create'&&command.product?.asin&&state.products.some(p=>!relationIssue(command.product,p)))throw fail('同じ商品の在庫が登録済みです。商品情報・販路編集で既存在庫を選択してください');
  if(expectedRevision!==docs['physical-stock'].revision||registrationDocuments(command).some(k=>k!=='physical-stock'&&sourceRevisions?.[k]!==docs[k].revision))throw fail('登録先が更新されました。入力を残して最新の内容で確認し直してください',409);
  const receipt=applyStockCommand(state,structuredClone(command),{actor,at}),p=state.products.find(x=>x.id===receipt.productId),summary=[];
  p.useChannels=[...new Set([...(p.useChannels||[]),...(r.merchant?['merchant']:[]),...(r.yahoo?['yahoo']:[])])];
  if(r.merchant)summary.push('Amazon自社発送の管理対象に追加（出品状態は別途確認）');
  if(r.yahoo&&r.yahooUrl){
    const link=registerPageLink(docs['link-monitor'].state,{amazon:p.asin,yahoo:r.yahooUrl,submitted:true},at);
    // A new URL carries no verified SKU/condition identity; keep that uncertainty visible.
    if(!p.linkedLinkIds.includes(link.id))p.linkedLinkIds.push(link.id);
    summary.push('ヤフオクURLを関連付け');
  }else if(r.yahoo&&p.linkedLinkIds.length){
    receipt.yahooUrls=p.linkedLinkIds.map(id=>docs['link-monitor'].state.links.find(l=>l.id===id)).filter(Boolean).map(l=>'https://auctions.yahoo.co.jp/jp/auction/'+l.listingId);summary.push('登録済みヤフオク出品を利用：'+receipt.yahooUrls.join(' ／ '));
  }else if(r.yahoo&&r.draft===false)throw fail('商品紐付けにはヤフオク出品URLまたは登録済み出品を指定してください');
  const wantsDraft=r.draft===true||(r.draft===undefined&&r.yahoo&&!r.yahooUrl&&!p.linkedLinkIds.length);

  if(r.planning){
    const planning=docs['sales-planning'].state,row=productOverview({monitor:docs['link-monitor'].state,physical:state,planning,watch:docs['product-watch']?.state||emptyProductWatch(),drafts:[]},at).find(row=>row.sourceKeys.includes('stock:'+p.id)),existing=row?.plans.find(plan=>plan.status!=='closed');
    if(!existing)applyPlanningCommand(planning,{operationId:command.operationId,kind:'create',planId:planId(command.operationId),plan:{title:p.title,asin:p.asin,sellerSku:p.sellerSku,condition:p.condition,setContents:p.setContents,imageUrl:p.imageUrl||'',source:{kind:'stock',id:p.id},kind:'amazon',status:'active',durationDays:10,availableOn:'',reviewOn:'',note:p.memo,decisions:['undecided'],linkedLinkIds:p.linkedLinkIds}},{actor,at,sources:[{kind:'stock',...p}]});
    summary.push(existing?'登録済みの販売監視を利用':'販売監視に追加（販売開始日・方針は後で設定）');
  }
  if(wantsDraft){const plan=docs['sales-planning']?.state.plans.find(x=>x.status!=='closed'&&(x.workspaceStockId===p.id||x.source.kind==='stock'&&x.source.id===p.id));await associateDraft(docs,p,{stockId:p.id,planId:plan?.id,linkIds:p.linkedLinkIds},at);summary.push('ヤフオク出品下書きへ関連登録（既存の文面・作業状態は保持）');}
  await applyStockWorkspace(docs,command,p,receipt,{actor,at,summary});
  receipt.registrationSummary=summary;
  return receipt;
}
