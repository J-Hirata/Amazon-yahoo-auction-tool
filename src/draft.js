import { CONFIG } from "./config.js";

export function buildYahooDraft(item) {
  const title = cleanCustomerTitle(item.title || item.asin);
  const price = item.startPrice;
  const stalePrice = item.stalePrice;
  const imageUrls = uniqueImages(Array.isArray(item.imageUrls) ? item.imageUrls : normalizeLines(item.imageUrls));

  return {
    asin: item.asin,
    title,
    price,
    stalePrice,
    amazonUrl: item.amazonUrl,
    sourceRegion: CONFIG.sourceRegion,
    shipping: "送料込み",
    shipAfter: `${CONFIG.shipAfterDaysMin}日から${CONFIG.shipAfterDaysMax}日`,
    auctionDays: CONFIG.yahooAuctionDays,
    autoDiscountRate: CONFIG.yahooAutoDiscountRate,
    imageUrls,
    categorySearchText: buildCategorySearchText({ ...item, title }),
    description: buildDescription(item)
  };
}

function buildDescription(item) {
  const productLines = cleanProductDescription(item.description, item.title);
  const displayTitle = cleanCustomerTitle(item.title || item.asin);
  const lines = [
    "ご覧いただきありがとうございます。",
    "",
    "【商品について】",
    displayTitle,
    ...productLines,
    "",
    "【商品の状態】",
    "写真のものを出品いたします。",
    "",
    "【発送】",
    `発送元: ${CONFIG.sourceRegion}`,
    "送料: 出品者負担",
    `発送目安: 落札後${CONFIG.shipAfterDaysMin}日から${CONFIG.shipAfterDaysMax}日`,
    "",
    "【管理番号】",
    `ASIN: ${item.asin}`,
    "",
    "よろしくお願いいたします。"
  ];

  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\r\n");
}

function cleanCustomerTitle(value) {
  return String(value || "")
    .replace(/[［【\[][^］】\]]*(?:保証|返品|返金|Amazon|Prime)[^］】\]]*[］】\]]/gi, "")
    .replace(/\b(?:Amazon|Prime)\b/gi, "")
    .replace(/\d+\s*年(?:間)?\s*フル?保証/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanProductDescription(value, title = "") {
  const rawLines = normalizeLines(value)
    .flatMap((line) => line.split(/\n|。|・|●|■|◆|※/))
    .map((line) => line.replace(/^[-*・\s]+/, "").trim())
    .filter(Boolean);

  const titleWords = new Set(importantWords(title));
  const useful = rawLines
    .filter((line) => !isAmazonSpecific(line))
    .filter((line) => isUsefulSpecLine(line, titleWords))
    .filter((line) => line.length <= 120)
    .slice(0, 15);

  return useful.length
    ? useful.map((line) => `・${line}`)
    : ["・サイズ、重量、型番、仕様などは商品名と画像をご確認ください。"];
}

function isUsefulSpecLine(line, titleWords) {
  if (line.length < 4) return false;
  if (titleWords.has(line)) return false;
  return [
    "サイズ",
    "ブランド",
    "メーカー",
    "UPC",
    "ユニット",
    "寸法",
    "重量",
    "重さ",
    "型番",
    "品番",
    "カラー",
    "色",
    "容量",
    "素材",
    "対応",
    "仕様",
    "電源",
    "消費電力",
    "長さ",
    "幅",
    "高さ",
    "インチ",
    "mm",
    "cm",
    "kg",
    "g",
    "W",
    "V"
  ].some((keyword) => line.includes(keyword)) || /\d/.test(line);
}

function buildCategorySearchText(item) {
  return [
    extractModelNumber(item.title),
    item.title
  ].filter(Boolean)[0] || item.asin;
}

function extractModelNumber(value) {
  const text = String(value || "");
  const candidates = text.match(/[A-Z0-9][A-Z0-9._/-]{3,}[A-Z0-9]/gi) || [];
  return candidates
    .map((candidate) => candidate.replace(/[()［］【】\[\]]/g, ""))
    .find((candidate) => /[A-Z]/i.test(candidate) && /\d/.test(candidate)) || "";
}

function importantWords(title) {
  return String(title || "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2);
}

function isAmazonSpecific(line) {
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
    "おすすめ",
    "メーカー保証",
    "COM-ET",
    "Web:",
    "http",
    "お客様",
    "希望",
    "定期的",
    "交換をおすすめ",
    "使用できない理由",
    "業務用",
    "公式サイト",
    "寿命",
    "5年間フル保証",
    "年保証",
    "フル保証"
  ].some((keyword) => line.includes(keyword));
}

function uniqueImages(urls) {
  const filtered = urls.filter(isLikelyProductImage);
  const preferred = filtered.filter((url) => /^https?:\/\/m\.media-amazon\.com\/images\/I\//i.test(url));
  const byKey = new Map();
  for (const url of (preferred.length ? preferred : filtered)) {
    const key = imageKey(url);
    if (!byKey.has(key) || imageScore(url) > imageScore(byKey.get(key))) byKey.set(key, url);
  }
  return [...byKey.values()].slice(0, 10);
}

function isLikelyProductImage(url) {
  const value = String(url || "");
  if (!/^https?:\/\/(?:m\.media-amazon|images-(?:fe|na)\.ssl-images-amazon)\.com\/images\/I\//i.test(value)) return false;
  if (/\.(?:svg|gif)(?:[?#]|$)/i.test(value)) return false;
  if (/grey-pixel|sprite|nav-sprite|prime|yourprime|logo|fallback|sash|marketing|x-locale|al-jp/i.test(value)) return false;
  return true;
}

function imageKey(url) {
  return String(url || "")
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

function normalizeLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
