import {createHash} from "node:crypto";
import {stockImageUrl} from "./stock-images.js";

const uuid=value=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const choose=(value,allowed)=>{if(!allowed.includes(value))throw fail("販売方針・状態を選択してください");return value;};
function text(value,max,required=false){if(value===undefined)value="";if(typeof value!=="string"||value.trim().length>max||required&&!value.trim())throw fail("必須項目と文字数を確認してください");return value.trim();}
function date(value){value=text(value,10);if(value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+"T00:00:00Z"))||new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value))throw fail("日付を正しく入力してください");return value;}
export const planningToday=at=>new Date(at).toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
export const emptySalesPlanning=()=>({version:1,plans:[],events:[],receipts:[]});
export function planningDigest(command){const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;return createHash("sha256").update(JSON.stringify(ordered(command))).digest("hex");}
function fields(input,at){
  const asin=text(input.asin,10).toUpperCase();if(asin&&!/^[A-Z0-9]{10}$/.test(asin))throw fail("ASINは英数字10文字で入力してください");
  const source={kind:choose(input.source?.kind||"manual",["manual","stock","link"]),id:text(input.source?.id,200)};
  if(source.kind==="manual"?source.id:!uuid(source.id))throw fail("参照する在庫・紐付け商品を確認してください");
  const title=text(input.title,200)||asin;
  if(!title)throw fail("ASINまたは商品名を入力してください");
  const imageUrl=text(input.imageUrl,2048);
  if(imageUrl&&!stockImageUrl(imageUrl))throw fail("商品画像のURLを確認してください");
  const allowedDecisions=["undecided","amazon","advertising","yahoo","rakuten","catalog","replenish","price","return","hold"];
  const decisions=input.decisions===undefined?[input.decision||"undecided"]:input.decisions;
  if(!Array.isArray(decisions)||!decisions.length||decisions.length>allowedDecisions.length||new Set(decisions).size!==decisions.length||decisions.some(d=>!allowedDecisions.includes(d))||decisions.length>1&&decisions.includes("undecided"))throw fail("次の方針を選び直してください");
  const result={title,asin,imageUrl,imageSource:imageUrl?"amazon_catalog":"",sellerSku:text(input.sellerSku,200),condition:choose(input.condition,["new","used","parts","unknown"]),setContents:text(input.setContents,300),source,
    kind:choose(input.kind,["amazon","advertising","review"]),status:choose(input.status,["active","hold","closed"]),availableOn:date(input.availableOn),availabilityNote:text(input.availabilityNote,500),adStartedOn:date(input.adStartedOn),
    durationDays:input.durationDays,reviewOn:date(input.reviewOn),decision:decisions[0],decisions:[...decisions],note:text(input.note,1000),salesMemo:text(input.salesMemo,500)};
  if(!Number.isSafeInteger(result.durationDays)||result.durationDays<1||result.durationDays>365)throw fail("確認期間は1〜365日の整数で入力してください");
  if(result.availableOn&&result.availableOn>planningToday(at))throw fail("実際に販売可能だった日を入力してください。未来日では開始しません");
  if(result.adStartedOn&&(!result.availableOn||result.adStartedOn<result.availableOn||result.adStartedOn>planningToday(at)))throw fail("広告開始日は販売可能日以降の実際の日付を入力してください");
  return result;
}
export function planningSchedule(plan,at=new Date().toISOString()){
  const today=planningToday(at);let dueOn="",startedOn="",stage="waiting";
  if(plan.status==="closed")return{stage:"closed",dueOn:"",startedOn:"",remainingDays:null};
  if(plan.status==="hold"||plan.kind==="review"){dueOn=plan.reviewOn;stage=plan.status==="hold"?"hold":dueOn?"scheduled":"unscheduled";}
  else {startedOn=plan.kind==="advertising"?plan.availableOn&&plan.adStartedOn:plan.availableOn;if(startedOn){dueOn=new Date(Date.parse(startedOn+"T00:00:00Z")+plan.durationDays*86400000).toISOString().slice(0,10);stage=plan.kind==="advertising"?"advertising":"watching";}}
  const remainingDays=dueOn?Math.round((Date.parse(dueOn+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86400000):null;
  if(dueOn&&remainingDays<=0)stage="due";
  return{stage,dueOn,startedOn:startedOn||"",remainingDays};
}
export function validateSalesPlanning(state){
  if(!state||state.version!==1||!["plans","events","receipts"].every(k=>Array.isArray(state[k])))throw fail("販売の見直しデータの保存形式を確認してください");
  const planIds=new Set(),operations=new Set();
  for(const plan of state.plans){if(!uuid(plan.id)||planIds.has(plan.id)||!Number.isFinite(Date.parse(plan.createdAt))||!Number.isFinite(Date.parse(plan.updatedAt)))throw fail("販売計画の管理ID・日時を確認してください");planIds.add(plan.id);fields(plan,plan.updatedAt);}
  for(const receipt of state.receipts){if(!uuid(receipt.id)||operations.has(receipt.id)||!planIds.has(receipt.planId)||!receipt.actor||!/^[a-f0-9]{64}$/.test(receipt.digest))throw fail("販売計画の保存受付を確認してください");operations.add(receipt.id);}
  for(const event of state.events)if(!planIds.has(event.planId)||!operations.has(event.operationId))throw fail("販売計画の履歴を確認してください");
  if(state.plans.length>1000||state.events.length>10000||state.receipts.length>10000||Buffer.byteLength(JSON.stringify(state))>8*1024*1024)throw fail("販売計画の保存上限です。履歴を削除せず拡張を確認してください",409);
  return state;
}
export function applyPlanningCommand(state,command,{actor,at=new Date().toISOString(),sources=[]}={}){
  if(!uuid(command?.operationId)||!uuid(command?.planId)||typeof actor!=="string"||!actor||actor.length>256||!Number.isFinite(Date.parse(at)))throw fail("保存用のIDと本人を確認してください");
  const digest=planningDigest(command),previous=state.receipts.find(r=>r.id===command.operationId);
  if(previous){if(previous.digest!==digest||previous.actor!==actor)throw fail("同じ操作IDの内容が異なります",409);return{...previous,replayed:true};}
  const kind=choose(command.kind,["create","edit"]),existing=state.plans.find(p=>p.id===command.planId);
  if(existing?.decisions?.length>1&&command.plan?.decisions===undefined)throw fail("複数の方針が保存されています。画面を更新してから編集してください",409);
  const values=fields({...command.plan,imageUrl:command.plan?.imageUrl===undefined?existing?.imageUrl||"":command.plan.imageUrl},at);
  if(kind==="create"&&existing||kind==="edit"&&!existing)throw fail("販売計画が更新されています。一覧を確認してください",409);
  const identityChanged=existing&&["asin","sellerSku","condition","setContents"].some(k=>existing[k]!==values[k]);
  if(existing&&(["asin","sellerSku","setContents"].some(k=>existing[k]&&existing[k]!==values[k])||existing.condition!=="unknown"&&existing.condition!==values.condition||existing.source.kind!==values.source.kind||existing.source.id!==values.source.id))throw fail("別の商品・SKU・状態へ変更する場合は計画を分けて登録してください",409);
  if(values.source.kind!=="manual"){
    const source=sources.find(s=>s.kind===values.source.kind&&s.id===values.source.id);
    if(kind==="create"||identityChanged){
      if(!source)throw fail("参照先が見つかりません。最新の一覧から選び直してください",409);
      if(source.asin!==values.asin||source.sellerSku!==values.sellerSku||source.condition!=="unknown"&&source.condition!==values.condition||source.setContents&&source.setContents!==values.setContents)throw fail("参照先とASIN・SKU・状態・セット内容が異なります。別商品を混ぜず確認してください",409);
    }
    if(state.plans.some(p=>p.id!==command.planId&&p.status!=="closed"&&values.status!=="closed"&&p.source.kind===values.source.kind&&p.source.id===values.source.id))throw fail("この商品の確認中の計画があります。既存の計画を編集してください",409);
  }
  const before=existing?structuredClone(existing):null,plan={...values,id:command.planId,createdAt:existing?.createdAt||at,updatedAt:at};
  if(existing)Object.assign(existing,plan);else state.plans.push(plan);
  const receipt={id:command.operationId,planId:plan.id,digest,actor,at};state.receipts.push(receipt);state.events.push({operationId:receipt.id,planId:plan.id,actor,at,before,after:structuredClone(plan)});
  validateSalesPlanning(state);return receipt;
}
