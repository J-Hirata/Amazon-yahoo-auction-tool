import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {Pool} from "pg";
import {storageConfiguration} from "../src/storage-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {validatePhysicalStock} from "../src/physical-stock.js";
import {createStockPhotoRefresh} from "../src/cloud-stock-photos.js";
import {cloudAmazonConfig} from "../src/amazon-fba-reader.js";

const config=storageConfiguration();
if(config.backend!=="postgres" || !["production","development"].includes(config.environment))throw new Error("専用の接続設定を確認してください");
const pool=new Pool(config.poolOptions);
try {
  assert.equal((await pool.query("SELECT current_user AS name")).rows[0].name,"asin_inventory_app");
  const store=createPostgresDocumentStore({pool,key:"physical-stock",validate:validatePhysicalStock}),before=await store.readSnapshot();
  const other=async()=> (await pool.query("SELECT document_key,md5(payload::text) AS digest FROM app_storage.documents WHERE document_key <> 'physical-stock' ORDER BY document_key")).rows;
  const otherBefore=await other();
  if(!process.argv.includes("--apply"))console.log(JSON.stringify({mode:"dry-run",products:before.state.products.length,targetAsins:[...new Set(before.state.products.filter(p=>p.asin&&!p.imageUrl).map(p=>p.asin))].length}));
  else {
    const name="stock-photo-backup-"+new Date().toISOString().replace(/[:.]/g,"-")+".json";
    await writeFile(new URL("../data/cloud-private/"+name,import.meta.url),JSON.stringify(before),{flag:"wx"});
    const result=await createStockPhotoRefresh({store,config:cloudAmazonConfig()})({expectedRevision:before.revision,actor:"system:catalog-photos"});
    const after=await store.readSnapshot();
    const nonPhoto=p=>{const {imageUrl,imageSource,updatedAt,...rest}=p;return rest;};
    assert.deepEqual(after.state.products.map(nonPhoto),before.state.products.map(nonPhoto));
    assert.deepEqual(after.state.balances,before.state.balances);assert.deepEqual(after.state.transfers,before.state.transfers);
    assert.deepEqual(after.state.events.slice(0,before.state.events.length),before.state.events);assert.deepEqual(await other(),otherBefore);
    console.log(JSON.stringify({mode:"applied",...result,products:after.state.products.length,quantitiesUnchanged:true,otherMetadataUnchanged:true,otherDocumentsUnchanged:true,backupSaved:true,marketplaceWrites:0,liveEmails:0}));
  }
}catch {console.error("商品画像の確認に失敗しました。秘密値は表示していません。保存済み画像と数量を確認してください");process.exitCode=1;}
finally {await pool.end();}
