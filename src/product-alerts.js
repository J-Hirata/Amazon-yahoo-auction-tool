import {alertFba} from './fba-counter.js';
import {randomUUID} from "node:crypto";
import {planningToday} from "./sales-planning.js";
import {stockRisk,quantityEvidence} from "./stock-risk.js";
import {yahooEndMessage} from "./product-alert-mail.js";

export function collectProductAlerts(state,rows,settings,at){
  const signals=state.signals ||= {},pending=state.pendingAlerts ||= [],observed=new Set(),decisions=new Map();
  function observe(key,value,category,row,message,mailFormat){
    observed.add(key);decisions.set(key,value);
    if(!settings[category])return;
    if(value===null){if(signals[key])signals[key].known=false;return;}
    if(signals[key])signals[key].known=true;
    if(value&&/^(action-|review-)/.test(key)&&pending.some(p=>p.key===key&&p.queuedAt))return;
    const previous=signals[key];
    if(value&&!previous?.active){const id=randomUUID();pending.push({id,key,category,at,title:row.title||"取得状況",asin:row.asin||"",message,...(mailFormat?{mailFormat}:{}),eventKey:`product:${key}:${id}`});signals[key]={active:true,known:true,at};}
    else if(!value){signals[key]={active:false,known:true,at};for(const p of pending)if(p.key===key&&!p.queuedAt)p.dismissedAt=at;}
  }
  const fbaKeys=new Set(),yahooKeys=new Set(),planKeys=new Set(),riskKeys=new Set();
  for(const original of rows){
    const row={...original,fba:alertFba(original)};
    if(!row.sources.every(s=>s==="draft")){
      const risk=stockRisk(row,at),riskKey=`low-stock:${row.rule.key||row.key}:${risk.signature}`;
      if(risk.configured&&!riskKeys.has(riskKey)){
        riskKeys.add(riskKey);const previous=signals[riskKey];
        if(risk.low!==null&&risk.sku&&previous?.quantitySku&&previous.quantitySku!==risk.sku){previous.active=false;for(const p of pending)if(p.key===riskKey)p.dismissedAt ||= at;}
        observe(riskKey,risk.low,"stockAlerts",row,`残数警告：${risk.threshold}${risk.unit}以下になりました。${quantityEvidence(risk)}。商品ページと在庫台帳を確認してください。`);
        if(risk.low!==null&&risk.sku&&signals[riskKey])signals[riskKey].quantitySku=risk.sku;
      }
      const fbaKey=row.fba.sellerSku?`${row.asin}:${row.fba.sellerSku}`:row.key;
      if(!fbaKeys.has(fbaKey)){
        fbaKeys.add(fbaKey);
        const local=row.localAvailable===null?"手元在庫：未確認":`手元の使用可能在庫：${row.localAvailable}個`;
        observe(`fba-zero:${fbaKey}`,risk.configured&&risk.source==="fba"?false:row.fba.status==="complete"?row.fba.quantity===0:null,"stockAlerts",row,`FBAの${row.fba.source==='estimate'?'推定残数':'販売可能数'}が0個です。${local}。自己発送の在庫とは別です。併売の継続・補充を確認してください。`);
      }
      observe(`replenish:${row.key}`,row.rule.replenishEnabled&&row.fba.status==="complete"&&row.localAvailable!==null&&(row.rule.minimumSales7===0||row.sales.fbaQuantity7!==null)?row.replenishment:row.rule.replenishEnabled?null:false,"stockAlerts",row,
        `追加納品を検討してください。FBA${row.fba.source==='estimate'?'推定残数':'販売可能'}${row.fba.quantity}個、手元使用可能${row.localAvailable}個。${row.replenishmentInfo?.byRatio?`基準${row.replenishmentInfo.baseline}個の${row.replenishmentInfo.percent}%以下です。`:''}${(row.locations||[]).map(l=>`${l.locationId==='container'?'コンテナ':'会社・自宅'}：${l.usable===null?'未確認':l.usable+'個'}`).join(' ／ ')}。FBAの直近7日販売${row.sales.fbaQuantity7??"未確認"}個、残り${row.daysRemaining??"未確認"}日分。納品中：${(row.transfers||[]).filter(t=>t.to==="fba").reduce((n,t)=>n+t.remaining,0)}個（台帳記録）。納品予定：${(row.incoming||[]).filter(p=>p.remaining>0).map(p=>p.remaining+'個'+(p.expectedOn?'・'+p.expectedOn+'到着予定':'')).join(' ／ ')||'登録なし'}。納品手配前に実数と受領状況を確認してください。`);
    }
    for(const y of row.yahoo||[])if(!yahooKeys.has(y.listingId)){
      yahooKeys.add(y.listingId);const age=Date.parse(at)-Date.parse(y.checkedAt),fresh=Number.isFinite(age)&&age>=-60000&&age<=26*3600000;
      observe(`yahoo-ended:${y.listingId}${row.rule.relistStockSource?":"+row.rule.relistStockSource:""}`,fresh&&y.verified?y.status==="ended":null,"yahooAlerts",row,yahooEndMessage(row,y,at),'yahoo-ended-v1');
    }
    for(const p of row.plans)if(!planKeys.has(p.id)){
      planKeys.add(p.id);
      const url=`https://amazon-yahoo-inventory.vercel.app/?view=planning#id=${p.id}`;
      for(const a of p.actionSchedules||[]){
        const message=`${a.label} ／ 開始日：${a.startsOn||"未設定"} ／ 締切日：${a.endsOn||"未設定"}。${a.conditionLabel}。${a.note}\n結果を記録して次の方針を確認してください。\n${url}`;
        if(a.startsOn)observe(`action-start:${p.id}:${a.id}:${a.startsOn}`,Boolean(a.startDue&&!a.endDue),"reviewAlerts",row,`アクションの開始時期です。${message}`);
        if(a.endsOn)observe(`action-end:${p.id}:${a.id}:${a.endsOn}`,Boolean(a.endDue),"reviewAlerts",row,`アクションの締切です。${message}`);
      }
      if(!(p.actionSchedules||[]).some(a=>a.startsOn||a.endsOn)&&p.schedule.dueOn)observe(`review-plan:${p.id}:${p.schedule.dueOn}`,p.schedule.stage==="due","reviewAlerts",row,`販売の見直し時期です。確認日：${p.schedule.dueOn}。期間内の売れ行き、価格、広告、併売、追加納品を検討してください。\n${url}`);
    }
    if(row.watchDue&&!row.plans.some(p=>p.schedule.dueOn===row.watchDue))observe(`review-watch:${row.rule.key}:${row.watchDue}`,row.watchDue<=planningToday(at),"reviewAlerts",row,`監視商品の見直し時期です。確認日：${row.watchDue}。タグ：${row.tags.join("・")}。${row.rule.note}`);
  }
  for(const p of pending)if(/^(action-|review-|low-stock:|yahoo-ended:|fba-zero:|replenish:)/.test(p.key||"")&&!observed.has(p.key)&&!p.queuedAt)p.dismissedAt=at;
  for(const key of Object.keys(signals))if((key.startsWith('low-stock:')||key.startsWith('yahoo-ended:'))&&!observed.has(key))signals[key]={active:false,known:true,at};
  if(pending.length>5000)throw new Error("通知履歴の保存上限を確認してください");
  return pending.filter(p=>!p.queuedAt&&!p.dismissedAt&&(!observed.has(p.key)||decisions.get(p.key)===true));
}
