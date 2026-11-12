import {collectProductAlerts} from './product-alerts.js';
import {productOverview} from './product-overview.js';
import {noticeSchedule} from './product-notice-policy.js';

// Re-evaluate saved observations immediately before delivery, without consuming
// transitions or changing the durable watch. Accepted mail remains immutable.
export function productAlertContext(input,at){
 const watch=structuredClone(input.watch),settings=input.monitor.salesAutomation||{},assessments=new Map();
 collectProductAlerts(watch,productOverview({...input,watch},at),settings,at,{onObserve:a=>assessments.set(a.key,a)});
 const states={},conditions={},alerts=[];
 for(const p of input.watch.pendingAlerts||[]){
  const a=assessments.get(p.key),signal=p.key?watch.signals[p.key]:p.eventKey?.startsWith('product:fetch-error:')?watch.signals.fetchError:null;
  const current=a?a.value:/^(low-stock:|fba-zero:|replenish:|yahoo-ended:|action-|review-)/.test(p.key||'')?false:signal?.known===false?null:typeof signal?.active==='boolean'?signal.active:null;
  const superseded=signal?.alertId&&signal.alertId!==p.id;
  conditions[p.id]=p.dismissedAt||watch.pendingAlerts.find(a=>a.id===p.id)?.dismissedAt||superseded||!settings[p.category]?false:current;
  const schedule=noticeSchedule(p,input.monitor,input.watch,at);
  states[p.id]=schedule.stopped?false:conditions[p.id];
  alerts.push({...p,...(a?{title:a.row.title||p.title,asin:a.row.asin||p.asin,message:a.message,at,...(a.mailFormat?{mailFormat:a.mailFormat}:{}),...(a.mailDetails?{mailDetails:a.mailDetails}:{})}:{}),...schedule});
 }
 return {states,conditions,alerts};
}
