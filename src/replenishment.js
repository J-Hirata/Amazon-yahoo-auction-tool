import {alertFba} from './fba-counter.js';
const quantity=v=>Number.isSafeInteger(v)&&v>=0?v:null;
export function replenishmentView(row,watch){
  row={...row,fba:alertFba(row)};
  const rule=row.rule,configured=quantity(rule.baselineQuantity),stored=watch.replenishmentBaselines?.[rule.key];
  const matching=stored&&stored.asin===row.asin&&stored.sellerSku===row.fba.sellerSku&&stored.configuredQuantity===configured;
  const baseline=configured>0?Math.max(configured,matching?quantity(stored.quantity)||0:0):null;
  const percent=Number.isSafeInteger(rule.replenishPercent)?rule.replenishPercent:0;
  const byRatio=percent>0&&baseline>0&&row.fba.quantity!==null&&row.fba.quantity*100<=baseline*percent;
  const byCount=percent===0&&row.fba.quantity!==null&&row.fba.quantity<=rule.threshold;
  const byDays=rule.coverageDays>0&&row.daysRemaining!==null&&row.daysRemaining<=rule.coverageDays;
  const eligible=row.fbaEligibility!=='not_possible';
  const due=Boolean(rule.replenishEnabled&&eligible&&row.fba.status==='complete'&&row.localAvailable>0&&(rule.minimumSales7===0||row.sales.fbaQuantity7!==null&&row.sales.fbaQuantity7>=rule.minimumSales7)&&(byCount||byRatio||byDays));
  return {enabled:Boolean(rule.replenishEnabled),eligible,baseline,percent,ratioPercent:baseline>0&&row.fba.quantity!==null?Math.round(row.fba.quantity/baseline*100):null,byRatio,due,checkedAt:matching?stored.checkedAt:null};
}
export function recordReplenishmentBaselines(watch,rows,at){
  for(const row of rows){
    const configured=quantity(row.rule.baselineQuantity);
    if(!row.rule.replenishEnabled||!(row.rule.replenishPercent>0)||!(configured>0)||row.fba.status!=='complete'||!row.fba.sellerSku||!row.asin)continue;
    const key=row.rule.key,old=watch.replenishmentBaselines?.[key];
    const matching=old&&old.asin===row.asin&&old.sellerSku===row.fba.sellerSku&&old.configuredQuantity===configured;
    const next=Math.max(configured,matching?old.quantity:0,row.fba.quantity);
    if(!matching||next!==old.quantity){
      watch.replenishmentBaselines||={};
      watch.replenishmentBaselines[key]={asin:row.asin,sellerSku:row.fba.sellerSku,configuredQuantity:configured,quantity:next,checkedAt:at};
    }
  }
}
