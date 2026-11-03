import {monitorRequest} from "./monitor-http.js";
import {createCatalogView} from "./catalog-view.js";
import {createProductAccess} from "./product-access.js";
const $ = (selector) => document.querySelector(selector);
const displayHost=document.createElement("div");$("#linkRows").closest("table").before(displayHost);
const catalog=createCatalogView({key:"links",host:displayHost,roots:[$("#linkRows")],measureLabels:["FBA取得数 多い順","FBA取得数 少ない順"]});
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
const inventoryLabels = {available: "在庫あり", zero: "充当可能在庫なし", unknown: "確認できず", unlinked: "紐付け要確認"};
const yahooLabels = {active: "出品中", ended: "出品終了", ending: "終了・登録URLで確認", unknown: "登録URLから確認", unlinked: "出品URLを登録"};
let saved;
let demo;
let currentMode = "saved";
const access=createProductAccess({readOnly:()=>Boolean(saved?.config.capabilities?.readOnly)||currentMode==='demo',onChanged:async()=>{saved=await api();await access.load();render();}});
let running = 0;
const memoDrafts = new Map();
let notificationSettingsDirty = false;
let salesAutomationDirty=false;
let mailPoll;
const deliveryLabels = {pending: "送信待ち", sending: "送信処理中", smtp_accepted: "Gmail送信受付済み", failed: "送信失敗", uncertain: "送信結果不明・受信箱を確認", cancelled: "送信対象外", info_only: "補足情報・メール対象外"};
function amazonImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-fe.ssl-images-amazon.com"].includes(url.hostname) && !url.username && !url.password && !url.port) return url.href;
  } catch { /* An image is optional. */ }
  return "";
}
function productPreview(listing, product, link) {
  let image = "";
  let source = !listing?.imageUrl&&link?.previousListingImageUrl?"以前の出品写真（参考）":"ヤフオク写真";
  try {
    const url = new URL(listing?.imageUrl||link?.previousListingImageUrl);
    if (url.protocol === "https:" && url.hostname.endsWith(".yimg.jp") && !url.username && !url.password && !url.port) image = url.href;
  } catch { /* A missing image does not prevent linking. */ }
  if (!image) {image = amazonImage(product?.listingInfo?.offerImageUrls?.[0]); source = "自社Amazon写真";}
  if (!image) {image = amazonImage(product?.listingInfo?.catalogImageUrl); source = "Amazon共通画像";}
  const title = listing?.title || (product?.title !== product?.asin ? product?.title : "") || link?.previousListingTitle || "商品名：未取得";
  return `<div class="linked-product">${image ? `<div class="product-photo"><img src="${escape(image)}" alt="" width="64" height="64" loading="lazy" referrerpolicy="no-referrer"><small>${source}</small></div>` : ""}<span>${escape(title)}</span></div>`;
}
const date = (value) => value ? new Date(value).toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"}) : "不明";
const number = (value) => value === null || value === undefined ? "不明" : `${value}個`;
function status(message, error = false) {$("#monitorStatus").textContent = message; $("#monitorStatus").classList.toggle("error", error);}
async function api(path = "", data, method) {
  const headers = {"Content-Type": "application/json"};
  if (saved?.config.capabilities?.cloud && saved.storage.revision !== undefined) headers["If-Match"] = `"${saved.storage.revision}"`;
  const response = await monitorRequest(`/api/link-monitor${path}`, data === undefined ? undefined : {method: method || "POST", headers, body: JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作を完了できませんでした");
  return result;
}
async function action(work) {
  if (running) return;
  running++;
  const buttons = [...document.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  try { await work(); }
  catch (error) { status(error.message, true); }
  finally { running--; for (const button of buttons) if (button.isConnected) button.disabled = false; applyCapabilities(); }
}
function applyCapabilities() {
  const capabilities = saved?.config.capabilities;
  if (!capabilities?.cloud) return;
  const external = capabilities.externalReads === false;
  const readOnly = capabilities.readOnly;
  if ($("#salesSection")) {
    $("#salesSection").hidden = !capabilities.salesRead || currentMode !== "saved";
    $("#salesStart").disabled = Boolean(readOnly || !capabilities.salesRead || saved.salesHistory?.status === "running");
    $("#salesStart").textContent = saved.salesHistory?.status === "not_started" ? "販売追跡を開始" : "未追跡の商品を追加";
    $("#salesCheck").disabled = Boolean(readOnly || !capabilities.salesRead || !saved.salesHistory || ["not_started", "running"].includes(saved.salesHistory.status));
  }
  if (readOnly) $("#pageLinkForm").closest("section").hidden = true;
  for (const selector of ["#fbaCheck", "#productRefresh", "[data-product-preview]", "#advancedSetup", "[data-unlink]"]) {
    document.querySelectorAll(selector).forEach((element) => {
      if (selector === "#fbaCheck" && capabilities.inventoryRead) {element.hidden = false; element.disabled = Boolean(readOnly); element.title = "登録済みの商品だけのFBA数量を取得します。出品・在庫変更やメール送信は行いません"; return;}
      element.hidden = external && !capabilities.preserveControls;
      if (external && capabilities.preserveControls) {
        if (element.tagName === "DETAILS") element.querySelectorAll("button,input,textarea,select").forEach((control) => {control.disabled = true; control.title = "この取込・外部接続は移行後の追加対応です";});
        else {element.disabled = true; element.title = "外部取得・解除は追加対応中です。保存済みの情報は表示しています";}
      }
    });
  }
  document.querySelectorAll(".monitor-header nav a").forEach((element) => {element.hidden = !capabilities.legacyDrafts;});
  if ($("#cloudMailControls")) {
    $("#cloudMailControls").hidden = !capabilities.mailTest;
    $("#verifyCloudMail").disabled = Boolean(readOnly || !capabilities.mailTest);
    $("#testRegistrationMail").disabled = Boolean(readOnly || !capabilities.mailTest || saved.cloudMail?.status !== "verified" || saved.mailOutbox?.some((entry) => entry.key === "cloud-registration-test:v1"));
  }
  if($("#salesAutomationTest"))$("#salesAutomationTest").disabled=Boolean(readOnly || saved.cloudMail?.status!=="verified" || saved.mailOutbox?.some(item=>item.key==="sales-automation-test:v1"));
  for (const selector of ["#pageLinkForm", "#batchRegistration", "#previewCheck", ".memo-edit", ".link-memo"]) {
    document.querySelectorAll(selector).forEach((element) => {if (readOnly) element.hidden = true;});
  }
}
function switchMode(mode) {
  currentMode = mode;
  for (const [name, value] of [["demo", "練習用の紐付け"], ["saved", "登録した紐付け"]]) {
    $(`#${name}Tab`).setAttribute("aria-selected", String(mode === name));
    $(`#${name}Panel`).hidden = mode !== name;
    if (mode === name) $("#monitorTableTitle").textContent = value;
  }
  $("#previewCheck").hidden = mode !== "saved";
  $("#fbaCheck").hidden = mode !== "saved";
  $("#productRefresh").hidden = mode !== "saved";
  render();
}
$("#demoTab").addEventListener("click", () => switchMode("demo"));
$("#savedTab").addEventListener("click", () => switchMode("saved"));
$("#pageLinkForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  const data = Object.fromEntries(new FormData(event.target));
  saved = await api("/page-links", {...data, submitted: true});
  render(); event.target.reset(); status("Amazonとヤフオクのページを紐付けました。");
  scheduleMailPoll();
  const listingId = new URL(data.yahoo).pathname.split("/").filter(Boolean).at(-1).toLowerCase();
  const link = saved.links.find((item) => item.listingId === listingId);
  if (link) window.dispatchEvent(new CustomEvent("stock-page-link-created",{detail:{linkId:link.id,asin:link.asin || saved.catalog.find(p=>p.id===link.catalogId)?.asin}}));
  if (link && saved.config.capabilities?.externalReads !== false && !saved.listings.find((item) => item.listingId === listingId)?.previewCheckedAt) await fetchProductPreview(link.id);
});});
async function fetchProductPreview(id) {
  status("紐付けは保存済みです。ヤフオクの画像・商品名を取得しています。");
  saved = await api(`/links/${encodeURIComponent(id)}/product-preview`, {});
  render(); status("紐付けと商品の表示を更新しました。");
}
function addBatchRow() {
  if ($("#batchRows").children.length >= 50) return status("まとめ登録は50行までです", true);
  const row = document.createElement("div");
  row.className = "batch-row";
  const index = $("#batchRows").children.length + 1;
  row.innerHTML = `<label>AmazonのASIN・URL<input name="amazon" aria-label="${index}行目のAmazon ASIN・URL" autocomplete="off"></label><label>ヤフオクの出品URL<input name="yahoo" aria-label="${index}行目のヤフオクURL" autocomplete="off"></label><button type="button" class="batch-remove" title="この行を削除" aria-label="この行を削除">×</button><p class="batch-result" role="status"></p>`;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#batchRows").append(row);
}
$("#addBatchRow").addEventListener("click", addBatchRow);
for (let n = 0; n < 3; n++) addBatchRow();
$("#batchForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  const rows = [...$("#batchRows").children].filter((row) => !["created", "existing"].includes(row.dataset.result) && [...row.querySelectorAll("input")].some((input) => input.value.trim()));
  if (!rows.length) return status("未登録の行へASINとヤフオクURLを入力してください");
  saved = await api("/page-links/batch", {submitted: true, rows: rows.map((row) => Object.fromEntries([...row.querySelectorAll("input")].map((input) => [input.name, input.value])))});
  for (const result of saved.batchResults) {
    const row = rows[result.row];
    row.dataset.result = result.status;
    row.querySelector(".batch-result").textContent = result.status === "created" ? "登録しました" : result.status === "existing" ? "登録済みです" : result.error;
    for (const input of row.querySelectorAll("input")) {input.readOnly = result.status !== "error"; input.setAttribute("aria-invalid", String(result.status === "error"));}
  }
  const count = (value) => saved.batchResults.filter((item) => item.status === value).length;
  $("#batchStatus").textContent = `今回登録 ${count("created")}件 ／ 登録済み ${count("existing")}件 ／ 要修正 ${count("error")}件`;
  render(); scheduleMailPoll(); status("まとめ登録の結果を各行へ表示しました。要修正の行だけ直して再登録できます。");
});});
$("#notificationSettingsForm").addEventListener("change", () => {notificationSettingsDirty = true;});
$("#notificationSettingsForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  saved = await api("/notification-settings", {mailEnabled: $("#mailEnabled").checked, monitoringEnabled: $("#monitoringEnabled").checked});
  notificationSettingsDirty = false; render();
  status("通知設定を保存しました。過去の登録分への一斉送信は行いません。");
});});
$("#checkAndNotify").addEventListener("click", () => action(async () => {
  await api("/check-and-notify", {});
  let job;
  do {
    job = await api("/notification-status");
    $("#notificationJobStatus").textContent = job.status === "running" ? "在庫とヤフオクの出品状態を確認しています。" : job.status === "complete" ? "確認が終わりました。メールの結果は下に表示します。" : job.error || "確認を完了できませんでした。";
    if (job.status === "running") await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (job.status === "running");
  saved = await api(); render();
  status(job.status === "complete" ? "確認が終わりました。出品内容や在庫数は変更していません。" : job.error, job.status !== "complete");
}));
$("#testRegistrationMail").addEventListener("click", () => action(async () => {
  const link = saved.links[0];
  if (!link) return status("先に商品を1件紐付けてください", true);
  const cloud = saved.config.capabilities?.cloud;
  if (cloud && !window.confirm(`${saved.notificationSettings.recipient} に登録完了テストを1通だけ送ります。出品・在庫は変更せず、自動通知はオンにしません。送信しますか？`)) return;
  saved = await api("/mail/test-registration", {linkId: link.id, ...(cloud ? {confirmed: true} : {})}); render(); scheduleMailPoll();
  status("登録メールのテスト結果を更新しました。下の送信受付・失敗の表示をご確認ください。同じ商品のテストを重複送信しません。");
}));
$("#verifyCloudMail")?.addEventListener("click", () => action(async () => {
  saved = await api("/mail/verify", {}); render();
  status(saved.cloudMail?.status === "verified" ? "Gmailの接続・認証を確認しました。メールは送信していません。" : "Gmailへ接続できませんでした。メールは送信していません。", saved.cloudMail?.status !== "verified");
}));
function scheduleMailPoll() {
  clearTimeout(mailPoll);
  if (!saved?.config.notificationRuntime) return;
  if (!saved?.mailOutbox?.some((item) => ["pending", "sending"].includes(item.status))) return;
  mailPoll = setTimeout(async () => {
    try {if (!running) {saved = await api(); render();}}
    catch {status("メール送信状況を取得できません。更新して確認してください", true);}
    scheduleMailPoll();
  }, 2500);
}
function renderMail() {
  const settings = saved?.notificationSettings;
  $("#mailSettingLabel").textContent = `メール：${settings?.mailEnabled ? "有効" : "オフ"}`;
  $("#monitorSettingLabel").textContent = `自動確認：${settings?.monitoringEnabled ? "30分ごと" : "オフ"}`;
  $("#notificationSettingsFields").disabled = !saved?.config.notificationRuntime;
  $("#notificationRuntimeWarning").hidden = Boolean(saved?.config.notificationRuntime);
  $("#notificationRuntimeWarning").textContent = saved?.config.notificationRuntimeMessage || "通知機能の反映にはツールの再起動が必要です。";
  $("#notificationRecipient").textContent = settings ? `通知先：${settings.recipient}` : "通知機能はまだ反映されていません。";
  if (!notificationSettingsDirty) {$("#mailEnabled").checked = Boolean(settings?.mailEnabled); $("#monitoringEnabled").checked = Boolean(settings?.monitoringEnabled);}
  const records = saved?.mailOutbox || [];
  const automation=saved?.salesAutomation;
  if($("#salesAutomationControls")){
    $("#salesAutomationControls").hidden=!automation;
    $("#notificationSettingsForm").hidden=Boolean(automation);
    if(automation){
      $("#notificationRuntimeWarning").hidden=true;
      $("#mailSettingLabel").textContent=`販売メール：${automation.enabled?"有効":"オフ"}`;
      $("#monitorSettingLabel").textContent=`自動確認：${automation.enabled?"1日1回":"オフ"}`;
      if(!salesAutomationDirty)for(const [id,key] of [["salesAutoEnabled","enabled"],["salesAutoFba","fbaSales"],["salesAutoMerchant","merchantSales"],["salesAutoErrors","errorAlerts"],["salesAutoStock","stockAlerts"],["salesAutoYahoo","yahooAlerts"],["salesAutoReview","reviewAlerts"]])$("#"+id).checked=automation[key];
      $("#salesAutomationFields").disabled=Boolean(saved.config.capabilities?.readOnly);
      $("#salesAutomationStatus").textContent=`${automation.enabled?automation.schedule:"自動確認はオフ"} ／ 最終実行：${date(automation.job.startedAt)} ／ ${{not_run:"まだ実行していません",running:"確認中",complete:"完了",partial:"一部未確認・全商品一覧を確認",failed:"要確認"}[automation.job.status] || automation.job.status}${automation.job.error?` ／ ${automation.job.error}`:""}`;
      $("#salesAutomationRun").disabled=!automation.enabled;
    }
  }
  if ($("#cloudMailStatus")) $("#cloudMailStatus").textContent = saved?.cloudMail?.status === "verified" ? "Gmail接続済み・自動送信オフ" : saved?.cloudMail?.status === "failed" ? "Gmail接続失敗・未送信" : "Gmail接続は未確認・未送信";
  if(automation && saved.cloudMail?.status==="verified")$("#cloudMailStatus").textContent="Gmail接続済み（到着は受信箱で確認）";
  $("#mailSummary").textContent = `送信受付 ${records.filter((item) => item.status === "smtp_accepted").length}件 ／ 待ち ${records.filter((item) => ["pending", "sending"].includes(item.status)).length}件 ／ 失敗・要確認 ${records.filter((item) => ["failed", "uncertain"].includes(item.status)).length}件`;
  $("#mailOutbox").innerHTML = records.slice(-10).reverse().map((item) => {
    const first = item.targets[0], listing = saved.listings.find((entry) => entry.listingId === first?.listingId);
    return `<li class="mail-record">${escape(item.subject)} ／ ${escape(deliveryLabels[item.status] || item.status)}<br><span class="meta">${escape(listing?.title || first?.asin || "商品名未取得")} ／ 対象${item.targets.length}件 ／ ${date(item.createdAt)}</span>${item.error ? `<br>${escape(item.error)}` : ""}${item.status === "failed" && !saved.config.capabilities?.cloud ? `<button type="button" data-mail-retry="${escape(item.id)}">再試行</button>` : ""}</li>`;
  }).join("");
  document.querySelectorAll("[data-mail-retry]").forEach((button) => button.addEventListener("click", () => action(async () => {
    saved = await api(`/mail/${encodeURIComponent(button.dataset.mailRetry)}/retry`, {}); render(); scheduleMailPoll(); status("再試行の結果を更新しました。");
  })));
}
$("#salesAutomationForm")?.addEventListener("change",()=>{salesAutomationDirty=true;});
$("#salesAutomationForm")?.addEventListener("submit",event=>{event.preventDefault();action(async()=>{
  saved=await api("/automation/settings",{enabled:$("#salesAutoEnabled").checked,fbaSales:$("#salesAutoFba").checked,merchantSales:$("#salesAutoMerchant").checked,errorAlerts:$("#salesAutoErrors").checked,stockAlerts:$("#salesAutoStock").checked,yahooAlerts:$("#salesAutoYahoo").checked,reviewAlerts:$("#salesAutoReview").checked});salesAutomationDirty=false;render();status("通知の種類を保存しました。");
});});
$("#salesAutomationTest")?.addEventListener("click",()=>action(async()=>{
  if(!window.confirm(`${saved.salesAutomation.recipient} へ販売通知の経路テストを1通送ります。実注文の通知ではありません。`))return;
  saved=await api("/automation/test",{confirmed:true});render();status("テスト結果を更新しました。Gmailの受信箱で到着を確認してください。同じテストは重複送信しません。");
}));
$("#salesAutomationRun")?.addEventListener("click",()=>action(async()=>{
  status("登録商品の自社SKUと注文を確認しています。数分かかる場合があります。");
  try{saved=await api("/automation/run",{});render();status(saved.salesAutomation.job.status==="complete"?"販売の確認が完了しました。新しい販売があれば通知します。":saved.salesAutomation.job.error,saved.salesAutomation.job.status!=="complete");}
  catch(error){saved=await api();render();throw error;}
}));
$("#productRefresh").addEventListener("click", () => action(async () => {
  const ids = saved.links.map((item) => item.id);
  let failed = 0;
  for (let index = 0; index < ids.length; index++) {
    status(`商品画像・名前を取得しています。${index + 1} / ${ids.length}件`);
    try {saved = await api(`/links/${encodeURIComponent(ids[index])}/product-preview`, {}); render();}
    catch {failed++;}
  }
  status(`商品画像・名前を更新しました。${ids.length - failed}件取得、${failed}件未取得。紐付けは保持しています。`, failed > 0);
}));
window.addEventListener("beforeunload", (event) => {
  const batchPending = [...document.querySelectorAll('.batch-row input:not([readonly])')].some((input) => input.value.trim());
  if (memoDrafts.size || batchPending || notificationSettingsDirty || salesAutomationDirty || $("#pairAmazon").value || $("#pairYahoo").value) {event.preventDefault(); event.returnValue = "";}
});
$("#refreshMonitor").addEventListener("click", () => action(async () => {saved = await api(); render(); status("保存済みの情報を更新しました。Amazon在庫の自動取得は行っていません。");}));
$("#demoForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  const result = await api("/demo", {scenario: $("#demoScenario").value});
  demo = result.result;
  $("#demoSteps").innerHTML = result.scenario.map((step) => `<li>${escape(step.label)}：通知${step.events}件</li>`).join("");
  render(); status("練習用データで確認しました。実メールは送信していません。");
});});
$("#catalogFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return status("ファイルは2MB以内にしてください", true);
  $("#catalogContent").value = await file.text();
});
$("#catalogForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  saved = await api("/catalog", {content: $("#catalogContent").value, context: {sellerAccount: $("#accountName").value, marketplaceId: $("#marketplace").value, checkedAt: new Date($("#inventoryAt").value).toISOString()}});
  render(); status("Amazon商品情報を取り込みました。状態・付属品と在庫の確認時刻をご確認ください。");
});});
$("#yahooForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  status("ヤフオクの商品説明と管理番号を読み取っています。");
  try {saved = await api("/yahoo", {url: $("#listingUrl").value}); status("読み取りました。ASINと商品の状態・セット内容を確認してください。");}
  catch (error) {saved = await api(); throw error;}
  finally {render();}
});});
$("#manualListingForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  saved = await api("/manual-listing", Object.fromEntries(new FormData(event.target)));
  render(); status("出品を手動登録しました。出品状態は未確認として扱います。");
});});
$("#previewCheck").addEventListener("click", () => action(async () => {saved = await api("/preview", {}); render(); status("通知内容を判定しました。同じ状態の重複通知は作りません。実メールは未送信です。");}));
async function followFbaJob() {
  let job;
  do {
    job = await api("/fba-status");
    if (job.status === "running") {
      status(`紐付けた${job.targets || saved.links.length}商品のFBA在庫を確認しています。`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } while (job.status === "running");
  saved = await api();
  render();
  status(job.status === "complete" ? "FBA在庫の確認が終わりました。結果は各商品の下に表示しています。メールは送信していません。" : job.error || "FBA在庫を確認できませんでした。再度お試しください。", job.status !== "complete");
}
$("#fbaCheck").addEventListener("click", () => action(async () => {
  status("AmazonのFBA在庫を確認しています。");
  await api("/fba-check", {});
  await followFbaJob();
}));
$("#successorForm").addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
  saved = await api(`/links/${encodeURIComponent($("#previousLink").value)}/successor`, {listingId: $("#successorListing").value, evidence: $("#successorEvidence").value, reviewed: $("#successorReviewed").checked});
  render(); status("確認根拠を残して再出品先に引き継ぎました。ヤフオクの出品内容は変更していません。");
});});

function render() {
  const data = currentMode === "demo" ? demo : saved;
  if (!data) return;
  renderMail();
  renderSales();
  $("#catalogSummary").textContent = `登録済みのAmazon商品：${saved?.catalog.length || 0}件`;
  $("#linkRows").innerHTML = data.links.length ? data.links.map((link) => {
    const a = link.assessment, p = a.product, y = a.listing, live=currentMode==="saved"?access.info("link:"+link.id).live:null;
    const shownFba=live?.availability?.fba||live?.fba,yahooState=live?.availability?.yahoo?.find(r=>r.listingId===link.listingId)?.state||a.yahoo;
    const own = p?.listingInfo;
    const comment = own?.ownCommentStatus === "retrieved" ? own.ownComment : own?.ownCommentStatus === "empty" ? "記載なし" : "未取得";
    return `<tr><td data-label="商品">${productPreview(y, p,link)}</td><td data-label="御社のAmazon"><a href="https://www.amazon.co.jp/dp/${escape(p?.asin || "")}" target="_blank" rel="noreferrer">ASIN：${escape(p?.asin || "不明")}</a>${currentMode === "saved" ? `<small class="fba-quantity">FBA在庫：${escape(shownFba?.quantity!==null&&shownFba?.quantity!==undefined?shownFba.quantity+"個":"未確認")}</small><small>確認：${date(shownFba?.checkedAt)}</small><p class="own-comment">自社コメント：${escape(comment)}</p>` : ""}</td>
      <td data-label="ヤフオク"><a href="${escape(y?.url || "#")}" target="_blank" rel="noreferrer">${escape(y?.listingId || "不明")}</a><small>${a.inventory === "unlinked" ? "紐付け要確認" : "紐付け登録済み"}</small><small>出品状態：${yahooLabels[yahooState]}</small></td>
      <td data-label="自分用メモ">${currentMode === "demo" ? "" : `<div class="memo-display" ${memoDrafts.has(link.id) ? "hidden" : ""}><p class="memo-text">${escape(link.userMemo || "メモなし")}</p><button type="button" class="memo-edit">メモを編集</button></div><form class="link-memo" data-memo="${escape(link.id)}" ${memoDrafts.has(link.id) ? "" : "hidden"}><label>ひとことメモ<textarea name="memo" rows="2" maxlength="500" placeholder="例：スタンドなし">${escape(memoDrafts.has(link.id) ? memoDrafts.get(link.id) : link.userMemo || "")}</textarea></label><div class="memo-actions"><button type="submit">メモを保存</button><button type="button" class="memo-cancel">取消</button><span class="memo-status" role="status">${memoDrafts.has(link.id) ? "未保存" : link.memoUpdatedAt ? "保存済み" : ""}</span></div></form>`}<details><summary>補足・操作</summary><p>${escape(p?.title || y?.title || "商品名：未取得")}</p><p>SKU：${escape(p?.sellerSku || "未取得")}</p><p>${escape(p?.condition || "状態不明")} ／ ${escape(p?.setContents || "付属品不明")}</p>
      <p>FBA在庫：${number(p?.fulfillableQuantity)} ／ ${inventoryLabels[a.inventory]}</p><p>ヤフオク：${yahooLabels[a.yahoo]}</p><p>${escape(a.reason)}</p><p class="full-comment">自社コメント：${escape(comment)}</p>${amazonImage(own?.offerImageUrls?.[0]) ? `<div class="linked-product"><img src="${escape(amazonImage(own.offerImageUrls[0]))}" alt="自社Amazon出品写真" width="64" height="64" loading="lazy" referrerpolicy="no-referrer"></div>` : ""}<small>確認：${date(p?.checkedAt)}</small><small>引継ぎ履歴：${link.history.length}件</small>
      ${currentMode === "demo" ? "" : `<button type="button" class="product-preview-button" data-product-preview="${escape(link.id)}">画像・商品名を再取得</button><button type="button" class="unlink-button" data-unlink="${escape(link.id)}">解除</button>`}</details></td></tr>`;
  }).join("") : '<tr><td colspan="4">まだ紐付けはありません。</td></tr>';
  if (currentMode === "saved") data.links.forEach((link, index) => {
    const direct=document.createElement("div");access.mount(direct,"link:"+link.id,{asin:link.asin||link.assessment.product?.asin,listingIds:[link.listingId]});$("#linkRows").children[index].firstElementChild.append(direct);
    const review=document.createElement("a");review.href=`/?view=planning#plan=link:${encodeURIComponent(link.id)}`;review.textContent="販売の見直しへ追加";review.className="planning-entry-link";review.style.display="block";review.target='_blank';review.rel='noopener noreferrer';review.title='別タブで開く';
    $("#linkRows").children[index].lastElementChild.append(review);
    const asin = link.assessment.product?.asin || link.asin;
    const ownStock = (saved.physicalInventory || []).filter((p) => p.linkedLinkIds.includes(link.id) || asin && p.asin === asin);
    if (ownStock.length) {
      const stockLine = document.createElement("a"); stockLine.href = "/?view=stock"; stockLine.className = "physical-inventory-link";
      stockLine.textContent = ownStock.length === 1 ? ownStock[0].locations.map((b) => `${b.locationId === "container" ? "コンテナ" : "自宅・会社"} ${b.usable === null ? "未確認" : b.usable + ownStock[0].unit}`).join(" ／ ") + (ownStock[0].linkedLinkIds.includes(link.id) ? "（関連付け済み）" : "（同ASIN候補・要確認）") : `コンテナ・自社在庫の候補 ${ownStock.length}件を確認`;
      $("#linkRows").children[index].querySelector('[data-label="商品"]').append(stockLine);
    }
    const sales = saved.salesHistory?.products.find((item) => item.linkId === link.id);
    if (saved.config.capabilities?.salesRead) {
      const line = document.createElement("small");
      line.className = "sales-count";
      line.textContent = sales?.status === "complete" ? `追跡後の注文確定：${sales.confirmedQuantity}個（取消除外）` : sales?.status === "untracked" || !sales ? "販売履歴：未追跡" : "注文確定数：未確認・要確認";
      $("#linkRows").children[index].querySelector('[data-label="御社のAmazon"]').append(line);
    }
    const details = $("#linkRows").children[index].querySelector("details");
    for (const row of link.assessment.fbaRows || []) {
      const line = document.createElement("p");
      line.textContent = `在庫内訳：${row.condition || "状態不明"} ／ ${number(row.fulfillableQuantity)} ／ SKU：${row.sellerSku}`;
      details.append(line);
    }
  });
  document.querySelectorAll("[data-unlink]").forEach((button) => button.addEventListener("click", () => action(async () => {
    if (!confirm("この商品の紐付けを解除しますか？ 出品は変更されません。")) return;
    saved = await api(`/links/${encodeURIComponent(button.dataset.unlink)}`, {}, "DELETE"); render(); status("紐付けを解除しました。");
  })));
  document.querySelectorAll("form[data-memo]").forEach((form) => {
    const input = form.elements.memo;
    const label = form.querySelector(".memo-status");
    const display = form.parentElement.querySelector(".memo-display");
    display.querySelector("button").addEventListener("click", () => {display.hidden = true; form.hidden = false; input.focus();});
    form.querySelector(".memo-cancel").addEventListener("click", () => {memoDrafts.delete(form.dataset.memo); render();});
    input.addEventListener("input", () => {memoDrafts.set(form.dataset.memo, input.value); label.textContent = "未保存";});
    form.addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
      const id = form.dataset.memo, memo = input.value;
      label.textContent = "保存中…";
      try {
        saved = await api(`/links/${encodeURIComponent(id)}/memo`, {memo});
        if (input.value === memo) {memoDrafts.delete(id); label.textContent = "保存済み"; display.querySelector(".memo-text").textContent = memo || "メモなし"; display.hidden = false; form.hidden = true;}
        else {memoDrafts.set(id, input.value); label.textContent = "未保存";}
        status("メモを保存しました。出品内容・在庫・紐付けの判定は変更していません。");
      } catch (error) {label.textContent = "保存できませんでした"; throw error;}
    });});
  });
  document.querySelectorAll("[data-product-preview]").forEach((button) => button.addEventListener("click", () => action(() => fetchProductPreview(button.dataset.productPreview))));
  document.querySelectorAll(".linked-product img").forEach((img) => img.addEventListener("error", () => {img.hidden = true;}));
  catalog.update($("#linkRows"),data.links.map((link,index)=>{
    const a=link.assessment,p=a.product,y=a.listing,age=Date.now()-Date.parse(p?.checkedAt);
    const known=Number.isFinite(age)&&age>=-60000&&age<=90*60000&&!p?.error&&a.inventory!=="unlinked"&&typeof p?.fulfillableQuantity==="number";
    const live=currentMode==="saved"?access.info("link:"+link.id).live:null;const qty=live?(live.availability?.fba||live.fba)?.quantity??null:known?p.fulfillableQuantity:null;
    const sales=saved.salesHistory?.products.find(s=>s.linkId===link.id),photo=$("#linkRows").children[index].querySelector(".linked-product img");
    return {node:$("#linkRows").children[index],id:link.id,title:y?.title||(p?.title!==p?.asin?p?.title:"")||link.previousListingTitle||p?.asin||"商品名未取得",imageUrl:photo?.src,imageLabel:photo?.alt||"出品画像",
      badges:[link.asin||p?.asin||"ASINを登録"],renderAccess:currentMode==="saved"?host=>access.mount(host,"link:"+link.id,{asin:link.asin||p?.asin,listingIds:[link.listingId]}):undefined,metrics:currentMode==="saved"?[]:[{label:"Amazon FBA在庫",value:qty??"未確認",unit:"個"}],
      status:"",measure:qty,registeredAt:link.createdAt};
  }));
  const events = [...data.events].reverse();
  const selected = $("#eventSelect").value;
  $("#eventSelect").innerHTML = events.length ? events.map((event) => `<option value="${event.id}">${escape(event.title)} ／ ${date(event.at)} ／ ${event.delivery.status === "test_failed" ? "模擬送信失敗" : event.delivery.status === "test_sent" ? "模擬送信成功" : deliveryLabels[event.delivery.status] || "未送信"}</option>`).join("") : '<option value="">通知はありません</option>';
  if (events.some((event) => event.id === selected)) $("#eventSelect").value = selected;
  $("#eventCount").textContent = `${events.length}件・送信受付${events.filter((event) => event.delivery.status === "smtp_accepted").length}件`;
  const showEmail = () => {
    const event = events.find((item) => item.id === $("#eventSelect").value);
    const email = $("#emailPreview");
    email.replaceChildren();
    if (event) {
      const preview = event.preview;
      const p = event.assessment.product, y = event.assessment.listing;
      const currentListing = data.listings.find((item) => item.listingId === y?.listingId);
      email.innerHTML = `<p class="email-unsent">${escape(deliveryLabels[event.delivery.status] || "確認用・未送信")}</p>${productPreview(currentListing || y, p)}
        <div class="notification-pair"><a href="https://www.amazon.co.jp/dp/${escape(p?.asin || "")}" target="_blank" rel="noreferrer">Amazon：${escape(p?.asin || "不明")}</a><span aria-hidden="true">↔</span><a href="${escape(y?.url || "#")}" target="_blank" rel="noreferrer">ヤフオク：${escape(y?.listingId || "不明")}</a></div>
        <p class="email-message">${escape(preview.message)}</p><p class="email-action"><strong>必要な対応</strong><br>${escape(preview.action)}</p>
        <details class="email-details"><summary>補足情報</summary><pre></pre></details>`;
      email.querySelector("pre").textContent = event.text;
      email.querySelector(".linked-product img")?.addEventListener("error", (event) => {event.target.hidden = true;});
      if (event.delivery.status === "test_failed") {
        const error = document.createElement("p");
        error.className = "email-delivery-error";
        error.textContent = `模擬送信エラー: ${event.delivery.error} / 試行回数: ${event.delivery.attempts}`;
        email.prepend(error);
      }
    } else email.textContent = "まだ通知はありません。";
    const links = $("#previewLinks");
    links.hidden = true;
    links.replaceChildren();
    if (!links.hidden) {
      const urls = [["Amazonの商品を確認", `https://www.amazon.co.jp/dp/${event.assessment.product.asin}`], ["ヤフオクの出品を確認", event.assessment.listing.url]];
      for (const [label, href] of urls) {const anchor = document.createElement("a"); anchor.textContent = label; anchor.href = href; anchor.target = "_blank"; anchor.rel = "noreferrer"; links.append(anchor);}
    }
  };
  $("#eventSelect").onchange = showEmail; showEmail();
  $("#monitorLogs").innerHTML = data.logs.length ? data.logs.slice(-30).reverse().map((log) => `<li>${date(log.at)} ${escape(log.kind)} ${escape(log.message || "")}</li>`).join("") : "<li>履歴はありません。</li>";
  renderReviews();
  applyCapabilities();
}
function renderSales() {
  if (!$("#salesSection") || !saved?.config.capabilities?.salesRead) return;
  const sales = saved.salesHistory;
  if($("#salesTargetSummary"))$("#salesTargetSummary").innerHTML=(sales?.unresolved || []).map(item=>`<p class="error">${escape(item.title || item.asin)}：${escape(item.reason)}（登録した新品・中古と自社出品の状態を確認してください）</p>`).join("")+(sales?.trackedProducts || []).map(item=>`<p><strong>${escape(item.title)}</strong><br>${escape(item.asin)} ／ ${escape(item.sellerSku)}<br>追跡期間の注文確定：${number(item.confirmedQuantity)} ／ 保留：${number(item.pendingQuantity)}</p>`).join("");
  const labels = {not_started: "販売追跡：未開始", idle: "販売追跡：開始済み・注文未取得", running: "Amazon注文を確認中", complete: "注文確認済み", failed: "注文確認：失敗・販売数は未確認"};
  $("#salesSummary").textContent = `${labels[sales?.status] || "販売履歴：未確認"} ／ ${sales?.automatic?"1日1回の自動確認が有効":"自動通知オフ"}${sales?.error ? ` ／ ${sales.error}` : ""}${sales?.targets?` ／ 追跡 ${new Set(sales.targets.map(t=>t.sellerSku)).size} SKU・自社SKU未確認 ${sales.unresolved.length}件`:""}`;
  $("#salesSummary").classList.toggle("error", sales?.status === "failed");
  const tracked = sales?.products.filter((item) => item.status !== "untracked").length || 0;
  const unresolved = sales?.products.filter((item) => item.status === "unknown").length || 0;
  $("#salesPeriod").textContent = sales?.startedAt ? `追跡 ${tracked}組 ／ 要確認 ${unresolved}組 ／ 開始：${date(sales.startedAt)} ／ 確認済み期間の末尾：${date(sales.checkedThrough)}${sales.catchingUp ? " ／ 期間の確認が追いついていません" : ""}` : "追跡開始前の販売数：不明";
  const groups = new Map();
  for (const event of sales?.events || []) {
    const k = JSON.stringify([event.asin, event.sellerSku]);
    const group = groups.get(k) || {asin: event.asin, sellerSku: event.sellerSku, added: 0, corrected: 0};
    if (event.delta > 0) group.added += event.delta; else group.corrected -= event.delta;
    groups.set(k, group);
  }
  $("#salesPreview").innerHTML = groups.size ? [...groups.values()].map((group) => {
    const links = sales.products.filter((item) => item.asin === group.asin && item.sellerSku === group.sellerSku).map((item) => saved.links.find((link) => link.id === item.linkId)).filter(Boolean);
    const listing = saved.listings.find((item) => item.listingId === links[0]?.listingId);
    return `<div class="sales-preview-row"><strong>${escape(listing?.title || sales.targets?.find(t=>t.asin===group.asin&&t.sellerSku===group.sellerSku)?.title || group.asin)}</strong><p>今回の注文確定：${group.added}個 ／ 取消・訂正：${group.corrected}個</p><p><a href="https://www.amazon.co.jp/dp/${escape(group.asin)}" target="_blank" rel="noreferrer">ASIN：${escape(group.asin)}</a> ${links.map((link) => `<a href="https://auctions.yahoo.co.jp/jp/auction/${escape(link.listingId)}" target="_blank" rel="noreferrer">ヤフオク：${escape(link.listingId)}</a>`).join(" ")}</p><small>今回取得した販売の確認用表示 ／ 送信結果はメール通知欄で確認</small></div>`;
  }).join("") : `<p>${sales?.status === "complete" && !unresolved ? "今回の確認で新しい販売・訂正はありません。メール未送信。" : "今回の販売通知はまだ判定できない商品があります。メール未送信。"}</p>`;
  $("#salesEvents").innerHTML = (sales?.recentEvents || []).map((event) => `<li>${date(event.at)} ／ ${escape(event.asin)} ／ ${event.delta > 0 ? `注文確定 +${event.delta}個` : `取消・訂正 ${event.delta}個`} ／ ${escape(({historical:"過去期間の補完・通知対象外",muted:"この種類は通知オフ",queued:"通知待ち",preview:"プレビュー・未送信",...deliveryLabels})[event.delivery] || event.delivery)}</li>`).join("");
}
$("#salesStart")?.addEventListener("click", () => action(async () => {
  saved = await api("/sales/start", {}); render(); status("販売追跡の開始時刻を保存しました。過去の販売数は遡って推定しません。注文確認は2分ほど後から利用できます。");
}));
$("#salesCheck")?.addEventListener("click", () => action(async () => {
  status("Amazon注文を確認しています。メール・在庫変更は行いません。");
  try {saved = await api("/sales/check", {}); render(); status(saved.salesHistory.status === "complete" ? "販売履歴と通知プレビューを更新しました。実メールは送信していません。" : saved.salesHistory.error, saved.salesHistory.status !== "complete");}
  catch (error) {saved = await api(); render(); throw error;}
}));
function renderReviews() {
  if (!saved) return;
  $("#previousLink").innerHTML = '<option value="">選択してください</option>' + saved.links.map((link) => `<option value="${escape(link.id)}">${escape(link.asin || saved.catalog.find((p) => p.id === link.catalogId)?.sellerSku)} ／ ${escape(link.listingId)}</option>`).join("");
  $("#successorListing").innerHTML = '<option value="">選択してください</option>' + saved.listings.map((item) => `<option value="${escape(item.listingId)}">${escape(item.title)} ／ ${escape(item.listingId)}</option>`).join("");
  $("#listingReview").innerHTML = saved.listings.map((listing) => {
    const linked = saved.links.some((link) => link.listingId === listing.listingId);
    const candidates = new Set(listing.candidates.map((item) => item.catalogId));
    const options = [...saved.catalog].sort((a, b) => Number(candidates.has(b.id)) - Number(candidates.has(a.id)));
    const asins = [...new Set(listing.references.filter((ref) => ref.kind === "asin").map((ref) => ref.value))];
    return `<article class="review-listing"><h3>${escape(listing.title)}</h3><p class="meta">${escape(listing.listingId)} ／ 出品者：${escape(listing.seller || "不明")}</p>
      <p class="review-reference">管理番号：${listing.references.length ? listing.references.map((ref) => escape(ref.value)).join(" ／ ") : "なし・手動で照合"} ／ 候補 ${listing.candidates.length}件</p>
      ${linked ? '<span class="monitor-pill available">紐付け登録済み</span>' : `<form data-asin-listing-id="${escape(listing.listingId)}">
      <label>AmazonのASIN<input name="asin" required pattern="[A-Za-z0-9]{10}" minlength="10" maxlength="10" value="${escape(asins.length === 1 ? asins[0] : "")}" placeholder="例：B0176E86U8" autocomplete="off"></label>
      <div class="monitor-grid"><label>1出品に必要な在庫数<input name="unitsPerListing" type="number" min="1" step="1" value="1" required></label><label>確認メモ<input name="reviewNote" placeholder="管理番号と異なるASINの場合は根拠必須"></label></div>
      <label class="monitor-check"><input name="reviewed" type="checkbox" required>自分の出品で、ASINの商品・状態・付属品・セット内容が一致することを確認しました</label>
      <button type="submit">ASINで紐付ける</button></form>
      <details class="manual-entry sku-link"><summary>詳細設定：在庫データの商品を指定</summary><form data-listing-id="${escape(listing.listingId)}">
      <label>対応するAmazon商品<select name="catalogId" required><option value="">SKU・状態・付属品を確認して選択</option>${options.map((product) => `<option value="${escape(product.id)}">${candidates.has(product.id) ? "候補：" : ""}${escape(product.sellerSku)} ／ ${escape(product.title)} ／ ${escape(product.condition || "状態未登録")} ／ ${escape(product.setContents || "付属品未登録")}</option>`).join("")}</select></label>
      <div class="monitor-grid"><label>1出品に必要な在庫数<input name="unitsPerListing" type="number" min="1" step="1" value="1" required></label><label>確認メモ<input name="reviewNote" placeholder="ASINが異なる場合は根拠必須"></label></div>
      <label class="monitor-check"><input name="reviewed" type="checkbox" required>自分の出品で、SKU・状態・付属品・セット内容が一致することを確認しました</label>
      <button type="submit">この組み合わせで紐付ける</button></form></details>`}</article>`;
  }).join("");
  document.querySelectorAll("form[data-asin-listing-id]").forEach((form) => form.addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
    const data = Object.fromEntries(new FormData(form));
    saved = await api("/asin-links", {...data, unitsPerListing: Number(data.unitsPerListing), listingId: form.dataset.asinListingId, reviewed: form.querySelector('[name="reviewed"]').checked});
    render(); scheduleMailPoll(); status("ASINで紐付けを登録しました。在庫数は別途確認してください。");
  });}));
  document.querySelectorAll("form[data-listing-id]").forEach((form) => form.addEventListener("submit", (event) => {event.preventDefault(); action(async () => {
    const data = Object.fromEntries(new FormData(form));
    saved = await api("/links", {...data, unitsPerListing: Number(data.unitsPerListing), listingId: form.dataset.listingId, reviewed: form.querySelector('[name="reviewed"]').checked});
    render(); scheduleMailPoll(); status("確認済みの組み合わせを登録しました。");
  });}));
}
await action(async () => {
  saved = await api();
  await access.load();
  const result = await api("/demo", {scenario: "baseline"});
  demo = result.result;
  switchMode("saved");
  const unlinked = saved.listings.filter((item) => !saved.links.some((link) => link.listingId === item.listingId));
  if (unlinked.length === 1) {
    const asins = [...new Set(unlinked[0].references.filter((ref) => ref.kind === "asin").map((ref) => ref.value))];
    if (asins.length === 1) {
      $("#pairAmazon").value = asins[0];
      $("#pairYahoo").value = unlinked[0].url;
    }
  }
  if (saved.fbaJob?.status === "running") await followFbaJob();
  scheduleMailPoll();
});
