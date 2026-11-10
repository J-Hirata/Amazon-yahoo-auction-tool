import {monitorRequest} from './monitor-http.js';
import {createCatalogView,catalogImage} from './catalog-view.js';
import {DRAFT_STAGES,DRAFT_TABS,draftStage,draftHints,workOrder,boardItems,draftStatusLabel,draftItemLabel,draftHistory,draftEventLabel} from './draft-board.js';
const $=s=>document.querySelector(s),state={items:[],queue:{active:[],waiting:[]},priceReviews:[],selectedAsin:null};
let busy=false,stage='pending',editorBase,editorValues,batchRequest;
const selected=new Set(),archiveDialog=$('#draftArchiveDialog'),recordDialog=$('#draftRecordDialog');
const visibleItems=()=>boardItems(state.items,stage==='pending'?$('#draftPreparation').value:stage,$('#draftSearch').value);
const editDialog=$('#draftEditDialog'),editForm=$('#draftEditForm');
const editScroll=document.createElement('div');editScroll.className='draft-editor-scroll';editForm.querySelector('header').after(editScroll);while(editScroll.nextElementSibling&&editScroll.nextElementSibling.tagName!=='FOOTER')editScroll.append(editScroll.nextElementSibling);
const catalog=createCatalogView({key:'drafts',host:$('#draftDisplay'),roots:[$('#draftRows')],defaultMode:'tiles',measureLabels:['出品価格案 高い順','出品価格案 安い順'],onReorder:order=>work(async()=>{await request('/api/drafts/order',{order});await load();showTextStatus('出したい順番を保存しました。「次の下書き文面」にも反映します。');})});
let sharedEditor;const productEditor={async open(key){if(!state.capabilities?.cloud)return showTextStatus('共通の商品紐付けは販売コックピットのブラウザー版で利用できます。');if(!sharedEditor){const {createProductWorkspaceEditor}=await import('./product-workspace-editor.js');sharedEditor=createProductWorkspaceEditor({readOnly:()=>Boolean(state.capabilities?.readOnly),onChanged:load});}await sharedEditor.open(key);}};
$('#draftDisplay option[value=original]').textContent='作業順（保存済み）';$('#draftDisplay option[value=manual]').textContent='作業順（並べ替え）';
async function response(url,options={}){
 const headers=new Headers(options.headers);if(state.capabilities?.cloud&&options.method&&options.method!=='GET')headers.set('If-Match','"'+state.storage.revision+'"');
 const r=await monitorRequest(url,{...options,headers});if(!r.ok){const d=await r.json().catch(()=>({}));throw Object.assign(new Error(d.error||'操作を完了できませんでした'),{status:r.status});}return r;
}
async function request(url,body,method='POST'){return (await response(url,body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();}
function showTextStatus(message){$('#status').textContent=message;}
function controls(){$('#draftRows').inert=busy;for(const button of document.querySelectorAll('.draft-workbench button'))button.disabled=busy||Boolean(state.capabilities?.readOnly&&button.dataset.write!==undefined);for(const id of ['extensionNext','extensionSelected','copyYahooBookmarklet','copyYahooBookmarkletDraft','fetchProducts'])if(state.capabilities?.cloud)$('#'+id).disabled=true;editForm.querySelectorAll('input,select,textarea,button[type=submit]').forEach(n=>n.disabled=busy||Boolean(state.capabilities?.readOnly));if(state.capabilities?.readOnly){for(const id of ['add','draftPhotos','markDraftSaved','markListed'])$('#'+id).disabled=true;for(const b of document.querySelectorAll('.catalog-move,.catalog-drag'))b.disabled=true;}}
async function work(fn){if(busy)return;busy=true;controls();try{await fn();}catch(error){showTextStatus(error.message);$('#draftEditMessage').textContent=error.message+' 入力内容は残しています。';$('#draftArchiveMessage').textContent=error.message;if(error.status===409){archiveDialog.close();selected.clear();await load();showTextStatus('ほかの下書き編集が保存されました。最新の一覧を表示しました。編集の入力は残しています。アーカイブ対象は選び直してください。');}}finally{busy=false;controls();syncSelection();}}
async function load(){Object.assign(state,await request('/api/items'));catalog.setOrder(workOrder(state.items).map(p=>p.asin));render();}
function render(){
 const tabs=$('#summary');tabs.replaceChildren();for(const id of DRAFT_TABS){const entry=DRAFT_STAGES[id],button=document.createElement('button');button.type='button';button.dataset.draftStage=id;button.setAttribute('aria-pressed',String(stage===id));const count=id==='history'?state.items.reduce((n,i)=>n+draftHistory(i).length,0):boardItems(state.items,id).length;button.textContent=entry.label+' '+count;button.addEventListener('click',()=>{stage=id;selected.clear();$('#draftPanel').hidden=true;render();});tabs.append(button);}
 const current=DRAFT_STAGES[stage];$('#draftBoardTitle').textContent=current.title;$('#draftBoardHelp').textContent=current.help;
 const items=visibleItems(),root=$('#draftRows');root.replaceChildren();
 const history=stage==='history';root.hidden=history;$('#draftHistoryRows').hidden=!history;$('#draftDisplay').hidden=history;$('#draftSelection').hidden=history;$('#draftPreparationLabel').hidden=stage!=='pending';
 if(history){renderHistory(items);controls();return;}
 $('#draftCount').textContent=items.length+'件表示 ／ 登録全体 '+state.items.length+'件（各商品は1枚ずつ表示）';
 for(const item of items){const card=document.createElement('article');card.className='item draft-product';card.innerHTML='<div class="draft-list-photo"><img loading="lazy" referrerpolicy="no-referrer" alt="登録写真またはAmazonの商品参考画像"></div><div class="draft-list-copy"><strong></strong><p class="meta"></p><p class="draft-item-hint"></p><div class="draft-list-actions"></div></div>';const img=card.querySelector('img');img.src=catalogImage(item.displayImageUrl||item.imageUrls?.find(catalogImage))||'/catalog-image.svg';img.addEventListener('error',()=>{if(img.getAttribute('src')!=='/catalog-image.svg')img.src='/catalog-image.svg';});card.querySelector('strong').textContent=item.title||item.displayTitle||item.asin;card.querySelector('.meta').textContent=item.asin+' ／ '+draftItemLabel(item)+' ／ 出品価格案 '+yen(item.startPrice);card.querySelector('.draft-item-hint').textContent=hint(item);mountActions(card.querySelector('.draft-list-actions'),item);root.append(card);}
 if(!items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='この条件に一致する商品はありません。';root.append(empty);}
 catalog.update(root,items.map((item,index)=>({node:root.children[index],id:item.asin,title:item.title||item.displayTitle||item.asin,imageUrl:item.displayImageUrl||item.imageUrls?.find(catalogImage),imageLabel:'登録写真またはAmazonの商品参考画像',badges:[item.status==='draft_saved'&&!item.draftSaveConfirmedAt?'旧・貼り付け完了':draftStage(item)==='ready'?'準備完了':draftItemLabel(item),item.asin],metrics:[{label:'出品価格案',value:yen(item.startPrice),kind:'price'}],status:hint(item),registeredAt:item.createdAt,measure:item.startPrice,renderActions:host=>mountActions(host,item,true),onOpen:()=>openEditor(item),openLabel:'詳細・編集',openAriaLabel:(item.title||item.displayTitle||item.asin)+'の詳細・編集'})));
 controls();syncSelection();
}
const statusLabel=draftStatusLabel;
function hint(item){const missing=draftHints(item),phase=draftStage(item);return phase==='input'?(item.status==='draft_saved'?'旧・貼り付け記録：'+formatDate(item.draftSavedAt):'入力記録：'+formatDate(item.inputCompletedAt))+' ／ 保存・出品は別に確認':phase==='saved'?'保存を確認：'+formatDate(item.draftSaveConfirmedAt)+' ／ 出品済みは別に記録':phase==='listed'?'出品記録：'+formatDate(item.listedAt):phase==='archived'?'戻す先：'+draftItemLabel({...item,status:item.archivedFromStatus||'waiting_for_product_data'}):missing.length?'確認する情報：'+missing.join('・'):'写真・価格・現物を確認してから出品';}
function mountActions(host,item,compact=false){
 const label=document.createElement('label');label.className='draft-pick';const check=document.createElement('input');check.type='checkbox';check.className='draft-check';check.dataset.asin=item.asin;check.checked=selected.has(item.asin);check.setAttribute('aria-label',(item.title||item.asin)+'を選択');check.addEventListener('change',()=>{check.checked?selected.add(item.asin):selected.delete(item.asin);syncSelection();});label.append(check,document.createTextNode('選択'));host.append(label);
 const button=(text,run,write=false)=>{const b=document.createElement('button');b.type='button';b.textContent=text;if(write)b.dataset.write='';b.addEventListener('click',run);host.append(b);};
 if(!compact)button('詳細・編集',()=>openEditor(item));
 if(draftStage(item)!=='needs')button('下書き文面を確認',()=>work(()=>openDraft(item.asin)));
 const amazon=document.createElement('a');amazon.href='https://www.amazon.co.jp/dp/'+encodeURIComponent(item.asin);amazon.target='_blank';amazon.rel='noopener noreferrer';amazon.textContent='Amazon ↗';host.append(amazon);
 if(!(item.imageUrls?.length||item.displayImageUrl))button('写真を取得',()=>work(()=>fillPhotos([item.asin])),true);

 button('販路を紐付ける',()=>productEditor.open('draft:'+item.asin));
 button('履歴・整理',()=>openRecord(item));
}
function openEditor(item){editorBase=structuredClone(item);editForm.reset();for(const field of ['title','description','usedLowestPrice','status'])editForm.elements[field].value=item[field]??'';if(item.status==='draft_saved'&&!item.draftSaveConfirmedAt)editForm.elements.status.value='legacy_input';editForm.elements.imageUrls.value=(item.imageUrls||[]).join('\n');editorValues=Object.fromEntries(['title','description','usedLowestPrice','status','imageUrls'].map(k=>[k,editForm.elements[k].value]));editForm.querySelector('[data-ready]').hidden=draftStage(item)!=='needs';$('#draftEditIdentity').textContent=(item.title||item.asin)+' ／ '+item.asin;$('#draftEditMessage').textContent='状態はYahoo側の保存・出品を確認して記録してください。';const gallery=$('#draftEditPhotos');gallery.replaceChildren();for(const url of [...new Set([...(item.imageUrls||[]),item.displayImageUrl].filter(catalogImage))]){const img=document.createElement('img');img.src=url;img.alt='登録写真・商品参考画像';img.referrerPolicy='no-referrer';gallery.append(img);}$('#draftEditPrice').textContent='出品価格案：'+yen(item.startPrice)+' ／ 登録日：'+formatDate(item.createdAt);const history=$('#draftEditHistory');history.replaceChildren();for(const e of draftHistory(item,{registration:true})){const li=document.createElement('li');li.textContent=formatDate(e.at)+' ／ '+draftEventLabel(e);history.append(li);}editDialog.showModal();editDialog.querySelector('.draft-editor-scroll').scrollTop=0;}
editForm.addEventListener('submit',event=>{event.preventDefault();work(async()=>{const patch={};if(event.submitter?.dataset.ready!==undefined){if(!editForm.elements.title.value.trim()||!(Number(editForm.elements.usedLowestPrice.value)>0))throw new Error('商品名と参考価格を入力してから準備完了にしてください。');editForm.elements.status.value='ready_for_draft';}for(const [key,value] of Object.entries(editorValues))if(editForm.elements[key].value!==value)patch[key]=editForm.elements[key].value;if(!Object.keys(patch).length){$('#draftEditMessage').textContent='変更はありません。';return;}if(patch.status==='draft_saved')patch.saveConfirmed=true;await patchItem(editorBase.asin,patch);editDialog.close();showTextStatus('商品情報と作業状態を保存しました。');});});
for(const b of editForm.querySelectorAll('[data-edit-close]'))b.addEventListener('click',()=>{if(!busy)editDialog.close();});
editDialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});let editBackdrop=false;const outsideEdit=e=>{const r=editDialog.getBoundingClientRect();return e.target===editDialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};editDialog.addEventListener('pointerdown',e=>{editBackdrop=outsideEdit(e);});editDialog.addEventListener('click',e=>{if(editBackdrop&&outsideEdit(e)&&!busy)editDialog.close();editBackdrop=false;});
$('#draftSearch').addEventListener('input',()=>{selected.clear();render();});
$('#draftPreparation').addEventListener('change',()=>{selected.clear();render();});
function syncSelection(){
 const items=visibleItems(),blocked=busy||Boolean(state.capabilities?.readOnly),all=$('#draftSelectAll');
 for(const n of document.querySelectorAll('.draft-check')){n.checked=selected.has(n.dataset.asin);n.disabled=blocked;}
 all.checked=items.length>0&&items.every(i=>selected.has(i.asin));all.indeterminate=!all.checked&&items.some(i=>selected.has(i.asin));all.disabled=blocked||!items.length;
 $('#draftSelectedCount').textContent=selected.size+'件選択';$('#draftArchiveSelected').hidden=stage==='archived';$('#draftRestoreSelected').hidden=stage!=='archived';
 for(const id of ['draftArchiveSelected','draftRestoreSelected'])$('#'+id).disabled=blocked||!selected.size;
}
$('#draftSelectAll').addEventListener('change',event=>{for(const i of visibleItems())event.target.checked?selected.add(i.asin):selected.delete(i.asin);syncSelection();});
$('#draftClearSelection').addEventListener('click',()=>{selected.clear();syncSelection();});
$('#draftArchiveSelected').addEventListener('click',()=>reviewAction([...selected],'archive'));
$('#draftRestoreSelected').addEventListener('click',()=>reviewAction([...selected],'restore'));
function reviewAction(asins,action){
 if(!asins.length)return;batchRequest={asins,action};recordDialog.close();
 const restore=action==='restore';$('#draftArchiveTitle').textContent=(restore?'元の状態へ戻す':'アーカイブする')+'商品 '+asins.length+'件';
 $('#draftArchiveHelp').textContent=restore?'下記の作業状態へ戻します。旧データに元の状態が残っていない場合は「情報を補う」へ戻します。':'選んだ商品を作業一覧から外して保管します。商品名・文面・写真・保存履歴は残り、後から元の状態に戻せます。';
 const list=$('#draftArchiveItems');list.replaceChildren();for(const asin of asins){const i=state.items.find(i=>i.asin===asin),li=document.createElement('li');li.textContent=(i?.title||i?.displayTitle||asin)+' ／ '+asin+' ／ '+draftItemLabel(restore?{...i,status:i?.archivedFromStatus||'waiting_for_product_data'}:i);list.append(li);}
 $('#draftArchiveMessage').textContent='';$('#draftArchiveConfirm').textContent=asins.length+'件を'+(restore?'元の状態へ戻す':'アーカイブする');archiveDialog.showModal();
}
$('#draftArchiveCancel').addEventListener('click',()=>archiveDialog.close());
$('#draftArchiveConfirm').addEventListener('click',()=>work(async()=>{if(!batchRequest)return;const action=batchRequest.action;await request('/api/drafts/actions',batchRequest);selected.clear();archiveDialog.close();batchRequest=undefined;await load();showTextStatus(action==='restore'?'元の作業状態へ戻しました。':'アーカイブしました。「アーカイブ」から戻せます。');}));
function historyRow(item,event){
 const li=document.createElement('li'),time=document.createElement('time'),text=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p'),button=document.createElement('button');
 time.dateTime=event.at;time.textContent=formatDate(event.at);title.textContent=item.title||item.displayTitle||item.asin;detail.textContent=draftEventLabel(event)+' ／ '+item.asin+' ／ '+(event.source==='legacy'?'旧ツールからの記録':'操作の記録');text.append(title,detail);button.type='button';button.textContent='商品・履歴を開く';button.addEventListener('click',()=>openRecord(item));li.append(time,text,button);return li;
}
function renderHistory(items){
 const events=items.flatMap(item=>draftHistory(item).map(event=>({item,event}))).sort((a,b)=>Date.parse(b.event.at)-Date.parse(a.event.at)),root=$('#draftHistoryRows');root.replaceChildren();
 for(const {item,event}of events)root.append(historyRow(item,event));
 if(!events.length){const li=document.createElement('li');li.textContent='保存・出品・状態変更の記録はありません。';root.append(li);}
 $('#draftCount').textContent=events.length+'件の履歴 ／ '+items.length+'商品';
}
function openRecord(item){
 $('#draftRecordIdentity').textContent=(item.title||item.displayTitle||item.asin)+' ／ '+item.asin+' ／ 現在：'+draftItemLabel(item);
 const root=$('#draftRecordEvents');root.replaceChildren();for(const e of draftHistory(item,{registration:true})){const li=document.createElement('li');li.textContent=formatDate(e.at)+' ／ '+draftEventLabel(e)+' ／ '+(e.source==='legacy'?'旧ツールからの記録':'操作の記録');root.append(li);}
 if(!root.children.length){const li=document.createElement('li');li.textContent='保存されている日時の記録はありません。';root.append(li);}
 const actions=$('#draftRecordActions');actions.replaceChildren();const button=(label,fn,write=false)=>{const b=document.createElement('button');b.type='button';b.textContent=label;if(write)b.dataset.write='';b.addEventListener('click',fn);actions.append(b);};
 button('商品情報・作業状態を編集',()=>{recordDialog.close();openEditor(item);});
 if(draftStage(item)==='input')button('Yahoo保存済みを確認・記録',()=>work(async()=>{await patchItem(item.asin,{status:'draft_saved',saveConfirmed:true});recordDialog.close();stage='saved';render();showTextStatus('Yahoo側の下書き保存を確認済みとして記録しました。出品完了は別です。');}),true);
 if(draftStage(item)==='archived')button('元の作業状態へ戻す',()=>reviewAction([item.asin],'restore'),true);
 else{
  if(!['ready','needs'].includes(draftStage(item)))button('下書き作成待ちへ戻す',()=>work(async()=>{await patchItem(item.asin,{status:'ready_for_draft'});recordDialog.close();stage='pending';render();showTextStatus('作成待ちへ戻しました。以前の保存・出品履歴は残しています。');}),true);
  button('アーカイブする',()=>reviewAction([item.asin],'archive'),true);
 }
 recordDialog.showModal();controls();syncSelection();
}
$('#draftRecordClose').addEventListener('click',()=>recordDialog.close());
$('#draftShowAdd').addEventListener('click',()=>{$('#draftAdd').open=true;$('#asins').focus();});
$('#draftShowHelp').addEventListener('click',()=>{$('#draftHelp').open=true;$('#draftHelp').scrollIntoView({block:'start',behavior:'smooth'});});
$('#refresh').addEventListener('click',()=>work(load));
async function fillPhotos(asins){
 let success=0,failed=0;for(let start=0;start<asins.length;start+=5){showTextStatus('写真・商品名を補完中… '+Math.min(start+5,asins.length)+' / '+asins.length);const data=await request('/api/drafts/catalog',{asins:asins.slice(start,start+5)});success+=(data.results||[]).filter(r=>r.ok).length;failed+=(data.results||[]).filter(r=>!r.ok).length;Object.assign(state,data);render();}
 showTextStatus('写真・商品名の確認：補完・入力済み '+success+'件'+(failed?' ／ 取得できなかった '+failed+'件。各カードのAmazonリンクから確認し、編集で入力できます。':'')+'。説明・価格・作業状態は変更していません。');
}
$('#draftPhotos').addEventListener('click',()=>work(async()=>{const targets=boardItems(state.items,stage,$('#draftSearch').value).filter(i=>(!i.title?.trim()||i.title===i.asin)||!(i.imageUrls?.length||i.displayImageUrl)).map(i=>i.asin);if(!targets.length)return showTextStatus('写真・商品名は入力済みです。');await fillPhotos(targets);}));
$('#add').addEventListener('click',()=>work(async()=>{const entered=$('#asins').value;await request('/api/asins',{asins:entered});if($('#asins').value===entered)$('#asins').value='';await load();const ids=[...new Set(entered.split(/[\s,]+/).filter(Boolean).map(a=>a.toUpperCase()))];if(ids.length)await fillPhotos(ids);stage='pending';render();}));
$('#fetchProducts').addEventListener('click',()=>work(async()=>{const entered=$('#asins').value;await request('/api/fetch-product-data',{asins:entered});await load();showTextStatus('PC版でAmazon情報を取得しました。');}));
$('#nextDraft').addEventListener('click',()=>work(openNextDraft));
$('#closeDraft').addEventListener('click',()=>{$('#draftPanel').hidden=true;});
for(const [id,field] of [['copyTitle','#draftName'],['copyPrice','#draftPrice'],['copyText','#draftText'],['copyImages','#draftImages']])$('#'+id).addEventListener('click',()=>work(async()=>{await navigator.clipboard.writeText($(field).value);showTextStatus('コピーしました。');}));
$('#markDraftSaved').addEventListener('click',()=>work(()=>markSelected('draft_saved')));$('#markListed').addEventListener('click',()=>work(()=>markSelected('listed')));
async function markSelected(status){if(!state.selectedAsin)return;await patchItem(state.selectedAsin,{status,...(status==='draft_saved'?{saveConfirmed:true}:{})});$('#draftPanel').hidden=true;stage=status==='draft_saved'?'saved':'listed';render();showTextStatus('Yahoo側の'+(status==='draft_saved'?'下書き保存':'出品完了')+'を確認済みとして記録しました。');}
async function patchItem(asin,patch){await request('/api/items/'+encodeURIComponent(asin),patch,'PATCH');await load();}
async function openNextDraft(){const data=await request('/api/next-draft');if(!data.item)return showTextStatus('準備済みの商品はありません。「情報を補う」から準備を進めてください。');await openDraft(data.item.asin);}
async function openDraft(asin){const {draft}=await request('/api/items/'+encodeURIComponent(asin)+'/draft');state.selectedAsin=asin;$('#draftTitle').textContent=draft.asin+' ／ 出品価格案 '+yen(draft.price);$('#draftName').value=draft.title;$('#draftPrice').value=draft.price||'';$('#draftImages').value=draft.imageUrls.join('\n');$('#draftText').value=draft.description;$('#openYahoo').href=state.config?.yahooSellerUrl||'https://auctions.yahoo.co.jp/seller/';$('#draftPanel').hidden=false;$('#draftPanel').scrollIntoView({block:'start',behavior:'smooth'});$('#draftName').focus();}
const bookmarklet="javascript:(()=>{const s=document.createElement('script');s.src='http://localhost:41731/yahoo-fill.js?'+Date.now();document.body.appendChild(s);})();";
for(const id of ['copyYahooBookmarklet','copyYahooBookmarkletDraft'])$('#'+id).addEventListener('click',()=>work(async()=>{await navigator.clipboard.writeText(bookmarklet);showTextStatus('PC版のYahoo入力補助をコピーしました。');}));
function openWithExtension(asin){if(!asin)return showTextStatus('準備済みの商品を選んでください。');if(document.documentElement.dataset.asinYahooExtension!=='ready')return showTextStatus('使い方・PC版からChrome拡張の登録方法を確認してください。');document.dispatchEvent(new CustomEvent('asin-yahoo-open',{detail:{asin}}));}
$('#extensionSelected').addEventListener('click',()=>openWithExtension(state.selectedAsin));$('#extensionNext').addEventListener('click',()=>openWithExtension(state.queue.active[0]?.asin));
document.addEventListener('asin-yahoo-result',event=>showTextStatus(event.detail?.ok?'Yahooのフォームで内容を確認してください。':event.detail?.error||'出品ページを開けませんでした。'));
$("a[href='/api/export/drafts.csv']").addEventListener('click',event=>{if(!state.capabilities?.cloud)return;event.preventDefault();work(async()=>{const r=await response('/api/export/drafts.csv'),url=URL.createObjectURL(await r.blob()),link=document.createElement('a');link.href=url;link.download='drafts.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});});
const yen=value=>typeof value==='number'&&value>0?value.toLocaleString('ja-JP')+'円':'未設定';
const formatDate=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ja-JP'):'日時未設定';
await work(load);
const draftAsin=new URLSearchParams(location.hash.slice(1)).get('asin');if(draftAsin){$('#draftSearch').value=draftAsin;const item=state.items.find(i=>i.asin===draftAsin);if(item){const s=draftStage(item);stage=['ready','needs'].includes(s)?'pending':s;}render();}

function buildYahooMarketUrl(item) {
  const keyword = buildYahooMarketKeyword(item);
  return `https://auctions.yahoo.co.jp/closedsearch/closedsearch/${encodeURIComponent(keyword)}/0/`;
}

function buildYahooMarketKeyword(item) {
  const title = String(item.title || item.asin || "").trim();
  if (!title) return item.asin || "";
  const normalized = title
    .replace(/[【［\[][^】］\]]*(保証|ほしょう|送料無料|送料込み|中古|新品|未使用)[^】］\]]*[】］\]]/g, " ")
    .replace(/[【】［］\[\]（）()「」『』]/g, " ")
    .replace(/[\/_,.:;|｜+＋・]/g, " ")
    .replace(/[×]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = uniqueTokens(normalized.match(/[A-Za-z0-9][A-Za-z0-9-]{2,}|[一-龥ぁ-んァ-ヶー]{2,}/g) || []);
  const modelIndex = tokens.findIndex(isModelLikeToken);
  if (modelIndex >= 0) return buildModelKeyword(tokens, modelIndex);

  const latinName = buildLatinNameKeyword(tokens);
  if (latinName) return latinName;

  const stopWords = new Set([
    "新品", "中古", "未使用", "美品", "送料無料", "送料込み", "保証", "年保証", "付き", "付", "セット", "用", "対応",
    "大人", "子供", "キッズ", "メンズ", "レディース", "タイプ", "モデル", "サイズ", "カラー", "ブラック", "ホワイト"
  ]);
  const usefulTokens = tokens
    .map((token) => token.replace(/^\d+個$/, "").replace(/\d+年保証$/, ""))
    .filter((token) => token.length >= 2 && !stopWords.has(token))
    .slice(0, 4);
  const keyword = usefulTokens.length ? usefulTokens.join(" ") : normalized;
  return keyword.slice(0, 32).trim() || item.asin || title;
}

function isModelLikeToken(token) {
  if (isSizeLikeToken(token)) return false;
  return /[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 4;
}

function isSizeLikeToken(token) {
  return /^\d+(?:\.\d+)?(?:cm|mm|m|kg|g|ml|l|インチ|型)$/i.test(token)
    || /^\d+(?:\.\d+)?-\d+(?:\.\d+)?(?:cm|mm|m|kg|g|ml|l)$/i.test(token);
}

function buildLatinNameKeyword(tokens) {
  const latinWords = [];
  for (const token of tokens) {
    if (isSizeLikeToken(token) || isModelLikeToken(token)) continue;
    if (/^[A-Za-z]{3,}$/.test(token) && !isGenericLatinWord(token)) latinWords.push(token);
  }
  if (latinWords.length >= 2) return latinWords.slice(0, 4).join(" ");
  return "";
}

function buildModelKeyword(tokens, modelIndex) {
  const model = tokens[modelIndex];
  const prefix = [];
  for (let i = Math.max(0, modelIndex - 3); i < modelIndex; i += 1) {
    const token = tokens[i];
    if (/^[A-Za-z]{3,}$/.test(token) && !isGenericLatinWord(token)) prefix.push(token);
  }
  return [...prefix.slice(-2), model].join(" ");
}

function isGenericLatinWord(token) {
  return new Set(["with", "for", "and", "the", "new", "used", "black", "white", "size", "type", "model", "systems"]).has(token.toLowerCase());
}

function uniqueTokens(tokens) {
  const seen = new Set();
  const result = [];
  for (const token of tokens) {
    const normalized = token.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
