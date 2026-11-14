import {manualFbaCounter} from './fba-counter.js';
// Shared counter used by screen, alerts and mail. Never write calculated quantities back to inventory.
const validTime=v=>Number.isFinite(Date.parse(v));
const number=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const stamp=v=>validTime(v)?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'日時不明';
const day=v=>validTime(v)?new Date(Date.parse(v)+9*3600000).toISOString().slice(0,10):'日付不明';
const shipping=v=>v==='AMAZON'?'FBA':v==='MERCHANT'?'自社発送':'発送方法未確認';
const uniqueEvents=events=>[...new Map(events.map(e=>[e.id,e])).values()];
function relatedRows(group,state,rows){
 const targets=(state.salesTracking?.trackers||[]).filter(t=>t.asin===group.asin&&t.sellerSku===group.sellerSku);
 const keys=new Set(targets.flatMap(t=>[t.sourceId,t.linkId&&`link:${t.linkId}`]).filter(Boolean));
 return rows.filter(r=>r.asin===group.asin&&!r.referenceIssue&&(r.sourceKeys||[]).some(k=>keys.has(k)));
}
function latest(entries){
 const sorted=entries.filter(e=>number(e.quantity)!==null&&validTime(e.checkedAt)).sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt));
 if(!sorted.length)return null;
 const top=sorted[0];return sorted.some(e=>Date.parse(e.checkedAt)===Date.parse(top.checkedAt)&&e.quantity!==top.quantity)?null:top;
}
function quantities(group,state,rows,at){
 const related=relatedRows(group,state,rows),lines=[],result={api:null,estimate:null,home:{quantity:null,status:'unlinked'},container:{quantity:null,status:'unlinked'}};
 const api=latest(related.flatMap(r=>{
  const f=r.fba||{},matches=f.sellerSku===group.sellerSku?[f]:f.variants?.filter(v=>v.sellerSku===group.sellerSku)||[];
  return ['complete','ambiguous'].includes(f.status)?matches.map(v=>({quantity:v.quantity,checkedAt:f.checkedAt})):[];
 }));
 result.api=api;
 lines.push(api?`FBA販売可能（このSKU）：${api.quantity}個（Amazon取得 ${stamp(api.checkedAt)}）`:'FBA販売可能（このSKU）：取得値なし');
 const manual=latest(related.flatMap(r=>{
  const review=r.availability?.review;
  if(!review||review.sellerSku&&review.sellerSku!==group.sellerSku)return [];
  const scopes=(state.salesTracking?.trackers||[]).filter(t=>t.asin===group.asin&&(r.sourceKeys||[]).includes(t.sourceId));
  return [{quantity:review.manualFbaQuantity,checkedAt:review.checkedAt,scopes,sku:review.sellerSku||'',row:r}];
 }));
 // API observations are already net of reservations/sales. A manual baseline is a separate projection.
 if(manual){
  const counter=manualFbaCounter(manual.row,manual.row.availability.review,state,at),covered=counter&&['estimated','stale','negative'].includes(counter.status),sales=counter?.sales||0;
  const scope=manual.sku?'このSKU':'商品全体・SKU未指定';
  result.estimate={quantity:covered?manual.quantity-sales:null,status:counter?.status||'unknown',scope,checkedAt:manual.checkedAt};
  lines.push(covered?`FBA推定残数（${scope}）：${manual.quantity-sales}個${manual.quantity-sales<0?'（基準数を要確認）':''} ／ 手入力${manual.quantity}個 − 基準後のAmazon確定販売${sales}個`:`FBA推定残数（${scope}）：計算保留（販売追跡期間・対象SKUを確認）`);
  lines[lines.length-1]+=`（手入力基準：${stamp(manual.checkedAt)}）`;
 }
 const stocks=new Map();for(const r of related)for(const id of r.stockIds||[])if(!stocks.has(id))stocks.set(id,r);
 for(const [id,label] of [['home','自社・自宅'],['container','コンテナ']]){
  const entries=[...stocks.values()].map(r=>({location:r.locations?.find(l=>l.locationId===id),unit:r.unit||'個'}));
  const units=new Set(entries.map(e=>e.unit));
  if(!entries.length){lines.push(`${label}：在庫台帳の関連付けなし`);continue;}
  if(units.size!==1||entries.some(e=>number(e.location?.usable)===null)){result[id]={quantity:null,status:units.size!==1?'unit_conflict':'unconfirmed'};lines.push(`${label}：${units.size!==1?'単位が異なるため合算保留':'数量未入力'}`);continue;}
  result[id]={quantity:entries.reduce((n,e)=>n+e.location.usable,0),unit:entries[0].unit,status:'confirmed'};
  lines.push(`${label}：${entries.reduce((n,e)=>n+e.location.usable,0)}${entries[0].unit}（台帳の使用可能数）`);
  const dates=[...new Set(entries.map(e=>stamp(e.location.checkedAt)))];lines[lines.length-1]+=`（確認：${dates.join(' / ')}）`;
 }
 return {...result,lines};
}
export function salesMailSummary({state,events,inventory={rows:[]},at=new Date().toISOString()}){
 const groups=new Map(),tracking=state.salesTracking||{};
 for(const e of uniqueEvents(events)){
  const order=(tracking.orders||[]).find(o=>o.orderId===e.orderId&&o.itemId===e.itemId);
  const date=day(e.delta>0?order?.createdAt||e.eligibleFromAt:e.updatedAt||e.at);
  const key=JSON.stringify([e.asin,e.sellerSku,e.fulfillment]);
  let g=groups.get(key);if(!g){g={asin:e.asin,sellerSku:e.sellerSku,fulfillment:e.fulfillment,dates:new Map(),positive:0,negative:0};groups.set(key,g);}
  const d=g.dates.get(date)||{positive:0,negative:0};if(e.delta>0){g.positive+=e.delta;d.positive+=e.delta;}else{g.negative-=e.delta;d.negative-=e.delta;}g.dates.set(date,d);
 }
 const products=[],sections=[...groups.values()].map(g=>{
  const title=(tracking.trackers||[]).find(t=>t.asin===g.asin&&t.sellerSku===g.sellerSku)?.title||g.asin;
  const dates=[...g.dates].sort(([a],[b])=>a.localeCompare(b)).map(([date,d])=>`${date}：${d.positive?`注文日の確定販売 ${d.positive}個`:''}${d.positive&&d.negative?' ／ ':''}${d.negative?`取消・訂正 ${d.negative}個（更新日）`:''}`).join(' ／ ');
  const summary=`${shipping(g.fulfillment)} ／ 注文確定 ${g.positive}個${g.negative?` ／ 取消・訂正 ${g.negative}個 ／ 差引 ${g.positive-g.negative}個`:''}`;
  const stock=inventory.readFailed?{api:null,estimate:null,home:{quantity:null,status:'read_failed'},container:{quantity:null,status:'read_failed'},lines:['FBA販売可能（このSKU）：取得値なし','自社・自宅：在庫情報の読取に失敗（台帳を確認）','コンテナ：在庫情報の読取に失敗（台帳を確認）']}:quantities(g,state,inventory.rows||[],at);
  const quantitiesText=stock.lines.join(' ／ ');
  products.push({asin:g.asin,sellerSku:g.sellerSku,fulfillment:g.fulfillment,title,positive:g.positive,negative:g.negative,stock,orderDates:[...g.dates.keys()].sort()});
  const lines=[`${title} — ${summary}`,dates,quantitiesText,`SKU: ${g.sellerSku} ／ https://www.amazon.co.jp/dp/${g.asin}`];
  return lines.join('\n');
 });
 return {products,targets:[...groups.values()].map(({asin,sellerSku})=>({asin,sellerSku})),text:['Amazon販売集計（今回確認分・注文日は日本時間）。',...sections,`注文確認済み：${stamp(tracking.checkedThrough)}`,'FBA取得値は二重減算しません。推定と台帳は参考値：取消による在庫復帰・納品・他販路の販売は自動反映しません。','数量の確認・修正：https://amazon-yahoo-inventory.vercel.app/?view=stock','全商品一覧：https://amazon-yahoo-inventory.vercel.app/?view=overview'].join('\n\n')};
}
