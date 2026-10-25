import {randomUUID} from "node:crypto";
import {readFbaInventory} from "./amazon-fba-reader.js";

export function createCloudFba({store, config, readInventory = readFbaInventory, now = () => new Date().toISOString()}) {
  function status(state) {
    const job = state.amazonInventory;
    if (!job) return {status: "idle", pages: 0, scanned: 0};
    if (job.status === "running" && Date.parse(job.leaseUntil || "") <= Date.parse(now())) return {status: "failed", error: "前回の在庫確認が途中で停止しました。再度確認してください"};
    return {status: job.status, pages: job.pages || 0, scanned: job.scanned || 0, targets: job.asins?.length || 0, error: job.error || null};
  }
  async function start({expectedRevision}) {
    const id = randomUUID();
    const startedAt = now();
    const claim = await store.update((state) => {
      if (status(state).status === "running") return null;
      const asins = [...new Set(state.links.map((link) => link.matchBy === "asin" ? link.asin : state.catalog.find((item) => item.id === link.catalogId)?.asin).filter(Boolean))];
      if (!asins.length || asins.length > 100) throw Object.assign(new Error("紐付け済みの商品を1〜100件で確認してください"), {status: 400});
      if (state.amazonAccountKey && state.amazonAccountKey !== config.accountKey) throw Object.assign(new Error("以前とAmazonの接続先が異なります。設定を確認してください"), {status: 409});
      const sellerId = config.sellerId || (state.amazonAccountKey === config.accountKey ? state.amazonSellerId : null);
      if (!sellerId) throw Object.assign(new Error("対象商品だけを調べるため、Amazon出品者IDの確認が必要です"), {status: 400});
      state.amazonInventory = {...state.amazonInventory, jobId: id, status: "running", complete: false, startedAt, asins, error: null, leaseUntil: new Date(Date.parse(startedAt) + 60000).toISOString()};
      return {asins, sellerId};
    }, {expectedRevision});
    if (!claim) return status(await store.read());
    try {
      const result = await readInventory({asins: claim.asins, config: {...config, sellerId: claim.sellerId}, maxDurationMs: 40000, maxPages: 20});
      if (!result.complete || result.scope !== "linked_asins_only" || result.accountKey !== config.accountKey || result.sellerId !== claim.sellerId || JSON.stringify([...result.asins].sort()) !== JSON.stringify([...claim.asins].sort())) throw new Error("対象商品の在庫を確認できませんでした");
      await store.update((state) => {
        if (state.amazonInventory?.jobId !== id) throw Object.assign(new Error("新しい在庫確認が始まっています。最新の結果を確認してください"), {status: 409});
        state.amazonAccountKey = config.accountKey; state.amazonSellerId = result.sellerId;
        state.amazonInventory = {...result, jobId: id};
        state.logs.push({at: now(), kind: "cloud_fba_complete", pages: result.pages, scanned: result.scanned, message: "紐付け済み商品のFBA在庫を確認しました。メール・出品変更は行っていません"});
      });
    } catch (error) {
      if (String(error.code || "").startsWith("STORAGE_")) throw error;
      const http = String(error.message || "").match(/HTTP (\d{3})/)?.[1];
      const message = `FBA在庫を確認できません${http ? `（HTTP ${http}）` : ""}。接続・権限・タイムアウトを確認してください。以前の数量を現在庫やゼロとは扱いません`;
      await store.update((state) => {
        if (state.amazonInventory?.jobId !== id) return;
        state.amazonInventory = {...state.amazonInventory, status: "failed", complete: false, error: message};
        state.logs.push({at: now(), kind: "cloud_fba_failed", message});
      });
    }
    return status(await store.read());
  }
  return {start, status};
}
