import {monitorRequest} from './monitor-http.js';
// The complete rule is read immediately before saving; other monitoring settings stay intact.
export function createFbaAlarm({readOnly,onChanged}){
  async function request(path='',command,revision){
    const response=await monitorRequest('/api/product-overview'+path,command?{method:'POST',headers:{'Content-Type':'application/json','If-Match':'"'+revision+'"'},body:JSON.stringify({command})}:undefined);
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'設定を読み込めませんでした'),{status:response.status});return data;
  }
  let snapshot;
  function mount(host,key){
    const box=document.createElement('section');box.className='fba-alarm-editor';
    box.innerHTML='<strong>FBA残数アラーム</strong><label>FBAが何個以下になったら通知するか<input type="number" min="0" max="1000000" step="1" placeholder="未設定（通知しない）" aria-label="FBA残数アラームの個数"></label><small>空欄で解除。0なら在庫切れ時。日次確認で通知します。</small><button type="button">アラームを保存</button><p role="status" aria-live="polite"></p>';
    const input=box.querySelector('input'),button=box.querySelector('button'),message=box.querySelector('p');let loaded=false,busy=false,pending;
    input.disabled=button.disabled=true;
    const rowOf=data=>data.rows.find(r=>r.sourceKeys.includes(key)||r.key===key);
    async function initialize(){busy=true;try{const data=await (snapshot??=request()),row=rowOf(data);if(!row)throw new Error('対象商品を読み直してください');input.value=row.rule.lowStock?.source==='fba'?row.rule.lowStock.threshold??'':'';loaded=true;message.textContent=[row.rule.lowStock?.source&&row.rule.lowStock.source!=='fba'?'保存すると残数警告の対象をFBAへ変更します。':'',!data.automation?.enabled||!data.automation?.stockAlerts?'メールを受け取るには、通知設定で自動確認・在庫警告を有効にしてください。':''].filter(Boolean).join(' ');}catch(e){message.textContent=e.message;}finally{busy=false;input.disabled=button.disabled=!loaded||readOnly();}}
    void initialize();
    button.addEventListener('click',async()=>{
      if(busy||readOnly()||!loaded||!input.reportValidity())return;
      const value=input.value===''?null:Number(input.value);if(value!==null&&(!Number.isSafeInteger(value)||value<0||value>1000000))return;
      busy=true;input.disabled=button.disabled=true;message.textContent='保存中…';
      try{
        if(!pending){const data=await request(),row=rowOf(data);if(!row)throw new Error('対象商品を読み直してください');pending={revision:data.revision,command:{operationId:crypto.randomUUID(),rule:{...row.rule,lowStock:{source:'fba',threshold:value}}}};}
        await request('/operations',pending.command,pending.revision);pending=undefined;message.textContent=value===null?'アラームを解除しました。':value+'個以下で通知する設定を保存しました。';await onChanged();
      }catch(e){if(e.status>=400&&e.status<500)pending=undefined;message.textContent=e.message+' 入力は残しています。再度保存してください。';}
      finally{busy=false;input.disabled=readOnly()||Boolean(pending);button.disabled=readOnly();button.textContent=pending?'同じ設定で保存結果を確認':'アラームを保存';}
    });host.append(box);
  }
  return {mount,invalidate:()=>{snapshot=undefined;}};
}
