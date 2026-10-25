import {randomUUID} from "node:crypto";
import {parse} from "csv-parse/sync";
import {managementReferences, yahooListingUrl, yahooImageUrl} from "./yahoo-observation.js";

export const PREVIEW_CONFIG = Object.freeze({mode: "preview", intervalMinutes: 30, freshnessMinutes: 90, schedulerEnabled: false, emailEnabled: false});
export const INVENTORY_LABELS = {available: "在庫あり", zero: "充当可能在庫なし", unknown: "確認できず", unlinked: "紐付け要確認"};
export const YAHOO_LABELS = {active: "出品中", ended: "終了確認済み", ending: "終了検知・再確認待ち", unknown: "確認できず", unlinked: "紐付け要確認"};
export function emptyMonitor() { return {version: 1, catalog: [], listings: [], links: [], events: [], logs: []}; }
export function quantity(value) {
  if (!["string", "number"].includes(typeof value) || !/^\d+$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function text(value) { return String(value ?? "").trim(); }
function time(value) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; }

export function normalizeCatalog(row, context = {}) {
  const get = (...keys) => keys.map((key) => row[key]).find((value) => value !== undefined && value !== "");
  const sellerSku = text(get("sellerSku", "seller-sku", "sku", "SKU"));
  const sellerAccount = text(get("sellerAccount", "account") || context.sellerAccount);
  const marketplaceId = text(get("marketplaceId", "marketplace") || context.marketplaceId);
  const asin = text(get("asin", "ASIN")).toUpperCase();
  if (!sellerSku || !sellerAccount || !marketplaceId || !/^[A-Z0-9]{10}$/.test(asin)) throw new Error("Amazon側のアカウント名・マーケットプレイス・SKU・ASINが必要です");
  const checkedAt = get("checkedAt", "capturedAt") || context.checkedAt;
  if (time(checkedAt) === null) throw new Error("在庫を確認した日時を入力してください。取込時刻だけでは新しい在庫と判定しません");
  return {
    id: [sellerAccount, marketplaceId, sellerSku].map(encodeURIComponent).join("|"), sellerAccount, marketplaceId, sellerSku, asin,
    fnSku: text(get("fnSku", "fnsku", "FNSKU")), title: text(get("title", "product-name", "item-name") || asin),
    condition: text(get("condition", "condition-type")), setContents: text(get("setContents", "contents")),
    managementNumber: text(get("managementNumber", "管理番号")),
    fulfillableQuantity: quantity(get("fulfillableQuantity", "afn-fulfillable-quantity")),
    reservedQuantity: quantity(get("reservedQuantity", "afn-reserved-quantity")),
    inboundQuantity: quantity(get("inboundQuantity")), unfulfillableQuantity: quantity(get("unfulfillableQuantity", "afn-unsellable-quantity")),
    externalCommitments: quantity(get("externalCommitments")),
    mcfEligibility: ["verified", "unknown", "unavailable"].includes(row.mcfEligibility) ? row.mcfEligibility : "unknown",
    listingStatus: text(row.listingStatus) || "不明", checkedAt: new Date(checkedAt).toISOString(), source: "manual_import"
  };
}

export function parseCatalog(content, context) {
  const raw = text(content).replace(/^\uFEFF/, "");
  let rows;
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const value = JSON.parse(raw);
    rows = Array.isArray(value) ? value : value.items;
  } else {
    const matrix = parse(raw, {bom: true, skip_empty_lines: true, delimiter: raw.split(/\r?\n/)[0].includes("\t") ? "\t" : ","});
    const headers = matrix.shift()?.map(text) || [];
    if (headers.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("CSVの列名を確認してください");
    rows = matrix.map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i]])));
  }
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new Error("1〜5000件の商品データを指定してください");
  const catalog = rows.map((row) => normalizeCatalog(row, context));
  if (new Set(catalog.map((item) => item.id)).size !== catalog.length) throw new Error("同じアカウント・マーケットプレイス・SKUが重複しています");
  return catalog;
}

export function candidatesFor(listing, catalog) {
  const refs = listing.references || managementReferences(listing.description);
  return catalog.flatMap((item) => {
    const matches = refs.filter((ref) => ref.kind === "asin" ? item.asin === ref.value : item.managementNumber && item.managementNumber === ref.value);
    return matches.length ? [{catalogId: item.id, sellerSku: item.sellerSku, title: item.title, condition: item.condition, setContents: item.setContents, evidence: matches, needsReview: true}] : [];
  });
}

export function asinFromInput(value) {
  const input = text(value);
  if (/^[A-Z0-9]{10}$/i.test(input)) return input.toUpperCase();
  let url;
  try {url = new URL(input);} catch {throw new Error("Amazonの商品URLまたはASIN（英数字10文字）を入力してください");}
  const match = url.pathname.match(/^\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i);
  if (url.protocol !== "https:" || !["amazon.co.jp", "www.amazon.co.jp"].includes(url.hostname) || url.port || url.username || url.password || !match) throw new Error("Amazon.co.jpの /dp/ または /gp/product/ の商品URLを入力してください");
  return match[1].toUpperCase();
}

export function registerPageLink(state, {amazon, yahoo, reviewed, submitted}, at) {
  const asin = asinFromInput(amazon);
  const identity = yahooListingUrl(yahoo);
  let listing = state.listings.find((item) => item.listingId === identity.listingId);
  if (!listing) listing = observeListing(state, {...identity, title: "", seller: "", references: [],
    observation: {status: "unknown", verified: false, checkedAt: at, source: "page_link", evidence: "ページの紐付け登録のみ。出品状態は未取得です"}});
  return confirmAsinLink(state, {listingId: listing.listingId, asin, reviewed: reviewed === true || submitted === true}, at);
}

export function updateLinkMemo(state, linkId, memo, at) {
  const link = state.links.find((item) => item.id === linkId);
  if (!link) throw new Error("紐付けが見つかりません。画面を更新してください");
  if (typeof memo !== "string" || memo.length > 500) throw new Error("ひとことメモは500文字以内で入力してください");
  link.userMemo = memo;
  link.memoUpdatedAt = at;
  return link;
}

export function registerPageLinks(state, {rows, submitted}, at) {
  if (submitted !== true || !Array.isArray(rows) || !rows.length || rows.length > 50) throw new Error("登録する商品を1〜50行で入力してください");
  return rows.map((row, index) => {
    try {
      const candidate = structuredClone(state);
      const before = new Set(state.links.map((item) => item.id));
      const link = registerPageLink(candidate, {...row, submitted: true}, at);
      Object.assign(state, candidate);
      return {row: index, status: before.has(link.id) ? "existing" : "created", linkId: link.id};
    } catch (error) {return {row: index, status: "error", error: error.message};}
  });
}

export function updateListingPreview(state, linkId, snapshot, at) {
  const link = state.links.find((item) => item.id === linkId);
  const listing = state.listings.find((item) => item.listingId === link?.listingId);
  if (!link || !listing || listing.listingId !== snapshot.listingId) throw new Error("紐付けが変更されました。画面を更新してください");
  // Presentation metadata must not confirm ownership, reference matches or listing status.
  listing.title = text(snapshot.title) || listing.title;
  listing.imageUrl = yahooImageUrl(snapshot.imageUrl) || listing.imageUrl || "";
  listing.previewCheckedAt = at;
  return listing;
}

export function confirmAsinLink(state, {listingId, asin, reviewed, unitsPerListing = 1, reviewNote = ""}, at) {
  asin = text(asin).toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error("ASINは英数字10文字で入力してください");
  const listing = state.listings.find((item) => item.listingId === listingId);
  if (!listing || reviewed !== true) throw new Error("Amazonとヤフオクが同じ商品であることを確認してください");
  if (!Number.isSafeInteger(Number(unitsPerListing)) || Number(unitsPerListing) < 1) throw new Error("1出品に必要な在庫数を入力してください");
  const asins = new Set((listing.references || []).filter((ref) => ref.kind === "asin").map((ref) => ref.value));
  if ((asins.size > 1 || (asins.size === 1 && !asins.has(asin))) && !text(reviewNote)) throw new Error("管理番号のASINが一致しません。確認した根拠を記入してください");
  const previous = state.links.find((link) => link.listingId === listingId);
  if (previous && (previous.matchBy !== "asin" || previous.asin !== asin)) throw new Error("別の商品に紐付いています。解除してから確認してください");
  const fields = {matchBy: "asin", asin, listingId, verified: true, reviewedAt: at,
    unitsPerListing: Number(unitsPerListing), reviewNote: text(reviewNote),
    referenceFingerprint: JSON.stringify(listing.references || [])};
  if (previous) {Object.assign(previous, fields); return previous;}
  const link = {id: randomUUID(), ...fields, history: [], signals: {}};
  state.links.push(link);
  return link;
}

export function confirmLink(state, {listingId, catalogId, reviewed, unitsPerListing = 1, reviewNote = ""}, at) {
  const listing = state.listings.find((item) => item.listingId === listingId);
  const product = state.catalog.find((item) => item.id === catalogId);
  if (!listing || !product) throw new Error("Amazon商品とヤフオク出品を選択してください");
  if (reviewed !== true || !product.condition || !product.setContents || !listing.seller) throw new Error("出品者・状態・付属品を確認し、確認済みにチェックしてください");
  if (!Number.isSafeInteger(Number(unitsPerListing)) || Number(unitsPerListing) < 1) throw new Error("1出品に必要な在庫数を入力してください");
  const asins = new Set((listing.references || []).filter((ref) => ref.kind === "asin").map((ref) => ref.value));
  if ((asins.size > 1 || (asins.size === 1 && !asins.has(product.asin))) && !text(reviewNote)) throw new Error("管理番号のASINが一致しません。確認した根拠を記入してください");
  const previous = state.links.find((link) => link.listingId === listingId);
  if (previous && previous.catalogId !== catalogId) throw new Error("この出品は別の商品に紐付いています。既存の紐付けを解除してから確認してください");
  if (previous) {
    Object.assign(previous, {verified: true, reviewedAt: at, reviewNote: text(reviewNote), unitsPerListing: Number(unitsPerListing), productFingerprint: JSON.stringify([product.asin, product.fnSku, product.condition, product.setContents]), referenceFingerprint: JSON.stringify(listing.references || [])});
    return previous;
  }
  const link = {id: randomUUID(), catalogId, listingId, unitsPerListing: Number(unitsPerListing), verified: true, reviewedAt: at, reviewNote: text(reviewNote), referenceFingerprint: JSON.stringify(listing.references || []), productFingerprint: JSON.stringify([product.asin, product.fnSku, product.condition, product.setContents]), history: [], signals: {}};
  state.links.push(link);
  return link;
}

function fresh(checkedAt, at) {
  const age = time(at) - time(checkedAt);
  return time(checkedAt) !== null && age >= -60000 && age <= PREVIEW_CONFIG.freshnessMinutes * 60000;
}
function asinInventory(link, state, at, listing) {
  const fallback = {asin: link.asin, title: listing?.title || link.asin, fulfillableQuantity: null, source: "asin_registration"};
  const snapshot = state.amazonInventory;
  if (!snapshot) return {product: fallback, reason: "FBA在庫は未取得です。「FBA在庫を確認する」で確認できます", label: "未確認"};
  if (snapshot.status === "running") return {product: fallback, reason: "FBA在庫を確認しています。途中の情報は判定に使いません", label: "確認中"};
  if (snapshot.status !== "complete" || snapshot.complete !== true) return {product: fallback, reason: snapshot.error || "前回の取得が完了していません。再度確認してください", label: "取得できず"};
  if (!snapshot.asins?.includes(link.asin)) return {product: fallback, reason: "このASINはまだ在庫を確認していません", label: "未確認"};
  if (!fresh(snapshot.startedAt, at) || !fresh(snapshot.checkedAt, at)) return {product: fallback, reason: "在庫情報が古くなりました。再度確認してください", label: "古い情報"};
  const rows = snapshot.items.filter((item) => item.asin === link.asin);
  if (!rows.length) return {product: fallback, reason: "このASINに対応するFBA在庫が見つかりません。在庫ゼロとは判定しません", label: "該当なし・要確認"};
  if (rows.length > 1) return {product: fallback, ambiguous: true, rows, reason: "同じASINに複数の在庫があります。状態の違う商品を混ぜないため合算していません", label: "要確認"};
  return {product: {...rows[0], fulfillableQuantity: quantity(rows[0].fulfillableQuantity), checkedAt: rows[0].checkedAt || snapshot.checkedAt,
    externalCommitments: null, mcfEligibility: "unknown"}, rows, label: quantity(rows[0].fulfillableQuantity) === null ? "不明" : `${rows[0].fulfillableQuantity}個`};
}
export function assessLink(link, state, at) {
  const listing = state.listings.find((item) => item.listingId === link.listingId);
  const asinOnly = link.matchBy === "asin";
  // An ASIN association is not a verified FBA stock record.
  const live = asinOnly ? asinInventory(link, state, at, listing) : null;
  const product = asinOnly ? live.product : state.catalog.find((item) => item.id === link.catalogId);
  const fingerprint = product && JSON.stringify([product.asin, product.fnSku, product.condition, product.setContents]);
  if (link.observationConflict || !link.verified || !product || !listing || (!asinOnly && link.productFingerprint !== fingerprint) || link.referenceFingerprint !== JSON.stringify(listing.references || [])) return {inventory: "unlinked", yahoo: "unlinked", reason: "商品情報または管理番号が変わりました。紐付けを再確認してください", product, listing};
  if (asinOnly && state.catalog.filter((item) => item.asin === link.asin).length > 1) return {inventory: "unlinked", yahoo: "unlinked", reason: "同じASINに複数の商品情報があります。状態・セット内容を確認してください。在庫は合算しません", product, listing};
  if (live?.ambiguous) return {inventory: "unlinked", yahoo: "unlinked", reason: live.reason, product, listing, fbaLabel: live.label, fbaRows: live.rows};
  let inventory = "unknown";
  let reason = "在庫数量・確認日時・マルチチャネル出荷可否の確認が必要です";
  let availableQuantity = null;
  const count = quantity(product.fulfillableQuantity);
  if (fresh(product.checkedAt, at) && !product.error && count !== null) {
    if (count === 0) { inventory = "zero"; availableQuantity = 0; reason = "FBAの出荷可能数量が0です"; }
    else if (quantity(product.externalCommitments) !== null && product.mcfEligibility === "verified") {
      availableQuantity = Math.max(0, count - product.externalCommitments);
      inventory = availableQuantity < link.unitsPerListing ? "zero" : "available";
      reason = inventory === "zero" ? "FBA未反映の確定引当分を除くと、1出品に必要な数量がありません" : "出荷可能数量と未反映引当分・出荷条件を確認済みです";
    }
  }
  if (!fresh(product.checkedAt, at)) reason = "在庫情報が古い、または確認時刻が不明です";
  if (product.error) reason = product.error;
  if (asinOnly) reason = live.reason || (count === null ? "FBA数量を確認できません。在庫ゼロとは扱いません" : count === 0 ? "FBAの出荷可能数量が0です" : `FBA在庫は${count}個です。マルチチャネルの出荷条件・未反映の引当は未確認です`);
  if (asinOnly && state.amazonInventory?.scope === "linked_asins_only" && count === 0) {
    inventory = "unknown";
    availableQuantity = null;
    live.label = "0個（取得分）";
    reason = "検索できた出品のFBA数量は0個です。削除済み出品の在庫などは未確認のため、ASIN全体の在庫切れは未確定です";
  }
  const observation = listing.observation;
  let yahoo = "unknown";
  if (observation?.verified && fresh(observation.checkedAt, at)) {
    if (observation.status === "active") yahoo = "active";
    if (["ended", "stopped"].includes(observation.status)) yahoo = listing.endConfirmations >= 2 ? "ended" : "ending";
  }
  return {inventory, yahoo, reason, availableQuantity, product, listing, lineage: link.history, ...(live ? {fbaLabel: live.label, fbaRows: live.rows || []} : {})};
}

export function observeListing(state, snapshot) {
  const old = state.listings.find((item) => item.listingId === snapshot.listingId);
  if (old && time(snapshot.observation?.checkedAt) < time(old.observation?.checkedAt)) return old;
  const ended = ["ended", "stopped"].includes(snapshot.observation?.status) && snapshot.observation.verified;
  const consecutive = old && old.observation?.status === snapshot.observation.status && old.observation?.verified && time(snapshot.observation.checkedAt) > time(old.observation.checkedAt) && time(snapshot.observation.checkedAt) - time(old.observation.checkedAt) <= PREVIEW_CONFIG.freshnessMinutes * 60000;
  const next = {...old, ...snapshot, endConfirmations: ended ? (consecutive ? (old.endConfirmations || 1) + 1 : 1) : 0};
  if (old) state.listings[state.listings.indexOf(old)] = next;
  else state.listings.push(next);
  return next;
}

export function registerSuccessor(state, linkId, {listingId, reviewed, evidence}, at) {
  const link = state.links.find((item) => item.id === linkId);
  const next = state.listings.find((item) => item.listingId === listingId);
  const old = state.listings.find((item) => item.listingId === link?.listingId);
  if (!link || !next || !old || reviewed !== true || !text(evidence)) throw new Error("再出品先と、同じ商品である確認根拠が必要です");
  if (!old.seller || old.seller !== next.seller || listingId === old.listingId) throw new Error("出品者が異なるか、同じ出品IDです");
  if (JSON.stringify(next.references || []) !== link.referenceFingerprint) throw new Error("再出品先の管理番号が異なるため、自動では引き継げません");
  const transition = {previousId: link.listingId, nextId: listingId, evidence: text(evidence), at};
  link.history.push(transition);
  link.listingId = listingId;
  link.pendingSuccessor = transition;
  return link;
}

const eventLabels = {inventory_zero: "FBA充当可能在庫なし", inventory_recovered: "FBA在庫復帰", yahoo_ended: "ヤフオク出品終了・再出品状況の確認が必要", yahoo_recovered: "ヤフオク出品中を確認", yahoo_relisted: "ヤフオク再出品先を確認", inventory_unknown: "FBA在庫を確認できません", yahoo_unknown: "ヤフオク状態を確認できません", inventory_restored: "FBA在庫の確認再開", yahoo_restored: "ヤフオク状態の確認再開", link_review: "商品紐付けの再確認が必要"};
export function runPreview(state, at = new Date().toISOString()) {
  const created = [];
  for (const link of state.links) {
    const assessment = assessLink(link, state, at);
    const add = (kind) => {
      const title = kind === "inventory_unknown" && assessment.product?.source === "amazon_sp_api" && quantity(assessment.product.fulfillableQuantity) !== null ? "マルチチャネル出荷条件の確認が必要" : eventLabels[kind];
      const event = {id: randomUUID(), linkId: link.id, kind, at, title, assessment: structuredClone(assessment), delivery: {status: "preview", attempts: 0}};
      state.events.push(event); created.push(event);
    };
    if (assessment.inventory === "unlinked") {
      if (!link.reviewAlerted) add("link_review");
      link.reviewAlerted = true;
      continue;
    }
    link.reviewAlerted = false;
    const successorChanged = Boolean(link.pendingSuccessor);
    if (successorChanged) {add("yahoo_relisted"); delete link.pendingSuccessor;}
    for (const domain of ["inventory", "yahoo"]) {
      const current = assessment[domain];
      // A relisting transition must not erase the last confirmed listing state.
      if (current === "ending") continue;
      const previous = link.signals[domain] || {};
      if (current === "unknown") {
        if (previous.observed !== "unknown") add(`${domain}_unknown`);
        link.signals[domain] = {...previous, observed: "unknown"};
        continue;
      }
      if (previous.observed === "unknown") add(`${domain}_restored`);
      if (previous.known !== current) {
        if (current === "zero") add("inventory_zero");
        else if (domain === "inventory" && previous.known === "zero") add("inventory_recovered");
        else if (current === "ended") add("yahoo_ended");
        else if (domain === "yahoo" && previous.known === "ended" && !successorChanged) add("yahoo_recovered");
      }
      link.signals[domain] = {known: current, observed: current};
    }
  }
  return created;
}

export function notificationPreview(event) {
  const {product: p, listing: y, availableQuantity, inventory, yahoo} = event.assessment;
  const count = (value) => value === null || value === undefined ? "不明" : `${value}個`;
  const messages = {
    inventory_observed_zero: ["確認できたFBA在庫は0個です。在庫切れ全体の確定ではありません。", "Amazonの在庫とマルチチャネル出荷可否を確認し、ヤフオクの販売を続けてよいか判断してください。"],
    inventory_observed_recovered: [`確認できたFBA在庫が${p?.fulfillableQuantity ?? "不明"}個に復帰しました。`, "現在の数量とマルチチャネル出荷条件を確認してください。"],
    inventory_zero: ["ヤフオクの注文に使えるFBA在庫がありません。", "ヤフオクに出品が残っているか確認し、販売を続けてよいか判断してください。"],
    inventory_recovered: ["FBA在庫が復帰しました。", "商品・数量・出荷条件を確認して、販売を再開できるか判断してください。"],
    inventory_unknown: ["FBA在庫を確認できません。在庫切れと確定したわけではありません。", "Amazon側の在庫と取得状況を確認してください。"],
    inventory_restored: ["FBA在庫の確認を再開できました。", "現在の在庫数と出荷条件を確認してください。"],
    yahoo_ended: ["ヤフオクの出品が終了・停止しています。", "再出品されているか確認してください。後継の出品がある場合は紐付け先も確認してください。"],
    yahoo_recovered: ["ヤフオクの出品が再開されています。", "現在の出品内容とFBA在庫を確認してください。"],
    yahoo_unknown: ["ヤフオクの出品状態を確認できません。終了とは確定していません。", "ヤフオクの商品ページと取得状況を確認してください。"],
    yahoo_restored: ["ヤフオクの出品状態を再び確認できました。", "現在の出品状態を確認してください。"],
    yahoo_relisted: ["確認済みの再出品先へ、紐付けを引き継ぎました。", "新しい商品ページと紐付け先が正しいか確認してください。"],
    link_review: ["このASINとヤフオク出品の組み合わせを再確認してください。", "同じASINでも状態・付属品・セット内容が一致しているか確認してください。"]
  };
  if (event.kind === "inventory_unknown" && p?.source === "amazon_sp_api" && quantity(p.fulfillableQuantity) !== null) {
    messages.inventory_unknown = [`FBA在庫は${p.fulfillableQuantity}個です。ヤフオク注文への出荷条件は未確認です。`, "マルチチャネルの出荷条件と、未反映の引当分を確認してください。"];
  }
  if (event.kind === "link_review" && event.assessment.reason?.startsWith("同じASIN")) messages.link_review[0] = event.assessment.reason;
  const [message, action] = messages[event.kind] || [event.title, "商品と出品の状態を確認してください。"];
  return {message, action,
    product: [
      ["商品名", y?.title || p?.title || "不明"],
      ["ASIN", p?.asin || "不明"],
      ["SKU", p?.sellerSku || "未取得"],
      ["商品の状態", p?.condition || "不明"],
      ["付属品・セット内容", p?.setContents || "不明"]
    ],
    status: [
      ["注文に使えるFBA在庫", count(availableQuantity)],
      ["在庫の判定", INVENTORY_LABELS[inventory]],
      ["ヤフオクの状態", YAHOO_LABELS[yahoo]],
      ["ヤフオク出品ID", y?.listingId || "不明"],
      ["終了理由", y?.observation?.reason && y.observation.reason !== "unknown" ? y.observation.reason : "不明"]
    ]
  };
}

export function notificationText(event, {preview: isPreview = true} = {}) {
  const {product: p, listing: y, availableQuantity, inventory, yahoo, reason} = event.assessment;
  const number = (v) => v === null || v === undefined ? "不明" : String(v);
  const transition = event.assessment.lineage?.at(-1);
  const preview = notificationPreview(event);
  return [
    `${isPreview ? "【確認用・未送信】" : ""}${event.title}`,
    "",
    preview.message,
    `必要な対応: ${preview.action}`,
    `確認時刻: ${new Date(event.at).toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"})}（日本時間）`,
    "",
    "【商品情報】",
    ...preview.product.map(([label, value]) => `${label}: ${value}`),
    "",
    "【在庫・出品状況】",
    ...preview.status.map(([label, value]) => `${label}: ${value}`),
    "",
    "【確認用リンク】",
    `Amazon: ${p?.asin ? `https://www.amazon.co.jp/dp/${p.asin}` : "不明"}`,
    `ヤフオク: ${y?.url || "不明"}`,
    "",
    "【確認の詳細】",
    `ASIN: ${p?.asin || "不明"} / Seller SKU: ${p?.sellerSku || "不明"} / FNSKU: ${p?.fnSku || "不明"}`,
    `アカウント: ${p?.sellerAccount || "不明"} / 状態: ${p?.condition || "不明"} / セット内容: ${p?.setContents || "不明"}`,
    `FBA fulfillableQuantity: ${number(p?.fulfillableQuantity)} / FBA未反映の確定引当: ${number(p?.externalCommitments)}`,
    `判定用数量: ${number(availableQuantity)} / 在庫判定: ${INVENTORY_LABELS[inventory]}`,
    `在庫情報元: ${{manual_import: "ファイル・手動取込", test: "練習用データ", asin_registration: "ASIN登録のみ・在庫未取得", amazon_sp_api: "Amazon FBA在庫API"}[p?.source] || "不明"} / 在庫確認時刻: ${p?.checkedAt || "不明"} / マルチチャネル可否: ${{verified: "確認済み", unknown: "未確認", unavailable: "出荷できず"}[p?.mcfEligibility] || "不明"}`,
    `ヤフオクID: ${y?.listingId || "不明"} / 状態: ${YAHOO_LABELS[yahoo]} / 終了理由: ${y?.observation?.reason && y.observation.reason !== "unknown" ? y.observation.reason : "不明"}`,
    `ヤフオク確認時刻: ${y?.observation?.checkedAt || "不明"} / 根拠: ${y?.observation?.evidence || "不明"}`,
    `再出品の引継ぎ: ${transition ? `${transition.previousId} → ${transition.nextId} / 確認根拠: ${transition.evidence}` : "後継出品の有無は未確認"}`,
    `判定理由: ${reason} / 確認時刻: ${event.at}`,
    "",
    isPreview ? "この通知はプレビューです。メール送信・出品停止・再出品・価格変更は実行していません。" : "この通知では出品停止・再出品・価格変更は行っていません。"
  ].join("\n");
}

export async function testDelivery(event, transport, at = new Date().toISOString()) {
  if (transport.testOnly !== true) throw new Error("実メール送信は未設定です");
  if (event.delivery.status === "test_sent") return;
  event.delivery.attempts++;
  try { await transport.send({id: event.id, text: notificationText(event)}); event.delivery = {...event.delivery, status: "test_sent", at}; }
  catch (error) { event.delivery = {...event.delivery, status: "test_failed", error: error.message, at}; }
}
