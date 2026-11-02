import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {parse} from "dotenv";
import {createCloudRuntime} from "../src/cloud-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {validateMonitorState} from "../src/storage-validation.js";
for(const file of ["main-admin.env","app-runtime.env","connections.env"])Object.assign(process.env,parse(await readFile(new URL(`../data/cloud-private/${file}`,import.meta.url))));
const runtime=await createCloudRuntime();
try{
  assert.equal(runtime.config.origin,"https://amazon-yahoo-inventory.vercel.app");
  const store=createPostgresDocumentStore({pool:runtime.pool,key:"link-monitor",validate:validateMonitorState}),before=await store.readSnapshot(),previous=before.state.salesAutomation;
  if(!previous?.enabled)throw new Error("日次確認が停止されています。現在の本人設定を保持します");
  if(!process.argv.includes("--apply-user-request")){console.log(JSON.stringify({current:previous,changes:{stockAlerts:true,yahooAlerts:true,reviewAlerts:true},emailSent:false}));}
  else{
    await writeFile(new URL(`../data/cloud-private/product-notifications-before-${Date.now()}.json`,import.meta.url),JSON.stringify(before),{flag:"wx",mode:0o600});
    await runtime.automation.settings({...previous,stockAlerts:previous.stockAlerts??true,yahooAlerts:previous.yahooAlerts??true,reviewAlerts:previous.reviewAlerts??true,expectedRevision:before.revision});
    const after=await store.read();const core=s=>{const {salesAutomation,...rest}=s;return rest;};assert.deepEqual(core(before.state),core(after));
    console.log(JSON.stringify({applied:true,settings:after.salesAutomation,otherMonitorFieldsUnchanged:true,emailSent:false}));
  }
}finally{await runtime.pool.end();}
