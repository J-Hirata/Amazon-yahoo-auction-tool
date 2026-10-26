const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const quantity = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const family = (v) => /^new/i.test(v || "") ? "new" : /^used/i.test(v || "") ? "used" : "unknown";
export const amazonConditionLabel = (v) => ({new:"新品",used:"中古",unknown:"状態不明"})[family(v)];

// Authenticated seller's Listings Items only. Never inspect the retail Buy Box.
export async function readOwnAmazonListings({asins, config, fetchImpl = fetch, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)), maxPages = 5}) {
  const targets = [...new Set(asins)];
  if (!targets.length || targets.length > 20 || targets.some((a) => !/^[A-Z0-9]{10}$/.test(a)) || !/^[A-Z0-9]+$/.test(config.sellerId || "") || config.marketplaceId !== "A1VC38T7YXB528") throw fail("登録ASINと接続済みの自社出品者を確認してください");
  const startedAt = new Date(now()).toISOString(), deadline = now() + 35000;
  async function request(url, options) {
    if (now() >= deadline) throw fail("自社出品の取得時間を超えました");
    let response;
    try {response = await fetchImpl(url, {...options, redirect:"error", signal:AbortSignal.timeout(Math.max(1, Math.min(12000, deadline - now())))});} catch {throw fail("Amazonの自社出品に接続できません");}
    if (!response.ok) throw fail(`Amazonの自社出品を取得できません（HTTP ${response.status}）`);
    try {return await response.json();} catch {throw fail("自社出品の応答を確認できません");}
  }
  const token = await request("https://api.amazon.com/auth/o2/token", {method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:config.refreshToken,client_id:config.clientId,client_secret:config.clientSecret})});
  if (!token.access_token || typeof token.access_token !== "string") throw fail("Amazon認証を確認できません");
  const rows = new Map(), seen = new Set(); let pageToken, pages = 0, expected = 0;
  do {
    if (++pages > maxPages) throw fail("自社出品を最後まで取得できませんでした");
    const url = new URL(`https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${config.sellerId}`);
    for (const [key,value] of Object.entries({marketplaceIds:config.marketplaceId,identifiersType:"ASIN",identifiers:targets.join(","),includedData:"summaries,fulfillmentAvailability",pageSize:"20",...(pageToken ? {pageToken} : {})})) url.searchParams.set(key,value);
    const data = await request(url,{method:"GET",headers:{"x-amz-access-token":token.access_token}});
    if (!Array.isArray(data.items) || data.errors?.length || !Number.isSafeInteger(data.numberOfResults) || data.numberOfResults < 0) throw fail("自社出品の取得結果を確認できません");
    if (Number.isSafeInteger(data.numberOfResults)) expected = Math.max(expected,data.numberOfResults);
    for (const item of data.items) {
      const summaries = item.summaries?.filter((s) => s.marketplaceId === config.marketplaceId) || [];
      if (summaries.length !== 1 || !targets.includes(summaries[0].asin) || typeof item.sku !== "string" || !item.sku || !Array.isArray(summaries[0].status) || summaries[0].status.some((s) => typeof s !== "string")) throw fail("自社出品のASIN・SKU・状態を確認できません");
      const s = summaries[0];
      if (item.fulfillmentAvailability !== undefined && !Array.isArray(item.fulfillmentAvailability)) throw fail("発送方法の応答を確認できません");
      const row = {asin:s.asin,sellerSku:item.sku,condition:typeof s.conditionType === "string" ? s.conditionType : "",statuses:s.status,
        fulfillment:(item.fulfillmentAvailability || []).map((f) => ({channel: typeof f.fulfillmentChannelCode === "string" ? f.fulfillmentChannelCode : "",quantity:quantity(f.quantity)}))};
      if (rows.has(item.sku) && JSON.stringify(rows.get(item.sku)) !== JSON.stringify(row)) throw fail("取得中に同じSKUの出品情報が変わりました");
      rows.set(item.sku,row);
    }
    pageToken = data.pagination?.nextToken;
    if (pageToken && (typeof pageToken !== "string" || seen.has(pageToken))) throw fail("自社出品の続きが繰り返されています");
    if (pageToken) {seen.add(pageToken);await wait(550);}
  } while (pageToken);
  if (rows.size < expected) throw fail("自社出品を最後まで取得できませんでした");
  return {version:1,status:"complete",source:"own_seller_listings",sellerId:config.sellerId,accountKey:config.accountKey,marketplaceId:config.marketplaceId,asins:targets,rows:[...rows.values()],startedAt,checkedAt:new Date(now()).toISOString(),pages};
}

export function stockAmazonView(product, snapshot, at = new Date().toISOString(), account = {}) {
  const empty = {status:"unknown",label:"自社出品は未確認",offers:[],matchingSkus:[],checkedAt:null};
  if (!product.asin) return {...empty,status:"no_asin",label:"ASIN未登録"};
  if (!snapshot) return empty;
  if (snapshot.status !== "complete") return {...empty,label:"取得できず・要再確認",error:snapshot.error};
  if (snapshot.source !== "own_seller_listings" || !snapshot.sellerId || !snapshot.accountKey || !account.amazonSellerId || !account.amazonAccountKey || snapshot.sellerId !== account.amazonSellerId || snapshot.accountKey !== account.amazonAccountKey || snapshot.marketplaceId !== "A1VC38T7YXB528") return {...empty,label:"自社アカウントの確認が必要"};
  if (!snapshot.asins?.includes(product.asin)) return empty;
  const age = Date.parse(at) - Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 90 * 60000) return {...empty,status:"stale",label:"自社出品情報を再確認",checkedAt:snapshot.checkedAt};
  const offers = (snapshot.rows || []).filter((r) => r.asin === product.asin).map((r) => ({...r,conditionLabel:amazonConditionLabel(r.condition),buyable:r.statuses.includes("BUYABLE"),
    shippingLabel:[...new Set(r.fulfillment.map((f) => f.channel === "DEFAULT" ? "自己発送" : f.channel.startsWith("AMAZON") ? "FBA" : "発送方法未確認"))].join("・") || "発送方法未確認"}));
  const matches = offers.filter((r) => ["new","used"].includes(product.condition) && family(r.condition) === product.condition && (!product.sellerSku || r.sellerSku === product.sellerSku));
  if (!offers.length) return {...empty,status:"not_found",label:"自社出品を確認できず",checkedAt:snapshot.checkedAt};
  return {status:matches.length ? matches.some((r) => r.buyable) ? "buyable" : "present" : "variant_mismatch",label:matches.length ? matches.some((r) => r.buyable) ? "販売中の自社出品あり" : "自社出品あり・購入可否要確認" : "別の状態・SKUの自社出品あり",
    offers,matchingSkus:matches.map((r) => r.sellerSku),checkedAt:snapshot.checkedAt,variantWarning:matches.length ? "" : `在庫登録は${({new:"新品",used:"中古",parts:"部品・現状品",unknown:"状態未確認"})[product.condition]}です。Amazonの状態・SKUと確認してください。`};
}

export function createStockAmazonRefresh({store, monitorStore, config, readListings = readOwnAmazonListings, now = () => new Date().toISOString()}) {
  return async ({expectedRevision,actor}) => {
    const snapshot = await store.readSnapshot(), account = await monitorStore.read();
    if (snapshot.revision !== expectedRevision) throw fail("最新の在庫一覧を読み込んでください",409);
    if (account.amazonAccountKey !== config.accountKey || !account.amazonSellerId || config.sellerId && config.sellerId !== account.amazonSellerId) throw fail("接続済みの御社Amazonアカウントとの一致を確認してください",409);
    const targets = [...new Set(snapshot.state.products.map((p) => p.asin).filter(Boolean))];
    if (!targets.length) throw fail("ASINが登録された商品がありません");
    if (targets.length > 20) throw fail("現在は20 ASINまでの確認に対応しています。対象分割の対応が必要です。");
    let result;
    try {
      result = await readListings({asins:targets,config:{...config,sellerId:account.amazonSellerId}});
      if (result.status !== "complete" || result.source !== "own_seller_listings" || result.marketplaceId !== "A1VC38T7YXB528" || result.sellerId !== account.amazonSellerId || result.accountKey !== config.accountKey || JSON.stringify(result.asins) !== JSON.stringify(targets)) throw fail("自社出品の確認範囲が一致しません");
    } catch {result = {...snapshot.state.amazonListings,version:1,status:"failed",error:"自社出品を取得できませんでした。在庫ゼロ・未出品とは判断しません。",attemptedAt:now()};}
    await store.update((state) => {
      state.amazonListings = {...result,actor,attemptedAt:now()};
    },{expectedRevision});
    return {status:result.status,checkedAsins:result.status === "complete" ? result.asins.length : 0,offers:result.status === "complete" ? result.rows.length : 0,error:result.error || ""};
  };
}
