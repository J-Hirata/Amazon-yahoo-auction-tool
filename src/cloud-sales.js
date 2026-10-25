import {randomUUID} from "node:crypto";
import {readAmazonSales} from "./amazon-sales-reader.js";
import {applySalesResult, salesHistoryView} from "./sales-history.js";

const failure = (message, status = 409) => Object.assign(new Error(message), {status});
function targetsFor(state, config) {
  const inventory = state.amazonInventory;
  if (state.amazonAccountKey !== config.accountKey || state.amazonSellerId !== config.sellerId || inventory?.status !== "complete" || inventory.complete !== true) throw failure("先に自社FBA在庫を確認してください。対象SKUが確定するまで注文を取得しません");
  return state.links.flatMap((link) => {
    const product = link.matchBy === "asin" ? null : state.catalog.find((item) => item.id === link.catalogId);
    const asin = link.asin || product?.asin;
    const rows = inventory.items.filter((item) => item.asin === asin && (!product || item.sellerSku === product.sellerSku));
    if (!link.verified || link.observationConflict || rows.length !== 1 || state.catalog.filter((item) => item.asin === asin).length > 1 || !rows[0].sellerSku) return [];
    return [{linkId: link.id, asin, sellerSku: rows[0].sellerSku, condition: rows[0].condition || "unknown"}];
  });
}
const scope = (targets) => JSON.stringify(targets.map((t) => [t.linkId, t.asin, t.sellerSku, t.condition]).sort());

export function createCloudSales({store, config, readOrders = readAmazonSales, now = () => new Date().toISOString()}) {
  async function start({expectedRevision}) {
    const at = now();
    await store.update((state) => {
      const targets = targetsFor(state, config);
      if (!targets.length || targets.length > 100) throw failure("追跡できる商品がありません。ASINに複数SKUがある場合は先に対象を確認してください", 400);
      if (state.salesTracking && (state.salesTracking.accountKey !== config.accountKey || state.salesTracking.sellerId !== config.sellerId)) throw failure("販売追跡のAmazonアカウントが異なります");
      if (salesHistoryView(state, at).status === "running") throw failure("注文確認中は追跡対象を変更できません");
      const tracking = state.salesTracking ||= {version: 1, accountKey: config.accountKey, sellerId: config.sellerId, marketplaceId: config.marketplaceId,
        startedAt: at, trackers: [], orders: [], events: [], sync: {status: "idle"}};
      for (const target of targets) {
        const previous = tracking.trackers.find((t) => t.linkId === target.linkId);
        if (previous && scope([previous]) !== scope([target])) throw failure("追跡中の商品SKUや状態が変わりました。履歴を引き継ぐか確認してください");
        if (!previous) tracking.trackers.push({...target, startedAt: at});
      }
      state.logs.push({at, kind: "sales_tracking_started", message: "販売追跡の開始時刻を保存しました。注文取得・メール送信・在庫変更は行っていません"});
    }, {expectedRevision});
  }
  async function check({expectedRevision}) {
    const at = now(), jobId = randomUUID();
    const claim = await store.update((state) => {
      const tracking = state.salesTracking;
      if (!tracking) throw failure("先に販売追跡を開始してください", 400);
      if (salesHistoryView(state, at).status === "running") throw failure("注文を確認中です");
      if (Date.parse(tracking.sync?.nextAllowedAt || "") > Date.parse(at)) throw failure("Amazonの取得間隔を空けてください。約3分後に再確認できます", 429);
      const targets = targetsFor(state, config);
      if (tracking.accountKey !== config.accountKey || tracking.marketplaceId !== config.marketplaceId || tracking.sellerId !== config.sellerId ||
        tracking.trackers.some((t) => !targets.some((item) => scope([item]) === scope([t])))) throw failure("追跡対象のSKUが変わったか不明になりました。FBAと紐付けを再確認してください");
      const after = tracking.checkedThrough ? new Date(Math.max(Date.parse(tracking.startedAt), Date.parse(tracking.checkedThrough) - 5 * 60000)).toISOString() : tracking.startedAt;
      const before = new Date(Math.min(Date.parse(at) - 120000, Date.parse(after) + 7 * 86400000)).toISOString();
      if (Date.parse(before) < Date.parse(after)) throw failure("追跡開始から2分ほど待って注文を確認してください", 400);
      tracking.sync = {status: "running", jobId, startedAt: at, leaseUntil: new Date(Date.parse(at) + 60000).toISOString(), nextAllowedAt: new Date(Date.parse(at) + 180000).toISOString()};
      return {after, before, targets: [...new Map(tracking.trackers.map((t) => [t.sellerSku, {asin: t.asin, sellerSku: t.sellerSku}])).values()], scope: scope(targets)};
    }, {expectedRevision});
    try {
      const result = await readOrders({config, targets: claim.targets, after: claim.after, before: claim.before, maxPages: 5, maxDurationMs: 40000});
      if (result.after !== claim.after || result.before !== claim.before) throw new Error("注文の取得期間が一致しません");
      await store.update((state) => {
        const tracking = state.salesTracking;
        if (tracking?.sync?.jobId !== jobId || scope(targetsFor(state, config)) !== claim.scope) throw failure("注文確認中に対象が変わりました。古い結果は保存していません");
        applySalesResult(tracking, result, now());
        tracking.sync = {...tracking.sync, status: "complete", checkedAt: now(), pages: result.pages, error: null};
        state.logs.push({at: now(), kind: "sales_check_complete", message: "Amazon注文の販売履歴とプレビューを更新しました。メール・在庫変更は行っていません"});
      });
    } catch (error) {
      if (String(error.code || "").startsWith("STORAGE_")) throw error;
      const http = String(error.message || "").match(/HTTP (\d{3})/)?.[1];
      await store.update((state) => {
        if (state.salesTracking?.sync?.jobId !== jobId) return;
        state.salesTracking.sync = {...state.salesTracking.sync, status: "failed", error: `注文を確認できません${http ? `（HTTP ${http}）` : ""}。権限・対象・取得上限を確認してください。販売ゼロとは扱いません`};
      });
    }
  }
  return {start, check};
}
