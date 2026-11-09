

const validId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "");
const contextId = () => {const id = new URLSearchParams(location.hash.slice(1)).get("stock"); return validId(id) ? id : "";};

export function workspaceNavigation({drafts, stock, planning, overview, physicalStock, salesPlanning,productOverview}) {
  const nav = document.createElement("nav"); nav.className="workspace-tools"; nav.setAttribute("aria-label", "管理画面");
  function item(label, href, selected, image, key, caption) {
    const a = document.createElement("a"), text = document.createElement("span"), logo=document.createElement('img'), note=document.createElement('span');
    a.href = href; a.className='workspace-tool'; a.dataset.tool=key; a.setAttribute('aria-label',label);
    text.className='workspace-tool-name'; text.textContent = label;
    Object.assign(logo,{src:image,alt:'',width:56,height:56}); logo.className='workspace-tool-logo';
    note.className='workspace-tool-caption'; note.textContent=caption; note.setAttribute('aria-hidden','true');
    a.append(logo,text,note);
    if (selected) a.setAttribute("aria-current","page"); return a;
  }
  const context = contextId(), hash = context ? "#stock=" + context : "";
  nav.append(item("商品紐付けツール","/"+hash,!drafts&&!stock&&!planning&&!overview,'/extension-logo.png','links','Amazon・ヤフオクを紐付け'),item("ヤフオク出品下書きツール","/?view=drafts"+hash,drafts,'/workspace-drafts.png','drafts','ヤフオクへの出品準備'));
  if (physicalStock) nav.append(item("コンテナ・自社在庫","/?view=stock",stock,'/workspace-stock.png','stock','保管場所と実数を管理'));
  if (salesPlanning) nav.append(item("販売の監視・見直し","/?view=planning",planning,'/workspace-planning.png','planning','売れ行き・次の方針を確認'));
  if (productOverview) nav.append(item('全商品一覧','/?view=overview',overview,'/workspace-overview.png','overview','販路と在庫をまとめて確認'));
  nav.style.setProperty('--workspace-tool-count',String(nav.children.length));
  nav.dataset.count=String(nav.children.length);
  return nav;
}

export async function stockWorkflowContext({drafts, main, request}) {
  const id = contextId(); if (!id) return;
  const response = await request("/api/physical-stock"); if (!response.ok) throw new Error("対象在庫を確認できません。コンテナ・自社在庫から選び直してください。");
  const inventory = await response.json(), product = inventory.products.find(p=>p.id===id);
  if (!product) throw new Error("対象在庫が見つかりません。コンテナ・自社在庫から選び直してください。");
  const band = document.createElement("section"), label = document.createElement("span"), name = document.createElement("strong"), meta = document.createElement("span"), back = document.createElement("a");
  band.className = "workspace-context"; band.setAttribute("aria-label","作業対象の在庫");
  label.textContent = "対象在庫"; name.textContent = product.title;
  meta.textContent = [product.condition==="new"?"新品":product.condition==="used"?"中古":"状態要確認",product.asin||"ASIN未登録"].join(" ／ ");
  back.href = "/?view=stock#connect="+id;back.target='_blank';back.rel='noopener noreferrer';back.title='別タブで開く';back.textContent = "この在庫の紐付けを確認"; band.append(label,name,meta,back); main.prepend(band);
  if (drafts) {
    const input = main.querySelector("#asins"); if (input && product.asin) input.value = product.asin;
  } else {
    const input = main.querySelector("#pairAmazon");
    if (input && product.asin) {input.value = product.asin; input.defaultValue = product.asin; input.readOnly = true;}
    window.addEventListener("stock-page-link-created",event=>{
      if (event.detail?.asin !== product.asin || !validId(event.detail?.linkId)) return;
      back.href = "/?view=stock#connect="+id+"&link="+event.detail.linkId;
      back.textContent = "この出品を在庫に関連付ける"; back.classList.add("workspace-next");
    });
  }
}
