(() => {
  const baseUrl = "http://localhost:41731";
  const extension = globalThis.asinYahooExtension;
  const fetch = extension?.fetch || globalThis.fetch.bind(globalThis);
  let requestedAsin = extension?.selectedAsin || null;
  const oldPanel = document.querySelector("#asin-yahoo-fill-panel");
  if (oldPanel) oldPanel.remove();

  const panel = document.createElement("section");
  panel.id = "asin-yahoo-fill-panel";
  panel.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "width:min(360px,calc(100vw - 32px))",
    "box-sizing:border-box",
    "max-height:84vh",
    "overflow:auto",
    "background:#fff",
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
        <strong style="display:block;font-size:16px">Yahoo入力補助</strong>
        <span id="ayf-status" style="color:#64748b">下書きを読み込み中です</span>
      </div>
      <button id="ayf-close" style="flex-shrink:0;white-space:nowrap;border:0;background:#e2e8f0;border-radius:6px;padding:6px 8px;cursor:pointer">閉じる</button>
    </div>
    <div id="ayf-body" style="display:grid;gap:8px;margin-top:12px"></div>
  `;
  document.body.appendChild(panel);

  const status = panel.querySelector("#ayf-status");
  const body = panel.querySelector("#ayf-body");
  let draftCandidates = [];
  let draftIndex = Number(sessionStorage.getItem("asinYahooDraftIndex") || "0");
  panel.querySelector("#ayf-close").addEventListener("click", () => panel.remove());

  loadDraft().catch((error) => {
    status.textContent = "読み込みに失敗しました";
    body.textContent = `${error.message}。ASINツールを起動してから、パネルを閉じてもう一度開いてください。`;
  });

  async function loadDraft(nextIndex = draftIndex) {
    const queueResponse = await fetch(`${baseUrl}/api/items`);
    const queuePayload = await queueResponse.json();
    const activeCandidates = queuePayload.queue?.active || [];
    const waitingReadyCandidates = (queuePayload.queue?.waiting || []).filter((item) => item.status === "ready_for_draft");
    draftCandidates = [...activeCandidates, ...waitingReadyCandidates];
    if (requestedAsin) {
      const requested = draftCandidates.findIndex((item) => item.asin === requestedAsin);
      if (requested < 0) throw new Error("選択した商品は下書き候補にありません。管理画面で下書き候補に戻してください");
      nextIndex = requested;
      requestedAsin = null;
    }
    if (!draftCandidates.length) {
      status.textContent = "下書き候補はありません";
      body.innerHTML = utilityLinks();
      return;
    }

    draftIndex = normalizeDraftIndex(nextIndex, draftCandidates.length);
    sessionStorage.setItem("asinYahooDraftIndex", String(draftIndex));
    const currentItem = draftCandidates[draftIndex];
    const response = await fetch(`${baseUrl}/api/items/${encodeURIComponent(currentItem.asin)}/draft`);
    const payload = await response.json();
    const draft = payload.draft;
    if (!draft) {
      status.textContent = "下書きデータを作れませんでした";
      body.innerHTML = utilityLinks();
      return;
    }

    status.textContent = `${draftIndex + 1}/${draftCandidates.length} ${draft.asin} / ${formatYen(draft.price)}`;
    body.innerHTML = `
      <label>商品を選択<select id="ayf-select" style="display:block;width:100%;margin:6px 0;padding:8px">${draftCandidates.map((item, index) => `<option value="${index}" ${index === draftIndex ? "selected" : ""}>${escapeHtml(item.title || item.asin)}</option>`).join("")}</select></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${button("← 前の商品", "prevDraft", true)}
        ${button("次の商品 →", "nextDraft", true)}
      </div>
      <div style="font-weight:700;line-height:1.45">${escapeHtml(draft.title)}</div>
      ${amazonProductLink(draft)}
      ${button("まとめて入力", "fillAll")}
      ${button("説明だけ再入力", "description")}
      ${button("画像をアップロード", "images")}
      ${button("終了日・10%値下げ設定", "options")}
      ${button("型番で製品検索", "productSearch")}
      ${button("商品候補の一番上を選択", "productCandidate")}
      ${button("フォームを空にして入力", "clearAndFill")}
      ${button("カテゴリ選択後に下書き保存", "saveYahooDraft")}
      ${button("入力を記録・空にして次へ", "finishNext")}
      ${button("入力済みとして次へ", "doneNext")}
      ${button("Yahoo保存完了を確認して記録", "saved")}
      ${utilityLinks()}
      <details>
        <summary style="cursor:pointer">内容を確認</summary>
        <textarea readonly style="width:100%;height:180px;margin-top:8px">${escapeHtml(draft.description)}</textarea>
      </details>
      <p style="margin:0;color:#64748b;line-height:1.55">カテゴリはYahoo側で候補から選択してください。次の商品へ行く時は、前の商品データが残っていないか確認してから入力します。</p>
    `;

    const selectDraft = (index) => loadDraft(index).catch((error) => { status.textContent = error.message; });
    body.querySelector("#ayf-select").addEventListener("change", (event) => selectDraft(Number(event.target.value)));
    body.querySelector("[data-action='prevDraft']").addEventListener("click", () => selectDraft(draftIndex - 1));
    body.querySelector("[data-action='nextDraft']").addEventListener("click", () => selectDraft(draftIndex + 1));
    body.querySelector("[data-action='fillAll']").addEventListener("click", async () => {
      if (hasResidualListingData(draft)) {
        status.textContent = "前の商品データが残っている可能性があります。新しい出品ページを開くか「フォームを空にして入力」を押してください";
        return;
      }
      await fillWholeDraft(draft);
      await recordInputCompletion(draft);
    });
    body.querySelector("[data-action='description']").addEventListener("click", () => fillField("description", draft.description));
    body.querySelector("[data-action='images']").addEventListener("click", async () => {
      const count = await uploadImages(draft.imageUrls || []);
      if (count) status.textContent = `画像を${count}枚セットしました`;
      else {
        await navigator.clipboard.writeText((draft.imageUrls || []).join("\n"));
        status.textContent = "画像欄が見つからないため、画像URLをコピーしました";
      }
    });
    body.querySelector("[data-action='options']").addEventListener("click", () => {
      const count = fillAuctionOptions(draft);
      status.textContent = `終了日・値下げ設定を${count}項目入力しました`;
    });
    body.querySelector("[data-action='productSearch']").addEventListener("click", () => {
      const done = fillProductSearch(draft);
      status.textContent = done
        ? "製品検索欄に型番・商品名を入れて検索しました。候補が出たら内容を確認してください"
        : "製品検索欄または検索ボタンが見つかりませんでした";
    });
    body.querySelector("[data-action='productCandidate']").addEventListener("click", () => {
      const clicked = clickFirstProductCandidate(draft);
      status.textContent = clicked
        ? "商品候補の一番上を選択しました。カテゴリが入ったか確認してください"
        : "選択できる商品候補が見つかりませんでした";
    });
    body.querySelector("[data-action='clearAndFill']").addEventListener("click", async () => {
      const cleared = clearListingForm();
      await fillWholeDraft(draft);
      await recordInputCompletion(draft);
      status.textContent += ` / 入力前に${cleared}項目を空にしました。画像枠だけは残っていないか目視確認してください`;
    });
    body.querySelector("[data-action='saveYahooDraft']").addEventListener("click", async () => {
      const categoryIssue = categoryNeedsSelection();
      if (categoryIssue) {
        status.textContent = "カテゴリを選択してから、もう一度押してください";
        focusElement(categoryIssue);
        return;
      }
      const control = findDraftSaveControl();
      if (!control) {
        status.textContent = "Yahoo側の下書き保存ボタンが見つかりません";
        return;
      }
      await markLocalInputDone(draft.asin);
      focusElement(control);
      control.click();
      status.textContent = "Yahooの下書き保存ボタンを押しました。保存完了をYahoo側で確認し、管理画面で記録してください";
    });
    body.querySelector("[data-action='saved']").addEventListener("click", async () => {
      await markLocalDraftSaved(draft.asin);
      status.textContent = "管理画面を下書き保存済みにしました";
    });
    body.querySelector("[data-action='finishNext']").addEventListener("click", async () => {
      await markLocalInputDone(draft.asin);
      const cleared = clearListingForm();
      status.textContent = `この商品を入力済みとして記録し、フォームを${cleared}項目空にしました。次の商品を読み込みます`;
      await loadDraft(draftIndex);
    });
    body.querySelector("[data-action='doneNext']").addEventListener("click", async () => {
      await markLocalInputDone(draft.asin);
      const cleared = clearListingForm();
      status.textContent = `この商品を入力済みとして記録し、フォームを${cleared}項目空にしました。次の商品を読み込みます`;
      await loadDraft(draftIndex);
    });
  }

  function normalizeDraftIndex(index, total) {
    if (!total) return 0;
    if (!Number.isFinite(index)) return 0;
    if (index < 0) return total - 1;
    if (index >= total) return 0;
    return index;
  }

  function button(label, action, secondary = false) {
    const background = secondary ? "#334155" : "#166534";
    return `<button data-action="${action}" style="border:0;background:${background};color:#fff;border-radius:6px;padding:10px 12px;cursor:pointer;text-align:left">${label}</button>`;
  }

  function amazonProductLink(draft) {
    const href = draft.amazonUrl || `https://www.amazon.co.jp/dp/${encodeURIComponent(draft.asin)}`;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer" style="display:block;background:#fff7ed;color:#9a3412;text-decoration:none;border-radius:6px;padding:9px 12px;border:1px solid #fed7aa">Amazon商品ページを確認</a>`;
  }

  function utilityLinks() {
    return `
      <div style="border-top:1px solid #e2e8f0;margin-top:4px;padding-top:10px;display:grid;gap:6px">
        <div style="font-weight:700;color:#334155">管理・登録</div>
        ${linkButton("管理画面を開く", `${baseUrl}/`)}
        ${linkButton("ASIN登録へ戻る", `${baseUrl}/#asin-register`)}
        ${linkButton("Yahoo補助の登録方法", `${baseUrl}/yahoo-helper.html`)}
      </div>
    `;
  }

  function linkButton(label, href) {
    return `<a href="${href}" target="_blank" rel="noreferrer" style="display:block;background:#f1f5f9;color:#0f172a;text-decoration:none;border-radius:6px;padding:9px 12px;border:1px solid #cbd5e1">${label}</a>`;
  }

  function fillAllDraftFields(draft) {
    return [
      fillField("title", draft.title, false),
      fillField("price", String(draft.price || ""), false),
      fillField("description", draft.description || fallbackDescription(draft), false)
    ].filter(Boolean).length;
  }

  async function fillWholeDraft(draft) {
    const filled = fillAllDraftFields(draft);
    const imageCount = await uploadImages(draft.imageUrls || []);
    const optionCount = fillAuctionOptions(draft);
    status.textContent = `${filled}項目入力、画像${imageCount}枚、設定${optionCount}項目。カテゴリはYahoo側で選んでください`;
  }

  async function recordInputCompletion(draft) {
    await markLocalInputDone(draft.asin);
    status.textContent += " / 入力済みとして記録しました。Yahoo側の保存・出品完了はまだ記録していません";
  }

  function hasResidualListingData(draft) {
    const titleField = findBestField("title");
    const priceField = findBestField("price");
    const descriptionField = findBestField("description");
    const categoryField = findCategoryField();
    const values = [titleField, priceField, descriptionField, categoryField]
      .filter(Boolean)
      .map((field) => currentValue(field).trim())
      .filter(Boolean);
    if (!values.length) return false;

    const titleValue = titleField ? currentValue(titleField).trim() : "";
    if (titleValue && sameProductTitle(titleValue, draft.title)) return false;
    return true;
  }

  function sameProductTitle(currentTitle, nextTitle) {
    const words = importantWords(nextTitle);
    if (!words.length) return false;
    return words.slice(0, 4).some((word) => currentTitle.includes(word));
  }

  function clearListingForm() {
    const fields = [
      findBestField("title"),
      findBestField("price"),
      findBestField("description"),
      findCategoryField()
    ].filter(Boolean);
    const uniqueFields = [...new Set(fields)];
    for (const field of uniqueFields) setValue(field, "");

    for (const input of allDocuments().flatMap((doc) => [...doc.querySelectorAll("input[type='file']")])) {
      try {
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {
        // Some browser-controlled file inputs cannot be cleared.
      }
    }
    return uniqueFields.length;
  }

  function findCategoryField() {
    return allTextFields().find((field) => isCategoryText(directFieldText(field).toLowerCase())) || null;
  }

  function fillField(kind, value, announce = true) {
    const field = findBestField(kind);
    const nextValue = kind === "description" ? formatDescriptionForYahoo(value || "") : value || "";
    if (!field) {
      navigator.clipboard.writeText(nextValue);
      if (announce) status.textContent = "入力欄が見つからないため、内容をクリップボードにコピーしました";
      return false;
    }
    setValue(field, nextValue);
    focusElement(field);
    if (announce) status.textContent = "入力しました。内容を確認してください";
    return true;
  }

  function formatDescriptionForYahoo(value) {
    return String(value || "")
      .replace(/\r?\n/g, "\r\n")
      .replace(/(。)\s+(【)/g, "$1\r\n\r\n$2")
      .replace(/\s+(【[^】]+】)/g, "\r\n\r\n$1")
      .replace(/\s+(・)/g, "\r\n$1")
      .replace(/(ください。)\s+(気になる点)/g, "$1\r\n$2")
      .replace(/(負担)\s+(発送目安)/g, "$1\r\n$2")
      .replace(/(ASIN:\s*[A-Z0-9]{10})\s+/g, "$1\r\n\r\n")
      .replace(/\r\n{3,}/g, "\r\n\r\n")
      .trim();
  }

  function findBestField(kind) {
    if (kind === "description") return findDescriptionField();

    const fields = allTextFields().filter((field) => allowedForKind(field, kind));
    let best = null;
    let bestScore = 0;
    for (const field of fields) {
      const haystack = fieldText(field).toLowerCase();
      let score = keywordScore(kind, haystack);
      if (kind === "price" && field.getAttribute?.("type") === "number") score += 8;
      if (score > bestScore) {
        best = field;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function findDescriptionField() {
    const candidates = allDocuments()
      .flatMap((doc) => [...doc.querySelectorAll("textarea, [contenteditable='true'], iframe")])
      .flatMap((field) => iframeEditableBody(field) || [field])
      .filter((field) => !field.disabled && !field.readOnly && isVisible(field) && !panel.contains(field))
      .filter((field) => !isCategoryText(directFieldText(field).toLowerCase()));

    let best = null;
    let bestScore = 0;
    for (const field of candidates) {
      const haystack = fieldText(field).toLowerCase();
      let score = area(field) / 1000;
      if (containsAny(haystack, ["説明", "商品説明", "商品の特徴", "使用感", "魅力", "comment", "description"])) score += 120;
      if (field.tagName === "TEXTAREA") score += 50;
      if (field.isContentEditable || field.tagName === "BODY") score += 45;
      if (score > bestScore) {
        best = field;
        bestScore = score;
      }
    }
    return best || null;
  }

  function keywordScore(kind, haystack) {
    const keywords = {
      title: ["タイトル", "商品名", "品名", "オークションタイトル", "title", "name"],
      price: ["価格", "開始価格", "即決価格", "販売価格", "落札価格", "price"]
    }[kind] || [];
    return keywords.reduce((score, keyword) => haystack.includes(keyword.toLowerCase()) ? score + keyword.length : score, 0);
  }

  function allowedForKind(field, kind) {
    const haystack = directFieldText(field).toLowerCase();
    if (isCategoryText(haystack)) return false;
    if (kind === "price") return field.tagName === "INPUT" && field.getAttribute("type") !== "file";
    if (kind === "title") return field.tagName === "INPUT" || field.tagName === "TEXTAREA";
    return true;
  }

  function allTextFields() {
    return allDocuments().flatMap((doc) => [...doc.querySelectorAll("input:not([type=hidden]), textarea, [contenteditable='true']")])
      .filter((field) => !field.disabled && !field.readOnly && isVisible(field))
      .filter((field) => !panel.contains(field));
  }

  function allDocuments() {
    const docs = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        // Cross-origin frames cannot be inspected.
      }
    }
    return docs;
  }

  function iframeEditableBody(field) {
    if (field.tagName !== "IFRAME") return null;
    try {
      const body = field.contentDocument?.body;
      return body ? [body] : [];
    } catch {
      return [];
    }
  }

  async function uploadImages(imageUrls) {
    const uniqueUrls = uniqueImages(imageUrls).slice(0, 10);
    const input = allDocuments().flatMap((doc) => [...doc.querySelectorAll("input[type='file']")])
      .find((field) => !field.disabled && isVisibleOrLikelyUpload(field) && acceptsImage(field));
    if (!input || !uniqueUrls.length || typeof DataTransfer === "undefined") return 0;

    const transfer = new DataTransfer();
    for (const [index, imageUrl] of uniqueUrls.entries()) {
      try {
        const response = await fetch(`${baseUrl}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`);
        if (!response.ok) continue;
        const blob = await response.blob();
        const ext = extensionFromType(blob.type) || "jpg";
        transfer.items.add(new File([blob], `amazon-${index + 1}.${ext}`, { type: blob.type || "image/jpeg" }));
      } catch {
        // Image upload is best effort.
      }
    }
    if (!transfer.files.length) return 0;
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return transfer.files.length;
  }

  function fillAuctionOptions(draft) {
    let count = 0;
    const days = Number(draft.auctionDays || 5);
    const endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const month = endDate.getMonth() + 1;
    const day = endDate.getDate();
    const ymd = `${endDate.getFullYear()}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
    const jpDate = `${month}月${day}日`;

    if (fillEndDateControl(ymd, jpDate, String(days))) count++;
    if (fillAutoRelistCount()) count++;
    if (fillAutoDiscountControl(String(Math.round((draft.autoDiscountRate || 0.1) * 100)))) count++;
    return count;
  }

  function fillEndDateControl(ymd, jpDate, days) {
    const controls = visibleControls();
    const dateSelects = controls.filter((control) => control.tagName === "SELECT")
      .filter((control) => [...control.options].some(isDateOption));

    for (const select of dateSelects) {
      if (selectDateOption(select, jpDate, ymd)) return true;
    }

    const durationControls = controls.filter((control) => fieldText(control).includes("期間"));
    for (const control of durationControls) {
      if (control.tagName === "SELECT" && selectOptionLike(control, [`${days}日`, days])) return true;
      setValue(control, days);
      return true;
    }
    return false;
  }

  function isDateOption(option) {
    const text = `${option.textContent || ""} ${option.value || ""}`;
    return /\d{1,2}\s*月\s*\d{1,2}\s*日/.test(text) || /\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(text);
  }

  function selectDateOption(select, jpDate, ymd) {
    const normalizedJp = compactDate(jpDate);
    const normalizedYmd = compactDate(ymd);
    const option = [...select.options].find((opt) => {
      const text = compactDate(`${opt.textContent || ""} ${opt.value || ""}`);
      return text.includes(normalizedJp) || text.includes(normalizedYmd);
    });
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function compactDate(value) {
    return String(value || "")
      .replace(/[年月./-]/g, "")
      .replace(/日.*/g, "")
      .replace(/\s+/g, "");
  }

  function fillAutoRelistCount() {
    const control = bestControl(["自動再出品", "再出品"], ["値下げ", "値下"]);
    if (!control) return false;
    if (control.tagName === "SELECT") return selectOptionLike(control, ["3回", "3"]);
    setValue(control, "3");
    return true;
  }

  function fillAutoDiscountControl(percent) {
    const control = bestControl(["自動で値下げ", "値下げ", "値下げ率"]);
    if (!control) return false;
    if (control.tagName === "SELECT") return selectOptionLike(control, [`${percent}%`, percent]);
    setValue(control, percent);
    return true;
  }

  function fillProductSearch(draft) {
    const searchText = draft.categorySearchText || extractModelNumber(draft.title) || draft.title || draft.asin;
    const input = findProductSearchInput();
    if (!input) return false;
    setValue(input, searchText);
    focusElement(input);
    const button = findNearbySearchButton(input) || findSearchButton();
    if (button) button.click();
    return true;
  }

  function findProductSearchInput() {
    const fields = allTextFields()
      .filter((field) => field.tagName === "INPUT")
      .filter((field) => {
        const text = fieldText(field);
        return containsAny(text, ["商品名", "メーカー", "型番", "品番", "製品", "検索"]);
      })
      .filter((field) => !isCategoryText(directFieldText(field).toLowerCase()))
      .sort((a, b) => productSearchScore(b) - productSearchScore(a));
    return fields[0] || null;
  }

  function productSearchScore(field) {
    const text = fieldText(field);
    let score = 0;
    for (const word of ["商品名", "メーカー", "型番", "品番", "製品", "検索"]) {
      if (text.includes(word)) score += word.length;
    }
    const rect = field.getBoundingClientRect();
    if (rect.width > 300) score += 6;
    return score;
  }

  function findNearbySearchButton(input) {
    const container = input.closest("tr, li, section, div, dd, dl") || input.parentElement;
    if (!container) return null;
    return [...container.querySelectorAll("button, input[type='button'], input[type='submit'], a, [role='button']")]
      .find((control) => isVisible(control) && controlLabel(control).includes("検索")) || null;
  }

  function findSearchButton() {
    return allDocuments().flatMap((doc) => [...doc.querySelectorAll("button, input[type='button'], input[type='submit'], a, [role='button']")])
      .find((control) => isVisible(control) && controlLabel(control).includes("検索")) || null;
  }

  function extractModelNumber(value) {
    const candidates = String(value || "").match(/[A-Z0-9][A-Z0-9._/-]{3,}[A-Z0-9]/gi) || [];
    return candidates.find((candidate) => /[A-Z]/i.test(candidate) && /\d/.test(candidate)) || "";
  }

  function clickFirstProductCandidate(draft) {
    const controls = allDocuments().flatMap((doc) => [...doc.querySelectorAll("button, input[type='button'], input[type='submit'], a, [role='button']")])
      .filter((control) => !control.disabled && isVisible(control) && !panel.contains(control));
    const candidates = controls
      .map((control) => ({ control, label: controlLabel(control), context: fieldText(control) }))
      .filter((item) => item.label.includes("選択する") || item.label.includes("選択"))
      .filter((item) => !item.context.includes("カテゴリ選択後") && !item.context.includes("下書き"))
      .sort((a, b) => candidateScore(b, draft) - candidateScore(a, draft));

    const candidate = candidates[0]?.control;
    if (!candidate) return false;
    focusElement(candidate);
    candidate.click();
    return true;
  }

  function candidateScore(item, draft) {
    const text = `${item.label} ${item.context}`;
    let score = 0;
    for (const word of importantWords(draft.title)) {
      if (text.includes(word)) score += Math.min(word.length, 12);
    }
    if (text.includes("発売日")) score += 8;
    if (text.includes("メーカー") || text.includes("ブランド")) score += 6;
    return score;
  }

  function importantWords(title) {
    return String(title || "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 2)
      .slice(0, 8);
  }

  function bestControl(requiredWords, excludedWords = []) {
    let best = null;
    let bestScore = 0;
    for (const control of visibleControls()) {
      const identityText = `${directFieldText(control)} ${previousText(control)}`;
      const optionText = control.tagName === "SELECT" ? [...control.options].map((option) => option.textContent).join(" ") : "";
      const haystack = `${identityText} ${optionText}`;
      if (excludedWords.some((word) => identityText.includes(word))) continue;
      const score = requiredWords.reduce((sum, word) => haystack.includes(word) ? sum + word.length : sum, 0);
      if (score > bestScore) {
        best = control;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function visibleControls() {
    return allDocuments().flatMap((doc) => [...doc.querySelectorAll("input:not([type=hidden]), textarea, select")])
      .filter((field) => !field.disabled && !field.readOnly && isVisible(field));
  }

  function selectOptionLike(select, hints) {
    const list = Array.isArray(hints) ? hints : [hints];
    const option = [...select.options].find((opt) => list.some((hint) => opt.textContent.includes(String(hint)) || opt.value.includes(String(hint))));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function categoryNeedsSelection() {
    const fields = allTextFields().filter((field) => isCategoryText(directFieldText(field).toLowerCase()));
    return fields.find((field) => !currentValue(field).trim()) || null;
  }

  function findDraftSaveControl() {
    const controls = allDocuments().flatMap((doc) => [...doc.querySelectorAll("button, input[type='button'], input[type='submit'], a, [role='button']")])
      .filter((control) => !control.disabled && isVisible(control));
    return controls.find((control) => {
      const label = controlLabel(control);
      const hasDraft = label.includes("下書") || label.includes("保存してあとで") || label.includes("あとで出品");
      if (!hasDraft) return false;
      if (!(label.includes("保存") || label.includes("登録") || label.includes("あとで"))) return false;
      if (label.includes("出品する") || label.includes("確認する") || label.includes("削除")) return false;
      return true;
    }) || null;
  }

  function fieldText(field) {
    return [
      directFieldText(field),
      previousText(field),
      field.closest("tr, li, section, div, dd, dl")?.textContent?.slice(0, 220)
    ].filter(Boolean).join(" ");
  }

  function directFieldText(field) {
    const doc = field.ownerDocument || document;
    const id = field.getAttribute?.("id");
    const label = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrappingLabel = field.closest?.("label");
    return [
      field.getAttribute?.("name"),
      field.getAttribute?.("aria-label"),
      field.getAttribute?.("placeholder"),
      label?.textContent,
      wrappingLabel?.textContent
    ].filter(Boolean).join(" ");
  }

  function previousText(field) {
    let node = field;
    const parts = [];
    for (let i = 0; i < 4 && node; i++) {
      node = node.previousElementSibling;
      if (node) parts.push(node.textContent || "");
    }
    return parts.join(" ").slice(0, 220);
  }

  function setValue(field, value) {
    if (field.tagName === "BODY") {
      field.focus();
      field.innerHTML = textToHtmlLines(value);
    } else if (field.isContentEditable) {
      field.innerHTML = textToHtmlLines(value);
    } else {
      field.value = value;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }

  function textToHtmlLines(value) {
    return escapeHtml(value).replace(/\r?\n/g, "<br>");
  }

  function focusElement(element) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus?.();
  }

  async function markLocalInputDone(asin) {
    await recordLocalWorkStatus(asin, "input_done");
  }

  async function recordLocalWorkStatus(asin, workStatus) {
    const response = await fetch(`${baseUrl}/api/items/${encodeURIComponent(asin)}`, {
      method: "PATCH", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: workStatus, ...(workStatus === "draft_saved" ? {saveConfirmed: true} : {})})
    });
    if (!response.ok) {status.textContent = "管理画面への作業記録を保存できませんでした。入力内容は残しています。"; throw new Error("作業記録の保存に失敗しました");}
  }

  async function markLocalDraftSaved(asin) {
    await recordLocalWorkStatus(asin, "draft_saved");
  }

  function uniqueImages(urls) {
    const filtered = (urls || []).filter(isLikelyProductImage);
    const preferred = filtered.filter((url) => /^https?:\/\/m\.media-amazon\.com\/images\/I\//i.test(url));
    const byKey = new Map();
    for (const url of (preferred.length ? preferred : filtered)) {
      const key = imageKey(url);
      if (!byKey.has(key)) byKey.set(key, url);
    }
    return [...byKey.values()];
  }

  function isLikelyProductImage(url) {
    const value = String(url || "");
    if (!/^https?:\/\/(?:m\.media-amazon|images-(?:fe|na)\.ssl-images-amazon)\.com\/images\/I\//i.test(value)) return false;
    if (/\.(?:svg|gif)(?:[?#]|$)/i.test(value)) return false;
    if (/grey-pixel|sprite|nav-sprite|prime|yourprime|logo|fallback|sash|marketing|x-locale|al-jp/i.test(value)) return false;
    return true;
  }

  function imageKey(url) {
    return String(url)
      .replace(/\._[^./]+_\./, ".")
      .replace(/\._[^./]+_(?=\.[a-z]{3,4}$)/i, "")
      .replace(/SS\d+|SX\d+|SY\d+|SL\d+/gi, "");
  }

  function fallbackDescription(draft) {
    return [
      "ご覧いただきありがとうございます。",
      "",
      "【商品情報】",
      draft.title || draft.asin,
      "",
      "Amazonの商品情報をもとに登録しています。サイズ、型番、仕様などは画像と商品名をご確認ください。",
      "",
      "【発送】",
      "発送元: 東京都",
      "送料: 出品者負担",
      "発送目安: 落札後3日から7日",
      "",
      `ASIN: ${draft.asin}`
    ].join("\n");
  }

  function isCategoryText(value) {
    return value.includes("カテゴリ") || value.includes("カテゴリー") || value.includes("category");
  }

  function currentValue(field) {
    if (field.isContentEditable) return field.textContent || "";
    return field.value || "";
  }

  function acceptsImage(input) {
    const accept = input.getAttribute("accept") || "";
    return !accept || accept.includes("image") || accept.includes(".jpg") || accept.includes(".png");
  }

  function isVisibleOrLikelyUpload(input) {
    return isVisible(input) || input.closest("[class*='image'], [id*='image'], [class*='upload'], [id*='upload']");
  }

  function extensionFromType(type) {
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    return "";
  }

  function controlLabel(control) {
    return [
      control.textContent,
      control.getAttribute("value"),
      control.getAttribute("aria-label"),
      control.getAttribute("title")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function containsAny(value, words) {
    return words.some((word) => value.includes(word.toLowerCase()));
  }

  function isVisible(element) {
    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function area(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function formatYen(value) {
    return value ? `${Number(value).toLocaleString("ja-JP")}円` : "未設定";
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
})();
