import {stockImageUrl} from './stock-images.js';
import {draftView} from './cloud-drafts.js';
const photo=value=>{const url=stockImageUrl(value);return url&&!new URL(url).hostname.endsWith('.yimg.jp')?url:'';};
const needsTitle=item=>!item.title?.trim()||item.title.trim()===item.asin;
const hasPhoto=item=>Array.isArray(item.imageUrls)?item.imageUrls.length>0:Boolean(item.imageUrls);
const fail=(message,status)=>Object.assign(new Error(message),{status});
export function createDraftCatalog({store,monitorStore,stockStore,planningStore,readCatalog,readOnly=false,now=()=>new Date().toISOString()}){
 async function cache(){
  const results=await Promise.allSettled([monitorStore?.read(),stockStore?.read(),planningStore?.read()]);
  const [monitor,stock,planning]=results.map(r=>r.status==='fulfilled'?r.value:null),map=new Map();
  const add=(asin,title,imageUrl)=>{if(!/^[A-Z0-9]{10}$/.test(asin||''))return;const previous=map.get(asin)||{asin,title:'',imageUrl:''};map.set(asin,{asin,title:previous.title||title||'',imageUrl:previous.imageUrl||photo(imageUrl)});};
  for(const p of monitor?.amazonInventory?.items||[])add(p.asin,p.listingInfo?.title||p.title,p.listingInfo?.catalogImageUrl);
  for(const p of stock?.products||[])if(p.imageSource==='amazon_catalog')add(p.asin,'',p.imageUrl);
  for(const p of planning?.plans||[])if(p.imageSource==='amazon_catalog')add(p.asin,'',p.imageUrl);
  return map;
 }
 async function view(saved=undefined){
  saved??=await store.readSnapshot();const refs=await cache(),result=draftView(saved);
  result.items=result.items.map(item=>({...item,displayImageUrl:item.imageUrls?.find(stockImageUrl)||refs.get(item.asin)?.imageUrl||'',displayTitle:needsTitle(item)?refs.get(item.asin)?.title||'':item.title}));
  result.capabilities.catalogRead=Boolean(readCatalog);result.capabilities.readOnly=readOnly;return result;
 }
 async function fill(asins,{expectedRevision}){
  if(!Array.isArray(asins)||!asins.length||asins.length>5||new Set(asins).size!==asins.length||asins.some(a=>typeof a!=='string'||!/^[A-Z0-9]{10}$/.test(a)))throw fail('ASINは登録済みの商品から1〜5件ずつ選んでください',400);
  const saved=await store.readSnapshot();if(saved.revision!==expectedRevision)throw fail('ほかの下書き編集が保存されました。入力を残して一覧を読み直してください',409);
  if(asins.some(asin=>!saved.state.some(p=>p.asin===asin)))throw fail('登録済みの商品を選んでください',400);
  const refs=await cache(),patches=[],results=[];
  for(const asin of asins){
   const item=saved.state.find(p=>p.asin===asin),reference={...refs.get(asin)},missingTitle=needsTitle(item),missingPhoto=!hasPhoto(item);
   if(!missingTitle&&!missingPhoto){results.push({asin,ok:true,message:'入力済みの情報を保持しました'});continue;}
   if((missingTitle&&!reference.title||missingPhoto&&!reference.imageUrl)&&readCatalog)try{const remote=await readCatalog(asin);if(remote?.asin===asin){reference.title ||= remote.title;reference.imageUrl ||= photo(remote.imageUrl);}}catch{/* Individual failures never erase existing input. */}
   const patch={};if(missingTitle&&typeof reference.title==='string'&&reference.title.trim())patch.title=reference.title.trim().slice(0,500);if(missingPhoto&&photo(reference.imageUrl))patch.imageUrls=[photo(reference.imageUrl)];
   if(Object.keys(patch).length)patches.push({asin,patch});
   results.push({asin,ok:Boolean(Object.keys(patch).length),message:Object.keys(patch).length?'不足している写真・商品名だけ補完しました':'取得できませんでした。Amazonリンクから確認し、編集で入力できます'});
  }
  if(patches.length)await store.update(items=>{for(const {asin,patch} of patches){const item=items.find(p=>p.asin===asin);if(!item)throw fail('商品が更新されました',409);Object.assign(item,patch,{updatedAt:now()});}},{expectedRevision});
  return {results,...await view()};
 }
 async function draftItem(asin){const item=(await view()).items.find(p=>p.asin===asin);if(!item)return undefined;return {...item,title:needsTitle(item)?item.displayTitle||item.title:item.title,imageUrls:hasPhoto(item)?item.imageUrls:item.displayImageUrl?[item.displayImageUrl]:[]};}
 return {view,fill,draftItem};
}
