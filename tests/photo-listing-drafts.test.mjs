import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PROTOCOL,normalizedContent,parsePackage,contentDigest,hash} from '../shared/photo-bridge.mjs';
import {createPhotoLibrary,emptyPhotoLibrary,validatePhotoLibrary} from '../src/photo-library.js';
import {createCloudHandler} from '../src/cloud-handler.js';
import {photoDraftZip,photoDraftText} from '../public/photo-draft-zip.js';
const key='1'.repeat(64),source='https://photos.example',target='https://inventory.example',owner=randomUUID();
function packet(changes={}){
 const assets=Array.from({length:3},(_,i)=>({id:randomUUID(),name:'DSC_000'+i+'.JPG',position:i+1,sourceSha256:hash('original'+i),sha256:hash('image'+i),bytes:8,width:200,height:200,previewSha256:hash('preview'+i),previewBytes:9,quality:'stored'}));
 const content=normalizedContent({sourceWorkspaceId:owner,productId:randomUUID(),batchId:randomUUID(),projectName:'撮影プロジェクト',batchTitle:'取込回',name:'商品',asin:'B001234567',sku:'',note:'電源なし',reviewNote:'型番未確認',assets,mainAssetId:assets[1].id,identifiers:[],...changes});
 return parsePackage({...content,packageId:randomUUID(),revision:1,digest:contentDigest(content),createdAt:new Date().toISOString()});
}
function store(state){
 let data=structuredClone(state),revision=0;
 return {read:async()=>structuredClone(data),readSnapshot:async()=>({state:structuredClone(data),revision}),update:async(fn,options={})=>{
  if(options.expectedRevision!==undefined&&revision!==options.expectedRevision)throw Object.assign(Error('競合'),{status:409});const copy=structuredClone(data);await fn(copy);data=copy;revision++;
 }};
}
function fixture(){const s=store(emptyPhotoLibrary()),stocks=store({products:[]}),lib=createPhotoLibrary({store:s,stockStore:stocks,sourceOrigin:source,sourceWorkspaceId:owner,key});return {s,stocks,lib,drafts:lib.listingDrafts};}
function command(p,changes={}){return {operationId:randomUUID(),action:'save',packageId:p.packageId,version:0,values:{title:'中古の現物',description:'傷あり。写真のものです。',note:'確認用メモ',price:3000,assetIds:[p.assets[1].id,p.assets[2].id]},...changes};}
test('old library payload remains valid and byte-for-byte unchanged on viewing the draft workspace',async()=>{
 const f=fixture(),before=await f.s.read();await f.drafts.view();assert.deepEqual(await f.s.read(),before);validatePhotoLibrary(before);assert.equal(before.listingDrafts,undefined);
});
test('ASIN-less photo draft preserves selected main/order, source identity and internal memo',async()=>{
 const f=fixture(),p=packet({asin:null});await f.lib.receive({protocol:PROTOCOL,packages:[p]});const before=await f.s.read(),stocks=await f.stocks.read(),rev=(await f.s.readSnapshot()).revision;
 const result=await f.drafts.save(command(p),{expectedRevision:rev,actor:'owner'}),d=result.items[0];
 assert.equal(d.asin,'');assert.equal(d.channel,'yahoo');assert.equal(d.ready,true);assert.deepEqual(d.assetIds,[p.assets[1].id,p.assets[2].id]);assert.equal(d.note,'確認用メモ');assert.equal(d.packageId,p.packageId);
 assert.deepEqual((await f.s.read()).packages,before.packages);assert.deepEqual((await f.s.read()).links,before.links);assert.deepEqual((await f.s.read()).operations,before.operations);assert.deepEqual(await f.stocks.read(),stocks);
 const exported=await f.drafts.exportData(d.id,d.version);assert.match(exported.text,/傷あり/);assert.doesNotMatch(exported.text,/確認用メモ/);assert.equal(exported.note,'確認用メモ');assert.deepEqual(exported.photos.map(p=>p.id),d.assetIds);
});
test('same ASIN and name stay separate physical drafts; repeated save is idempotent and actor bound',async()=>{
 const f=fixture(),p=packet(),q=packet();await f.lib.receive({protocol:PROTOCOL,packages:[p,q]});const rev=(await f.s.readSnapshot()).revision,c=command(p),a=await f.drafts.save(c,{expectedRevision:rev,actor:'owner'});
 const retry=await f.drafts.save(c,{expectedRevision:rev,actor:'owner'});assert.equal(retry.items.length,1);assert.equal(retry.items[0].version,1);
 await assert.rejects(()=>f.drafts.save(c,{expectedRevision:rev,actor:'other'}),{status:409});
 const b=await f.drafts.save(command(q),{expectedRevision:retry.revision,actor:'owner'});assert.equal(b.items.length,2);assert.notEqual(b.items[0].id,b.items[1].id);assert.equal(new Set(b.items.map(i=>i.asin)).size,1);
});
test('stale edits and unsupported prices/photos fail without changing saved input',async()=>{
 const f=fixture(),p=packet();await f.lib.receive({protocol:PROTOCOL,packages:[p]});const v=await f.drafts.save(command(p),{expectedRevision:1,actor:'owner'}),before=await f.s.read();
 await assert.rejects(()=>f.drafts.save(command(p),{expectedRevision:v.revision,actor:'owner'}),{status:409});
 for(const values of [{title:''},{price:-1},{price:1.5},{price:'100'},{assetIds:[]},{assetIds:[randomUUID()]},{assetIds:[p.assets[0].id,p.assets[0].id]},{description:'x'.repeat(20001)}]){
  const c=command(p,{version:1});Object.assign(c.values,values);await assert.rejects(()=>f.drafts.save(c,{expectedRevision:v.revision,actor:'owner'}));
 }
 assert.deepEqual(await f.s.read(),before);
});
test('changed source package does not silently change an existing draft, explicit versioned save does',async()=>{
 const f=fixture(),p=packet();await f.lib.receive({protocol:PROTOCOL,packages:[p]});let v=await f.drafts.save(command(p),{expectedRevision:1,actor:'owner'});
 const p2=packet({productId:p.productId,batchId:p.batchId});p2.revision=2;await f.lib.receive({protocol:PROTOCOL,packages:[p2]});
 v=await f.drafts.view();assert.equal(v.items[0].packageId,p.packageId);const next=await f.drafts.save(command(p2,{version:1}),{expectedRevision:v.revision,actor:'owner'});assert.equal(next.items.length,1);assert.equal(next.items[0].packageId,p2.packageId);assert.equal(next.items[0].version,2);
 await assert.rejects(()=>f.drafts.exportData(next.id,1),{status:409});
});
test('partial draft, archive and restore retain all source photos and saved content',async()=>{
 const f=fixture(),p=packet();await f.lib.receive({protocol:PROTOCOL,packages:[p]});const c=command(p);c.values.price=null;c.values.description='';
 let v=await f.drafts.save(c,{expectedRevision:1,actor:'owner'});assert.equal(v.items[0].ready,false);const original=v.items[0];
 v=await f.drafts.save({operationId:randomUUID(),action:'archive',packageId:p.packageId,version:1},{expectedRevision:v.revision,actor:'owner'});assert.equal(v.items[0].archived,true);
 v=await f.drafts.save({operationId:randomUUID(),action:'restore',packageId:p.packageId,version:2},{expectedRevision:v.revision,actor:'owner'});assert.equal(v.items[0].archived,false);assert.deepEqual(v.items[0].assetIds,original.assetIds);assert.equal(v.items[0].description,original.description);assert.equal((await f.s.read()).packages[0].assets.length,3);
});
test('duplicate content is not exported twice and cross-product package corruption is rejected',async()=>{
 const f=fixture(),p=packet(),same={...p.assets[2],sha256:p.assets[1].sha256};p.assets[2]=same;p.digest=contentDigest(p);await f.lib.receive({protocol:PROTOCOL,packages:[p]});
 await assert.rejects(()=>f.drafts.save(command(p),{expectedRevision:1,actor:'owner'}),{status:400});
 const q=packet();await f.lib.receive({protocol:PROTOCOL,packages:[q]});const v=await f.drafts.save(command(q),{expectedRevision:2,actor:'owner'}),state=await f.s.read();state.listingDrafts[0].packageId=p.packageId;assert.throws(()=>validatePhotoLibrary(state));assert.equal(v.items[0].history[0].packageId,q.packageId);
});
test('draft APIs preserve owner/Origin/readonly/JSON/revision guards and legacy root links',async()=>{
 const f=fixture(),p=packet();await f.lib.receive({protocol:PROTOCOL,packages:[p]});
 const config={origin:target,authUrl:'https://fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth',readOnly:false},assets=new Map([['/',{body:'workspace',type:'text/html'}]]),verifyOwner=async r=>({status:r.headers.get('authorization')==='Bearer owner'?200:401,userId:'owner'});
 const handler=createCloudHandler({config,photoLibrary:f.lib,verifyOwner,assets}),headers={Authorization:'Bearer owner','Content-Type':'application/json','If-Match':'"1"'},body=JSON.stringify(command(p));
 assert.equal((await handler(new Request(target+'/api/photo-listing-drafts'))).status,401);
 assert.equal((await handler(new Request(target+'/api/photo-listing-drafts',{method:'POST',headers:{...headers,Origin:source},body}))).status,403);
 assert.equal((await handler(new Request(target+'/api/photo-listing-drafts',{method:'POST',headers:{...headers,'If-Match':''},body}))).status,428);
 assert.equal((await handler(new Request(target+'/api/photo-listing-drafts',{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body}))).status,415);
 const readonly=createCloudHandler({config:{...config,readOnly:true},photoLibrary:f.lib,verifyOwner});assert.equal((await readonly(new Request(target+'/api/photo-listing-drafts',{method:'POST',headers,body}))).status,403);
 const saved=await handler(new Request(target+'/api/photo-listing-drafts',{method:'POST',headers,body}));assert.equal(saved.status,200);
 const d=(await saved.json()).items[0],auth={Authorization:'Bearer owner'};
 assert.equal((await handler(new Request(target+'/api/photo-listing-drafts/'+d.id+'/export/1',{headers:auth}))).status,200);
 for(const url of ['/?view=drafts&section=photos','/?section=photos&view=drafts','/?view=photos'])assert.equal((await handler(new Request(target+url))).status,200);
 assert.equal((await handler(new Request(target+'/?view=drafts&section=photos&extra=x'))).status,404);
});
test('ZIP preserves literal UTF-8 text, blocks unsafe paths and bounds retained photos',async()=>{
 const bytes=photoDraftText('JAN: 0123456789012\r\n商品名'),b=photoDraftZip([['出品下書き.txt',bytes],['01.jpg',Uint8Array.of(1,2,3)]]);
 assert.equal(b.type,'application/zip');const data=new Uint8Array(await b.arrayBuffer());assert.equal(new DataView(data.buffer).getUint32(0,true),0x04034b50);assert.match(new TextDecoder().decode(data),/0123456789012/);
 assert.throws(()=>photoDraftZip([['../x',bytes]]));assert.throws(()=>photoDraftZip([['x',new Uint8Array(5000001)]]));
});
