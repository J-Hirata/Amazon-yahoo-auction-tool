import {stockImageUrl} from "./stock-images.js";

const fail = (message, status = 502) => Object.assign(new Error(message), {status});
export async function readPlanningCatalog({asin, config, fetchImpl = fetch}) {
  if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin) || config.marketplaceId !== "A1VC38T7YXB528") throw fail("ASINを英数字10文字で入力してください", 400);
  async function request(url, options) {
    let response;
    try {response = await fetchImpl(url, {...options, redirect: "error", signal: AbortSignal.timeout(6000)});}
    catch {throw fail("商品情報を取得できません。ASINのまま登録できます");}
    if (!response.ok) {await response.body?.cancel(); throw fail("商品情報を取得できません。ASINのまま登録できます");}
    try {return await response.json();} catch {throw fail("商品情報を読み取れません。ASINのまま登録できます");}
  }
  const token = await request("https://api.amazon.com/auth/o2/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "refresh_token", refresh_token: config.refreshToken, client_id: config.clientId, client_secret: config.clientSecret})});
  if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 16384) throw fail("Amazonの商品情報を確認できません");
  const url = new URL(`https://sellingpartnerapi-fe.amazon.com/catalog/2022-04-01/items/${asin}`);
  url.searchParams.set("marketplaceIds", config.marketplaceId);
  url.searchParams.set("includedData", "summaries,images");
  url.searchParams.set("locale", "ja_JP");
  const item = await request(url, {method: "GET", headers: {"x-amz-access-token": token.access_token}});
  if (item.asin !== asin || item.errors?.length) throw fail("取得した商品のASINが一致しません");
  const summary = item.summaries?.find(row => row.marketplaceId === config.marketplaceId);
  const title = typeof summary?.itemName === "string" ? summary.itemName.trim().slice(0, 200) : "";
  const images = item.images?.filter(row => row.marketplaceId === config.marketplaceId).flatMap(row => row.images || []) || [];
  const imageUrl = images.filter(row => row.variant === "MAIN" && stockImageUrl(row.link) && !new URL(row.link).hostname.endsWith(".yimg.jp"))
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.link || "";
  return {asin, title, imageUrl: stockImageUrl(imageUrl), imageSource: imageUrl ? "amazon_catalog" : ""};
}
