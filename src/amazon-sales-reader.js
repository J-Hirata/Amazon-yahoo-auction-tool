const statuses = new Set(["PENDING_AVAILABILITY", "PENDING", "UNSHIPPED", "PARTIALLY_SHIPPED", "SHIPPED", "CANCELLED", "UNFULFILLABLE"]);
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;

// Orders 2026-01-01 supplies items with the search response. Never request buyer/address datasets.
export async function readAmazonSales({config, targets, after, before, fetchImpl = fetch, now = Date.now, maxPages = 5, maxDurationMs = 40000}) {
  const started = now();
  if (!date(after) || !date(before) || Date.parse(before) < Date.parse(after) || Date.parse(before) > started - 120000 || Date.parse(before) - Date.parse(after) > 7 * 86400000) throw new Error("注文の確認期間を確認してください");
  if (config.marketplaceId !== "A1VC38T7YXB528" || !config.sellerId || !targets?.length || targets.length > 100 || targets.some((t) => !id(t.sellerSku) || !/^[A-Z0-9]{10}$/.test(t.asin))) throw new Error("注文の対象商品と日本の自社アカウントを確認してください");
  const wanted = new Map(targets.map((target) => [target.sellerSku, target.asin]));
  if (wanted.size !== targets.length) throw new Error("注文の対象SKUが重複しています");
  async function request(url, options) {
    const remaining = maxDurationMs - (now() - started);
    if (remaining <= 0) throw new Error("注文確認が時間内に完了しませんでした");
    let response;
    try {response = await fetchImpl(url, {...options, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(15000, remaining)))});}
    catch {throw new Error("注文の接続を確認できません。販売ゼロとは扱いません");}
    if (!response.ok) {await response.body?.cancel(); throw new Error(`注文確認に失敗しました（HTTP ${response.status}）`);}
    try {return await response.json();} catch {throw new Error("注文の応答形式を確認できません");}
  }
  const token = await request("https://api.amazon.com/auth/o2/token", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded;charset=UTF-8"},
    body: new URLSearchParams({grant_type: "refresh_token", refresh_token: config.refreshToken, client_id: config.clientId, client_secret: config.clientSecret})});
  if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 16384) throw new Error("Amazon認証を確認できません");
  const rows = new Map(), seenTokens = new Set();
  let nextToken, pages = 0, scanned = 0;
  do {
    if (++pages > maxPages) throw new Error("注文の確認がページ上限で停止しました。期間を完了済みにはしません");
    const url = new URL("https://sellingpartnerapi-fe.amazon.com/orders/2026-01-01/orders");
    for (const [key, value] of Object.entries({marketplaceIds: config.marketplaceId, lastUpdatedAfter: after, lastUpdatedBefore: before,
      maxResultsPerPage: "100", includedData: "FULFILLMENT,CANCELLATION", ...(nextToken ? {paginationToken: nextToken} : {})})) url.searchParams.set(key, value);
    const data = await request(url, {method: "GET", headers: {"x-amz-access-token": token.access_token, "user-agent": "ASINYahooSalesRead/1.0"}});
    if (!Array.isArray(data.orders) || data.errors?.length || data.orders.length > 100) throw new Error("注文の一覧を確認できません");
    scanned += data.orders.length;
    for (const order of data.orders) {
      if (!Array.isArray(order.orderItems)) throw new Error("注文の商品明細が不足しています");
      for (const item of order.orderItems) {
        const sku = item.product?.sellerSku;
        if (!wanted.has(sku)) continue;
        const channel = order.salesChannel;
        if (channel?.channelName === "NON_AMAZON") continue;
        if (!id(order.orderId) || !id(item.orderItemId) || !date(order.createdTime) || !date(order.lastUpdatedTime) || wanted.get(sku) !== item.product.asin) throw new Error("注文と対象SKUの照合ができません");
        if (Date.parse(order.lastUpdatedTime) < Date.parse(after) || Date.parse(order.lastUpdatedTime) > Date.parse(before) || Date.parse(order.createdTime) > Date.parse(order.lastUpdatedTime)) throw new Error("注文の確認日時が期間と一致しません");
        const quantity = Number.isSafeInteger(item.quantityOrdered) && item.quantityOrdered >= 0 ? item.quantityOrdered : null;
        const status = order.fulfillment?.fulfillmentStatus;
        const uncertain = channel?.channelName !== "AMAZON" || channel.marketplaceId !== config.marketplaceId || !statuses.has(status) || status === "UNFULFILLABLE" || quantity === null ||
          Boolean(item.measurement || order.associatedOrders?.length || item.associatedOrderItems?.length || item.cancellation?.cancellationExecution);
        const row = {orderId: order.orderId, itemId: item.orderItemId, asin: item.product.asin, sellerSku: sku, createdAt: order.createdTime,
          updatedAt: order.lastUpdatedTime, status: uncertain ? "UNKNOWN" : status, quantity,
          fulfillment: ["AMAZON", "MERCHANT"].includes(order.fulfillment?.fulfilledBy) ? order.fulfillment.fulfilledBy : "UNKNOWN"};
        // A full-order cancellation is explicit even if the item also has cancellation metadata.
        if (status === "CANCELLED" && channel?.channelName === "AMAZON" && channel.marketplaceId === config.marketplaceId && quantity !== null) row.status = "CANCELLED";
        const key = JSON.stringify([row.orderId, row.itemId]);
        if (rows.has(key) && JSON.stringify(rows.get(key)) !== JSON.stringify(row)) throw new Error("取得中に同じ注文の内容が変わりました");
        rows.set(key, row);
      }
    }
    if (data.pagination !== undefined && (!data.pagination || typeof data.pagination !== "object" || Array.isArray(data.pagination))) throw new Error("注文の続きの形式を確認できません");
    nextToken = data.pagination?.nextToken;
    if (nextToken !== undefined && (typeof nextToken !== "string" || !nextToken || seenTokens.has(nextToken))) throw new Error("注文の続きが不正か繰り返されています");
    if (nextToken) seenTokens.add(nextToken);
  } while (nextToken);
  return {complete: true, accountKey: config.accountKey, sellerId: config.sellerId, marketplaceId: config.marketplaceId,
    after, before, pages, scanned, rows: [...rows.values()]};
}
