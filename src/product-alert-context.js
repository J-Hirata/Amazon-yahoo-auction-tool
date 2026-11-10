import {collectProductAlerts} from './product-alerts.js';
import {productOverview} from './product-overview.js';

// Re-evaluate saved observations immediately before delivery, without consuming
// transitions or changing the durable watch. Accepted mail remains immutable.
export function productAlertContext(input,at){
 const watch=structuredClone(input.watch),settings=input.monitor.salesAutomation||{},assessments=new Map();
 collectProductAlerts(watch,productOverview({...input,watch},at),settings,at,{onObserve:a=>assessments.set(a.key,a)});
 const states={},alerts=[];
 for(const p of input.watch.pendingAlerts||[]){
  const a=assessments.get(p.key),signal=p.key?watch.signals[p.key]:p.eventKey?.startsWith('product:fetch-error:')?watch.signals.fetchError:null;
  const current=a?a.value:/^(low-stock:|fba-zero:|replenish:|yahoo-ended:|action-|review-)/.test(p.key||'')?false:signal?.known===false?null:typeof signal?.active==='boolean'?signal.active:null;
  const superseded=signal?.alertId&&signal.alertId!==p.id;
  states[p.id]=p.dismissedAt||watch.pendingAlerts.find(a=>a.id===p.id)?.dismissedAt||superseded||!settings[p.category]?false:current;
  alerts.push(a?{...p,title:a.row.title||p.title,asin:a.row.asin||p.asin,message:a.message,at,...(a.mailFormat?{mailFormat:a.mailFormat}:{})}:{...p});
 }
 return {states,alerts};
}
