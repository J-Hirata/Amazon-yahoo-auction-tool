import {monitorRequest} from "./monitor-http.js";
import {catalogImage} from "./catalog-view.js";
import {createElement,CalendarClock,RefreshCw,Plus,Search,X,Save,Pencil,History,ClipboardCopy} from "lucide";
import {ACTION_LABELS,ACTION_STAGES} from "../src/planning-actions.js";
import {createProductAccess} from "./product-access.js";

const $=s=>document.querySelector(s),escape=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const shapes={calendar:CalendarClock,refresh:RefreshCw,plus:Plus,search:Search,x:X,save:Save,pencil:Pencil,history:History,copy:ClipboardCopy};
const icon=name=>createElement(shapes[name],{width:18,height:18,"aria-hidden":"true","stroke-width":1.8}).outerHTML;
const conditions={new:"新品",used:"中古",parts:"部品・現状品",unknown:"状態未確認"},kinds={amazon:"Amazonで様子見",advertising:"広告テスト",review:"販売方針の見直し"};
const stages={waiting:"販売・広告開始待ち",watching:"様子見中",advertising:"広告テスト中",due:"見直し時期",hold:"保留",scheduled:"確認待ち",unscheduled:"確認日未設定",closed:"完了"};
const decisions={undecided:"方針未定",...ACTION_LABELS};
const decisionText=plan=>(plan.decisions||[plan.decision||"undecided"]).map(d=>decisions[d]).join(" ／ ");
const fields=["title","asin","sellerSku","condition","setContents","kind","status","availableOn","availabilityNote","adStartedOn","durationDays","reviewOn","decision","note","salesMemo","imageUrl"];
const when=value=>new Date(value).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"});

export async function openPlanning({userId,readOnly}){
  let view,busy=false,filter="all",editing=null,planId,pending,actionDrafts={};
  const form=$("#planningForm"),dialog=$("#planningDialog"),pendingKey="sales-planning-pending:"+userId;
  const access=createProductAccess({readOnly:()=>readOnly,onChanged:async()=>load()});
  const status=(message,error=false)=>{$("#planningStatus").textContent=message;$("#planningStatus").classList.toggle("error",error);};
  let mode="list";try{mode=localStorage.getItem("planning-mode:"+userId)==="tiles"?"tiles":"list";}catch{}
  function showMode(){document.querySelector(".planning-table").classList.toggle("planning-tiles",mode==="tiles");for(const b of document.querySelectorAll("[data-plan-mode]"))b.setAttribute("aria-pressed",String(b.dataset.planMode===mode));}
  for(const b of document.querySelectorAll("[data-plan-mode]"))b.addEventListener("click",()=>{mode=b.dataset.planMode;showMode();try{localStorage.setItem("planning-mode:"+userId,mode);}catch{}});showMode();
  let lookupSerial=0,lookupTimer,lookupPromise=null,lookupAsin="",autoTitle="",inputAsin="";
  const validAsin=value=>/^[A-Z0-9]{10}$/.test(value);
  function showSelected(source){
    const box=$("#planningSelectedProduct"),image=catalogImage(source?.imageUrl||form.elements.imageUrl.value);
    box.hidden=!source&&!image;box.replaceChildren();
    if(box.hidden)return;
    if(image){const img=document.createElement("img");img.src=image;img.alt=source?"選択した商品の参考画像":"Amazon共通カタログ画像";img.referrerPolicy="no-referrer";img.addEventListener("error",()=>{img.hidden=true;});box.append(img);}
    const text=document.createElement("span");text.className='planning-selected-name';
    const title=document.createElement('strong');title.textContent=source?.title||form.elements.title.value||form.elements.asin.value;text.append(title);
    if(source){const detail=document.createElement('small');detail.textContent=[conditions[source.condition],source.asin||'ASINなし',source.sellerSku?'SKU：'+source.sellerSku:'SKU未指定',source.setContents].filter(Boolean).join(' ／ ');text.append(detail);}
    box.append(text);
    if(source){
      const availability=source.availability,locations=source.locations||[],quantity=v=>Number.isSafeInteger(v)&&v>=0?v+'個':'未確認';
      const values=[[availability?.fba?.source==='manual'?'FBA（手入力）':'FBA',availability?availability.fba?.quantity:source.fba?.quantity],['ヤフオク',availability?.yahooQuantity],['コンテナ',locations.find(l=>l.locationId==='container')?.usable],['会社・自宅',locations.find(l=>l.locationId==='home')?.usable]];
      const counts=document.createElement('dl');counts.className='planning-source-stock';
      for(const [label,value] of values){const item=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=label==='ヤフオク'&&!source.listingIds?.length?'未登録':quantity(value);item.append(dt,dd);counts.append(item);}box.append(counts);
      const notes=source.notes?.length?source.notes:source.memo?[{label:'在庫メモ',text:source.memo}]:[];
      for(const note of notes){const p=document.createElement('p');p.className='planning-source-note';const label=document.createElement('small');label.textContent=note.label;p.append(label,document.createTextNode(note.text));box.append(p);}
      const a=document.createElement('a');a.href=source.href;a.target='_blank';a.rel='noopener noreferrer';a.textContent='元の商品を別タブで開く';a.className='planning-source-origin';box.append(a);
    }
    if(!source&&image){const caption=document.createElement("small");caption.textContent="Amazon共通カタログ画像";box.append(caption);}
  }
  function renderSources(){
    const query=$("#planningSourceSearch").value.trim().toLowerCase();
    const sources=view.sources.filter(s=>[s.title,s.asin,s.sellerSku].join(" ").toLowerCase().includes(query));
    $("#planningSourceCards").innerHTML=sources.length?sources.map(s=>{
      const existing=existingForSource(s.kind,s.id);
      return `<button type="button" class="planning-source-card" data-plan-source="${escape(s.kind+":"+s.id)}"><img src="${escape(catalogImage(s.imageUrl)||"/catalog-image.svg")}" alt="商品参考画像" loading="lazy" referrerpolicy="no-referrer"><span><strong>${escape(s.title)}</strong><small>${s.kind==="stock"?"コンテナ・自社在庫":"Amazon・ヤフオクの紐付け"} ／ ${escape(conditions[s.condition])}</small><small>${escape(s.asin||"ASINなし")}</small>${s.setContents?`<small>${escape(s.setContents)}</small>`:""}<small>${existing?"登録済みの計画を開く":"この商品を選ぶ"}</small></span></button>`;
    }).join(""):"<p>該当する商品はありません。新規ASINからも登録できます。</p>";
    for(const button of document.querySelectorAll("[data-plan-source]"))button.addEventListener("click",()=>{
      if(busy||readOnly||pending)return;
      const [kind,id]=button.dataset.planSource.split(":"),existing=existingForSource(kind,id);
      if(existing){open(existing);return;}
      form.elements.source.value=button.dataset.planSource;sourceChanged();$("#planningSources").open=false;
    });
    for(const img of document.querySelectorAll(".planning-source-card img"))img.addEventListener("error",()=>{if(img.getAttribute("src")!=="/catalog-image.svg")img.src="/catalog-image.svg";});
  }
  function existingForSource(kind,id){
    const related=access.info(kind+':'+id).live?.workspace?.plans||[];
    return view.plans.find(p=>p.status!=='closed'&&(p.source.kind===kind&&p.source.id===id||related.some(r=>r.id===p.id)));
  }
  function lookupProduct(){
    const asin=form.elements.asin.value.trim().toUpperCase();
    if(form.elements.source.value!=="manual"||!validAsin(asin)||!view.catalogRead||readOnly)return Promise.resolve();
    if(lookupAsin===asin)return lookupPromise||Promise.resolve();
    const serial=++lookupSerial,title=form.elements.title.value;
    lookupAsin=asin;$("#planningCatalogStatus").textContent="商品名・写真を取得しています…";
    lookupPromise=(async()=>{
      try{
        const response=await monitorRequest("/api/sales-planning/catalog",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({asin})});
        const product=await response.json();if(!response.ok)throw new Error(product.error);
        if(serial!==lookupSerial||!dialog.open||form.elements.source.value!=="manual"||form.elements.asin.value.trim().toUpperCase()!==asin)return;
        if(product.asin!==asin)throw new Error("取得した商品のASINが一致しません");
        if(product.title&&(!form.elements.title.value||form.elements.title.value===autoTitle||form.elements.title.value===asin)&&form.elements.title.value===title){form.elements.title.value=product.title;autoTitle=product.title;}
        if(!form.elements.imageUrl.value)form.elements.imageUrl.value=catalogImage(product.imageUrl)||"";
        showSelected();$("#planningCatalogStatus").textContent=product.title?"商品情報を取得しました。保存すると登録されます。":"商品名は未取得です。ASINのまま登録できます。";
      }catch{
        if(serial===lookupSerial&&dialog.open)$("#planningCatalogStatus").textContent="商品情報を取得できませんでした。ASINのまま登録できます。";
      }
    })();
    return lookupPromise;
  }
  try{pending=JSON.parse(sessionStorage.getItem(pendingKey)||"null");if(pending&&!/^[0-9a-f-]{36}$/i.test(pending.command?.operationId||""))pending=null;}catch{pending=null;}
  for(const el of document.querySelectorAll("[data-plan-icon]"))el.innerHTML=icon(el.dataset.planIcon);
  function controls(){
    for(const button of document.querySelectorAll(".planning-shell button"))if(!button.closest('.product-access'))button.disabled=busy;
    for(const button of document.querySelectorAll("#planningNew,#planningSave,[data-plan-edit],[data-plan-source-fix]"))button.disabled=busy||readOnly||Boolean(pending)||!view;
    $("#planningFields").disabled=busy||readOnly||Boolean(pending);$("#planningPending").hidden=!pending;
    $("#planningRetry").disabled=busy||readOnly;
  }
  async function request(path="",command,revision=view?.revision){
    const response=await monitorRequest("/api/sales-planning"+path,command===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json","If-Match":`"${revision}"`},body:JSON.stringify({command})});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||"販売計画を保存できません"),{status:response.status});return data;
  }
  async function work(callback){if(busy)return;busy=true;controls();try{await callback();}catch(error){status(error.message,true);if(dialog.open)$("#planningFormStatus").textContent=error.message;}finally{busy=false;controls();}}
  const actionDue=p=>p.actionSchedules?.some(a=>["start","due"].includes(a.stage));
  const datedActions=p=>p.actionSchedules?.some(a=>a.startsOn||a.endsOn);
  const nextCheck=p=>datedActions(p)?p.actionSchedules.map(a=>a.nextOn).filter(Boolean).sort()[0]||"":p.schedule.dueOn;
  function matches(p,key){if(key==="all")return true;if(p.status==="closed")return key==="closed";if(key==="due")return datedActions(p)?actionDue(p):p.schedule.stage==="due";if(key==="waiting")return datedActions(p)?p.actionSchedules.some(a=>["waiting","blocked","undated"].includes(a.stage)):["waiting","unscheduled"].includes(p.schedule.stage);if(key==="active")return datedActions(p)?p.actionSchedules.some(a=>a.stage==="active"):["watching","advertising","scheduled","hold"].includes(p.schedule.stage);return p.schedule.stage===key;}
  function render(){
    $("#planningCount").textContent=`${view.plans.length}商品 ／ 見直し時期 ${view.plans.filter(p=>matches(p,"due")).length}件`;
    for(const tab of document.querySelectorAll("[data-plan-filter]")){tab.setAttribute("aria-selected",String(tab.dataset.planFilter===filter));tab.querySelector("span").textContent=view.plans.filter(p=>matches(p,tab.dataset.planFilter)).length;}
    const query=$("#planningSearch").value.trim().toLowerCase(),sort=$("#planningSort").value;
    const plans=view.plans.filter(p=>matches(p,filter)&&[p.title,p.asin,p.sellerSku,p.note,p.salesMemo].join(" ").toLowerCase().includes(query)).sort((a,b)=>sort==="new"?b.createdAt.localeCompare(a.createdAt):sort==="old"?a.createdAt.localeCompare(b.createdAt):(nextCheck(a)||"9999").localeCompare(nextCheck(b)||"9999")||a.createdAt.localeCompare(b.createdAt));
    $("#planningRows").innerHTML=plans.length?plans.map(p=>{
      const schedule=p.schedule,source=p.reference,photo=catalogImage(source?.imageUrl||p.imageUrl)||"/catalog-image.svg",date=nextCheck(p)||"未設定",remaining=date==="未設定"?null:Math.round((Date.parse(date)-Date.parse(new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"})))/86400000);
      const live=access.info("plan:"+p.id).live,fbaQuantity=live?.availability?live.availability.fba.quantity:live?live.fba?.quantity:source?.availability?source.availability.fba.quantity:source?.fba?.quantity;
      const location=source?.locations?.map(l=>`${l.locationId==="container"?"コンテナ":"自宅・会社"} <b>${l.usable===null?"未確認":escape(l.usable)+"個"}</b>`).join("<br>")||"";
      const references=p.referenceIssue?`<span class="error">${escape(p.referenceIssue)}</span>`:source?`${location?`<span>${location}</span>`:""}<span>FBA数量：<b>${Number.isSafeInteger(fbaQuantity)?escape(fbaQuantity)+"個":"未確認"}</b></span><span>ヤフオク：${source.listingIds?.length?source.listingIds.map(id=>`<a href="https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">${escape(id)}</a>`).join(" ／ "):"関連付けなし"}</span><a href="${escape(source.href)}">元の商品を確認</a>`:"在庫台帳への登録なし";
      const asinLink=p.asin?` ／ <a href="https://www.amazon.co.jp/dp/${encodeURIComponent(p.asin)}" target="_blank" rel="noopener noreferrer">${escape(p.asin)}</a>`:" ／ ASIN未登録";
      const sales=p.salesMemo?`<p class="planning-note">${escape(p.salesMemo)}</p>`:'<span class="planning-meta">販売実績：未記録</span>';
      const copy=p.asin?`<button type="button" data-plan-copy="${escape(p.asin)}" class="planning-secondary" aria-label="ASINをコピー" title="ASINをコピー">${icon("copy")}</button>`:"";
      return `<tr data-plan-id="${escape(p.id)}">
        <td><div class="planning-product"><img class="planning-photo" src="${escape(photo)}" alt="商品参考画像" loading="lazy" referrerpolicy="no-referrer"><div>
          <strong>${escape(p.title)}</strong><span class="planning-meta">${escape(conditions[p.condition])}${asinLink}</span>
          ${p.sellerSku?`<span class="planning-meta">SKU：${escape(p.sellerSku)}</span>`:""}${p.setContents?`<span class="planning-meta">${escape(p.setContents)}</span>`:""}</div></div>${(source?.notes||[]).map(n=>`<p class="planning-source-note"><small>${escape(n.label)}</small>${escape(n.text)}</p>`).join('')}<div data-plan-access="${p.id}"></div></td>
        <td data-label="現在の取り組み"><span class="planning-badge ${escape(schedule.stage)}">${escape(stages[schedule.stage])}</span>
          <div>${escape(kinds[p.kind])}${p.kind!=="review"?` ／ ${p.durationDays}日`:""}</div><span class="planning-meta">販売可能日：${escape(p.availableOn||"未確認")}</span>
          ${p.kind==="advertising"?`<span class="planning-meta">広告開始日：${escape(p.adStartedOn||"未確認")}</span>`:""}<span class="planning-meta">広告配信状況：未確認（広告API未接続）</span>${sales}</td>
        <td data-label="確認日"><div class="planning-date ${schedule.stage==="due"?"planning-due":""}">${escape(date)}</div><span class="planning-meta">${remaining===null?"":remaining===0?"今日確認":remaining<0?`${-remaining}日経過`:`あと${remaining}日`}</span></td>
        <td data-label="在庫・販売先の参照"><div class="planning-reference">${references}</div></td>
        <td data-label="次の方針・操作"><strong>${escape(decisionText(p))}</strong>${(p.actionSchedules||[]).length?`<ol class="planning-timeline">${p.actionSchedules.map(a=>`<li class="${escape(a.stage)}"><b>${escape(a.label)}</b><span>${escape(a.startsOn||"開始日未設定")} → ${escape(a.endsOn||"締切未設定")}</span><span>${escape(ACTION_STAGES[a.stage])}${a.dependsOn?` ／ ${escape(a.conditionLabel)}`:""}</span>${a.outcome!=="pending"?`<span>結果：${escape(({good:"良好",poor:"不調",other:"その他"})[a.outcome])}</span>`:""}${a.note?`<span>${escape(a.note)}</span>`:""}</li>`).join("")}</ol>`:""}${p.note?`<p class="planning-note">${escape(p.note)}</p>`:""}
          <div class="planning-row-actions"><button type="button" data-plan-edit="${p.id}">${icon("pencil")}方針・日付</button>
          <button type="button" data-plan-history="${p.id}" class="planning-secondary" aria-label="${escape(p.title)}の履歴" title="判断の履歴">${icon("history")}</button>${copy}${p.referenceIssue&&p.source.kind==="stock"?`<button type="button" data-plan-source-fix="${p.id}">元在庫のASIN・SKUに合わせる</button>`:""}</div></td></tr>`;
    }).join(""):`<tr><td class="planning-empty" colspan="5">${icon("calendar")}${view.plans.length?"条件に一致する商品がありません":"まだ販売計画は登録されていません"}</td></tr>`;
    for(const img of document.querySelectorAll(".planning-photo"))img.addEventListener("error",()=>{if(img.getAttribute("src")!=="/catalog-image.svg")img.src="/catalog-image.svg";});
    for(const host of document.querySelectorAll('[data-plan-access]')){const p=view.plans.find(p=>p.id===host.dataset.planAccess);access.mount(host,'plan:'+p.id,{asin:p.asin,title:p.title,listingIds:p.reference?.listingIds||[]});}
    for(const button of document.querySelectorAll("[data-plan-edit]"))button.addEventListener("click",()=>open(view.plans.find(p=>p.id===button.dataset.planEdit)));
    for(const button of document.querySelectorAll("[data-plan-history]"))button.addEventListener("click",()=>historyFor(button.dataset.planHistory));
    for(const button of document.querySelectorAll("[data-plan-source-fix]"))button.addEventListener("click",()=>work(async()=>{
      if(readOnly||pending)return;
      const p=view.plans.find(p=>p.id===button.dataset.planSourceFix),s=view.sources.find(s=>s.kind==="stock"&&s.id===p.source.id);
      if(!s)throw new Error("元在庫を確認してください");
      $("#planningHistoryRows").innerHTML=`<h3>元在庫の商品情報に合わせる</h3><p>${escape(p.title)}</p><p>ASIN：${escape(p.asin)} → ${escape(s.asin)}</p><p>SKU：${escape(p.sellerSku||"未指定")} → ${escape(s.sellerSku||"未指定")}</p><p>同じ商品の登録訂正であることを確認してください。方針・日付・現物数量は維持します。</p><button id="planningSourceFixConfirm" type="button">この内容で訂正する</button>`;
      $("#planningSourceFixConfirm").addEventListener("click",()=>work(async()=>{
        if(readOnly||pending)return;
        pending={command:{operationId:crypto.randomUUID(),planId:p.id,kind:"reconcile_source",expectedAsin:p.asin,confirmed:true,reason:"元在庫の商品情報訂正に合わせてASIN・SKUを再照合"},revision:view.revision};
        try{sessionStorage.setItem(pendingKey,JSON.stringify(pending));}catch{pending=null;throw new Error("保存受付を記録できません");}
        await sendPending();$("#planningHistory").close();
      }));
      $("#planningHistory").showModal();
    }));
    for(const button of document.querySelectorAll("[data-plan-copy]"))button.addEventListener("click",()=>work(async()=>{await navigator.clipboard.writeText(button.dataset.planCopy);status("ASINをコピーしました。出品状態は変更していません。");}));
    controls();
  }
  async function load(){view=await request();await access.load();render();}
  function updateFields(){
    const isReview=form.elements.kind.value==="review",hold=form.elements.status.value==="hold",closed=form.elements.status.value==="closed";
    for(const el of document.querySelectorAll("[data-plan-period]"))el.hidden=isReview||hold||closed;
    for(const el of document.querySelectorAll("[data-plan-review]"))el.hidden=(!isReview&&!hold)||closed;
    for(const el of document.querySelectorAll("[data-plan-availability]"))el.hidden=isReview||closed;
    for(const el of document.querySelectorAll("[data-plan-ad]"))el.hidden=form.elements.kind.value!=="advertising"||closed;
    const today=new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});form.elements.availableOn.max=today;form.elements.adStartedOn.max=today;
  }
  function sourceChanged(){
    lookupSerial++;lookupAsin="";lookupPromise=null;clearTimeout(lookupTimer);autoTitle="";form.elements.imageUrl.value="";$("#planningCatalogStatus").textContent="";
    if(editing)return;const [kind,id]=form.elements.source.value.split(":"),source=view.sources.find(s=>s.kind===kind&&s.id===id);
    for(const name of ["title","asin","sellerSku","condition","setContents"]){if(source)form.elements[name].value=source[name]||"";else form.elements[name].value=name==="condition"?"unknown":"";}
    for(const name of ["asin","sellerSku","setContents"])form.elements[name].readOnly=Boolean(source);
    form.elements.condition.disabled=Boolean(source&&source.condition!=="unknown");
    form.elements.imageUrl.value=source?.imageUrl||'';
    inputAsin=form.elements.asin.value;showSelected(source);$("#planningManual").hidden=true;$("#planningSources").hidden=Boolean(source);
    $("#planningIdentity").open=!source;
    $("#planningDialogTitle").textContent=source?'この商品の販売見直し':'商品を追加';
    $("#planningSave").innerHTML=icon('save')+(source?'見直し対象に追加':'保存');
    if(source){form.elements.kind.value='review';$("#planningSources").open=false;}updateFields();
  }
  function open(plan){
    lookupSerial++;lookupAsin="";lookupPromise=null;autoTitle="";clearTimeout(lookupTimer);
    editing=plan||null;planId=plan?.id||crypto.randomUUID();form.reset();$("#planningFormStatus").textContent="";
    form.elements.imageUrl.value="";form.elements.availabilityNote.value="";
    $("#planningCatalogStatus").textContent="";$("#planningSourceSearch").value="";$("#planningSources").open=false;$("#planningSources").hidden=Boolean(plan);$("#planningManual").hidden=true;
    $("#planningDialogTitle").textContent=plan?"方針・確認日を変更":"商品を追加";$("#planningSave").innerHTML=icon('save')+'保存';$("#planningIdentity").open=!plan||plan.source.kind==='manual';
    const selected=new Set(plan?.decisions||[plan?.decision||"undecided"]);
    actionDrafts=Object.fromEntries((plan?.actions||[]).map(a=>[a.decision,{...a}]));
    $("#planningDecisions").innerHTML=Object.entries(decisions).filter(([key])=>key!=="undecided").map(([key,label])=>`<label><input type="checkbox" name="decisions" value="${key}" ${selected.has(key)?"checked":""}>${escape(label)}</label>`).join("");
    renderActionEditors();
    const source=form.elements.source;source.innerHTML='<option value="manual">ASIN・商品名から登録</option>';
    for(const [kind,label] of [["stock","コンテナ・自社在庫"],["link","Amazon・ヤフオクの紐付け商品"]]){const group=document.createElement("optgroup");group.label=label;for(const row of view.sources.filter(s=>s.kind===kind)){const option=document.createElement("option");option.value=kind+":"+row.id;option.textContent=`${row.title} ／ ${conditions[row.condition]} ／ ${row.sellerSku||row.asin||"ASINなし"}`;group.append(option);}source.append(group);}
    if(plan){if(plan.source.kind!=="manual"&&!view.sources.some(s=>s.kind===plan.source.kind&&s.id===plan.source.id)){const option=document.createElement("option");option.value=plan.source.kind+":"+plan.source.id;option.textContent="元の参照先（現在は確認できません）";source.append(option);}for(const name of fields)form.elements[name].value=plan[name]??"";source.value=plan.source.kind==="manual"?"manual":plan.source.kind+":"+plan.source.id;}
    source.disabled=Boolean(plan);for(const name of ["asin","sellerSku","setContents"])form.elements[name].readOnly=Boolean(plan?.[name]);form.elements.condition.disabled=Boolean(plan&&plan.condition!=="unknown");
    inputAsin=form.elements.asin.value;renderSources();showSelected(plan?.reference);updateFields();controls();if(!dialog.open)dialog.showModal();
    if(plan?.source.kind==="manual"&&(!plan.imageUrl||plan.title===plan.asin))void lookupProduct();
  }
  function captureActions(){for(const panel of document.querySelectorAll('[data-action-editor]')){const a=actionDrafts[panel.dataset.actionEditor];for(const input of panel.querySelectorAll('[data-action-field]'))a[input.dataset.actionField]=input.value;}}
  function renderActionEditors(){
    const selected=[...form.querySelectorAll('[name="decisions"]:checked')].map(i=>i.value);
    for(const d of selected)actionDrafts[d]||={id:crypto.randomUUID(),decision:d,startsOn:"",endsOn:"",dependsOn:"",trigger:"always",status:"planned",outcome:"pending",note:""};
    const select=(a,field,title,options)=>`<label>${title}<select data-action-field="${field}" aria-label="${escape(decisions[a.decision]+"："+title)}">${options.map(([v,l])=>`<option value="${escape(v)}" ${a[field]===v?"selected":""}>${escape(l)}</option>`).join("")}</select></label>`;
    $("#planningActionEditors").innerHTML=selected.map(d=>{const a=actionDrafts[d];return `<section data-action-editor="${d}" class="planning-action-editor"><h3>${escape(decisions[d])}</h3><div class="planning-action-fields"><label>開始日<input type="date" data-action-field="startsOn" value="${escape(a.startsOn)}" aria-label="${escape(decisions[d]+"：開始日")}"></label><label>締切日<input type="date" data-action-field="endsOn" value="${escape(a.endsOn)}" aria-label="${escape(decisions[d]+"：締切日")}"></label>${select(a,"dependsOn","前のアクション",[["","なし（日付だけで確認）"],...selected.filter(p=>p!==d).map(p=>[actionDrafts[p].id,decisions[p]])])}${select(a,"trigger","始める条件",[["always","日付／前の結果を記録したら"],["poor","前の結果が悪ければ"],["good","前の結果が良ければ"]])}${select(a,"status","進み具合",[["planned","予定"],["active","取り組み中"],["done","結果を記録済み"],["cancelled","取りやめ"]])}${select(a,"outcome","結果",[["pending","まだ判断していない"],["good","良好"],["poor","不調"],["other","その他"]])}<label class="planning-wide">実施内容・判断基準<input data-action-field="note" value="${escape(a.note)}" maxlength="500" aria-label="${escape(decisions[d]+"：実施内容・判断基準")}" placeholder="例：売れなければ次の販路へ／好調なら追加納品"></label></div></section>`;}).join("");
  }
  $("#planningDecisions").addEventListener("change",()=>{captureActions();renderActionEditors();});
  $("#planningActionEditors").addEventListener("change",e=>{const panel=e.target.closest('[data-action-editor]');if(!panel)return;if(e.target.dataset.actionField==="outcome"&&e.target.value!=="pending")panel.querySelector('[data-action-field="status"]').value="done";if(e.target.dataset.actionField==="status"&&e.target.value!=="done")panel.querySelector('[data-action-field="outcome"]').value="pending";});
  function historyFor(id){
    const plan=view.plans.find(p=>p.id===id);$("#planningHistoryTitle").textContent=plan.title+"：判断の履歴";
    const events=view.events.filter(e=>e.planId===id).map(e=>`<section class="planning-event">
      <strong>${escape(when(e.at))} ／ ${e.before?"方針・日付を更新":"計画を登録"}</strong>
      <p>${escape(e.before?decisionText(e.before)+" → ":"")}${escape(decisionText(e.after))}</p>
      <p>${escape(kinds[e.after.kind])} ／ ${e.after.durationDays}日 ／ ${escape(e.after.status==="hold"?"保留":e.after.status==="closed"?"完了":"確認継続")}</p>
      <p>販売可能日：${escape(e.after.availableOn||"未確認")} ／ 広告開始：${escape(e.after.adStartedOn||"未確認")} ／ 確認日：${escape(e.after.reviewOn||"期間から算出")}</p>
      <p>${escape(e.after.availabilityNote)}</p><p>${escape(e.after.salesMemo)}</p><p>${escape(e.after.note)}</p>${(e.after.actions||[]).map(a=>`<p>${escape(decisions[a.decision])}：${escape(a.startsOn||"未設定")} → ${escape(a.endsOn||"未設定")} ／ ${escape(a.status)} ／ ${escape(a.outcome)}</p>`).join("")}</section>`).join("");
    $("#planningHistoryRows").innerHTML='<p class="planning-meta">全商品の直近100件の記録から表示</p>'+(events||"履歴はありません");$("#planningHistory").showModal();
  }
  function clearPending(){pending=null;sessionStorage.removeItem(pendingKey);}
  async function sendPending(){
    try{const result=await request("/operations",pending.command,pending.revision);clearPending();view=result.result;await access.load();render();dialog.close();status("販売計画を保存しました。在庫・出品・広告は変更していません。");}
    catch(error){if(error.status>=400&&error.status<500){clearPending();await load();}throw error;}
  }
  form.addEventListener("submit",event=>{event.preventDefault();void work(async()=>{
    const asin=form.elements.asin.value.trim().toUpperCase();form.elements.asin.value=asin;
    if(!form.elements.title.value.trim()&&!validAsin(asin))throw new Error("ASINまたは商品名を入力してください");
    clearTimeout(lookupTimer);await lookupProduct();
    const values=Object.fromEntries(fields.map(name=>[name,form.elements[name].value]));values.durationDays=Number(values.durationDays);const [kind,id]=form.elements.source.value.split(":");values.source={kind,id:id||""};
    values.decisions=[...form.querySelectorAll('[name="decisions"]:checked')].map(input=>input.value);if(!values.decisions.length)values.decisions=["undecided"];values.decision=values.decisions[0];
    captureActions();values.actions=values.decisions.filter(d=>d!=="undecided").map(d=>({...actionDrafts[d]}));
    const command={operationId:crypto.randomUUID(),planId,kind:editing?"edit":"create",plan:values};
    pending={command,revision:view.revision};try{sessionStorage.setItem(pendingKey,JSON.stringify(pending));}catch{pending=null;throw new Error("保存受付をこのブラウザーへ記録できません。ブラウザーの保存設定を確認してください。");}
    await sendPending();
  });});
  $("#planningNew").addEventListener("click",()=>open());$("#planningRefresh").addEventListener("click",()=>work(load));
  $("#planningSearch").addEventListener("input",render);$("#planningSort").addEventListener("change",render);
  for(const tab of document.querySelectorAll("[data-plan-filter]")){tab.addEventListener("click",()=>{filter=tab.dataset.planFilter;render();});tab.addEventListener("keydown",event=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll("[data-plan-filter]")],index=tabs.indexOf(tab),next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(index+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();});}
  form.elements.source.addEventListener("change",sourceChanged);for(const name of ["kind","status"])form.elements[name].addEventListener("change",updateFields);
  $("#planningSourceSearch").addEventListener("input",renderSources);
  $("#planningManual").addEventListener("click",()=>{form.elements.source.value="manual";sourceChanged();form.elements.asin.focus();});
  form.elements.asin.addEventListener("input",()=>{
    const asin=form.elements.asin.value.trim().toUpperCase();
    if(asin!==inputAsin){lookupSerial++;lookupAsin="";lookupPromise=null;clearTimeout(lookupTimer);form.elements.imageUrl.value="";if(form.elements.title.value===autoTitle)form.elements.title.value="";autoTitle="";inputAsin=asin;showSelected();$("#planningCatalogStatus").textContent="";}
    if(validAsin(asin))lookupTimer=setTimeout(()=>void lookupProduct(),350);
  });
  form.elements.asin.addEventListener("blur",()=>{clearTimeout(lookupTimer);void lookupProduct();});
  dialog.addEventListener("close",()=>{if(!dialog.open){lookupSerial++;clearTimeout(lookupTimer);}});
  form.elements.availableOn.addEventListener("change",updateFields);
  for(const button of document.querySelectorAll("[data-plan-close]"))button.addEventListener("click",()=>dialog.close());
  $("#planningHistoryClose").addEventListener("click",()=>$("#planningHistory").close());
  $("#planningReconcile").addEventListener("click",()=>work(async()=>{await request("/operations/"+pending.command.operationId);clearPending();await load();dialog.close();status("保存済みの計画を確認しました。重複登録していません。");}));
  $("#planningRetry").addEventListener("click",()=>work(sendPending));
  await load();
  const hash=new URLSearchParams(location.hash.slice(1)),requested=hash.get("plan"),direct=hash.get("id");
  if(direct){const p=view.plans.find(p=>p.id===direct);if(p&&!readOnly&&!pending)open(p);}
  if(requested){
    const match=requested.match(/^(stock|link):([0-9a-f-]{36})$/i),source=match&&view.sources.find(s=>s.kind===match[1]&&s.id===match[2]);
    history.replaceState(null,"",location.pathname+location.search);
    if(source&&!readOnly&&!pending){
      const existing=existingForSource(source.kind,source.id);
      if(existing){open(existing);status("登録済みの販売計画を開きました。");}
      else{open();form.elements.source.value=source.kind+":"+source.id;sourceChanged();status("選んだ商品を引き継ぎました。保存すると販売見直しへ追加されます。");}
    }else status("引き継ぐ商品を確認できません。写真付きの商品選択から選び直してください。",true);
  }
}
