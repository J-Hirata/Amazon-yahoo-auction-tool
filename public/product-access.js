import {monitorRequest} from "./monitor-http.js";
import {createInventoryPanel} from './inventory-panel.js';
import {mountProductWorkspace} from './product-workspace.js';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const amazon=asin=>/^[A-Z0-9]{10}$/.test(asin||"")?`https://www.amazon.co.jp/dp/${asin}`:"";
const yahoo=id=>/^[a-z][0-9]{6,15}$/.test(id||"")?`https://auctions.yahoo.co.jp/jp/auction/${id}`:"";
export function createProductAccess({readOnly=()=>false,onChanged=async()=>{}}={}){
 let entries={},busy=false,selected,pending,chosenKey='';const pendingKey="product-links-pending";
 try{pending=JSON.parse(sessionStorage.getItem(pendingKey)||"null");}catch{}
 const dialog=el('dialog',undefined,'product-url-dialog');dialog.setAttribute('aria-label','商品ページのURLを登録・修正');
 dialog.innerHTML='<form><header><h2>商品ページのURLを登録・修正</h2><button type="button" data-url-close aria-label="URL入力を閉じる">閉じる</button></header><p data-url-title></p><fieldset><label>Amazonの商品URL または ASIN<input name="amazon" required maxlength="2048" aria-label="Amazonの商品URL または ASIN"></label><div class="product-picker-entry"><button type="button" data-picker-open>登録済みの商品から選ぶ</button><a href="/" target="_blank" rel="noopener noreferrer">商品紐付けツールを別タブで開く</a></div><section data-product-picker hidden aria-label="登録済みの商品を選択"><header><strong data-picker-heading></strong><button type="button" data-picker-cancel aria-label="商品選択を閉じる">&times;</button></header><label>登録済みの商品を検索<input type="search" data-picker-search placeholder="商品名・ASIN・SKU・出品ID"></label><div data-picker-rows class="product-picker-rows"></div></section><div data-picker-picked hidden class="product-picker-picked"></div><div data-url-new-fields class="product-url-new-fields"><label>追加・変更するヤフオク出品<select name="replaceLinkId" aria-label="追加・変更するヤフオク出品"></select></label><label>ヤフオクの商品URL<input name="yahoo" type="url" maxlength="2048" placeholder="https://auctions.yahoo.co.jp/jp/auction/…" aria-label="ヤフオクの商品URL"></label><p>同じ商品・状態・セットのURLを登録してください。</p></div></fieldset><p data-url-message role="status" aria-live="polite"></p><footer><button type="button" data-url-close>取消</button><button type="submit" data-url-save>URLを保存</button></footer></form>';
 document.body.append(dialog);const form=dialog.querySelector('form'),message=dialog.querySelector('[data-url-message]'),save=dialog.querySelector('[data-url-save]');
 const controls=()=>{form.querySelector('fieldset').disabled=busy||Boolean(pending)||readOnly();save.disabled=busy||readOnly();save.textContent=pending?'同じ内容で保存結果を確認':chosenKey?'この商品と関連付ける':'URLを保存';for(const b of dialog.querySelectorAll('[data-url-close]'))b.disabled=busy;};
 async function request(path='',body,revision){const r=await monitorRequest('/api/product-links'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json',...(revision===undefined?{}:{'If-Match':`"${revision}"`})},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error||'商品ページのURLを読み込めません'),{status:r.status});return data;}
 async function load(){try{entries=(await request()).entries;return true;}catch{return false;}}
 function info(key,fallback={}){return entries[key]||{key,asin:fallback.asin||'',title:fallback.title||'商品',sellerSku:fallback.sellerSku||'',live:fallback.live||null,yahoo:(fallback.listingIds||[]).filter(id=>yahoo(id)).map(id=>({listingId:id,url:yahoo(id)}))};}
 function selectUrl(){form.elements.yahoo.value=selected.yahoo.find(y=>y.linkId===form.elements.replaceLinkId.value)?.url||'';}
 const picker=dialog.querySelector('[data-product-picker]'),picked=dialog.querySelector('[data-picker-picked]'),search=dialog.querySelector('[data-picker-search]'),urlFields=dialog.querySelector('[data-url-new-fields]');
 const condition=value=>({new:'新品',used:'中古',parts:'部品・現状品',unknown:'状態未確認',used_good:'中古・良い',used_very_good:'中古・非常に良い',used_like_new:'中古・ほぼ新品',used_acceptable:'中古・可',UsedGood:'中古・良い',UsedVeryGood:'中古・非常に良い',UsedLikeNew:'中古・ほぼ新品',UsedAcceptable:'中古・可'})[value]||value||'状態未確認';
 const family=value=>/^(new|新品)/i.test(value||'')?'new':/^(used|中古)/i.test(value||'')?'used':value==='parts'?'parts':'unknown';
 function mismatch(target){
  if(!selected.asin||selected.asin!==target.asin)return 'ASINが異なります';
  const a=selected.sellerSku||selected.resolvedSku,b=target.sellerSku||target.resolvedSku;
  if(a&&b&&a!==b)return 'SKUが異なります';
  if(family(selected.condition)!=='unknown'&&family(target.condition)!=='unknown'&&family(selected.condition)!==family(target.condition))return '新品・中古が異なります';
  if(selected.setContents&&target.setContents&&selected.setContents!==target.setContents)return 'セット内容を確認してください';
  return '';
 }
 function candidateDetails(target){
  const box=el('div',undefined,'product-picker-product');
  if(target.imageUrl){const img=el('img');img.src=target.imageUrl;img.alt='登録済み商品の参考画像';img.referrerPolicy='no-referrer';img.loading='lazy';img.addEventListener('error',()=>{img.hidden=true;});box.append(img);}
  const text=el('span');text.append(el('strong',target.title),el('small',[target.asin,condition(target.condition),target.sellerSku||target.resolvedSku||'SKU未指定'].filter(Boolean).join(' ／ ')));
  if(target.key.startsWith('link:'))text.append(el('small',target.yahoo.map(y=>y.listingId).join(' ／ ')));
  else {const counts=target.live?.availability?.locations||[];text.append(el('small',['container','home'].map(id=>{const n=counts.find(l=>l.locationId===id)?.usable;return (id==='container'?'コンテナ ':'会社・自宅 ')+(n===null||n===undefined?'未確認':n+'個');}).join(' ／ ')));}
  if(target.memo)text.append(el('small',target.memo,'product-picker-memo'));box.append(text);return box;
 }
 function choose(target){
  chosenKey=target.key;picker.hidden=true;picked.hidden=false;picked.replaceChildren(el('small','関連付ける登録済み商品'),candidateDetails(target));
  const cancel=el('button','選び直す');cancel.type='button';cancel.addEventListener('click',()=>showPicker(false));picked.append(cancel);urlFields.hidden=true;form.elements.yahoo.disabled=true;form.elements.replaceLinkId.disabled=true;message.textContent='';controls();
 }
 function renderCandidates(){
  const query=search.value.trim().toLowerCase(),kind=selected.key.startsWith('link:')?'stock:':'link:',rows=dialog.querySelector('[data-picker-rows]');rows.replaceChildren();
  const targets=Object.values(entries).filter(p=>p.key.startsWith(kind)&&[p.title,p.asin,p.sellerSku,p.resolvedSku,p.memo,...p.yahoo.map(y=>y.listingId)].join(' ').toLowerCase().includes(query)).sort((a,b)=>Number(b.asin===selected.asin)-Number(a.asin===selected.asin)||a.title.localeCompare(b.title,'ja'));
  for(const target of targets){const reason=mismatch(target),already=selected.key.startsWith('link:')?target.yahoo.some(y=>y.linkId===selected.key.slice(5)):selected.yahoo.some(y=>y.linkId===target.key.slice(5));
   const button=el('button',undefined,'product-picker-option');button.type='button';button.dataset.pickKey=target.key;button.append(candidateDetails(target),el('small',already?'関連付け済み':reason||'この商品を選ぶ','product-picker-result'));button.disabled=Boolean(reason||already);button.addEventListener('click',()=>choose(target));rows.append(button);
  }
  if(!targets.length)rows.append(el('p','該当する登録商品はありません。','product-picker-empty'));
 }
 function closePicker(){chosenKey='';picker.hidden=true;picked.hidden=true;urlFields.hidden=false;form.elements.yahoo.disabled=false;form.elements.replaceLinkId.disabled=false;controls();}
 function showPicker(reset=true){closePicker();picker.hidden=false;if(reset)search.value=selected.asin||'';dialog.querySelector('[data-picker-heading]').textContent=selected.key.startsWith('link:')?'関連付けるコンテナ・自社在庫':'登録済みのAmazon・ヤフオク紐付け';renderCandidates();search.focus();}
 dialog.querySelector('[data-picker-open]').addEventListener('click',()=>showPicker());dialog.querySelector('[data-picker-cancel]').addEventListener('click',closePicker);search.addEventListener('input',renderCandidates);
 async function open(key,fallback){if(busy||readOnly())return;await load();selected=info(pending?.command.key||key,fallback);form.reset();dialog.querySelector('[data-url-title]').textContent=selected.title;
  form.elements.amazon.value=selected.asin||'';form.elements.amazon.readOnly=Boolean(selected.asin);
  form.elements.replaceLinkId.replaceChildren();const options=selected.key.startsWith('link:')?selected.yahoo:[{linkId:'',listingId:'新しい出品URLを追加'},...selected.yahoo];
  for(const o of options){const option=el('option',o.listingId);option.value=o.linkId;form.elements.replaceLinkId.append(option);}
  if(selected.yahoo.length===1)form.elements.replaceLinkId.value=selected.yahoo[0].linkId||'';selectUrl();
  closePicker();
  if(pending){if(pending.command.kind==='associate-existing'){if(entries[pending.command.targetKey])choose(entries[pending.command.targetKey]);}else{form.elements.amazon.value=pending.command.amazon;form.elements.yahoo.value=pending.command.yahoo;form.elements.replaceLinkId.value=pending.command.replaceLinkId;}}
  message.textContent=selected.revision===undefined?'登録画面を読み込めませんでした。保存済みリンクから確認し、一覧を更新してから開き直してください。':'';controls();if(!dialog.open)dialog.showModal();
 }
 form.elements.replaceLinkId.addEventListener('change',selectUrl);
 form.addEventListener('submit',async event=>{event.preventDefault();if(busy||readOnly())return;
  if(!pending){if(selected.revision===undefined){message.textContent='URL登録画面を読み直してください';return;}const command=chosenKey?{operationId:crypto.randomUUID(),key:selected.key,kind:'associate-existing',targetKey:chosenKey,confirmed:true}:{operationId:crypto.randomUUID(),key:selected.key,amazon:form.elements.amazon.value.trim(),yahoo:form.elements.yahoo.value.trim(),replaceLinkId:form.elements.replaceLinkId.value};pending={command,sourceRevisions:selected.sourceRevisions,revision:selected.revision};try{sessionStorage.setItem(pendingKey,JSON.stringify(pending));}catch{pending=null;message.textContent='保存受付をブラウザに記録できませんでした';return;}}
  busy=true;controls();message.textContent='URLと商品の関連付けを保存しています…';
  try{await request('/operations',{command:pending.command,sourceRevisions:pending.sourceRevisions},pending.revision);pending=null;sessionStorage.removeItem(pendingKey);await load();dialog.close();await onChanged();}
  catch(e){if(e.status>=400&&e.status<500){pending=null;sessionStorage.removeItem(pendingKey);await load();selected=info(selected.key);message.textContent=e.message+' 入力を確認してから保存してください。';}else message.textContent='保存結果を確認できません。同じ内容で保存結果を確認してください。';}
  finally{busy=false;controls();}
 });
 for(const b of dialog.querySelectorAll('[data-url-close]'))b.addEventListener('click',()=>dialog.close());
 async function refresh(button){if(busy||readOnly())return;busy=true;button.disabled=true;const old=button.textContent;button.textContent='取得中…';try{await request('/refresh',{});await load();await onChanged();}catch(e){const note=el('small',e.message,'product-access-note');button.parentElement?.append(note);}finally{busy=false;button.disabled=false;button.textContent=old;}}
 const inventory=createInventoryPanel({request,load,info,onChanged,readOnly});
 function mount(host,key,fallback={}){
  const p=info(key,fallback);host.classList.add('product-access');host.setAttribute('aria-label','商品ページとURLの登録');host.replaceChildren();
  inventory.mount(host,p,{key,fallback,editUrl:()=>open(key,fallback),refresh,amazonUrl:amazon(p.asin)});
  mountProductWorkspace(host,p);
 }
 return {load,info,mount,open};
}
