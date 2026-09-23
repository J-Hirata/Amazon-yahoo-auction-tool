import { calculateAuctionPrices } from "./pricing.js";
import { CONFIG } from "./config.js";

export async function buildItemsFromAsins(asins) {
  const now = new Date().toISOString();
  return asins.map((asin) => {
    const usedLowestPrice = null;
    const prices = calculateAuctionPrices(usedLowestPrice, CONFIG);
    return {
      asin,
      title: "",
      description: "",
      imageUrls: [],
      amazonUrl: `https://www.amazon.co.jp/dp/${encodeURIComponent(asin)}`,
      usedLowestPrice,
      startPrice: prices.startPrice,
      stalePrice: prices.stalePrice,
      sourceRegion: CONFIG.sourceRegion,
      shippingIncluded: CONFIG.shippingIncluded,
      shipAfterDaysMin: CONFIG.shipAfterDaysMin,
      shipAfterDaysMax: CONFIG.shipAfterDaysMax,
      status: "waiting_for_product_data",
      createdAt: now,
      updatedAt: now
    };
  });
}
