import {applyPlanningCommand,planningDigest,planningSchedule} from "./sales-planning.js";
import {assessLink} from "./link-monitor.js";
import {stockImageUrl} from "./stock-images.js";
import {actionSchedules} from "./planning-actions.js";

const fail=(message,status)=>Object.assign(new Error(message),{status});
export function createCloudPlanning({store,stock,monitorStore,readCatalog,now=()=>new Date().toISOString()}){
  async function sources(){
    const physical=await stock.view(),monitor=await monitorStore.read(),at=now();
    const rows=physical.products.map(p=>({kind:"stock",id:p.id,title:p.title,asin:p.asin,sellerSku:p.sellerSku,condition:p.condition,setContents:p.setContents,imageUrl:p.photo?.url||"",href:"/?view=stock",locations:p.totals.locations,
      fba:p.fba,amazon:p.amazon,listingIds:p.linked.map(l=>l.listingId)}));
    for(const link of monitor.links){const a=assessLink(link,monitor,at),p=a.product,y=a.listing,age=Date.parse(at)-Date.parse(p?.checkedAt),fresh=Number.isFinite(age)&&age>=-60000&&age<=90*60000&&!p?.error&&a.inventory!=="unlinked";
      rows.push({kind:"link",id:link.id,title:y?.title||p?.title||link.asin,asin:p?.asin||link.asin||"",sellerSku:link.amazonSellerSku||p?.sellerSku||"",condition:/^new/i.test(p?.condition||"")?"new":/^used/i.test(p?.condition||"")?"used":"unknown",setContents:p?.setContents||"",imageUrl:stockImageUrl(y?.imageUrl)||"",href:"/",locations:[],
        fba:{quantity:fresh&&typeof p?.fulfillableQuantity==="number"?p.fulfillableQuantity:null,label:fresh?"FBA取得分":"未確認・古い情報",checkedAt:p?.checkedAt||null},listingIds:[link.listingId],yahooStatus:a.yahoo});
    }
    return rows;
  }
  async function view(){const saved=await store.readSnapshot(),rows=await sources(),at=now();return{revision:saved.revision,checkedAt:at,catalogRead:Boolean(readCatalog),sources:rows,events:saved.state.events.slice(-100).reverse(),plans:saved.state.plans.map(p=>{
    const source=rows.find(s=>s.kind===p.source.kind&&s.id===p.source.id),mismatch=source&&(source.asin!==p.asin||source.sellerSku!==p.sellerSku||source.condition!=="unknown"&&source.condition!==p.condition||source.setContents&&source.setContents!==p.setContents);
    return{...p,actionSchedules:actionSchedules(p,at),schedule:planningSchedule(p,at),reference:mismatch?null:source||null,referenceIssue:mismatch?"参照先の商品情報が変わっています":!source&&p.source.kind!=="manual"?"参照先が見つかりません":""};
  })};}
  async function commit(command,{expectedRevision,actor}){
    const previous=(await store.read()).receipts.find(r=>r.id===command?.operationId);
    if(previous){if(previous.actor!==actor||previous.digest!==planningDigest(command))throw fail("同じ操作IDの内容が異なります",409);return{receipt:{...previous,replayed:true},result:await view()};}
    const rows=await sources();
    const receipt=await store.update(state=>{const previous=state.receipts.find(r=>r.id===command?.operationId);if(previous){if(previous.actor!==actor||previous.digest!==planningDigest(command))throw fail("同じ操作IDの内容が異なります",409);return{...previous,replayed:true};}return applyPlanningCommand(state,command,{actor,at:now(),sources:rows});},{expectedRevision});
    return{receipt,result:await view()};
  }
  async function operation(id,actor){const receipt=(await store.read()).receipts.find(r=>r.id===id&&r.actor===actor);if(!receipt)throw fail("この操作の保存はまだ確認できません",404);return receipt;}
  async function lookup(asin){
    if(typeof asin!=="string"||!/^[A-Z0-9]{10}$/.test(asin))throw fail("ASINを英数字10文字で入力してください",400);
    if(!readCatalog)throw fail("商品情報の自動取得は未接続です。ASINのまま登録できます",503);
    return readCatalog(asin);
  }
  return{view,commit,operation,lookup};
}
