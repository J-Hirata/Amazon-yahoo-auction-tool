import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {parse} from "dotenv";
import {createCloudRuntime} from "../src/cloud-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {validateMonitorState} from "../src/storage-validation.js";

for(const file of ["main-admin.env","app-runtime.env","connections.env"]){
  const values=parse(await readFile(new URL(`../data/cloud-private/${file}`,import.meta.url)));
  Object.assign(process.env,values);
}
let runtime;
try {
  runtime=await createCloudRuntime();
  assert.equal(runtime.config.origin,"https://amazon-yahoo-inventory.vercel.app");
  assert.equal((await runtime.pool.query("SELECT current_user AS name")).rows[0].name,"asin_inventory_app");
  const store=createPostgresDocumentStore({pool:runtime.pool,key:"link-monitor",validate:validateMonitorState}),before=await store.readSnapshot();
  const other=async()=>(await runtime.pool.query("SELECT document_key,md5(payload::text) AS digest FROM app_storage.documents WHERE document_key <> 'link-monitor' ORDER BY document_key")).rows;
  const otherBefore=await other();
  if(process.argv.includes("--repair-tracking")){
    await writeFile(new URL(`../data/cloud-private/sales-tracking-before-${Date.now()}.json`,import.meta.url),JSON.stringify(before),{flag:"wx",mode:0o600});
    await runtime.sales.start({expectedRevision:before.revision});
    for(let i=0;i<5;i++){
      await runtime.sales.check({catchUp:true});const current=(await store.read()).salesTracking;
      if(current.sync.status!=="complete" || Date.parse(current.checkedThrough)>=Date.now()-15*60000)break;
    }
  }
  const after=await store.readSnapshot(),state=after.state,t=state.salesTracking;
  assert.deepEqual(await other(),otherBefore);
  const core=s=>{const {salesTracking,salesTargets,logs,...rest}=s;return rest;};
  assert.deepEqual(core(state),core(before.state));
  const summary={checkedAt:new Date().toISOString(),mode:process.argv.includes("--repair-tracking")?"repair_tracking":"inspect",otherDocumentsUnchanged:true,stockAndSettingsUnchanged:true,
    linkedProducts:state.links.length,trackingStartedAt:t?.startedAt,checkedThrough:t?.checkedThrough,status:t?.sync?.status,error:t?.sync?.error,
    targets:new Set(t?.trackers?.map(t=>t.sellerSku)).size,unresolved:state.salesTargets?.unresolved || [],orders:t?.orders?.length,events:t?.events?.length,
    fulfillmentCounts:Object.fromEntries(["AMAZON","MERCHANT","UNKNOWN"].map(k=>[k,t?.orders?.filter(o=>o.fulfillment===k).length || 0])),
    products:[...new Set(t?.trackers?.map(t=>t.asin))].map(asin=>({asin,skus:[...new Set(t.trackers.filter(v=>v.asin===asin).map(v=>v.sellerSku))].length,
      confirmedQuantity:t.orders.filter(r=>r.asin===asin&&r.eligibleFromAt&&r.status!=="UNKNOWN").reduce((n,r)=>n+r.confirmedQuantity,0),
      unknownOrders:t.orders.filter(r=>r.asin===asin&&r.status==="UNKNOWN").length})),
    automationEnabled:Boolean(state.salesAutomation?.enabled),mailSentNow:false,marketplaceWrites:0};
  await writeFile(new URL("../output/sales-tracking-live-20261031.json",import.meta.url),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
}catch(error){console.error(JSON.stringify({failed:true,code:error.code || "CHECK_FAILED",message:String(error.message).startsWith("自社出品")||String(error.message).startsWith("Amazon")?error.message:"販売追跡の照合に失敗しました。秘密値は表示していません"}));process.exitCode=1;}
finally{await runtime?.pool.end();}
