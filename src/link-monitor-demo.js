import {emptyMonitor, normalizeCatalog, confirmLink, observeListing, registerSuccessor, runPreview} from "./link-monitor.js";
export function demoMonitor(at) {
  const state = emptyMonitor();
  const item = normalizeCatalog({sellerAccount: "練習用アカウント", marketplaceId: "JP-DEMO", sellerSku: "DEMO-USED-001", asin: "B000DEMO01", fnSku: "DEMO-FNSKU", title: "練習用モニター（実在商品ではありません）", condition: "中古・良い", setContents: "本体と電源コード、スタンドなし", fulfillableQuantity: 5, externalCommitments: 0, mcfEligibility: "verified", checkedAt: at});
  state.catalog.push(item);
  item.source = "test";
  observeListing(state, {listingId: "d1000000001", url: "https://auctions.yahoo.co.jp/jp/auction/d1000000001", title: item.title, seller: "練習用出品者", references: [{kind: "asin", value: item.asin}], description: `【管理番号】\nASIN: ${item.asin}`, observation: {status: "active", verified: true, reason: "unknown", checkedAt: at, source: "test", evidence: "練習用データ"}});
  confirmLink(state, {listingId: state.listings[0].listingId, catalogId: item.id, reviewed: true}, at);
  return state;
}
export function advanceDemo(state, scenario, at) {
  const product = state.catalog[0];
  const link = state.links[0];
  const listing = state.listings[0];
  const steps = [];
  const check = (label, inventory, status = "active", extra = {}) => {
    at = new Date(Date.parse(at) + 1000).toISOString();
    Object.assign(product, {fulfillableQuantity: inventory, checkedAt: at, error: undefined, ...extra});
    observeListing(state, {...listing, observation: {status, verified: true, checkedAt: at, source: "test", reason: status === "stopped" ? "手動停止（練習）" : "unknown", evidence: "練習用データ"}});
    const created = runPreview(state, at);
    steps.push({label, events: created.length});
  };
  check("最初の確認", 5);
  if (["zero", "mail_failed", "mail_retry"].includes(scenario)) check("在庫5→0", 0);
  else if (scenario === "decreased") check("在庫5→4（販売と断定しない）", 4);
  else if (scenario === "repeat") { check("在庫5→0", 0); check("0のまま再確認", 0); }
  else if (scenario === "recovery") {check("在庫5→0", 0); check("在庫復帰", 3); check("再び0", 0);}
  else if (scenario === "ended") {check("終了を検知", 5, "ended"); check("終了を再確認", 5, "ended");}
  else if (scenario === "stopped") {check("停止を検知", 5, "stopped"); check("停止を再確認", 5, "stopped");}
  else if (scenario === "failed") check("在庫の取得失敗", null, "active", {error: "Amazon在庫を取得できません（練習）"});
  else if (scenario === "mismatch") {product.setContents = "別セットに変更"; check("商品内容が変わった", 5);}
  else if (scenario === "relisted") {
    const next = {...listing, listingId: "d1000000002", url: "https://auctions.yahoo.co.jp/jp/auction/d1000000002"};
    observeListing(state, next);
    registerSuccessor(state, link.id, {listingId: next.listingId, evidence: "同一商品・出品者・管理番号を確認（練習）", reviewed: true}, at);
    steps.push({label: "根拠を確認し再出品IDを引継ぎ", events: runPreview(state, at).length});
  }
  return steps;
}
