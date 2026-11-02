// Local, in-memory UI fixture. No credentials, database or marketplace requests.
import http from "node:http";
import {readFile} from "node:fs/promises";
import {Readable} from "node:stream";
import {randomUUID} from "node:crypto";
import {createCloudHandler} from "../src/cloud-handler.js";
import {createCloudPlanning} from "../src/cloud-planning.js";
import {emptySalesPlanning,validateSalesPlanning} from "../src/sales-planning.js";
import {emptyMonitor} from "../src/link-monitor.js";
import {loadCloudAssets} from "../src/cloud-runtime.js";

let state=emptySalesPlanning(),revision=0;
const store={read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision}={})=>{
  if(expectedRevision!==undefined&&expectedRevision!==revision)throw Object.assign(new Error("更新競合"),{code:"STORAGE_CONFLICT"});
  const copy=structuredClone(state),result=await fn(copy);validateSalesPlanning(copy);state=copy;revision++;return result;
}};
let sourceAsin="B000PICK01";
const sourceId=randomUUID(),stock={view:async()=>({products:[{id:sourceId,title:"写真で選ぶ練習用モニター",asin:sourceAsin,sellerSku:"",condition:"used",setContents:"スタンドなし",photo:{url:""},totals:{locations:[]},fba:{quantity:null},linked:[]}]})};
const monitorStore={read:async()=>emptyMonitor()};
const planning=createCloudPlanning({store,stock,monitorStore,readCatalog:async asin=>{
  await new Promise(r=>setTimeout(r,asin==="B000SLOW01"?1000:100));
  if(asin==="B000FAIL00")throw Object.assign(new Error("商品情報を取得できません"),{status:502});
  return{asin,title:`自動取得した試験商品 ${asin}`,imageUrl:"https://m.media-amazon.com/images/I/planning-fixture.jpg"};
}});
const view=await readFile(new URL("../dist/cloud/cloud-planning-view.html",import.meta.url),"utf8");
const assets=await loadCloudAssets();
const page=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/sales-planning.css"><title>販売計画・隔離テスト</title>${view}<script type="module">import{openPlanning}from'/sales-planning.js';await openPlanning({userId:'local-fixture',readOnly:false});</script></html>`;
let handler,base;
const server=http.createServer(async(req,res)=>{try{
  if(req.url==="/__fixture/correct-source"&&req.method==="POST"){sourceAsin="B000PICK02";res.end("ok");return;}
  if(req.url==="/__fixture/state"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({state,revision,sourceId}));return;}
  if(req.url.startsWith("/?view=planning")||req.url==="/"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end(page);return;}
  const response=await handler(new Request(new URL(req.url,base),{method:req.method,headers:req.headers,...(["GET","HEAD"].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:"half"})}));
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch{res.writeHead(500);res.end();}});
server.listen(0,"127.0.0.1",()=>{base=`http://127.0.0.1:${server.address().port}`;handler=createCloudHandler({config:{origin:base,authUrl:"https://fixture.invalid",readOnly:false},store:monitorStore,planning,assets,verifyOwner:async()=>({status:200,userId:"fixture-owner"})});console.log(JSON.stringify({url:base,sourceId}));});
