import {monitorRequest} from './monitor-http.js';
import {bindStockAsin} from './stock-asin-input.js';
import {createStockWorkspaceFields} from './stock-workspace-fields.js';
const fields=['title','asin','sellerSku','condition','setContents','memo','imageUrl','fbaEligibility'];
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function createProductWorkspaceEditor({readOnly=()=>false,onChanged=async()=>{}}={}){
 let dialog,form,entry,entries={},workspaceFields,asinInput,busy=false,preview,pending;
 const pendingKey='product-workspace-pending';
 try{pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');}catch{}
 async function request(path='',body,revision){
  const r=await monitorRequest('/api/product-links'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json','If-Match':'"'+revision+'"'},body:JSON.stringify(body)}),data=await r.json();
  if(!r.ok)throw Object.assign(new Error(data.error||'商品編集を完了できません'),{status:r.status});return data;
 }
 function setup(){
  if(dialog)return;
  for(const href of ['/physical-stock.css','/product-access.css'])if(!document.querySelector('link[href="'+href+'"]')){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}
  dialog=el('dialog',undefined,'stock-dialog product-workspace-dialog');dialog.setAttribute('aria-label','商品情報・販路編集');
  dialog.innerHTML='<form><header><h2>商品情報・販路編集</h2><button type="button" data-close aria-label="商品編集を閉じる">×</button></header><nav data-related-pages aria-label="この商品の登録先"></nav><div class="workspace-editor-heading"><img data-photo alt="商品参考画像"><strong data-title></strong></div><div data-edit-fields><div class="stock-form-grid"><label>ASIN（任意）<input name="asin" maxlength="2048" autocomplete="off" spellcheck="false"></label><label>SKU（任意）<input name="sellerSku" maxlength="200"></label></div><label>商品名<input name="title" required maxlength="200"></label><div class="stock-form-grid"><label>新品・中古<select name="condition"><option value="unknown">未確認</option><option value="new">新品</option><option value="used">中古</option><option value="parts">部品・現状品</option></select></label><label>在庫の用途<select name="fbaEligibility"><option value="unknown">未設定</option><option value="possible">FBAへ追加納品する在庫</option><option value="not_possible">自社発送用（FBA納品不可）</option></select></label></div><fieldset class="stock-concurrent-fields"><legend>この商品をほかの販路・販売監視にも登録</legend><label><input type="checkbox" name="alsoStock">コンテナ・自社在庫に登録する</label><section data-stock-choice hidden><strong>登録済みのコンテナ・自社在庫を選ぶ</strong><input data-stock-search type="search" placeholder="商品名・ASIN・SKUで絞り込む"><select name="stockId" hidden></select><div data-stock-options></div><small data-stock-help></small></section><label><input type="checkbox" name="alsoMerchant">Amazon自社発送にも使う</label><label><input type="checkbox" name="alsoYahoo"><span data-yahoo-label>出品済みの商品を紐付ける</span></label><label data-yahoo-url hidden>ヤフオク出品URL<input name="yahooUrl" type="url" maxlength="2048" placeholder="https://auctions.yahoo.co.jp/jp/auction/…"></label><small data-yahoo-help></small><div data-link-options></div><label><input type="checkbox" name="alsoDraft">ヤフオク出品下書きを用意する</label><small>出品済みの紐付けとは別に選べます。既存の下書きは文面・作業状態を保持します。</small><label><input type="checkbox" name="alsoPlanning">販売監視・見直しにも登録する</label><label data-plan-choice hidden>登録済みの販売監視を選ぶ<select name="planId"></select></label><small>登録済みのものを利用します。実際の出品操作は各販路で行ってください。</small></fieldset><fieldset data-location-fields><legend>場所ごとの数量</legend><div class="stock-form-grid"><label>コンテナ<input name="containerQuantity" type="number" min="0" max="1000000" step="1" placeholder="未確認"></label><label>自宅・会社<input name="homeQuantity" type="number" min="0" max="1000000" step="1" placeholder="未確認"></label></div></fieldset><label>状態・付属品・セット内容<input name="setContents" maxlength="300"></label><label>ひとことメモ<textarea name="memo" rows="3" maxlength="1000"></textarea></label><label>商品画像URL（任意）<input name="imageUrl" type="url" maxlength="2048"></label></div><section data-review hidden><h3>変更内容の確認</h3><div data-review-lines></div></section><p data-status role="status"></p><footer><button type="button" class="secondary" data-back hidden>編集に戻る</button><button type="button" class="secondary" data-close>取消</button><button type="submit" data-preview>変更内容を確認</button><button type="button" data-save hidden>この内容で保存</button></footer></form>';
  document.body.append(dialog);form=dialog.querySelector('form');workspaceFields=createStockWorkspaceFields(form);asinInput=bindStockAsin(form.elements.asin);
  for(const b of dialog.querySelectorAll('[data-close]'))b.addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog.querySelector('[data-back]').addEventListener('click',()=>{if(!pending)review(false);});
  form.addEventListener('change',()=>{if(!pending){preview=null;sync();}});
  form.addEventListener('input',()=>{if(!pending)preview=null;});
  form.addEventListener('submit',e=>{e.preventDefault();work(async()=>{
   asinInput.normalize();const command=values(),payload={command,sourceRevisions:entry.sourceRevisions};
   const data=await request('/preview',payload,entry.revision);preview={...payload,revision:entry.revision};
   const lines=dialog.querySelector('[data-review-lines]');lines.replaceChildren();
   for(const [k,v]of Object.entries(command.product))lines.append(el('p',({title:'商品名',asin:'ASIN',sellerSku:'SKU',condition:'状態',setContents:'セット内容',memo:'メモ',imageUrl:'画像URL',fbaEligibility:'用途'})[k]+'：'+v));
   for(const text of data.receipt.registrationSummary)lines.append(el('p',text));
   review(true);
  });});
  dialog.querySelector('[data-save]').addEventListener('click',()=>work(async()=>{
   const payload=pending||preview;if(!payload)throw new Error('入力内容を確認してください');
   sessionStorage.setItem(pendingKey,JSON.stringify(payload));pending=payload;controls();
   try{await request('/operations',{command:payload.command,sourceRevisions:payload.sourceRevisions,confirmed:true},payload.revision);}
   catch(error){if(error.status>=400&&error.status<500){sessionStorage.removeItem(pendingKey);pending=null;preview=null;review(false);}throw error;}
   sessionStorage.removeItem(pendingKey);pending=null;dialog.close();await onChanged();
  }));
 }
 function controls(){
  form.querySelector('[data-edit-fields]').inert=busy||Boolean(pending);
  for(const b of dialog.querySelectorAll('button'))b.disabled=busy||readOnly();
  dialog.querySelector('[data-back]').disabled=busy||Boolean(pending);
  dialog.querySelector('[data-save]').textContent=pending?'同じ操作で保存結果を確認':'この内容で保存';
 }
 function review(yes){
  form.querySelector('[data-edit-fields]').hidden=yes;form.querySelector('[data-review]').hidden=!yes;
  for(const attr of ['data-save','data-back'])form.querySelector('['+attr+']').hidden=!yes;
  form.querySelector('[data-preview]').hidden=yes;dialog.querySelector('[data-status]').textContent='';controls();
 }
 async function work(fn){if(busy||readOnly())return;busy=true;controls();try{await fn();}catch(e){dialog.querySelector('[data-status]').textContent=e.message;}finally{busy=false;controls();}}
 function selectedStock(){return entry.editor.stockId?entry.editor:entry.editor.candidates.find(c=>c.id===form.elements.stockId.value);}
 function sync(){
  const f=form.elements;for(const id of ['container','home'])f[id+'Quantity'].disabled=!f.alsoStock.checked;
  form.querySelector('[data-stock-choice]').hidden=!f.alsoStock.checked||Boolean(entry.editor.stockId);
  form.querySelector('[data-yahoo-url]').hidden=!f.alsoYahoo.checked;
  form.querySelector('[data-yahoo-help]').textContent=f.alsoYahoo.checked?'既存の出品を選ぶか、ヤフオク出品URLを入力してください。下書きは別のチェックで選択します。':'';
  form.querySelector('[data-plan-choice]').hidden=!f.alsoPlanning.checked||!f.planId.options.length;
  form.querySelector('[data-stock-help]').textContent=entry.editor.candidates.length?'候補を選ぶと、その在庫の数量を表示します。選択できない候補は理由を表示します。':'同じASINの既存在庫はありません。ASINを確認するか、新しい在庫として数量を入力してください。';
 }
 function values(){
  const product={},f=form.elements;for(const k of fields){const v=f[k].value.trim();if(v!==(entry.editor.product[k]||''))product[k]=v;}
  const workspace=workspaceFields.values(),counts={};for(const id of ['container','home'])if(f.alsoStock.checked){const v=f[id+'Quantity'].value,before=selectedStock()?.counts?.[id]??selectedStock()?.locations?.find(l=>l.locationId===id)?.usable??null;if(v===''&&before!==null)throw new Error('登録済みの数量は空欄にできません。在庫なしは0を入力してください。');if(v!==''&&Number(v)!==before)counts[id]=Number(v);}if(Object.keys(counts).length)workspace.counts=counts;
  return {operationId:crypto.randomUUID(),key:entry.key,kind:'workspace',product,workspace,stockId:f.stockId.value||entry.editor.stockId,linkIds:[...new Set([...entry.editor.linkIds,...[...form.querySelectorAll('[data-link-options] input:checked')].map(i=>i.value)])],planId:f.planId.value||undefined,registration:{draft:f.alsoDraft.checked,stock:f.alsoStock.checked,merchant:f.alsoMerchant.checked,yahoo:f.alsoYahoo.checked,planning:f.alsoPlanning.checked,yahooUrl:f.alsoYahoo.checked?f.yahooUrl.value.trim():''}};
 }
 async function open(key){
  if(readOnly())return;setup();
  try{
   entries=(await request()).entries;entry=entries[key];if(!entry?.editor)throw new Error('商品情報を読み直してください');
   if(pending&&pending.command.key!==key)throw new Error('前の商品に保存結果が未確認の操作があります。その商品の編集から確認してください。');
   form.reset();preview=null;review(false);const f=form.elements,p=entry.editor.product;
   for(const k of fields)f[k].value=p[k]||'';asinInput.refresh();
   f.asin.readOnly=entry.editor.linkIds.length>0||key.startsWith('draft:');f.sellerSku.readOnly=Boolean(p.sellerSku);f.condition.disabled=Boolean(entry.editor.stockId);f.setContents.readOnly=Boolean(entry.editor.stockId);
   for(const id of ['container','home'])f[id+'Quantity'].value=entry.editor.counts[id]??'';
   f.alsoStock.checked=Boolean(entry.editor.stockId);f.alsoStock.disabled=f.alsoStock.checked;
   f.alsoPlanning.checked=entry.editor.plans.some(p=>p.status!=='closed')||key.startsWith('plan:');f.alsoPlanning.disabled=f.alsoPlanning.checked;
   f.alsoMerchant.checked=p.useChannels.includes('merchant');f.alsoYahoo.checked=Boolean(entry.editor.yahooUrls.length);f.yahooUrl.value=entry.editor.yahooUrls[0]||'';
   form.querySelector('[data-yahoo-label]').textContent=entry.editor.yahooUrls.length?'商品紐付けに登録済み':'出品済みの商品を紐付ける';
   f.alsoDraft.checked=entry.editor.drafts.some(d=>d.associated);f.alsoDraft.disabled=f.alsoDraft.checked;
   f.stockId.replaceChildren(new Option('登録済みの在庫を選択',''));for(const c of entry.editor.candidates)f.stockId.add(new Option(c.title+' ／ '+(c.sellerSku||'SKU未指定'),c.id));
   const stockOptions=form.querySelector('[data-stock-options]'),stockSearch=form.querySelector('[data-stock-search]');stockSearch.value='';
   const drawStocks=()=>{stockOptions.replaceChildren();for(const c of entry.editor.candidates.filter(c=>[c.title,c.asin,c.sellerSku].join(' ').toLowerCase().includes(stockSearch.value.toLowerCase()))){const label=el('label',undefined,'workspace-existing-link'),img=el('img'),input=el('input'),copy=el('span');img.src=c.imageUrl||'/catalog-image.svg';img.alt='在庫商品の写真';img.width=48;img.height=48;img.referrerPolicy='no-referrer';input.type='radio';input.name='existingStock';input.value=c.id;input.checked=f.stockId.value===c.id;input.disabled=Boolean(c.issue);copy.append(el('strong',c.title),el('small',c.asin+' ／ '+(c.sellerSku||'SKU未指定')),el('small',c.issue||c.locations.map(l=>(l.locationId==='container'?'コンテナ':'自宅・会社')+' '+(l.usable??'未確認')).join(' ／ ')));label.append(input,img,copy);stockOptions.append(label);input.addEventListener('change',()=>{f.stockId.value=c.id;for(const id of ['container','home'])f[id+'Quantity'].value=c.locations.find(l=>l.locationId===id)?.usable??'';const target=entries['stock:'+c.id]?.editor,plan=target?.plans.find(p=>p.status!=='closed');if(plan){f.alsoPlanning.checked=true;f.planId.value=plan.id;}sync();});}};
   stockSearch.oninput=drawStocks;drawStocks();
   f.planId.replaceChildren(new Option('新しく販売監視へ登録',''));for(const c of [...entry.editor.plans.filter(p=>p.status!=='closed'),...entry.editor.planCandidates]){const option=new Option((c.title||p.title)+(c.issue?' ／ '+c.issue:''),c.id);option.disabled=Boolean(c.issue);f.planId.add(option);}f.planId.value=entry.editor.plans.find(p=>p.status!=='closed')?.id||'';
   const nav=form.querySelector('[data-related-pages]');nav.replaceChildren();const page=(label,url)=>{const a=el('a',label+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';nav.append(a);};
   if(entry.editor.stockId)page('コンテナ・自社在庫','/?view=stock#item='+encodeURIComponent('stock:'+entry.editor.stockId));
   for(const id of entry.editor.linkIds)page('商品紐付け','/#item='+encodeURIComponent('link:'+id));
   for(const plan of entry.editor.plans)page('販売監視','/?view=planning#id='+plan.id);
   if(entry.editor.drafts.some(d=>d.associated))page('ヤフオク出品下書き','/?view=drafts#asin='+p.asin);
   const links=form.querySelector('[data-link-options]');links.replaceChildren();
   for(const candidate of Object.values(entries).filter(e=>e.key.startsWith('link:')&&e.asin===entry.editor.product.asin&&!entry.editor.linkIds.includes(e.key.slice(5)))){
    const label=el('label',undefined,'workspace-existing-link'),input=el('input'),text=el('span',candidate.title+' ／ '+candidate.yahoo[0]?.listingId),img=el('img');img.src=candidate.imageUrl||'/catalog-image.svg';img.alt='出品商品の写真';img.width=48;img.height=48;img.referrerPolicy='no-referrer';label.append(img);const a=entry.editor.product,b=candidate.editor.product,family=v=>/^(used|中古)/i.test(v||'')?'used':/^(new|新品)/i.test(v||'')?'new':v==='parts'?'parts':'unknown',issue=a.sellerSku&&b.sellerSku&&a.sellerSku!==b.sellerSku?'SKUが異なります':family(a.condition)!=='unknown'&&family(b.condition)!=='unknown'&&family(a.condition)!==family(b.condition)?'新品・中古が異なります':a.setContents&&b.setContents&&a.setContents!==b.setContents?'セット内容が異なります':'';input.disabled=Boolean(issue);if(issue)text.append(el('small',issue));input.type='checkbox';input.value=candidate.key.slice(5);label.append(input,text);links.append(label);
    input.addEventListener('change',()=>{if(input.checked){f.alsoYahoo.checked=true;if(!f.yahooUrl.value)f.yahooUrl.value=candidate.yahoo[0]?.url||'';sync();}});
   }
   workspaceFields.populate(p,entry.live);form.querySelector('[data-title]').textContent=p.title;const photo=form.querySelector('[data-photo]');photo.src=entry.imageUrl||'/catalog-image.svg';photo.onerror=()=>{photo.onerror=null;photo.src='/catalog-image.svg';};
   sync();if(pending){preview=pending;review(true);form.querySelector('[data-review-lines]').textContent='前の保存結果を同じ操作IDで確認します。重複登録はしません。';}
   if(!dialog.open)dialog.showModal();dialog.scrollTop=0;
  }catch(e){if(dialog.open)dialog.querySelector('[data-status]').textContent=e.message;else{const notice=el('p',e.message,'product-save-notice');notice.setAttribute('role','status');document.body.append(notice);}}
 }
 return {open};
}
