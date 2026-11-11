import {createTileSize} from './tile-size.js';
const modes = ["list", "tiles"], sorts = ["original", "manual", "dateDesc", "dateAsc", "titleAsc", "titleDesc", "measureDesc", "measureAsc"];
const ids=value=>[...new Set((Array.isArray(value)?value:[]).filter(id=>typeof id==="string"&&id.length>0&&id.length<=200))].slice(0,10000);
export function presentationSettings(value) {
  return {mode:modes.includes(value?.mode)?value.mode:"list",sort:sorts.includes(value?.sort)?value.sort:"original",order:ids(value?.order),size:["small","standard","large"].includes(value?.size)?value.size:"standard"};
}
// Reordering a filtered view must not discard the positions of hidden products.
export function mergeManualOrder(saved,visible) {
  const previous=ids(saved),next=ids(visible),set=new Set(next);let index=0;
  return [...previous.map(id=>set.has(id)?next[index++]:id),...next.slice(index)];
}
export function presentationOrder(entries, sort, order=[]) {
  const rank=new Map(ids(order).map((id,index)=>[id,index]));
  return entries.map((entry,index)=>({entry,index})).sort((a,b)=>{
    const x=a.entry,y=b.entry;
    if(sort==="manual")return (rank.get(String(x.id))??Infinity)-(rank.get(String(y.id))??Infinity)||a.index-b.index;
    if(sort==="dateAsc"||sort==="dateDesc"){
      const xd=typeof x.registeredAt==="string"?Date.parse(x.registeredAt):NaN,yd=typeof y.registeredAt==="string"?Date.parse(y.registeredAt):NaN;
      if(Number.isFinite(xd)!==Number.isFinite(yd))return Number.isFinite(xd)?-1:1;
      return (Number.isFinite(xd)?(xd-yd)*(sort==="dateDesc"?-1:1):0)||a.index-b.index;
    }
    if(sort==="titleAsc"||sort==="titleDesc")return String(x.title||"").localeCompare(String(y.title||""),"ja",{numeric:true})*(sort==="titleDesc"?-1:1)||a.index-b.index;
    if(sort==="measureAsc"||sort==="measureDesc"){
      const valid=v=>typeof v==="number"&&Number.isFinite(v),xKnown=valid(x.measure),yKnown=valid(y.measure);
      if(xKnown!==yKnown)return xKnown?-1:1;
      return (xKnown?(x.measure-y.measure)*(sort==="measureDesc"?-1:1):0)||a.index-b.index;
    }
    return a.index-b.index;
  }).map(x=>x.entry);
}
export function catalogImage(value) {
  try {const u=new URL(value);if(u.protocol==="https:"&&!u.username&&!u.password&&!u.port&&(u.hostname.endsWith(".yimg.jp")||["m.media-amazon.com","images-na.ssl-images-amazon.com","images-fe.ssl-images-amazon.com"].includes(u.hostname)))return u.href;} catch {}
  return "";
}
const node=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
const icon=(name)=>{const img=node("img");img.src=`/catalog-${name}.svg`;img.alt="";img.width=18;img.height=18;return img;};

// Presentation preferences only. The original controls and their listeners stay in place.
export function createCatalogView({key,host,roots,measureLabels=["数量 多い順","数量 少ない順"],defaultMode="list",onReorder=()=>{}}) {
  let settings;try{settings=presentationSettings(JSON.parse(localStorage.getItem("catalog-view:"+key)||"null")||{mode:defaultMode});}catch{settings=presentationSettings({mode:defaultMode});}
  const expanded=new Set(), groups=new Map(), sortables=new Map(), bar=node("div","catalog-controls"), segmented=node("div","catalog-modes"),live=node("span","catalog-live");
  live.setAttribute("role","status");live.setAttribute("aria-live","polite");bar.append(live);
  const resize=root=>{const width=root.clientWidth,columns=width>=1120?5:width>=900?4:width>=660?3:2;root.style.setProperty("--catalog-columns",columns);root.classList.toggle("catalog-dense",columns===5);};
  const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(entries=>entries.forEach(({target})=>resize(target))):null;
  for(const root of roots)observer?.observe(root);
  bar.dataset.catalogControls=key;segmented.setAttribute("role","group");segmented.setAttribute("aria-label","表示形式");
  const buttons=modes.map(mode=>{
    const button=node("button","catalog-mode");button.type="button";button.dataset.catalogMode=mode;
    button.title=mode==="list"?"リスト表示":"タイル表示";button.setAttribute("aria-label",button.title);button.append(icon(mode),node("span","",mode==="list"?"リスト":"タイル"));
    button.addEventListener("click",()=>{settings.mode=mode;apply();save();});segmented.append(button);return button;
  });
  const label=node("label","catalog-sort-label"),caption=node("span","","並び順"),select=node("select","catalog-sort");select.setAttribute("aria-label","並び順");
  for(const [value,text] of [["original","元の並び順"],["manual","自由な並び順"],["dateDesc","登録日 新しい順"],["dateAsc","登録日 古い順"],["measureDesc",measureLabels[0]],["measureAsc",measureLabels[1]],["titleAsc","商品名 昇順"],["titleDesc","商品名 降順"]]){const option=node("option","",text);option.value=value;select.append(option);}
  select.value=settings.sort;select.addEventListener("change",()=>{settings.sort=select.value;apply();save();});label.append(caption,select);bar.append(segmented,label);host.append(bar);
  const density=createTileSize({host:bar,roots,value:settings.size,onChange:size=>{settings.size=size;save();}});
  function save(){try{localStorage.setItem("catalog-view:"+key,JSON.stringify(settings));return true;}catch{live.textContent="このブラウザーに並び順を保存できませんでした。";return false;}}
  const currentIds=root=>[...root.children].filter(el=>el.matches(".catalog-item")&&!el.classList.contains("catalog-drag-fallback")).map(el=>el.dataset.catalogId);
  function remember(root){settings.order=mergeManualOrder(settings.order,currentIds(root));settings.sort="manual";select.value="manual";}
  let sortableModule;
  async function enableDrag(root){
    if(sortables.has(root))return;
    sortables.set(root,null);
    try{
      sortableModule??=import("./catalog-sortable.js");const {default:Sortable}=await sortableModule;
      const sortable=new Sortable(root,{group:{name:`catalog-${key}-${roots.indexOf(root)}`,pull:false,put:false},
        draggable:".catalog-item:not(.catalog-expanded)",handle:".catalog-drag",animation:150,disabled:settings.mode!=="tiles",
        delay:150,delayOnTouchOnly:true,touchStartThreshold:4,ghostClass:"catalog-drag-ghost",fallbackClass:"catalog-drag-fallback",
        onStart:()=>remember(root),onEnd:()=>{remember(root);apply();if(save())live.textContent="並び順を変更しました。";void onReorder(currentIds(root));}});
      sortables.set(root,sortable);
    }catch{sortables.delete(root);live.textContent="ドラッグを読み込めませんでした。前後の矢印で並べ替えできます。";}
  }
  function move(root,id,target){
    const order=currentIds(root),from=order.indexOf(id);if(from<0)return;
    const to=target==="first"?0:target==="last"?order.length-1:from+target;
    if(to<0||to>=order.length||to===from)return;
    order.splice(to,0,...order.splice(from,1));settings.order=mergeManualOrder(settings.order,order);settings.sort="manual";select.value="manual";
    apply();if(save())live.textContent=`${to+1}番目に移動しました。`;void onReorder(currentIds(root));
  }
  function apply(){
    host.closest("main")?.classList.toggle("catalog-tiles-page",settings.mode==="tiles");
    for(const button of buttons)button.setAttribute("aria-pressed",String(button.dataset.catalogMode===settings.mode));
    for(const root of roots){root.classList.toggle("catalog-grid",settings.mode==="tiles");root.dataset.catalogLayout=settings.mode;
      const table=root.closest("table");if(table)table.classList.toggle("catalog-table-tiles",settings.mode==="tiles");
      for(const item of presentationOrder(groups.get(root)||[],settings.sort,settings.order))root.append(item.node);
      density?.resize();resize(root);sortables.get(root)?.option("disabled",settings.mode!=="tiles");
      if(settings.mode==="tiles")void enableDrag(root);
    }
  }
  function update(root,entries){
    const rows=entries.filter(e=>e.node);groups.set(root,rows);
    for(const data of rows){
      const row=data.node;row.classList.add("catalog-item");row.dataset.catalogId=data.id;
      row.querySelector(":scope > .catalog-summary, :scope > td > .catalog-summary")?.remove();
      row.querySelector(":scope > .catalog-registration, :scope > td > .catalog-registration")?.remove();
      const registered=typeof data.registeredAt==="string"?Date.parse(data.registeredAt):NaN;
      const registration=node("small","catalog-registration",`登録日：${Number.isFinite(registered)?new Date(registered).toLocaleDateString("ja-JP"):"不明"}`);
      (row.tagName==="TR"?row.firstElementChild:row).append(registration);
      const summary=node("div","catalog-summary"),imageBox=node("div","catalog-image"),image=node("img");
      image.src=(/^blob:/.test(data.privateImageUrl||"")?data.privateImageUrl:"")||catalogImage(data.imageUrl)||"/catalog-image.svg";image.alt=data.imageLabel||data.title||"商品画像";image.loading="lazy";image.referrerPolicy="no-referrer";
      image.addEventListener("load",()=>imageBox.classList.add("loaded"));
      image.addEventListener("error",()=>{if(image.getAttribute("src")!=="/catalog-image.svg")image.src="/catalog-image.svg";});imageBox.append(image);
      const title=node("strong","catalog-title",data.title||"商品名未取得");title.title=data.title||"商品名未取得";
      const badges=node("div","catalog-badges");for(const text of data.badges||[]){const badge=node("span","",text);badge.title=text;badges.append(badge);}
      const metrics=node("div","catalog-metrics");for(const metric of data.metrics||[]){const box=node("div"),label=node("span","",metric.label),value=node("strong",metric.kind==="price"?"catalog-price":typeof metric.value==="number"?String(metric.value).length>4?"catalog-long-number":"":"catalog-unknown",metric.value??"未確認");value.title=String(metric.value??"未確認")+(metric.unit||"");box.append(label,value);if(typeof metric.value==="number"&&metric.unit&&metric.unit!=="個")box.append(node("small","",metric.unit));metrics.append(box);}
      const state=node("small","catalog-state",data.status||"");state.title=data.status||"";
      const open=node("button","catalog-open");open.type="button";open.append(icon("list"),node("span","","詳細"));open.setAttribute("aria-label",(data.title||"商品")+"の詳細");
      const footer=node("div","catalog-footer"),reorder=node("div","catalog-reorder");
      for(const [name,text,delta] of [["grip","ドラッグして並べ替え",0],["prev","前へ移動",-1],["next","後ろへ移動",1]]){
        const button=node("button",name==="grip"?"catalog-drag":"catalog-move");button.type="button";button.title=text;button.setAttribute("aria-label",`${data.title||"商品"}：${text}`);button.append(icon(name));
        if(delta)button.addEventListener("click",()=>{move(root,data.id,delta);button.focus();});
        else button.addEventListener("keydown",event=>{const delta={ArrowLeft:-1,ArrowUp:-1,ArrowRight:1,ArrowDown:1,Home:"first",End:"last"}[event.key];if(delta!==undefined){event.preventDefault();move(root,data.id,delta);button.focus();}});
        reorder.append(button);
      }
      footer.append(reorder,open);
      function expandedState(){const yes=!data.onOpen&&expanded.has(data.id);row.classList.toggle("catalog-expanded",yes);open.setAttribute("aria-expanded",String(yes));open.querySelector("span").textContent=data.onOpen?data.openLabel||"編集":yes?"閉じる":"詳細";if(data.onOpen){open.removeAttribute("aria-expanded");open.setAttribute("aria-haspopup","dialog");}}
      open.addEventListener("click",()=>{if(data.onOpen){data.onOpen();return;}if(expanded.has(data.id))expanded.delete(data.id);else expanded.add(data.id);expandedState();});
      summary.append(imageBox,title,badges,metrics,state);row.classList.toggle('catalog-with-access',Boolean(data.renderAccess));
      if(data.renderAccess){const access=node('div','catalog-access');data.renderAccess(access);if(data.identity){const id=node("div","catalog-identity","SKU："+data.identity);id.title=id.textContent;access.prepend(id);}if(data.memo){const memo=node("p","catalog-memo",data.memo);memo.title=data.memo;access.append(memo);}const memberships=access.querySelector('.product-membership');if(memberships){badges.append(memberships);badges.setAttribute('aria-label','状態・用途・登録済みのページ');}summary.append(access);}if(data.renderActions){const actions=node("div","catalog-card-actions");data.renderActions(actions);summary.append(actions);}summary.append(footer);if(data.onOpen){open.classList.add('catalog-edit-link');if(data.disabled)open.disabled=true;open.setAttribute('aria-label',data.openAriaLabel||data.openLabel||'商品情報・販路編集');}(row.tagName==="TR"?row.firstElementChild:row).prepend(summary);expandedState();
    }
    apply();
  }
  apply();return {update,mode:()=>settings.mode,setOrder:order=>{settings.order=ids(order);apply();save();}};
}
