import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {Pool} from "pg";
import {storageConfiguration} from "../src/storage-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {validatePhysicalStock} from "../src/physical-stock.js";
import {validateMonitorState} from "../src/storage-validation.js";
import {createStockAmazonRefresh,stockAmazonView} from "../src/stock-amazon-listings.js";
import {cloudAmazonConfig} from "../src/amazon-fba-reader.js";
const config=storageConfiguration();
if(config.backend!=="postgres" || !["production","development"].includes(config.environment))throw new Error("専用DBの接続先を確認してください");
const pool=new Pool(config.poolOptions);
try{
  assert.equal((await pool.query("SELECT current_user AS name")).rows[0].name,"asin_inventory_app");
  const store=createPostgresDocumentStore({pool,key:"physical-stock",validate:validatePhysicalStock});
  const monitorStore=createPostgresDocumentStore({pool,key:"link-monitor",validate:validateMonitorState});
  const before=await store.readSnapshot(),other=async()=>(await pool.query("SELECT document_key,md5(payload::text) AS digest FROM app_storage.documents WHERE document_key <> 'physical-stock' ORDER BY document_key")).rows;
  const otherBefore=await other();
  if(!process.argv.includes("--apply"))console.log(JSON.stringify({mode:"dry-run",products:before.state.products.length,asins:[...new Set(before.state.products.map(p=>p.asin).filter(Boolean))].length}));
  else{
    await writeFile(new URL("../data/cloud-private/stock-amazon-backup-"+new Date().toISOString().replace(/[:.]/g,"-")+".json",import.meta.url),JSON.stringify(before),{flag:"wx"});
    const result=await createStockAmazonRefresh({store,monitorStore,config:cloudAmazonConfig()})({expectedRevision:before.revision,actor:"system:own-amazon-listings"});
    const after=await store.readSnapshot(),core=state=>{const {amazonListings,...rest}=state;return rest;};
    assert.deepEqual(core(after.state),core(before.state));assert.deepEqual(await other(),otherBefore);
    const account=await monitorStore.read();
    console.log(JSON.stringify({mode:"applied",...result,products:after.state.products.map(p=>{const v=stockAmazonView(p,after.state.amazonListings,new Date().toISOString(),account);return{asin:p.asin,registration:p.condition,status:v.status,offers:v.offers.map(o=>({condition:o.conditionLabel,shipping:o.shippingLabel,buyable:o.buyable}))};}),coreUnchanged:true,otherDocumentsUnchanged:true,marketplaceWrites:0,liveEmails:0}));
    if(result.status!=="complete")process.exitCode=1;
  }
}catch{console.error("自社出品の確認に失敗しました。秘密値は表示していません。数量は変更しません。");process.exitCode=1;}
finally{await pool.end();}
