import assert from "node:assert/strict";
import {Pool} from "pg";
import {readFile,writeFile} from "node:fs/promises";
import {parse} from "dotenv";
import {randomUUID} from "node:crypto";
import {storageConfiguration} from "../src/storage-runtime.js";
import {emptyProductWatch,validateProductWatch,createProductOverview} from "../src/product-overview.js";
import {createProductMonitoring} from "../src/product-monitoring.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {validateMonitorState,validateDraftItems} from "../src/storage-validation.js";
import {validatePhysicalStock} from "../src/physical-stock.js";
import {validateSalesPlanning} from "../src/sales-planning.js";
import {cloudAmazonConfig} from "../src/amazon-fba-reader.js";
for(const file of ["main-admin.env","app-runtime.env","connections.env"])Object.assign(process.env,parse(await readFile(new URL(`../data/cloud-private/${file}`,import.meta.url))));
const key="product-watch",apply=process.argv.includes("--apply"),pool=new Pool(storageConfiguration().poolOptions);
try{
  assert.equal((await pool.query("SELECT current_user AS name")).rows[0].name,"asin_inventory_app");
  if(apply){
    const client=await pool.connect();try{
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const before=(await client.query("SELECT document_key,md5(payload::text) AS digest,revision FROM app_storage.documents WHERE document_key<>$1 ORDER BY document_key",[key])).rows;
      const present=await client.query("SELECT document_key FROM app_storage.documents WHERE document_key=$1",[key]);
      if(!present.rows.length)await client.query("INSERT INTO app_storage.documents(document_key,payload) VALUES($1,$2::jsonb) ON CONFLICT(document_key) DO NOTHING",[key,JSON.stringify(emptyProductWatch())]);
      assert.deepEqual((await client.query("SELECT document_key,md5(payload::text) AS digest,revision FROM app_storage.documents WHERE document_key<>$1 ORDER BY document_key",[key])).rows,before);await client.query("COMMIT");
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }
  const store=(key,validate)=>createPostgresDocumentStore({pool,key,validate}),watchStore=store(key,validateProductWatch),monitorStore=store("link-monitor",validateMonitorState),stockStore=store("physical-stock",validatePhysicalStock),planningStore=store("sales-planning",validateSalesPlanning);
  const overview=createProductOverview({watchStore,monitorStore,stockStore,planningStore,draftStore:store("draft-items",validateDraftItems)});
  if(apply){
    const snapshot=await watchStore.readSnapshot();await writeFile(new URL(`../data/cloud-private/product-watch-before-${Date.now()}.json`,import.meta.url),JSON.stringify(snapshot),{flag:"wx",mode:0o600});
    const input=await overview.inputs(),helmet=input.physical.products.find(p=>p.id==="0ff97942-8c3a-48aa-b62e-d463daf0ef50"&&p.asin==="B008U1FD7G"),spray=input.planning.plans.find(p=>p.asin==="B088T91SW4");
    const rules=[...(helmet?[{key:`stock:${helmet.id}`,tags:["watch"],replenishEnabled:true,threshold:10,minimumSales7:1,coverageDays:0,reviewDays:10,startedOn:"",note:"FBAが10個以下で直近販売があり、コンテナの補充用在庫がある場合に追加納品を検討。本人11/2依頼。"}]:[]),...(spray?[{key:`plan:${spray.id}`,tags:["watch","overstock"],replenishEnabled:false,threshold:10,minimumSales7:0,coverageDays:0,reviewDays:10,startedOn:"",note:"在庫過多。販売可能と確認した日から10日観察し、価格・広告・併売を検討。期限は既存計画を使用。"}]:[])];
    for(const rule of rules){const saved=await watchStore.readSnapshot();if(!saved.state.rules.some(r=>r.key===rule.key))await overview.commit({operationId:randomUUID(),rule},{expectedRevision:saved.revision,actor:"system:user-requested-product-monitoring"});}
  }
  let monitoring;
  if(process.argv.includes("--refresh-preview"))monitoring=await createProductMonitoring({overview,watchStore,config:cloudAmazonConfig()}).run({settings:{stockAlerts:true,yahooAlerts:true,reviewAlerts:true,errorAlerts:true}});
  const view=await overview.view(),watch=await watchStore.read();
  const summary={checkedAt:new Date().toISOString(),rows:view.rows.length,stockRows:view.rows.filter(r=>r.stockIds.length).length,planRows:view.rows.filter(r=>r.plans.length).length,watchRows:view.rows.filter(r=>r.tags.includes("watch")).length,monitoring,
    previewAlerts:(watch.pendingAlerts||[]).filter(a=>!a.queuedAt&&!a.dismissedAt).map(({id,category,title,message})=>({id,category,title,message})),
    physicalQuantitiesChanged:false,marketplaceWrites:0,emailsSent:0};
  await writeFile(new URL("../output/product-overview-preview-20261102.json",import.meta.url),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}catch(error){console.error(JSON.stringify({failed:true,code:error.code||"CHECK_FAILED",message:"全商品一覧の準備を確認してください。秘密値は表示していません"}));process.exitCode=1;}finally{await pool.end();}
