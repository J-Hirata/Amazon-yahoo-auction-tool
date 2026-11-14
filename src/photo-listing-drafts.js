import {id,hash,stableItemId} from '../shared/photo-bridge.mjs';
import {CONFIG} from './config.js';
const fail=(m,status=400)=>Object.assign(Error(m),{status});
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const draftId=(p,channel='yahoo')=>stableItemId(p.sourceWorkspaceId,p.productId+':'+channel);
const channels=['yahoo','mercari'];
const ready=d=>!!(d.title.trim()&&d.description.trim()&&d.price&&d.assetIds.length);
export function validatePhotoListingDrafts(state){
 const drafts=state.listingDrafts||[],ops=state.listingDraftOperations||[];
 if(!Array.isArray(drafts)||!Array.isArray(ops)||new Set(drafts.map(d=>d?.id)).size!==drafts.length)throw fail('写真からの下書きの保存形式を確認してください');
 for(const d of drafts){
  const p=state.packages.find(p=>p.packageId===d?.packageId);
  if(!p||d.id!==draftId(p,d.channel)||!channels.includes(d.channel)||d.sourceItemId!==stableItemId(p.sourceWorkspaceId,p.productId)||!Number.isSafeInteger(d.version)||d.version<1||
   !text(d.title,500)||!d.title.trim()||!text(d.description,20000)||!text(d.note,2000)||!(d.price===null||Number.isSafeInteger(d.price)&&d.price>0&&d.price<=100000000)||
   !Array.isArray(d.assetIds)||!d.assetIds.length||d.assetIds.length>10||new Set(d.assetIds).size!==d.assetIds.length||d.assetIds.some(a=>!p.assets.some(v=>v.id===a))||typeof d.archived!=='boolean'||!Array.isArray(d.history)||!Number.isFinite(Date.parse(d.createdAt))||!Number.isFinite(Date.parse(d.updatedAt)))throw fail('下書きの商品と写真の対応を確認してください');
 }
 for(const d of drafts)if(d.researchContextId&&!(state.researchContexts||[]).some(c=>c.id===d.researchContextId&&c.packageId===d.packageId&&c.decision.channel===d.channel))throw fail('下書きとリサーチの写真セットが一致しません');
 if(ops.some(o=>!id(o?.id)||!id(o.draftId)||typeof o.actor!=='string'||!/^[a-f0-9]{64}$/.test(o.digest)))throw fail('下書きの保存記録を確認してください');
 return state;
}
export function createPhotoListingDrafts({store,sourceOrigin,now=()=>new Date().toISOString()}){
 function display(d,state){
  const p=state.packages.find(p=>p.packageId===d.packageId);
  return {...d,ready:ready(d),asin:p.asin||'',sourceName:p.name,sourceUrl:sourceOrigin+'/products/'+p.productId+'/photos',projectName:p.projectName,batchTitle:p.batchTitle,
   photos:d.assetIds.map(assetId=>p.assets.find(a=>a.id===assetId)),package:p};
 }
 async function view(){
  const saved=await store.readSnapshot();validatePhotoListingDrafts(saved.state);
  return {researchContexts:saved.state.researchContexts||[],revision:saved.revision,items:(saved.state.listingDrafts||[]).map(d=>display(d,saved.state)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),yahooSellerUrl:CONFIG.yahooSellerUrl,mercariSellerUrl:'https://jp.mercari.com/sell/create'};
 }
 async function save(input,{expectedRevision,actor}){
  if(!input||!id(input.operationId)||!['save','archive','restore'].includes(input.action)||!Number.isSafeInteger(input.version)||input.version<0)throw fail('下書きの保存内容を確認してください');
  const fingerprint=hash(JSON.stringify(input)),before=await store.readSnapshot(),receipt=(before.state.listingDraftOperations||[]).find(o=>o.id===input.operationId);
  if(receipt){if(receipt.actor!==actor||receipt.digest!==fingerprint)throw fail('同じ操作IDで内容が変わっています',409);return {id:receipt.draftId,...await view()};}
  let resultId;
  await store.update(state=>{
   state.listingDrafts ||= [];state.listingDraftOperations ||= [];
   const existingReceipt=state.listingDraftOperations.find(o=>o.id===input.operationId);
   if(existingReceipt)throw fail('前の保存が反映されました。一覧を更新してください',409);
   const p=state.packages.find(p=>p.packageId===input.packageId);if(!p)throw fail('受け取った写真セットを選んでください',404);
   const channel=input.channel??'yahoo';if(!channels.includes(channel))throw fail('販売先はヤフオク・メルカリから選んでください');resultId=draftId(p,channel);const previous=state.listingDrafts.find(d=>d.id===resultId);
   if((previous?.version||0)!==input.version)throw fail('この商品の下書きが更新されました。入力を残して最新の下書きを確認してください',409);
   const at=now();
   if(input.action==='save'){
    const values=input.values;
    if(!values||!text(values.title,500)||!values.title.trim()||!text(values.description,20000)||!text(values.note,2000)||!(values.price===null||Number.isSafeInteger(values.price)&&values.price>0&&values.price<=100000000)||
     !Array.isArray(values.assetIds)||values.assetIds.length<1||values.assetIds.length>10||new Set(values.assetIds).size!==values.assetIds.length||values.assetIds.some(a=>!p.assets.some(v=>v.id===a)))throw fail('商品名・価格・使う写真（1〜10枚）を確認してください');
    if(new Set(values.assetIds.map(a=>p.assets.find(v=>v.id===a).sha256)).size!==values.assetIds.length)throw fail('同じ内容の写真が重複しています。1枚だけ選んでください');
    const researchContextId=Object.hasOwn(values,'researchContextId')?values.researchContextId:(previous?.packageId===p.packageId?previous.researchContextId:null)??null;
    if(researchContextId&&!(state.researchContexts||[]).some(c=>c.id===researchContextId&&c.packageId===p.packageId&&c.decision.channel===channel))throw fail('同じ写真セットのリサーチ結果を選んでください');
    if(previous?.archived)throw fail('アーカイブから戻してから編集してください',409);
    const next={id:resultId,sourceItemId:stableItemId(p.sourceWorkspaceId,p.productId),packageId:p.packageId,channel,researchContextId,title:values.title.trim(),description:values.description,note:values.note,price:values.price,assetIds:values.assetIds,archived:false,version:(previous?.version||0)+1,createdAt:previous?.createdAt||at,updatedAt:at,
     history:[...(previous?.history||[]),{action:'saved',at,actor,packageId:p.packageId,assetIds:values.assetIds,version:(previous?.version||0)+1}]};
    if(previous)Object.assign(previous,next);else state.listingDrafts.push(next);
   }else{
    if(!previous||previous.packageId!==p.packageId)throw fail('保存済みの下書きを選んでください',404);
    previous.archived=input.action==='archive';previous.version++;previous.updatedAt=at;previous.history.push({action:input.action,at,actor,version:previous.version});
   }
   state.listingDraftOperations.push({id:input.operationId,draftId:resultId,digest:fingerprint,actor,at});validatePhotoListingDrafts(state);
  },{expectedRevision});
  return {id:resultId,...await view()};
 }
 async function exportData(draft,version){
  if(!id(draft)||!Number.isSafeInteger(version))throw fail('保存した下書きを選んでください');
  const v=await view(),d=v.items.find(d=>d.id===draft);if(!d)throw fail('下書きがありません',404);if(d.version!==version)throw fail('下書きが更新されました。最新の内容を確認して取得してください',409);
  const title='商品名：'+d.title+'\r\n'+(d.channel==='mercari'?'販売価格：':'開始価格：')+(d.price===null?'未入力':d.price+'円')+'\r\n\r\n【商品説明】\r\n'+d.description.replace(/\r?\n/g,'\r\n');
  return {id:d.id,version:d.version,channel:d.channel,references:(v.researchContexts.find(c=>c.id===d.researchContextId)?.decision.references||[]),title:d.title,text:title,note:d.note,packageId:d.packageId,photos:d.photos,identifiers:d.package.identifiers.filter(r=>d.assetIds.includes(r.assetId)),sourceUrl:d.sourceUrl};
 }
 return {view,save,exportData};
}
