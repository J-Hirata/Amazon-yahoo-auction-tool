import {randomUUID} from "node:crypto";
import {readAmazonSales} from "./amazon-sales-reader.js";
import {applySalesResult, salesHistoryView} from "./sales-history.js";

const failure = (message, status = 409) => Object.assign(new Error(message), {status});
function targetsFor(state, config) {
  if (state.salesTargets) {
    const s=state.salesTargets;
    if(s.accountKey!==config.accountKey || s.sellerId!==config.sellerId || s.marketplaceId!==config.marketplaceId || state.amazonAccountKey!==config.accountKey || state.amazonSellerId!==config.sellerId) throw failure("販売追跡のAmazonアカウントが異なります");
    return s.targets.filter(t=>{const link=state.links.find(l=>l.id===t.linkId||t.sourceId===`link:${l.id}`);return !link?.amazonSellerSku||link.amazonSellerSku===t.sellerSku||(state.merchantLinks||[]).some(r=>r.key===t.sourceId&&r.asin===t.asin&&r.sellerSku===t.sellerSku&&r.accountKey===config.accountKey&&r.sellerId===config.sellerId);});
  }
  const inventory = state.amazonInventory;
  if (state.amazonAccountKey !== config.accountKey || state.amazonSellerId !== config.sellerId || inventory?.status !== "complete" || inventory.complete !== true) throw failure("先に自社FBA在庫を確認してください。対象SKUが確定するまで注文を取得しません");
  return state.links.flatMap((link) => {
    const product = link.matchBy === "asin" ? null : state.catalog.find((item) => item.id === link.catalogId);
    const asin = link.asin || product?.asin;
    const sku=link.amazonSellerSku||product?.sellerSku;
    const rows = inventory.items.filter((item) => item.asin === asin && (!sku || item.sellerSku === sku));
    if (!link.verified || link.observationConflict || rows.length !== 1 || !sku&&state.catalog.filter((item) => item.asin === asin).length > 1 || !rows[0].sellerSku) return [];
    return [{linkId: link.id, asin, sellerSku: rows[0].sellerSku, condition: rows[0].condition || "unknown"}];
  });
}
const identity=t=>JSON.stringify([t.sourceId || t.linkId,t.sellerSku]);
const scope = (targets) => JSON.stringify(targets.map((t) => [t.sourceId || t.linkId, t.asin, t.sellerSku, t.condition]).sort());

export function createCloudSales({store, config, readTargets, readOrders = readAmazonSales, now = () => new Date().toISOString()}) {
  async function start({expectedRevision}) {
    const at = now();
    const resolved=readTargets ? await readTargets() : null;
    await store.update((state) => {
      if(resolved)state.salesTargets=resolved;
      const targets = targetsFor(state, config);
      if (!targets.length || new Set(targets.map(t=>t.sellerSku)).size > 100) throw failure("追跡できる商品がありません。自社出品のSKUを確認してください", 400);
      if (state.salesTracking && (state.salesTracking.accountKey !== config.accountKey || state.salesTracking.sellerId !== config.sellerId)) throw failure("販売追跡のAmazonアカウントが異なります");
      if (salesHistoryView(state, at).status === "running") throw failure("注文確認中は追跡対象を変更できません");
      const tracking = state.salesTracking ||= {version: 1, accountKey: config.accountKey, sellerId: config.sellerId, marketplaceId: config.marketplaceId,
        startedAt: at, trackers: [], orders: [], events: [], sync: {status: "idle"}};
      for (const target of targets) {
        const previous = tracking.trackers.find((t) => identity(t) === identity(target) || target.linkId && t.linkId === target.linkId && t.asin===target.asin && t.sellerSku===target.sellerSku);
        if(previous)Object.assign(previous,target);
        else {
          // Re-read the existing observation period when a missed merchant SKU is added.
          // Order versions prevent double counting. Notification start is a separate boundary.
          const known=tracking.trackers.find(t=>t.asin===target.asin&&t.sellerSku===target.sellerSku);
          tracking.trackers.push({...target,startedAt:known?.startedAt||tracking.startedAt});
          if(!known&&tracking.checkedThrough)tracking.checkedThrough=tracking.startedAt;
        }
      }
      state.logs.push({at, kind: "sales_tracking_started", message: "販売追跡の開始時刻を保存しました。注文取得・メール送信・在庫変更は行っていません"});
    }, {expectedRevision});
  }
  async function check({expectedRevision, catchUp = false} = {}) {
    const at = now(), jobId = randomUUID();
    const claim = await store.update((state) => {
      const tracking = state.salesTracking;
      if (!tracking) throw failure("先に販売追跡を開始してください", 400);
      if (salesHistoryView(state, at).status === "running") throw failure("注文を確認中です");
      if (!catchUp && Date.parse(tracking.sync?.nextAllowedAt || "") > Date.parse(at)) throw failure("Amazonの取得間隔を空けてください。約3分後に再確認できます", 429);
      const targets = targetsFor(state, config);
      if (tracking.accountKey !== config.accountKey || tracking.marketplaceId !== config.marketplaceId || tracking.sellerId !== config.sellerId ||
        (!state.salesTargets && tracking.trackers.some((t) => !targets.some((item) => scope([item]) === scope([t]))))) throw failure("追跡対象のSKUが変わったか不明になりました。FBAと紐付けを再確認してください");
      const after = tracking.checkedThrough ? new Date(Math.max(Date.parse(tracking.startedAt), Date.parse(tracking.checkedThrough) - 5 * 60000)).toISOString() : tracking.startedAt;
      const before = new Date(Math.min(Date.parse(at) - 120000, Date.parse(after) + (tracking.windowMs || 7 * 86400000))).toISOString();
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
        const limited=error.code==="SALES_PAGE_LIMIT";
        if(limited)state.salesTracking.windowMs=Math.max(600000,Math.floor((Date.parse(claim.before)-Date.parse(claim.after))/2));
        state.salesTracking.sync = {...state.salesTracking.sync, status: "failed", errorCode:limited?'SALES_PAGE_LIMIT':'SALES_FETCH_FAILED', error: limited ? "注文数が多いため次回は取得期間を短くして再開します。未完了期間は維持しています" : `注文を確認できません${http ? `（HTTP ${http}）` : ""}。権限・対象・取得上限を確認してください。販売ゼロとは扱いません`};
      });
    }
  }
  return {start, check};
}
