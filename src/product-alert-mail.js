import {riskQuantity,relistingAssessment} from './stock-risk.js';

const origin='https://amazon-yahoo-inventory.vercel.app/';
const count=v=>Number.isSafeInteger(v)&&v>=0;
const stamp=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'日時未記録';

// Mail-only snapshot. No inventory/auction/mail state is changed by formatting.
export function yahooEndMessage(row,ended,at){
  const quantity=riskQuantity(row,'fba',at),manual=row.availability?.fba;
  let fba=quantity.quantity!==null?`Amazon FBA：在庫${quantity.quantity}個（取得 ${stamp(quantity.checkedAt)}／SKU：${quantity.sku}）`:'Amazon FBA：取得値なし（在庫を再取得）';
  if(quantity.quantity===null&&manual?.source==='manual'&&count(manual.quantity))fba+=`／手入力${manual.quantity}個（確認 ${stamp(manual.checkedAt)}）`;
  const stocks=row.stockIds?.length?(row.locations||[]).filter(l=>['container','home'].includes(l.locationId)):[];
  const physical=stocks.length?['container','home'].map(id=>{
    const location=stocks.find(l=>l.locationId===id),label=id==='container'?'コンテナ':'自社・自宅';
    return location&&count(location.usable)?`${label} ${location.usable}${row.unit||'個'}（台帳 ${stamp(location.checkedAt)}）`:`${label} 数量未入力`;
  }).join('／'):'記載なし';
  const plans=row.plans||[],dates=plans.flatMap(p=>[...(p.actionSchedules||[]).map(a=>a.nextOn),p.schedule?.dueOn]).filter(Boolean).sort();
  const planning=plans.length?`登録${plans.length}件${dates[0]?`／次回 ${dates[0]}`:'／日付未設定'}`:'記載なし';
  const result=ended.reason==='sold'?'（落札あり）':ended.reason==='unsold'?'（落札なし）':'';
  const planningUrl=origin+'?view=planning'+(plans.length===1&&plans[0].id?'#id='+encodeURIComponent(plans[0].id):'');
  return [
    `ヤフオク出品 ${ended.listingId} が終了しました${result}。`,
    relistingAssessment(row,ended,at).message,
    `ヤフオク：https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(ended.listingId)}`,
    `全商品一覧：${origin}?view=overview`,
    '',fba,
    ...(row.asin?[`Amazon商品：https://www.amazon.co.jp/dp/${encodeURIComponent(row.asin)}`]:[]),
    '',`コンテナ・自社在庫：${physical}`,origin+'?view=stock',
    '',`販売の監視・見直し：${planning}`,planningUrl,
  ].join('\n');
}

export function productAlertsMail(alerts,{mode='daily',at}={}){
  const compact=alerts.some(a=>a.mailFormat==='yahoo-ended-v1');
  const blocks=alerts.map(a=>`${a.title}${a.asin?` ／ ${a.asin}`:''}\n確認：${stamp(a.at||at)}\n${a.message}`);
  return [
    ...(!compact?[mode==='risk'?'リスク確認で対応が必要な項目を検知しました。':'日次確認で対応が必要な項目があります。']:[]),
    ...blocks,
    ...(!compact?[`全商品一覧：${origin}?view=overview`,'数量・出品・広告は自動変更していません。']:[]),
  ].join('\n\n');
}
