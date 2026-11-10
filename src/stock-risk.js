import {alertFba} from './fba-counter.js';
// Explicitly selected quantities only. Projections and offered stock are not physical stock.
export const RISK_SOURCES={fba:'FBA販売可能数',merchant:'Amazon自社発送の出品数量',home:'現物台帳：自社・自宅',container:'現物台帳：コンテナ'};
const count=n=>Number.isSafeInteger(n)&&n>=0;
const validTime=t=>Number.isFinite(Date.parse(t));
const fresh=(t,at)=>validTime(t)&&Date.parse(at)-Date.parse(t)>=-60000&&Date.parse(at)-Date.parse(t)<=26*3600000;
export function riskSettings(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'source')||!Object.hasOwn(value,'threshold')||value.source!==''&&!Object.hasOwn(RISK_SOURCES,value.source)||value.threshold!==null&&(!count(value.threshold)||value.threshold>1000000))throw Object.assign(new Error('残数警告の対象数量と通知残数を確認してください'),{status:400});
  return {source:value.source,threshold:value.threshold};
}
export function riskQuantity(row,source,at){
  const result={source,label:RISK_SOURCES[source]||'対象数量未設定',quantity:null,unit:'個',sku:'',checkedAt:null,status:'unknown',basis:''};
  if(source==='fba'){
    const f=alertFba(row)||{};Object.assign(result,{sku:f.sellerSku||f.sellerSkus?.join(' / ')||row.sellerSku||'',checkedAt:f.checkedAt||null,basis:f.source==='estimate'?`販売連動の推定残数：手入力${f.counter.baseline} − 基準後の確定販売${f.counter.sales}。他販路・納品・取消復帰は未反映`:'Amazon取得値。販売分を再度引きません'});
    if(f.status==='complete'&&result.sku&&count(f.quantity)&&fresh(f.checkedAt,at))Object.assign(result,{status:'known',quantity:f.quantity});
  }else if(source==='merchant'){
    const c=row.channels?.merchant||{};Object.assign(result,{sku:c.skus?.length===1?c.skus[0]:'',checkedAt:c.checkedAt||null,basis:'Amazon上の出品数量です。現物残数ではありません'});
    if(['active','inactive'].includes(c.state)&&result.sku&&count(c.quantity)&&fresh(c.checkedAt,at))Object.assign(result,{status:'known',quantity:c.quantity});
  }else if(['home','container'].includes(source)){
    const b=row.locations?.find(l=>l.locationId===source);Object.assign(result,{checkedAt:b?.checkedAt||null,unit:row.unit||'個',sku:row.sellerSku||'',basis:'台帳の使用可能数です。他販路の販売は自動減算しません'});
    if(row.stockIds?.length&&count(b?.usable)&&validTime(b.checkedAt)&&Date.parse(b.checkedAt)<=Date.parse(at)+60000)Object.assign(result,{status:'recorded',quantity:b.usable});
  }
  return result;
}
export function stockRisk(row,at){
  if(row.sharedLowStock?.conflict)return {source:'fba',label:'通知残数の設定が不一致',quantity:null,unit:'個',sku:'',checkedAt:null,status:'conflict',basis:'商品編集で共通の数を選んでください',configured:true,conflict:true,threshold:null,low:null,signature:JSON.stringify(['conflict',row.key])};
  const setting=row.rule.lowStock||{source:'',threshold:null},configured=Boolean(setting.source&&setting.threshold!==null),quantity=riskQuantity(row,setting.source,at);
  return {...quantity,configured,threshold:setting.threshold,low:configured&&quantity.quantity!==null?quantity.quantity<=setting.threshold:null,signature:JSON.stringify([row.asin,row.condition||'',row.stockIds||[],setting.source,setting.threshold])};
}
export function quantityEvidence(q){
  const at=q.checkedAt&&validTime(q.checkedAt)?new Date(q.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'日時なし';
  return `${q.label}：${q.quantity===null?'数量を確認できません':q.quantity+q.unit} ／ SKU：${q.sku||(['home','container'].includes(q.source)?'台帳単位・SKU未指定':'SKU未確定')} ／ 確認：${at}。${q.basis}`;
}
export function relistingAssessment(row,ended,at){
  // The ended notice uses current FBA stock by default, including sold endings.
  // A selected alternative remains authoritative; never infer a physical stock pool.
  const source=row.rule?.relistStockSource||'fba',q=riskQuantity(row,source,at);
  if(!ended.verified||ended.status!=='ended'||!fresh(ended.checkedAt,at))return {candidate:false,message:'出品状態を再取得してください。終了を確認できていません。'};
  if(row.referenceIssue||row.linkConflicts?.length)return {candidate:false,message:'商品紐付けの不一致があるため再出品候補は判定保留です。対象の商品・SKU・台帳を確認してください。'};
  const others=(row.yahoo||[]).filter(y=>y.listingId!==ended.listingId);
  const active=others.filter(y=>y.verified&&y.status==='active'&&fresh(y.checkedAt,at));
  if(active.length)return {candidate:false,message:`関連出品 ${active.map(y=>y.listingId).join('、')} が出品中です。重複再出品は不要です。`};
  if(others.some(y=>!y.verified||!['active','ended'].includes(y.status)||!fresh(y.checkedAt,at)))return {candidate:false,message:'ほかの関連出品を再取得してください。重複再出品を避けるため、先に出品状態を確認してください。'};
  if(q.quantity===null)return {candidate:false,message:source==='fba'?'FBA在庫を再取得してください。再出品に使える残数が分かりません。':`${q.label}の数量・確認日を登録してください。再出品に使える残数が分かりません。`};
  if(q.quantity===0)return {candidate:false,message:`${q.label}は0${q.unit}です。補充または別の在庫・販路へ切り替えてください。`};
  const required=Number.isSafeInteger(ended.unitsPerListing)&&ended.unitsPerListing>0?ended.unitsPerListing:1;
  if(q.quantity<required)return {candidate:false,message:`${q.label}は${q.quantity}${q.unit}です。1出品に必要な${required}${q.unit}へ補充してから再出品してください。`};
  return {candidate:true,message:source==='fba'?`Amazon FBAに在庫${q.quantity}個あります。ヤフオクへ再出品してください。`:`${q.label}に${q.quantity}${q.unit}の記録があります。${source==='merchant'?'現物の残数':'台帳と実数'}を照合して、ヤフオクへ再出品してください。`};
}
