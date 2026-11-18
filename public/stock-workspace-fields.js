import {fbaStatus} from './fba-status.js';
import {createInlineMonitoringFields} from './inline-monitoring-fields.js';
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
export function createStockWorkspaceFields(form){
 const section=el('fieldset');section.className='stock-workspace-fields';section.innerHTML='<legend>FBA在庫・納品予定</legend><p data-current></p><label class="stock-alarm-primary">FBAが何個以下なら通知するか<input name="workspaceAlarm" type="number" min="0" max="1000000" step="1" placeholder="残数を指定"></label><small>紐付け済みの商品紐付け・在庫・販売監視で共通の設定です。0なら在庫切れ時。日次確認で通知します。</small><p data-alarm-status role="status"></p><label data-alarm-clear hidden><input name="workspaceAlarmClear" type="checkbox">残数指定を解除して各ページを揃える</label><div class="stock-manual-correction"><label>在庫数の手入力補正（任意）<select name="workspaceFbaAction"><option value="keep">変更しない（通常はこちら）</option><option value="set">現在のFBA在庫数を手入力する</option><option value="clear">手入力を解除しAmazon取得値に戻す</option></select></label><p data-manual-status></p><label data-manual-field hidden>現在のFBA在庫数（手入力）<input name="workspaceFba" type="number" min="0" max="1000000" step="1" placeholder="確認した現在庫を入力"></label><small>手入力した時点の在庫数から販売分を差し引きます。通知する残数とは別です。Amazon側の数量は変更しません。</small></div><div data-existing></div><div class="stock-incoming-new"><strong>納品予定を追加</strong><div class="stock-form-grid"><label>到着予定数<input name="incomingQuantity" type="number" min="1" max="1000000" step="1" placeholder="予定があれば入力"></label><label>状況<select name="incomingStage"><option value="packing">梱包中</option><option value="transit">発送中</option></select></label><label>到着予定日<input name="incomingDate" type="date"></label><label>納品番号・メモ<input name="incomingReference" maxlength="200"></label></div></div>';
 form.querySelector('[data-location-fields],#stockInitialFields').after(section);let initial={},plans=[],initialDraft=null;
 const memo=el('label','通知時のメモ（任意）'),memoInput=el('textarea');memoInput.name='workspaceAlarmNote';memoInput.rows=2;memoInput.maxLength=1000;memoInput.placeholder='例：90個以下になったら追加納品する';memo.append(memoInput);section.querySelector('.stock-alarm-primary').after(memo);
 const memoHelp=el('small','残数警告などのメールと確認画面に表示します。入力した内容を自動実行するものではありません。');memo.after(memoHelp);
 const newIncoming=section.querySelector('.stock-incoming-new'),incomingDetails=el('details'),incomingSummary=el('summary','FBAへの納品予定（任意）');incomingDetails.className='stock-incoming-details';newIncoming.before(incomingDetails);newIncoming.querySelector('strong').remove();incomingDetails.append(incomingSummary,newIncoming);
 const draftStatus=el('p');draftStatus.setAttribute('role','status');newIncoming.append(draftStatus);
 for(const input of newIncoming.querySelectorAll('input'))input.autocomplete='off';
 const monitoring=createInlineMonitoringFields(form);
 function draftMessage(){draftStatus.textContent=form.elements.incomingQuantity.value===''&&(form.elements.incomingDate.value||form.elements.incomingReference.value.trim())?'予定数は未入力です。日付・メモを数量未定の下書きとして保存できます。':'予定がなければ空欄で登録できます。日付・メモだけでも下書きとして保存します。';}
 newIncoming.addEventListener('input',draftMessage);
 function manualFields(){const active=form.elements.workspaceFbaAction.value==='set';section.querySelector('[data-manual-field]').hidden=!active;form.elements.workspaceFba.disabled=!active;form.elements.workspaceFba.required=active;}
 form.elements.workspaceFbaAction.addEventListener('change',manualFields);form.elements.workspaceAlarmClear.addEventListener('change',()=>{form.elements.workspaceAlarm.disabled=form.elements.workspaceAlarmClear.checked;});
 function refresh(live){
  const f=live?.availability?.fba,c=f?.counter,source=({estimate:'推定',manual:'手入力',amazon:'Amazon取得',unknown:'数量未取得'})[f?.source]||'数量未取得';
  let skuList=form.querySelector('#stockWorkspaceSkus');if(!skuList){skuList=el('datalist');skuList.id='stockWorkspaceSkus';form.append(skuList);form.elements.sellerSku.setAttribute('list',skuList.id);}skuList.replaceChildren();for(const option of live?.skuOptions||[]){const o=el('option');o.value=option.sellerSku;o.label=[option.condition,option.shipping,Number.isSafeInteger(option.fbaQuantity)?'FBA '+option.fbaQuantity+'個':''].filter(Boolean).join(' ／ ');skuList.append(o);}
  section.querySelector('[data-current]').textContent=`現在のFBA在庫：${Number.isSafeInteger(f?.quantity)?f.quantity+'個':'数量未取得'}${f?.source?'（'+source+'）':''}${c?.sales!==null&&c?.sales!==undefined?' ／ 基準'+c.baseline+' − 販売'+c.sales:''}`;
  let reason=section.querySelector('[data-fba-reason]');if(!reason){reason=el('p');reason.dataset.fbaReason='';section.querySelector('[data-current]').after(reason);}reason.textContent=fbaStatus(live).message+(f?.checkedAt?' 最終取得：'+new Date(f.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'');
  if(f?.variants?.length)reason.textContent+=' '+f.variants.map(v=>v.sellerSku+'：'+(Number.isSafeInteger(v.quantity)?v.quantity+'個':'未確認')+'（'+v.condition+'）').join(' ／ ');
 }
 function populate(product,live){
  refresh(live);
  form.elements.workspaceFba.value='';form.elements.workspaceFbaAction.value='keep';manualFields();form.elements.workspaceAlarm.value=live?.alarmThreshold??'';form.elements.workspaceAlarm.disabled=false;form.elements.workspaceAlarmClear.checked=false;
  const shared=live?.sharedLowStock,conflict=Boolean(shared?.conflict);section.querySelector('[data-alarm-clear]').hidden=!conflict;
  section.querySelector('[data-alarm-status]').textContent=conflict?'通知残数が異なります（'+shared.values.map(v=>v.source==='fba'?v.threshold+'個以下':v.source?'別の在庫を対象':'残数指定なし').join(' ／ ')+'）。共通の数を入力するか、残数指定の解除を選んでください。':live?.workspace?.stockCandidates?.some(p=>!p.mismatch)?'同じASINの在庫候補があります。未連携の在庫とは通知設定を共有しません。登録先欄で対象を選んで関連付けてください。':'';
  const review=live?.availability?.review;section.querySelector('[data-manual-status]').textContent=review?.manualFbaQuantity!==null&&review?.manualFbaQuantity!==undefined?'保存済みの手入力：'+review.manualFbaQuantity+'個（'+new Date(review.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+'）。過去の計算起点です。':'Amazonから数量を取得できる場合、通常は変更不要です。';
  initial={fba:form.elements.workspaceFba.value,alarm:form.elements.workspaceAlarm.value};plans=[];const host=section.querySelector('[data-existing]');host.replaceChildren();
  memoInput.value=live?.workspace?.notificationNote||'';initial.alarmNote=memoInput.value;monitoring.populate(live);
  const draft=live?.workspace?.incomingDraft;initialDraft=draft?{stage:draft.stage,expectedOn:draft.expectedOn,reference:draft.reference}:null;
  form.elements.incomingQuantity.value='';form.elements.incomingDate.value=draft?.expectedOn||'';form.elements.incomingReference.value=draft?.reference||'';form.elements.incomingStage.value=draft?.stage||'packing';incomingDetails.open=Boolean(draft);draftMessage();
  for(const p of live?.incoming||[]){
   const box=el('div');box.className='stock-incoming-existing';box.append(el('strong',`納品予定 ${p.quantity}個 ／ ${p.sellerSku||'SKU未指定'}${p.remaining===0?' ／ '+(p.status==='closed'?'到着確認済み':'在庫反映済み・推定'):''}`));
   if(p.status==='closed'){host.append(box);continue;}
   const fields=el('div');fields.className='stock-form-grid';const refs={};
   for(const [key,label,type]of [['stage','状況','select'],['expectedOn','到着予定日','date'],['reference','納品番号・メモ','text']]){const l=el('label',label),input=el(type==='select'?'select':'input');if(type==='select')for(const [v,t]of [['packing','梱包中'],['transit','発送中']]){const o=el('option',t);o.value=v;input.append(o);}else{input.type=type;if(type==='text')input.maxLength=200;}input.value=p[key]||'';l.append(input);fields.append(l);refs[key]=input;}
   const l=el('label','到着を確認済み'),done=el('input');done.type='checkbox';l.prepend(done);l.className='stock-arrival-confirm';box.append(fields,l);host.append(box);plans.push({p,refs,done});
  }
 }
 function values(){
  const w={};if(form.elements.workspaceFbaAction.value==='set'){if(form.elements.workspaceFba.value==='')throw new Error('確認した現在のFBA在庫数を入力してください');w.manualFbaQuantity=Number(form.elements.workspaceFba.value);}else if(form.elements.workspaceFbaAction.value==='clear')w.manualFbaQuantity=null;
  if(form.elements.workspaceAlarmClear.checked)w.alarmThreshold=null;else if(form.elements.workspaceAlarm.value!==initial.alarm)w.alarmThreshold=form.elements.workspaceAlarm.value===''?null:Number(form.elements.workspaceAlarm.value);
  if(memoInput.value!==initial.alarmNote)w.alarmNote=memoInput.value;
  const monitoringValues=monitoring.values();if(monitoringValues)w.planning=monitoringValues;
  const incoming=[];for(const {p,refs,done}of plans)if(done.checked)incoming.push({id:p.id,complete:true});else if(Object.keys(refs).some(k=>refs[k].value!==(p[k]||'')))incoming.push({id:p.id,sellerSku:p.sellerSku,quantity:p.quantity,...Object.fromEntries(Object.entries(refs).map(([k,n])=>[k,n.value]))});
  if(form.elements.incomingQuantity.value!=='')incoming.push({quantity:Number(form.elements.incomingQuantity.value),sellerSku:form.elements.sellerSku.value.trim(),stage:form.elements.incomingStage.value,expectedOn:form.elements.incomingDate.value,reference:form.elements.incomingReference.value.trim()});
  else {const draft=form.elements.incomingDate.value||form.elements.incomingReference.value.trim()?{stage:form.elements.incomingStage.value,expectedOn:form.elements.incomingDate.value,reference:form.elements.incomingReference.value.trim()}:null;if(JSON.stringify(draft)!==JSON.stringify(initialDraft))w.incomingDraft=draft;}
  if(incoming.length)w.incoming=incoming;return w;
 }
 return {populate,values,refresh,sync:monitoring.sync,choosePlan:monitoring.choose};
}
