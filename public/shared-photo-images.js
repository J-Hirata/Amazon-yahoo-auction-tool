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
export async function previewSharedPhoto(packet,index=0){
 const dialog=document.createElement('dialog');dialog.className='photo-draft-image-viewer';dialog.setAttribute('aria-label','写真を拡大');
 const header=document.createElement('header'),caption=document.createElement('span'),close=document.createElement('button'),image=document.createElement('img'),footer=document.createElement('footer'),previous=document.createElement('button'),next=document.createElement('button');
 close.type=previous.type=next.type='button';close.textContent='閉じる';previous.textContent='← 前へ';next.textContent='次へ →';header.append(caption,close);footer.append(previous,next);dialog.append(header,image,footer);document.body.append(dialog);
 let request=0;async function show(i){index=i;const token=++request,a=packet.assets[i];caption.textContent=(i+1)+' / '+packet.assets.length+' ／ '+a.name;previous.disabled=i===0;next.disabled=i===packet.assets.length-1;image.removeAttribute('src');image.alt='写真を読み込んでいます';
  try{const url=await sharedPhotoUrl({packageId:packet.packageId,assetId:a.id},'image');if(token===request){image.src=url;image.alt=a.name;}}catch(e){if(token===request)image.alt=e.message;}
 }
 previous.onclick=()=>void show(index-1);next.onclick=()=>void show(index+1);close.onclick=()=>dialog.close();
 dialog.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'&&index>0){e.preventDefault();void show(index-1);}if(e.key==='ArrowRight'&&index<packet.assets.length-1){e.preventDefault();void show(index+1);}});
 dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();await show(index);
}
export function releaseSharedImages(){for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();}
if(typeof window!=='undefined')window.addEventListener('pagehide',releaseSharedImages);
export function retainSharedStock(next,previous){
 const byId=new Map(previous.products.filter(p=>p.sharedPhoto).map(p=>[p.id,p.sharedPhoto]));
 return {...next,photoRead:previous.photoRead,amazonRead:previous.amazonRead,photoLibrary:previous.photoLibrary,
  products:next.products.map(p=>({...p,...(byId.has(p.id)?{sharedPhoto:byId.get(p.id)}:{})}))};
}
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
