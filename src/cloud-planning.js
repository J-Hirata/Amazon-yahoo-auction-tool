import {applyPlanningCommand,planningDigest,planningSchedule} from "./sales-planning.js";
import {assessLink} from "./link-monitor.js";
import {stockImageUrl} from "./stock-images.js";
import {actionSchedules} from "./planning-actions.js";
import {conditionFamily} from './product-workspace.js';

const fail=(message,status)=>Object.assign(new Error(message),{status});
export function createCloudPlanning({store,stock,monitorStore,overview,readCatalog,now=()=>new Date().toISOString()}){
  async function sources(){
    const physical=await stock.view(),monitor=await monitorStore.read(),at=now(),liveRows=overview?(await overview.view()).rows:[];
    const rows=physical.products.map(p=>({kind:"stock",id:p.id,title:p.title,asin:p.asin,sellerSku:p.sellerSku,condition:p.condition,setContents:p.setContents,imageUrl:p.photo?.url||"",href:"/?view=stock#item="+encodeURIComponent('stock:'+p.id),locations:p.totals.locations,
      fba:p.fba,amazon:p.amazon,listingIds:p.linked.map(l=>l.listingId)}));
    for(const link of monitor.links){const a=assessLink(link,monitor,at),p=a.product,y=a.listing,age=Date.parse(at)-Date.parse(p?.checkedAt),fresh=Number.isFinite(age)&&age>=-60000&&age<=90*60000&&!p?.error&&a.inventory!=="unlinked";
      const live=liveRows.find(r=>r.linkIds.includes(link.id));
      rows.push({kind:"link",id:link.id,title:y?.title||p?.title||link.asin,asin:p?.asin||link.asin||"",sellerSku:link.amazonSellerSku||live?.availability.sku||p?.sellerSku||"",condition:conditionFamily(live?.fba.condition||p?.condition),setContents:p?.setContents||"",imageUrl:stockImageUrl(y?.imageUrl)||"",href:"/#item="+encodeURIComponent('link:'+link.id),locations:live?.locations||[],
        fba:live?.fba||{quantity:fresh&&typeof p?.fulfillableQuantity==="number"?p.fulfillableQuantity:null,label:fresh?"FBA取得分":"未確認・古い情報",checkedAt:p?.checkedAt||null},listingIds:live?.yahoo?.map(y=>y.listingId)||[link.listingId],yahooStatus:a.yahoo});
    }
    return rows;
  }
  async function view(){const saved=await store.readSnapshot(),rows=await sources(),at=now();return{revision:saved.revision,checkedAt:at,catalogRead:Boolean(readCatalog),sources:rows,events:saved.state.events.slice(-100).reverse(),plans:saved.state.plans.map(p=>{
    const source=rows.find(s=>s.kind===p.source.kind&&s.id===p.source.id),mismatch=source&&(source.asin!==p.asin||source.sellerSku&&p.sellerSku&&source.sellerSku!==p.sellerSku||source.condition!=="unknown"&&p.condition!=="unknown"&&source.condition!==p.condition||source.setContents&&p.setContents&&source.setContents!==p.setContents);
    return{...p,actionSchedules:actionSchedules(p,at),schedule:planningSchedule(p,at),reference:mismatch?null:source||null,referenceIssue:mismatch?"参照先の商品情報が変わっています":!source&&p.source.kind!=="manual"?"参照先が見つかりません":""};
  })};}
  async function commit(command,{expectedRevision,actor}){
    const previous=(await store.read()).receipts.find(r=>r.id===command?.operationId);
    if(previous){if(previous.actor!==actor||previous.digest!==planningDigest(command))throw fail("同じ操作IDの内容が異なります",409);return{receipt:{...previous,replayed:true},result:await view()};}
    const rows=await sources();
    if(overview&&command.kind==='create'&&command.plan?.status!=='closed'&&['stock','link'].includes(command.plan?.source?.kind)){
      const key=command.plan.source.kind+':'+command.plan.source.id,related=(await overview.view()).rows.find(r=>r.sourceKeys.includes(key));
      if(related?.plans.some(p=>p.status!=='closed'))throw fail('この商品の確認中の計画があります。既存の計画を編集してください',409);
    }
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
