const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
export function createInlineMonitoringFields(form){
 const panel=el('section');panel.className='stock-inline-monitoring';panel.hidden=true;
 panel.innerHTML='<p><strong>販売の監視をこの画面で設定</strong></p><label data-plan-select hidden>設定する販売監視<select name="workspacePlanId"></select></label><div class="stock-form-grid"><label data-monitor-start>販売監視の開始日（任意）<input name="workspaceMonitorStart" type="date"></label><label data-monitor-days>何日間確認するか（任意）<input name="workspaceMonitorDays" type="number" min="1" max="365" step="1" placeholder="10"></label><label data-monitor-ad hidden>広告の開始日（任意）<input name="workspaceMonitorAd" type="date"></label><label data-monitor-review hidden>確認日（任意）<input name="workspaceMonitorReview" type="date"></label></div><p data-monitor-period role="status"></p><label>販売監視の目的・メモ（任意）<textarea name="workspaceMonitorNote" rows="3" maxlength="1000" placeholder="例：10日間売れなければ古物市場への出品を検討"></textarea></label><small>空欄のままでも登録できます。開始日が未設定なら期間の計測はまだ始まりません。メモは監視の案内にも表示します。</small>';
 form.elements.alsoPlanning.closest('label').after(panel);
 let plans=[],initial={availableOn:'',durationDays:'10',adStartedOn:'',reviewOn:'',note:''};
 const names={availableOn:'workspaceMonitorStart',durationDays:'workspaceMonitorDays',adStartedOn:'workspaceMonitorAd',reviewOn:'workspaceMonitorReview',note:'workspaceMonitorNote'};
 function selected(){return plans.find(p=>p.id===form.elements.workspacePlanId.value);}
 function period(){
  const f=form.elements,plan=selected(),start=plan?.kind==='advertising'?f.workspaceMonitorAd.value:f.workspaceMonitorStart.value,days=Number(f.workspaceMonitorDays.value||initial.durationDays||10);
  let end=plan?.kind==='review'?f.workspaceMonitorReview.value:'';
  if(!end&&/^\d{4}-\d{2}-\d{2}$/.test(start)&&Number.isInteger(days)&&days>=1&&days<=365)end=new Date(Date.parse(start+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
  panel.querySelector('[data-monitor-period]').textContent='販売監視期間 '+(start||'開始日未設定')+' → '+(end||'確認日未設定')+(plan?.actionCount?' ／ 個別アクションの設定は保持します':'');
 }
 function fill(){
  const p=selected(),f=form.elements;initial=Object.fromEntries(Object.entries(names).map(([k])=>[k,String(p?.[k]??(k==='durationDays'?10:''))]));
  for(const [k,name]of Object.entries(names))f[name].value=initial[k];
  const review=p?.kind==='review';panel.querySelector('[data-monitor-start]').hidden=review;panel.querySelector('[data-monitor-days]').hidden=review;panel.querySelector('[data-monitor-review]').hidden=!review;panel.querySelector('[data-monitor-ad]').hidden=p?.kind!=='advertising';
  period();sync();
 }
 function sync(){panel.hidden=!form.elements.alsoPlanning.checked;for(const input of panel.querySelectorAll('input,textarea,select'))input.disabled=Boolean(input.closest('[hidden]'));}
 form.elements.alsoPlanning.addEventListener('change',sync);form.elements.workspacePlanId.addEventListener('change',fill);panel.addEventListener('input',period);
 function populate(live){
  plans=(live?.workspace?.plans||[]).filter(p=>p.status!=='closed');const select=form.elements.workspacePlanId;select.replaceChildren();
  if(plans.length!==1){const o=el('option',plans.length?'対象を選択':'新しい販売監視');o.value='';select.append(o);}
  for(const p of plans){const o=el('option',p.title);o.value=p.id;select.append(o);}
  panel.querySelector('[data-plan-select]').hidden=plans.length<2;fill();sync();
 }
 function values(){
  if(!form.elements.alsoPlanning.checked)return;
  const result={};for(const [k,name]of Object.entries(names)){
   const value=form.elements[name].value.trim();if(k==='durationDays'&&value==='')continue;
   if(value!==initial[k])result[k]=k==='durationDays'?Number(value):value;
  }
  if(!Object.keys(result).length)return;
  if(form.elements.workspacePlanId.value)result.planId=form.elements.workspacePlanId.value;
  return result;
 }
 function choose(plan){if(!plans.some(p=>p.id===plan.id)){plans.push(plan);const option=el('option',plan.title);option.value=plan.id;form.elements.workspacePlanId.append(option);}form.elements.workspacePlanId.value=plan.id;fill();sync();}
 return {populate,values,sync,choose};
}
