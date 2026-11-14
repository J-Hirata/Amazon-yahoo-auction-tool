import {riskQuantity,relistingAssessment} from './stock-risk.js';
import {addNoticeDays,noticeDay,recurringNotice} from './product-notice-policy.js';

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

export function alertMailDetails(row,kind,at,extra={}){
  const rowKey=row.rule?.key||row.sourceKeys?.find(k=>/^(stock|link|plan|watch):/.test(k))||row.key;
  const result={kind,rowKey};
  if(kind==='yahoo'){
    const assessment=relistingAssessment(row,extra.ended,at),q=riskQuantity(row,row.rule?.relistStockSource||'fba',at);
    const outcome=extra.ended.reason==='sold'?'（落札あり）':extra.ended.reason==='unsold'?'（落札なし）':'';
    return {...result,kind:assessment.candidate?'relist':'yahoo',quantity:q,lines:[`出品終了${outcome} ／ ${assessment.message}`],listingId:extra.ended.listingId};
  }
  if(kind==='stock'){
    const q=extra.risk||riskQuantity(row,'fba',at),label=q.source==='fba'&&q.basis?.startsWith('販売連動')?'FBA推定残数':q.label;
    return {...result,quantity:q,threshold:extra.risk?.threshold??null,lines:[`${label} ${q.quantity===null?'未確認':q.quantity+q.unit}${extra.risk?` ／ 警告設定 ${extra.risk.threshold}${q.unit}以下`:''}`]};
  }
  if(kind==='zero'){
    const q=riskQuantity(row,'fba',at),label=row.fba.source==='estimate'?'FBA推定残数':q.quantity===null?'FBA取得分':'FBA販売可能数';
    return {...result,kind:'stock',quantity:q,lines:[`${label} ${row.fba.quantity}個${!q.sku?'（SKU未確定）':''} ／ 補充・併売の継続を確認してください。`]};
  }
  if(kind==='replenish')return {...result,kind:'stock',lines:[`補充を検討：FBA${row.fba.source==='estimate'?'推定残数':'販売可能数'} ${row.fba.quantity}個 ／ 手元使用可能数 ${row.localAvailable??'未確認'}個`,...(row.replenishmentInfo?.byRatio?[`基準${row.replenishmentInfo.baseline}個の${row.replenishmentInfo.percent}%以下`]:[]),...(row.locations?.length?[(row.locations||[]).map(l=>`${l.locationId==='container'?'コンテナ':'会社・自宅'}：${l.usable===null?'未確認':l.usable+'個'}`).join(' ／ ')]:[]),...(row.incoming?.some(p=>p.remaining>0)?['納品予定 '+row.incoming.filter(p=>p.remaining>0).map(p=>p.remaining+'個'+(p.expectedOn?'・'+p.expectedOn:'')).join('／')]:[])]};
  return {...result,...extra};
}
const groups=[['yahoo','ヤフオク終了'],['stock','残数警告'],['review','販売の監視'],['other','その他の確認']];
const categoryColors={stock:['#9d2525','#ffe5e5','#e5b2b2'],review:['#74520b','#fff5cd','#dfc366'],yahoo:['#644399','#f0e9ff','#c8b0e6'],other:['#334155','#eef2f6','#cbd5e1']};
const clean=value=>String(value??'').replace(/[\r\n]+/g,' ').trim();
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function productAlertGroup(alert){
  if(alert.mailDetails?.kind==='relist')return 'yahoo';
  if(groups.some(([key])=>key===alert.mailDetails?.kind))return alert.mailDetails.kind;
  if(alert.category==='stockAlerts')return 'stock';
  if(alert.category==='reviewAlerts')return 'review';
  if(alert.category==='yahooAlerts')return 'yahoo';
  return 'other';
}
const alertLink=alert=>origin+'?view=overview'+(alert.id&&recurringNotice(alert)?'#notice='+encodeURIComponent(alert.id):'');
const actionLabel=alert=>alert.id&&recurringNotice(alert)?'確認・再案内の解除':'管理画面を開く';
const nextDay=(at,alert)=>noticeDay(at||alert.at)?addNoticeDays(noticeDay(at||alert.at)):'確認待ち';
function alertLines(alert){return alert.mailDetails?.lines?.length?alert.mailDetails.lines.map(clean).filter(Boolean):String(alert.message||'').split('\n').filter(Boolean);}
function parts(alerts){return {fresh:alerts.filter(a=>!a.isReminder),repeat:alerts.filter(a=>a.isReminder)};}
export function productAlertsSubject(alerts,{mode='daily'}={}){
  const {fresh,repeat}=parts(alerts);
  return `【販売コックピット】${mode==='risk'?'在庫・出品の警告：':''}${[fresh.length?`新しい案内 ${fresh.length}件`:'',repeat.length?`再案内 ${repeat.length}件`:''].filter(Boolean).join('・')||'確認のお知らせ'}`;
}
export function productAlertsMail(alerts,{at,embedded=false}={}){
  const {fresh,repeat}=parts(alerts),lines=embedded?[]:['販売コックピット',groups.map(([key,label])=>{const n=alerts.filter(a=>productAlertGroup(a)===key).length;return n?`${label} ${n}件`:'';}).filter(Boolean).join(' ／ '),`確認：${stamp(at||alerts[0]?.at)}`,''];
  for(const [items,heading]of [[fresh,'新しい案内'],[repeat,'再案内（3日ごと）']]){
    if(!items.length)continue;lines.push(`【${heading}】`);
    for(const [kind,label]of groups){const selected=items.filter(a=>productAlertGroup(a)===kind);if(!selected.length)continue;
      lines.push(`■ ${label}（${selected.length}件）`);
      selected.forEach((a,i)=>{
        lines.push(`${i+1}. ${clean(a.title)}${a.asin?` ／ ${a.asin}`:''}`,...alertLines(a).map(line=>'   '+line));
        if(a.isReminder)lines.push(`   通知${a.notificationNumber}回目 ／ 前回 ${noticeDay(a.lastSentAt)||'確認待ち'} ／ 次回 ${nextDay(at,a)}の日次確認`);
        lines.push(`   ${actionLabel(a)}：${alertLink(a)}`,'');
      });
    }
  }
  if(!embedded)lines.push('再案内を止めるには、上のリンク先で「この件の再案内を止める」にチェックしてください。','残数の警告設定や見直し日も、同じ画面から変更できます。');
  return lines.join('\n');
}
export function productAlertsHtml(alerts,{at,embedded=false}={}){
  const {fresh,repeat}=parts(alerts),checked=stamp(at||alerts[0]?.at),textStyle='font-family:Arial,Meiryo,sans-serif;font-size:15px;line-height:1.65;color:#202b3c;';
  function section(items,heading){
    if(!items.length)return '';
    let html=`<h2 style="font-size:18px;margin:28px 0 12px;color:#244d86;">${esc(heading)} <span style="font-size:14px;font-weight:normal;">${items.length}件</span></h2>`;
    for(const [kind,label]of groups){const selected=items.filter(a=>productAlertGroup(a)===kind);if(!selected.length)continue;
      const [color,background,border]=categoryColors[kind];
      html+=`<h3 style="font-size:15px;margin:20px 0 4px;"><span style="display:inline-block;padding:1px 8px;border:1px solid ${border};border-radius:999px;color:${color};background:${background};">${esc(label)}</span>（${selected.length}件）</h3><table role="presentation" style="border-collapse:collapse;width:100%;">`;
      for(const a of selected){const meta=a.isReminder?`<div style="font-size:13px;color:#59687a;margin-top:4px;">通知${a.notificationNumber}回目・前回 ${esc(noticeDay(a.lastSentAt)||'確認待ち')}・次回 ${esc(nextDay(at,a))}</div>`:'';
        html+=`<tr><td style="padding:12px 0;border-bottom:1px solid #dce3eb;${textStyle}"><div style="font-weight:bold;">${esc(clean(a.title))}</div><div>${alertLines(a).map(esc).join('<br>')}</div>${meta}<div style="margin-top:6px;"><a href="${esc(alertLink(a))}" style="color:#2458a6;text-decoration:underline;">${esc(actionLabel(a))} ↗</a></div><div style="font-size:12px;color:#59687a;">${esc(a.asin||'')}</div></td></tr>`;
      }html+='</table>';
    }return html;
  }
  if(embedded)return section(fresh,'新しい案内')+section(repeat,'再案内（3日ごと）');
  return `<div style="${textStyle}max-width:660px;margin:0 auto;padding:16px;"><div style="font-size:21px;font-weight:bold;">販売コックピット</div><div style="font-size:13px;color:#59687a;">確認 ${esc(checked)}</div>${section(fresh,'新しい案内')}${section(repeat,'再案内（3日ごと）')}<p style="font-size:13px;color:#59687a;margin-top:22px;">各商品のリンクから「この件の再案内を止める」にチェックできます。残数の警告設定・見直し日も同じ画面から変更できます。</p></div>`;
}
