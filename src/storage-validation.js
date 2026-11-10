export function validateMonitorState(state) {
  if (!state || state.version !== 1 || !["catalog", "listings", "links", "events", "logs"].every((key) => Array.isArray(state[key]))) {
    throw new Error("紐付けデータの形式を確認してください");
  }
  if(state.merchantLinks!==undefined&&(!Array.isArray(state.merchantLinks)||state.merchantLinks.length>5000||new Set(state.merchantLinks.map(r=>r?.key)).size!==state.merchantLinks.length||state.merchantLinks.some(r=>!r||! /^(?:link|stock|plan):[0-9a-f-]{36}$|^draft:[A-Z0-9]{10}$/i.test(r.key)||! /^[A-Z0-9]{10}$/.test(r.asin)||typeof r.accountKey!=='string'||!r.accountKey||typeof r.sellerId!=='string'||!r.sellerId||typeof r.sellerSku!=='string'||!r.sellerSku.trim()||r.sellerSku.length>200||!['new','used','parts','unknown'].includes(r.condition)||!Number.isFinite(Date.parse(r.linkedAt)))))throw new Error('Amazon自社発送の紐付けを確認してください');
  if(state.merchantListingSnapshots!==undefined&&(!Array.isArray(state.merchantListingSnapshots)||state.merchantListingSnapshots.length>100||state.merchantListingSnapshots.some(s=>!s||s.status!=='complete'||s.source!=='own_seller_listings'||!Array.isArray(s.asins)||s.asins.length!==1||!Array.isArray(s.rows))))throw new Error('Amazon自社発送の取得情報を確認してください');
  return state;
}

export function validateDraftItems(items) {
  if (!Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || typeof item.asin !== "string" || !item.asin)) {
    throw new Error("下書き商品のデータ形式を確認してください");
  }
  if(items.some(item=>item.workPriority!==undefined&&(!Number.isSafeInteger(item.workPriority)||item.workPriority<0||item.workPriority>1000000)))throw new Error('下書きの作業順を確認してください');
  if (new Set(items.map((item) => item.asin)).size !== items.length) throw new Error("下書き商品に重複したASINがあります");
  return items;
}
