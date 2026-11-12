import {monitorRequest} from './monitor-http.js';
import {sharedPhotoUrl} from './shared-photo-images.js';
import {openPhotoDraft} from './photo-listing-drafts.js';
import {DRAFTS_HOME} from './draft-workspace.js';
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
export async function openSharedPhotos({readOnly=false,enabled=true}={}){
 const $=s=>document.querySelector(s),host=$('#sharedPhotosItems'),status=$('#sharedPhotosStatus'),dialog=$('#sharedPhotoDialog');
 let data,busy=false,opened=null,pendingInput=null;
 const retry=node('button','前の写真関連付けを再試行');retry.type='button';retry.hidden=true;status.after(retry);retry.onclick=()=>{if(pendingInput)void save(pendingInput);};
 const message=(text,error=false)=>{status.textContent=text;status.className=error?'shared-photo-error':'';};
 async function image(img,p,a,mode='preview',state){
  try{img.src=await sharedPhotoUrl({packageId:p.packageId,assetId:a.id},mode);if(state)state.hidden=true;}
  catch(error){img.removeAttribute('src');img.alt=error.message;img.title=error.message;if(state){state.hidden=false;state.textContent=error.message;state.className='shared-photo-error';}}
 }
 async function preview(p,index){
  opened={p,index};const a=p.assets[index];$('#sharedPhotoCaption').textContent=p.name+' ／ '+a.name;$('#sharedPhotoPosition').textContent=(index+1)+' / '+p.assets.length;
  $('#sharedPhotoPrevious').disabled=index===0;$('#sharedPhotoNext').disabled=index===p.assets.length-1;
  const img=$('#sharedPhotoFull');img.removeAttribute('src');img.alt='写真を読み込んでいます';
  if(!dialog.open)dialog.showModal();
  const expected=opened;try{const url=await sharedPhotoUrl({packageId:p.packageId,assetId:a.id},'image');if(opened===expected){img.src=url;img.alt=p.name+' '+a.name;}}
  catch(error){if(opened===expected)img.alt=error.message;}
 }
 $('#sharedPhotoClose').onclick=()=>dialog.close();
 $('#sharedPhotoPrevious').onclick=()=>{if(opened&&opened.index>0)void preview(opened.p,opened.index-1);};
 $('#sharedPhotoNext').onclick=()=>{if(opened&&opened.index<opened.p.assets.length-1)void preview(opened.p,opened.index+1);};
 dialog.addEventListener('keydown',e=>{if(e.key==='ArrowLeft')$('#sharedPhotoPrevious').click();if(e.key==='ArrowRight')$('#sharedPhotoNext').click();});
 function remember(input){pendingInput=input;retry.hidden=false;try{sessionStorage.setItem('photo-library-pending',JSON.stringify(input));}catch{}}
 function forget(){pendingInput=null;retry.hidden=true;try{sessionStorage.removeItem('photo-library-pending');}catch{}}
 async function save(input){
  if(busy||readOnly)return;busy=true;retry.disabled=true;remember(input);render();message('写真と在庫の対応を保存しています…');
  try{
   const r=await monitorRequest('/api/photo-library/link',{method:'POST',headers:{'Content-Type':'application/json','If-Match':'"'+data.revision+'"'},body:JSON.stringify(input)});
   const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error||'関連付けを保存できません'),{status:r.status});
   data=v;forget();message(input.action==='unlink'?'写真の関連付けを外しました。元写真は保持しています。':'写真と在庫を関連付けました。出品・数量変更は行っていません。');
  }catch(error){if(error.status>=400&&error.status<500){forget();await load();}message(error.message+'。通信結果が不明な場合は、同じ操作を再試行できます。',true);}
  finally{busy=false;retry.disabled=false;render();}
 }
 function render(){
  host.replaceChildren();if(!data)return;
  const query=$('#sharedPhotosSearch').value.toLowerCase(),stockContext=new URLSearchParams(location.hash.slice(1)).get('stock');
  const items=data.items.filter(i=>[i.latest.name,i.latest.asin,i.latest.sku].join(' ').toLowerCase().includes(query));
  if(!items.length){host.append(node('p',data.items.length?'一致する商品はありません。':'共有写真はまだありません。写真ナビの商品一覧で商品を選び「コックピットへ共有」を押してください。'));return;}
  for(const item of items){
   const p=item.latest,card=node('article',undefined,'shared-photo-card'),title=node('h2',p.name),main=p.assets.find(a=>a.id===p.mainAssetId)||p.assets[0],img=node('img',undefined,'shared-photo-main');
   img.alt=p.name;img.loading='lazy';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',p.name+'を拡大');img.onclick=()=>void preview(p,p.assets.indexOf(main));img.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();img.click();}};
   const loading=node('small','写真を読み込んでいます…');void image(img,p,main,'preview',loading);
   const source=node('a','写真ナビで確認・修正 ↗');source.href=item.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';
   card.append(img,loading,title,node('small',[p.projectName||'プロジェクト未設定',p.batchTitle].join(' ／ ')),node('small',p.assets.length+'枚 ／ '+(p.asin||'ASIN未設定')+(p.sku?' ／ '+p.sku:'')),source);
   if(p.note)card.append(node('p',p.note));if(p.reviewNote)card.append(node('small','確認メモ：'+p.reviewNote));
   if(p.identifiers.length){const info=node('details'),heading=node('summary','型番・JANの読み取り結果');info.append(heading);
    for(const r of p.identifiers){const a=p.assets.find(a=>a.id===r.assetId);info.append(node('p',(r.confirmed?'確認済み':'候補・要確認')+' ／ '+a.name+'\n'+[...r.models,...r.jans].join(' ／ ')+(r.note?'\n'+r.note:'')));}
    card.append(info);
   }
   if(p.assets.some(a=>a.quality==='preview_only'))card.append(node('small','一部は保存済みプレビューです。出品に使う際は画質を確認してください。'));
   const form=node('form'),stockLabel=node('label','関連付ける在庫商品','shared-stock-label'),select=node('select');select.setAttribute('aria-label',p.name+'の在庫商品');select.required=true;
   const blank=node('option','在庫商品を選んでください');blank.value='';select.append(blank);
   for(const s of data.stocks){const option=node('option',s.title+' ／ '+(s.asin||'ASINなし')+(s.sku?' ／ '+s.sku:''));option.value=s.id;select.append(option);}
   if(data.stocks.some(s=>s.id===stockContext))select.value=stockContext;
   stockLabel.append(select);
   const useLabel=node('label'),use=node('input');use.type='checkbox';use.checked=!data.stocks.find(s=>s.id===select.value)?.hasPhoto;
   useLabel.append(use,document.createTextNode('在庫の代表写真に使う'));select.onchange=()=>{use.checked=!data.stocks.find(s=>s.id===select.value)?.hasPhoto;};
   let selected=main.id;
   const details=node('details'),summary=node('summary','写真一覧・代表写真を選ぶ（'+p.assets.length+'枚）'),thumbs=node('div',undefined,'shared-photo-thumbs');details.append(summary,thumbs);
   details.addEventListener('toggle',()=>{if(!details.open||thumbs.children.length)return;for(const [index,a] of p.assets.entries()){
    const choice=node('div',undefined,'shared-photo-choice'),thumb=node('img');thumb.alt=a.name;thumb.loading='lazy';thumb.onclick=()=>void preview(p,index);thumb.tabIndex=0;thumb.setAttribute('role','button');thumb.setAttribute('aria-label',a.name+'を拡大');thumb.onkeydown=e=>{if(e.key==='Enter')thumb.click();};
    const label=node('label'),radio=node('input');radio.type='radio';radio.name='main-'+p.packageId;radio.value=a.id;radio.checked=a.id===selected;radio.onchange=()=>{selected=a.id;void image(img,p,a);img.onclick=()=>void preview(p,index);};
    label.append(radio,document.createTextNode((index+1)+'枚目を使う'));choice.append(thumb,label,node('span',a.name));thumbs.append(choice);void image(thumb,p,a);
   }});
   const submit=node('button','この在庫に写真を関連付ける');submit.type='submit';submit.disabled=busy||readOnly;select.disabled=busy||readOnly;use.disabled=busy||readOnly;
   form.append(stockLabel,useLabel,submit);
   form.onsubmit=e=>{e.preventDefault();if(select.value)void save({operationId:crypto.randomUUID(),stockId:select.value,stockRevision:data.stockRevision,action:'attach',packageId:p.packageId,assetId:selected,useAsMain:use.checked});};
   const start=node('button',data.listingDrafts?.some(d=>d.sourceItemId===item.itemId)?'この商品の下書きを開く':'この写真で下書きを準備','photo-draft-start');start.type='button';start.dataset.write='';start.disabled=readOnly||busy;
   start.onclick=()=>void openPhotoDraft({packet:p,readOnly,onSaved:saved=>{location.href=DRAFTS_HOME+'#photo-draft-saved='+saved.id;}}).catch(e=>message(e.message,true));
   const inventory=node('details',undefined,'shared-photo-inventory'),inventoryHeading=node('summary','在庫の写真にも使う（任意）');inventory.open=Boolean(stockContext);inventory.append(inventoryHeading,form);
   card.append(start,details,inventory);
   const ids=new Set(data.packages.filter(v=>v.productId===p.productId&&v.sourceWorkspaceId===p.sourceWorkspaceId).map(v=>v.packageId));
   for(const link of data.links.filter(l=>ids.has(l.packageId))){
    const linked=node('div',undefined,'shared-photo-linked'),stock=data.stocks.find(s=>s.id===link.stockId),a=node('a',stock?.title||'在庫商品を確認');
    a.href='/?view=stock#connect='+link.stockId;linked.append(node('small',link.packageId===p.packageId?'関連付け済み':'以前の写真セットで関連付け済み'),a);
    const remove=node('button','この関連付けを外す');remove.type='button';remove.disabled=busy||readOnly;remove.onclick=()=>void save({operationId:crypto.randomUUID(),stockId:link.stockId,stockRevision:data.stockRevision,action:'unlink'});linked.append(remove);card.append(linked);
   }
   host.append(card);
  }
 }
 async function load(){
  const r=await monitorRequest('/api/photo-library'),v=await r.json();if(!r.ok)throw Error(v.error||'共有写真を読み込めません');
  data=v;render();message(data.items.length+'商品の写真セットを受け取っています。');
 }
 $('#sharedPhotosSearch').oninput=render;$('#sharedPhotosRefresh').onclick=()=>{if(!busy)void load().catch(e=>message(e.message,true));};
 if(!enabled){message('写真ナビとの接続準備中です。既存機能は引き続き使えます。');return;}
 await load();
 const contextId=new URLSearchParams(location.hash.slice(1)).get('research'),context=(data.researchContexts||[]).find(c=>c.id===contextId),packet=context&&data.packages.find(p=>p.packageId===context.packageId);
 if(packet)await openPhotoDraft({packet,readOnly,onSaved:async()=>{await load();message('リサーチ内容から下書きを保存しました。');}});
 try{const pending=JSON.parse(sessionStorage.getItem('photo-library-pending')||'null');if(pending){pendingInput=pending;retry.hidden=false;message('前の写真関連付けの保存結果が不明です。一覧を確認し、必要なら同じ操作を再試行してください。');}}catch{}
}
