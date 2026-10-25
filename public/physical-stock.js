import {monitorRequest} from "./monitor-http.js";

const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const when = (value) => value ? new Date(value).toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"}) : "未確認";
const labels = {create: "商品登録", edit: "商品情報の編集", add: "追加", remove: "販売等の減少", count: "棚卸し・実数修正", reserve: "取り置き", release: "取り置き解除", unusable: "使用不可へ振替", recover: "使用可能へ復帰", dispatch: "発送・移動開始", receive_transfer: "到着・受領", return_transfer: "出荷元へ戻す"};
const conditions = {new: "新品", used: "中古", parts: "部品・現状品", unknown: "状態未確認"};
const tasks = {none: "", pending: "カタログ作成待ち", working: "カタログ作業中", registered: "カタログ登録済み"};
const locationName = (id) => ({container: "コンテナ", home: "自宅・自社", fba: "Amazon FBA"})[id] || id;
const references = [["iiyama XUB2493HS-B3", 6, "台"], ["iiyama E2483HS-B3", 13, "台"], ["ASUS VG245H", 7, "台"], ["I-O DATA LCD-MF245EDB-F", 5, "台"], ["学研 スーパーのりものデラックス：ふみきりのヒミツ！", 15, "箱"], ["ヘルメット（色別・数量要確認）", null, "個"]];
function imageUrl(value) {try {const u = new URL(value); if (u.protocol === "https:" && u.hostname.endsWith(".yimg.jp") && !u.username && !u.password && !u.port) return u.href;} catch {} return "";}

export async function openStock({userId, readOnly}) {
  let view, activeProduct, editingProduct, preview, busy = false, dirty = false, pending;
  const pendingKey = "physical-stock-pending:" + userId;
  const productForm = $("#stockProductForm"), actionForm = $("#stockActionForm");
  const status = (message, error = false) => {$("#stockStatus").textContent = message; $("#stockStatus").classList.toggle("error", error);};
  try {pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");} catch {pending = null;}
  function controls() {
    for (const button of document.querySelectorAll(".stock-shell button")) button.disabled = busy;
    for (const button of document.querySelectorAll("[data-stock-action],[data-stock-edit],[data-stock-transfer],#stockNew,[data-reference]")) button.disabled = busy || readOnly || Boolean(pending) || !view;
    $("#stockCommit").disabled = busy || readOnly || !preview;
    $("#stockCommit").textContent = pending ? "同じ操作を再試行" : "この内容で保存";
    $("#stockRetry").disabled = busy || readOnly;
    $("#stockPending").hidden = !pending;
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
    $("#stockSummary").textContent = `${view.products.length}商品 ／ 移動中 ${view.totals.inTransit}件 ／ 手入力台帳・FBAは別参照`;
    const query = $("#stockSearch").value.trim().toLowerCase(), place = $("#stockLocationFilter").value, filter = $("#stockStateFilter").value;
    const products = view.products.filter((p) => [p.title, p.managementId, p.asin, p.sellerSku, p.memo].join(" ").toLowerCase().includes(query) &&
      (!place || p.totals.locations.some((b) => b.locationId === place && (b.usable === null || b.usable + b.reserved + b.unusable > 0))) &&
      (!filter || filter === "catalog" && ["pending", "working"].includes(p.catalogTask) || filter === "unknown" && p.totals.unknownLocations > 0 || filter === "transit" && p.totals.inTransit > 0 || filter === "replenishment" && p.replenishmentCandidate));
    const balance = (b, unit) => b.usable === null ? '<strong>未確認</strong>' : `<strong>使用可能 ${b.usable}${escape(unit)}</strong><small>取り置き ${b.reserved} ／ 使用不可 ${b.unusable}</small><small>${when(b.checkedAt)}</small>`;
    $("#stockRows").innerHTML = products.length ? products.map((p) => {
      const photo = imageUrl(p.linked[0]?.imageUrl);
      return `<tr><td data-label="商品"><div class="stock-product">${photo ? `<img src="${escape(photo)}" alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer">` : ""}<div><strong>${escape(p.title)}</strong><small>${escape(p.managementId)} ／ ${conditions[p.condition]} ／ ${escape(p.unit)}</small><small>${escape(p.setContents)}</small>${p.asin ? `<small>ASIN：${escape(p.asin)}</small>` : ""}<small>${escape(p.memo)}</small><small>${escape(tasks[p.catalogTask])}${p.reviewDate ? ` ／ 再確認 ${escape(p.reviewDate)}` : ""}</small></div></div></td>
        <td data-label="コンテナ">${balance(p.totals.locations[0], p.unit)}</td><td data-label="自宅・自社">${balance(p.totals.locations[1], p.unit)}</td><td data-label="移動中"><strong>${p.totals.inTransit}${escape(p.unit)}</strong><small>手元の確認済み計 ${p.totals.usable + p.totals.reserved + p.totals.unusable}${escape(p.unit)}${p.totals.unknownLocations ? "・未確認の場所あり" : ""}</small></td>
        <td data-label="Amazon・ヤフオク"><strong>FBA：${escape(p.fba.label)}</strong><small>${when(p.fba.checkedAt)}</small>${p.replenishmentCandidate ? '<small>補充検討（取得分0）</small>' : ""}${p.linked.map((l) => `<a href="https://auctions.yahoo.co.jp/jp/auction/${escape(l.listingId)}" target="_blank" rel="noreferrer">${escape(l.listingId)}</a><small>出品状態：${({active:"出品中",ended:"終了確認済み",ending:"再確認待ち"})[l.yahooStatus] || "未確認"}</small>`).join("")}</td>
        <td data-label="操作"><button type="button" data-stock-action="${escape(p.id)}">数量・移動</button><button type="button" data-stock-edit="${escape(p.id)}">情報・メモ</button></td></tr>`;
    }).join("") : `<tr><td colspan="6">${view.products.length ? "該当する商品はありません。" : "登録された手元在庫はまだありません。"}</td></tr>`;
    for (const img of document.querySelectorAll("#stockRows img")) img.addEventListener("error", () => {img.hidden = true;});
    for (const button of document.querySelectorAll("[data-stock-action]")) button.addEventListener("click", () => openAction(button.dataset.stockAction));
    for (const button of document.querySelectorAll("[data-stock-edit]")) button.addEventListener("click", () => openProduct(view.products.find((p) => p.id === button.dataset.stockEdit)));
    $("#stockTransferRows").innerHTML = view.transfers.length ? [...view.transfers].reverse().map((t) => `<div class="stock-transfer"><span><strong>${escape(view.products.find((p) => p.id === t.productId)?.title || "商品")}</strong><br>${locationName(t.from)} → ${locationName(t.to)} ／ 移動中 ${t.remaining} ／ 到着 ${t.received} ／ 出荷元へ戻し ${t.returned}<br><small>${escape(t.reference)} ／ ${when(t.updatedAt)}</small></span>${t.remaining ? `<button type="button" data-stock-transfer="${escape(t.id)}">到着を記録</button>` : ""}</div>`).join("") : "<p>移動の記録はありません。</p>";
    for (const button of document.querySelectorAll("[data-stock-transfer]")) {button.disabled = readOnly || Boolean(pending); button.addEventListener("click", () => {const t = view.transfers.find((t) => t.id === button.dataset.stockTransfer); openAction(t.productId, "receive_transfer", t.id);});}
    $("#stockHistory").innerHTML = view.events.length ? view.events.map((e) => `<li>${when(e.at)} ／ ${escape(view.products.find((p) => p.id === e.productId)?.title)} ／ ${labels[e.kind]} ／ ${escape(e.reason)}${e.changes.map((c) => `<br>${locationName(c.locationId)}：${["usable", "reserved", "unusable"].map((b) => `${({usable:"使用可能",reserved:"取り置き",unusable:"使用不可"})[b]} ${c.before[b] ?? "未確認"} → ${c.after[b] ?? "未確認"}`).join(" ／ ")}`).join("")}${e.transferAfter ? `<br>移動中 ${e.transferBefore?.remaining ?? 0} → ${e.transferAfter.remaining} ／ 到着 ${e.transferBefore?.received ?? 0} → ${e.transferAfter.received} ／ 戻し ${e.transferBefore?.returned ?? 0} → ${e.transferAfter.returned}` : ""}${e.evidence ? `<br>確認根拠：${escape(e.evidence)}` : ""}${e.metadataAfter ? `<br>ASIN：${escape(e.metadataBefore.asin || "なし")} → ${escape(e.metadataAfter.asin || "なし")} ／ ${escape(tasks[e.metadataAfter.catalogTask])}` : ""}</li>`).join("") : "<li>まだ変更履歴はありません。</li>";
    controls();
  }
  async function load() {view = await request(); render();}
  function openProduct(product, reference) {
    editingProduct = product || null; productForm.reset(); dirty = false; preview = null;
    $("#stockProductError").textContent = ""; $("#stockProductTitle").textContent = product ? "商品情報・メモ" : "商品を登録";
    $("#stockInitialFields").hidden = Boolean(product);
    $("#stockExtraFields").open = Boolean(product && product.catalogTask !== "none");
    for (const field of ["title", "unit", "condition", "setContents", "asin", "sellerSku", "memo", "catalogTask", "fbaEligibility", "reviewDate"]) {
      if (product) productForm.elements[field].value = product[field] || "";
      productForm.elements[field].disabled = Boolean(product && ["unit", "condition", "setContents"].includes(field));
    }
    $("#stockLinked").innerHTML = '<option value="">紐付けなし</option>' + view.linkOptions.map((l) => `<option value="${escape(l.id)}">${escape(l.title)} ／ ${escape(l.asin)} ／ ${escape(l.listingId)}</option>`).join("");
    $("#stockLinked").value = product?.linkedLinkIds[0] || "";
    if (reference) {productForm.elements.title.value = reference[0]; productForm.elements.unit.value = reference[2];}
    $("#stockProductDialog").showModal();
  }
  function syncAction() {
    const kind = actionForm.elements.kind.value, transferring = ["receive_transfer", "return_transfer"].includes(kind);
    $("#stockNormalLocation").hidden = transferring; $("#stockCountFields").hidden = kind !== "count"; $("#stockQtyFields").hidden = kind === "count";
    $("#stockDispatchFields").hidden = kind !== "dispatch"; $("#stockReceiveFields").hidden = !transferring;
    actionForm.elements.quantity.required = kind !== "count";
    for (const b of ["usable", "reserved", "unusable"]) {actionForm.elements[b].required = kind === "count"; if (kind === "count") actionForm.elements[b].value = activeProduct.totals.locations.find((l) => l.locationId === actionForm.elements.locationId.value)?.[b] ?? "";}
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
    $("#stockConfirmContent").innerHTML = `<strong>${escape(result.product.title)}</strong><p>${labels[command.kind]} ／ ${escape(result.product.managementId)}</p>${e?.changes.length ? `<table><thead><tr><th>場所・区分</th><th>変更前</th><th>変更後</th></tr></thead><tbody>${e.changes.flatMap((c) => ["usable", "reserved", "unusable"].map((b) => `<tr><td>${locationName(c.locationId)}・${({usable:"使用可能",reserved:"取り置き",unusable:"使用不可"})[b]}</td><td>${c.before[b] ?? "未確認"}</td><td>${c.after[b] ?? "未確認"}${escape(result.product.unit)}</td></tr>`)).join("")}</tbody></table>` : ""}${e?.transferAfter ? `<p>${locationName(e.transferAfter.from)} → ${locationName(e.transferAfter.to)} ／ 移動中 ${e.transferAfter.remaining}${escape(result.product.unit)}</p>` : ""}<p>${escape(command.reason || result.product.memo || "")}</p>${command.kind === "edit" ? `<p>ASIN：${escape(result.product.asin || "未登録")} ／ ${escape(tasks[result.product.catalogTask])}</p><p>${escape(result.product.memo)}</p>` : ""}<p class="meta">手元在庫の記録のみ。Amazon・ヤフオクの数量や出品は変更しません。</p>`;
    $("#stockConfirmError").textContent = ""; $("#stockConfirmDialog").showModal(); controls();
    if (result.duplicates.length) {const warning = document.createElement("p"); warning.className = "stock-error"; warning.textContent = "同じASIN・商品名の登録あり：" + result.duplicates.map((p) => p.managementId + " " + p.title).join(" ／ ") + "。別の現物・状態か確認してください。"; $("#stockConfirmContent").prepend(warning);}
  }
  productForm.addEventListener("submit", (event) => {event.preventDefault(); work(async () => {
    const p = Object.fromEntries(["title", "unit", "condition", "setContents", "asin", "sellerSku", "memo", "catalogTask", "fbaEligibility", "reviewDate"].map((field) => [field, productForm.elements[field].value]));
    p.linkedLinkIds = $("#stockLinked").value ? [$("#stockLinked").value] : [];
    await showPreview({operationId: crypto.randomUUID(), kind: editingProduct ? "edit" : "create", productId: editingProduct?.id || crypto.randomUUID(), product: p,
      ...(editingProduct ? {} : {locationId: productForm.elements.locationId.value, quantity: productForm.elements.quantity.value === "" ? null : Number(productForm.elements.quantity.value)})});
  }, "#stockProductError");});
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
      view = result.result; clearPending(); dirty = false;
      for (const dialog of document.querySelectorAll(".stock-dialog[open]")) dialog.close(); render(); status(result.receipt.replayed ? "保存済みの操作を確認しました。数量を重複変更していません。" : "在庫の変更と履歴を保存しました。");
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
  for (const selector of ["#stockSearch", "#stockLocationFilter", "#stockStateFilter"]) $(selector).addEventListener("input", render);
  for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => {$("#" + button.dataset.close).close(); if (button.dataset.close !== "stockConfirmDialog") dirty = false;});
  for (const element of [actionForm.elements.kind, actionForm.elements.locationId, actionForm.elements.to, actionForm.elements.transferId]) element.addEventListener("change", syncAction);
  $("#stockLinked").addEventListener("change", () => {const l = view.linkOptions.find((l) => l.id === $("#stockLinked").value); if (!l) return; if (!productForm.elements.title.value) productForm.elements.title.value = l.title; productForm.elements.asin.value = l.asin || ""; productForm.elements.sellerSku.value = l.sellerSku || "";});
  for (const form of [productForm, actionForm]) form.addEventListener("input", () => {dirty = true;});
  window.addEventListener("beforeunload", (event) => {if (dirty || pending) {event.preventDefault(); event.returnValue = "";}});
  $("#stockReferenceRows").innerHTML = references.map((r, index) => `<div class="stock-reference"><span>${escape(r[0])}<br><small>以前のメモ：${r[1] === null ? "数量未確認" : r[1] + r[2]}・現在数ではありません</small></span><button type="button" data-reference="${index}">この商品を入力</button></div>`).join("");
  for (const button of document.querySelectorAll("[data-reference]")) button.addEventListener("click", () => openProduct(null, references[Number(button.dataset.reference)]));
  await work(async () => {await load(); if (pending) status("前の操作の保存結果が未確認です。同じ操作IDで確認・再試行できます。", true);});
}
