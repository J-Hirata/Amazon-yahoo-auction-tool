const AMAZON_HOST = "https://www.amazon.co.jp";

export async function fetchAmazonProductPage(asin) {
  const url = `${AMAZON_HOST}/dp/${encodeURIComponent(asin)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
      }
    });

    const html = await response.text();
    if (!response.ok) {
      return {
        asin,
        ok: false,
        message: `Amazonページの取得に失敗しました: HTTP ${response.status}`
      };
    }

    const item = parseAmazonProductPage(asin, html, url);
    if (!item.title && !item.imageUrls.length) {
      return {
        asin,
        ok: false,
        message: "Amazonページは取得できましたが、商品情報を読み取れませんでした。ログイン確認・年齢確認・一時ブロック画面の可能性があります。"
      };
    }

    return {
      asin,
      ok: true,
      item,
      message: item.usedLowestPrice ? "Amazon商品ページから取得しました。" : "商品情報は取得しましたが、中古最安値は読み取れませんでした。価格を確認してください。"
    };
  } catch (error) {
    return {
      asin,
      ok: false,
      message: error.name === "AbortError"
        ? "Amazonページの取得がタイムアウトしました。"
        : `Amazonページの取得に失敗しました: ${error.message}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseAmazonProductPage(asin, html, amazonUrl = `${AMAZON_HOST}/dp/${asin}`) {
  const title = cleanText(
    byIdText(html, "productTitle") ||
    metaContent(html, "og:title") ||
    titleText(html).replace(/^Amazon\.co\.jp\s*:\s*/i, "")
  );
  const imageUrls = collectImages(html);
  const features = collectFeatureBullets(html);
  const details = collectProductDetails(html);
  const description = normalizeProductDescription([
    details.join("\n"),
    features.join("\n"),
    byIdText(html, "productDescription"),
    byIdText(html, "bookDescription_feature_div")
  ].filter(Boolean).join("\n\n"));
  const usedLowestPrice = findUsedLowestPrice(html) || findPrimaryPrice(html);

  return {
    asin,
    title,
    description,
    imageUrls,
    amazonUrl,
    usedLowestPrice,
    status: usedLowestPrice ? "ready_for_draft" : "waiting_for_product_data"
  };
}

function byIdText(html, id) {
  const block = html.match(new RegExp(`<[^>]+id=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  return block ? cleanText(stripTags(block[1])) : "";
}

function titleText(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(decodeHtml(match[1])) : "";
}

function metaContent(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeRegExp(property)}["'][^>]*>`, "i");
  return decodeHtml((html.match(pattern) || html.match(reverse) || [])[1] || "");
}

function collectImages(html) {
  const primaryImages = [];
  const fallbackImages = [];
  for (const match of html.matchAll(/<img[^>]+id=["']landingImage["'][^>]+(?:src|data-old-hires)=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
    primaryImages.push(decodeHtml(match[1]));
  }
  for (const match of html.matchAll(/<img[^>]+(?:src|data-old-hires)=["'](https?:\/\/[^"']+)["'][^>]*id=["']landingImage["'][^>]*>/gi)) {
    primaryImages.push(decodeHtml(match[1]));
  }

  const ogImage = metaContent(html, "og:image");
  if (ogImage) primaryImages.push(ogImage);

  for (const match of html.matchAll(/data-a-dynamic-image=["']([^"']+)["']/gi)) {
    const decoded = decodeHtml(match[1]);
    try {
      const parsed = JSON.parse(decoded);
      for (const url of Object.keys(parsed)) primaryImages.push(url);
    } catch {
      for (const url of decoded.matchAll(/https?:\/\/[^"',\\]+/g)) primaryImages.push(url[0]);
    }
  }

  for (const match of html.matchAll(/<img[^>]+(?:src|data-old-hires)=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
    fallbackImages.push(decodeHtml(match[1]));
  }

  const images = primaryImages.some(isLikelyProductImage) ? primaryImages : fallbackImages;
  const filtered = uniqueImages(images).filter(isLikelyProductImage);
  const preferred = filtered.filter((url) => /^https?:\/\/m\.media-amazon\.com\/images\/I\//i.test(url));
  return (preferred.length ? preferred : filtered).slice(0, 10);
}

function isLikelyProductImage(url) {
  const value = String(url || "");
  if (!/^https?:\/\/(?:m\.media-amazon|images-(?:fe|na)\.ssl-images-amazon)\.com\/images\/I\//i.test(value)) return false;
  if (/\.(?:svg|gif)(?:[?#]|$)/i.test(value)) return false;
  if (/grey-pixel|sprite|nav-sprite|prime|yourprime|logo|fallback|sash|marketing|x-locale|al-jp/i.test(value)) return false;
  return true;
}

function uniqueImages(urls) {
  const byKey = new Map();
  for (const url of urls.filter(Boolean)) {
    const key = imageKey(url);
    if (!byKey.has(key) || imageScore(url) > imageScore(byKey.get(key))) byKey.set(key, url);
  }
  return [...byKey.values()];
}

function imageKey(url) {
  return String(url)
    .replace(/\._[^./]+_\./, ".")
    .replace(/\._[^./]+_(?=\.[a-z]{3,4}$)/i, "")
    .replace(/SS\d+/gi, "")
    .replace(/SX\d+/gi, "")
    .replace(/SY\d+/gi, "");
}

function imageScore(url) {
  const nums = [...String(url).matchAll(/(?:SS|SX|SY|UL|AC)_(?:[^0-9]*)(\d+)/gi)].map((match) => Number(match[1]));
  return nums.length ? Math.max(...nums) : 999;
}

function collectFeatureBullets(html) {
  const section = sectionById(html, "feature-bullets");
  if (!section) return [];
  return [...section.matchAll(/<li[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/gi)]
    .map((match) => cleanText(stripTags(match[1])))
    .filter((line) => line && !isAmazonSpecificLine(line))
    .slice(0, 12);
}

function collectProductDetails(html) {
  const sections = [
    sectionById(html, "productOverview_feature_div"),
    sectionById(html, "detailBullets_feature_div"),
    sectionById(html, "detailBulletsWrapper_feature_div"),
    sectionById(html, "prodDetails"),
    sectionById(html, "productDetails_techSpec_section_1"),
    sectionById(html, "productDetails_detailBullets_sections1")
  ].filter(Boolean);

  const rows = [];
  for (const section of sections) {
    for (const match of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...match[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
        .map((cell) => cleanText(stripTags(cell[1])))
        .filter(Boolean);
      if (cells.length >= 2) rows.push([cells[0], cells.slice(1).join(" ")]);
    }

    for (const match of section.matchAll(/<li[^>]*>\s*<span[^>]*class=["'][^"']*a-text-bold[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/gi)) {
      rows.push([cleanText(stripTags(match[1])), cleanText(stripTags(match[2]))]);
    }

    for (const match of section.matchAll(/<span[^>]+class=["'][^"']*a-text-bold[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/gi)) {
      rows.push([cleanText(stripTags(match[1])), cleanText(stripTags(match[2]))]);
    }
  }

  const byLabel = new Map();
  for (const [rawLabel, rawValue] of rows) {
    const label = cleanDetailLabel(rawLabel);
    const value = cleanText(rawValue);
    if (!label || !value || label === value || isAmazonSpecificLine(`${label} ${value}`)) continue;
    if (!isUsefulDetail(label, value)) continue;
    if (!byLabel.has(label)) byLabel.set(label, value);
  }

  return [...byLabel.entries()].map(([label, value]) => `${label}: ${value}`).slice(0, 18);
}

function cleanDetailLabel(value) {
  return cleanText(value)
    .replace(/[：:]\s*$/, "")
    .replace(/^・/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulDetail(label, value) {
  const text = `${label} ${value}`;
  return [
    "ブランド",
    "ブランド名",
    "メーカー",
    "メーカー名",
    "画面サイズ",
    "サイズ",
    "重量",
    "商品の重量",
    "解像度",
    "最大解像度",
    "ネイティブ解像度",
    "リフレッシュレート",
    "インターフェース",
    "接続",
    "互換",
    "色",
    "カラー",
    "素材",
    "容量",
    "型番",
    "品番",
    "UPC",
    "ユニット数"
  ].some((keyword) => text.includes(keyword)) || /\d/.test(value);
}

function normalizeProductDescription(value) {
  return String(value || "")
    .replace(/質問[:：]/g, "\n質問:")
    .replace(/回答[:：]/g, "\n回答:")
    .split(/\r?\n|。/)
    .map((line) => cleanText(line).replace(/^・/, ""))
    .filter(Boolean)
    .filter((line) => !isAmazonSpecificLine(line))
    .filter((line) => line.length <= 140)
    .slice(0, 10)
    .join("\n");
}

function isAmazonSpecificLine(line) {
  return [
    "保証",
    "返品",
    "返金",
    "Amazon",
    "アマゾン",
    "Prime",
    "質問",
    "回答",
    "カスタマー",
    "レビュー",
    "ランキング",
    "詳細はこちら",
    "おすすめ",
    "メーカー保証",
    "COM-ET",
    "Web:",
    "http",
    "お客様",
    "ご希望",
    "定期的",
    "交換をお願いします",
    "使用できない理由",
    "業務用",
    "公衆浴場",
    "直射日光",
    "寿命"
  ].some((keyword) => line.includes(keyword));
}

function findUsedLowestPrice(html) {
  const text = cleanText(stripTags(html));
  const candidates = [];
  const patterns = [
    /中古(?:品)?[^￥¥]{0,80}[￥¥]\s*([\d,]+)/g,
    /[￥¥]\s*([\d,]+)[^。]{0,80}中古(?:品)?/g,
    /used[^$￥¥]{0,80}[￥¥]\s*([\d,]+)/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) candidates.push(numberOrNull(match[1]));
  }

  return minPrice(candidates);
}

function findPrimaryPrice(html) {
  const candidates = [];
  const priceBlocks = [
    ...html.matchAll(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi),
    ...html.matchAll(/<span[^>]+id=["']priceblock_[^"']+["'][^>]*>([\s\S]*?)<\/span>/gi)
  ];

  for (const match of priceBlocks) {
    const price = numberOrNull(stripTags(match[1]));
    if (price) candidates.push(price);
  }

  return minPrice(candidates);
}

function minPrice(values) {
  const prices = values.filter((value) => Number.isFinite(value) && value > 0);
  return prices.length ? Math.min(...prices) : null;
}

function numberOrNull(value) {
  const parsed = Number(String(value || "").replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sectionById(html, id) {
  const start = html.search(new RegExp(`<[^>]+id=["']${escapeRegExp(id)}["'][^>]*>`, "i"));
  if (start < 0) return "";
  return html.slice(start, Math.min(html.length, start + 20000));
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function cleanText(value) {
  return decodeHtml(String(value || "")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
