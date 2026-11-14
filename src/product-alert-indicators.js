import {collectProductAlerts} from './product-alerts.js';
// Shared alert predicates, projected without consuming a notification transition.
export function withAlertIndicators(rows,watch,settings,at){
 const indicators=new Map(rows.map(row=>[row.key,{items:[],unknown:[]}]));
 collectProductAlerts(structuredClone(watch),rows,settings,at,{observeOnly:true,onObserve:a=>{
  if(!settings[a.category])return;
  const target=indicators.get(a.row.key);if(!target)return;
  const kind=a.mailDetails?.kind||({stockAlerts:'stock',reviewAlerts:'review',yahooAlerts:'yahoo'})[a.category];
  const field=kind==='review'?'review':kind==='yahoo'||kind==='relist'?'yahoo':a.mailDetails?.quantity?.source||'fba';
  const signal=watch.signals?.[a.key],id=signal?.active?signal.alertId||null:null;
  const value={key:a.key,id,kind,field,lines:a.mailDetails?.lines||[a.message],quantity:a.mailDetails?.quantity||null,period:a.mailDetails?.period||null};
  if(a.value===true)target.items.push(value);else if(a.value===null)target.unknown.push(value);
 }});
 return rows.map(row=>({...row,alerts:indicators.get(row.key).items,alertUnknown:indicators.get(row.key).unknown,alertNotificationsEnabled:Boolean(settings.enabled)}));
}
