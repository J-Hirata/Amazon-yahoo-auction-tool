const state = { watches: [], summary: {} };

document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#checkNow").addEventListener("click", checkNow);
document.querySelector("#addWatch").addEventListener("click", addWatch);

await load();

async function load() {
  const res = await fetch("/api/stock-watch");
  Object.assign(state, await res.json());
  render();
}

async function addWatch() {
  const asins = document.querySelector("#watchAsins").value;
  const sellerName = document.querySelector("#sellerName").value;
  const res = await fetch("/api/stock-watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asins, sellerName })
  });
  Object.assign(state, await res.json());
  document.querySelector("#watchAsins").value = "";
  showStatus("監視対象に追加しました。");
  render();
}

async function checkNow() {
  showStatus("Amazon側を確認しています。少し待ってください。");
  const res = await fetch("/api/stock-watch/check", { method: "POST" });
  const payload = await res.json();
  Object.assign(state, payload);
  showStatus(`確認しました。要対応 ${payload.summary.needsAttention} 件 / リマインド対象 ${payload.summary.reminders} 件`);
  render();
}

function render() {
  const summary = state.summary || {};
  document.querySelector("#summary").innerHTML = `
    <div><strong>${summary.needsAttention || 0}</strong><span>要対応</span></div>
    <div><strong>${summary.reminders || 0}</strong><span>リマインド対象</span></div>
    <div><strong>${summary.ownStock || 0}</strong><span>自社在庫あり</span></div>
    <div><strong>${summary.watching || 0}</strong><span>FBA監視中</span></div>
  `;

  const root = document.querySelector("#watchList");
  root.innerHTML = "";
  const watches = [...state.watches].sort(sortWatch);
  if (!watches.length) {
    root.innerHTML = `<p class="empty">監視対象はまだありません。</p>`;
    return;
  }
  for (const item of watches) root.appendChild(card(item));
}

function card(item) {
  const el = document.createElement("article");
  el.className = "item";
  el.innerHTML = `
    <div class="item-head">
      <div>
        <strong>${escapeHtml(item.title || item.asin)}</strong>
        <a href="${item.amazonUrl || `https://www.amazon.co.jp/dp/${item.asin}`}" target="_blank" rel="noreferrer">${item.asin}</a>
      </div>
      <span class="status-pill">${statusLabel(item.status)}</span>
    </div>
    <p class="meta">セラー名: ${escapeHtml(item.sellerName || "")} / 監視対象: FBA・Amazon発送のみ</p>
    <p class="${item.status === "needs_attention" ? "review" : "meta"}">${escapeHtml(item.lastCheckMessage || "未確認")}</p>
    <div class="prices">
      <span>最終確認: ${formatDate(item.lastCheckAt)}</span>
      <span>価格: ${yen(item.price)}</span>
      <span>セラー確認: ${item.sellerFound ? "あり" : "未確認"}</span>
      <span>FBA確認: ${item.fbaFound ? "あり" : "未確認"}</span>
      <span>初回検知: ${formatDate(item.firstAlertAt)}</span>
    </div>
    <label>メモ
      <textarea data-field="note" rows="2">${escapeHtml(item.note || "")}</textarea>
    </label>
    <div class="actions">
      <button type="button" data-action="resolved">対応済み</button>
      <button type="button" data-action="own_stock">自社在庫ありとして継続</button>
      <button type="button" data-action="watching">再監視する</button>
      <button type="button" data-action="paused">監視停止</button>
      <button type="button" data-action="reminder">リマインド送信済みにする</button>
      <button type="button" data-action="delete" class="danger">削除</button>
    </div>
  `;

  el.querySelector("[data-field='note']").addEventListener("change", (event) => patchWatch(item.asin, { note: event.target.value }));
  el.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      if (action === "delete") return deleteWatch(item.asin);
      if (action === "reminder") return patchWatch(item.asin, { reminderSent: true });
      return patchWatch(item.asin, { status: action });
    });
  });
  return el;
}

async function patchWatch(asin, patch) {
  const res = await fetch(`/api/stock-watch/${encodeURIComponent(asin)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  Object.assign(state, await res.json());
  render();
}

async function deleteWatch(asin) {
  const res = await fetch(`/api/stock-watch/${encodeURIComponent(asin)}`, { method: "DELETE" });
  Object.assign(state, await res.json());
  render();
}

function sortWatch(a, b) {
  const rank = { needs_attention: 0, own_stock: 1, watching: 2, paused: 3, resolved: 4 };
  return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.lastCheckAt || "").localeCompare(String(a.lastCheckAt || ""));
}

function statusLabel(status) {
  return {
    watching: "FBA監視中",
    needs_attention: "要対応",
    own_stock: "自社在庫あり",
    paused: "監視停止",
    resolved: "対応済み"
  }[status] || status;
}

function showStatus(message) {
  document.querySelector("#status").textContent = message;
}

function formatDate(value) {
  if (!value) return "未確認";
  return new Date(value).toLocaleString("ja-JP");
}

function yen(value) {
  return value ? `${Number(value).toLocaleString("ja-JP")}円` : "未取得";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}
