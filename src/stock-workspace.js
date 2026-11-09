import {createHash} from 'node:crypto';
import {applyStockCommand,stockTotals} from './physical-stock.js';
import {saveIncoming} from './fba-incoming.js';
import {productOverview,emptyProductWatch,ruleFields} from './product-overview.js';
const fail=m=>Object.assign(new Error(m),{status:400});
const own=(v,k)=>Object.hasOwn(v,k);
const number=n=>Number.isSafeInteger(n)&&n>=0&&n<=1000000;
function childId(id,key){const h=createHash('sha256').update(id+key).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);}
export function workspaceDocuments(w){
 if(w===undefined)return [];
 if(!w||typeof w!=='object'||Array.isArray(w)||Object.keys(w).some(k=>!['counts','manualFbaQuantity','alarmThreshold','incoming'].includes(k)))throw fail('商品編集の入力内容を確認してください');
 return [...(own(w,'manualFbaQuantity')||w.incoming?.length?['link-monitor']:[]),...(own(w,'alarmThreshold')?['product-watch']:[])];
}
export async function applyStockWorkspace(docs,command,p,receipt,{actor,at,summary}){
 const w=command.workspace;if(!w)return;workspaceDocuments(w);
 if(w.counts){if(command.kind!=='edit'||Array.isArray(w.counts)||Object.keys(w.counts).some(k=>!['container','home'].includes(k)))throw fail('場所ごとの数量を確認してください');const totals=stockTotals(docs['physical-stock'].state,p.id),locations={};for(const [id,q] of Object.entries(w.counts)){if(!number(q))throw fail('場所ごとの数量は0以上の整数を入力してください');const before=totals.locations.find(l=>l.locationId===id);locations[id]={usable:q,reserved:before.reserved??0,unusable:before.unusable??0};summary.push(`${id==='container'?'コンテナ':'会社・自宅'}：${before.usable??'未確認'} → ${q}${p.unit}`);}if(Object.keys(locations).length)applyStockCommand(docs['physical-stock'].state,{operationId:childId(command.operationId,':counts'),kind:'count_locations',productId:p.id,locations,reason:'商品編集で場所別実数を確認'},{actor,at});}
 const m=docs['link-monitor']?.state;
 if(own(w,'manualFbaQuantity')){
  const q=w.manualFbaQuantity;if(!p.asin||q!==null&&!number(q))throw fail('ASINとFBA残数の基準値を確認してください');
  const key='stock:'+p.id,old=(m.inventoryReviews||[]).find(r=>r.key===key);if(old)(m.inventoryReviewHistory||=[]).push({...old,replacedAt:at});
  m.inventoryReviews=[...(m.inventoryReviews||[]).filter(r=>r.key!==key),{key,asin:p.asin,sellerSku:p.sellerSku||'',condition:p.condition,manualFbaQuantity:q,mode:'manual',checkedAt:at,actor}];summary.push('FBA残数の基準：'+(q===null?'解除':q+'個')+'（Amazon側は変更しません）');
 }
 if(own(w,'alarmThreshold')){
  const q=w.alarmThreshold;if(q!==null&&!number(q))throw fail('FBAアラームの個数を確認してください');const watch=docs['product-watch'].state,key='stock:'+p.id;
  const old=watch.rules.find(r=>r.key===key),rule=ruleFields({...{key,tags:[],replenishEnabled:false,threshold:10,minimumSales7:0,coverageDays:0,reviewDays:10,startedOn:'',note:''},...old,lowStock:{source:q===null?'':'fba',threshold:q}},at);
  if(old)Object.assign(old,rule);else watch.rules.push(rule);summary.push('FBA残数アラーム：'+(q===null?'解除':q+'個以下'));
 }
 if(w.incoming!==undefined){
  if(!p.asin||!Array.isArray(w.incoming)||w.incoming.length>50)throw fail('ASINとFBA納品予定を確認してください');
  const seen=new Set();for(const [index,x]of w.incoming.entries()){
   if(!x||x.id&&seen.has(x.id))throw fail('同じ納品予定を二重に変更できません');if(x.id)seen.add(x.id);
   const row=productOverview({monitor:m,physical:docs['physical-stock'].state,planning:docs['sales-planning'].state,watch:docs['product-watch']?.state||emptyProductWatch(),drafts:[]},at).find(r=>r.sourceKeys.includes('stock:'+p.id));
   const op={operationId:childId(command.operationId,':incoming:'+index),kind:x.complete?'incoming-close':'incoming',incomingId:x.id,...(x.complete?{}:{incoming:{sellerSku:x.sellerSku??p.sellerSku??'',quantity:x.quantity,stage:x.stage,expectedOn:x.expectedOn,reference:x.reference}})};
   saveIncoming(m,row,op,{actor,at});summary.push(x.complete?'FBA納品予定：到着確認済み':`FBA納品予定：${x.quantity}個・${x.stage==='packing'?'梱包中':'発送中'}・${x.expectedOn||'日付未設定'}`);
  }
 }
 receipt.workspaceUpdated=true;
}
