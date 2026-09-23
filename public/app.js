const state = { items: [], queue: { active: [], waiting: [] }, priceReviews: [], config: null, selectedAsin: null };
const yahooBookmarkletCode = "javascript:(()=>{const s=document.createElement('script');s.src='http://localhost:41731/yahoo-fill.js?'+Date.now();document.body.appendChild(s);})();";

document.querySelector("#extensionSelected").addEventListener("click", () => openWithExtension(state.selectedAsin));
document.querySelector("#extensionNext").addEventListener("click", () => openWithExtension(state.queue.active[0]?.asin));
document.addEventListener("asin-yahoo-result", (event) => {
  showTextStatus(event.detail?.ok ? "Yahoo出品ページを開きました。ASIN下書きから商品を確認して「まとめて入力」を押してください。" : event.detail?.error || "出品ページを開けませんでした。");
});

function openWithExtension(asin) {
  if (!asin) return showTextStatus("下書き候補の商品を選んでください。");
  if (document.documentElement.dataset.asinYahooExtension !== "ready") {
    showTextStatus("Chrome拡張を登録してから管理画面を再読み込みしてください。「Chrome拡張の登録方法」から手順を確認できます。");
    return;
  }
  showTextStatus("選択した商品をYahoo出品ページへ引き継いでいます。");
  document.dispatchEvent(new CustomEvent("asin-yahoo-open", {detail: {asin}}));
}

document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#nextDraft").addEventListener("click", openNextDraft);
document.querySelector("#closeDraft").addEventListener("click", () => {
  document.querySelector("#draftPanel").hidden = true;
});
document.querySelector("#copyTitle").addEventListener("click", () => copyField("#draftName"));
document.querySelector("#copyPrice").addEventListener("click", () => copyField("#draftPrice"));
document.querySelector("#copyText").addEventListener("click", () => copyField("#draftText"));
document.querySelector("#copyImages").addEventListener("click", () => copyField("#draftImages"));
document.querySelector("#markDraftSaved").addEventListener("click", () => markSelected("draft_saved"));
document.querySelector("#markListed").addEventListener("click", () => markSelected("listed"));
document.querySelector("#copyYahooBookmarklet").addEventListener("click", copyYahooBookmarklet);
document.querySelector("#copyYahooBookmarkletDraft").addEventListener("click", copyYahooBookmarklet);
document.querySelector("#add").addEventListener("click", async () => {
  const asins = document.querySelector("#asins").value;
  await fetch("/api/asins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asins })
  });
  document.querySelector("#asins").value = "";
  await load();
});
document.querySelector("#fetchProducts").addEventListener("click", async () => {
  const asins = document.querySelector("#asins").value;
  showTextStatus("Amazon情報を取得しています。少し待ってください。");
  const res = await fetch("/api/fetch-product-data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asins })
  });
  const payload = await res.json();
  showStatus(payload.results);
  await load();
});

await load();

async function load() {
  const res = await fetch("/api/items");
  Object.assign(state, await res.json());
  render();
}

function showTextStatus(message) {
  document.querySelector("#status").textContent = message;
}

function showStatus(results = []) {
  if (!results.length) {
    showTextStatus("取得対象はありません。");
    return;
  }
  const ok = results.filter((result) => result.ok).length;
  const failed = results.length - ok;
  const message = results.find((result) => !result.ok)?.message || results.find((result) => result.message)?.message || "";
  showTextStatus(`取得完了: 成功 ${ok}件 / 要確認 ${failed}件 ${message}`);
}

function render() {
  const { active, waiting } = state.queue;
  syncYahooLinks();
  syncYahooLaunchBanner(active);
  const columns = document.querySelector(".columns");
  const waitingColumn = document.querySelector("#waitingColumn");
  const hasWaiting = waiting.length > 0;
  columns.classList.toggle("no-waiting", !hasWaiting);
  waitingColumn.hidden = !hasWaiting;
  document.querySelector("#summary").innerHTML = `
    <div><strong>${active.length}</strong><span>下書き候補</span></div>
    <div><strong>${waiting.length}</strong><span>待機・要確認</span></div>
    <div><strong>${state.priceReviews.length}</strong><span>値下げ確認</span></div>
    <div><strong>${state.items.length}</strong><span>総登録数</span></div>
  `;
  renderList("#active", active, true);
  renderList("#waiting", waiting, false);
  renderHistory();
}

function syncYahooLaunchBanner(active) {
  const banner = document.querySelector("#yahooLaunchBanner");
  const count = document.querySelector("#yahooLaunchCount");
  if (!banner || !count) return;
  banner.hidden = active.length === 0;
  count.textContent = `${active.length}件の下書き候補`;
}

function renderList(selector, items, compact) {
  const root = document.querySelector(selector);
  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = `<p class="empty">対象はありません。</p>`;
    return;
  }
  for (const item of items) root.appendChild(card(item, compact));
}

function card(item, compact) {
  const el = document.createElement("article");
  el.className = `item ${compact ? "compact-item" : ""}`;
  el.innerHTML = `
    <div class="item-head">
      <div>
        <strong>${escapeHtml(item.title || item.asin)}</strong>
        <a href="${item.amazonUrl}" target="_blank" rel="noreferrer">${item.asin}</a>
      </div>
      <span class="status-pill">${statusLabel(item.status)}</span>
    </div>
    <div class="prices">
      <span>初回: ${yen(item.startPrice)}</span>
      <span>7日後: ${yen(item.stalePrice)}</span>
    </div>
    <p class="meta">中古最安値: ${yen(item.usedLowestPrice)} / 東京都から発送 / 送料込み / 発送目安 ${item.shipAfterDaysMin}-${item.shipAfterDaysMax}日</p>
    ${compact ? "" : detailEditor(item)}
    ${reviewBadge(item)}
    <div class="actions">
      <button type="button" data-action="draft">下書き文面</button>
      <button type="button" data-action="saved">下書き保存済み</button>
      <button type="button" data-action="delete" class="danger">削除</button>
      <a href="${item.amazonUrl}" target="_blank" rel="noreferrer">Amazon</a>
      <a href="${buildYahooMarketUrl(item)}" target="_blank" rel="noreferrer" title="キーワード: ${escapeAttribute(buildYahooMarketKeyword(item))}">ヤフオク</a>
    </div>
  `;

  el.querySelector("[data-action='draft']").addEventListener("click", async () => openDraft(item.asin));
  el.querySelector("[data-action='saved']").addEventListener("click", async () => patchItem(item.asin, { status: "draft_saved" }));
  el.querySelector("[data-action='delete']").addEventListener("click", async () => deleteItem(item.asin));
  el.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", async () => {
      await patchItem(item.asin, { [input.dataset.field]: input.value });
    });
  });

  return el;
}

function renderHistory() {
  const root = document.querySelector("#recentHistory");
  if (!root) return;
  const items = [...state.items]
    .filter((item) => item.draftSavedAt)
    .sort((a, b) => timestamp(b.draftSavedAt) - timestamp(a.draftSavedAt))
    .slice(0, 20);
  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = `<p class="empty">Yahooへ貼り付け完了した商品はまだありません。</p>`;
    return;
  }
  for (const item of items) root.appendChild(historyCard(item));
}

function historyCard(item) {
  const el = document.createElement("article");
  el.className = "item history-item";
  el.innerHTML = `
    <div>
      <strong>${escapeHtml(item.title || item.asin)}</strong>
      <p class="meta">${escapeHtml(item.asin)} / 貼り付け完了 / ${formatDate(item.draftSavedAt)}</p>
    </div>
    <div class="history-actions">
      <button type="button" data-action="draft">下書き文面</button>
      <button type="button" data-action="restore">下書き候補に戻す</button>
      <a href="${item.amazonUrl}" target="_blank" rel="noreferrer">Amazon</a>
    </div>
  `;
  el.querySelector("[data-action='draft']").addEventListener("click", async () => openDraft(item.asin));
  el.querySelector("[data-action='restore']").addEventListener("click", async () => {
    await patchItem(item.asin, { status: "ready_for_draft", draftSavedAt: null });
    showTextStatus(`${item.asin} を下書き候補に戻しました。`);
  });
  return el;
}

function timestamp(value) {
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

function formatDate(value) {
  const time = timestamp(value);
  if (!time) return "日時未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(time));
}

function detailEditor(item) {
  return `
    <div class="edit-grid">
      <label>商品名
        <input data-field="title" value="${escapeAttribute(item.title || "")}" placeholder="Amazonの商品名">
      </label>
      <label>Amazon中古最安値
        <input data-field="usedLowestPrice" type="number" min="1" value="${item.usedLowestPrice ?? ""}" placeholder="例: 3980">
      </label>
    </div>
    <label>仕様・サイズ・重さなど
      <textarea data-field="description" rows="3" placeholder="ヤフオク説明に使う仕様情報">${escapeHtml(item.description || "")}</textarea>
    </label>
    <label>画像URL
      <textarea data-field="imageUrls" rows="2" placeholder="1行に1URL">${escapeHtml((item.imageUrls || []).join("\n"))}</textarea>
    </label>
  `;
}

function statusLabel(status) {
  return {
    waiting_for_product_data: "情報待ち",
    ready_for_draft: "下書きOK",
    draft_saved: "下書き保存済み",
    listed: "出品済み",
    sold: "売却済み",
    archived: "除外"
  }[status] || status;
}

function reviewBadge(item) {
  if (!state.priceReviews.some((review) => review.asin === item.asin)) return "";
  return `<p class="review">7日経過: ${yen(item.stalePrice)}への値下げを確認</p>`;
}

async function openNextDraft() {
  const res = await fetch("/api/next-draft");
  const { item } = await res.json();
  if (!item) {
    showTextStatus("下書き候補はありません。");
    return;
  }
  await openDraft(item.asin);
}

async function openDraft(asin) {
  const res = await fetch(`/api/items/${encodeURIComponent(asin)}/draft`);
  const { draft } = await res.json();
  state.selectedAsin = asin;
  document.querySelector("#draftTitle").textContent = `${draft.asin} / ${yen(draft.price)}`;
  document.querySelector("#draftName").value = draft.title;
  document.querySelector("#draftPrice").value = draft.price || "";
  document.querySelector("#draftImages").value = draft.imageUrls.join("\n");
  document.querySelector("#draftText").value = draft.description;
  document.querySelector("#openYahoo").href = state.config?.yahooSellerUrl || "https://auctions.yahoo.co.jp/seller/";
  document.querySelector("#draftPanel").hidden = false;
  document.querySelector("#draftName").focus();
}

function syncYahooLinks() {
  const yahooUrl = state.config?.yahooSellerUrl || "https://auctions.yahoo.co.jp/seller/";
  document.querySelector("#openYahooWorkflow").href = yahooUrl;
  document.querySelector("#openYahoo").href = yahooUrl;
  const launchButton = document.querySelector("#yahooLaunchButton");
  if (launchButton) launchButton.href = yahooUrl;
}

async function markSelected(status) {
  if (!state.selectedAsin) return;
  await patchItem(state.selectedAsin, { status });
  if (status === "listed") await openNextDraft();
}

async function copyField(selector) {
  const field = document.querySelector(selector);
  await navigator.clipboard.writeText(field.value);
  showTextStatus("コピーしました。");
}

async function copyYahooBookmarklet() {
  await navigator.clipboard.writeText(yahooBookmarkletCode);
  showTextStatus("41731版のYahoo入力補助ブックマークレットをコピーしました。ブックマークバーへ登録してください。");
}

async function patchItem(asin, patch) {
  await fetch(`/api/items/${encodeURIComponent(asin)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  await load();
}

async function deleteItem(asin) {
  await fetch(`/api/items/${encodeURIComponent(asin)}`, { method: "DELETE" });
  await load();
}

function yen(value) {
  return value ? `${Number(value).toLocaleString("ja-JP")}円` : "未設定";
}

function buildYahooMarketUrl(item) {
  const keyword = buildYahooMarketKeyword(item);
  return `https://auctions.yahoo.co.jp/closedsearch/closedsearch/${encodeURIComponent(keyword)}/0/`;
}

function buildYahooMarketKeyword(item) {
  const title = String(item.title || item.asin || "").trim();
  if (!title) return item.asin || "";
  const normalized = title
    .replace(/[【［\[][^】］\]]*(保証|ほしょう|送料無料|送料込み|中古|新品|未使用)[^】］\]]*[】］\]]/g, " ")
    .replace(/[【】［］\[\]（）()「」『』]/g, " ")
    .replace(/[\/_,.:;|｜+＋・]/g, " ")
    .replace(/[×]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = uniqueTokens(normalized.match(/[A-Za-z0-9][A-Za-z0-9-]{2,}|[一-龥ぁ-んァ-ヶー]{2,}/g) || []);
  const modelIndex = tokens.findIndex(isModelLikeToken);
  if (modelIndex >= 0) return buildModelKeyword(tokens, modelIndex);

  const latinName = buildLatinNameKeyword(tokens);
  if (latinName) return latinName;

  const stopWords = new Set([
    "新品", "中古", "未使用", "美品", "送料無料", "送料込み", "保証", "年保証", "付き", "付", "セット", "用", "対応",
    "大人", "子供", "キッズ", "メンズ", "レディース", "タイプ", "モデル", "サイズ", "カラー", "ブラック", "ホワイト"
  ]);
  const usefulTokens = tokens
    .map((token) => token.replace(/^\d+個$/, "").replace(/\d+年保証$/, ""))
    .filter((token) => token.length >= 2 && !stopWords.has(token))
    .slice(0, 4);
  const keyword = usefulTokens.length ? usefulTokens.join(" ") : normalized;
  return keyword.slice(0, 32).trim() || item.asin || title;
}

function isModelLikeToken(token) {
  if (isSizeLikeToken(token)) return false;
  return /[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 4;
}

function isSizeLikeToken(token) {
  return /^\d+(?:\.\d+)?(?:cm|mm|m|kg|g|ml|l|インチ|型)$/i.test(token)
    || /^\d+(?:\.\d+)?-\d+(?:\.\d+)?(?:cm|mm|m|kg|g|ml|l)$/i.test(token);
}

function buildLatinNameKeyword(tokens) {
  const latinWords = [];
  for (const token of tokens) {
    if (isSizeLikeToken(token) || isModelLikeToken(token)) continue;
    if (/^[A-Za-z]{3,}$/.test(token) && !isGenericLatinWord(token)) latinWords.push(token);
  }
  if (latinWords.length >= 2) return latinWords.slice(0, 4).join(" ");
  return "";
}

function buildModelKeyword(tokens, modelIndex) {
  const model = tokens[modelIndex];
  const prefix = [];
  for (let i = Math.max(0, modelIndex - 3); i < modelIndex; i += 1) {
    const token = tokens[i];
    if (/^[A-Za-z]{3,}$/.test(token) && !isGenericLatinWord(token)) prefix.push(token);
  }
  return [...prefix.slice(-2), model].join(" ");
}

function isGenericLatinWord(token) {
  return new Set(["with", "for", "and", "the", "new", "used", "black", "white", "size", "type", "model", "systems"]).has(token.toLowerCase());
}

function uniqueTokens(tokens) {
  const seen = new Set();
  const result = [];
  for (const token of tokens) {
    const normalized = token.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
