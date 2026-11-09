const n=v=>Number.isSafeInteger(v)&&v>=0;
const fail=m=>Object.assign(new Error(m),{status:400});
export function incomingFor(row,monitor,at,watch={}){
 return (monitor.fbaIncoming||[]).filter(p=>row.sourceKeys.includes(p.key)&&p.asin===row.asin).map(p=>{
  const raw=row.fba||{},actual=raw.status==='complete'&&raw.sellerSku===p.sellerSku?raw.quantity:raw.status==='ambiguous'?raw.variants?.find(v=>v.sellerSku===p.sellerSku)?.quantity:null;
  const age=Date.parse(at)-Date.parse(raw.checkedAt),others=(monitor.fbaIncoming||[]).filter(v=>v.asin===p.asin&&v.sellerSku===p.sellerSku&&v.id!==p.id&&v.status!=='closed'&&!(watch.incomingReflections?.[v.id]?.quantity>=v.quantity));
  // Inventory growth is evidence of reflection, not a receipt confirmation for a shipment.
  const previous=watch.incomingReflections?.[p.id],remembered=previous?.sellerSku===p.sellerSku&&previous.baselineAt===p.baselineAt?previous.quantity:0;
  const detected=p.sellerSku&&p.stage==='transit'&&!others.length&&n(actual)&&n(p.baselineQuantity)&&Date.parse(raw.checkedAt)>Date.parse(p.baselineAt)&&age>=-60000&&age<=26*3600000?Math.min(p.quantity,Math.max(0,actual-p.baselineQuantity)):0;
  const reflected=Math.max(remembered,detected);
  return {...p,reflected:p.status==='closed'?p.quantity:reflected,remaining:p.status==='closed'?0:p.quantity-reflected,reflectionAt:reflected?raw.checkedAt:null,reflectionStatus:p.status==='closed'?'confirmed':reflected>=p.quantity?'inferred_complete':reflected?'inferred_partial':'pending'};
 });
}
export function saveIncoming(monitor,row,command,{at,actor}){
 const list=monitor.fbaIncoming||=[];
 if(command.kind==='incoming-close'){
  const p=list.find(p=>p.id===command.incomingId&&row.sourceKeys.includes(p.key));if(!p)throw fail('納品予定を選び直してください');
  p.status=command.reopen===true?'open':'closed';p.closedAt=command.reopen===true?null:at;p.confirmedBy=actor;return p.id;
 }
 if(list.length>=2000)throw fail('納品予定の保存上限です');
 const existing=command.incomingId?list.find(p=>p.id===command.incomingId&&row.sourceKeys.includes(p.key)&&p.status!=='closed'):null;
 if(command.incomingId&&!existing)throw fail('編集する納品予定を選び直してください');
 const x=command.incoming?{...command.incoming,sellerSku:command.incoming.sellerSku?.trim()||row.sellerSku||''}:null;
 if(!x||!n(x.quantity)||x.quantity<1||x.quantity>1000000||typeof x.sellerSku!=='string'||x.sellerSku.length>200||row.sellerSku&&row.sellerSku!==x.sellerSku||!['packing','transit'].includes(x.stage)||typeof x.expectedOn!=='string'||x.expectedOn&&!/^\d{4}-\d{2}-\d{2}$/.test(x.expectedOn)||typeof x.reference!=='string'||x.reference.length>200)throw fail('納品予定数・SKU・到着予定日を確認してください');
 if(x.expectedOn&&(!Number.isFinite(Date.parse(x.expectedOn))||new Date(x.expectedOn+'T00:00:00Z').toISOString().slice(0,10)!==x.expectedOn))throw fail('到着予定日を確認してください');
 const f=row.fba||{},quantity=f.status==='complete'&&f.sellerSku===x.sellerSku?f.quantity:f.status==='ambiguous'?f.variants?.find(v=>v.sellerSku===x.sellerSku)?.quantity:null;
 if(existing){if(existing.sellerSku!==x.sellerSku||existing.quantity!==x.quantity)throw fail('数量・SKUが変わる場合は以前の予定を完了し、新しい予定として登録してください');if(existing.stage!==x.stage){existing.baselineQuantity=n(quantity)?quantity:null;existing.baselineAt=f.checkedAt||null;}Object.assign(existing,{stage:x.stage,expectedOn:x.expectedOn,reference:x.reference.trim(),updatedAt:at});return existing.id;}
 list.push({id:command.operationId,key:row.key,asin:row.asin,sellerSku:x.sellerSku.trim(),quantity:x.quantity,stage:x.stage,expectedOn:x.expectedOn,reference:x.reference.trim(),baselineQuantity:n(quantity)?quantity:null,baselineAt:f.checkedAt||null,status:'open',createdAt:at,actor});return command.operationId;
}

export function recordIncomingReflections(watch,rows){for(const row of rows)for(const p of row.incoming||[])if(p.status!=='closed'&&p.reflected>0){watch.incomingReflections||={};const old=watch.incomingReflections[p.id];if(!old||p.reflected>old.quantity)watch.incomingReflections[p.id]={quantity:p.reflected,sellerSku:p.sellerSku,baselineAt:p.baselineAt,checkedAt:p.reflectionAt};}}
