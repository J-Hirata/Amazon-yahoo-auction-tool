import {monitorRequest} from './monitor-http.js';
import {bindStockAsin} from './stock-asin-input.js';
import {createStockWorkspaceFields} from './stock-workspace-fields.js';
import {createProductPicker} from './workspace-product-picker.js';
const fields=['title','asin','sellerSku','condition','setContents','memo','imageUrl','fbaEligibility'];
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function createProductWorkspaceEditor({readOnly=()=>false,onChanged=async()=>{}}={}){
 let dialog,form,entry,entries={},workspaceFields,asinInput,busy=false,preview,pending,pickers=[],chosenLinkIds=new Set(),merchantSku='';
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
  dialog.innerHTML='<form><header><h2>商品情報・販路編集</h2><button type="button" data-close aria-label="商品編集を閉じる">×</button></header><nav data-related-pages aria-label="この商品の登録先"></nav><div class="workspace-editor-heading"><img data-photo alt="商品参考画像"><strong data-title></strong></div><div data-edit-fields><div class="stock-form-grid"><label>ASIN（任意）<input name="asin" maxlength="2048" autocomplete="off" spellcheck="false"></label><label>SKU（任意）<input name="sellerSku" maxlength="200"></label></div><label>商品名<input name="title" required maxlength="200"></label><div class="stock-form-grid"><label>新品・中古<select name="condition"><option value="unknown">未確認</option><option value="new">新品</option><option value="used">中古</option><option value="parts">部品・現状品</option></select></label><label>在庫の用途<select name="fbaEligibility"><option value="unknown">未設定</option><option value="possible">FBAへ追加納品する在庫</option><option value="not_possible">自社発送用（FBA納品不可）</option></select></label></div><fieldset class="stock-concurrent-fields"><legend>この商品をほかの販路・販売監視にも登録</legend><label><input type="checkbox" name="alsoStock">コンテナ・自社在庫に登録する</label><section data-stock-choice hidden><select name="stockId" hidden></select><div data-stock-picker></div></section><p data-stock-registered hidden></p><label><input type="checkbox" name="alsoMerchant"><span data-merchant-label>Amazon自社発送の出品を紐付ける</span></label><section data-merchant-choice hidden><p data-merchant-help></p><button type="button" class="secondary" data-merchant-refresh>Amazonの自社発送出品を取得・更新</button><div data-merchant-picker></div></section><label><input type="checkbox" name="alsoYahoo"><span data-yahoo-label>出品済みの商品を紐付ける</span></label><label data-yahoo-url hidden>ヤフオク出品URL<input name="yahooUrl" type="url" maxlength="2048" placeholder="https://auctions.yahoo.co.jp/jp/auction/…"></label><small data-yahoo-help></small><div data-yahoo-registered hidden></div><div data-link-options></div><label><input type="checkbox" name="alsoDraft">ヤフオク出品下書きを用意する</label><small>出品済みの紐付けとは別に選べます。既存の下書きは文面・作業状態を保持します。</small><label><input type="checkbox" name="alsoPlanning">販売監視・見直しにも登録する</label><p data-plan-registered hidden></p><section data-plan-choice hidden><select name="planId" hidden></select><div data-plan-picker></div></section><small>登録済みのものを利用します。実際の出品操作は各販路で行ってください。</small></fieldset><fieldset data-location-fields><legend>場所ごとの数量</legend><div class="stock-form-grid"><label>コンテナ<input name="containerQuantity" type="number" min="0" max="1000000" step="1" placeholder="未確認"></label><label>自宅・会社<input name="homeQuantity" type="number" min="0" max="1000000" step="1" placeholder="未確認"></label></div></fieldset><label>状態・付属品・セット内容<input name="setContents" maxlength="300"></label><label>ひとことメモ<textarea name="memo" rows="3" maxlength="1000"></textarea></label><label>商品画像URL（任意）<input name="imageUrl" type="url" maxlength="2048"></label></div><section data-review hidden><h3>変更内容の確認</h3><div data-review-lines></div></section><p data-status role="status"></p><footer><button type="button" class="secondary" data-back hidden>編集に戻る</button><button type="button" class="secondary" data-close>取消</button><button type="submit" data-preview>変更内容を確認</button><button type="button" data-save hidden>この内容で保存</button></footer></form>';
  document.body.append(dialog);form=dialog.querySelector('form');
  // Header and actions stay reachable while only the long form body scrolls.
  const scroll=el('div',undefined,'workspace-editor-scroll'),footer=form.querySelector('footer');form.querySelector('header').after(scroll);
  while(scroll.nextElementSibling&&scroll.nextElementSibling!==footer)scroll.append(scroll.nextElementSibling);
  footer.querySelector('[data-close]').textContent='保存せず閉じる';
  form.querySelector('[data-merchant-refresh]').addEventListener('click',()=>work(async()=>{
   asinInput.normalize();const key=entry.key;await request('/merchant-options',{command:{key,asin:form.elements.asin.value},sourceRevisions:entry.sourceRevisions},entry.revision);
   const updated=(await request()).entries[key];if(!updated?.editor)throw new Error('対象商品を読み直してください');
   const unchanged=['title','asin','sellerSku','condition','setContents','memo','fbaEligibility'].every(k=>updated.editor.product[k]===entry.editor.product[k])&&JSON.stringify(updated.editor.counts)===JSON.stringify(entry.editor.counts)&&JSON.stringify(updated.editor.sources)===JSON.stringify(entry.editor.sources);
   if(!unchanged)throw new Error('商品情報が別の操作で更新されました。入力内容は残しています。最新の商品情報を確認してください。');
   entries[key]=updated;entry=updated;for(const picker of pickers)picker.draw();form.querySelector('[data-merchant-help]').textContent='Amazonの自社発送出品を更新しました。商品を選んで確認・保存してください。';
  }));
  const linkSection=form.querySelector('[data-link-options]');linkSection.innerHTML='<div data-link-picker></div>';
  workspaceFields=createStockWorkspaceFields(form);asinInput=bindStockAsin(form.elements.asin);
  for(const b of dialog.querySelectorAll('[data-close]'))b.addEventListener('click',()=>{if(!busy)dialog.close();});
  let backdropStart=false;
  const outside=e=>{const r=dialog.getBoundingClientRect();return e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',e=>{backdropStart=outside(e);});
  dialog.addEventListener('click',e=>{if(backdropStart&&outside(e)&&!busy)dialog.close();backdropStart=false;});
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog.querySelector('[data-back]').addEventListener('click',()=>{if(!pending)review(false);});
  form.addEventListener('change',()=>{if(!pending){preview=null;sync();}});
  form.addEventListener('input',()=>{if(!pending)preview=null;});
  for(const name of ['asin','sellerSku','condition','setContents'])form.elements[name].addEventListener('input',()=>{if(!pending)for(const picker of pickers)picker.draw();});
  form.elements.asin.addEventListener('blur',()=>{for(const picker of pickers)picker.draw();});
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
  const linked=entry.editor.linkIds.length>0;
  form.querySelector('[data-yahoo-url]').hidden=!f.alsoYahoo.checked||linked;
  form.querySelector('[data-yahoo-registered]').hidden=!linked;
  form.querySelector('[data-stock-registered]').hidden=!entry.editor.stockId;
  form.querySelector('[data-plan-registered]').hidden=!entry.editor.plans.some(p=>p.status!=='closed');
  form.querySelector('[data-merchant-choice]').hidden=!f.alsoMerchant.checked;
  form.querySelector('[data-yahoo-help]').textContent=f.alsoYahoo.checked&&!linked?'既存の出品を選ぶか、ヤフオク出品URLを入力してください。下書きは別のチェックで選択します。':'';
  form.querySelector('[data-plan-choice]').hidden=!f.alsoPlanning.checked||entry.editor.plans.some(p=>p.status!=='closed');
  form.querySelector('[data-link-options]').hidden=linked||!f.alsoYahoo.checked||!Object.keys(entries).some(key=>key.startsWith('link:')&&!entry.editor.linkIds.includes(key.slice(5)));
 }
 function values(){
  const product={},f=form.elements;for(const k of fields){const v=f[k].value.trim();if(v!==(entry.editor.product[k]||''))product[k]=v;}
  const workspace=workspaceFields.values(),counts={};for(const id of ['container','home'])if(f.alsoStock.checked){const v=f[id+'Quantity'].value,before=selectedStock()?.counts?.[id]??selectedStock()?.locations?.find(l=>l.locationId===id)?.usable??null;if(v===''&&before!==null)throw new Error('登録済みの数量は空欄にできません。在庫なしは0を入力してください。');if(v!==''&&Number(v)!==before)counts[id]=Number(v);}if(Object.keys(counts).length)workspace.counts=counts;
  return {operationId:crypto.randomUUID(),key:entry.key,kind:'workspace',product,workspace,merchantSellerSku:f.alsoMerchant.checked?merchantSku:'',stockId:f.stockId.value||entry.editor.stockId,linkIds:[...new Set([...entry.editor.linkIds,...(f.alsoYahoo.checked?chosenLinkIds:[])])],planId:f.planId.value||undefined,registration:{draft:f.alsoDraft.checked,stock:f.alsoStock.checked,merchant:f.alsoMerchant.checked,yahoo:f.alsoYahoo.checked,planning:f.alsoPlanning.checked,yahooUrl:f.alsoYahoo.checked&&!entry.editor.linkIds.length?f.yahooUrl.value.trim():''}};
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
   merchantSku=entry.editor.merchant?.sellerSku||'';f.alsoMerchant.checked=Boolean(merchantSku||entry.editor.merchant?.conflict);f.alsoMerchant.disabled=f.alsoMerchant.checked;f.alsoYahoo.checked=Boolean(entry.editor.yahooUrls.length);f.alsoYahoo.disabled=f.alsoYahoo.checked;f.yahooUrl.value=entry.editor.yahooUrls[0]||'';
   form.querySelector('[data-stock-registered]').textContent=entry.editor.stockId?'登録済み：'+p.title:'';
   form.querySelector('[data-plan-registered]').textContent='登録済み：'+entry.editor.plans.filter(p=>p.status!=='closed').map(p=>p.title).join(' ／ ');
   const registeredYahoo=form.querySelector('[data-yahoo-registered]');registeredYahoo.replaceChildren();for(const y of entry.yahoo){const a=el('a','ヤフオク出品 '+y.listingId+' ↗');a.href=y.url;a.target='_blank';a.rel='noopener noreferrer';registeredYahoo.append(a);}
   form.querySelector('[data-merchant-label]').textContent=merchantSku?'Amazon自社発送に紐付け済み':'Amazon自社発送の出品を紐付ける';
   form.querySelector('[data-merchant-help]').textContent=entry.editor.merchant?.conflict?'関連先で自社発送のSKUが異なります。正しい出品を選んで共通の紐付けにしてください。':'Amazonに登録済みの自社発送出品を選びます。FBAのSKUとは別に保存します。候補がない場合は出品情報を取得してください。';
   form.querySelector('[data-yahoo-label]').textContent=entry.editor.yahooUrls.length?'商品紐付けに登録済み':'出品済みの商品を紐付ける';
   f.alsoDraft.checked=entry.editor.drafts.some(d=>d.associated);f.alsoDraft.disabled=f.alsoDraft.checked;
   f.stockId.replaceChildren(new Option('登録済みの在庫を選択',''));for(const c of entry.editor.candidates)f.stockId.add(new Option(c.title+' ／ '+(c.sellerSku||'SKU未指定'),c.id));
   const planChoices=[...entry.editor.plans.filter(c=>c.status!=='closed').map(c=>({...c,...(entries['plan:'+c.id]?.editor.product||p)})),...entry.editor.planCandidates];
   f.planId.replaceChildren(new Option('新しく販売監視へ登録',''));for(const c of planChoices)f.planId.add(new Option(c.title,c.id));f.planId.value=entry.editor.plans.find(c=>c.status!=='closed')?.id||'';
   chosenLinkIds=new Set();
   const current=()=>Object.fromEntries(['asin','sellerSku','condition','setContents'].map(k=>[k,f[k].value.trim()]));
   const fillMissing=c=>{for(const k of ['asin','sellerSku'])if(!f[k].value.trim()&&c[k]&&!f[k].readOnly)f[k].value=c[k];if(f.condition.value==='unknown'&&c.condition)f.condition.value=c.condition;asinInput.refresh();};
   const refreshPickers=()=>{for(const picker of pickers)picker.draw();sync();};
   pickers=[];
   const merchantProducts=()=>{const list=[...(entry.editor.merchantChoices||[])];if(merchantSku===entry.editor.merchant?.sellerSku&&merchantSku&&!list.some(c=>c.sellerSku===merchantSku&&c.asin===p.asin))list.unshift({id:JSON.stringify([p.asin,merchantSku]),asin:p.asin,sellerSku:merchantSku,title:p.title,condition:p.condition,imageUrl:p.imageUrl,detail:'紐付け済み・出品状況は取得ボタンで更新できます'});return list;};
   pickers.push(createProductPicker(form.querySelector('[data-merchant-picker]'),{label:'Amazon自社発送の登録済み出品',products:merchantProducts,source:()=>({...current(),sellerSku:''}),selected:()=>merchantSku?[JSON.stringify([f.asin.value,merchantSku])]:[],onSelect:c=>{merchantSku=c.sellerSku;if(!f.asin.value&&!f.asin.readOnly)f.asin.value=c.asin;if(f.condition.value==='unknown')f.condition.value=c.condition;asinInput.refresh();refreshPickers();}}));
   pickers.push(createProductPicker(form.querySelector('[data-stock-picker]'),{label:'登録済みのコンテナ・自社在庫',products:()=>entry.editor.candidates.map(c=>({...c,detail:c.locations.map(l=>(l.locationId==='container'?'コンテナ':'自宅・会社')+' '+(l.usable??'未確認')).join(' ／ ')})),source:current,selected:()=>[f.stockId.value].filter(Boolean),onSelect:c=>{
    f.stockId.value=c.id;fillMissing(c);for(const id of ['container','home'])f[id+'Quantity'].value=c.locations.find(l=>l.locationId===id)?.usable??'';
    const relatedMerchant=entries['stock:'+c.id]?.editor.merchant;if(relatedMerchant?.sellerSku||relatedMerchant?.conflict){if(merchantSku&&relatedMerchant.sellerSku&&merchantSku!==relatedMerchant.sellerSku){merchantSku='';form.querySelector('[data-merchant-help]').textContent='元の商品と選んだ在庫で自社発送SKUが異なります。正しい出品を選んでください。';}else merchantSku=relatedMerchant.sellerSku;f.alsoMerchant.checked=true;f.alsoMerchant.disabled=true;}
    const plan=entries['stock:'+c.id]?.editor.plans.find(p=>p.status!=='closed');if(plan&&!entry.editor.plans.some(p=>p.status!=='closed')){f.alsoPlanning.checked=true;f.planId.value=plan.id;}refreshPickers();
   }}));
   pickers.push(createProductPicker(form.querySelector('[data-plan-picker]'),{label:'登録済みの販売監視',products:()=>planChoices,source:current,selected:()=>[f.planId.value].filter(Boolean),onSelect:c=>{f.planId.value=c.id;fillMissing(c);refreshPickers();}}));
   const nav=form.querySelector('[data-related-pages]');nav.replaceChildren();const page=(label,url)=>{const a=el('a',label+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';nav.append(a);};
   if(entry.editor.stockId)page('コンテナ・自社在庫','/?view=stock#item='+encodeURIComponent('stock:'+entry.editor.stockId));
   for(const id of entry.editor.linkIds)page('商品紐付け','/#item='+encodeURIComponent('link:'+id));
   for(const plan of entry.editor.plans)page('販売監視','/?view=planning#id='+plan.id);
   if(entry.editor.drafts.some(d=>d.associated))page('ヤフオク出品下書き','/?view=drafts#asin='+p.asin);
   const linkChoices=Object.values(entries).filter(e=>e.key.startsWith('link:')&&!entry.editor.linkIds.includes(e.key.slice(5))).map(e=>({...e.editor.product,id:e.key.slice(5),title:e.title,imageUrl:e.imageUrl,listingId:e.yahoo[0]?.listingId,url:e.yahoo[0]?.url}));
   pickers.push(createProductPicker(form.querySelector('[data-link-picker]'),{label:'登録済みのヤフオク出品',products:()=>linkChoices,source:current,selected:()=>[...chosenLinkIds],multiple:true,onSelect:(c,checked)=>{
    if(checked){chosenLinkIds.add(c.id);fillMissing(c);}else chosenLinkIds.delete(c.id);refreshPickers();
   }}));
   workspaceFields.populate(p,entry.live);form.querySelector('[data-title]').textContent=p.title;const photo=form.querySelector('[data-photo]');photo.src=p.imageUrl||entry.imageUrl||'/catalog-image.svg';photo.onerror=()=>{photo.onerror=null;photo.src='/catalog-image.svg';};
   sync();if(pending){preview=pending;review(true);form.querySelector('[data-review-lines]').textContent='前の保存結果を同じ操作IDで確認します。重複登録はしません。';}
   if(!dialog.open)dialog.showModal();dialog.querySelector('.workspace-editor-scroll').scrollTop=0;
  }catch(e){if(dialog.open)dialog.querySelector('[data-status]').textContent=e.message;else{const notice=el('p',e.message,'product-save-notice');notice.setAttribute('role','status');document.body.append(notice);}}
 }
 return {open};
}
