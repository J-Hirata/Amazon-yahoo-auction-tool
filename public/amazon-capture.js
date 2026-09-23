(() => {
  const baseUrl = "http://localhost:41731";
  const existing = document.querySelector("#asin-amazon-capture-panel");
  if (existing) existing.remove();

  const product = captureProduct();
  const panel = document.createElement("section");
  panel.id = "asin-amazon-capture-panel";
  panel.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "width:340px",
    "max-height:82vh",
    "overflow:auto",
    "background:#ffffff",
    "color:#202124",
    "border:1px solid #d0d5dd",
    "border-radius:8px",
    "box-shadow:0 12px 32px rgba(15,23,42,.22)",
    "font:14px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "padding:14px"
  ].join(";");

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
      <div>
        <strong style="display:block;font-size:16px">Amazon取込補助</strong>
        <span id="aac-status" style="color:#64748b">${escapeHtml(product.asin || "ASIN未検出")}</span>
      </div>
      <button id="aac-close" style="border:0;background:#e2e8f0;border-radius:6px;padding:6px 8px;cursor:pointer">閉じる</button>
    </div>
    <div style="display:grid;gap:8px;margin-top:12px">
      <label style="display:grid;gap:4px">ASIN
        <input id="aac-asin" value="${escapeAttribute(product.asin)}" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px">
      </label>
      <label style="display:grid;gap:4px">商品名
        <textarea id="aac-title" rows="2" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px">${escapeHtml(product.title)}</textarea>
      </label>
      <label style="display:grid;gap:4px">Amazon中古最安値
        <input id="aac-price" value="${product.usedLowestPrice || ""}" placeholder="例: 3980" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px">
      </label>
      <label style="display:grid;gap:4px">説明
        <textarea id="aac-description" rows="5" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px">${escapeHtml(product.description)}</textarea>
      </label>
      <label style="display:grid;gap:4px">画像URL
        <textarea id="aac-images" rows="4" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px">${escapeHtml(product.imageUrls.join("\n"))}</textarea>
      </label>
      <button id="aac-import" style="border:0;background:#166534;color:#fff;border-radius:6px;padding:10px 12px;cursor:pointer;text-align:left">管理画面へ取り込む</button>
      <p style="margin:0;color:#64748b;line-height:1.5">取り込んだ後、管理画面で価格・説明・画像を確認してください。</p>
    </div>
  `;

  document.body.appendChild(panel);
  const status = panel.querySelector("#aac-status");
  panel.querySelector("#aac-close").addEventListener("click", () => panel.remove());
  panel.querySelector("#aac-import").addEventListener("click", async () => {
    const payload = {
      asin: panel.querySelector("#aac-asin").value,
      title: panel.querySelector("#aac-title").value,
      usedLowestPrice: panel.querySelector("#aac-price").value,
      description: panel.querySelector("#aac-description").value,
      imageUrls: panel.querySelector("#aac-images").value.split(/\r?\n/).filter(Boolean),
      amazonUrl: location.href
    };

    status.textContent = "取り込み中です";
    const response = await fetch(`${baseUrl}/api/import-amazon-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    status.textContent = response.ok ? "取り込みました" : result.error || "取り込みに失敗しました";
  });

  function captureProduct() {
    const asin = findAsin();
    const title = text("#productTitle") || meta("og:title") || document.title.replace(/Amazon\\.co\\.jp\\s*:\\s*/i, "").trim();
    const price = parsePrice(text(".a-price .a-offscreen") || text("#priceblock_ourprice") || text("#priceblock_dealprice"));
    const featureLines = texts("#feature-bullets li span.a-list-item")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line && !line.includes("詳細はこちら"));
    const description = [
      featureLines.join("\n"),
      text("#productDescription")
    ].filter(Boolean).join("\n\n");
    const imageUrls = unique([
      meta("og:image"),
      attr("#landingImage", "src"),
      ...[...document.querySelectorAll("#altImages img, img.a-dynamic-image")]
        .map((img) => img.currentSrc || img.src)
    ]).filter((url) => /^https?:\/\//.test(url));

    return {
      asin,
      title,
      usedLowestPrice: price,
      description,
      imageUrls
    };
  }

  function findAsin() {
    const candidates = [
      location.pathname,
      document.querySelector("[name='ASIN']")?.value,
      document.querySelector("[data-asin]")?.getAttribute("data-asin")
    ].filter(Boolean).join(" ");
    const match = candidates.toUpperCase().match(/[A-Z0-9]{10}/);
    return match ? match[0] : "";
  }

  function text(selector) {
    return document.querySelector(selector)?.textContent?.trim() || "";
  }

  function texts(selector) {
    return [...document.querySelectorAll(selector)].map((el) => el.textContent || "");
  }

  function attr(selector, name) {
    return document.querySelector(selector)?.getAttribute(name) || "";
  }

  function meta(property) {
    return document.querySelector(`meta[property="${property}"], meta[name="${property}"]`)?.getAttribute("content") || "";
  }

  function parsePrice(value) {
    const match = String(value || "").replace(/,/g, "").match(/\d+/);
    return match ? Number(match[0]) : "";
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
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

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
