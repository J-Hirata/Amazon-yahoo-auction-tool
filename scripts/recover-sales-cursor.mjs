import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parse} from 'dotenv';
import {databasePool} from '../src/storage-runtime.js';
import {createPostgresDocumentStore} from '../src/postgres-document-store.js';
import {validateMonitorState} from '../src/storage-validation.js';
import {cloudAmazonConfig} from '../src/amazon-fba-reader.js';
import {createCloudSales} from '../src/cloud-sales.js';
import {catchUpSales} from '../src/sales-catchup.js';

// Observation recovery only: this file has no mail transport or marketplace writer.
const privateDir=process.argv[2];assert.ok(privateDir&&path.isAbsolute(privateDir));
assert.equal(process.argv[3],'--repair-observations');
for(const f of ['app-runtime.env','connections.env'])Object.assign(process.env,parse(await readFile(path.join(privateDir,f))));
assert.equal(process.env.ASIN_PUBLIC_ORIGIN,'https://amazon-yahoo-inventory.vercel.app');
const pool=databasePool(),store=createPostgresDocumentStore({pool,key:'link-monitor',validate:validateMonitorState}),folder='output/monitoring-gap-20261110';
const rest=s=>{const {salesTracking,logs,...core}=s;return core;};
try{
  await mkdir(folder,{recursive:true});const before=await store.readSnapshot();
  const job=before.state.salesAutomationJob;assert.ok(job?.status!=='running'||Date.parse(job.leaseUntil)<=Date.now(),'An automatic run is active');
  await writeFile(`${folder}/sales-recovery-before.json`,JSON.stringify(before,null,2),{flag:'wx'});
  const others=async()=>(await pool.query("SELECT document_key,revision,md5(payload::text) AS digest FROM app_storage.documents WHERE document_key<>'link-monitor' ORDER BY document_key")).rows;
  const otherBefore=await others(),config=cloudAmazonConfig(process.env);
  const sales=createCloudSales({store,config}),progress=await catchUpSales({sales,readState:()=>store.read(),now:()=>new Date().toISOString()});
  assert.equal(progress.status,'complete');const after=await store.readSnapshot();assert.deepEqual(rest(after.state),rest(before.state));assert.deepEqual(await others(),otherBefore);
  const oldEvents=new Set(before.state.salesTracking.events.map(e=>e.id)),fresh=after.state.salesTracking.events.filter(e=>!oldEvents.has(e.id));
  assert.ok(fresh.every(e=>e.delivery==='preview'));assert.deepEqual(after.state.mailOutbox,before.state.mailOutbox);
  await writeFile(`${folder}/sales-recovery-after.json`,JSON.stringify(after,null,2));
  const result={at:new Date().toISOString(),progress,previousCheckedThrough:before.state.salesTracking.checkedThrough,checkedThrough:after.state.salesTracking.checkedThrough,
    oldOrderCount:before.state.salesTracking.orders.length,orderCount:after.state.salesTracking.orders.length,newEvents:fresh.map(e=>({asin:e.asin,sellerSku:e.sellerSku,delta:e.delta,kind:e.kind,fulfillment:e.fulfillment,orderDate:e.eligibleFromAt,delivery:e.delivery})),
    oldOrdersRetained:before.state.salesTracking.orders.every(o=>after.state.salesTracking.orders.some(n=>n.orderId===o.orderId&&n.itemId===o.itemId)),otherDocumentsUnchanged:true,settingsLinksAndMailUnchanged:true,mailSent:false,marketplaceWrites:0};
  await writeFile(`${folder}/sales-recovery.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await pool.end();}
