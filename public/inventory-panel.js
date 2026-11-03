const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const amount=(q,unit='個')=>Number.isSafeInteger(q)&&q>=0?`${q}${unit}`:'未確認';
const time=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認';
const family=v=>/^(new|新品)/i.test(v||'')?'new':/^(used|中古)/i.test(v||'')?'used':'unknown';
const merchantOnly=p=>p?.live?.channels?.fba?.state==='absent'&&['active','inactive'].includes(p?.live?.channels?.merchant?.state);
export function createInventoryPanel({request,load,info,onChanged,readOnly}){
 let selected,pending,busy=false,lastSku='',manualAllowed=true;const storageKey='inventory-review-pending';
 try{pending=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
 const dialog=el('dialog',undefined,'product-url-dialog inventory-dialog');dialog.setAttribute('aria-label','SKUとFBA在庫の確認');
 dialog.innerHTML='<form><header><h2>SKUとFBA在庫の確認</h2><button type="button" data-close>閉じる</button></header><p data-title></p><fieldset><div data-options role="group" aria-label="自社の出品SKU候補"></div><label>対応するAmazon SKU<input name="sellerSku" list="inventory-sku-options" maxlength="200" placeholder="SKUを選択・手入力"><datalist id="inventory-sku-options"></datalist></label><p data-automatic role="status"></p><label>FBA在庫の手入力<input name="manualFbaQuantity" type="number" min="0" max="1000000" step="1" placeholder="未確認なら空欄"></label><p data-manual-note>未取得時の補助値（自動取得を優先）。空欄：未確認／0：在庫なし</p></fieldset><p data-message role="status"></p><footer><button type="button" data-close>取消</button><button type="submit" data-save>確認内容を保存</button></footer></form>';
 document.body.append(dialog);const form=dialog.querySelector('form'),message=dialog.querySelector('[data-message]');
 function controls(){form.querySelector('fieldset').disabled=busy||Boolean(pending)||readOnly();form.elements.manualFbaQuantity.disabled=!manualAllowed;form.querySelector('[data-save]').disabled=busy||readOnly();form.querySelector('[data-save]').textContent=pending?'同じ内容で保存結果を確認':'確認内容を保存';dialog.querySelectorAll('[data-close]').forEach(b=>b.disabled=busy);}
 function mismatched(option){const expected=family(selected?.live?.availability?.condition),actual=family(option?.conditionKey||option?.condition);return expected!=='unknown'&&actual!=='unknown'&&expected!==actual;}
 function optionSummary(o){return [o.condition,o.sellable?'販売中':'販売停止・販売不可',o.fba?'FBA '+amount(o.fbaQuantity):'',o.merchant?'自社発送販売数 '+amount(o.merchantQuantity):''].filter(Boolean).join('／');}
 function syncSku(){
  const value=form.elements.sellerSku.value.trim(),option=selected?.live?.skuOptions?.find(o=>o.sellerSku===value);
  if(value!==lastSku){form.elements.manualFbaQuantity.value='';lastSku=value;}
  for(const radio of form.querySelectorAll('[name=skuCandidate]'))radio.checked=radio.value===value;
  manualAllowed=!(option?.merchant&&!option.fba||!value&&merchantOnly(selected));
  if(!manualAllowed)form.elements.manualFbaQuantity.value='';
  form.querySelector('[data-automatic]').textContent=option?optionSummary(option):value?'このSKUの自動取得数は未確認':'対象SKUは未選択';
  form.querySelector('[data-manual-note]').textContent=manualAllowed?'未取得時の補助値（自動取得を優先）。空欄：未確認／0：在庫なし':'自社発送のSKUです。自社発送販売数とFBA在庫は別の数量です。';controls();
 }
 async function open(key,fallback){if(busy||readOnly())return;if(!await load()){selected={};message.textContent='最新の在庫情報を取得できません。閉じてから再度開いてください。';controls();form.querySelector('[data-save]').disabled=true;dialog.showModal();return;}selected=info(pending?.command.key||key,fallback);form.reset();dialog.querySelector('[data-title]').textContent=selected.title;
  form.elements.sellerSku.value=pending?.command.sellerSku??selected.sellerSku??'';form.elements.manualFbaQuantity.value=pending?(pending.command.manualFbaQuantity??''):(selected.manualReview?.manualFbaQuantity??'');
  const options=selected.live?.skuOptions||[],list=form.querySelector('datalist'),choices=form.querySelector('[data-options]');list.replaceChildren();choices.replaceChildren();lastSku=form.elements.sellerSku.value.trim();
  for(const row of options){const mismatch=mismatched(row),label=el('label',undefined,'inventory-sku-choice'),radio=el('input'),text=el('span');radio.type='radio';radio.name='skuCandidate';radio.value=row.sellerSku;radio.disabled=mismatch;text.append(el('strong',row.sellerSku),el('small',optionSummary(row)+(mismatch?'／新品・中古が異なります':'')));label.append(radio,text);choices.append(label);radio.addEventListener('change',()=>{form.elements.sellerSku.value=row.sellerSku;syncSku();});if(!mismatch){const o=el('option');o.value=row.sellerSku;o.label=optionSummary(row);list.append(o);}}
  if(!options.length)choices.append(el('p','自社SKUは未取得。入力したSKUは次回の取得で照合します。'));syncSku();
  message.textContent=selected.revision===undefined?'元の紐付け・在庫・計画から対象商品を登録してください。':'';controls();dialog.showModal();
 }
 form.elements.sellerSku.addEventListener('input',syncSku);
 form.addEventListener('submit',async e=>{e.preventDefault();if(busy||readOnly())return;
  if(!pending){if(selected.revision===undefined){message.textContent='元の商品を選び直してください';return;}if(mismatched(selected.live?.skuOptions?.find(o=>o.sellerSku===form.elements.sellerSku.value.trim()))){message.textContent='新品・中古が異なるSKUです。対象商品のSKUを確認してください。';return;}pending={command:{operationId:crypto.randomUUID(),kind:'inventory',key:selected.key,sellerSku:form.elements.sellerSku.value.trim(),manualFbaQuantity:!manualAllowed||form.elements.manualFbaQuantity.value===''?null:Number(form.elements.manualFbaQuantity.value)},revision:selected.revision,sourceRevisions:selected.sourceRevisions};try{sessionStorage.setItem(storageKey,JSON.stringify(pending));}catch{pending=null;message.textContent='保存受付をブラウザに記録できませんでした';return;}}
  busy=true;controls();message.textContent='確認内容を保存しています…';
  try{await request('/operations',{command:pending.command,sourceRevisions:pending.sourceRevisions},pending.revision);pending=null;sessionStorage.removeItem(storageKey);await load();dialog.close();await onChanged();}
  catch(error){if(error.status>=400&&error.status<500){pending=null;sessionStorage.removeItem(storageKey);await load();selected=info(selected.key);}message.textContent=error.message+(pending?' 同じ内容で保存結果を確認できます。':' 入力を残しています。内容を確認して保存してください。');}
  finally{busy=false;controls();}
 });dialog.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>dialog.close()));
 function mount(host,p,{key,fallback,editUrl,refresh,amazonUrl}){
  const a=p.live?.availability,channels=p.live?.channels;
  const button=(text,fn)=>{const b=el('button',text);b.type='button';b.disabled=readOnly();b.addEventListener('click',fn);return b;};
  const sku=el('div',`SKU：${a?.sku||p.sellerSku||'未指定'}`,'product-sku');sku.title=sku.textContent;
  if(a?.condition&&a.condition!=='unknown'&&a.condition!=='状態未確認')sku.append(el('span',a.condition));host.append(sku);
  if(a?.level==='danger'&&a.message.includes('多い'))host.append(el('strong',a.message+(p.live?.workspace?.stocks.length?p.live.workspace.replenishment?.eligible===false?'・自社発送用の実在庫あり':'・補充元の在庫を確認':''),'inventory-risk danger'));
  const markets=el('div',undefined,'product-access-links');
  function market(label,url,q,status,tone,quantityLabel=''){
   const node=url?el('a'):button('',editUrl);node.className='market-stock '+tone;
   if(url){node.href=url;node.target='_blank';node.rel='noopener noreferrer';}
   const line=el('span',undefined,'market-stock-head'),number=el('span',undefined,'market-stock-amount');if(quantityLabel)number.append(el('small',quantityLabel));number.append(el('b',amount(q)));line.append(el('span',label),number);node.append(line,el('span',status,'market-stock-state'));markets.append(node);
  }
  const fbaState=({active:'FBAで販売中',inactive:'FBAは販売停止・販売不可',absent:'FBAの出品登録なし'})[channels?.fba?.state]||'FBAの販売状態は未確認',merchantState=({active:'自社発送で販売中',inactive:'自社発送は販売停止・販売不可'})[channels?.merchant?.state];
  const onlyMerchant=merchantOnly(p),q=onlyMerchant?channels.merchant.quantity:a?.fba?.quantity??null;
  market(amazonUrl?'Amazonを開く ↗':'Amazon URLを登録',amazonUrl,q,(onlyMerchant?merchantState:fbaState)+(a?.fba?.source==='manual'&&!onlyMerchant?'／FBA数は手入力':''),'amazon-stock'+(q===0?' zero':''),onlyMerchant?'自社発送販売数':'FBA数量');
  const amazonBlock=markets.lastElementChild;
  if(onlyMerchant)amazonBlock.append(el('span',fbaState,'market-stock-secondary'));
  else if(merchantState)amazonBlock.append(el('span',merchantState+'／販売数 '+amount(channels.merchant.quantity),'market-stock-secondary'));
  const ambiguous=!a?.sku&&a?.fba?.status==='ambiguous';
  if(ambiguous)amazonBlock.append(el('span','対象SKU未選択・候補 '+a.fba.variants.length+'件','market-stock-secondary'));
  if(p.yahoo.length)for(const listing of p.yahoo){
   const y=a?.yahoo?.find(y=>y.listingId===listing.listingId),ended=y?.state==='ended',conflict=a?.linkConflicts?.includes(listing.listingId);
   const label=conflict?'SKU・商品情報が異なるため比較対象外':ended?a.fba.quantity>0?'出品終了・再出品を確認':'出品終了':y?.state==='active'?'出品中'+(y.quantitySource==='single_auction'?'／数量未記載のため1個':''):'状態・数量は未確認';
   market(p.yahoo.length>1?`ヤフオク ${listing.listingId} ↗`:'ヤフオクを開く ↗',listing.url,y?.quantity??null,label,ended?'yahoo-stock ended':y?.state==='active'?'yahoo-stock active':'yahoo-stock unknown');
  }else market('ヤフオク URLを登録','',null,'出品URL未登録','unknown');
  host.append(markets);
  const locations=el('div',undefined,'physical-stock-lines');for(const [id,label] of [['container','コンテナ'],['home','会社・自宅']]){const l=a?.locations?.find(l=>l.locationId===id),line=el('div');line.append(el('span',label),el('b',l?amount(l.usable,a?.unit):p.live?.workspace?.stockCandidates.length?'未関連':'未登録'));locations.append(line);}host.append(locations);
  const tools=el('div',undefined,'product-access-tools'),edit=button('SKU・在庫数を確認',()=>open(key,fallback));if(ambiguous)edit.classList.add('sku-selection-required');edit.disabled=readOnly()||p.revision===undefined||!p.asin;tools.append(edit,button('URL登録・修正',editUrl));const update=button('状態を再取得',()=>refresh(update));tools.append(update);host.append(tools);
  const details=el('details',undefined,'product-stock-details');details.append(el('summary','確認時刻・補足'));
  details.append(el('p',`FBA確認：${time(a?.fba?.checkedAt)}${a?.fba?.source==='manual'?'（手入力）':''}`));
  if(channels?.merchant?.checkedAt)details.append(el('p',`自社発送確認：${time(channels.merchant.checkedAt)}／販売可能 ${amount(channels.merchant.quantity)}（FBA・場所別実数とは別）`));
  if(a?.fba?.reserved>0)details.append(el('p',`予約・処理中 ${a.fba.reserved}個（FBA販売可能数に含めません）`));
  if(a?.poolListings>1)details.append(el('p',`同じSKUのヤフオク${a.poolListings}出品で必要なFBA在庫：${a.poolRequired}個${a.poolComplete?'':'以上（未確認の出品あり）'}`));
  for(const y of a?.yahoo||[])details.append(el('p',`ヤフオク ${y.listingId}：${time(y.checkedAt)}`));
  if(a?.level==='warning')details.append(el('p',a.message));
  details.append(el('p','FBA販売可能数を比較しています。注文数や手元在庫とは合算せず、マルチチャネルの発送可否は別に確認します。'));host.append(details);
 }
 return {mount,open};
}
