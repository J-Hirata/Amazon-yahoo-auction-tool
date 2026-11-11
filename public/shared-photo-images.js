import {monitorRequest} from './monitor-http.js';
const urls=new Map(),pending=new Map(),queue=[];let active=0;
async function limited(job){
 if(active>=4)await new Promise(resolve=>queue.push(resolve));else active++;
 try{return await job();}finally{const next=queue.shift();if(next)next();else active--;}
}
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v||'');
export async function sharedPhotoUrl(photo,mode='preview'){
 if(!uuid(photo?.packageId)||!uuid(photo?.assetId)||!['image','preview'].includes(mode))throw Error('共有写真の対応を確認できません');
 const key=photo.packageId+'/'+photo.assetId+'/'+mode;
 if(urls.has(key))return urls.get(key);
 if(!pending.has(key))pending.set(key,limited(async()=>{
  const response=await monitorRequest('/api/photo-library/'+photo.packageId+'/assets/'+photo.assetId+'/'+mode);
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||'共有写真を取得できません');}
  const url=URL.createObjectURL(await response.blob());urls.set(key,url);return url;
 }).finally(()=>pending.delete(key)));
 return pending.get(key);
}
export function releaseSharedImages(){for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();}
if(typeof window!=='undefined')window.addEventListener('pagehide',releaseSharedImages);
export async function hydrateSharedPhotos(data,kind){
 const rows=kind==='stock'?data.products:data.rows;
 let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{for(;;){
  const row=rows[cursor++];if(!row)break;
  const p=row.sharedPhoto;if(!p||!p.useAsMain&&(kind==='stock'?row.photo?.url:row.imageUrl))continue;
  try{const url=await sharedPhotoUrl(p);row.sharedPhotoUrl=url;if(kind==='stock')row.photo={url,label:'写真ナビの共有写真'};}
  catch(error){row.sharedPhotoError=error.message;}
 }}));
 return data;
}
