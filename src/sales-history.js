import {createHash} from "node:crypto";

const confirmed = new Set(["UNSHIPPED", "PARTIALLY_SHIPPED", "SHIPPED"]);
const pending = new Set(["PENDING", "PENDING_AVAILABILITY"]);
const key = (row) => JSON.stringify([row.orderId, row.itemId]);
const fingerprint = (row) => JSON.stringify([row.asin, row.sellerSku, row.createdAt, row.reportedStatus || row.status, row.quantity]);

export function applySalesResult(tracking, result, at) {
  if (!result.complete || result.accountKey !== tracking.accountKey || result.sellerId !== tracking.sellerId || result.marketplaceId !== tracking.marketplaceId || !Array.isArray(result.rows) ||
    !Number.isFinite(Date.parse(result.after)) || !Number.isFinite(Date.parse(result.before)) || Date.parse(result.after) > Date.parse(result.before)) throw new Error("注文の取得範囲を確認できません");
  const targets = new Map(tracking.trackers.map((t) => [t.sellerSku, t.asin]));
  const existing = new Map(tracking.orders.map((row) => [key(row), row]));
  const processed = new Set();
  const created = [];
  for (const row of result.rows) {
    if (targets.get(row.sellerSku) !== row.asin || typeof row.orderId !== "string" || !row.orderId || typeof row.itemId !== "string" || !row.itemId || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt)) || Date.parse(row.createdAt) > Date.parse(row.updatedAt) ||
      Date.parse(row.updatedAt) < Date.parse(result.after) || Date.parse(row.updatedAt) > Date.parse(result.before) || ![...confirmed, ...pending, "CANCELLED", "UNFULFILLABLE", "UNKNOWN"].includes(row.status) ||
      !(row.quantity === null && row.status === "UNKNOWN" || Number.isSafeInteger(row.quantity) && row.quantity >= 0)) throw new Error("注文の識別・数量・期間を確認できません");
    const id = key(row), previous = existing.get(id);
    if (processed.has(id)) throw new Error("取得結果の同じ注文が重複しています");
    processed.add(id);
    if (previous && (previous.asin !== row.asin || previous.sellerSku !== row.sellerSku || previous.createdAt !== row.createdAt)) throw new Error("同じ注文の対象商品が変わりました");
    if (previous && Date.parse(row.updatedAt) < Date.parse(previous.updatedAt)) continue;
    if (previous && row.updatedAt === previous.updatedAt) {
      if (fingerprint(previous) !== fingerprint(row)) throw new Error("同じ更新時刻の注文内容が矛盾しています");
      continue;
    }
    const firstStart = tracking.trackers.filter((t) => t.sellerSku === row.sellerSku).map((t) => t.startedAt).sort()[0];
    const next = {...row, firstSeenAt: previous?.firstSeenAt || at,
      eligibleFromAt: previous?.eligibleFromAt || (Date.parse(row.createdAt) >= Date.parse(firstStart) ? row.createdAt : previous && pending.has(previous.status) && confirmed.has(row.status) ? at : null),
      firstConfirmedObservedAt: previous?.firstConfirmedObservedAt || (confirmed.has(row.status) ? at : null),
      confirmedQuantity: previous?.confirmedQuantity || 0};
    if (previous?.confirmedQuantity > 0 && pending.has(row.status)) {next.reportedStatus = row.status; next.status = "UNKNOWN";}
    if (next.status !== "UNKNOWN") next.confirmedQuantity = confirmed.has(row.status) ? row.quantity : 0;
    if (next.eligibleFromAt && next.status !== "UNKNOWN") {
      const delta = next.confirmedQuantity - (previous?.confirmedQuantity || 0);
      if (delta) {
        const event = {id: createHash("sha256").update(JSON.stringify([id, row.updatedAt, next.confirmedQuantity, previous?.updatedAt || ""])).digest("hex"),
          orderId: row.orderId, itemId: row.itemId, asin: row.asin, sellerSku: row.sellerSku, at, eligibleFromAt: next.eligibleFromAt,
          kind: delta > 0 ? "order_confirmed" : "order_corrected", delta, delivery: "preview"};
        tracking.events.push(event); created.push(event);
      }
    }
    existing.set(id, next);
  }
  if (existing.size > 10000 || tracking.events.length > 20000) throw new Error("販売履歴の保存上限を確認してください。過去履歴は削除していません");
  tracking.orders = [...existing.values()];
  tracking.lastBatchEventIds = created.map((event) => event.id);
  tracking.checkedThrough = result.before;
  return created;
}

export function salesHistoryView(state, at = new Date().toISOString()) {
  const tracking = state.salesTracking;
  if (!tracking) return {status: "not_started", products: [], events: [], automatic: false};
  const sync = tracking.sync || {};
  const interrupted = sync.status === "running" && Date.parse(sync.leaseUntil || "") <= Date.parse(at);
  const status = interrupted ? "failed" : sync.status || "idle";
  const products = state.links.map((link) => {
    const target = tracking.trackers.find((t) => t.linkId === link.id);
    if (!target) return {linkId: link.id, status: "untracked", confirmedQuantity: null};
    const rows = tracking.orders.filter((row) => row.sellerSku === target.sellerSku && row.asin === target.asin && row.eligibleFromAt && Date.parse(row.eligibleFromAt) >= Date.parse(target.startedAt));
    const unknown = rows.some((row) => row.status === "UNKNOWN");
    const complete = status === "complete" && Boolean(tracking.checkedThrough) && Date.parse(tracking.checkedThrough) >= Date.parse(target.startedAt);
    return {...target, status: !complete || unknown ? "unknown" : "complete", confirmedQuantity: complete && !unknown ? rows.reduce((sum, row) => sum + row.confirmedQuantity, 0) : null,
      pendingQuantity: rows.filter((row) => pending.has(row.status)).reduce((sum, row) => sum + (row.quantity || 0), 0),
      checkedThrough: tracking.checkedThrough};
  });
  const last = new Set(tracking.lastBatchEventIds || []);
  return {status, startedAt: tracking.startedAt, checkedThrough: tracking.checkedThrough, checkedAt: sync.checkedAt, nextAllowedAt: sync.nextAllowedAt,
    error: interrupted ? "前回の注文確認が途中で停止しました。販売ゼロとは扱いません" : sync.error || null,
    catchingUp: Boolean(tracking.checkedThrough && Date.parse(tracking.checkedThrough) < Date.parse(at) - 15 * 60000),
    products, events: status === "complete" ? tracking.events.filter((event) => last.has(event.id)) : [], recentEvents: tracking.events.slice(-50).reverse(), automatic: false};
}
