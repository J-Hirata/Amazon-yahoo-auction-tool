export function calculateAuctionPrices(usedLowestPrice, config) {
  if (!Number.isFinite(usedLowestPrice) || usedLowestPrice <= 0) {
    return { startPrice: null, stalePrice: null };
  }

  const startPrice = roundToYen(usedLowestPrice * (1 - config.initialDiscountRate));
  const stalePrice = roundToYen(startPrice * (1 - config.staleDiscountRate));
  return { startPrice, stalePrice };
}

function roundToYen(value) {
  return Math.max(1, Math.floor(value));
}
