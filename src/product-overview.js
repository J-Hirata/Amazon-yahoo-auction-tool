import {incomingFor} from './fba-incoming.js';
import {sharedLowStock,saveSharedLowStock} from './product-low-stock.js';
import {alertFba} from './fba-counter.js';
import {riskSettings,stockRisk,riskQuantity} from "./stock-risk.js";
import {collectProductAlerts} from "./product-alerts.js";
import {createHash} from "node:crypto";
import {stockTotals} from "./physical-stock.js";
import {planningSchedule,planningToday} from "./sales-planning.js";
import {stockImageUrl} from "./stock-images.js";
import {actionSchedules} from "./planning-actions.js";
import {productChannels} from "./product-channels.js";
import {attachAvailability,skuOptions} from './product-availability.js';
import {resolvedLinkSku,resolvedLinkCondition,productWorkspace,conditionFamily} from './product-workspace.js';
import {replenishmentView} from './replenishment.js';
export const WATCH_TAGS={watch:"監視対象",overstock:"在庫過多",large:"大型",heavy:"重量物"};
const fail=(m,status=400)=>Object.assign(new Error(m),{status});
const uuid=v=>/^[0-9a-f-]{36}$/i.test(v||"");
const family=v=>/^new/i.test(v||"")?"new":/^used/i.test(v||"")?"used":"unknown";
const text=(v,n=500)=>{if(typeof v!=="string"||v.length>n)throw fail("入力文字数を確認してください");return v.trim();};
const number=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
export const emptyProductWatch=()=>({version:1,rules:[],receipts:[],observations:{},signals:{}});
export function validateProductWatch(state){
  if(state?.version!==1||!Array.isArray(state.rules)||!Array.isArray(state.receipts)||!state.observations||!state.signals)throw fail("商品監視の保存形式を確認してください");
  if(state.rules.length>2000||state.receipts.length>10000||new Set(state.rules.map(r=>r.key)).size!==state.rules.length||Buffer.byteLength(JSON.stringify(state))>8*1024*1024)throw fail("商品監視の保存上限を確認してください");
  for(const rule of state.rules){if(rule.lowStock!==undefined)riskSettings(rule.lowStock);if(rule.relistStockSource!==undefined&&!['','merchant','home','container'].includes(rule.relistStockSource))throw fail('再出品候補の残数参照元を確認してください');}
  return state;
}
export function ruleFields(input,at){
  const key=text(input.key,100);if(!/^(stock|link|plan|draft|watch):[A-Za-z0-9_-]{1,80}$/.test(key))throw fail("対象商品を確認してください");
  const tags=input.tags;if(!Array.isArray(tags)||new Set(tags).size!==tags.length||tags.some(t=>!Object.hasOwn(WATCH_TAGS,t)))throw fail("監視タグを選んでください");
  if(typeof input.replenishEnabled!=="boolean"||!number(input.threshold,1000000)||!number(input.minimumSales7,1000000)||!number(input.coverageDays,365)||!number(input.reviewDays,365)||input.reviewDays<1)throw fail("閾値・日数は指定範囲の整数で入力してください");
  const startedOn=text(input.startedOn||"",10);if(startedOn&&(!/^\d{4}-\d{2}-\d{2}$/.test(startedOn)||!Number.isFinite(Date.parse(startedOn))||new Date(startedOn+"T00:00:00Z").toISOString().slice(0,10)!==startedOn||startedOn>planningToday(at)))throw fail("確認済みの販売開始日を入力してください。予定日では開始しません");
  const result={key,tags:[...tags],replenishEnabled:input.replenishEnabled,threshold:input.threshold,minimumSales7:input.minimumSales7,coverageDays:input.coverageDays,reviewDays:input.reviewDays,startedOn,note:text(input.note||"",1000),updatedAt:at};
  if(input.baselineQuantity!==undefined||input.replenishPercent!==undefined){
    if(input.baselineQuantity!==null&&!number(input.baselineQuantity,1000000)||!number(input.replenishPercent,100)||input.replenishPercent>0&&!(input.baselineQuantity>0))throw fail('補充の基準数と割合を確認してください');
    result.baselineQuantity=input.baselineQuantity;result.replenishPercent=input.replenishPercent;
  }
  if(input.lowStock!==undefined)result.lowStock=riskSettings(input.lowStock);
  if(input.relistStockSource!==undefined){if(!['','merchant','home','container'].includes(input.relistStockSource))throw fail('再出品候補の残数参照元を選んでください');result.relistStockSource=input.relistStockSource;}
  if(input.manualListingStatus!==undefined){if(!["unknown","mercari","none"].includes(input.manualListingStatus))throw fail("手動の出品状況を選んでください");result.manualListingStatus=input.manualListingStatus;}
  if(key.startsWith("watch:")){
    const asin=text(input.asin||"",10).toUpperCase(),title=text(input.title||"",200)||asin;
    if(!title||asin&&!/^[A-Z0-9]{10}$/.test(asin)||!["new","used","parts","unknown"].includes(input.condition))throw fail("監視商品の名前・ASIN・状態を確認してください");
    const imageUrl=text(input.imageUrl||"",2048);if(imageUrl&&!stockImageUrl(imageUrl))throw fail("商品写真を確認してください");
    Object.assign(result,{asin,title,condition:input.condition,sellerSku:text(input.sellerSku||"",200),imageUrl});
  }
  return result;
}
function inventoryFor(row,monitor,watch,at){
  const snapshot=watch.observations.fba;
  const unknown={quantity:null,reserved:null,status:"unknown",checkedAt:snapshot?.asins?.includes(row.asin)?snapshot.checkedAt||null:null,variants:[]};
  if(!row.asin)return {...unknown,status:"no_asin"};
  if(row.sources?.every(s=>s==='draft'))return {...unknown,status:'draft'};
  if(snapshot?.status!=="complete"||!snapshot.complete||snapshot.accountKey!==monitor.amazonAccountKey||snapshot.sellerId!==monitor.amazonSellerId||!snapshot.asins?.includes(row.asin))return unknown;
  if(!Number.isFinite(Date.parse(snapshot.checkedAt))||Date.parse(at)-Date.parse(snapshot.checkedAt)>26*3600000||Date.parse(snapshot.checkedAt)>Date.parse(at)+60000)return {...unknown,status:"stale"};
  const targets=(monitor.salesTargets?.targets||[]).filter(t=>row.sourceKeys.includes(t.sourceId));
  const fbaSkus=[...new Set(targets.filter(t=>t.fulfillment?.includes("AMAZON")).map(t=>t.sellerSku))];
  if(!row.sellerSku&&targets.length&&!fbaSkus.length)return {...unknown,status:"not_fba"};
  const matches=snapshot.items.filter(r=>r.asin===row.asin&&(!row.sellerSku||r.sellerSku===row.sellerSku)&&(row.sellerSku||!fbaSkus.length||fbaSkus.includes(r.sellerSku))&&(!["new","used"].includes(row.condition)||family(r.condition)===row.condition));
  if(matches.length!==1)return {...unknown,status:matches.length>1?"ambiguous":"not_found",variants:matches.map(r=>({sellerSku:r.sellerSku,quantity:r.fulfillableQuantity,condition:r.condition}))};
  const item=matches[0];return {status:Number.isSafeInteger(item.fulfillableQuantity)?"complete":"unknown",quantity:Number.isSafeInteger(item.fulfillableQuantity)?item.fulfillableQuantity:null,reserved:item.reservedQuantity,inbound:item.inboundQuantity??null,checkedAt:snapshot.checkedAt,sellerSku:item.sellerSku,condition:item.condition,variants:[]};
}
function salesFor(row,monitor,at){
  const t=monitor.salesTracking,start=Date.parse(at)-7*86400000;
  const targets=(t?.trackers||[]).filter(target=>row.sourceKeys.includes(target.sourceId)||row.linkIds.includes(target.linkId));
  const skus=new Set(row.sellerSku?[row.sellerSku]:targets.map(target=>target.sellerSku));
  const complete=t?.sync?.status==="complete"&&Date.parse(t.checkedThrough)>=Date.parse(at)-26*3600000&&targets.length&&targets.every(target=>Date.parse(target.startedAt)<=start);
  const rows=(t?.orders||[]).filter(r=>r.asin===row.asin&&skus.has(r.sellerSku)&&Date.parse(r.createdAt)>=start);
  const uncertain=rows.some(r=>r.status==="UNKNOWN");
  return {quantity7:complete&&!uncertain?rows.reduce((n,r)=>n+(r.confirmedQuantity||0),0):null,fbaQuantity7:complete&&!uncertain?rows.filter(r=>r.fulfillment==="AMAZON").reduce((n,r)=>n+(r.confirmedQuantity||0),0):null,observedQuantity7:rows.reduce((n,r)=>n+(r.confirmedQuantity||0),0),status:!complete?"incomplete":uncertain?"unknown":"complete",checkedThrough:t?.checkedThrough||null};
}
export function productOverview({monitor,physical,planning,drafts=[],watch},at=new Date().toISOString()){
  const rows=[],byKey=new Map(),linkRows=new Map();
  const linkSku=l=>resolvedLinkSku(l,monitor,watch,at);
  const observation=id=>[(watch.observations.yahoo||[]).find(y=>y.listingId===id),monitor.listings.find(l=>l.listingId===id)?.observation].filter(Boolean).sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt))[0];
  const add=(key,values)=>{const row={key,title:values.asin||"商品名未取得",asin:"",sellerSku:"",condition:"unknown",imageUrl:"",sourceKeys:[key],sources:[key.split(":")[0]],stockIds:[],linkIds:[],plans:[],locations:[],...values};rows.push(row);byKey.set(key,row);return row;};
  for(const p of physical.products){const totals=stockTotals(physical,p.id);add(`stock:${p.id}`,{...p,key:`stock:${p.id}`,stockIds:[p.id],locations:totals.locations,transfers:physical.transfers.filter(t=>t.productId===p.id&&t.remaining>0).map(t=>({to:t.to,remaining:t.remaining}))});}
  for(const link of monitor.links){
    const p=monitor.catalog.find(p=>p.id===link.catalogId),listing=monitor.listings.find(l=>l.listingId===link.listingId),asin=link.asin||p?.asin||"";
    const sku=linkSku(link);
    const linkCondition=conditionFamily(resolvedLinkCondition(link,monitor,watch,at));
    const candidates=physical.products.filter(s=>(s.linkedLinkIds.includes(link.id)||sku&&s.sellerSku===sku&&monitor.links.some(l=>s.linkedLinkIds.includes(l.id)&&l.verified&&!l.observationConflict&&(l.asin||monitor.catalog.find(p=>p.id===l.catalogId)?.asin)===asin&&linkSku(l)===sku))&&s.asin===asin&&(!s.sellerSku||!sku||s.sellerSku===sku)&&(s.sellerSku||new Set(monitor.links.filter(l=>s.linkedLinkIds.includes(l.id)).map(linkSku).filter(Boolean)).size<=1)&&(linkCondition==='unknown'||s.condition==='unknown'||s.condition===linkCondition));
    const row=candidates.length===1?byKey.get(`stock:${candidates[0].id}`):add(`link:${link.id}`,{asin,title:link.workspaceProduct?.title||listing?.title||link.previousListingTitle||p?.title||asin,setContents:link.workspaceProduct?.setContents||p?.setContents||'',sellerSku:sku,condition:link.workspaceProduct?.condition||(link.matchBy==="asin"?"unknown":family(p?.condition)),imageUrl:link.workspaceProduct?.imageUrl||listing?.imageUrl||p?.listingInfo?.catalogImageUrl||""});
    if(sku&&!row.sellerSku)row.sellerSku=sku;
    if(!row.sourceKeys.includes(`link:${link.id}`))row.sourceKeys.push(`link:${link.id}`);if(!row.sources.includes("link"))row.sources.push("link");row.linkIds.push(link.id);linkRows.set(link.id,row);
    if(!row.imageUrl)row.imageUrl=listing?.imageUrl||"";
    (row.yahoo ||= []).push({listingId:link.listingId,title:listing?.title||"",unitsPerListing:link.unitsPerListing||1,...observation(link.listingId)});
  }
  for(const p of planning.plans){
    const explicit=(p.linkedLinkIds||[]).map(id=>linkRows.get(id)).filter(Boolean);
    const source=p.workspaceStockId?byKey.get(`stock:${p.workspaceStockId}`):p.source.kind==="stock"?byKey.get(`stock:${p.source.id}`):p.source.kind==="link"?linkRows.get(p.source.id):explicit.length===1?explicit[0]:null;
    const match=source&&source.asin===p.asin&&(!p.sellerSku||source.sellerSku===p.sellerSku)&&(!["new","used"].includes(source.condition)||p.condition==='unknown'||p.condition===source.condition);
    const row=match?source:add(`plan:${p.id}`,{asin:p.asin,sellerSku:p.sellerSku,title:p.title,condition:p.condition,imageUrl:p.imageUrl,referenceIssue:Boolean(source&&!match)});
    if(!row.sourceKeys.includes(`plan:${p.id}`))row.sourceKeys.push(`plan:${p.id}`);if(!row.sources.includes("plan"))row.sources.push("plan");row.plans.push({...p,schedule:planningSchedule(p,at),actionSchedules:actionSchedules(p,at)});if(!row.imageUrl)row.imageUrl=p.imageUrl||"";
    for(const id of p.linkedLinkIds||[]){const link=monitor.links.find(l=>l.id===id),listing=monitor.listings.find(l=>l.listingId===link?.listingId);if(link&&(link.asin||monitor.catalog.find(c=>c.id===link.catalogId)?.asin)===p.asin&&!row.linkIds.includes(id)){if(linkSku(link)&&row.sellerSku&&linkSku(link)!==row.sellerSku){row.referenceIssue=true;continue;}row.linkIds.push(id);(row.yahoo||=[]).push({listingId:link.listingId,title:listing?.title||"",unitsPerListing:link.unitsPerListing||1,...observation(link.listingId)});}}
  }
  for(const p of drafts)add(`draft:${p.asin}`,{asin:p.asin,title:p.title||p.asin,condition:"unknown",imageUrl:p.imageUrls?.[0]||""});
  for(const rule of watch.rules.filter(r=>r.key.startsWith("watch:")))add(rule.key,{asin:rule.asin,title:rule.title,condition:rule.condition,sellerSku:rule.sellerSku,imageUrl:rule.imageUrl});
  for(const row of rows){
    row.imageUrl=stockImageUrl(row.imageUrl)||"";
    const related=[...(row.linkedLinkIds||[]),...row.plans.flatMap(p=>[...(p.linkedLinkIds||[]),...(p.source.kind==='link'?[p.source.id]:[])])];
    row.linkConflicts=[...new Set(related.filter(id=>!row.linkIds.includes(id)).map(id=>monitor.links.find(l=>l.id===id)?.listingId).filter(Boolean))];
    if(row.linkConflicts.length)row.referenceIssue=true;
    row.rules=watch.rules.filter(r=>row.sourceKeys.includes(r.key));row.rule=row.rules.find(r=>r.key===row.key)||row.rules[0]||{key:row.key,tags:[],replenishEnabled:false,threshold:10,minimumSales7:0,coverageDays:0,reviewDays:10,startedOn:"",note:""};
    row.sharedLowStock=sharedLowStock(row);
    if(row.sharedLowStock.hasSetting)row.rule={...row.rule,lowStock:row.sharedLowStock.conflict?{source:'',threshold:null}:{source:row.sharedLowStock.source,threshold:row.sharedLowStock.threshold}};
    row.tags=[...new Set(row.rules.flatMap(r=>r.tags))];
    row.fba=inventoryFor(row,monitor,watch,at);row.incoming=incomingFor(row,monitor,at,watch);row.sales=salesFor(row,monitor,at);
    row.daysRemaining=row.fba.quantity!==null&&row.sales.fbaQuantity7>0?Math.round(row.fba.quantity/(row.sales.fbaQuantity7/7)*10)/10:null;
    row.localKnown=row.locations.some(l=>l.usable!==null);row.localAvailable=row.localKnown?row.locations.reduce((sum,l)=>sum+(l.usable||0),0):null;
    row.badges=[...(row.asin&&row.sources.some(s=>s!=="draft")?["amazon"]:[]),...(row.linkIds.length?["yahoo","parallel"]:[]),...(row.locations.some(l=>l.locationId==="container"&&l.usable>0)?["container"]:[]),...(row.locations.some(l=>l.locationId==="home"&&l.usable>0)?["home"]:[]),...row.tags,...(row.plans.length?["planning"]:[]),...(row.sources.includes("draft")?["draft"]:[])];
    row.watchDue=row.rule.startedOn?new Date(Date.parse(row.rule.startedOn+"T00:00:00Z")+row.rule.reviewDays*86400000).toISOString().slice(0,10):"";
    row.channels=productChannels(row,monitor,watch,at,physical.amazonListings);
    row.skuOptions=skuOptions(row,monitor,watch,at,physical.amazonListings);
    row.provenance=row.sources.map(s=>({stock:"コンテナ・自社在庫",link:"商品紐付け",plan:"販売の監視・見直し",draft:"出品下書き",watch:"監視専用登録"})[s]);
    row.dueDates=[...row.plans.flatMap(p=>p.actionSchedules.some(a=>a.startsOn||a.endsOn)?p.actionSchedules.map(a=>a.nextOn).filter(Boolean):[p.schedule.dueOn].filter(Boolean)),...(row.watchDue?[row.watchDue]:[])].sort();
    row.attention=[];if(row.sharedLowStock.conflict)row.attention.push("通知残数が不一致：商品編集で共通の数に統一してください");if(row.fba.quantity===0)row.attention.push("FBA販売可能0");if(row.yahoo?.some(y=>y.status==="ended"))row.attention.push("ヤフオク終了");if(row.dueDates[0]&&row.dueDates[0]<=planningToday(at))row.attention.push("見直し時期");
    if(row.yahoo?.some(y=>!y.verified||!Number.isFinite(Date.parse(y.checkedAt))||Date.parse(at)-Date.parse(y.checkedAt)>26*3600000))row.attention.push("ヤフオク未確認");
    row.replenishmentInfo=replenishmentView(row,watch);row.replenishment=row.replenishmentInfo.due;
    if(row.replenishment)row.attention.push("追加納品を検討");
    if(row.referenceIssue)row.attention.push("参照先を要確認");
    if(row.channels.manualConflict)row.attention.push("手動の出品なし記録と出品中の取得情報が不一致");
    row.workspace=productWorkspace(row,{physical,monitor,watch,at});
  }
  for(const row of attachAvailability(rows,monitor,at)){const effective=alertFba(row);row.daysRemaining=effective.quantity!==null&&row.sales.fbaQuantity7>0?Math.round(effective.quantity/(row.sales.fbaQuantity7/7)*10)/10:null;row.replenishmentInfo=replenishmentView(row,watch);row.replenishment=row.replenishmentInfo.due;if(row.workspace)row.workspace.replenishment=row.replenishmentInfo;if(row.replenishment&&!row.attention.includes('追加納品を検討'))row.attention.push('追加納品を検討');row.risk=stockRisk(row,at);row.riskOptions=Object.fromEntries(["fba","merchant","home","container"].map(s=>[s,riskQuantity(row,s,at)]));if(row.risk.low===true)row.attention.push(`残数警告：${row.risk.label} ${row.risk.quantity}${row.risk.unit}`);}
  return rows;
}
export function createProductOverview({monitorStore,stockStore,planningStore,draftStore,watchStore,ruleTransaction,now=()=>new Date().toISOString()}){
  async function inputs(){const [monitor,physical,planning,drafts,watch]=await Promise.all([monitorStore.read(),stockStore.read(),planningStore.read(),draftStore?draftStore.read():[],watchStore.readSnapshot()]);return {monitor,physical,planning,drafts,watch:watch.state,revision:watch.revision};}
  async function view(){const data=await inputs(),at=now();return{revision:data.revision,checkedAt:at,rows:productOverview(data,at),monitoring:data.watch.observations.job||{status:"not_run"},relisting:data.monitor.yahooRelisting||null,automation:data.monitor.salesAutomation||null,mail:(data.monitor.mailOutbox||[]).slice(-10).map(({kind,status,createdAt,subject})=>({kind,status,createdAt,subject}))};}
  async function commit(command,{expectedRevision,actor}){
    if(!uuid(command?.operationId))throw fail("操作IDを確認してください");const digest=createHash("sha256").update(JSON.stringify(command)).digest("hex");
    function apply(state,data){
      const saved=state.receipts.find(r=>r.id===command.operationId);if(saved){if(saved.actor!==actor||saved.digest!==digest)throw fail("同じ操作IDの内容が異なります",409);return;}
      const at=now(),rule=ruleFields(command.rule,at),row=productOverview({...data,watch:state},at).find(row=>row.sourceKeys.includes(rule.key));
      if(!rule.key.startsWith('watch:')&&!row)throw fail('対象商品が見つかりません。一覧を更新してください',409);
      if(command.lowStockUpdate===false)delete rule.lowStock;
      if(row?.sharedLowStock?.conflict&&rule.lowStock!==undefined&&command.lowStockUpdate!==true)throw fail('通知残数が異なります。共通の数を選んで保存してください',409);
      const previous=state.rules.find(r=>r.key===rule.key);if(previous&&rule.key.startsWith('watch:')&&previous.asin&&previous.asin!==rule.asin)throw fail('別のASINは新しい監視商品として追加してください',409);
      if(rule.manualListingStatus!==undefined)rule.manualListingAt=previous?.manualListingStatus===rule.manualListingStatus?previous.manualListingAt||at:at;
      const lowStock=rule.lowStock;delete rule.lowStock;if(previous)Object.assign(previous,rule);else state.rules.push(rule);
      if(lowStock!==undefined)saveSharedLowStock(state,row||{key:rule.key,sourceKeys:[rule.key]},lowStock,{actor,at,operationId:command.operationId});
      state.receipts.push({id:command.operationId,digest,actor,at});validateProductWatch(state);
    }
    if(ruleTransaction)await ruleTransaction.update(docs=>{
      const state=docs['product-watch'].state,saved=state.receipts.find(r=>r.id===command.operationId);
      if(!saved&&docs['product-watch'].revision!==expectedRevision)throw fail('監視設定が更新されました。入力を残して確認し直してください',409);
      apply(state,{monitor:docs['link-monitor'].state,physical:docs['physical-stock'].state,planning:docs['sales-planning'].state,drafts:docs['draft-items']?.state||[]});
    });
    else{const data=await inputs(),saved=data.watch.receipts.find(r=>r.id===command.operationId);if(saved){if(saved.actor!==actor||saved.digest!==digest)throw fail('同じ操作IDの内容が異なります',409);return view();}await watchStore.update(state=>apply(state,data),{expectedRevision});}
    return view();
  }
  async function previewRisks(){const data=await inputs(),at=now(),watch=structuredClone(data.watch),settings={...data.monitor.salesAutomation,reviewAlerts:false};const rows=productOverview({...data,watch},at),pending=collectProductAlerts(watch,rows,settings,at);return {checkedAt:at,nonSending:true,daytimeSchedule:"未設定",notificationEnabled:Boolean(settings.enabled),alerts:pending.filter(p=>settings.enabled&&settings[p.category]).map(({title,asin,message,category})=>({title,asin,message,category})),quantities:rows.filter(r=>r.risk.configured).map(r=>({title:r.title,key:r.key,...r.risk}))};}
  return {view,commit,inputs,previewRisks};
}
