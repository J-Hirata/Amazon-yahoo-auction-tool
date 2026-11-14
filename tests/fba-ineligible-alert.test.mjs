import test from 'node:test';import assert from 'node:assert/strict';
import {collectProductAlerts} from '../src/product-alerts.js';import {withAlertIndicators} from '../src/product-alert-indicators.js';import {emptyProductWatch} from '../src/product-overview.js';
const at='2026-11-15T00:00:00Z',settings={enabled:true,stockAlerts:true,reviewAlerts:true,yahooAlerts:true};
function product(eligibility='not_possible'){return {key:'stock:test',title:'FBA不可の自社発送商品',asin:'B000TEST01',sellerSku:'OLD-FBA',condition:'used',sources:['stock'],sourceKeys:['stock:test'],stockIds:['test'],fbaEligibility:eligibility,useChannels:['merchant','yahoo'],unit:'個',rule:{key:'stock:test',replenishEnabled:false,threshold:0},fba:{status:'complete',quantity:0,sellerSku:'OLD-FBA',checkedAt:at},channels:{fba:{state:'inactive'},merchant:{state:'active',skus:['OWN-MERCHANT'],quantity:1,checkedAt:at}},locations:[{locationId:'home',usable:1,checkedAt:at}],localAvailable:1,plans:[],yahoo:[],sales:{},tags:[]};}

test('FBA-ineligible merchant stock does not receive the automatic zero-FBA alert',()=>{
 const row=product(),watch=emptyProductWatch(),before=structuredClone(row);assert.equal(collectProductAlerts(watch,[row],settings,at).length,0);assert.deepEqual(row,before);assert.equal(withAlertIndicators([row],watch,settings,at)[0].alerts.length,0);
});

test('eligible or unclassified products keep their zero-FBA protection even with merchant stock',()=>{
 for(const value of ['possible','unknown',undefined]){const row=product();row.fbaEligibility=value;const alerts=collectProductAlerts(emptyProductWatch(),[row],settings,at);assert.equal(alerts.length,1);assert.match(alerts[0].key,/^fba-zero:/);}
});

test('explicit home stock warning stays active for an FBA-ineligible product',()=>{
 const row=product();row.rule.lowStock={source:'home',threshold:1};const alerts=withAlertIndicators([row],emptyProductWatch(),settings,at)[0].alerts;assert.equal(alerts.length,1);assert.equal(alerts[0].quantity.source,'home');assert.equal(alerts[0].quantity.quantity,1);
});

test('a previously queued zero alert becomes false without changing the reminder control or queued receipt',()=>{
 const row=product('possible'),watch=emptyProductWatch(),first=collectProductAlerts(watch,[row],settings,at)[0];first.queuedAt=at;watch.noticeControls={[first.id]:{stopped:false,at}};const before=structuredClone(watch);row.fbaEligibility='not_possible';
 const indicators=withAlertIndicators([row],watch,settings,at);assert.equal(indicators[0].alerts.length,0);assert.deepEqual(watch,before);
 const observations=[];collectProductAlerts(watch,[row],settings,at,{onObserve:a=>observations.push(a)});assert.equal(observations.find(a=>a.key===first.key).value,false);assert.equal(watch.signals[first.key].active,false);assert.equal(watch.pendingAlerts[0].queuedAt,at);assert.deepEqual(watch.noticeControls,before.noticeControls);
});

test('review reminders remain visible on an FBA-ineligible product',()=>{
 const row=product();row.rule.startedOn='2026-10-31';row.watchDue='2026-11-14';const alerts=withAlertIndicators([row],emptyProductWatch(),settings,at)[0].alerts;assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'review');
});
