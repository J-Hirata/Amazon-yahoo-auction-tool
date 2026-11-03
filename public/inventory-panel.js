const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const amount=(q,unit='個')=>Number.isSafeInteger(q)&&q>=0?`${q}${unit}`:'未確認';
const time=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認';
export function createInventoryPanel({request,load,info,onChanged,readOnly}){
 let selected,pending,busy=false;const storageKey='inventory-review-pending';
 try{pending=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
 const dialog=el('dialog',undefined,'product-url-dialog inventory-dialog');dialog.setAttribute('aria-label','SKUとFBA在庫の確認');
 dialog.innerHTML='<form><header><h2>SKUとFBA在庫の確認</h2><button type="button" data-close>閉じる</button></header><p data-title></p><fieldset><label>対応するAmazon SKU<input name="sellerSku" list="inventory-sku-options" maxlength="200" placeholder="SKUを選択・手入力"><datalist id="inventory-sku-options"></datalist></label><p data-options></p><label>FBA在庫の手入力<input name="manualFbaQuantity" type="number" min="0" max="1000000" step="1" placeholder="未確認なら空欄"></label><p>Amazonから数量を取得できないときの補助値です。自動取得の数がある場合はそちらを使います。空欄は未確認、0は在庫なしです。</p></fieldset><p data-message role="status"></p><footer><button type="button" data-close>取消</button><button type="submit" data-save>確認内容を保存</button></footer></form>';
 document.body.append(dialog);const form=dialog.querySelector('form'),message=dialog.querySelector('[data-message]');
 function controls(){form.querySelector('fieldset').disabled=busy||Boolean(pending)||readOnly();form.querySelector('[data-save]').disabled=busy||readOnly();form.querySelector('[data-save]').textContent=pending?'同じ内容で保存結果を確認':'確認内容を保存';dialog.querySelectorAll('[data-close]').forEach(b=>b.disabled=busy);}
 async function open(key,fallback){if(busy||readOnly())return;if(!await load()){selected={};message.textContent='最新の在庫情報を取得できません。閉じてから再度開いてください。';controls();form.querySelector('[data-save]').disabled=true;dialog.showModal();return;}selected=info(pending?.command.key||key,fallback);form.reset();dialog.querySelector('[data-title]').textContent=selected.title;
  form.elements.sellerSku.value=pending?.command.sellerSku??selected.sellerSku??'';form.elements.manualFbaQuantity.value=pending?(pending.command.manualFbaQuantity??''):(selected.manualReview?.manualFbaQuantity??'');
  const options=selected.live?.skuOptions||[],list=form.querySelector('datalist');list.replaceChildren();
  for(const row of options){const o=el('option');o.value=row.sellerSku;o.label=`${row.condition}／${row.shipping}`;list.append(o);}
  dialog.querySelector('[data-options]').textContent=options.length?options.map(r=>`${r.sellerSku}：${r.condition}・${r.shipping}`).join('\n'):'自社SKUを取得できていません。手入力したSKUは、次の取得時にそのSKUだけで照合します。';
  message.textContent=selected.revision===undefined?'元の紐付け・在庫・計画から対象商品を登録してください。':'';controls();dialog.showModal();
 }
 form.addEventListener('submit',async e=>{e.preventDefault();if(busy||readOnly())return;
  if(!pending){if(selected.revision===undefined){message.textContent='元の商品を選び直してください';return;}pending={command:{operationId:crypto.randomUUID(),kind:'inventory',key:selected.key,sellerSku:form.elements.sellerSku.value.trim(),manualFbaQuantity:form.elements.manualFbaQuantity.value===''?null:Number(form.elements.manualFbaQuantity.value)},revision:selected.revision,sourceRevisions:selected.sourceRevisions};try{sessionStorage.setItem(storageKey,JSON.stringify(pending));}catch{pending=null;message.textContent='保存受付をブラウザに記録できませんでした';return;}}
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
  if(a?.level==='danger'&&a.message.includes('多い'))host.append(el('strong',a.message+(p.live?.workspace?.stocks.length?'・補充元の在庫を確認':''),'inventory-risk danger'));
  const markets=el('div',undefined,'product-access-links');
  function market(label,url,q,status,tone){
   const node=url?el('a'):button('',editUrl);node.className='market-stock '+tone;
   if(url){node.href=url;node.target='_blank';node.rel='noopener noreferrer';}
   const line=el('span',undefined,'market-stock-head');line.append(el('span',label),el('b',amount(q)));node.append(line,el('span',status,'market-stock-state'));markets.append(node);
  }
  const fbaState=({active:'FBAで出品中',inactive:'FBAは販売停止・販売不可',absent:'FBAの出品登録なし'})[channels?.fba?.state]||'出品状態は未確認';
  market(amazonUrl?'Amazonを開く ↗':'Amazon URLを登録',amazonUrl,a?.fba?.quantity??null,fbaState+(a?.fba?.source==='manual'?'／在庫は手入力':''),'amazon-stock'+(a?.fba?.quantity===0?' zero':''));
  if(p.yahoo.length)for(const listing of p.yahoo){
   const y=a?.yahoo?.find(y=>y.listingId===listing.listingId),ended=y?.state==='ended',conflict=a?.linkConflicts?.includes(listing.listingId);
   const label=conflict?'SKU・商品情報が異なるため比較対象外':ended?a.fba.quantity>0?'出品終了・再出品を確認':'出品終了':y?.state==='active'?'出品中'+(y.quantitySource==='single_auction'?'／数量未記載のため1個':''):'状態・数量は未確認';
   market(p.yahoo.length>1?`ヤフオク ${listing.listingId} ↗`:'ヤフオクを開く ↗',listing.url,y?.quantity??null,label,ended?'yahoo-stock ended':y?.state==='active'?'yahoo-stock active':'yahoo-stock unknown');
  }else market('ヤフオク URLを登録','',null,'出品URL未登録','unknown');
  host.append(markets);
  const locations=el('div',undefined,'physical-stock-lines');for(const [id,label] of [['container','コンテナ'],['home','会社・自宅']]){const l=a?.locations?.find(l=>l.locationId===id),line=el('div');line.append(el('span',label),el('b',l?amount(l.usable,a?.unit):p.live?.workspace?.stockCandidates.length?'未関連':'未登録'));locations.append(line);}host.append(locations);
  const tools=el('div',undefined,'product-access-tools'),edit=button('SKU・在庫数を確認',()=>open(key,fallback));edit.disabled=readOnly()||p.revision===undefined||!p.asin;tools.append(edit,button('URL登録・修正',editUrl));const update=button('状態を再取得',()=>refresh(update));tools.append(update);host.append(tools);
  const details=el('details',undefined,'product-stock-details');details.append(el('summary','確認時刻・補足'));
  details.append(el('p',`FBA確認：${time(a?.fba?.checkedAt)}${a?.fba?.source==='manual'?'（手入力）':''}`));
  if(a?.fba?.reserved>0)details.append(el('p',`予約・処理中 ${a.fba.reserved}個（FBA販売可能数に含めません）`));
  if(a?.poolListings>1)details.append(el('p',`同じSKUのヤフオク${a.poolListings}出品で必要なFBA在庫：${a.poolRequired}個${a.poolComplete?'':'以上（未確認の出品あり）'}`));
  for(const y of a?.yahoo||[])details.append(el('p',`ヤフオク ${y.listingId}：${time(y.checkedAt)}`));
  if(a?.level==='warning')details.append(el('p',a.message));
  details.append(el('p','FBA販売可能数を比較しています。注文数や手元在庫とは合算せず、マルチチャネルの発送可否は別に確認します。'));host.append(details);
 }
 return {mount,open};
}
