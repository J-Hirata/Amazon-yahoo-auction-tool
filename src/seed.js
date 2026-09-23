import { saveItems } from "./store.js";
import { calculateAuctionPrices } from "./pricing.js";
import { CONFIG } from "./config.js";

const now = new Date().toISOString();
const samples = [
  sample("B0DUMMY001", "サンプル商品 1", 3200),
  sample("B0DUMMY002", "サンプル商品 2", 4980),
  sample("B0DUMMY003", "サンプル商品 3", 12800)
];

await saveItems(samples);
console.log("サンプルデータを作成しました。");

function sample(asin, title, usedLowestPrice) {
  const prices = calculateAuctionPrices(usedLowestPrice, CONFIG);
  return {
    asin,
    title,
    description: "Amazon商品情報を取得したあと、ここに説明文が入ります。",
    imageUrls: [],
    amazonUrl: `https://www.amazon.co.jp/dp/${asin}`,
    usedLowestPrice,
    startPrice: prices.startPrice,
    stalePrice: prices.stalePrice,
    sourceRegion: CONFIG.sourceRegion,
    shippingIncluded: CONFIG.shippingIncluded,
    shipAfterDaysMin: CONFIG.shipAfterDaysMin,
    shipAfterDaysMax: CONFIG.shipAfterDaysMax,
    status: "ready_for_draft",
    createdAt: now,
    updatedAt: now
  };
}
