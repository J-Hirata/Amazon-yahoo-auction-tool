import { fetchAmazonProductPage } from "./amazon-page-scraper.js";

export async function fetchProductData(asin) {
  if (!process.env.AMAZON_PRODUCT_DATA_URL) {
    return fetchAmazonProductPage(asin);
  }

  const endpoint = new URL(process.env.AMAZON_PRODUCT_DATA_URL);
  endpoint.searchParams.set("asin", asin);

  const headers = { Accept: "application/json" };
  if (process.env.AMAZON_PRODUCT_DATA_TOKEN) {
    headers.Authorization = `Bearer ${process.env.AMAZON_PRODUCT_DATA_TOKEN}`;
  }

  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    return {
      asin,
      ok: false,
      message: `商品データ取得に失敗しました: HTTP ${response.status}`
    };
  }

  const data = await response.json();
  return {
    asin,
    ok: true,
    item: normalizeProductData(asin, data),
    message: "商品データAPIから取得しました。"
  };
}

function normalizeProductData(asin, data) {
  const usedLowestPrice = numberOrNull(data.usedLowestPrice ?? data.used_lowest_price ?? data.price);
  return {
    asin,
    title: data.title || data.name || "",
    description: data.description || normalizeFeatures(data.features),
    imageUrls: normalizeImages(data.imageUrls || data.images || data.image_urls),
    usedLowestPrice,
    status: usedLowestPrice ? "ready_for_draft" : "waiting_for_product_data"
  };
}

function normalizeFeatures(features) {
  if (!Array.isArray(features)) return "";
  return features.filter(Boolean).map((feature) => `・${feature}`).join("\n");
}

function normalizeImages(images) {
  if (!images) return [];
  if (Array.isArray(images)) {
    return images
      .map((image) => typeof image === "string" ? image : image.url || image.large || image.medium)
      .filter(Boolean);
  }
  return String(images).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function numberOrNull(value) {
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
