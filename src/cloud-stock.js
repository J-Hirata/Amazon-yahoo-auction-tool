import {applyStockCommand, stockCommandDigest, stockTotals, STOCK_LOCATIONS} from "./physical-stock.js";
import {assessLink, PREVIEW_CONFIG} from "./link-monitor.js";
import {stockImageUrl} from "./stock-images.js";

const fail = (message, status) => Object.assign(new Error(message), {status});
function checkLinks(command, monitor) {
  if (!["create", "edit"].includes(command.kind)) return;
  for (const id of command.product?.linkedLinkIds || []) {
    const link = monitor.links.find((link) => link.id === id);
    const asin = link?.asin || monitor.catalog.find((item) => item.id === link?.catalogId)?.asin;
    if (!link?.verified || link.observationConflict || command.product.asin?.trim().toUpperCase() !== asin) throw fail("紐付け先と在庫商品のASINが一致しません。数量は変更していません", 409);
  }
}
function linksFor(monitor, at) {
  return monitor.links.map((link) => {
    const assessment = assessLink(link, monitor, at), product = assessment.product, listing = assessment.listing;
    const age = Date.parse(at) - Date.parse(product?.checkedAt);
    const current = Number.isFinite(age) && age >= -60000 && age <= PREVIEW_CONFIG.freshnessMinutes * 60000 && !product?.error;
    return {id: link.id, asin: product?.asin || link.asin, sellerSku: product?.sellerSku || "", condition: product?.condition || "",
      title: listing?.title || product?.title || link.asin, imageUrl: listing?.imageUrl || "", listingId: link.listingId,
      yahooStatus: assessment.yahoo, fbaLabel: assessment.fbaLabel || "未確認", quantity: current && assessment.inventory !== "unlinked" && product?.source === "amazon_sp_api" ? product.fulfillableQuantity : null, checkedAt: product?.checkedAt || null};
  });
}
export function physicalStockView({state, revision}, monitor, at = new Date().toISOString(), drafts = []) {
  const linkOptions = linksFor(monitor, at);
  const products = state.products.map((product) => {
    const totals = stockTotals(state, product.id), linked = product.linkedLinkIds.map((id) => linkOptions.find((link) => link.id === id)).filter(Boolean);
    const unique = new Map(linked.map((link) => [link.sellerSku, link]));
    const reference = unique.size === 1 ? [...unique.values()][0] : null;
    const mismatch = reference && (reference.asin !== product.asin || !/^(new|used)/i.test(reference.condition) || !["new", "used"].includes(product.condition) || product.sellerSku && product.sellerSku !== reference.sellerSku ||
      product.condition === "new" && /used/i.test(reference.condition) || product.condition === "used" && /^new/i.test(reference.condition));
    const fba = reference && reference.sellerSku && !mismatch && reference.quantity !== null && reference.quantity !== undefined ?
      {quantity: reference.quantity, label: reference.fbaLabel, checkedAt: reference.checkedAt, sellerSku: reference.sellerSku} : {quantity: null, label: linked.length ? "SKU・状態・鮮度を要確認" : "未紐付け", checkedAt: null};
    const linkCandidates = product.asin ? linkOptions.filter((l) => l.asin === product.asin && !product.linkedLinkIds.includes(l.id)) : [];
    const savedPhotos = (monitor.amazonInventory?.items || []).filter((r) => r.asin === product.asin).map((r) => r.listingInfo?.catalogImageUrl).filter((u) => stockImageUrl(u));
    const draftPhotos = drafts.filter((d) => product.asin && d.asin === product.asin).flatMap((d) => d.imageUrls || []).filter((u) => stockImageUrl(u));
    const photoUrl = stockImageUrl(product.imageUrl) || stockImageUrl(linked[0]?.imageUrl) || stockImageUrl(savedPhotos[0]) || stockImageUrl(draftPhotos[0]) || stockImageUrl(linkCandidates[0]?.imageUrl);
    const photoLabel = product.imageUrl ? product.imageSource === "amazon_catalog" ? "Amazon商品画像（現物写真ではありません）" : "登録した商品画像" : linked[0]?.imageUrl ? "ヤフオク出品写真" : savedPhotos.length || draftPhotos.length ? "Amazon商品画像（現物写真ではありません）" : "同ASINのヤフオク参考画像（紐付け未確認）";
    return {...product, totals, linked, linkCandidates, photo: photoUrl ? {url: photoUrl, label: photoLabel} : null, fba, replenishmentCandidate: product.fbaEligibility === "possible" && fba.quantity === 0 && totals.usable > 0,
      catalogDue: ["pending", "working"].includes(product.catalogTask) && Boolean(product.reviewDate) && product.reviewDate <= new Date(Date.parse(at) + 9 * 3600000).toISOString().slice(0, 10)};
  });
  return {storage: {backend: "postgres", revision}, locations: STOCK_LOCATIONS, products, linkOptions,
    transfers: state.transfers, events: state.events.slice(-100).reverse(), totals: {products: products.length, inTransit: state.transfers.filter((t) => t.remaining > 0).length},
    checkedAt: at, automatic: false};
}
export function stockCsv(view) {
  const cell = (value) => '"' + String(value ?? "").replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
  const rows = [["管理ID", "商品名", "ASIN", "SKU", "状態", "単位", "場所", "使用可能", "取り置き", "使用不可", "確認状態", "最終確認", "メモ"]];
  for (const product of view.products) for (const balance of product.totals.locations) rows.push([product.managementId, product.title, product.asin, product.sellerSku, product.condition, product.unit,
    STOCK_LOCATIONS.find((l) => l.id === balance.locationId).name, balance.usable, balance.reserved, balance.unusable, balance.usable === null ? "未確認" : "確認済み", balance.checkedAt, product.memo]);
  return "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
export function createCloudStock({store, monitorStore, draftStore, now = () => new Date().toISOString()}) {
  async function view() {return physicalStockView(await store.readSnapshot(), await monitorStore.read(), now(), draftStore ? await draftStore.read() : []);}
  async function preview(command, {expectedRevision, actor}) {
    const snapshot = await store.readSnapshot();
    if (snapshot.revision !== expectedRevision) throw fail("在庫が更新されています。最新の内容で確認し直してください", 409);
    checkLinks(command, await monitorStore.read());
    const state = structuredClone(snapshot.state), receipt = applyStockCommand(state, command, {actor, at: now()});
    const event = state.events.find((e) => e.operationId === receipt.id);
    const product = state.products.find((p) => p.id === receipt.productId);
    const duplicates = state.products.filter((p) => p.id !== product.id && (product.asin && p.asin === product.asin || p.title.toLowerCase() === product.title.toLowerCase())).map((p) => ({managementId: p.managementId, title: p.title})).slice(0, 5);
    return {revision: snapshot.revision, receipt, product, event, duplicates};
  }
  async function commit(command, {expectedRevision, actor, confirmed}) {
    if (confirmed !== true) throw fail("変更前後を確認して保存してください", 400);
    const snapshot = await store.readSnapshot(), previous = snapshot.state.receipts.find((r) => r.id === command?.operationId);
    if (previous) {
      if (previous.digest !== stockCommandDigest(command) || previous.actor !== actor) throw fail("操作IDと内容が一致しません", 409);
      return {receipt: {...previous, replayed: true}, result: await view()};
    }
    checkLinks(command, await monitorStore.read());
    const receipt = await store.update((state) => applyStockCommand(state, command, {actor, at: now()}), {expectedRevision});
    return {receipt, result: await view()};
  }
  async function operation(id, actor) {
    const receipt = (await store.read()).receipts.find((r) => r.id === id && r.actor === actor);
    if (!receipt) throw fail("この操作の保存はまだ確認できません。同じ操作IDのまま再試行してください", 404);
    return receipt;
  }
  return {view, preview, commit, operation};
}
