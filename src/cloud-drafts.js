import {splitDraftQueue, findPriceReviewItems} from "./queue.js";
import {CONFIG} from "./config.js";
import {calculateAuctionPrices} from "./pricing.js";
import {buildItemsFromAsins} from "./amazon.js";
import {buildYahooDraft} from "./draft.js";
import {buildDraftCsv} from "./csv.js";

export {buildYahooDraft, buildDraftCsv};
export function draftView({state, revision}) {
  return {items: state, queue: splitDraftQueue(state), priceReviews: findPriceReviewItems(state), config: CONFIG,
    storage: {backend: "postgres", revision}, capabilities: {cloud: true, externalReads: false}};
}
export async function addDrafts(state, value, at) {
  const asins = [...new Set(String(value || "").split(/[\s,]+/).filter(Boolean).map((asin) => asin.toUpperCase()))];
  if (!asins.length || asins.length > 50 || asins.some((asin) => !/^[A-Z0-9]{10}$/.test(asin))) throw new Error("ASINを1〜50件、英数字10文字で入力してください");
  const existing = new Set(state.map((item) => item.asin));
  for (const item of await buildItemsFromAsins(asins.filter((asin) => !existing.has(asin)))) state.push({...item, createdAt: at, updatedAt: at});
}
export function patchDraft(state, asin, patch, at) {
  const item = state.find((entry) => entry.asin === asin);
  if (!item) throw new Error("商品が見つかりません");
  const allowed = new Set(["title", "description", "imageUrls", "usedLowestPrice", "status", "draftSavedAt"]);
  if (!patch || Object.keys(patch).some((key) => !allowed.has(key))) throw new Error("変更する項目を確認してください");
  const next = {...item};
  for (const [key, limit] of [["title", 500], ["description", 20000]]) if (key in patch) {
    if (typeof patch[key] !== "string" || patch[key].length > limit) throw new Error("商品名・説明の長さを確認してください");
    next[key] = patch[key];
  }
  if ("imageUrls" in patch) {
    const urls = Array.isArray(patch.imageUrls) ? patch.imageUrls : String(patch.imageUrls).split(/\r?\n/);
    next.imageUrls = urls.map((value) => String(value).trim()).filter(Boolean);
    if (next.imageUrls.length > 20 || next.imageUrls.some((value) => {
      try {const url = new URL(value); return value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port || !(["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-fe.ssl-images-amazon.com"].includes(url.hostname) || url.hostname.endsWith(".yimg.jp"));}
      catch {return true;}
    })) throw new Error("対応するAmazon・ヤフオクの画像URLを確認してください");
  }
  if ("usedLowestPrice" in patch) {
    const price = patch.usedLowestPrice === "" || patch.usedLowestPrice === null ? null : Number(patch.usedLowestPrice);
    if (price !== null && (!Number.isFinite(price) || price <= 0 || price > 100000000)) throw new Error("参考価格を確認してください");
    next.usedLowestPrice = price;
    Object.assign(next, calculateAuctionPrices(price, CONFIG));
  }
  if ("status" in patch) {
    if (!["ready_for_draft", "waiting_for_product_data", "draft_saved", "listed", "sold", "archived"].includes(patch.status)) throw new Error("商品の作業状態を確認してください");
    next.status = patch.status;
    if (patch.status !== item.status) {
      if (patch.status === "draft_saved") next.draftSavedAt = at;
      if (patch.status === "listed") next.listedAt = at;
      if (patch.status === "sold") next.soldAt = at;
      if (patch.status === "ready_for_draft" && item.status === "draft_saved") next.draftSavedAt = null;
    }
  }
  if ("draftSavedAt" in patch && !(patch.draftSavedAt === null && patch.status === "ready_for_draft")) throw new Error("保存完了時刻の直接変更はできません");
  next.updatedAt = at;
  Object.assign(item, next);
}
