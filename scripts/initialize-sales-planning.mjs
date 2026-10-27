import assert from "node:assert/strict";
import {Pool} from "pg";
import {storageConfiguration} from "../src/storage-runtime.js";
import {emptySalesPlanning,validateSalesPlanning} from "../src/sales-planning.js";

const key="sales-planning",args=process.argv.slice(2);
if(!args.includes("--apply")){console.log(JSON.stringify({dryRun:true,document:key,operation:"insert empty document only if absent; no DDL, grants or updates to existing documents"}));}
else{
  if(!args.includes("--confirm-document=sales-planning"))throw new Error("保存先文書の明示確認が必要です");
  const config=storageConfiguration();if(config.backend!=="postgres"||!config.host)throw new Error("確認済み専用Neonへだけ初期化できます");
  const pool=new Pool(config.poolOptions),client=await pool.connect();
  try{
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const before=(await client.query("SELECT document_key,md5(payload::text) AS digest,revision FROM app_storage.documents WHERE document_key<>$1 ORDER BY document_key",[key])).rows;
    const inserted=await client.query("INSERT INTO app_storage.documents(document_key,payload) VALUES($1,$2::jsonb) ON CONFLICT(document_key) DO NOTHING RETURNING document_key",[key,JSON.stringify(emptySalesPlanning())]);
    validateSalesPlanning((await client.query("SELECT payload FROM app_storage.documents WHERE document_key=$1",[key])).rows[0].payload);
    assert.deepEqual((await client.query("SELECT document_key,md5(payload::text) AS digest,revision FROM app_storage.documents WHERE document_key<>$1 ORDER BY document_key",[key])).rows,before);
    await client.query("COMMIT");console.log(JSON.stringify({document:key,created:inserted.rowCount===1,otherDocumentsUnchanged:true,marketWrites:0,mailSent:0}));
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();await pool.end();}
}
