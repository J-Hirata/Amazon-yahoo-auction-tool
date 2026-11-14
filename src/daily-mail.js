import {productAlertsMail,productAlertsHtml} from './product-alert-mail.js';
import {noticeDay} from './product-notice-policy.js';
export const ALERTS_URL='https://amazon-yahoo-inventory.vercel.app/?view=overview#alerts=active';
const overview='https://amazon-yahoo-inventory.vercel.app/?view=overview';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'日時未確認';
const physical=q=>Number.isSafeInteger(q?.quantity)?q.quantity+(q.unit||'個'):({unlinked:'在庫未登録',unconfirmed:'数量未入力',unit_conflict:'単位不一致',read_failed:'取得できず'})[q?.status]||'未確認';
function saleLines(p){
 const api=p.stock?.api,where=p.fulfillment==='MERCHANT'?'自社発送 ／ ':p.fulfillment==='AMAZON'?'':'発送方法未確認 ／ ';
 const summary=`${where}注文確定 ${p.positive}個${p.negative?` ／ 取消・訂正 ${p.negative}個 ／ 差引 ${p.positive-p.negative}個`:''}`;
 return [`${p.title} ― ${summary} ／ FBA在庫 ${Number.isSafeInteger(api?.quantity)?api.quantity+'個':'未確認'}`,
  `自社・自宅：${physical(p.stock?.home)} ／ コンテナ：${physical(p.stock?.container)}`,
  `SKU: ${p.sellerSku||'未確認'} ／ https://www.amazon.co.jp/dp/${p.asin}`];
}
export function dailyMail({at,sales=[],alerts=[],errors=[]}){
 const subject=`【販売コックピット】確認 ${noticeDay(at)||'日付未確認'} ／ 販売${sales.length}商品・アラート${alerts.length}件`;
 const text=[`確認 ${stamp(at)}`,sales.length?'【今回確認した販売】':'',...sales.map(p=>saleLines(p).join('\n')),
  alerts.length?`【アラート ${alerts.length}件】\n`+productAlertsMail(alerts,{at,embedded:true}):'',
  ...errors.map(e=>'【確認できない項目】\n'+e),
  `アラート商品一覧：${ALERTS_URL}`,`全商品一覧：${overview}`,
  sales.length?'FBAはAmazon取得値、自社・自宅とコンテナは保存台帳です。推定値や未入力を実数に置き換えていません。':''
 ].filter(Boolean).join('\n\n');
 const saleHtml=sales.length?'<h2 style="font-size:17px;margin:24px 0 12px;">今回確認した販売</h2>'+sales.map(p=>{
  const lines=saleLines(p),url=`https://www.amazon.co.jp/dp/${encodeURIComponent(p.asin)}`;
  return `<div style="margin:0 0 20px;"><div style="font-weight:bold;">${esc(lines[0])}</div><div>${esc(lines[1])}</div><div style="font-size:13px;">SKU: ${esc(p.sellerSku||'未確認')} ／ <a href="${url}">${esc(url)}</a></div></div>`;
 }).join(''):'';
 const html=`<div style="max-width:680px;margin:0 auto;padding:16px;font:15px/1.7 Arial,Meiryo,sans-serif;color:#243345;"><div style="font-weight:bold;font-size:20px;">販売コックピット</div><div>確認 ${esc(stamp(at))}</div>${saleHtml}${alerts.length?`<h2 style="font-size:17px;margin-top:26px;">アラート ${alerts.length}件</h2>`+productAlertsHtml(alerts,{at,embedded:true}):''}${errors.map(e=>`<p style="color:#a12828;">確認できない項目：${esc(e)}</p>`).join('')}<p><a href="${ALERTS_URL}">アラート商品一覧 ↗</a><br><a href="${overview}">全商品一覧 ↗</a></p>${sales.length?'<p style="font-size:12px;color:#59687a;">FBAはAmazon取得値、自社・自宅とコンテナは保存台帳です。注文確定は今回確認した分で、過去注文の遅れて確定した分を含む場合があります。</p>':''}</div>`;
 return {subject,text,html};
}
