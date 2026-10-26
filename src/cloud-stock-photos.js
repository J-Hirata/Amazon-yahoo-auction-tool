import {randomUUID} from "node:crypto";
import {applyStockCommand} from "./physical-stock.js";
import {stockImageUrl} from "./stock-images.js";

// Catalog Items v2022-04-01: image GETs only; no listing or inventory writes.
export async function readCatalogPhotos({asins, config, fetchImpl = fetch, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms))}) {
  const targets = [...new Set(asins)];
  if (!targets.length) return {photos: [], errors: []};
  if (targets.length > 8 || targets.some((a) => !/^[A-Z0-9]{10}$/.test(a)) || config.marketplaceId !== "A1VC38T7YXB528") throw new Error("画像の取得対象を確認してください");
  const deadline = now() + 35000;
  async function request(url, options) {
    if (now() >= deadline) throw new Error("画像の取得時間を超えました");
    let r;
    try {r = await fetchImpl(url, {...options, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(12000, deadline - now())))});} catch {throw new Error("Amazonの商品画像に接続できません");}
    if (!r.ok) throw new Error(`画像の取得に失敗しました（HTTP ${r.status}）`);
    try {return await r.json();} catch {throw new Error("画像の応答を読み取れません");}
  }
  const token = await request("https://api.amazon.com/auth/o2/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({grant_type: "refresh_token", refresh_token: config.refreshToken, client_id: config.clientId, client_secret: config.clientSecret})});
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Amazon認証を確認できません");
  const result = {photos: [], errors: []};
  for (const asin of targets) {
    try {
      const url = new URL(`https://sellingpartnerapi-fe.amazon.com/catalog/2022-04-01/items/${asin}`);
      url.searchParams.set("marketplaceIds", config.marketplaceId); url.searchParams.set("includedData", "images");
      const item = await request(url, {method: "GET", headers: {"x-amz-access-token": token.access_token}});
      if (item.asin !== asin || item.errors?.length) throw new Error("取得画像のASINが一致しません");
      const images = item.images?.filter((i) => i.marketplaceId === config.marketplaceId).flatMap((i) => i.images || []) || [];
      const photo = images.filter((i) => i.variant === "MAIN" && stockImageUrl(i.link)).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (!photo) throw new Error("Amazonの商品画像が見つかりません");
      result.photos.push({asin, imageUrl: stockImageUrl(photo.link), imageSource: "amazon_catalog"});
    } catch (e) {result.errors.push({asin, error: e.message});}
    if (now() < deadline) await wait(550);
  }
  return result;
}

export function createStockPhotoRefresh({store, config, readPhotos = readCatalogPhotos}) {
  return async ({expectedRevision, actor}) => {
    const snapshot = await store.readSnapshot();
    if (snapshot.revision !== expectedRevision) throw Object.assign(new Error("最新の在庫一覧を読み込んでください"), {status: 409});
    const targets = [...new Set(snapshot.state.products.filter((p) => p.asin && !p.imageUrl).map((p) => p.asin))].slice(0, 8);
    const result = targets.length ? await readPhotos({asins: targets, config}) : {photos: [], errors: []};
    let updated = 0;
    if (result.photos.length) await store.update((state) => {
      for (const p of state.products) {
        const photo = result.photos.find((photo) => photo.asin === p.asin);
        if (!photo || p.imageUrl || !stockImageUrl(photo.imageUrl)) continue;
        applyStockCommand(state, {operationId: randomUUID(), productId: p.id, kind: "edit", product: {...p, imageUrl: photo.imageUrl, imageSource: "amazon_catalog"}, reason: "Amazonの商品画像を取得"}, {actor});
        updated++;
      }
    }, {expectedRevision});
    return {updated, requested: targets.length, errors: result.errors, remaining: Math.max(0, snapshot.state.products.filter((p) => p.asin && !p.imageUrl).length - updated)};
  };
}
