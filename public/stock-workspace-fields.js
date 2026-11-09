const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
export function createStockWorkspaceFields(form){
 const section=el('fieldset');section.className='stock-workspace-fields';section.innerHTML='<legend>FBA在庫・納品予定</legend><p data-current></p><div class="stock-form-grid"><label>FBA残数の基準値<input name="workspaceFba" type="number" min="0" max="1000000" step="1" placeholder="訂正する場合に入力"></label><label>FBAが何個以下なら通知するか<input name="workspaceAlarm" type="number" min="0" max="1000000" step="1" placeholder="指定なし"></label></div><small>FBA基準値は販売分を差し引く起点です。Amazon側の数量は変わりません。</small><div data-existing></div><div class="stock-incoming-new"><strong>納品予定を追加</strong><div class="stock-form-grid"><label>到着予定数<input name="incomingQuantity" type="number" min="1" max="1000000" step="1" placeholder="予定があれば入力"></label><label>状況<select name="incomingStage"><option value="packing">梱包中</option><option value="transit">発送中</option></select></label><label>到着予定日<input name="incomingDate" type="date"></label><label>納品番号・メモ<input name="incomingReference" maxlength="200"></label></div></div>';
 form.querySelector('[data-location-fields],#stockInitialFields').after(section);let initial={},plans=[];
 function populate(product,live){
  const f=live?.availability?.fba,c=f?.counter,source=f?.source==='estimate'?'推定':f?.source==='manual'?'手入力基準':'Amazon取得';
  let skuList=form.querySelector('#stockWorkspaceSkus');if(!skuList){skuList=el('datalist');skuList.id='stockWorkspaceSkus';form.append(skuList);form.elements.sellerSku.setAttribute('list',skuList.id);}skuList.replaceChildren();for(const option of live?.skuOptions||[]){const o=el('option');o.value=option.sellerSku;o.label=[option.condition,option.shipping,Number.isSafeInteger(option.fbaQuantity)?'FBA '+option.fbaQuantity+'個':''].filter(Boolean).join(' ／ ');skuList.append(o);}
  section.querySelector('[data-current]').textContent=`FBA：${Number.isSafeInteger(f?.quantity)?f.quantity+'個':'数量未取得'}${f?.source?'（'+source+'）':''}${c?.sales!==null&&c?.sales!==undefined?' ／ 基準'+c.baseline+' − 販売'+c.sales:''}`;
  form.elements.workspaceFba.value=live?.availability?.review?.manualFbaQuantity??'';form.elements.workspaceAlarm.value=live?.alarmThreshold??'';
  initial={fba:form.elements.workspaceFba.value,alarm:form.elements.workspaceAlarm.value};plans=[];const host=section.querySelector('[data-existing]');host.replaceChildren();
  for(const p of live?.incoming||[]){
   const box=el('div');box.className='stock-incoming-existing';box.append(el('strong',`納品予定 ${p.quantity}個 ／ ${p.sellerSku||'SKU未指定'}${p.remaining===0?' ／ '+(p.status==='closed'?'到着確認済み':'在庫反映済み・推定'):''}`));
   if(p.status==='closed'){host.append(box);continue;}
   const fields=el('div');fields.className='stock-form-grid';const refs={};
   for(const [key,label,type]of [['stage','状況','select'],['expectedOn','到着予定日','date'],['reference','納品番号・メモ','text']]){const l=el('label',label),input=el(type==='select'?'select':'input');if(type==='select')for(const [v,t]of [['packing','梱包中'],['transit','発送中']]){const o=el('option',t);o.value=v;input.append(o);}else{input.type=type;if(type==='text')input.maxLength=200;}input.value=p[key]||'';l.append(input);fields.append(l);refs[key]=input;}
   const l=el('label','到着を確認済み'),done=el('input');done.type='checkbox';l.prepend(done);l.className='stock-arrival-confirm';box.append(fields,l);host.append(box);plans.push({p,refs,done});
  }
 }
 function values(){
  const w={};if(form.elements.workspaceFba.value!==initial.fba)w.manualFbaQuantity=form.elements.workspaceFba.value===''?null:Number(form.elements.workspaceFba.value);
  if(form.elements.workspaceAlarm.value!==initial.alarm)w.alarmThreshold=form.elements.workspaceAlarm.value===''?null:Number(form.elements.workspaceAlarm.value);
  const incoming=[];for(const {p,refs,done}of plans)if(done.checked)incoming.push({id:p.id,complete:true});else if(Object.keys(refs).some(k=>refs[k].value!==(p[k]||'')))incoming.push({id:p.id,sellerSku:p.sellerSku,quantity:p.quantity,...Object.fromEntries(Object.entries(refs).map(([k,n])=>[k,n.value]))});
  if(form.elements.incomingQuantity.value!=='')incoming.push({quantity:Number(form.elements.incomingQuantity.value),sellerSku:form.elements.sellerSku.value.trim(),stage:form.elements.incomingStage.value,expectedOn:form.elements.incomingDate.value,reference:form.elements.incomingReference.value.trim()});
  else if(form.elements.incomingDate.value||form.elements.incomingReference.value.trim())throw new Error('納品予定の個数を入力してください。');
  if(incoming.length)w.incoming=incoming;return w;
 }
 return {populate,values};
}
