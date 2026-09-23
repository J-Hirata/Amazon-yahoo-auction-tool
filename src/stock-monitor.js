const AMAZON_HOST = "https://www.amazon.co.jp";
const DEFAULT_SELLER = "キャットコーポレーション合同会社";

export function normalizeWatchAsins(input) {
  return String(input || "")
    .split(/\r?\n/)
    .map((asin) => asin.trim().toUpperCase())
    .filter(Boolean)
    .filter((asin, index, all) => /^[A-Z0-9]{10}$/.test(asin) && all.indexOf(asin) === index);
}

export async function checkStockWatchItem(item) {
  const amazonUrl = item.amazonUrl || `${AMAZON_HOST}/dp/${encodeURIComponent(item.asin)}`;
  const now = new Date().toISOString();
  try {
    const response = await fetch(amazonUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
      }
    });
    const html = await response.text();
    if (!response.ok) return checked(item, now, "needs_attention", `Amazonページ取得失敗 HTTP ${response.status}`, amazonUrl);

    const text = cleanText(stripTags(html));
    const sellerName = item.sellerName || DEFAULT_SELLER;
    const sellerFound = text.includes(sellerName);
    const fbaFound = hasFbaSignal(text, sellerName);
    const unavailable = isUnavailableText(text);
    const price = findPrice(text);
    const title = findTitle(html) || item.title || item.asin;

    if (!sellerFound) {
      return checked(item, now, "needs_attention", "自社セラー名がAmazonページ上で確認できません。FBA出品が消えている可能性があります。", amazonUrl, {
        title,
        price,
        sellerFound,
        fbaFound,
        unavailable
      });
    }
    if (!fbaFound) {
      return checked(item, now, "needs_attention", "自社セラー名はありますが、Amazon発送/FBA出品として確認できません。自社発送のみの可能性があります。", amazonUrl, {
        title,
        price,
        sellerFound,
        fbaFound,
        unavailable
      });
    }
    if (unavailable) {
      return checked(item, now, "needs_attention", "在庫切れ・販売不可の可能性があります。", amazonUrl, {
        title,
        price,
        sellerFound,
        fbaFound,
        unavailable
      });
    }
    return checked(item, now, "watching", "自社FBA出品を確認しました。", amazonUrl, {
      title,
      price,
      sellerFound,
      fbaFound,
      unavailable
    });
  } catch (error) {
    return checked(item, now, "needs_attention", `確認に失敗しました: ${error.message}`, amazonUrl);
  }
}

export function needsReminder(item, now = new Date()) {
  if (item.status !== "needs_attention") return false;
  if (!item.firstAlertAt) return false;
  const last = item.lastReminderAt || item.firstAlertAt;
  const hours = Number(item.reminderHours || 6);
  return now.getTime() - new Date(last).getTime() >= hours * 60 * 60 * 1000;
}

function checked(item, now, status, message, amazonUrl, extra = {}) {
  const wasAttention = item.status === "needs_attention";
  const next = {
    ...item,
    ...extra,
    status: keepManualStatus(item.status, status),
    amazonUrl,
    lastCheckAt: now,
    lastCheckMessage: message,
    updatedAt: now
  };
  if (next.status === "needs_attention" && !wasAttention) next.firstAlertAt = now;
  if (next.status !== "needs_attention") {
    delete next.firstAlertAt;
    delete next.lastReminderAt;
  }
  return next;
}

function keepManualStatus(currentStatus, detectedStatus) {
  if (["resolved", "own_stock", "paused"].includes(currentStatus)) return currentStatus;
  return detectedStatus;
}

function hasFbaSignal(text, sellerName) {
  const windows = sellerName ? textWindowsAround(text, sellerName, 900) : [text];
  return windows.some((part) => [
    "Amazon.co.jp が発送",
    "Amazon.co.jpが発送",
    "Amazonから発送",
    "Amazon が発送",
    "配送元 Amazon",
    "出荷元 Amazon",
    "出荷元: Amazon",
    "Fulfilled by Amazon",
    "FBA"
  ].some((word) => part.includes(word)));
}

function textWindowsAround(text, needle, radius) {
  const windows = [];
  let index = text.indexOf(needle);
  while (index >= 0) {
    windows.push(text.slice(Math.max(0, index - radius), Math.min(text.length, index + needle.length + radius)));
    index = text.indexOf(needle, index + needle.length);
  }
  return windows.length ? windows : [text];
}

function isUnavailableText(text) {
  return [
    "現在在庫切れです",
    "在庫切れ",
    "この商品は現在お取り扱いできません",
    "一時的に在庫切れ",
    "販売していません"
  ].some((word) => text.includes(word));
}

function findPrice(text) {
  const match = text.match(/[￥¥]\s*([\d,]+)/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function findTitle(html) {
  return cleanText(
    byIdText(html, "productTitle") ||
    metaContent(html, "og:title") ||
    ""
  ).replace(/\s*Amazon\.co\.jp.*$/i, "");
}

function byIdText(html, id) {
  const block = html.match(new RegExp(`<[^>]+id=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  return block ? cleanText(stripTags(block[1])) : "";
}

function metaContent(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeRegExp(property)}["'][^>]*>`, "i");
  return decodeHtml((html.match(pattern) || html.match(reverse) || [])[1] || "");
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
