import {randomUUID} from "node:crypto";
import {readFbaInventory} from "./amazon-fba-reader.js";
import {fetchYahooListing} from "./yahoo-observation.js";
import {productOverview} from "./product-overview.js";
import {planningToday} from "./sales-planning.js";

export function collectProductAlerts(state,rows,settings,at){
  const signals=state.signals ||= {},pending=state.pendingAlerts ||= [],observed=new Set();
  function observe(key,value,category,row,message){
    observed.add(key);
    if(value===null||!settings[category])return;
    if(value&&/^(action-|review-)/.test(key)&&pending.some(p=>p.key===key&&p.queuedAt))return;
    const previous=signals[key];
    if(value&&!previous?.active){const id=randomUUID();pending.push({id,key,category,at,title:row.title||"取得状況",asin:row.asin||"",message,eventKey:`product:${key}:${id}`});signals[key]={active:true,at};}
    else if(!value){signals[key]={active:false,at};for(const p of pending)if(p.key===key&&!p.queuedAt)p.dismissedAt=at;}
  }
  const fbaKeys=new Set(),yahooKeys=new Set(),planKeys=new Set();
  for(const row of rows){
    if(!row.sources.every(s=>s==="draft")){
      const fbaKey=row.fba.sellerSku?`${row.asin}:${row.fba.sellerSku}`:row.key;
      if(!fbaKeys.has(fbaKey)){
        fbaKeys.add(fbaKey);
        const local=row.localAvailable===null?"手元在庫：未確認":`手元の使用可能在庫：${row.localAvailable}個`;
        observe(`fba-zero:${fbaKey}`,row.fba.status==="complete"?row.fba.quantity===0:null,"stockAlerts",row,`FBAの販売可能数が0個です。${local}。自己発送の在庫とは別です。併売の継続・補充を確認してください。`);
      }
      observe(`replenish:${row.key}`,row.rule.replenishEnabled&&row.fba.status==="complete"&&row.localAvailable!==null&&(row.rule.minimumSales7===0||row.sales.fbaQuantity7!==null)?row.replenishment:row.rule.replenishEnabled?null:false,"stockAlerts",row,
        `追加納品を検討してください。FBA販売可能${row.fba.quantity}個、手元使用可能${row.localAvailable}個。FBAの直近7日販売${row.sales.fbaQuantity7??"未確認"}個、残り${row.daysRemaining??"未確認"}日分。納品中：${(row.transfers||[]).filter(t=>t.to==="fba").reduce((n,t)=>n+t.remaining,0)}個（台帳記録）。納品手配前に実数と受領状況を確認してください。`);
    }
    for(const y of row.yahoo||[])if(!yahooKeys.has(y.listingId)){
      yahooKeys.add(y.listingId);const fresh=Number.isFinite(Date.parse(y.checkedAt))&&Date.parse(at)-Date.parse(y.checkedAt)<=26*3600000;
      observe(`yahoo-ended:${y.listingId}`,fresh&&y.verified?y.status==="ended":null,"yahooAlerts",row,`ヤフオク出品 ${y.listingId} の終了を確認しました。${y.reason==="unsold"?"落札なしの終了です。":y.reason==="sold"?"落札ありの終了です。":"落札の有無は未確認です。売れ残りとは断定していません。"}\nhttps://auctions.yahoo.co.jp/jp/auction/${y.listingId}\n再出品するか確認してください。`);
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
  for(const p of pending)if(/^(action-|review-)/.test(p.key||"")&&!observed.has(p.key)&&!p.queuedAt)p.dismissedAt=at;
  if(pending.length>5000)throw new Error("通知履歴の保存上限を確認してください");
  return pending.filter(p=>!p.queuedAt&&!p.dismissedAt);
}

export function createProductMonitoring({overview,watchStore,config,readInventory=readFbaInventory,readYahoo=fetchYahooListing,readListings,now=()=>new Date().toISOString()}){
  async function run({settings,enqueueAlerts,refreshListings=false}){
    const id=randomUUID(),at=now(),claim=await watchStore.update(state=>{
      if(state.observations.job?.status==="running"&&Date.parse(state.observations.job.leaseUntil)>Date.parse(at))return false;
      state.observations.job={id,status:"running",startedAt:at,leaseUntil:new Date(Date.parse(at)+150000).toISOString()};return true;
    });
    if(!claim)return {status:"running"};
    const input=await overview.inputs(),asins=[...new Set(productOverview(input,at).filter(r=>!r.sources.every(s=>s==="draft")).map(r=>r.asin).filter(Boolean))];
    let fba,listings,errors=[];
    if(asins.length&&asins.length<=100){
      try{fba=await readInventory({asins,config,maxPages:20,maxDurationMs:45000});if(!fba.complete||fba.accountKey!==config.accountKey||fba.sellerId!==config.sellerId||JSON.stringify([...fba.asins].sort())!==JSON.stringify([...asins].sort()))throw new Error("scope");}
      catch{errors.push("FBA在庫を取得できません。以前の数量を現在庫やゼロとは扱いません");fba={...input.watch.observations.fba,status:"failed",complete:false,attemptedAt:now()};}
    }else if(asins.length>100){errors.push("FBA対象が100 ASINを超えています。分割確認が必要です");fba={...input.watch.observations.fba,status:'failed',complete:false,attemptedAt:now()};}
    if(refreshListings&&readListings&&asins.length&&asins.length<=100){
      try{const deadline=Date.now()+35000,rows=[];let result;for(let i=0;i<asins.length;i+=20){if(Date.now()>=deadline)throw new Error('timeout');result=await readListings({asins:asins.slice(i,i+20),config,maxDurationMs:deadline-Date.now()});if(result.status!=='complete'||result.accountKey!==config.accountKey||result.sellerId!==config.sellerId)throw new Error('scope');rows.push(...result.rows);}listings={...result,asins,rows,attemptedAt:now()};}
      catch{errors.push('Amazonの出品状態を取得できません。商品ページを開くか再取得してください');listings={...input.watch.observations.listings,status:'failed',attemptedAt:now()};}
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
        results.push({listingId:target.listingId,status:snapshot.observation.status,verified:true,reason:snapshot.observation.reason||"unknown",quantity:snapshot.quantity??snapshot.observation.quantity??null,saleType:snapshot.saleType||snapshot.observation.saleType||'unknown',bidCount:snapshot.bidCount??null,checkedAt:snapshot.observation.checkedAt});
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
      const rows=productOverview({...current,watch:state},now()),pending=collectProductAlerts(state,rows,settings,now());
      if(errors.length&&settings.errorAlerts){
        if(!state.signals.fetchError?.active){const eventId=randomUUID();state.pendingAlerts.push({id:eventId,eventKey:`product:fetch-error:${eventId}`,category:"errorAlerts",title:"在庫・出品の取得状況",message:errors.join("\n"),at:now()});state.signals.fetchError={active:true};}
      }else if(!errors.length){state.signals.fetchError={active:false};for(const p of state.pendingAlerts)if(p.eventKey.startsWith("product:fetch-error:")&&!p.queuedAt)p.dismissedAt=now();}
      return structuredClone(state.pendingAlerts.filter(p=>!p.queuedAt&&!p.dismissedAt));
    });
    if(pending.length&&enqueueAlerts){await enqueueAlerts(pending);await watchStore.update(state=>{for(const p of state.pendingAlerts)if(pending.some(v=>v.id===p.id))p.queuedAt=now();});}
    return {status:errors.length?"partial":"complete",errors,pendingAlerts:pending.length};
  }
  return {run};
}
