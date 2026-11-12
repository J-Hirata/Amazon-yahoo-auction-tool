import {PROTOCOL,id,parsePackage,stableItemId,bridgeFetch,bridgeOrigin,bridgeKey,hash} from '../shared/photo-bridge.mjs';
import {createPhotoListingDrafts,validatePhotoListingDrafts} from './photo-listing-drafts.js';
const fail=(m,status=400)=>Object.assign(new Error(m),{status});
export function emptyPhotoLibrary(){return {version:1,packages:[],links:[],operations:[]};}
export function validatePhotoLibrary(state){
 if(!state||state.version!==1||!['packages','links','operations'].every(k=>Array.isArray(state[k]))||new Set(state.packages.map(p=>p.packageId)).size!==state.packages.length||new Set(state.links.map(l=>l.stockId)).size!==state.links.length)throw fail('共有写真の保存形式を確認してください');
 for(const p of state.packages)parsePackage(p);
 if(state.links.some(l=>!id(l.stockId)||typeof l.useAsMain!=='boolean'||l.active!==true&&l.active!==false||!state.packages.some(p=>p.packageId===l.packageId&&p.assets.some(a=>a.id===l.assetId))))throw fail('在庫と写真の対応が一致しません');
 return validatePhotoListingDrafts(state);
}
export function createPhotoLibrary({store,stockStore,sourceOrigin,sourceWorkspaceId,key,fetchImpl=fetch,allowLocal=false,linkTransaction}){
 const origin=bridgeOrigin(sourceOrigin,allowLocal);bridgeKey(key);if(!id(sourceWorkspaceId))throw fail('写真共有の接続元を確認してください');
 async function receive(raw){
  if(raw?.protocol!==PROTOCOL||!Array.isArray(raw.packages)||raw.packages.length<1||raw.packages.length>50)throw fail('写真セットを1〜50商品で送ってください');
  const packs=raw.packages.map(parsePackage);if(new Set(packs.map(p=>p.packageId)).size!==packs.length||packs.some(p=>p.sourceWorkspaceId!==sourceWorkspaceId))throw fail('共有元の所有者が一致しません',403);
  const before=await store.readSnapshot();
  for(const p of packs){const old=before.state.packages.find(s=>s.packageId===p.packageId);if(old&&JSON.stringify(parsePackage(old))!==JSON.stringify(p))throw fail('同じ共有IDで写真や商品情報が変わっています',409);}
  if(packs.some(p=>!before.state.packages.some(s=>s.packageId===p.packageId)))await store.update(state=>{
   for(const p of packs){const old=state.packages.find(s=>s.packageId===p.packageId);if(old&&JSON.stringify(parsePackage(old))!==JSON.stringify(p))throw fail('共有が競合しています',409);if(!old)state.packages.push(p);}
  });
  return {receipts:packs.map(p=>({packageId:p.packageId,itemId:stableItemId(p.sourceWorkspaceId,p.productId),digest:p.digest}))};
 }
 async function view(){
  const [saved,stocks]=await Promise.all([store.readSnapshot(),stockStore.readSnapshot()]),latest=new Map();
  for(const p of saved.state.packages){const itemId=stableItemId(p.sourceWorkspaceId,p.productId),current=latest.get(itemId);if(!current||p.revision>current.latest.revision)latest.set(itemId,{itemId,latest:p,sourceUrl:origin+'/products/'+p.productId+'/photos'});}
  return {items:[...latest.values()].sort((a,b)=>b.latest.revision-a.latest.revision),packages:saved.state.packages,listingDrafts:saved.state.listingDrafts||[],links:saved.state.links.filter(l=>l.active),revision:saved.revision,stockRevision:stocks.revision,
   stocks:stocks.state.products.map(s=>({id:s.id,title:s.title,asin:s.asin||'',sku:s.sellerSku||'',hasPhoto:!!s.imageUrl})),sourceOrigin:origin};
 }
 async function link(input,{expectedRevision,actor}){
  if(!input||!id(input.operationId)||!id(input.stockId)||!['attach','unlink'].includes(input.action)||!Number.isSafeInteger(input.stockRevision))throw fail('在庫商品と写真を選んでください');
  const previous=await store.readSnapshot(),fingerprint=hash(JSON.stringify(input)),receipt=previous.state.operations.find(o=>o.id===input.operationId);
  if(receipt){if(receipt.digest!==fingerprint||receipt.actor!==actor)throw fail('同じ操作IDで内容が変わっています',409);return view();}
  const stocks=await stockStore.readSnapshot();if(stocks.revision!==input.stockRevision)throw fail('在庫一覧が更新されました。もう一度選んでください',409);
  const stock=stocks.state.products.find(p=>p.id===input.stockId);if(!stock)throw fail('在庫商品が見つかりません',404);
  const apply=state=>{
   if(state.operations.some(o=>o.id===input.operationId))throw fail('同じ操作が更新されました。一覧を更新してください',409);
   const old=state.links.find(l=>l.stockId===input.stockId);
   if(input.action==='attach'){
    const p=state.packages.find(p=>p.packageId===input.packageId);if(!p||!p.assets.some(a=>a.id===input.assetId)||typeof input.useAsMain!=='boolean')throw fail('この商品に含まれる写真を選んでください');
    const next={stockId:input.stockId,packageId:p.packageId,assetId:input.assetId,useAsMain:input.useAsMain,active:true,linkedAt:new Date().toISOString(),actor};
    if(old)Object.assign(old,next);else state.links.push(next);
   }else if(old){old.active=false;old.unlinkedAt=new Date().toISOString();}
   state.operations.push({id:input.operationId,digest:fingerprint,stockId:input.stockId,action:input.action,actor,at:new Date().toISOString()});
  };
  if(linkTransaction)await linkTransaction.update(docs=>{
   const current=docs['photo-library'],stockDoc=docs['physical-stock'],old=current.state.operations.find(o=>o.id===input.operationId);
   if(old){if(old.digest!==fingerprint||old.actor!==actor)throw fail('同じ操作IDで内容が変わっています',409);return;}
   if(current.revision!==expectedRevision||stockDoc.revision!==input.stockRevision||!stockDoc.state.products.some(s=>s.id===input.stockId))throw fail('在庫か写真一覧が更新されました。もう一度選んでください',409);
   apply(current.state);
  });else await store.update(apply,{expectedRevision});
  return view();
 }
 async function image(packageId,assetId,mode='preview'){
  if(!id(packageId)||!id(assetId)||!['preview','image'].includes(mode))throw fail('写真が見つかりません',404);
  const saved=await store.read(),p=saved.packages.find(p=>p.packageId===packageId),a=p?.assets.find(a=>a.id===assetId);if(!a)throw fail('受け取っていない写真です',404);
  const response=await bridgeFetch(origin,'/api/photo-packages/'+packageId+'/assets/'+assetId+'/'+mode,key,{fetchImpl});
  if(!response.ok)throw fail(response.status===410?'元の写真共有が解除されています':'元写真を取得できません。写真ナビで共有状態を確認してください',response.status===410?410:503);
  if(!/^image\/jpeg(?:;|$)/.test(response.headers.get('content-type')||''))throw fail('画像の応答を確認できません',503);
  const limit=mode==='preview'?a.previewBytes:a.bytes;
  if(Number(response.headers.get('content-length')||0)>limit)throw fail('写真の大きさが一致しません',409);
  const reader=response.body?.getReader();if(!reader)throw fail('写真を取得できません',503);
  const chunks=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw fail('写真の大きさが一致しません',409);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=Buffer.concat(chunks);if(size!==limit||hash(bytes)!==(mode==='preview'?a.previewSha256:a.sha256))throw fail('写真の内容が共有時と一致しません',409);
  return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }
 async function decorateStock(data){
  const saved=await store.read();
  return {...data,products:data.products.map(p=>{const l=saved.links.find(l=>l.stockId===p.id&&l.active);return {...p,...(l?{sharedPhoto:{packageId:l.packageId,assetId:l.assetId,useAsMain:l.useAsMain}}:{})};})};
 }
 async function decorateOverview(data){
  const saved=await store.read();
  return {...data,rows:data.rows.map(r=>{const matches=saved.links.filter(l=>l.active&&(r.stockIds||[]).includes(l.stockId));const l=matches.length===1?matches[0]:null;
   return {...r,...(l?{sharedPhoto:{packageId:l.packageId,assetId:l.assetId,useAsMain:l.useAsMain}}:{})};})};
 }
 return {receive,view,link,image,decorateStock,decorateOverview,listingDrafts:createPhotoListingDrafts({store,sourceOrigin:origin})};
}
