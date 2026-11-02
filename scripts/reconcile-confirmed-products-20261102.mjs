import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {parse} from "dotenv";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {storageConfiguration} from "../src/storage-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {validateMonitorState} from "../src/storage-validation.js";
import {validatePhysicalStock} from "../src/physical-stock.js";
import {validateSalesPlanning,planningSchedule} from "../src/sales-planning.js";
import {createCloudStock} from "../src/cloud-stock.js";
import {createCloudPlanning} from "../src/cloud-planning.js";
import {cloudAmazonConfig} from "../src/amazon-fba-reader.js";
import {readPlanningCatalog} from "../src/planning-catalog.js";

if(!process.argv.includes("--apply-confirmed-correction"))throw new Error("11/2の本人確認に基づく訂正だけを実行します");
for(const f of ["main-admin.env","app-runtime.env","connections.env"])Object.assign(process.env,parse(await readFile(new URL(`../data/cloud-private/${f}`,import.meta.url))));
const evidence=JSON.parse(await readFile(new URL("../output/amazon-stock-confirmation-20261102.json",import.meta.url)));
assert.ok(Date.now()-Date.parse(evidence.checkedAt)<3600000);
const helmet=evidence.listings.rows.find(r=>r.asin==="B008U1FD7G"),spray=evidence.listings.rows.find(r=>r.asin==="B088T91SW4");
assert.equal(helmet.sellerSku,"20261009B008U1FD7G");assert.equal(helmet.condition,"used_very_good");assert.ok(spray.statuses.includes("BUYABLE"));
const pool=new Pool(storageConfiguration().poolOptions),at=new Date().toISOString(),actor="system:user-confirmed-20261102";
try{
  assert.equal((await pool.query("SELECT current_user AS name")).rows[0].name,"asin_inventory_app");
  const monitorStore=createPostgresDocumentStore({pool,key:"link-monitor",validate:validateMonitorState}),store=createPostgresDocumentStore({pool,key:"physical-stock",validate:validatePhysicalStock}),planStore=createPostgresDocumentStore({pool,key:"sales-planning",validate:validateSalesPlanning});
  const before=await store.readSnapshot(),plansBefore=await planStore.readSnapshot();
  await writeFile(new URL(`../data/cloud-private/confirmed-products-before-${Date.now()}.json`,import.meta.url),JSON.stringify({stock:before,planning:plansBefore}),{flag:"wx",mode:0o600});
  const stock=createCloudStock({store,monitorStore}),planning=createCloudPlanning({store:planStore,stock,monitorStore});
  const p=before.state.products.find(p=>p.id==="0ff97942-8c3a-48aa-b62e-d463daf0ef50");assert.ok(["B00UA1AFFO","B008U1FD7G"].includes(p.asin));
  const catalog=await readPlanningCatalog({asin:helmet.asin,config:cloudAmazonConfig()});
  if(p.asin!==helmet.asin)await stock.commit({operationId:randomUUID(),kind:"edit",productId:p.id,product:{...p,asin:helmet.asin,sellerSku:helmet.sellerSku,imageUrl:catalog.imageUrl||"",imageSource:catalog.imageUrl?"amazon_catalog":"manual",
    memo:p.memo+"\n11/2本人確認：自己発送販売は未開始。FBA補充用。コンテナ約50個、FBA販売可能20個。FBA10個以下で補充検討の通知を希望（通知は未実装）。"}},{expectedRevision:before.revision,actor,confirmed:true});
  let plans=await planStore.readSnapshot();const hp=plans.state.plans.find(v=>v.source.kind==="stock"&&v.source.id===p.id&&v.id==="e1dd3882-c51a-4c31-927d-535c5e8a9a87");assert.ok(hp);
  if(hp.asin!==helmet.asin)await planning.commit({operationId:randomUUID(),kind:"reconcile_source",planId:hp.id,expectedAsin:hp.asin,confirmed:true,reason:"本人添付の自社FBA出品と自社API照合でASINの誤登録を訂正。同じ現物商品の参照を維持"},{expectedRevision:plans.revision,actor});
  plans=await planStore.readSnapshot();const sp=plans.state.plans.find(p=>p.asin===spray.asin);
  if(sp.availableOn!=="2026-11-02"||sp.durationDays!==10)await planning.commit({operationId:randomUUID(),kind:"edit",planId:sp.id,plan:{...sp,availableOn:"2026-11-02",durationDays:10,
    availabilityNote:"11/2に本人申告と自社ListingsのBUYABLE応答で販売可能を確認。販売開始の初日は不明。FBA即出荷可能0・予約95も別に確認。",
    decisions:[...new Set([...(sp.decisions||[sp.decision]),"amazon","price"])],
    salesMemo:sp.salesMemo+"\n11/2確認から10日観察。11/12に売れ行き・値下げ・広告を検討。初日からの広告も検討中、実配信は未確認。"}},{expectedRevision:plans.revision,actor});
  const after=await store.read(),plansAfter=await planStore.read();assert.deepEqual(after.balances,before.state.balances);assert.deepEqual(after.transfers,before.state.transfers);assert.equal(after.products.length,before.state.products.length);assert.equal(plansAfter.plans.length,plansBefore.state.plans.length);
  const report={checkedAt:at,helmet:{asin:after.products.find(v=>v.id===p.id).asin,quantityChanged:false},spray:{asin:sp.asin,...planningSchedule(plansAfter.plans.find(v=>v.id===sp.id),at)},stockCount:after.products.length,planCount:plansAfter.plans.length,adsChanged:false,marketplaceWrites:0,emailsSent:0};
  await writeFile(new URL("../output/confirmed-products-reconciliation-20261102.json",import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await pool.end();}
