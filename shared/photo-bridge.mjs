import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export const PROTOCOL='photo-package/v1';
export const id=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const hash=v=>createHash('sha256').update(v).digest('hex');
const bad=()=>{throw Object.assign(new Error('写真セットの形式または対応を確認してください。'),{status:400});};
const text=(v,max,empty=true)=>{if(typeof v!=='string'||v.length>max||!empty&&!v.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))bad();return v;};
const list=(v,max,len)=>{if(!Array.isArray(v)||v.length>len)bad();return v.map(x=>text(x,max));};
const dimension=v=>{if(!Number.isSafeInteger(v)||v<1||v>2560)bad();return v;};
const bytes=v=>{if(!Number.isSafeInteger(v)||v<1||v>4000000)bad();return v;};
export function normalizedContent(raw){
 if(!raw||!id(raw.sourceWorkspaceId)||!id(raw.productId)||!id(raw.batchId)||!Array.isArray(raw.assets)||!raw.assets.length||raw.assets.length>200)bad();
 const assets=raw.assets.map((a,i)=>{
  if(!a||!id(a.id)||a.position!==i+1||!sha(a.sourceSha256)||!sha(a.sha256)||!sha(a.previewSha256)||!['stored','preview_only'].includes(a.quality))bad();
  return {id:a.id,name:text(a.name,1000,false),position:a.position,sourceSha256:a.sourceSha256,sha256:a.sha256,bytes:bytes(a.bytes),width:dimension(a.width),height:dimension(a.height),previewSha256:a.previewSha256,previewBytes:bytes(a.previewBytes),quality:a.quality};
 });
 if(new Set(assets.map(a=>a.id)).size!==assets.length||raw.mainAssetId!==null&&!assets.some(a=>a.id===raw.mainAssetId))bad();
 if(raw.asin!==null&&(typeof raw.asin!=='string'||!/^[A-Z0-9]{10}$/.test(raw.asin)))bad();
 if(!Array.isArray(raw.identifiers)||raw.identifiers.length>assets.length)bad();
 const identifiers=raw.identifiers.map(r=>{
  if(!r||!assets.some(a=>a.id===r.assetId)||typeof r.confirmed!=='boolean'||!Number.isSafeInteger(r.version)||r.version<0)bad();
  return {assetId:r.assetId,models:list(r.models,100,12),jans:list(r.jans,64,12),note:text(r.note,400),confirmed:r.confirmed,version:r.version};
 });
 if(new Set(identifiers.map(r=>r.assetId)).size!==identifiers.length)bad();
 return {protocol:PROTOCOL,sourceWorkspaceId:raw.sourceWorkspaceId,productId:raw.productId,batchId:raw.batchId,projectName:text(raw.projectName,100),batchTitle:text(raw.batchTitle,160),name:text(raw.name,200,false),asin:raw.asin,sku:text(raw.sku,300),note:text(raw.note,2000),reviewNote:text(raw.reviewNote,2000),mainAssetId:raw.mainAssetId,assets,identifiers};
}
export const contentDigest=raw=>hash(JSON.stringify(normalizedContent(raw)));
export function parsePackage(raw){
 const content=normalizedContent(raw);
 if(raw.protocol!==PROTOCOL||!id(raw.packageId)||!Number.isSafeInteger(raw.revision)||raw.revision<1||!Number.isFinite(Date.parse(raw.createdAt))||raw.digest!==contentDigest(content))bad();
 return {...content,packageId:raw.packageId,revision:raw.revision,createdAt:raw.createdAt,digest:raw.digest};
}
export function stableItemId(workspace,product){
 const h=hash(workspace+':'+product);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}
export function bridgeOrigin(raw,allowLocal=false){
 let u;try{u=new URL(raw);}catch{throw new Error('写真共有の接続先が未設定です。');}
 if(u.href!==u.origin+'/'||u.username||u.password||!(u.protocol==='https:'||allowLocal&&u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw new Error('写真共有の接続先が正しくありません。');
 return u.origin;
}
export function bridgeKey(key){if(!sha(key))throw new Error('写真共有の接続設定が必要です。');return key;}
function signature(key,method,url,body,time){const u=new URL(url);return createHmac('sha256',bridgeKey(key)).update(['photo-bridge/v1',method.toUpperCase(),u.origin,u.pathname,u.search,time,hash(body)].join('\n')).digest('hex');}
export function signedHeaders(key,method,url,body='',at=Date.now()){
 const time=String(at);return {'Content-Type':'application/json','x-photo-time':time,'x-photo-signature':signature(key,method,url,body,time)};
}
export function verifyBridge(request,key,body='',at=Date.now()){
 try{
  const time=request.headers.get('x-photo-time'),sig=request.headers.get('x-photo-signature');
  if(!/^\d{13}$/.test(time||'')||!sha(sig)||Math.abs(at-Number(time))>90000)return false;
  const expected=signature(key,request.method,request.url,body,time);
  return timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(sig,'hex'));
 }catch{return false;}
}
export async function bridgeFetch(origin,path,key,{body='',method='GET',fetchImpl=fetch}={}){
 const url=origin+path;
 return fetchImpl(url,{method,headers:signedHeaders(key,method,url,body),...(method==='GET'?{}:{body}),signal:AbortSignal.timeout(30000),redirect:'error'});
}
