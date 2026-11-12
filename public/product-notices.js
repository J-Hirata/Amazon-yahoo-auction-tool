import {monitorRequest} from './monitor-http.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={relist:'ヤフオク再出品',stock:'残数警告・補充',review:'販売見直し',yahoo:'ヤフオク終了・要確認'};
export function createNoticeManager({readOnly,userId,onSettings,onChanged}){
  let data,selectedId=null,keys=null,busy=false,pending=null;
  const storageKey='notice-operation:'+userId;
  try{pending=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
  const dialog=document.createElement('dialog');dialog.className='notice-dialog';dialog.setAttribute('aria-labelledby','noticeTitle');
  dialog.innerHTML='<header><h2 id="noticeTitle">通知・再案内</h2><button type="button" data-close class="secondary">閉じる</button></header><p class="notice-policy"></p><label class="notice-stopped-toggle"><input type="checkbox" data-show-stopped>解除済みも表示</label><div data-notice-message role="status"></div><div data-notice-items></div><button type="button" data-notice-retry hidden>同じ内容で保存を確認</button>';
  document.body.append(dialog);
  const message=(text,error=false)=>{const node=dialog.querySelector('[data-notice-message]');node.textContent=text;node.classList.toggle('error',error);};
  async function request(options){const response=await monitorRequest('/api/product-overview/notices',options),body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error||'再案内を確認できませんでした'),{status:response.status});return body;}
  function render(){
    if(!data)return;
    dialog.querySelector('.notice-policy').textContent=data.enabled?'未対応の案内は3日ごと。チェックを付けると、この件の再案内を止めます。':'3日ごとの再案内は設定反映待ちです。';
    const showStopped=dialog.querySelector('[data-show-stopped]').checked;
    const items=data.notices.filter(n=>(!selectedId||n.id===selectedId)&&(!keys||keys.has(n.summary?.rowKey))&&(showStopped||!n.stopped||n.id===selectedId));
    const host=dialog.querySelector('[data-notice-items]');
    host.innerHTML=items.length?Object.entries(labels).map(([kind,label])=>{
      const notices=items.filter(n=>(n.summary?.kind||'stock')===kind);if(!notices.length)return '';
      return `<section><h3>${label}（${notices.length}件）</h3>${notices.map(n=>{
        const detail=n.summary||{},status=n.stopped?'再案内を解除済み':n.current===null?'最新の数量・状態を確認待ち':n.blocked?'送信結果・受付時刻を確認してください':n.deliveredCount?`通知${n.deliveredCount}回済み ／ 次回 ${n.nextOn||'設定反映待ち'}の日次確認`:'初回の通知待ち';
        const settings=detail.rowKey?`<button type="button" class="secondary" data-notice-settings="${esc(detail.rowKey)}" data-notice-kind="${esc(kind)}">${kind==='review'?'見直しの設定を変更':'残数・通知の設定を変更'}</button>`:'';
        const plan=detail.planId?`<a href="/?view=planning#id=${encodeURIComponent(detail.planId)}">見直し日・方針を変更 ↗</a>`:'';
        const listing=detail.listingId?`<a href="https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(detail.listingId)}" target="_blank" rel="noopener noreferrer">ヤフオク出品を確認 ↗</a>`:'';
        const quantity=detail.quantity;
        return `<article data-notice-item="${esc(n.id)}" class="${n.stopped?'notice-stopped':''}"><h4>${esc(n.title)}</h4><p>${(detail.lines?.length?detail.lines:[n.message]).map(esc).join('<br>')}</p><p class="notice-status">${esc(status)}</p><label class="notice-stop"><input type="checkbox" data-stop-notice="${esc(n.id)}" ${n.stopped?'checked':''} ${readOnly||busy||pending?'disabled':''}>この件の再案内を止める</label><div class="notice-actions">${plan}${settings}${listing}</div>${quantity?`<details><summary>数量の根拠・商品情報</summary><p>${esc(n.asin)} ／ SKU ${esc(quantity.sku||'未指定')}<br>${esc(quantity.basis||'')}<br>確認 ${esc(quantity.checkedAt||'未確認')}</p></details>`:''}</article>`;
      }).join('')}</section>`;
    }).join(''):`<p>${selectedId?'この案内は解消または内容が変更されています。':'再案内の対象はありません。'}</p>`;
    for(const control of host.querySelectorAll('[data-stop-notice]'))control.addEventListener('change',()=>save(control.dataset.stopNotice,control.checked));
    for(const button of host.querySelectorAll('[data-notice-settings]'))button.addEventListener('click',()=>{dialog.close();onSettings(button.dataset.noticeSettings,button.dataset.noticeKind);});
    dialog.querySelector('[data-notice-retry]').hidden=!pending;
  }
  async function deliver(){
    if(!pending||busy)return;busy=true;render();
    try{
      data=await request({method:'POST',headers:{'Content-Type':'application/json','If-Match':`"${pending.revision}"`},body:JSON.stringify({command:pending.command})});
      pending=null;sessionStorage.removeItem(storageKey);message('再案内の設定を保存しました。');await onChanged?.();
    }catch(error){
      message(error.message,true);
      if(error.status>=400&&error.status<500){pending=null;sessionStorage.removeItem(storageKey);data=await request();}
    }finally{busy=false;render();}
  }
  async function save(alertId,stopped){
    if(readOnly||busy||pending)return;
    pending={command:{operationId:crypto.randomUUID(),alertId,stopped},revision:data.revision};
    try{sessionStorage.setItem(storageKey,JSON.stringify(pending));}catch{pending=null;message('保存受付を記録できませんでした。',true);render();return;}
    await deliver();
  }
  async function open({id=null,sourceKeys=null}={}){
    selectedId=id;keys=sourceKeys?new Set(sourceKeys):null;message('読み込み中…');dialog.querySelector('[data-notice-items]').replaceChildren();if(!dialog.open)dialog.showModal();
    try{data=await request();message(pending?'保存結果が未確認の操作があります。同じ内容で保存を確認できます。':'');render();}catch(error){message(error.message,true);}
  }
  dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());
  dialog.querySelector('[data-show-stopped]').addEventListener('change',render);
  dialog.querySelector('[data-notice-retry]').addEventListener('click',deliver);
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  return {open};
}
