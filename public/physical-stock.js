import {monitorRequest} from "./monitor-http.js";
import {createCatalogView} from "./catalog-view.js";
import {createElement, Boxes, Warehouse, House, Plus, Minus, Truck, History, NotebookPen, RefreshCw, Download, Search, X, ArrowRight, Check, Pencil, Package, ArrowLeftRight, Image as ImageIcon, Link2, FilePenLine} from "lucide";

const icons = {boxes: Boxes, warehouse: Warehouse, house: House, plus: Plus, minus: Minus, truck: Truck, history: History, notebook: NotebookPen, refresh: RefreshCw, download: Download, search: Search, x: X, arrow: ArrowRight, check: Check, pencil: Pencil, package: Package, move: ArrowLeftRight, image: ImageIcon, link:Link2, draft:FilePenLine};
const icon = (name) => createElement(icons[name], {width: 18, height: 18, "aria-hidden": "true", "focusable": "false", "stroke-width": 1.8}).outerHTML;

const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const when = (value) => value ? new Date(value).toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"}) : "未確認";
const labels = {create: "商品登録", edit: "商品情報の編集", add: "追加", remove: "販売等の減少", count: "棚卸し・実数修正", count_locations: "場所ごとの数量修正", reserve: "取り置き", release: "取り置き解除", unusable: "使用不可へ振替", recover: "使用可能へ復帰", dispatch: "発送・移動開始", receive_transfer: "到着・受領", return_transfer: "出荷元へ戻す"};
const conditions = {new: "新品", used: "中古", parts: "部品・現状品", unknown: "状態未確認"};
const tasks = {none: "", pending: "カタログ作成待ち", working: "カタログ作業中", registered: "カタログ登録済み"};
const purposes = {unknown: "用途未設定", possible: "FBA補充用", not_possible: "自社発送用（FBA不可）"};
const locationName = (id) => ({container: "コンテナ", home: "自宅・会社", fba: "Amazon FBA"})[id] || id;
const references = [["iiyama XUB2493HS-B3", 6, "台"], ["iiyama E2483HS-B3", 13, "台"], ["ASUS VG245H", 7, "台"], ["I-O DATA LCD-MF245EDB-F", 5, "台"], ["学研 スーパーのりものデラックス：ふみきりのヒミツ！", 15, "箱"], ["ヘルメット（色別・数量要確認）", null, "個"]];
function imageUrl(value) {try {const u = new URL(value); if (u.protocol === "https:" && (u.hostname.endsWith(".yimg.jp") || ["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-fe.ssl-images-amazon.com"].includes(u.hostname)) && !u.username && !u.password && !u.port && u.href.length <= 2048) return u.href;} catch {} return "";}

export async function openStock({userId, readOnly}) {
  let view, activeProduct, editingProduct, placesProduct, linkProduct, preview, busy = false, dirty = false, pending;
  const pendingKey = "physical-stock-pending:" + userId;
  const productForm = $("#stockProductForm"), actionForm = $("#stockActionForm"), placesForm = $("#stockPlacesForm");
  const displayHost=document.createElement("div");$(".stock-table-wrap").before(displayHost);
  const catalog=createCatalogView({key:"stock",host:displayHost,roots:[$("#stockRows")],measureLabels:["確認済み数量 多い順","確認済み数量 少ない順"]});
  for (const element of document.querySelectorAll("[data-stock-icon]")) element.innerHTML = icon(element.dataset.stockIcon);
  const status = (message, error = false) => {$("#stockStatus").textContent = message; $("#stockStatus").classList.toggle("error", error);};
  try {pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");} catch {pending = null;}
  function controls() {
    for (const button of document.querySelectorAll(".stock-shell button")) button.disabled = busy;
    for (const button of document.querySelectorAll("[data-stock-action],[data-stock-edit],[data-stock-places],[data-stock-connect],[data-stock-transfer],#stockNew,[data-reference]")) button.disabled = busy || readOnly || Boolean(pending) || !view;
    $("#stockCommit").disabled = busy || readOnly || !preview;
    $("#stockCommit").innerHTML = icon("check") + (pending ? "同じ操作を再試行" : "この内容で保存");
    $("#stockRetry").disabled = busy || readOnly;
    $("#stockPending").hidden = !pending;
    $("#stockPhotos").disabled = busy || readOnly || Boolean(pending) || !view?.photoRead;
    $("#stockAmazonCheck").disabled = busy || readOnly || Boolean(pending) || !view?.amazonRead;
    for (const select of document.querySelectorAll("[data-stock-purpose]")) select.disabled = busy || readOnly || Boolean(pending);
    $("#stockLinkSubmit").disabled = busy || readOnly || Boolean(pending) || !document.querySelector("#stockLinkOptions input:checked:not(:disabled)");
    for (const a of document.querySelectorAll(".stock-link-routes a")) {a.setAttribute("aria-disabled",String(readOnly || Boolean(pending) || !linkProduct?.asin));if(readOnly || pending || !linkProduct?.asin)a.removeAttribute("href");}
  }
  async function request(path = "", data, revision = view?.storage.revision) {
    const response = await monitorRequest("/api/physical-stock" + path, data === undefined ? undefined : {method: "POST", headers: {"Content-Type": "application/json", "If-Match": `"${revision}"`}, body: JSON.stringify(data)});
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload.error || "在庫操作を完了できません"), {status: response.status});
    return payload;
  }
  async function work(callback, errorSelector) {
    if (busy) return; busy = true; controls();
    try {await callback();}
    catch (error) {status(error.message, true); if (errorSelector) $(errorSelector).textContent = error.message;}
    finally {busy = false; controls();}
  }
  function render() {
    if (!view) return;
    $("#stockSummary").textContent = `${view.products.length}商品`;
    $("#stockTransferCount").textContent = view.totals.inTransit ? `移動中 ${view.totals.inTransit}件` : "";
    const query = $("#stockSearch").value.trim().toLowerCase(), place = $("#stockLocationFilter").value, filter = $("#stockStateFilter").value, purpose = $("#stockPurposeFilter").value;
    const products = view.products.filter((p) => [p.title, p.managementId, p.asin, p.sellerSku, p.memo].join(" ").toLowerCase().includes(query) &&
      (!place || p.totals.locations.some((b) => b.locationId === place && (b.usable === null || b.usable + b.reserved + b.unusable > 0))) &&
      (!purpose || p.fbaEligibility === purpose) &&
      (!filter || filter === "catalog" && ["pending", "working"].includes(p.catalogTask) || filter === "unknown" && p.totals.unknownLocations > 0 || filter === "transit" && p.totals.inTransit > 0 || filter === "replenishment" && p.replenishmentCandidate));
    const balance = (b, p) => `<button type="button" class="stock-balance ${b.usable === null ? "unconfirmed" : ""}" data-stock-places="${escape(p.id)}" data-place="${b.locationId}" title="${locationName(b.locationId)}の数量を編集" aria-label="${locationName(b.locationId)}の数量を編集">${b.usable === null ? `<span>未確認</span>${icon("plus")}` : `<strong>${b.usable}</strong><span>${escape(p.unit)}</span>${icon("pencil")}`}</button>${b.reserved || b.unusable ? `<small>取り置き ${b.reserved} ／ 使用不可 ${b.unusable}</small>` : ""}`;
    $("#stockRows").innerHTML = products.length ? products.map((p) => {
      const photo = imageUrl(p.photo?.url);
      const chips = [`<span class="stock-badge">${conditions[p.condition]}</span>`, ...(p.catalogTask !== "none" && p.catalogTask !== "registered" ? [`<span class="stock-badge ${p.catalogDue ? "attention" : ""}">${escape(tasks[p.catalogTask])}</span>`] : []), ...(p.totals.inTransit ? [`<span class="stock-badge attention">${icon("truck")}移動中 ${p.totals.inTransit}${escape(p.unit)}</span>`] : [])];
      return `<tr><td data-label="商品"><div class="stock-product">${photo ? `<img src="${escape(photo)}" alt="${escape(p.photo.label)}" title="${escape(p.photo.label)}" width="80" height="80" loading="lazy" referrerpolicy="no-referrer">` : `<span class="stock-product-icon" title="ASINまたは商品画像URLを登録して画像を取得">${icon("image")}<small>写真なし</small></span>`}<div class="stock-product-text"><strong>${escape(p.title)}</strong><select class="stock-purpose purpose-${escape(p.fbaEligibility)}" data-stock-purpose="${escape(p.id)}" aria-label="${escape(p.title)}の在庫の用途">${Object.entries(purposes).map(([id,label])=>`<option value="${id}" ${id === p.fbaEligibility ? "selected" : ""}>${label}</option>`).join("")}</select><div class="stock-badges">${chips.join("")}</div>${p.setContents ? `<small>${escape(p.setContents)}</small>` : ""}${p.memo ? `<p class="stock-memo">${escape(p.memo)}</p>` : ""}${p.asin ? `<a class="stock-asin" href="https://www.amazon.co.jp/dp/${escape(p.asin)}" target="_blank" rel="noreferrer">${escape(p.asin)}</a>` : ""}
        <details class="stock-item-details"><summary>詳細</summary><dl><dt>管理ID</dt><dd>${escape(p.managementId)}</dd><dt>SKU</dt><dd>${escape(p.sellerSku || "未登録")}</dd><dt>FBA参照</dt><dd>${escape(p.fba.label)}${p.fba.checkedAt ? ` ／ ${when(p.fba.checkedAt)}` : ""}</dd><dt>納品設定</dt><dd>${({unknown:"未確認",possible:"納品候補",not_possible:"FBA不可・自己発送等"})[p.fbaEligibility]}</dd>${p.reviewDate ? `<dt>再確認日</dt><dd>${escape(p.reviewDate)}</dd>` : ""}${p.totals.locations.map((b) => `<dt>${locationName(b.locationId)}</dt><dd>${b.usable === null ? "未確認" : `使用可能 ${b.usable} ／ 取り置き ${b.reserved} ／ 使用不可 ${b.unusable}<br>${when(b.checkedAt)}`}</dd>`).join("")}</dl>${p.replenishmentCandidate ? '<p>補充検討（FBA取得分0）</p>' : ""}${p.linked.map((l) => `<a href="https://auctions.yahoo.co.jp/jp/auction/${escape(l.listingId)}" target="_blank" rel="noreferrer">ヤフオク ${escape(l.listingId)}</a><small>出品状態：${({active:"出品中",ended:"終了確認済み",ending:"再確認待ち"})[l.yahooStatus] || "未確認"}</small>`).join("")}</details></div></div></td>
        <td data-label="コンテナ">${balance(p.totals.locations[0], p)}</td><td data-label="自宅・会社">${balance(p.totals.locations[1], p)}</td>
        <td data-label="販売先の状況"><div class="stock-sales-overview"><section class="stock-channel"><h3>Amazonの自社出品</h3><strong class="amazon-state state-${escape(p.amazon.status)}">${escape(p.amazon.label)}</strong>${p.amazon.offers.map((o) => `<small>${escape(o.conditionLabel)} ／ ${escape(o.shippingLabel)} ／ ${o.buyable ? "販売中" : "購入可否要確認"}</small><details class="stock-offer-details"><summary>SKU・確認内容</summary><small>SKU：${escape(o.sellerSku)}</small>${o.fulfillment.filter(f=>f.channel==="DEFAULT").map(f=>`<small>Amazon自己発送の設定数：${f.quantity === null ? "不明" : f.quantity + "個"}</small>`).join("")}</details>`).join("")}${p.amazon.variantWarning ? `<small class="stock-variant-warning">${escape(p.amazon.variantWarning)}</small>` : ""}${p.amazon.checkedAt ? `<small>確認：${when(p.amazon.checkedAt)}</small>` : ""}</section><section class="stock-channel"><h3>ヤフオクとの関連付け</h3><strong>${p.linked.length ? `関連付け済み ${p.linked.length}件` : "登録なし"}</strong>${p.linked.map((l) => `<a href="https://auctions.yahoo.co.jp/jp/auction/${escape(l.listingId)}" target="_blank" rel="noreferrer">${escape(l.listingId)}</a><small>${({active:"出品中",ended:"終了確認済み",ending:"終了・再確認待ち"})[l.yahooStatus] || "出品状態は未確認"}</small>`).join("")}${!p.linked.length && p.linkCandidates.length ? `<small>同ASINの候補 ${p.linkCandidates.length}件</small><button class="stock-text-button" type="button" data-stock-connect="${escape(p.id)}">ヤフオクの関連付けを確認</button>` : ""}${p.linked.length ? `<small>FBA参考：${escape(p.fba.label)}</small>` : ""}</section></div></td>
        <td data-label="操作"><div class="stock-row-actions"><button type="button" data-stock-places="${escape(p.id)}">${icon("pencil")}数量を編集</button><button class="secondary" type="button" data-stock-action="${escape(p.id)}">${icon("move")}入出庫・移動</button><button class="stock-text-button" type="button" data-stock-edit="${escape(p.id)}">${icon("notebook")}情報・メモ</button></div></td></tr>`;
    }).join("") : `<tr><td colspan="5" class="stock-empty">${icon("package")}<p>${view.products.length ? "該当する商品はありません。" : "登録されたコンテナ・自社在庫はまだありません。"}</p></td></tr>`;
    for (const img of document.querySelectorAll("#stockRows img")) img.addEventListener("error", () => {img.hidden = true;});
    for (const button of document.querySelectorAll("[data-stock-action]")) button.addEventListener("click", () => openAction(button.dataset.stockAction));
    for (const button of document.querySelectorAll("[data-stock-edit]")) button.addEventListener("click", () => openProduct(view.products.find((p) => p.id === button.dataset.stockEdit)));
    for (const button of document.querySelectorAll("[data-stock-places]")) button.addEventListener("click", () => openPlaces(button.dataset.stockPlaces, button.dataset.place));
    for (const [index,row] of [...document.querySelectorAll("#stockRows tr")].entries()) {
      const product=products[index]; if(!product)continue;
      const review=document.createElement("a");review.href=`/?view=planning#plan=stock:${encodeURIComponent(product.id)}`;review.textContent="販売の見直しへ追加";review.className="planning-entry-link";
      row.querySelector(".stock-row-actions").append(review);
      let button=row.querySelector("[data-stock-connect]");
      if(!button){button=document.createElement("button");button.type="button";button.className="stock-text-button";button.dataset.stockConnect=product.id;row.querySelector(".stock-channel:last-child").append(button);}
      button.innerHTML=icon("link")+"ヤフオクと紐付け";button.addEventListener("click",()=>openLinks(product));
    }
    for (const select of document.querySelectorAll("[data-stock-purpose]")) select.addEventListener("change", () => {const product = view.products.find((p) => p.id === select.dataset.stockPurpose), value = select.value; select.value = product.fbaEligibility; work(() => showPreview({operationId: crypto.randomUUID(), kind: "edit", productId: product.id, product: {...product, fbaEligibility: value}, reason: "在庫の用途を変更"}));});
    $("#stockTransferRows").innerHTML = view.transfers.length ? [...view.transfers].reverse().map((t) => `<div class="stock-transfer"><span><strong>${escape(view.products.find((p) => p.id === t.productId)?.title || "商品")}</strong><br>${locationName(t.from)} → ${locationName(t.to)} ／ 移動中 ${t.remaining} ／ 到着 ${t.received} ／ 出荷元へ戻し ${t.returned}<br><small>${escape(t.reference)} ／ ${when(t.updatedAt)}</small></span>${t.remaining ? `<button type="button" data-stock-transfer="${escape(t.id)}">到着を記録</button>` : ""}</div>`).join("") : "<p>移動の記録はありません。</p>";
    for (const button of document.querySelectorAll("[data-stock-transfer]")) {button.disabled = readOnly || Boolean(pending); button.addEventListener("click", () => {const t = view.transfers.find((t) => t.id === button.dataset.stockTransfer); openAction(t.productId, "receive_transfer", t.id);});}
    $("#stockHistory").innerHTML = view.events.length ? view.events.map((e) => `<li>${when(e.at)} ／ ${escape(view.products.find((p) => p.id === e.productId)?.title)} ／ ${labels[e.kind]} ／ ${escape(e.reason)}${e.changes.map((c) => `<br>${locationName(c.locationId)}：${["usable", "reserved", "unusable"].map((b) => `${({usable:"使用可能",reserved:"取り置き",unusable:"使用不可"})[b]} ${c.before[b] ?? "未確認"} → ${c.after[b] ?? "未確認"}`).join(" ／ ")}`).join("")}${e.transferAfter ? `<br>移動中 ${e.transferBefore?.remaining ?? 0} → ${e.transferAfter.remaining} ／ 到着 ${e.transferBefore?.received ?? 0} → ${e.transferAfter.received} ／ 戻し ${e.transferBefore?.returned ?? 0} → ${e.transferAfter.returned}` : ""}${e.evidence ? `<br>確認根拠：${escape(e.evidence)}` : ""}${e.metadataAfter ? `<br>ASIN：${escape(e.metadataBefore.asin || "なし")} → ${escape(e.metadataAfter.asin || "なし")} ／ ${escape(tasks[e.metadataAfter.catalogTask])}` : ""}</li>`).join("") : "<li>まだ変更履歴はありません。</li>";
    catalog.update($("#stockRows"),products.map((p,index)=>({node:$("#stockRows").children[index],id:p.id,title:p.title,imageUrl:p.photo?.url,imageLabel:p.photo?.label,
      badges:[conditions[p.condition],purposes[p.fbaEligibility]],metrics:p.totals.locations.map(b=>({label:locationName(b.locationId),value:b.usable??"未確認",unit:p.unit})),
      status:`Amazon${p.amazon.status==="buyable"?"販売中":p.amazon.status==="present"?"出品あり":p.amazon.status==="variant_mismatch"?"状態要確認":"要確認"}／ヤフオク${p.linked.length?`${p.linked.length}件`:"未登録"}`,
      measure:p.totals.unknownLocations===0?p.totals.usable:null,registeredAt:p.createdAt})));
    controls();
  }
  async function load() {view = await request(); render();}
  function openLinks(product, suggestedLink) {
    if(readOnly || pending || busy)return;
    linkProduct=product;dirty=false;preview=null;
    $("#stockLinkTitle").textContent=product.title+" ／ "+(product.asin||"ASIN未登録");$("#stockLinkError").textContent="";
    const options=view.linkOptions.filter(l=>l.asin===product.asin&&product.asin);
    $("#stockLinkOptions").innerHTML=options.length?options.map(l=>{
      const already=product.linkedLinkIds.includes(l.id), family=/^new/i.test(l.condition)?"new":/^used/i.test(l.condition)?"used":"unknown";
      const mismatch=family!=="unknown"&&["new","used"].includes(product.condition)&&family!==product.condition || product.sellerSku&&l.sellerSku&&product.sellerSku!==l.sellerSku;
      return `<label class="stock-link-option"><input type="checkbox" value="${escape(l.id)}" ${already||l.id===suggestedLink&&!mismatch?"checked":""} ${already||mismatch?"disabled":""}><span><strong>${escape(l.title)}</strong><small>${escape(l.listingId)} ／ ${family==="unknown"?"状態未確認":conditions[family]}${l.sellerSku?" ／ "+escape(l.sellerSku):""}</small><small>${already?"紐付け済み":mismatch?"在庫登録と状態・SKUが異なります":"同じ商品・状態・セットか確認"}</small></span></label>`;
    }).join(""):"<p class='stock-muted'>このASINの登録済み出品はありません。</p>";
    $("#stockLinkNew").href="/#stock="+product.id;$("#stockLinkDraft").href="/?view=drafts#stock="+product.id;
    if(!product.asin)$("#stockLinkError").textContent="ASINを商品情報に登録してください。";
    $("#stockLinkDialog").showModal();controls();
  }
  $("#stockLinkForm").addEventListener("change",()=>{dirty=true;controls();});
  $("#stockLinkForm").addEventListener("submit",event=>{event.preventDefault();work(async()=>{
    const added=[...document.querySelectorAll("#stockLinkOptions input:checked:not(:disabled)")].map(i=>i.value);
    if(!added.length)throw new Error("追加する出品を選んでください。");
    await showPreview({operationId:crypto.randomUUID(),kind:"edit",productId:linkProduct.id,product:{...linkProduct,linkedLinkIds:[...new Set([...linkProduct.linkedLinkIds,...added])]},reason:"ヤフオク出品との関連付け"});
  },"#stockLinkError");});
  function openProduct(product, reference) {
    editingProduct = product || null; productForm.reset(); dirty = false; preview = null;
    $("#stockProductError").textContent = ""; $("#stockProductTitle").textContent = product ? "商品情報・メモ" : "商品を登録";
    $("#stockInitialFields").hidden = Boolean(product);
    $("#stockExtraFields").open = Boolean(product && product.catalogTask !== "none");
    for (const field of ["title", "unit", "condition", "setContents", "asin", "sellerSku", "memo", "catalogTask", "fbaEligibility", "reviewDate", "imageUrl"]) {
      if (product) productForm.elements[field].value = product[field] || "";
      productForm.elements[field].disabled = Boolean(product && ["unit", "condition", "setContents"].includes(field));
    }
    $("#stockLinked").innerHTML = '<option value="">紐付けなし</option>' + view.linkOptions.map((l) => `<option value="${escape(l.id)}">${product?.asin === l.asin ? "同ASIN候補：" : ""}${escape(l.title)} ／ ${escape(l.asin)} ／ ${escape(l.listingId)}</option>`).join("");
    $("#stockLinked").value = product?.linkedLinkIds[0] || "";
    if (reference) productForm.elements.title.value = reference[0];
    $("#stockProductDialog").showModal();
  }
  function openPlaces(id, focusPlace) {
    placesProduct = view.products.find((p) => p.id === id); placesForm.reset(); dirty = false; preview = null;
    $("#stockPlacesTitle").textContent = placesProduct.title; $("#stockPlacesError").textContent = "";
    for (const b of placesProduct.totals.locations) {
      placesForm.elements[b.locationId].value = b.usable ?? "";
      const prefix = b.locationId === "container" ? "Container" : "Home";
      $("#stock" + prefix + "Unit").textContent = placesProduct.unit;
      $("#stock" + prefix + "Before").textContent = b.usable === null ? "現在：未確認" : `現在：${b.usable}${placesProduct.unit}`;
    }
    $("#stockPlacesBuckets").textContent = placesProduct.totals.locations.filter((b) => b.reserved || b.unusable).map((b) => `${locationName(b.locationId)}：取り置き${b.reserved}・使用不可${b.unusable}（変更なし）`).join(" ／ ");
    $("#stockPlacesDialog").showModal();
    if (focusPlace) placesForm.elements[focusPlace].focus();
  }
  function syncAction() {
    const kind = actionForm.elements.kind.value, transferring = ["receive_transfer", "return_transfer"].includes(kind);
    for (const button of document.querySelectorAll("[data-stock-mode]")) button.setAttribute("aria-pressed", String(button.dataset.stockMode === kind));
    $("#stockAdvancedActions").open = !["add", "remove", "dispatch"].includes(kind);
    $("#stockQtyLabel").textContent = ({add:"追加する数量",remove:"減らす数量",dispatch:"移動する数量",receive_transfer:"到着した数量",return_transfer:"戻す数量"})[kind] || "数量";
    $("#stockNormalLocation").hidden = transferring; $("#stockCountFields").hidden = kind !== "count"; $("#stockQtyFields").hidden = kind === "count";
    $("#stockDispatchFields").hidden = kind !== "dispatch"; $("#stockReceiveFields").hidden = !transferring;
    actionForm.elements.quantity.required = kind !== "count";
    for (const b of ["usable", "reserved", "unusable"]) {actionForm.elements[b].required = kind === "count"; if (kind === "count") actionForm.elements[b].value = activeProduct.totals.locations.find((l) => l.locationId === actionForm.elements.locationId.value)?.[b] ?? (b === "usable" ? "" : 0);}
    const transfer = view.transfers.find((t) => t.id === actionForm.elements.transferId.value);
    actionForm.elements.transferId.required = transferring;
    actionForm.elements.evidence.required = kind === "receive_transfer" && transfer?.to === "fba";
    actionForm.elements.reference.required = kind === "dispatch" && actionForm.elements.to.value === "fba";
  }
  function openAction(id, kind = "add", transferId) {
    activeProduct = view.products.find((p) => p.id === id); actionForm.reset(); dirty = false; preview = null;
    $("#stockActionTitle").textContent = activeProduct.title; $("#stockActionError").textContent = "";
    actionForm.elements.kind.value = kind;
    actionForm.elements.locationId.value = activeProduct.totals.locations.find((b) => b.usable !== null)?.locationId || "container";
    actionForm.elements.transferId.innerHTML = view.transfers.filter((t) => t.productId === id && t.remaining).map((t) => `<option value="${escape(t.id)}">${locationName(t.from)} → ${locationName(t.to)} ／ 残 ${t.remaining} ／ ${escape(t.reference)}</option>`).join("");
    if (transferId) actionForm.elements.transferId.value = transferId;
    syncAction(); $("#stockActionDialog").showModal();
  }
  async function showPreview(command, revision = view.storage.revision) {
    if (pending && command.operationId !== pending.command.operationId) throw new Error("前の操作の保存結果を確認してから、次の操作を行ってください。");
    const result = await request("/preview", {command}, revision); preview = {command, revision: result.revision};
    const e = result.event;
    const changes = e?.changes.flatMap((c) => ["usable", "reserved", "unusable"].filter((b) => b === "usable" || c.before[b] !== c.after[b] && !(c.before[b] === null && c.after[b] === 0)).map((b) => `<tr><td>${locationName(c.locationId)}${b !== "usable" ? "・" + ({reserved:"取り置き",unusable:"使用不可"})[b] : ""}</td><td>${c.before[b] ?? "未確認"}</td><td><strong>${c.after[b] ?? "未確認"}</strong>${c.after[b] !== null ? escape(result.product.unit) : ""}</td></tr>`)).join("") || "";
    $("#stockConfirmContent").innerHTML = `<strong>${escape(result.product.title)}</strong><p class="stock-muted">${labels[command.kind]}</p>${changes ? `<table><thead><tr><th>場所・区分</th><th>変更前</th><th>変更後</th></tr></thead><tbody>${changes}</tbody></table>` : ""}${e?.transferAfter ? `<p>${locationName(e.transferAfter.from)} → ${locationName(e.transferAfter.to)} ／ 移動中 ${e.transferAfter.remaining}${escape(result.product.unit)}</p>` : ""}<p>${escape(command.reason || result.product.memo || "")}</p>${command.kind === "edit" ? `<p>ASIN：${escape(result.product.asin || "未登録")} ／ ${escape(tasks[result.product.catalogTask])}</p><p>${escape(result.product.memo)}</p>` : ""}<p class="meta">Amazon・ヤフオクの数量や出品は変更しません。</p>`;
    $("#stockConfirmError").textContent = ""; $("#stockConfirmDialog").showModal(); controls();
    if (e?.metadataBefore?.fbaEligibility !== undefined && e.metadataBefore.fbaEligibility !== result.product.fbaEligibility) {const line = document.createElement("p"); line.textContent = `用途：${purposes[e.metadataBefore.fbaEligibility]} → ${purposes[result.product.fbaEligibility]}`; $("#stockConfirmContent").prepend(line);}
    if (result.duplicates.length) {const warning = document.createElement("p"); warning.className = "stock-error"; warning.textContent = "同じASIN・商品名の登録あり：" + result.duplicates.map((p) => p.managementId + " " + p.title).join(" ／ ") + "。別の現物・状態か確認してください。"; $("#stockConfirmContent").prepend(warning);}
    const previous=view.products.find(p=>p.id===command.productId);
    if(command.kind==="edit"&&JSON.stringify(previous?.linkedLinkIds)!==JSON.stringify(result.product.linkedLinkIds)){
      const line=document.createElement("p");line.textContent="ヤフオクとの関連付け："+result.product.linkedLinkIds.map(id=>view.linkOptions.find(l=>l.id===id)?.listingId||id).join(" ／ ")+"。場所別数量は変更しません。";$("#stockConfirmContent").append(line);
    }
  }
  productForm.addEventListener("submit", (event) => {event.preventDefault(); work(async () => {
    const p = Object.fromEntries(["title", "unit", "condition", "setContents", "asin", "sellerSku", "memo", "catalogTask", "fbaEligibility", "reviewDate", "imageUrl"].map((field) => [field, productForm.elements[field].value]));
    p.imageSource = editingProduct?.imageUrl === p.imageUrl ? editingProduct.imageSource || "manual" : "manual";
    p.linkedLinkIds = $("#stockLinked").value ? editingProduct?.linkedLinkIds[0] === $("#stockLinked").value ? editingProduct.linkedLinkIds : [$("#stockLinked").value] : [];
    await showPreview({operationId: crypto.randomUUID(), kind: editingProduct ? "edit" : "create", productId: editingProduct?.id || crypto.randomUUID(), product: p,
      ...(editingProduct ? {} : {initialCounts: Object.fromEntries(["container", "home"].map((id) => {const value = productForm.elements[id + "Quantity"].value; return [id, value === "" ? null : Number(value)];}))})});
  }, "#stockProductError");});
  placesForm.addEventListener("submit", (event) => {event.preventDefault(); work(async () => {
    const locations = {};
    for (const b of placesProduct.totals.locations) {
      const value = placesForm.elements[b.locationId].value;
      if (value === "") {if (b.usable !== null) throw new Error(`${locationName(b.locationId)}は確認済みです。数量を入力してください（在庫なしは0）。`); continue;}
      const usable = Number(value);
      if (usable !== b.usable) locations[b.locationId] = {usable, reserved: b.reserved ?? 0, unusable: b.unusable ?? 0};
    }
    if (!Object.keys(locations).length) throw new Error("数量は変更されていません。変更する場所の実数を入力してください。");
    await showPreview({operationId: crypto.randomUUID(), kind: "count_locations", productId: placesProduct.id, locations, reason: placesForm.elements.reason.value.trim() || "場所ごとの実数を確認"});
  }, "#stockPlacesError");});
  actionForm.addEventListener("submit", (event) => {event.preventDefault(); work(async () => {
    const kind = actionForm.elements.kind.value, command = {operationId: crypto.randomUUID(), kind, productId: activeProduct.id, reason: actionForm.elements.reason.value};
    if (kind === "count") {command.locationId = actionForm.elements.locationId.value; command.counts = Object.fromEntries(["usable", "reserved", "unusable"].map((b) => [b, Number(actionForm.elements[b].value)]));}
    else {command.quantity = Number(actionForm.elements.quantity.value); if (["receive_transfer", "return_transfer"].includes(kind)) Object.assign(command, {transferId: actionForm.elements.transferId.value, bucket: actionForm.elements.bucket.value, evidence: actionForm.elements.evidence.value});
      else {command.locationId = actionForm.elements.locationId.value; if (kind === "dispatch") Object.assign(command, {to: actionForm.elements.to.value, reference: actionForm.elements.reference.value});}}
    await showPreview(command);
  }, "#stockActionError");});
  function clearPending() {pending = null; try {sessionStorage.removeItem(pendingKey);} catch {} controls();}
  async function save(payload) {
    sessionStorage.setItem(pendingKey, JSON.stringify(payload)); pending = payload; controls();
    try {
      const result = await request("/operations", {command: payload.command, confirmed: true}, payload.revision);
      view = {...result.result, photoRead: view.photoRead,amazonRead:view.amazonRead}; clearPending(); dirty = false;
      for (const dialog of document.querySelectorAll(".stock-dialog[open]")) dialog.close(); render(); status(result.receipt.replayed ? "保存済みの操作を確認しました。数量を重複変更していません。" : payload.command.reason==="ヤフオク出品との関連付け" ? "ヤフオクとの関連付けを保存しました。場所別数量は変更していません。" : "在庫の変更と履歴を保存しました。");
    } catch (error) {$("#stockPendingStatus").textContent = error.message; throw error;}
  }
  $("#stockCommit").addEventListener("click", () => work(() => save(preview), "#stockConfirmError"));
  $("#stockResolve").addEventListener("click", () => work(async () => {await request("/operations/" + pending.command.operationId); clearPending(); dirty = false; for (const dialog of document.querySelectorAll(".stock-dialog[open]")) dialog.close(); await load(); status("前の操作は保存済みでした。数量の再変更はしていません。");}));
  $("#stockRetry").addEventListener("click", () => work(async () => {
    const payload = pending;
    try {await save(payload);} catch (error) {
      if (error.status !== 409) throw error;
      await load();
      // A committed operation is returned before version checking by the server.
      // On a real conflict, require a fresh preview instead of silently rebasing a count.
      preview = null; await showPreview(payload.command, view.storage.revision);
      status("別の操作で在庫が更新されています。新しい変更前後を確認してから保存してください。");
    }
  }));
  $("#stockRefresh").addEventListener("click", () => work(async () => {await load(); status("保存済みの手元在庫を更新しました。");}));
  $("#stockNew").addEventListener("click", () => openProduct());
  $("#stockExport").addEventListener("click", () => work(async () => {const response = await monitorRequest("/api/physical-stock/export.csv"); if (!response.ok) throw new Error("CSVを取得できません"); const url = URL.createObjectURL(await response.blob()); const a = document.createElement("a"); a.href = url; a.download = "physical-stock.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);}));
  $("#stockPhotos").addEventListener("click", () => work(async () => {status("Amazonの商品画像を取得しています。数量は変更しません。"); const result = await request("/photos", {}); await load(); status(`商品画像 ${result.updated}件を保存しました。${result.errors.length ? `取得できず ${result.errors.length}件：${result.errors.map((e) => e.asin + " " + e.error).join(" ／ ")}` : ""}${result.remaining ? " 未取得分はもう一度取得できます。" : ""} ASIN未登録の商品は画像URLまたはASINを登録してください。`);}));
  $("#stockAmazonCheck").addEventListener("click",()=>work(async()=>{status("登録ASINに対応する御社のAmazon出品を確認しています。数量・出品は変更しません。");const result=await request("/amazon-listings",{});await load();status(result.status === "complete" ? `御社のAmazon出品を確認しました（${result.checkedAsins} ASIN・${result.offers} SKU）。倉庫の実数やヤフオクの関連付けは変更していません。` : result.error,result.status !== "complete");}));
  for (const selector of ["#stockSearch", "#stockLocationFilter", "#stockStateFilter", "#stockPurposeFilter"]) $(selector).addEventListener("input", render);
  for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => {$("#" + button.dataset.close).close(); if (button.dataset.close !== "stockConfirmDialog") dirty = false;});
  for (const element of [actionForm.elements.kind, actionForm.elements.locationId, actionForm.elements.to, actionForm.elements.transferId]) element.addEventListener("change", syncAction);
  for (const button of document.querySelectorAll("[data-stock-mode]")) button.addEventListener("click", () => {actionForm.elements.kind.value = button.dataset.stockMode; syncAction(); dirty = true;});
  $("#stockLinked").addEventListener("change", () => {const l = view.linkOptions.find((l) => l.id === $("#stockLinked").value); if (!l) return; if (!productForm.elements.title.value) productForm.elements.title.value = l.title; productForm.elements.asin.value = l.asin || ""; productForm.elements.sellerSku.value = l.sellerSku || "";});
  for (const form of [productForm, actionForm, placesForm]) form.addEventListener("input", () => {dirty = true;});
  window.addEventListener("beforeunload", (event) => {if (dirty || pending) {event.preventDefault(); event.returnValue = "";}});
  $("#stockReferenceRows").innerHTML = references.map((r, index) => `<div class="stock-reference"><span>${escape(r[0])}<br><small>以前のメモ：${r[1] === null ? "数量未確認" : r[1] + r[2]}・現在数ではありません</small></span><button type="button" data-reference="${index}">この商品を入力</button></div>`).join("");
  for (const button of document.querySelectorAll("[data-reference]")) button.addEventListener("click", () => openProduct(null, references[Number(button.dataset.reference)]));
  await work(async () => {await load(); if (pending) status("前の操作の保存結果が未確認です。同じ操作IDで確認・再試行できます。", true);});
  const context=new URLSearchParams(location.hash.slice(1)),target=view?.products.find(p=>p.id===context.get("connect"));
  if(target&&!pending&&!readOnly){openLinks(target,context.get("link"));history.replaceState(null,"",location.pathname+location.search);}
}
