import {load} from "cheerio";

export function yahooImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname.endsWith(".yimg.jp") && !url.username && !url.password && !url.port && url.href.length <= 2048) return url.href;
  } catch { /* No supported product image is available. */ }
  return "";
}

export function yahooListingUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:" || !["auctions.yahoo.co.jp", "page.auctions.yahoo.co.jp"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("ヤフオクの商品URLを入力してください");
  const match = url.pathname.match(/^\/(?:jp\/)?auction\/([a-z][0-9]{6,15})\/?$/i);
  if (!match) throw new Error("出品IDのある商品URLを入力してください");
  return {listingId: match[1].toLowerCase(), url: `https://auctions.yahoo.co.jp/jp/auction/${match[1].toLowerCase()}`};
}

export function descriptionText(html) {
  const $ = load(String(html || ""));
  $("script,style,noscript").remove();
  $("br").replaceWith("\n");
  $("div,p,tr,li").append("\n");
  return $.text().replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function managementReferences(text) {
  const refs = [];
  const lines = String(text || "").normalize("NFKC").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/管理(?:番号|ID|コード)|\bASIN\s*[:：]/i.test(line)) continue;
    const block = [line, ...lines.slice(i + 1, i + 3)].join(" ").slice(0, 240);
    for (const match of block.matchAll(/\bASIN\s*[:：]\s*([A-Z0-9]{10})(?![A-Z0-9])/gi)) refs.push({kind: "asin", value: match[1].toUpperCase()});
    const token = line.match(/管理(?:番号|ID|コード)[】\]）)]*\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_-]{2,79})/i)?.[1];
    if (token && token.toUpperCase() !== "ASIN") refs.push({kind: /^B[A-Z0-9]{9}$/.test(token.toUpperCase()) ? "asin" : "management", value: token});
  }
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.value}`, ref])).values()];
}

export function parseYahooPage(html, url, at = new Date().toISOString()) {
  const identity = yahooListingUrl(url);
  const $ = load(html);
  let item;
  try { item = JSON.parse($("#__NEXT_DATA__").text()).props?.pageProps?.initialState?.item?.detail?.item; } catch { /* Missing structured data is not evidence of an ended listing. */ }
  if (!item || item.auctionId !== identity.listingId) throw new Error("商品情報を確認できません。ログイン画面やページ変更の可能性があります");
  const description = descriptionText(item.descriptionHtml || (item.description || []).join("\n"));
  const status = item.status === "open" ? "active" : item.status === "closed" ? "ended" : "unknown";
  return {
    ...identity, title: String(item.title || ""), imageUrl: yahooImageUrl($('meta[property="og:image"]').attr("content")), seller: String(item.seller?.aucUserId || ""),
    condition: String(item.conditionName || ""), description, references: managementReferences(description),
    observation: {status, reason: "unknown", checkedAt: at, source: "public_page", verified: status !== "unknown", evidence: `商品ページの状態: ${String(item.status || "不明")}`},
    endTime: item.endTime || null
  };
}

export async function fetchYahooListing(url, {fetchImpl = fetch, now = () => new Date().toISOString()} = {}) {
  let target = yahooListingUrl(url).url;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchImpl(target, {redirect: "manual", signal: AbortSignal.timeout(15000), headers: {Accept: "text/html", "Accept-Language": "ja-JP"}});
    if (response.status >= 300 && response.status < 400) {
      target = yahooListingUrl(new URL(response.headers.get("location"), target).href).url;
      continue;
    }
    if (!response.ok) throw new Error(`商品ページを取得できません (HTTP ${response.status})`);
    const html = await response.text();
    if (html.length > 3000000) throw new Error("商品ページが大きすぎます");
    return parseYahooPage(html, target, now());
  }
  throw new Error("商品ページの移動先を確認できません");
}
