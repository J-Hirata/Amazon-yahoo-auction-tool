import {createElement, Link2, FilePenLine, Warehouse, CalendarClock, LayoutGrid} from "lucide";

const validId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "");
const contextId = () => {const id = new URLSearchParams(location.hash.slice(1)).get("stock"); return validId(id) ? id : "";};

export function workspaceNavigation({drafts, stock, planning, overview, physicalStock, salesPlanning,productOverview}) {
  const nav = document.createElement("nav"); nav.setAttribute("aria-label", "管理画面");
  const market = document.createElement("div"); market.className = "workspace-market";
  const logo = document.createElement("img"); Object.assign(logo, {src:"/extension-logo.png",alt:"Amazonからヤフオクへ",width:44,height:44});
  const marketBody = document.createElement("div"), title = document.createElement("span");
  marketBody.className = "workspace-market-body"; title.className = "workspace-group-title"; title.textContent = "Amazon・ヤフオク併売";
  const links = document.createElement("div"); links.className = "workspace-links";
  function item(label, href, selected, shape) {
    const a = document.createElement("a"), text = document.createElement("span"); a.href = href; text.textContent = label;
    a.append(createElement(shape,{width:18,height:18,"aria-hidden":"true"}),text);
    if (selected) a.setAttribute("aria-current","page"); return a;
  }
  const context = contextId(), hash = context ? "#stock=" + context : "";
  links.append(item("商品紐付けツール","/"+hash,!drafts&&!stock&&!planning&&!overview,Link2),item("出品下書きツール","/?view=drafts"+hash,drafts,FilePenLine));
  marketBody.append(title,links); market.append(logo,marketBody); nav.append(market);
  if (physicalStock) {
    const inventory = document.createElement("div"), caption = document.createElement("span");
    inventory.className = "workspace-inventory"; caption.className = "workspace-group-title"; caption.textContent = "在庫管理";
    inventory.append(caption);if(productOverview)inventory.append(item("全商品一覧","/?view=overview",overview,LayoutGrid));inventory.append(item("コンテナ・自社在庫","/?view=stock",stock,Warehouse)); nav.append(inventory);
  }
  if(salesPlanning){const group=document.createElement("div"),caption=document.createElement("span");group.className="workspace-inventory";caption.className="workspace-group-title";caption.textContent="販売方針";group.append(caption,item("販売の監視・見直し","/?view=planning",planning,CalendarClock));nav.append(group);}
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
  back.href = "/?view=stock#connect="+id; back.textContent = "この在庫の紐付けへ戻る"; band.append(label,name,meta,back); main.prepend(band);
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
