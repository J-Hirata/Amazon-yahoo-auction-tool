import {monitorRequest} from "./monitor-http.js";
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const amazon=asin=>/^[A-Z0-9]{10}$/.test(asin||"")?`https://www.amazon.co.jp/dp/${asin}`:"";
const yahoo=id=>/^[a-z][0-9]{6,15}$/.test(id||"")?`https://auctions.yahoo.co.jp/jp/auction/${id}`:"";
export function createProductAccess({readOnly=()=>false,onChanged=async()=>{}}={}){
 let entries={},busy=false,selected,pending;const pendingKey="product-links-pending";
 try{pending=JSON.parse(sessionStorage.getItem(pendingKey)||"null");}catch{}
 const dialog=el('dialog',undefined,'product-url-dialog');dialog.setAttribute('aria-label','商品ページのURLを登録・修正');
 dialog.innerHTML='<form><header><h2>商品ページのURLを登録・修正</h2><button type="button" data-url-close aria-label="URL入力を閉じる">閉じる</button></header><p data-url-title></p><fieldset><label>Amazonの商品URL または ASIN<input name="amazon" required maxlength="2048" aria-label="Amazonの商品URL または ASIN"></label><label>追加・変更するヤフオク出品<select name="replaceLinkId" aria-label="追加・変更するヤフオク出品"></select></label><label>ヤフオクの商品URL<input name="yahoo" type="url" maxlength="2048" placeholder="https://auctions.yahoo.co.jp/jp/auction/…" aria-label="ヤフオクの商品URL"></label><p>同じ商品・状態・セットのURLを登録してください。新しいURLを保存すると、この商品の監視対象にも反映します。</p></fieldset><p data-url-message role="status" aria-live="polite"></p><footer><button type="button" data-url-close>取消</button><button type="submit" data-url-save>URLを保存</button></footer></form>';
 document.body.append(dialog);const form=dialog.querySelector('form'),message=dialog.querySelector('[data-url-message]'),save=dialog.querySelector('[data-url-save]');
 const controls=()=>{form.querySelector('fieldset').disabled=busy||Boolean(pending)||readOnly();save.disabled=busy||readOnly();save.textContent=pending?'同じ内容で保存結果を確認':'URLを保存';for(const b of dialog.querySelectorAll('[data-url-close]'))b.disabled=busy;};
 async function request(path='',body,revision){const r=await monitorRequest('/api/product-links'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json',...(revision===undefined?{}:{'If-Match':`"${revision}"`})},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error||'商品ページのURLを読み込めません'),{status:r.status});return data;}
 async function load(){try{entries=(await request()).entries;return true;}catch{return false;}}
 function info(key,fallback={}){return entries[key]||{key,asin:fallback.asin||'',title:fallback.title||'商品',yahoo:(fallback.listingIds||[]).filter(id=>yahoo(id)).map(id=>({listingId:id,url:yahoo(id)}))};}
 function selectUrl(){form.elements.yahoo.value=selected.yahoo.find(y=>y.linkId===form.elements.replaceLinkId.value)?.url||'';}
 async function open(key,fallback){if(busy||readOnly())return;await load();selected=info(pending?.command.key||key,fallback);form.reset();dialog.querySelector('[data-url-title]').textContent=selected.title;
  form.elements.amazon.value=selected.asin||'';form.elements.amazon.readOnly=Boolean(selected.asin);
  form.elements.replaceLinkId.replaceChildren();const options=selected.key.startsWith('link:')?selected.yahoo:[{linkId:'',listingId:'新しい出品URLを追加'},...selected.yahoo];
  for(const o of options){const option=el('option',o.listingId);option.value=o.linkId;form.elements.replaceLinkId.append(option);}
  if(selected.yahoo.length===1)form.elements.replaceLinkId.value=selected.yahoo[0].linkId||'';selectUrl();
  if(pending){form.elements.amazon.value=pending.command.amazon;form.elements.yahoo.value=pending.command.yahoo;form.elements.replaceLinkId.value=pending.command.replaceLinkId;}
  message.textContent=selected.revision===undefined?'登録画面を読み込めませんでした。保存済みリンクから確認し、一覧を更新してから開き直してください。':'';controls();if(!dialog.open)dialog.showModal();
 }
 form.elements.replaceLinkId.addEventListener('change',selectUrl);
 form.addEventListener('submit',async event=>{event.preventDefault();if(busy||readOnly())return;
  if(!pending){if(selected.revision===undefined){message.textContent='URL登録画面を読み直してください';return;}pending={command:{operationId:crypto.randomUUID(),key:selected.key,amazon:form.elements.amazon.value.trim(),yahoo:form.elements.yahoo.value.trim(),replaceLinkId:form.elements.replaceLinkId.value},sourceRevisions:selected.sourceRevisions,revision:selected.revision};try{sessionStorage.setItem(pendingKey,JSON.stringify(pending));}catch{pending=null;message.textContent='保存受付をブラウザに記録できませんでした';return;}}
  busy=true;controls();message.textContent='URLと商品の関連付けを保存しています…';
  try{await request('/operations',{command:pending.command,sourceRevisions:pending.sourceRevisions},pending.revision);pending=null;sessionStorage.removeItem(pendingKey);await load();dialog.close();await onChanged();}
  catch(e){if(e.status>=400&&e.status<500){pending=null;sessionStorage.removeItem(pendingKey);await load();selected=info(selected.key);message.textContent=e.message+' 入力を確認してから保存してください。';}else message.textContent='保存結果を確認できません。同じ内容で保存結果を確認してください。';}
  finally{busy=false;controls();}
 });
 for(const b of dialog.querySelectorAll('[data-url-close]'))b.addEventListener('click',()=>dialog.close());
 async function refresh(button){if(busy||readOnly())return;busy=true;button.disabled=true;const old=button.textContent;button.textContent='取得中…';try{await request('/refresh',{});await load();await onChanged();}catch(e){const note=el('small',e.message,'product-access-note');button.parentElement?.append(note);}finally{busy=false;button.disabled=false;button.textContent=old;}}
 function mount(host,key,fallback={}){
  const p=info(key,fallback);host.classList.add('product-access');host.setAttribute('aria-label','商品ページとURLの登録');host.replaceChildren();
  const links=el('div',undefined,'product-access-links');
  const button=(label,fn)=>{const b=el('button',label);b.type='button';b.disabled=readOnly();b.addEventListener('click',fn);return b;};
  const anchor=(label,url)=>{const a=el('a',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.title=url;return a;};
  links.append(amazon(p.asin)?anchor('Amazonを開く ↗',amazon(p.asin)):button('Amazon URLを登録',()=>open(key,fallback)));
  if(p.yahoo.length)for(const y of p.yahoo)links.append(anchor(p.yahoo.length===1?'ヤフオクを開く ↗':`ヤフオク ${y.listingId} ↗`,y.url));else links.append(button('ヤフオク URLを登録',()=>open(key,fallback)));
  host.append(links);const tools=el('div',undefined,'product-access-tools');tools.append(button('URL登録・修正',()=>open(key,fallback)));const update=button('状態を再取得',()=>refresh(update));tools.append(update);host.append(tools);
  const state=p.live?.channels;
  if(state){const channels=[];if(state.fba.state==='active')channels.push('FBA出品中');if(state.merchant.state==='active')channels.push('Amazon自社発送で出品中');if(channels.length)host.append(el('small',channels.join(' ／ '),'product-access-note'));}
  if(!p.asin)host.append(el('small','AmazonのASINまたは商品URLを登録してください','product-access-note'));
  if(p.yahoo.length){for(const y of p.yahoo){const observed=p.live?.yahoo?.find(o=>o.listingId===y.listingId);const text=observed?.verified?observed.status==='ended'?'ヤフオクは終了。再出品済みならURLを修正してください':observed.status==='active'?'ヤフオク出品中':'登録URLを開いて出品状態を確認してください':observed?.checkedAt?'自動取得に失敗。登録URLを開くかURLを修正してください':'URL登録済み。状態を再取得してください';host.append(el('small',text,'product-access-note'));}}
 }
 return {load,info,mount,open};
}
