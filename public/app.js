import {monitorRequest} from './monitor-http.js';
import {createCatalogView,catalogImage} from './catalog-view.js';
import {DRAFT_STAGES,draftStage,draftHints,workOrder,boardItems} from './draft-board.js';
const $=s=>document.querySelector(s),state={items:[],queue:{active:[],waiting:[]},priceReviews:[],selectedAsin:null};
let busy=false,stage='pending',editorBase,editorValues;
const editDialog=$('#draftEditDialog'),editForm=$('#draftEditForm');
const catalog=createCatalogView({key:'drafts',host:$('#draftDisplay'),roots:[$('#draftRows')],defaultMode:'tiles',measureLabels:['出品価格案 高い順','出品価格案 安い順'],onReorder:order=>work(async()=>{await request('/api/drafts/order',{order});await load();showTextStatus('出したい順番を保存しました。「次の下書き文面」にも反映します。');})});
$('#draftDisplay option[value=original]').textContent='作業順（保存済み）';$('#draftDisplay option[value=manual]').textContent='作業順（並べ替え）';
async function response(url,options={}){
 const headers=new Headers(options.headers);if(state.capabilities?.cloud&&options.method&&options.method!=='GET')headers.set('If-Match','"'+state.storage.revision+'"');
 const r=await monitorRequest(url,{...options,headers});if(!r.ok){const d=await r.json().catch(()=>({}));throw Object.assign(new Error(d.error||'操作を完了できませんでした'),{status:r.status});}return r;
}
async function request(url,body,method='POST'){return (await response(url,body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();}
function showTextStatus(message){$('#status').textContent=message;}
function controls(){$('#draftRows').inert=busy;for(const button of document.querySelectorAll('.draft-workbench button'))button.disabled=busy||Boolean(state.capabilities?.readOnly&&button.dataset.write!==undefined);for(const id of ['extensionNext','extensionSelected','copyYahooBookmarklet','copyYahooBookmarkletDraft','fetchProducts'])if(state.capabilities?.cloud)$('#'+id).disabled=true;editForm.querySelectorAll('input,select,textarea,button[type=submit]').forEach(n=>n.disabled=busy||Boolean(state.capabilities?.readOnly));if(state.capabilities?.readOnly){for(const id of ['add','draftPhotos','markDraftSaved','markListed'])$('#'+id).disabled=true;for(const b of document.querySelectorAll('.catalog-move,.catalog-drag'))b.disabled=true;}}
async function work(fn){if(busy)return;busy=true;controls();try{await fn();}catch(error){showTextStatus(error.message);$('#draftEditMessage').textContent=error.message+' 入力内容は残しています。';if(error.status===409){await load();showTextStatus('ほかの下書き編集が保存されました。最新の一覧を表示しました。編集の入力は残しています。内容を確認して再度保存してください。');}}finally{busy=false;controls();}}
async function load(){Object.assign(state,await request('/api/items'));catalog.setOrder(workOrder(state.items).map(p=>p.asin));render();}
function render(){
 const tabs=$('#summary');tabs.replaceChildren();for(const [id,entry] of Object.entries(DRAFT_STAGES)){const button=document.createElement('button');button.type='button';button.dataset.draftStage=id;button.setAttribute('aria-pressed',String(stage===id));const count=boardItems(state.items,id).length;button.textContent=entry.label+' '+count;button.addEventListener('click',()=>{stage=id;render();});tabs.append(button);}
 const current=DRAFT_STAGES[stage];$('#draftBoardTitle').textContent=current.title;$('#draftBoardHelp').textContent=current.help;
 const items=boardItems(state.items,stage,$('#draftSearch').value),root=$('#draftRows');root.replaceChildren();
 $('#draftCount').textContent=items.length+'件表示 ／ 登録全体 '+state.items.length+'件（各商品は1枚ずつ表示）';
 for(const item of items){const card=document.createElement('article');card.className='item draft-product';card.innerHTML='<div class="draft-list-photo"><img loading="lazy" referrerpolicy="no-referrer" alt="登録写真またはAmazonの商品参考画像"></div><div class="draft-list-copy"><strong></strong><p class="meta"></p><p class="draft-item-hint"></p><div class="draft-list-actions"></div></div>';const img=card.querySelector('img');img.src=catalogImage(item.displayImageUrl||item.imageUrls?.find(catalogImage))||'/catalog-image.svg';img.addEventListener('error',()=>{if(img.getAttribute('src')!=='/catalog-image.svg')img.src='/catalog-image.svg';});card.querySelector('strong').textContent=item.title||item.displayTitle||item.asin;card.querySelector('.meta').textContent=item.asin+' ／ '+statusLabel(item.status)+' ／ 出品価格案 '+yen(item.startPrice);card.querySelector('.draft-item-hint').textContent=hint(item);mountActions(card.querySelector('.draft-list-actions'),item);root.append(card);}
 if(!items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='この条件に一致する商品はありません。';root.append(empty);}
 catalog.update(root,items.map((item,index)=>({node:root.children[index],id:item.asin,title:item.title||item.displayTitle||item.asin,imageUrl:item.displayImageUrl||item.imageUrls?.find(catalogImage),imageLabel:'登録写真またはAmazonの商品参考画像',badges:[statusLabel(item.status),item.asin],metrics:[{label:'出品価格案',value:yen(item.startPrice),kind:'price'}],status:hint(item),registeredAt:item.createdAt,measure:item.startPrice,renderActions:host=>mountActions(host,item,true)})));
 controls();
}
function statusLabel(status){return {waiting_for_product_data:'情報を補う',ready_for_draft:'出品準備できた',draft_saved:'保存済み・出品未記録',listed:'出品済み（手動記録）',sold:'売却済み',archived:'保留',deleted:'除外'}[status]||'情報を補う';}
function hint(item){const missing=draftHints(item);return draftStage(item)==='saved'?'保存記録：'+formatDate(item.draftSavedAt)+' ／ 出品済みは別に記録':draftStage(item)==='listed'?'出品記録：'+formatDate(item.listedAt):missing.length?'確認する情報：'+missing.join('・'):'写真・価格・現物を確認してから出品';}
function mountActions(host,item,compact=false){
 const button=(text,run,write=false)=>{const b=document.createElement('button');b.type='button';b.textContent=text;if(write)b.dataset.write='';b.addEventListener('click',run);host.append(b);};
 button(draftStage(item)==='needs'?'情報を入力・編集':'文面・作業を開く',()=>draftStage(item)==='needs'?openEditor(item):work(()=>openDraft(item.asin)));
 const amazon=document.createElement('a');amazon.href='https://www.amazon.co.jp/dp/'+encodeURIComponent(item.asin);amazon.target='_blank';amazon.rel='noopener noreferrer';amazon.textContent='Amazon ↗';host.append(amazon);
 if(!(item.imageUrls?.length||item.displayImageUrl))button('写真を取得',()=>work(()=>fillPhotos([item.asin])),true);
 if(draftStage(item)!=='needs')button(compact?'編集・状態':'商品情報・作業状態',()=>openEditor(item));
}
function openEditor(item){editorBase=structuredClone(item);editForm.reset();for(const field of ['title','description','usedLowestPrice','status'])editForm.elements[field].value=item[field]??'';editForm.elements.imageUrls.value=(item.imageUrls||[]).join('\n');editorValues=Object.fromEntries(['title','description','usedLowestPrice','status','imageUrls'].map(k=>[k,editForm.elements[k].value]));editForm.querySelector('[data-ready]').hidden=draftStage(item)!=='needs';$('#draftEditIdentity').textContent=(item.title||item.asin)+' ／ '+item.asin;$('#draftEditMessage').textContent='状態はYahoo側の保存・出品を確認して記録してください。';editDialog.showModal();}
editForm.addEventListener('submit',event=>{event.preventDefault();work(async()=>{const patch={};if(event.submitter?.dataset.ready!==undefined){if(!editForm.elements.title.value.trim()||!(Number(editForm.elements.usedLowestPrice.value)>0))throw new Error('商品名と参考価格を入力してから準備完了にしてください。');editForm.elements.status.value='ready_for_draft';}for(const [key,value] of Object.entries(editorValues))if(editForm.elements[key].value!==value)patch[key]=editForm.elements[key].value;if(!Object.keys(patch).length){$('#draftEditMessage').textContent='変更はありません。';return;}await patchItem(editorBase.asin,patch);editDialog.close();showTextStatus('商品情報と作業状態を保存しました。');});});
for(const b of editForm.querySelectorAll('[data-edit-close]'))b.addEventListener('click',()=>editDialog.close());
$('#draftSearch').addEventListener('input',render);
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
async function markSelected(status){if(!state.selectedAsin)return;await patchItem(state.selectedAsin,{status});$('#draftPanel').hidden=true;stage=status==='draft_saved'?'saved':'listed';render();showTextStatus('Yahoo側の'+(status==='draft_saved'?'下書き保存':'出品完了')+'を確認済みとして記録しました。');}
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
