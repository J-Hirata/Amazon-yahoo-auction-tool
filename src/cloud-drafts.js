import {splitDraftQueue, findPriceReviewItems} from "./queue.js";
import {CONFIG} from "./config.js";
import {calculateAuctionPrices} from "./pricing.js";
import {buildItemsFromAsins} from "./amazon.js";
import {buildYahooDraft} from "./draft.js";
import {buildDraftCsv} from "./csv.js";
import {changeDraftStatus} from './draft-workflow.js';

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
  const allowed = new Set(["title", "description", "imageUrls", "usedLowestPrice", "status", "draftSavedAt", "restore", "saveConfirmed"]);
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
  changeDraftStatus(next,item,patch,at);
  if ("draftSavedAt" in patch && !(patch.draftSavedAt === null && patch.status === "ready_for_draft")) throw new Error("保存完了時刻の直接変更はできません");
  if(JSON.stringify(next)===JSON.stringify(item))return;
  next.updatedAt = at;
  Object.assign(item, next);
}

export function batchDraftAction(state,{asins,action},at){
  if(!['archive','restore'].includes(action)||!Array.isArray(asins)||!asins.length||asins.length>200||asins.some(a=>typeof a!=='string'||!/^[A-Z0-9]{10}$/.test(a))||new Set(asins).size!==asins.length)throw new Error('対象商品と操作を確認してください（1〜200件）');
  if(asins.some(asin=>!state.some(i=>i.asin===asin)))throw new Error('商品が見つかりません。一覧を更新してください');
  const copy=structuredClone(state);
  for(const asin of asins)patchDraft(copy,asin,action==='restore'?{restore:true}:{status:'archived'},at);
  state.splice(0,state.length,...copy);
}
