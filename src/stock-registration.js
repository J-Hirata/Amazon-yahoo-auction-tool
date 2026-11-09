import {createHash} from 'node:crypto';
import {applyStockCommand,stockCommandDigest} from './physical-stock.js';
import {registerPageLink} from './link-monitor.js';
import {addDrafts} from './cloud-drafts.js';
import {applyPlanningCommand} from './sales-planning.js';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function registration(command){
  const value=command.registration;
  if(!['create','edit'].includes(command.kind)||!value||Array.isArray(value)||Object.keys(value).some(k=>!['merchant','yahoo','planning','yahooUrl'].includes(k))||['merchant','yahoo','planning'].some(k=>typeof value[k]!=='boolean')||typeof value.yahooUrl!=='string'||value.yahooUrl.length>2048||value.yahooUrl&&!value.yahoo)throw fail('同時登録する販路・監視を確認してください');
  if(value.yahoo&&!command.product?.asin)throw fail('ヤフオクの同時登録にはASINを入力してください');
  return value;
}
export function registrationDocuments(command){
  const r=registration(command);
  return ['physical-stock',...(r.yahoo?[r.yahooUrl?'link-monitor':'draft-items']:[]),...(r.planning?['sales-planning']:[])];
}
function planId(id){const hex=createHash('sha256').update(id+':planning').digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);}
// Executed on an isolated preview or under one database transaction. No marketplace writes.
export async function applyStockRegistration(docs,command,{actor,at,expectedRevision,sourceRevisions}){
  const r=registration(command),state=docs['physical-stock'].state,old=state.receipts.find(x=>x.id===command.operationId);
  if(old){if(old.actor!==actor||old.digest!==stockCommandDigest(command))throw fail('操作IDと内容が一致しません',409);return {...old,replayed:true};}
  if(expectedRevision!==docs['physical-stock'].revision||registrationDocuments(command).some(k=>k!=='physical-stock'&&sourceRevisions?.[k]!==docs[k].revision))throw fail('登録先が更新されました。入力を残して最新の内容で確認し直してください',409);
  const receipt=applyStockCommand(state,structuredClone(command),{actor,at}),p=state.products.find(x=>x.id===receipt.productId),summary=[];
  p.useChannels=[...new Set([...(p.useChannels||[]),...(r.merchant?['merchant']:[]),...(r.yahoo?['yahoo']:[])])];
  if(r.merchant)summary.push('Amazon自社発送の管理対象に追加（出品状態は別途確認）');
  if(r.yahoo&&r.yahooUrl){
    const link=registerPageLink(docs['link-monitor'].state,{amazon:p.asin,yahoo:r.yahooUrl,submitted:true},at);
    // A new URL carries no verified SKU/condition identity; keep that uncertainty visible.
    if(!p.linkedLinkIds.includes(link.id))p.linkedLinkIds.push(link.id);
    summary.push('ヤフオクURLを関連付け');
  }else if(r.yahoo){
    const drafts=docs['draft-items'].state,existing=drafts.find(d=>d.asin===p.asin);
    await addDrafts(drafts,p.asin,at);
    if(!existing){const item=drafts.find(d=>d.asin===p.asin);item.title=p.title;item.description=p.setContents||'';if(p.imageUrl)item.imageUrls=[p.imageUrl];}
    summary.push(existing?'既存のヤフオク下書きを利用（入力・状態を保持）':'ヤフオク下書き候補に追加（出品前の確認待ち）');
  }
  if(r.planning){
    const planning=docs['sales-planning'].state,existing=planning.plans.find(plan=>plan.source.kind==='stock'&&plan.source.id===p.id&&plan.status!=='closed');
    if(!existing)applyPlanningCommand(planning,{operationId:command.operationId,kind:'create',planId:planId(command.operationId),plan:{title:p.title,asin:p.asin,sellerSku:p.sellerSku,condition:p.condition,setContents:p.setContents,imageUrl:p.imageUrl||'',source:{kind:'stock',id:p.id},kind:'amazon',status:'active',durationDays:10,availableOn:'',reviewOn:'',note:p.memo,decisions:['undecided'],linkedLinkIds:p.linkedLinkIds}},{actor,at,sources:[{kind:'stock',...p}]});
    summary.push(existing?'登録済みの販売監視を利用':'販売監視に追加（販売開始日・方針は後で設定）');
  }
  receipt.registrationSummary=summary;
  return receipt;
}
