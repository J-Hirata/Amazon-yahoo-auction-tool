import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {storageConfiguration} from "../src/storage-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {createCloudPlanning} from "../src/cloud-planning.js";
import {emptySalesPlanning,validateSalesPlanning} from "../src/sales-planning.js";
import {emptyMonitor} from "../src/link-monitor.js";

const config=storageConfiguration();if(process.env.ASIN_RUN_DATABASE_TESTS!=="1"||config.backend!=="postgres"||config.environment!=="development")throw new Error("隔離した開発DBだけで販売計画試験を実行してください");
const pool=new Pool(config.poolOptions),key="test-planning-"+randomUUID(),actor="planning-database-fixture";
let checks=0;const pass=message=>{checks++;console.log("PASS "+message);};
const plan={title:"隔離DBの販売確認",asin:"B000PLAN01",sellerSku:"",condition:"used",setContents:"",source:{kind:"manual",id:""},kind:"amazon",status:"active",availableOn:"2026-10-01",availabilityNote:"対象SKUの販売可能を確認",adStartedOn:"",durationDays:14,reviewOn:"",decision:"undecided",note:"",salesMemo:""};
try{
  await pool.query("INSERT INTO app_storage.documents(document_key,payload) VALUES($1,$2::jsonb)",[key,JSON.stringify(emptySalesPlanning())]);
  const store=createPostgresDocumentStore({pool,key,validate:validateSalesPlanning}),options={stock:{view:async()=>({products:[]})},monitorStore:{read:async()=>emptyMonitor()},now:()=>"2026-10-27T03:00:00.000Z"};
  const service=createCloudPlanning({store,...options}),input={operationId:randomUUID(),planId:randomUUID(),kind:"create",plan};
  await service.commit(input,{expectedRevision:0,actor});assert.equal((await service.view()).plans[0].schedule.stage,"due");pass("real development DB stores the sales availability date and derives the correct review deadline");
  const edit=note=>({...input,operationId:randomUUID(),kind:"edit",plan:{...plan,note}});
  const race=await Promise.allSettled([service.commit(edit("判断A"),{expectedRevision:1,actor}),service.commit(edit("判断B"),{expectedRevision:1,actor})]);
  assert.equal(race.filter(r=>r.status==="fulfilled").length,1);assert.equal(race.find(r=>r.status==="rejected").reason.code,"STORAGE_CONFLICT");pass("concurrent reviews cannot overwrite a newer decision or both save a stale revision");
  const snapshot=await store.readSnapshot(),pending=edit("応答消失の試験");
  const lost=createCloudPlanning({...options,store:{...store,update:async(...args)=>{await store.update(...args);throw Object.assign(new Error("response lost"),{code:"STORAGE_COMMIT_UNKNOWN"});}}});
  await assert.rejects(lost.commit(pending,{expectedRevision:snapshot.revision,actor}),{code:"STORAGE_COMMIT_UNKNOWN"});
  assert.equal((await service.operation(pending.operationId,actor)).planId,input.planId);assert.equal((await service.commit(pending,{expectedRevision:snapshot.revision,actor})).receipt.replayed,true);assert.equal((await store.read()).plans.length,1);assert.equal((await store.read()).events.length,3);pass("accepted save with lost response reconciles and retries without duplicate plans or history");
  const before=await store.readSnapshot();await assert.rejects(service.commit({...edit("不正日付"),plan:{...plan,availableOn:"2026-02-30"}},{expectedRevision:before.revision,actor}));assert.deepEqual(await store.readSnapshot(),before);pass("invalid date rolls back the plan, receipt and history atomically");
  const independent=createPostgresDocumentStore({pool,key,validate:validateSalesPlanning});assert.deepEqual(await independent.readSnapshot(),before);pass("another connection restores identical plans and decision history");
  await assert.rejects(service.operation(pending.operationId,"other-owner"),error=>error.status===404);assert.deepEqual(await store.readSnapshot(),before);pass("operation receipts are owner-scoped and read-only");
  console.log(JSON.stringify({passed:checks,database:"real-development-neon",marketWrites:0,liveEmails:0}));
}finally{await pool.query("DELETE FROM app_storage.documents WHERE document_key=$1",[key]);await pool.end();}
