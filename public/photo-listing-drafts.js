import {monitorRequest} from './monitor-http.js';
import {sharedPhotoUrl,previewSharedPhoto} from './shared-photo-images.js';
import {photoDraftZip,photoDraftText} from './photo-draft-zip.js';
import {DRAFTS_HOME,SHARED_PHOTOS_HOME} from './draft-workspace.js';
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
async function request(path='',options){
 const r=await monitorRequest('/api/photo-listing-drafts'+path,options),data=await r.json();
 if(!r.ok)throw Object.assign(Error(data.error||'写真からの下書きを確認できません'),{status:r.status});return data;
}
function download(blob,name){const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export async function downloadPhotoDraft(d){
 const result=await request('/'+d.id+'/export/'+d.version),entries=[];
 for(const [i,a]of result.photos.entries()){
  const r=await monitorRequest('/api/photo-library/'+result.packageId+'/assets/'+a.id+'/image');
  if(!r.ok){const e=await r.json().catch(()=>({}));throw Error(e.error||'写真を取得できません。ZIPは作成していません。');}
  const b=new Uint8Array(await r.arrayBuffer());if(!b.length||b.length>4000000||!/^image\/jpeg/.test(r.headers.get('content-type')||''))throw Error('写真の内容を確認できません。');
  entries.push([String(i+1).padStart(2,'0')+'.jpg',b]);
 }
 entries.push(['出品下書き.txt',photoDraftText(result.text)],['作業メモ.txt',photoDraftText(result.note)],['写真対応.json',photoDraftText(JSON.stringify(result,null,2))]);
 download(photoDraftZip(entries),d.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,60)+'_下書き.zip');
}
export async function openPhotoDraft({packet,readOnly=false,onSaved=()=>{}}){
 const data=await request();let draft=data.items.find(d=>d.package.sourceWorkspaceId===packet.sourceWorkspaceId&&d.package.productId===packet.productId&&d.channel==='yahoo');
 if(draft?.archived)readOnly=true;
 let p=draft?.package||packet,selected=[...(draft?.assetIds||(p.mainAssetId?[p.mainAssetId]:[]))],pending=null,saving=false;
 const dialog=node('dialog',undefined,'photo-draft-editor'),form=node('form'),header=node('header'),h=node('h2','写真からヤフオク下書きを準備'),close=node('button','閉じる');close.type='button';header.append(h,close);
 const message=node('p',draft?.archived?'アーカイブ中です。「出品下書き」でアーカイブを表示して戻すと編集できます。':'','photo-draft-message');message.setAttribute('role','status');
 const inputs=node('fieldset'),layout=node('div',undefined,'photo-draft-layout'),fields=node('div',undefined,'photo-draft-fields'),photos=node('section',undefined,'photo-draft-picker');
 inputs.disabled=readOnly;
 function field(label,tag,value){const l=node('label',label),n=node(tag);n.value=value;l.append(n);fields.append(l);return n;}
 const title=field('商品名','input',draft?.title||packet.name);title.required=true;title.maxLength=500;
 const price=field('開始価格（円・未定なら空欄）','input',draft?.price??'');price.type='number';price.min='1';price.max='100000000';price.step='1';
 const description=field('出品する商品説明','textarea',draft?.description||'');description.rows=7;description.maxLength=20000;
 const note=field('作業メモ（出品文面には含めません）','textarea',draft?.note||[packet.note,packet.reviewNote].filter(Boolean).join('\n').slice(0,2000));note.rows=3;note.maxLength=2000;
 const count=node('p'),grid=node('div',undefined,'photo-draft-picker-grid');photos.append(node('h3','使う写真を選ぶ'),node('p','代表写真がある場合は選択済みです。使う写真を選び、タグだけの写真、暗い写真、重複した写真は外してください。最大10枚。'),count,grid);
 let observer;function renderPhotos(){
  observer?.disconnect();grid.replaceChildren();count.textContent=selected.length+' / 10枚を使用（1枚目が代表写真）';
  observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);const img=entry.target,a=p.assets.find(a=>a.id===img.dataset.asset);void sharedPhotoUrl({packageId:p.packageId,assetId:a.id}).then(url=>{img.src=url;}).catch(e=>{img.alt=e.message;message.textContent=e.message;});}},{root:grid,rootMargin:'120px'});
  for(const a of p.assets){
   const item=node('div',undefined,'photo-draft-choice'),img=node('img');img.alt=a.name;img.src='/catalog-image.svg';img.dataset.asset=a.id;img.loading='lazy';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',a.name+'を拡大');img.onclick=()=>void previewSharedPhoto(p,p.assets.indexOf(a));img.onkeydown=e=>{if(e.key==='Enter')img.click();};
   const label=node('label'),check=node('input');check.type='checkbox';check.checked=selected.includes(a.id);check.setAttribute('aria-label',a.name+'を使用');label.append(check,document.createTextNode(a.name));
   const main=node('button',selected[0]===a.id?'1枚目':'先頭にする');main.type='button';main.disabled=!check.checked||readOnly;main.setAttribute('aria-label',a.name+'を先頭にする');
   check.onchange=()=>{if(check.checked&&selected.length>=10){check.checked=false;message.textContent='写真は10枚まで選べます。';return;}selected=check.checked?[...selected,a.id]:selected.filter(v=>v!==a.id);renderPhotos();};
   main.onclick=()=>{selected=[a.id,...selected.filter(v=>v!==a.id)];renderPhotos();};item.append(img,label,main);grid.append(item);observer.observe(img);
  }
 }
 if(draft&&draft.packageId!==packet.packageId){const change=node('button','今回共有した写真セットに切り替える');change.type='button';change.disabled=readOnly;fields.append(node('p','この下書きは以前の写真セットを使っています。変更する場合は写真を選び直してください。'),change);change.onclick=()=>{p=packet;selected=p.mainAssetId?[p.mainAssetId]:[];change.disabled=true;renderPhotos();};}
 layout.append(fields,photos);inputs.append(layout);const footer=node('footer'),save=node('button','下書きを保存'),cancel=node('button','キャンセル');save.type='submit';save.disabled=readOnly||!!draft?.archived;save.dataset.write='';cancel.type='button';footer.append(cancel,save);
 form.append(header,node('p','出品に使う写真を選び、商品説明と価格を入力してください。保存した下書きから写真と文面をまとめて取得できます。'),inputs,message,footer);dialog.append(form);dialog.setAttribute('aria-label','写真からの出品下書き');document.body.append(dialog);
 function dismiss(){if(!saving)dialog.close();}
 close.onclick=dismiss;cancel.onclick=dismiss;dialog.addEventListener('click',e=>{if(e.target===dialog)dismiss();});dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});dialog.addEventListener('close',()=>{observer?.disconnect();dialog.remove();});
 form.onsubmit=async e=>{
  e.preventDefault();if(saving||readOnly)return;
  const base={action:'save',packageId:p.packageId,version:draft?.version||0,values:{title:title.value,price:price.value===''?null:Number(price.value),description:description.value,note:note.value,assetIds:selected}};
  const signature=JSON.stringify(base);if(!pending||pending.signature!==signature)pending={signature,input:{operationId:crypto.randomUUID(),...base}};
  saving=true;inputs.disabled=true;save.disabled=true;cancel.disabled=true;close.disabled=true;message.textContent='下書きを保存しています…';
  try{
   const saved=await request('',{method:'POST',headers:{'Content-Type':'application/json','If-Match':'"'+data.revision+'"'},body:JSON.stringify(pending.input)});
   pending=null;saving=false;dialog.close();await onSaved(saved);
  }catch(error){message.textContent=error.message+(error.status===409?' 入力は残しています。別のタブで最新の下書きを確認してください。':' 同じ保存ボタンで再試行できます。');}
  finally{saving=false;inputs.disabled=readOnly;save.disabled=readOnly;cancel.disabled=false;close.disabled=false;}
 };
 dialog.showModal();renderPhotos();title.focus();
}
export async function mountPhotoDraftBoard(main,{readOnly=false,enabled=true}={}){
 if(!enabled)return;
 const section=node('section',undefined,'photo-draft-board'),header=node('header'),heading=node('div'),status=node('p'),toolbar=node('div',undefined,'photo-draft-tools');
 heading.append(node('h2','写真からの下書き'),node('p','写真仕分けナビから受け取った商品を、写真と文面で準備します。'));
 const shared=node('a','写真仕分けナビ共有写真から追加');shared.href=SHARED_PHOTOS_HOME;
 const refresh=node('button','一覧を更新');refresh.type='button';const archived=node('label'),show=node('input');show.type='checkbox';archived.append(show,document.createTextNode('アーカイブも表示'));
 toolbar.append(shared,archived,refresh);header.append(heading,toolbar);status.setAttribute('role','status');const grid=node('div',undefined,'photo-draft-cards');section.append(header,status,grid);
 const nav=main.querySelector('.draft-workspace-nav');nav.after(section);let data,busy=false;
 const message=text=>{status.textContent=text;};
 async function load(){data=await request();render();}
 function render(){
  grid.replaceChildren();const items=data.items.filter(d=>show.checked||!d.archived);
  if(!items.length){grid.append(node('p','写真からの下書きはまだありません。「写真仕分けナビ共有写真」で使う商品を選んでください。'));return;}
  for(const d of items){
   const card=node('article',undefined,'photo-draft-card'),img=node('img');card.dataset.photoDraftId=d.id;img.alt=d.title;img.loading='lazy';void sharedPhotoUrl({packageId:d.packageId,assetId:d.assetIds[0]}).then(url=>img.src=url).catch(e=>img.alt=e.message);
   card.append(img,node('h3',d.title),node('small',(d.archived?'アーカイブ':d.ready?'下書き内容入力済み':'商品説明・価格を入力')+' ／ '+d.assetIds.length+'枚 ／ '+(d.price===null?'価格未定':d.price.toLocaleString('ja-JP')+'円')),node('small',[d.projectName,d.batchTitle].filter(Boolean).join(' ／ ')));
   const actions=node('div',undefined,'photo-draft-actions');
   const edit=node('button','詳細・写真を編集');edit.type='button';edit.onclick=()=>void openPhotoDraft({packet:d.package,readOnly:readOnly||d.archived,onSaved:async saved=>{data=saved;render();message('下書きをツール内に保存しました。');}}).catch(e=>message(e.message));
   const zip=node('button','写真・文面をまとめて取得');zip.type='button';zip.disabled=busy;zip.onclick=async()=>{if(busy)return;busy=true;zip.disabled=true;message('選択した写真と保存済み文面をまとめています…');try{await downloadPhotoDraft(d);message('写真と文面のZIPを作成しました。ヤフオクでは写真ファイルと文面を入力できます。');}catch(e){message(e.message);}finally{busy=false;zip.disabled=false;}};
   const yahoo=node('a','ヤフオクの入力画面へ ↗');yahoo.href=data.yahooSellerUrl;yahoo.target='_blank';yahoo.rel='noopener noreferrer';
   const archive=node('button',d.archived?'アーカイブから戻す':'アーカイブ');archive.type='button';archive.dataset.write='';archive.disabled=readOnly||busy;
   archive.onclick=async()=>{if(busy||readOnly)return;busy=true;archive.disabled=true;try{await request('',{method:'POST',headers:{'Content-Type':'application/json','If-Match':'"'+data.revision+'"'},body:JSON.stringify({operationId:crypto.randomUUID(),action:d.archived?'restore':'archive',packageId:d.packageId,version:d.version})});await load();message(d.archived?'下書きを戻しました。':'下書きをアーカイブしました。写真は保持しています。');}catch(e){message(e.message);}finally{busy=false;render();}};
   actions.append(edit,zip,yahoo,archive);card.append(actions);grid.append(card);
  }
 }
 refresh.onclick=()=>{if(!busy)void load().catch(e=>message(e.message));};show.onchange=()=>data&&render();
 await load();const savedId=new URLSearchParams(location.hash.slice(1)).get('photo-draft-saved'),savedCard=[...grid.children].find(c=>c.dataset.photoDraftId===savedId);if(savedCard){message('写真からの下書きを保存しました。');savedCard.tabIndex=-1;savedCard.focus();}
 const focus=new URLSearchParams(location.hash.slice(1)).get('photo-draft'),found=data.items.find(d=>d.id===focus);
 if(found)await openPhotoDraft({packet:found.package,readOnly:readOnly||found.archived,onSaved:async saved=>{data=saved;render();message('下書きをツール内に保存しました。');}});
}
