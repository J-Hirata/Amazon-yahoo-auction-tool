import {recordIncomingReflections} from './fba-incoming.js';
import {randomUUID} from "node:crypto";
import {readFbaInventory} from "./amazon-fba-reader.js";
import {fetchYahooListing} from "./yahoo-observation.js";
import {productOverview} from "./product-overview.js";
import {recordReplenishmentBaselines} from './replenishment.js';
import {collectYahooQuantityAlerts} from './yahoo-quantity-alerts.js';

export {collectProductAlerts} from "./product-alerts.js";
import {collectProductAlerts} from "./product-alerts.js";

export function createProductMonitoring({overview,watchStore,config,readInventory=readFbaInventory,readYahoo=fetchYahooListing,readListings,followRelistings,now=()=>new Date().toISOString()}){
  async function run({settings,enqueueAlerts,refreshListings=false}){
    const id=randomUUID(),at=now(),claim=await watchStore.update(state=>{
      if(state.observations.job?.status==="running"&&Date.parse(state.observations.job.leaseUntil)>Date.parse(at))return false;
      state.observations.job={id,status:"running",startedAt:at,leaseUntil:new Date(Date.parse(at)+150000).toISOString()};return true;
    });
    if(!claim)return {status:"running"};
    let relistingError='';
    if(followRelistings)try{await followRelistings();}catch{relistingError='再出品メールの確認に失敗しました。以前の紐付けを保持しています';}
    const input=await overview.inputs(),asins=[...new Set(productOverview(input,at).filter(r=>!r.sources.every(s=>s==="draft")).map(r=>r.asin).filter(Boolean))];
    let fba,listings,errors=relistingError?[relistingError]:[];
    if(asins.length&&asins.length<=100){
      try{fba=await readInventory({asins,config,maxPages:20,maxDurationMs:45000});if(!fba.complete||fba.accountKey!==config.accountKey||fba.sellerId!==config.sellerId||JSON.stringify([...fba.asins].sort())!==JSON.stringify([...asins].sort()))throw new Error("scope");}
      catch{errors.push("FBA在庫を取得できません。以前の数量を現在庫やゼロとは扱いません");fba={...input.watch.observations.fba,status:"failed",complete:false,attemptedAt:now()};}
    }else if(asins.length>100){errors.push("FBA対象が100 ASINを超えています。分割確認が必要です");fba={...input.watch.observations.fba,status:'failed',complete:false,attemptedAt:now()};}
    if(refreshListings&&readListings&&asins.length&&asins.length<=100){
      try{const deadline=Date.now()+35000,rows=[];let result;for(let i=0;i<asins.length;i+=20){if(Date.now()>=deadline)throw new Error('timeout');result=await readListings({asins:asins.slice(i,i+20),config,maxDurationMs:deadline-Date.now()});if(result.status!=='complete'||result.accountKey!==config.accountKey||result.sellerId!==config.sellerId)throw new Error('scope');rows.push(...result.rows);}listings={...result,asins,rows,attemptedAt:now()};}
      catch{errors.push('Amazonの出品状態を取得できません。商品ページを開くか再取得してください');listings={...input.watch.observations.listings,status:'failed',asins,attemptedAt:now()};}
    }
    const ids=[...new Set(input.monitor.links.map(l=>l.listingId))];
    const previous=input.watch.observations.yahoo||[];
    const targets=ids.map(listingId=>({listingId,previous:previous.find(y=>y.listingId===listingId)})).sort((a,b)=>(a.previous?.checkedAt||"").localeCompare(b.previous?.checkedAt||"")).slice(0,20);
    const results=[];
    for(let i=0;i<targets.length;i+=4)await Promise.all(targets.slice(i,i+4).map(async target=>{
      try{
        const snapshot=await readYahoo(`https://auctions.yahoo.co.jp/jp/auction/${target.listingId}`,{maxDurationMs:9000});
        const old=input.monitor.listings.find(l=>l.listingId===target.listingId),links=input.monitor.links.filter(l=>l.listingId===target.listingId);
        const identityOkay=snapshot.listingId===target.listingId&&(!old?.seller||snapshot.seller===old.seller)&&!(snapshot.references||[]).some(ref=>ref.kind==="asin"&&links.some(l=>l.asin&&l.asin!==ref.value));
        if(!identityOkay||!snapshot.observation?.verified)throw new Error("identity");
        results.push({listingId:target.listingId,status:snapshot.observation.status,verified:true,reason:snapshot.observation.reason||"unknown",quantity:snapshot.quantity??snapshot.observation.quantity??null,saleType:snapshot.saleType||snapshot.observation.saleType||'unknown',bidCount:snapshot.bidCount??null,endTime:snapshot.endTime||null,checkedAt:snapshot.observation.checkedAt});
      }catch{results.push({listingId:target.listingId,status:"unknown",verified:false,reason:"取得できず・終了とは判断しません",checkedAt:now()});}
    }));
    if(results.some(r=>!r.verified))errors.push(`ヤフオク${results.filter(r=>!r.verified).length}件を確認できません。ログインやページ変更の可能性があります`);
    if(ids.length>targets.length)errors.push(`ヤフオクは今回${targets.length}/${ids.length}件を確認。残りは次回に順番に確認します`);
    await watchStore.update(state=>{
      if(state.observations.job?.id!==id)throw new Error("監視中に別の実行が始まりました");
      if(fba)state.observations.fba=fba;
      if(listings)state.observations.listings=listings;
      state.observations.yahoo=[...previous.filter(p=>ids.includes(p.listingId)&&!results.some(r=>r.listingId===p.listingId)),...results];
      state.observations.job={...state.observations.job,status:errors.length?"partial":"complete",finishedAt:now(),errors,fbaCheckedAsins:asins.length,yahooChecked:results.length};
    });
    const current=await overview.inputs();
    const pending=await watchStore.update(state=>{
      for(const record of current.monitor.mailOutbox||[])if(record.status==='cancelled'&&record.cancelledFor==='conditions_changed')for(const p of state.pendingAlerts||[])if(record.alertIds?.includes(p.id)&&p.queuedAt){delete p.queuedAt;if(record.cancelledAlertIds?.includes(p.id))p.dismissedAt=now();}
      recordIncomingReflections(state,productOverview({...current,watch:state},now()));
      recordReplenishmentBaselines(state,productOverview({...current,watch:state},now()),now());
      const rows=productOverview({...current,watch:state},now());
      const standard=collectProductAlerts(state,rows,settings,now()).filter(p=>!p.key?.startsWith('yahoo-quantity:'));
      const pending=[...standard,...collectYahooQuantityAlerts(state,rows,settings,now(),previous)];
      if(errors.length&&settings.errorAlerts){
        if(!state.signals.fetchError?.active){const eventId=randomUUID();state.pendingAlerts.push({id:eventId,eventKey:`product:fetch-error:${eventId}`,category:"errorAlerts",title:"在庫・出品の取得状況",message:errors.join("\n"),at:now()});state.signals.fetchError={active:true};}
      }else if(!errors.length){state.signals.fetchError={active:false};for(const p of state.pendingAlerts)if(p.eventKey.startsWith("product:fetch-error:")&&!p.queuedAt)p.dismissedAt=now();}
      return structuredClone(state.pendingAlerts.filter(p=>settings[p.category]&&!p.queuedAt&&!p.dismissedAt));
    });
    if(pending.length&&enqueueAlerts){await enqueueAlerts(pending);await watchStore.update(state=>{for(const p of state.pendingAlerts)if(pending.some(v=>v.id===p.id))p.queuedAt=now();});}
    return {status:errors.length?"partial":"complete",errors,pendingAlerts:pending.length};
  }
  async function alertStates(){const state=await watchStore.read();return Object.fromEntries((state.pendingAlerts||[]).map(p=>{const signal=p.key?state.signals[p.key]:p.eventKey?.startsWith('product:fetch-error:')?state.signals.fetchError:null;return [p.id,p.dismissedAt?false:signal?.known===false?null:typeof signal?.active==='boolean'?signal.active:null];}));}
  return {run,alertStates};
}
