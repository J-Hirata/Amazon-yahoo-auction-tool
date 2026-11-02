import {createHash} from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quantity = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function amazonImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-fe.ssl-images-amazon.com"].includes(url.hostname) && !url.username && !url.password && !url.port && url.href.length <= 2048) return url.href;
  } catch { /* Unverified image sources are not displayed. */ }
  return "";
}
export function ownListingInfo(item, marketplaceId, checkedAt) {
  const attributes = item.attributes || {};
  const values = (name) => Array.isArray(attributes[name]) ? attributes[name].filter((value) => value?.marketplace_id === marketplaceId) : [];
  const comments = [...new Set(values("condition_note").filter((entry) => typeof entry.value === "string").map((entry) => entry.value))];
  const summary = item.summaries?.find((entry) => entry.marketplaceId === marketplaceId);
  return {checkedAt, source: "own_seller_listing", sellerSku: item.sku,
    ownComment: comments.length === 1 ? comments[0] : "", ownCommentStatus: comments.length === 1 ? comments[0] ? "retrieved" : "empty" : "unknown",
    offerImageUrls: [...new Set(Object.keys(attributes).filter((name) => /^(?:main|other)_offer_image_locator(?:_\d+)?$/.test(name)).flatMap((name) => values(name).map((entry) => amazonImageUrl(entry.media_location))).filter(Boolean))],
    catalogImageUrl: amazonImageUrl(summary?.mainImage?.link)};
}

export function amazonConfigFromValues(env) {
  const keys = ["AMAZON_SP_API_LWA_CLIENT_ID", "AMAZON_SP_API_LWA_CLIENT_SECRET", "AMAZON_SP_API_REFRESH_TOKEN", "AMAZON_SP_API_MARKETPLACE_ID"];
  if (keys.some((key) => !env[key])) throw new Error("Amazon接続設定に不足があります");
  if ((env.AMAZON_SP_API_REGION || "fe") !== "fe" || (env.AMAZON_SP_API_ENV || "production") !== "production" || env.AMAZON_SP_API_MARKETPLACE_ID !== "A1VC38T7YXB528") throw new Error("日本のAmazonアカウント設定を確認してください");
  return {clientId: env[keys[0]], clientSecret: env[keys[1]], refreshToken: env[keys[2]], marketplaceId: env[keys[3]],
    sellerId: env.AMAZON_SP_API_SELLER_ID || env.AMAZON_SELLER_ID || null,
    accountKey: createHash("sha256").update(JSON.stringify(keys.map((key) => key === "AMAZON_SP_API_LWA_CLIENT_SECRET" ? "" : env[key]))).digest("hex")};
}
export function cloudAmazonConfig(env = process.env) {
  return amazonConfigFromValues(Object.fromEntries(["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN", "MARKETPLACE_ID", "SELLER_ID"].map((key) => [`AMAZON_SP_API_${key.startsWith("CLIENT") ? "LWA_" : ""}${key}`, env[`ASIN_AMAZON_${key}`]])));
}

// Only token refresh and inventory GETs are supported; no order or listing writes.
export async function readFbaInventory({asins, config, fetchImpl = fetch, wait = sleep, onProgress = () => {}, maxPages = 100, maxDurationMs = 5 * 60 * 1000, now = () => Date.now()}) {
  const started = now();
  const startedAt = new Date(started).toISOString();
  const wanted = new Set(asins);
  if (!wanted.size || [...wanted].some((asin) => !/^[A-Z0-9]{10}$/.test(asin))) throw new Error("確認するASINがありません");
  function remaining() {
    const value = maxDurationMs - (now() - started);
    if (value <= 0) throw new Error("在庫の取得が時間内に完了しませんでした。再度確認してください");
    return value;
  }
  async function pause(ms) {if (remaining() <= ms) throw new Error("在庫の取得が時間内に完了しませんでした。再度確認してください"); await wait(ms); remaining();}
  async function request(url, options, label) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {response = await fetchImpl(url, {...options, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(20000, remaining())))});}
      catch {throw new Error(`${label}に接続できません。再度確認してください`);}
      if ([429, 500, 503].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        await pause(1500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`${label}に失敗しました（HTTP ${response.status}）。在庫ゼロとは扱いません`);
      try {return await response.json();} catch {throw new Error(`${label}の応答を読み取れません`);}
    }
  }
  const token = await request("https://api.amazon.com/auth/o2/token", {method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded;charset=UTF-8"},
    body: new URLSearchParams({grant_type: "refresh_token", refresh_token: config.refreshToken, client_id: config.clientId, client_secret: config.clientSecret})}, "Amazon認証");
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Amazon認証を確認できません");
  const headers = {"x-amz-access-token": token.access_token, "user-agent": "ASINYahooManualInventory/1.0"};
  let sellerId = config.sellerId;
  if (!sellerId) {
    // MyOffer is Amazon's explicit indication of this authenticated seller's offer.
    for (const condition of ["Used", "New"]) {
      const url = new URL(`https://sellingpartnerapi-fe.amazon.com/products/pricing/v0/items/${[...wanted][0]}/offers`);
      url.searchParams.set("MarketplaceId", config.marketplaceId);
      url.searchParams.set("ItemCondition", condition);
      const data = await request(url, {method: "GET", headers}, "Amazon出品者の確認");
      const ownIds = new Set((data.payload?.Offers || []).filter((offer) => offer.MyOffer === true).map((offer) => offer.SellerId).filter((id) => typeof id === "string"));
      if (ownIds.size > 1) throw new Error("Amazonの出品者を一意に確認できません");
      if (ownIds.size === 1) {sellerId = [...ownIds][0]; break;}
      await pause(2200);
    }
  }
  if (!sellerId || !/^[A-Z0-9]+$/.test(sellerId)) throw new Error("対象商品だけを調べるため、Amazon出品者IDの初回確認が必要です。全在庫の取得は行いません");
  let pages = 0;
  const skuToAsin = new Map();
  const listingInfoBySku = new Map();
  const targets = [...wanted];
  for (let offset = 0; offset < targets.length; offset += 20) {
    let pageToken;
    let listingRows = 0;
    const seenPages = new Set();
    do {
      if (++pages > maxPages || now() - started > maxDurationMs) throw new Error("対象商品の検索が完了しませんでした。再度確認してください");
      const url = new URL(`https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${sellerId}`);
      for (const [key, value] of Object.entries({marketplaceIds: config.marketplaceId, identifiersType: "ASIN", identifiers: targets.slice(offset, offset + 20).join(","), includedData: "summaries,attributes", pageSize: "20", ...(pageToken ? {pageToken} : {})})) url.searchParams.set(key, value);
      const data = await request(url, {method: "GET", headers}, "対象商品の検索");
      if (!Array.isArray(data.items) || data.errors?.length) throw new Error("対象商品の検索結果を確認できません");
      listingRows += data.items.length;
      for (const item of data.items) {
        const matches = item.summaries?.filter((summary) => summary.marketplaceId === config.marketplaceId && wanted.has(summary.asin)) || [];
        const ids = new Set(matches.map((summary) => summary.asin));
        if (ids.size !== 1 || typeof item.sku !== "string" || !item.sku) throw new Error("対象商品の識別情報が一致しません");
        const asin = [...ids][0];
        if (skuToAsin.has(item.sku) && skuToAsin.get(item.sku) !== asin) throw new Error("対象商品の識別情報が変わりました");
        skuToAsin.set(item.sku, asin);
        listingInfoBySku.set(item.sku, ownListingInfo(item, config.marketplaceId, new Date(now()).toISOString()));
      }
      await onProgress({phase: "listings", pages, scanned: skuToAsin.size, targets: wanted.size});
      pageToken = data.pagination?.nextToken;
      if (!pageToken && Number.isSafeInteger(data.numberOfResults) && data.numberOfResults > listingRows) throw new Error("対象商品の検索結果を最後まで取得できませんでした");
      if (pageToken && (typeof pageToken !== "string" || seenPages.has(pageToken))) throw new Error("対象商品の検索が繰り返されています");
      if (pageToken) seenPages.add(pageToken);
      await pause(250);
    } while (pageToken);
  }
  const skus = [...skuToAsin.keys()];
  let nextToken;
  let scanned = 0;
  const seenTokens = new Set();
  const rowsByKey = new Map();
  let inventoryPages = 0;
  for (let offset = 0; offset < skus.length; offset += 50) {
   nextToken = undefined;
   do {
    if (++inventoryPages > maxPages) throw new Error("対象商品の在庫取得が完了しませんでした");
    if (now() - started > maxDurationMs) throw new Error("在庫の取得が時間内に完了しませんでした。再度確認してください");
    const url = new URL("https://sellingpartnerapi-fe.amazon.com/fba/inventory/v1/summaries");
    for (const [key, value] of Object.entries({granularityType: "Marketplace", granularityId: config.marketplaceId, marketplaceIds: config.marketplaceId, details: "true", sellerSkus: skus.slice(offset, offset + 50).join(","), ...(nextToken ? {nextToken} : {})})) url.searchParams.set(key, value);
    const data = await request(url, {method: "GET", headers}, "FBA在庫取得");
    const rows = data.payload?.inventorySummaries;
    if (!Array.isArray(rows) || (data.errors?.length)) throw new Error("FBA在庫の形式を確認できません");
    const granularity = data.payload.granularity;
    if (granularity && (granularity.granularityId !== config.marketplaceId || granularity.granularityType !== "Marketplace")) throw new Error("FBA在庫の販売国が一致しません");
    scanned += rows.length;
    const checkedAt = new Date(now()).toISOString();
    for (const row of rows) {
      if (!row || typeof row.asin !== "string" || !/^[A-Z0-9]{10}$/.test(row.asin)) throw new Error("在庫商品の識別情報が不足しています");
      if (!wanted.has(row.asin)) throw new Error("対象外のASINが返されました。全在庫の取り込みは行いません");
      if (typeof row.sellerSku !== "string" || !row.sellerSku.trim()) throw new Error("対象商品の在庫識別情報が不足しています");
      if (skuToAsin.get(row.sellerSku) !== row.asin || !skus.slice(offset, offset + 50).includes(row.sellerSku)) throw new Error("対象商品のSKUとASINが一致しません");
      const item = {asin: row.asin, sellerSku: row.sellerSku, fnSku: String(row.fnSku || ""), condition: String(row.condition || ""),
        title: String(row.productName || row.asin), fulfillableQuantity: quantity(row.inventoryDetails?.fulfillableQuantity),
        reservedQuantity: quantity(row.inventoryDetails?.reservedQuantity?.totalReservedQuantity),
        unfulfillableQuantity: quantity(row.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity),
        totalQuantity: quantity(row.totalQuantity), lastUpdatedTime: row.lastUpdatedTime || null, checkedAt, source: "amazon_sp_api", listingInfo: listingInfoBySku.get(row.sellerSku)};
      const inbound=[row.inventoryDetails?.inboundWorkingQuantity,row.inventoryDetails?.inboundShippedQuantity,row.inventoryDetails?.inboundReceivingQuantity].map(quantity);
      item.inboundQuantity=inbound.every(v=>v!==null)?inbound.reduce((a,b)=>a+b,0):null;
      const key = JSON.stringify([item.asin, item.sellerSku, item.fnSku, item.condition]);
      const previous = rowsByKey.get(key);
      if (previous && JSON.stringify({...previous, checkedAt: ""}) !== JSON.stringify({...item, checkedAt: ""})) throw new Error("取得中に対象商品の情報が変わりました。再度確認してください");
      rowsByKey.set(key, item);
    }
    await onProgress({phase: "inventory", pages: pages + inventoryPages, scanned, targets: wanted.size});
    if (data.pagination !== undefined && (!data.pagination || typeof data.pagination !== "object" || Array.isArray(data.pagination))) throw new Error("在庫一覧の続きの形式を確認できません");
    nextToken = data.pagination?.nextToken;
    if (nextToken !== undefined && nextToken !== null && typeof nextToken !== "string") throw new Error("在庫一覧の続きの情報を確認できません");
    if (nextToken && seenTokens.has(nextToken)) throw new Error("在庫一覧が繰り返されています。再度確認してください");
    if (nextToken) seenTokens.add(nextToken);
    await pause(700);
   } while (nextToken);
  }
  return {status: "complete", complete: true, scope: "linked_asins_only", sellerId, accountKey: config.accountKey,
    asins: [...wanted], startedAt, checkedAt: new Date(now()).toISOString(), pages: pages + inventoryPages, scanned,
    items: [...rowsByKey.values()]};
}
