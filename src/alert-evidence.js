import {periodSales,periodSalesLine} from './period-sales.js';

export function endedListingUrl(details){return ['yahoo','relist'].includes(details?.kind)&&/^[A-Za-z0-9]{6,24}$/.test(details.listingId||'')?'https://auctions.yahoo.co.jp/jp/auction/'+encodeURIComponent(details.listingId):'';}

export function alertEvidence(row,details,monitor,at){
 if(!details)return details;
 const kind=details.kind,plans=(row.plans||[]).filter(p=>p.status!=='closed'),target=details.planId?plans.find(p=>p.id===details.planId):null;
 const notes=[],seen=new Set();
 function note(label,text){if(typeof text!=='string'||!text.trim()||seen.has(text.replace(/\r\n/g,'\n')))return;seen.add(text.replace(/\r\n/g,'\n'));notes.push({label,text});}
 note('確認したいこと・メモ',row.rule?.note);note('商品メモ',row.memo);
 for(const rule of row.rules||[])if(rule.key!==row.rule?.key&&(kind!=='review'||rule.key==='plan:'+details.planId))note('確認したいこと・メモ',rule.note);
 const relevant=target?[target]:kind==='review'?[]:plans;
 for(const p of relevant){const label=relevant.length>1?`（${p.title||'監視計画'}）`:'';note('販売の監視メモ'+label,p.note);note('販売状況メモ'+label,p.salesMemo);note('販売可能日のメモ'+label,p.availabilityNote);}
 if(details.actionId){const action=target?.actionSchedules?.find(a=>a.id===details.actionId);note('アクションメモ',action?.note);}
 const lines=(details.lines||[]).filter(line=>!notes.some(n=>n.text===line)),periods=[];
 if(kind==='review'&&details.period)periods.push({period:details.period,plan:target});
 else if(kind==='stock'){
  if(row.rule?.startedOn||row.watchDue)periods.push({period:{startsOn:row.rule?.startedOn||'',endsOn:row.watchDue||''}});
  else for(const p of plans){
   const actions=(p.actionSchedules||[]).filter(a=>a.startsOn||a.endsOn);
   if(actions.length)for(const a of actions)periods.push({period:{startsOn:a.startsOn||'',endsOn:a.endsOn||''},plan:p,label:a.label});
   else if(p.schedule?.dueOn||p.schedule?.startedOn||p.availableOn)periods.push({period:{startsOn:p.schedule?.startedOn||p.availableOn||'',endsOn:p.schedule?.dueOn||''},plan:p});
  }
  if(!periods.length)periods.push({period:{startsOn:'',endsOn:''}});
 }
 const unique=new Map();for(const p of periods){const key=JSON.stringify([p.period,p.plan?.sellerSku||row.sellerSku||'']);if(!unique.has(key))unique.set(key,p);}
 const results=[];
 for(const p of unique.values()){
  if(kind!=='review'||!lines.some(line=>line.includes('販売監視期間')))lines.push(`${p.label?p.label+' ／ ':''}販売監視期間 ${p.period.startsOn||'開始日未設定'} → ${p.period.endsOn||'終了日未設定'}`);
  const sales=periodSales(row,monitor,p.period,at,{sellerSku:p.plan?.sellerSku});results.push({...p.period,sales});lines.push(periodSalesLine(sales));
 }
 for(const n of notes)lines.push(`${n.label}：${n.text}`);
 return {...details,lines,notes,periodSales:results,listingUrl:endedListingUrl(details)};
}
