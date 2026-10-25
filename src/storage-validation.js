export function validateMonitorState(state) {
  if (!state || state.version !== 1 || !["catalog", "listings", "links", "events", "logs"].every((key) => Array.isArray(state[key]))) {
    throw new Error("紐付けデータの形式を確認してください");
  }
  return state;
}

export function validateDraftItems(items) {
  if (!Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || typeof item.asin !== "string" || !item.asin)) {
    throw new Error("下書き商品のデータ形式を確認してください");
  }
  if (new Set(items.map((item) => item.asin)).size !== items.length) throw new Error("下書き商品に重複したASINがあります");
  return items;
}
