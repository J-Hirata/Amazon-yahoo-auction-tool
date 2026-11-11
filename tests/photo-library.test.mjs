import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PROTOCOL,hash,normalizedContent,contentDigest,parsePackage,stableItemId,signedHeaders,verifyBridge,bridgeOrigin} from '../shared/photo-bridge.mjs';
import {emptyPhotoLibrary,validatePhotoLibrary,createPhotoLibrary} from '../src/photo-library.js';
import {createCloudHandler} from '../src/cloud-handler.js';
import {vercelCloudRequest} from '../src/vercel-entry.js';
const owner=randomUUID(),source='https://photos.example',target='https://inventory.example',key='1'.repeat(64),bytes=Buffer.from('private-jpeg-fixture');
function pack(changes={}){
 const asset={id:randomUUID(),name:'DSC_0001.JPG',position:1,sourceSha256:hash('original'),sha256:hash(bytes),previewSha256:hash(bytes),bytes:bytes.length,previewBytes:bytes.length,width:100,height:80,quality:'stored'};
 const content=normalizedContent({sourceWorkspaceId:owner,productId:randomUUID(),batchId:randomUUID(),projectName:'テスト',batchTitle:'撮影回',name:'同じASINの別個体',asin:'B001234567',sku:'',note:'電源なし',reviewNote:'要確認',mainAssetId:asset.id,assets:[asset],identifiers:[{assetId:asset.id,models:['AA-01'],jans:['0123456789012'],note:'写真で確認',confirmed:false,version:1}],...changes});
 return parsePackage({...content,packageId:randomUUID(),revision:1,createdAt:new Date().toISOString(),digest:contentDigest(content)});
}
function store(initial=emptyPhotoLibrary()){
 let state=structuredClone(initial),revision=0,writes=0;
 return {get writes(){return writes;},read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async(fn,{expectedRevision}={})=>{
  if(expectedRevision!==undefined&&expectedRevision!==revision)throw Object.assign(Error('競合'),{status:409});
  const next=structuredClone(state);await fn(next);state=next;revision++;writes++;
 }};
}
function fixture(fetchImpl=async()=>new Response(bytes,{headers:{'Content-Type':'image/jpeg'}})){
 const saved=store(),stocks=store({products:[{id:randomUUID(),title:'在庫1',asin:'B001234567',sellerSku:'sku-A',imageUrl:'https://m.media-amazon.com/a.jpg'},{id:randomUUID(),title:'在庫2',asin:'B001234567',sellerSku:'sku-B',imageUrl:''}],quantities:{home:4}});
 const lib=createPhotoLibrary({store:saved,stockStore:stocks,sourceOrigin:source,sourceWorkspaceId:owner,key,fetchImpl});
 return {saved,stocks,lib};
}
const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;
test('contract preserves photo order, source identity and JAN leading zero',()=>{
 const p=pack();assert.equal(p.identifiers[0].jans[0],'0123456789012');assert.equal(p.assets[0].position,1);assert.equal(parsePackage(reverse(p)).digest,p.digest);
 assert.throws(()=>parsePackage({...p,name:'other'}));assert.throws(()=>parsePackage({...p,mainAssetId:randomUUID()}));
 assert.throws(()=>parsePackage({...p,assets:[...p.assets,...p.assets]}));
});
test('HMAC binds method, origin, path, query, body and time',()=>{
 const url=target+'/api/photo-library/import',body='{"x":1}',at=Date.now(),headers=signedHeaders(key,'POST',url,body,at),r=new Request(url,{method:'POST',headers,body});
 assert.equal(verifyBridge(r,key,body,at),true);
 for(const [request,text,now] of [[new Request(url,{method:'GET',headers}),body,at],[new Request(source+'/api/photo-library/import',{method:'POST',headers}),body,at],[new Request(url+'?x=1',{method:'POST',headers}),body,at],[r,body+' ',at],[r,body,at+90001]])assert.equal(verifyBridge(request,key,text,now),false);
 assert.equal(verifyBridge(r,'2'.repeat(64),body,at),false);
 for(const url of ['https://photos.example/path','https://user@photos.example','http://photos.example','https://photos.example/?x=1'])assert.throws(()=>bridgeOrigin(url));
 assert.equal(bridgeOrigin('http://127.0.0.1:3111',true),'http://127.0.0.1:3111');
});
test('same ASIN remains two physical items, repeat receiving is idempotent after JSONB key ordering',async()=>{
 const f=fixture(),p=pack(),q=pack(),body={protocol:PROTOCOL,packages:[p,q]},receipt=await f.lib.receive(body);
 assert.notEqual(receipt.receipts[0].itemId,receipt.receipts[1].itemId);assert.equal(f.saved.writes,1);
 await f.saved.update(s=>{s.packages=s.packages.map(reverse);});const before=f.saved.writes;assert.deepEqual(await f.lib.receive(body),receipt);assert.equal(f.saved.writes,before);assert.equal((await f.lib.view()).items.length,2);
});
test('revisions preserve old membership without reassigning an existing link',async()=>{
 const f=fixture(),p=pack();await f.lib.receive({protocol:PROTOCOL,packages:[p]});let v=await f.lib.view();
 const command={operationId:randomUUID(),stockId:v.stocks[0].id,stockRevision:v.stockRevision,action:'attach',packageId:p.packageId,assetId:p.assets[0].id,useAsMain:false};
 const before=await f.stocks.read();v=await f.lib.link(command,{expectedRevision:v.revision,actor:'owner'});assert.deepEqual(await f.stocks.read(),before);assert.equal(f.stocks.writes,0);
 const newContent=normalizedContent({...p,name:'修正した商品名',note:'追記'}),p2=parsePackage({...newContent,packageId:randomUUID(),revision:2,createdAt:p.createdAt,digest:contentDigest(newContent)});
 await f.lib.receive({protocol:PROTOCOL,packages:[p2]});v=await f.lib.view();assert.equal(v.items.length,1);assert.equal(v.items[0].latest.packageId,p2.packageId);assert.equal(v.links[0].packageId,p.packageId);assert.equal(v.packages.length,2);
});
test('rejects wrong owner, malformed photo membership and conflicting immutable package id',async()=>{
 const f=fixture(),p=pack();await assert.rejects(()=>f.lib.receive({protocol:PROTOCOL,packages:[pack({sourceWorkspaceId:randomUUID()})]}),{status:403});
 await f.lib.receive({protocol:PROTOCOL,packages:[p]});const content=normalizedContent({...p,note:'changed'});
 await assert.rejects(()=>f.lib.receive({protocol:PROTOCOL,packages:[{...p,...content,digest:contentDigest(content)}]}),{status:409});
 const v=await f.lib.view();
 await assert.rejects(()=>f.lib.link({operationId:randomUUID(),stockId:v.stocks[0].id,stockRevision:0,action:'attach',packageId:p.packageId,assetId:randomUUID(),useAsMain:true},{expectedRevision:v.revision,actor:'owner'}),{status:400});
 assert.equal((await f.lib.view()).links.length,0);
});
test('link and unlink are explicit, revision protected, actor bound and idempotent',async()=>{
 const f=fixture(),p=pack();await f.lib.receive({protocol:PROTOCOL,packages:[p]});let v=await f.lib.view();
 const command={operationId:randomUUID(),stockId:v.stocks[0].id,stockRevision:0,action:'attach',packageId:p.packageId,assetId:p.assets[0].id,useAsMain:true};
 v=await f.lib.link(command,{expectedRevision:v.revision,actor:'owner'});const count=f.saved.writes;
 await f.stocks.update(s=>{s.products[0].title='変更後';});
 await f.lib.link(command,{expectedRevision:0,actor:'owner'});assert.equal(f.saved.writes,count);
 await assert.rejects(()=>f.lib.link(command,{expectedRevision:0,actor:'other'}),{status:409});
 await assert.rejects(()=>f.lib.link({...command,operationId:randomUUID()},{expectedRevision:v.revision,actor:'owner'}),{status:409});
 v=await f.lib.link({operationId:randomUUID(),stockId:command.stockId,stockRevision:1,action:'unlink'},{expectedRevision:v.revision,actor:'owner'});assert.equal(v.links.length,0);assert.equal(v.packages.length,1);
});
test('atomic link rechecks stock and library revisions without changing stock document',async()=>{
 const f=fixture(),p=pack();await f.lib.receive({protocol:PROTOCOL,packages:[p]});const v=await f.lib.view(),stockBefore=await f.stocks.read();
 const lib=createPhotoLibrary({store:f.saved,stockStore:f.stocks,sourceOrigin:source,sourceWorkspaceId:owner,key,linkTransaction:{update:async fn=>{const docs={'photo-library':await f.saved.readSnapshot(),'physical-stock':await f.stocks.readSnapshot()};docs['physical-stock'].revision++;await fn(docs);}}});
 await assert.rejects(()=>lib.link({operationId:randomUUID(),stockId:v.stocks[0].id,stockRevision:0,action:'attach',packageId:p.packageId,assetId:p.assets[0].id,useAsMain:true},{expectedRevision:v.revision,actor:'owner'}),{status:409});
 assert.deepEqual(await f.stocks.read(),stockBefore);assert.equal((await f.saved.read()).links.length,0);
});
test('image proxy signs exact received IDs and verifies bytes',async()=>{
 let request;
 const f=fixture(async(url,init)=>{request=new Request(url,init);return new Response(bytes,{headers:{'Content-Type':'image/jpeg'}});}),p=pack();await f.lib.receive({protocol:PROTOCOL,packages:[p]});
 const r=await f.lib.image(p.packageId,p.assets[0].id,'image');assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.equal(verifyBridge(request,key),true);assert.equal(r.headers.get('cache-control'),'private, no-store');
 await assert.rejects(()=>f.lib.image(p.packageId,randomUUID()),{status:404});
});
test('image corruption, oversize, revocation and upstream failure remain visible',async()=>{
 for(const response of [()=>new Response(Buffer.from('wrong'),{headers:{'Content-Type':'image/jpeg'}}),()=>new Response(Buffer.alloc(300),{headers:{'Content-Type':'image/jpeg'}}),()=>new Response(bytes,{headers:{'Content-Type':'text/html'}}),()=>new Response(null,{status:410}),()=>new Response(null,{status:500})]){
  const f=fixture(response),p=pack();await f.lib.receive({protocol:PROTOCOL,packages:[p]});await assert.rejects(()=>f.lib.image(p.packageId,p.assets[0].id));
 }
});
test('decorates only matching stock IDs and avoids ambiguous overview with multiple individuals',async()=>{
 const f=fixture(),p=pack();await f.lib.receive({protocol:PROTOCOL,packages:[p]});let v=await f.lib.view();
 for(const stock of v.stocks){v=await f.lib.link({operationId:randomUUID(),stockId:stock.id,stockRevision:0,action:'attach',packageId:p.packageId,assetId:p.assets[0].id,useAsMain:true},{expectedRevision:v.revision,actor:'owner'});}
 const before=await f.stocks.read(),stocks=await f.lib.decorateStock(before);assert.ok(stocks.products.every(p=>p.sharedPhoto));assert.equal(before.products[0].sharedPhoto,undefined);
 const overview=await f.lib.decorateOverview({rows:[{stockIds:[v.stocks[0].id]},{stockIds:v.stocks.map(s=>s.id)},{stockIds:[randomUUID()]}]});assert.ok(overview.rows[0].sharedPhoto);assert.equal(overview.rows[1].sharedPhoto,undefined);assert.equal(overview.rows[2].sharedPhoto,undefined);
 validatePhotoLibrary(await f.saved.read());
});
test('private HTTP boundary accepts only signed import and owner image/view/link',async()=>{
 const f=fixture(),p=pack(),config={origin:target,authUrl:'https://fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth',readOnly:false};
 const handler=createCloudHandler({config,photoLibrary:f.lib,photoBridgeKey:key,verifyOwner:async r=>({status:r.headers.get('authorization')==='Bearer owner'?200:401,userId:'owner'})});
 const path='/api/photo-library/import',body=JSON.stringify({protocol:PROTOCOL,packages:[p]}),headers=signedHeaders(key,'POST',target+path,body);
 assert.equal((await handler(new Request(target+path,{method:'POST',headers,body}))).status,200);
 assert.equal((await handler(new Request(target+path,{method:'POST',headers:{'Content-Type':'application/json'},body}))).status,401);
 assert.equal((await handler(new Request(target+'/api/photo-library'))).status,401);
 const auth={Authorization:'Bearer owner'};
 assert.equal((await handler(new Request(target+'/api/photo-library',{headers:auth}))).status,200);
 const linkBody=JSON.stringify({operationId:randomUUID(),stockId:(await f.stocks.read()).products[0].id,stockRevision:0,action:'attach',packageId:p.packageId,assetId:p.assets[0].id,useAsMain:true});
 assert.equal((await handler(new Request(target+'/api/photo-library/link',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:linkBody}))).status,428);
 const media='/api/photo-library/'+p.packageId+'/assets/'+p.assets[0].id+'/preview';
 assert.equal((await handler(new Request(target+media))).status,401);
 assert.equal((await handler(new Request(target+media,{headers:auth}))).status,200);
 assert.equal((await handler(new Request(target+'/api/photo-library',{headers:{...auth,Origin:source}}))).status,403);
 const rewritten=vercelCloudRequest(new Request(target+'/api/inventory?__route=photo-library/import',{method:'POST',headers,body}));
 assert.equal(verifyBridge(rewritten,key,body),true);
 const readonly=createCloudHandler({config:{...config,readOnly:true},photoLibrary:f.lib,photoBridgeKey:key,verifyOwner:async()=>({status:200,userId:'owner'})});
 assert.equal((await readonly(new Request(target+path,{method:'POST',headers,body}))).status,403);
});
