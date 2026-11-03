import {randomUUID, createHash} from "node:crypto";
import {stockImageUrl} from "./stock-images.js";

export const STOCK_LOCATIONS = [{id: "container", name: "コンテナ"}, {id: "home", name: "自宅・自社"}, {id: "fba", name: "Amazon FBA（観測のみ）"}];
const local = new Set(["container", "home"]);
const buckets = ["usable", "reserved", "unusable"];
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function fail(message, status = 400) {return Object.assign(new Error(message), {status});}
function text(value, maximum, required = false) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" || value.trim().length > maximum || required && !value.trim()) throw fail("入力欄の長さ・必須項目を確認してください");
  return value.trim();
}
function quantity(value, zero = false) {if (!count(value) || !zero && value === 0) throw fail(zero ? "数量は0以上の整数で入力してください" : "数量は1以上の整数で入力してください"); return value;}
function choice(value, choices) {if (!choices.includes(value)) throw fail("操作・場所・状態を選択してください"); return value;}
function asin(value) {const result = text(value, 10).toUpperCase(); if (result && !/^[A-Z0-9]{10}$/.test(result)) throw fail("ASINは10桁で入力してください"); return result;}
export function emptyPhysicalStock() {return {version: 1, products: [], balances: [], transfers: [], events: [], receipts: []};}
export function stockCommandDigest(command) {
  function ordered(value) {return Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;}
  return createHash("sha256").update(JSON.stringify(ordered(command))).digest("hex");
}
export function validatePhysicalStock(state) {
  if (!state || state.version !== 1 || !["products", "balances", "transfers", "events", "receipts"].every((key) => Array.isArray(state[key]))) throw new Error("手元在庫の保存形式を確認してください");
  const products = new Set(state.products.map((p) => p.id)), pairs = new Set(), operations = new Set();
  if (products.size !== state.products.length || state.products.some((p) => !uuid(p.id) || typeof p.title !== "string" || !p.title)) throw new Error("手元在庫の管理IDを確認してください");
  if (state.products.some((p) => p.imageUrl && stockImageUrl(p.imageUrl) !== p.imageUrl)) throw new Error("商品画像の保存先を確認してください");
  if (state.amazonListings && (!["complete","failed"].includes(state.amazonListings.status) || state.amazonListings.status === "complete" &&
    (!Array.isArray(state.amazonListings.rows) || !Array.isArray(state.amazonListings.asins) || state.amazonListings.rows.some((r) => typeof r.asin !== "string" || typeof r.sellerSku !== "string" || !Array.isArray(r.statuses) || !Array.isArray(r.fulfillment))))) throw new Error("自社Amazon出品の確認情報を検証してください");
  for (const balance of state.balances) {
    const pair = JSON.stringify([balance.productId, balance.locationId]);
    if (!products.has(balance.productId) || !local.has(balance.locationId) || pairs.has(pair) || !(buckets.every((b) => balance[b] === null) || buckets.every((b) => count(balance[b]))) ||
      buckets.every((b) => count(balance[b])) && buckets.reduce((sum, b) => sum + balance[b], 0) > 1000000) throw new Error("場所別数量の整合性を確認してください");
    pairs.add(pair);
  }
  for (const transfer of state.transfers) {
    if (!uuid(transfer.id) || !products.has(transfer.productId) || !local.has(transfer.from) || !STOCK_LOCATIONS.some((l) => l.id === transfer.to) || transfer.from === transfer.to ||
      !["quantity", "remaining", "received", "returned"].every((k) => count(transfer[k])) || transfer.quantity !== transfer.remaining + transfer.received + transfer.returned) throw new Error("移動中の数量が一致しません");
  }
  for (const receipt of state.receipts) {if (!uuid(receipt.id) || operations.has(receipt.id)) throw new Error("在庫操作IDの整合性を確認してください"); operations.add(receipt.id);}
  if (state.products.length > 1000 || state.events.length > 10000 || state.receipts.length > 10000 || Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) throw fail("在庫履歴の保存上限です。過去履歴は削除せず拡張を確認してください", 409);
  return state;
}
function productFields(data) {
  const task = choice(data.catalogTask || "none", ["none", "pending", "working", "registered"]);
  const result = {title: text(data.title, 200, true), unit: choice(data.unit || "個", ["個", "台", "箱", "セット", "冊"]), condition: choice(data.condition, ["new", "used", "parts", "unknown"]),
    setContents: text(data.setContents, 300), memo: text(data.memo, 500), asin: asin(data.asin), sellerSku: text(data.sellerSku, 200),
    catalogTask: task, fbaEligibility: choice(data.fbaEligibility || "unknown", ["unknown", "possible", "not_possible"]),
    linkedLinkIds: data.linkedLinkIds || [], reviewDate: text(data.reviewDate, 10)};
  if (!Array.isArray(result.linkedLinkIds) || result.linkedLinkIds.length > 10 || result.linkedLinkIds.some((value) => !uuid(value)) || new Set(result.linkedLinkIds).size !== result.linkedLinkIds.length) throw fail("紐付け先を確認してください");
  if (result.reviewDate && (!/^\d{4}-\d{2}-\d{2}$/.test(result.reviewDate) || new Date(result.reviewDate + "T00:00:00Z").toISOString().slice(0, 10) !== result.reviewDate)) throw fail("再確認日を正しく入力してください");
  if (task === "registered" && !result.asin) throw fail("カタログ登録済みにする場合はASINを入力してください");
  if (data.imageUrl !== undefined) {
    const value = text(data.imageUrl, 2048); if (value && !stockImageUrl(value)) throw fail("画像URLはAmazonまたはヤフオクのHTTPS画像URLを入力してください");
    result.imageUrl = value ? stockImageUrl(value) : "";
    result.imageSource = choice(data.imageSource || "manual", ["manual", "amazon_catalog"]);
  }
  return result;
}

export function applyStockCommand(state, command, {actor, at = new Date().toISOString()} = {}) {
  if (typeof actor !== "string" || !actor || actor.length > 256 || !Number.isFinite(Date.parse(at))) throw fail("操作した本人と日時を確認してください");
  if (!command || !uuid(command.operationId)) throw fail("保存用の操作IDを確認してください");
  const digest = stockCommandDigest(command), previous = state.receipts.find((r) => r.id === command.operationId);
  if (previous) {if (previous.digest !== digest || previous.actor !== actor) throw fail("同じ操作IDで内容が異なります", 409); return {...previous, replayed: true};}
  const kind = choice(command.kind, ["create", "edit", "memo", "add", "remove", "count", "count_locations", "reserve", "release", "unusable", "recover", "dispatch", "receive_transfer", "return_transfer"]);
  const reason = text(command.reason, 300, !["create", "edit", "memo"].includes(kind));
  const before = [], changes = [];
  const balance = (productId, locationId, requireKnown = true) => {
    if (!local.has(locationId)) throw fail("FBA数量はこの台帳で変更できません。コンテナか自宅・自社を選んでください");
    let row = state.balances.find((b) => b.productId === productId && b.locationId === locationId);
    if (!row) {row = {productId, locationId, usable: null, reserved: null, unusable: null, checkedAt: null}; state.balances.push(row);}
    if (requireKnown && row.usable === null) throw fail("この場所の実数が未確認です。先に棚卸しで実数を登録してください", 409);
    if (!before.some((b) => b.productId === productId && b.locationId === locationId)) before.push(structuredClone(row));
    return row;
  };
  let product = state.products.find((p) => p.id === command.productId), transferBefore = null, transferAfter = null, metadataBefore = null;
  if (kind === "create") {
    const fields = productFields(command.product || {});
    const id = command.productId || randomUUID();
    if (!uuid(id) || state.products.some((p) => p.id === id || p.managementId === "ST-" + id.slice(0, 8).toUpperCase())) throw fail("管理IDが重複しています。新規入力を開き直してください", 409);
    product = {...fields, id, managementId: "ST-" + id.slice(0, 8).toUpperCase(), createdAt: at, updatedAt: at};
    state.products.push(product);
    if (command.initialCounts !== undefined) {
      if (!command.initialCounts || Array.isArray(command.initialCounts) || Object.keys(command.initialCounts).length !== 2 || ![...local].every((id) => Object.hasOwn(command.initialCounts, id))) throw fail("コンテナと自宅・会社の数量を確認してください");
      for (const locationId of local) {
        const b = balance(id, locationId, false), amount = command.initialCounts[locationId];
        if (amount !== null) Object.assign(b, {usable: quantity(amount, true), reserved: 0, unusable: 0, checkedAt: at});
      }
    } else {
      const b = balance(id, choice(command.locationId, [...local]), false);
      if (command.quantity !== null) Object.assign(b, {usable: quantity(command.quantity, true), reserved: 0, unusable: 0, checkedAt: at});
    }
  } else {
    if (!product) throw fail("在庫商品が見つかりません", 404);
    if (kind === "edit") {
      metadataBefore = structuredClone(product); const fields = productFields(command.product || {});
      if (fields.unit !== product.unit || fields.condition !== product.condition || fields.setContents !== product.setContents) throw fail("単位・状態・セットの変更は別の管理商品として登録してください。数量を自動変換しません", 409);
      if (fields.asin !== product.asin && product.imageSource === "amazon_catalog" && (!Object.hasOwn(fields, "imageUrl") || fields.imageUrl === product.imageUrl)) Object.assign(fields, {imageUrl:"",imageSource:"manual"});
      Object.assign(product, fields, {updatedAt: at});
    } else if (kind === "memo") {
      if(typeof command.previousMemo!=='string'||typeof command.memo!=='string')throw fail('変更前後のメモを確認してください');
      if(command.previousMemo!==(product.memo||''))throw fail('別のメモが保存されています。最新のメモを確認してください',409);
      const memo=text(command.memo,500);metadataBefore=structuredClone(product);
      Object.assign(product,{memo,updatedAt:at});
    } else if (kind === "count_locations") {
      const entries = command.locations;
      if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Object.keys(entries).length || Object.keys(entries).some((id) => !local.has(id))) throw fail("修正する保管場所を確認してください");
      // Both places are one revision-checked transaction; omitted places remain untouched.
      for (const [locationId, counts] of Object.entries(entries)) {
        const b = balance(product.id, locationId, false);
        for (const bucket of buckets) b[bucket] = quantity(counts?.[bucket], true);
        b.checkedAt = at;
      }
    } else if (["receive_transfer", "return_transfer"].includes(kind)) {
      const transfer = state.transfers.find((t) => t.id === command.transferId && t.productId === product.id);
      if (!transfer || !transfer.remaining) throw fail("未完了の移動が見つかりません", 409);
      const amount = quantity(command.quantity); if (amount > transfer.remaining) throw fail("移動中の残数を超えています", 409);
      transferBefore = structuredClone(transfer);
      const destination = kind === "return_transfer" ? transfer.from : transfer.to;
      if (destination === "fba") {
        if (!text(command.evidence, 300, true)) throw fail("FBA受領の確認根拠が必要です");
      } else {
        const b = balance(product.id, destination), bucket = choice(command.bucket || "usable", ["usable", "unusable"]); b[bucket] += amount; b.checkedAt = at;
      }
      transfer.remaining -= amount; transfer[kind === "return_transfer" ? "returned" : "received"] += amount;
      transfer.updatedAt = at; transferAfter = structuredClone(transfer);
    } else {
      const b = balance(product.id, command.locationId, kind !== "count");
      if (kind === "count") {
        for (const bucket of buckets) b[bucket] = quantity(command.counts?.[bucket], true);
      } else {
        const amount = quantity(command.quantity);
        const source = kind === "release" ? "reserved" : kind === "recover" ? "unusable" : "usable";
        if (kind !== "add" && b[source] < amount) throw fail("対象区分の数量が不足しています。棚卸しや数量を確認してください", 409);
        if (kind === "add") b.usable += amount;
        else {
          b[source] -= amount;
          if (kind === "reserve") b.reserved += amount;
          if (["release", "recover"].includes(kind)) b.usable += amount;
          if (kind === "unusable") b.unusable += amount;
          if (kind === "dispatch") {
            const to = choice(command.to, STOCK_LOCATIONS.map((l) => l.id)); if (to === b.locationId) throw fail("別の移動先を選んでください");
            const reference = text(command.reference, 200, to === "fba");
            const transfer = {id: randomUUID(), productId: product.id, from: b.locationId, to, quantity: amount, remaining: amount, received: 0, returned: 0, reference, createdAt: at, updatedAt: at};
            state.transfers.push(transfer); transferAfter = structuredClone(transfer);
          }
        }
      }
      b.checkedAt = at;
    }
  }
  for (const old of before) changes.push({locationId: old.locationId, before: old, after: structuredClone(state.balances.find((b) => b.productId === old.productId && b.locationId === old.locationId))});
  const receipt = {id: command.operationId, digest, actor, at, kind, productId: product.id};
  state.events.push({id: randomUUID(), operationId: command.operationId, kind, productId: product.id, actor, at, reason,
    changes, transferBefore, transferAfter, ...(metadataBefore ? {metadataBefore, metadataAfter: structuredClone(product)} : {}), evidence: text(command.evidence, 300)});
  state.receipts.push(receipt); validatePhysicalStock(state); return receipt;
}

export function stockTotals(state, productId) {
  const locations = [...local].map((locationId) => state.balances.find((b) => b.productId === productId && b.locationId === locationId) || {productId, locationId, usable: null, reserved: null, unusable: null, checkedAt: null});
  return {locations, unknownLocations: locations.filter((b) => b.usable === null).length,
    usable: locations.reduce((n, b) => n + (b.usable || 0), 0), reserved: locations.reduce((n, b) => n + (b.reserved || 0), 0), unusable: locations.reduce((n, b) => n + (b.unusable || 0), 0),
    inTransit: state.transfers.filter((t) => t.productId === productId).reduce((n, t) => n + t.remaining, 0)};
}
