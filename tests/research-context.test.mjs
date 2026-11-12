import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizedContent,contentDigest,parsePackage,hash} from '../shared/photo-bridge.mjs';
import {parseResearchContext,validateResearchContexts} from '../shared/research-context.mjs';
import {emptyPhotoLibrary,createPhotoLibrary,validatePhotoLibrary} from '../src/photo-library.js';
function pack(workspace,product=randomUUID()){
 const asset={id:randomUUID(),name:'own.jpg',position:1,sourceSha256:hash('original'),sha256:hash('stored'),previewSha256:hash('preview'),bytes:6,previewBytes:7,width:100,height:80,quality:'stored'};
 const c=normalizedContent({sourceWorkspaceId:workspace,productId:product,batchId:randomUUID(),projectName:'project',batchTitle:'batch',name:'個体',asin:'B001234567',sku:'',note:'',reviewNote:'',mainAssetId:asset.id,assets:[asset],identifiers:[]});
 return parsePackage({...c,packageId:randomUUID(),revision:1,createdAt:new Date().toISOString(),digest:contentDigest(c)});
}
function memory(){
 let state=emptyPhotoLibrary(),revision=0;
 return {read:async()=>structuredClone(state),readSnapshot:async()=>({state:structuredClone(state),revision}),update:async fn=>{const next=structuredClone(state);await fn(next);validatePhotoLibrary(next);state=next;revision++;}};
}
function context(p){return {protocol:'research-context/v1',id:randomUUID(),sourceWorkspaceId:p.sourceWorkspaceId,productId:p.productId,packageId:p.packageId,packageDigest:p.digest,resultDigest:hash('result'),recordVersion:2,createdAt:new Date().toISOString(),input:{name:p.name,jan:'0123456789012',condition:'自分の現物の傷',accessories:'自分の付属品',operation:'untested'},decision:{channel:'yahoo',candidateAsin:'B001234567',candidateConfirmed:true,price:1000,references:[{url:'https://page.auctions.yahoo.co.jp/jp/auction/x123',relation:'similar',difference:'参考品は美品だが自分は傷あり'}]}};}
test('context cannot swap two physical items sharing one ASIN and retry is immutable/idempotent',async()=>{
 const workspace=randomUUID(),store=memory(),stocks={readSnapshot:async()=>({state:{products:[]},revision:0})};
 const lib=createPhotoLibrary({store,stockStore:stocks,sourceOrigin:'https://photos.example',sourceWorkspaceId:workspace,key:'a'.repeat(64)}),a=pack(workspace),b=pack(workspace);
 await lib.receive({protocol:'photo-package/v1',packages:[a,b]});const c=context(a);
 await lib.receiveResearch(c);const v=(await store.readSnapshot()).revision;await lib.receiveResearch(c);assert.equal((await store.readSnapshot()).revision,v);
 for(const change of [{productId:b.productId},{packageId:b.packageId},{packageDigest:hash('other')},{sourceWorkspaceId:randomUUID()}])await assert.rejects(()=>lib.receiveResearch({...c,id:randomUUID(),...change}));
 await assert.rejects(()=>lib.receiveResearch({...c,input:{...c.input,condition:'別の状態'}}));
 assert.equal((await store.read()).researchContexts.length,1);
});
test('own description never imports references or creates a listing, unknown remains unknown',()=>{
 const p=pack(randomUUID()),c=parseResearchContext(context(p));assert.equal(c.input.jan,'0123456789012');
 assert.ok(c.description.includes('自分の現物の傷'));assert.ok(!c.description.includes('参考品は美品'));
 assert.ok(c.description.includes('動作確認：未実施'));
 assert.throws(()=>parseResearchContext({...c,decision:{...c.decision,candidateConfirmed:false}}));
 assert.throws(()=>validateResearchContexts({packages:[p],researchContexts:[{...c,productId:randomUUID()}]}));
});
