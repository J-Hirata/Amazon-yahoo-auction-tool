const modes = ["list", "tiles"], sorts = ["original", "titleAsc", "titleDesc", "measureDesc", "measureAsc"];
export function presentationSettings(value) {
  return {mode:modes.includes(value?.mode)?value.mode:"list",sort:sorts.includes(value?.sort)?value.sort:"original"};
}
export function presentationOrder(entries, sort) {
  return entries.map((entry,index)=>({entry,index})).sort((a,b)=>{
    const x=a.entry,y=b.entry;
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
export function createCatalogView({key,host,roots,measureLabels=["数量 多い順","数量 少ない順"]}) {
  let settings;try{settings=presentationSettings(JSON.parse(localStorage.getItem("catalog-view:"+key)||"null"));}catch{settings=presentationSettings();}
  const expanded=new Set(), groups=new Map(), bar=node("div","catalog-controls"), segmented=node("div","catalog-modes");
  bar.dataset.catalogControls=key;segmented.setAttribute("role","group");segmented.setAttribute("aria-label","表示形式");
  const buttons=modes.map(mode=>{
    const button=node("button","catalog-mode");button.type="button";button.dataset.catalogMode=mode;
    button.title=mode==="list"?"リスト表示":"タイル表示";button.setAttribute("aria-label",button.title);button.append(icon(mode),node("span","",mode==="list"?"リスト":"タイル"));
    button.addEventListener("click",()=>{settings.mode=mode;apply();save();});segmented.append(button);return button;
  });
  const label=node("label","catalog-sort-label"),caption=node("span","","並び順"),select=node("select","catalog-sort");select.setAttribute("aria-label","並び順");
  for(const [value,text] of [["original","元の並び順"],["titleAsc","商品名 昇順"],["titleDesc","商品名 降順"],["measureDesc",measureLabels[0]],["measureAsc",measureLabels[1]]]){const option=node("option","",text);option.value=value;select.append(option);}
  select.value=settings.sort;select.addEventListener("change",()=>{settings.sort=select.value;apply();save();});label.append(caption,select);bar.append(segmented,label);host.append(bar);
  function save(){try{localStorage.setItem("catalog-view:"+key,JSON.stringify(settings));}catch{}}
  function apply(){
    for(const button of buttons)button.setAttribute("aria-pressed",String(button.dataset.catalogMode===settings.mode));
    for(const root of roots){root.classList.toggle("catalog-grid",settings.mode==="tiles");root.dataset.catalogLayout=settings.mode;
      const table=root.closest("table");if(table)table.classList.toggle("catalog-table-tiles",settings.mode==="tiles");
      for(const item of presentationOrder(groups.get(root)||[],settings.sort))root.append(item.node);
    }
  }
  function update(root,entries){
    const rows=entries.filter(e=>e.node);groups.set(root,rows);
    for(const data of rows){
      const row=data.node;row.classList.add("catalog-item");row.dataset.catalogId=data.id;
      row.querySelector(":scope > .catalog-summary, :scope > td > .catalog-summary")?.remove();
      const summary=node("div","catalog-summary"),imageBox=node("div","catalog-image"),image=node("img");
      image.src=catalogImage(data.imageUrl)||"/catalog-image.svg";image.alt=data.imageLabel||data.title||"商品画像";image.loading="lazy";image.referrerPolicy="no-referrer";
      image.addEventListener("load",()=>imageBox.classList.add("loaded"));
      image.addEventListener("error",()=>{if(image.getAttribute("src")!=="/catalog-image.svg")image.src="/catalog-image.svg";});imageBox.append(image);
      const title=node("strong","catalog-title",data.title||"商品名未取得");title.title=data.title||"商品名未取得";
      const badges=node("div","catalog-badges");for(const text of data.badges||[]){const badge=node("span","",text);badge.title=text;badges.append(badge);}
      const metrics=node("div","catalog-metrics");for(const metric of data.metrics||[]){const box=node("div"),label=node("span","",metric.label),value=node("strong",metric.kind==="price"?"catalog-price":typeof metric.value==="number"?String(metric.value).length>4?"catalog-long-number":"":"catalog-unknown",metric.value??"未確認");value.title=String(metric.value??"未確認")+(metric.unit||"");box.append(label,value);if(typeof metric.value==="number"&&metric.unit&&metric.unit!=="個")box.append(node("small","",metric.unit));metrics.append(box);}
      const state=node("small","catalog-state",data.status||"");state.title=data.status||"";
      const open=node("button","catalog-open");open.type="button";open.append(icon("list"),node("span","","詳細"));open.setAttribute("aria-label",(data.title||"商品")+"の詳細");
      function expandedState(){const yes=expanded.has(data.id);row.classList.toggle("catalog-expanded",yes);open.setAttribute("aria-expanded",String(yes));open.querySelector("span").textContent=yes?"閉じる":"詳細";}
      open.addEventListener("click",()=>{if(expanded.has(data.id))expanded.delete(data.id);else expanded.add(data.id);expandedState();});
      summary.append(imageBox,title,badges,metrics,state,open);(row.tagName==="TR"?row.firstElementChild:row).prepend(summary);expandedState();
    }
    apply();
  }
  apply();return {update,mode:()=>settings.mode};
}
