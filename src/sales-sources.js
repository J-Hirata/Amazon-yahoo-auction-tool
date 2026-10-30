const family = value => /^new/i.test(value || "") ? "new" : /^used/i.test(value || "") ? "used" : "unknown";

// A sales target is a seller SKU, never the retail offer or a guessed physical quantity.
export function resolveSalesSources(sources, snapshot, config) {
  if (snapshot?.status !== "complete" || snapshot.source !== "own_seller_listings" || snapshot.accountKey !== config.accountKey || snapshot.sellerId !== config.sellerId || snapshot.marketplaceId !== config.marketplaceId) throw new Error("自社出品のアカウントと取得完了を確認してください");
  const targets = [], unresolved = [];
  for (const source of sources) {
    if (!snapshot.asins.includes(source.asin)) throw new Error("登録商品の取得範囲が一致しません");
    const rows = snapshot.rows.filter(row => row.asin === source.asin && (!source.sellerSku || row.sellerSku === source.sellerSku) &&
      (!["new", "used"].includes(source.condition) || family(row.condition) === source.condition));
    if (!rows.length) unresolved.push({sourceId:source.sourceId,asin:source.asin,title:source.title,reason:"対象の自社SKUを確認できません"});
    for (const row of rows) targets.push({sourceId:source.sourceId,...(source.linkId ? {linkId:source.linkId} : {}),asin:row.asin,sellerSku:row.sellerSku,condition:row.condition || "unknown",title:source.title || row.asin,
      fulfillment:row.fulfillment.map(f=>f.channel === "DEFAULT" ? "MERCHANT" : f.channel.startsWith("AMAZON") ? "AMAZON" : "UNKNOWN")});
  }
  if (new Set(targets.map(t=>t.sellerSku)).size > 100) throw new Error("追跡対象は100 SKUまでです。対象分割が必要です");
  return {version:1,accountKey:config.accountKey,sellerId:config.sellerId,marketplaceId:config.marketplaceId,checkedAt:snapshot.checkedAt,targets,unresolved};
}
