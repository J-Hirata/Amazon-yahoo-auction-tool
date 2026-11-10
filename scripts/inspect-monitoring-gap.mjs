import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parse} from 'dotenv';
import {storageConfiguration} from '../src/storage-runtime.js';
import {Pool} from 'pg';
import {cloudAmazonConfig} from '../src/amazon-fba-reader.js';
import {readAmazonSales} from '../src/amazon-sales-reader.js';
import {applySalesResult} from '../src/sales-history.js';
import {fetchYahooListing} from '../src/yahoo-observation.js';

const privateDir=process.argv[2];if(!privateDir||!path.isAbsolute(privateDir))throw new Error('Supply the existing private settings directory');
for(const f of ['app-runtime.env','connections.env'])Object.assign(process.env,parse(await readFile(path.join(privateDir,f))));
assert.equal(process.env.ASIN_PUBLIC_ORIGIN,'https://amazon-yahoo-inventory.vercel.app');
const storage=storageConfiguration(),pool=new Pool(storage.poolOptions),folder='output/monitoring-gap-20261110';
try{
  await mkdir(folder,{recursive:true});
  const client=await pool.connect();let docs;
  try{await client.query('BEGIN READ ONLY');docs=(await client.query('SELECT document_key,payload,revision,updated_at,md5(payload::text) AS digest FROM app_storage.documents ORDER BY document_key')).rows;await client.query('COMMIT');}finally{client.release();}
  await writeFile(`${folder}/production-snapshot.json`,JSON.stringify(docs,null,2),{flag:'wx'});
  const monitor=docs.find(d=>d.document_key==='link-monitor').payload,watch=docs.find(d=>d.document_key==='product-watch').payload,config=cloudAmazonConfig(process.env);
  const targets=[...new Map(monitor.salesTracking.trackers.map(t=>[t.sellerSku,{sellerSku:t.sellerSku,asin:t.asin}])).values()];
  const after=monitor.salesTracking.checkedThrough,before=new Date(Date.now()-120000).toISOString();
  const live=await readAmazonSales({config,targets,after,before,maxPages:5,maxDurationMs:40000});
  await writeFile(`${folder}/live-orders.json`,JSON.stringify(live,null,2));
  const clone=structuredClone(monitor.salesTracking),events=applySalesResult(clone,live,new Date().toISOString());
  const ids=[...new Set(monitor.links.map(l=>l.listingId))],yahoo=[];
  for(let i=0;i<ids.length;i+=4)await Promise.all(ids.slice(i,i+4).map(async id=>{
    const previous=watch.observations.yahoo.find(y=>y.listingId===id);
    try{const next=await fetchYahooListing(`https://auctions.yahoo.co.jp/jp/auction/${id}`,{maxDurationMs:9000});yahoo.push({listingId:id,title:next.title,previous:previous&&{quantity:previous.quantity,status:previous.status,checkedAt:previous.checkedAt},current:{quantity:next.quantity??next.observation?.quantity??null,status:next.observation?.status,verified:next.observation?.verified,checkedAt:next.observation?.checkedAt}});}catch{yahoo.push({listingId:id,status:'fetch_failed'});}
  }));
  const afterDocs=(await pool.query('SELECT document_key,revision,md5(payload::text) AS digest FROM app_storage.documents ORDER BY document_key')).rows;
  const dbUnchanged=docs.every(d=>afterDocs.some(x=>x.document_key===d.document_key&&x.revision===d.revision&&x.digest===d.digest));
  assert.ok(dbUnchanged,'Concurrent DB edit; recheck preservation without overwriting user changes');
  const summary={at:new Date().toISOString(),readOnly:true,dbUnchanged,storedCheckedThrough:after,liveCheckedThrough:before,livePages:live.pages,newEvents:events.map(e=>({asin:e.asin,sellerSku:e.sellerSku,delta:e.delta,kind:e.kind,fulfillment:e.fulfillment,orderDate:e.eligibleFromAt})),yahoo,mailSent:false,marketplaceWrites:0};
  await writeFile(`${folder}/read-only-live-audit.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{await pool.end();}
