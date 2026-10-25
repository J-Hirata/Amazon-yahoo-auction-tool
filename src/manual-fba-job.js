import {readFbaInventory} from "./amazon-fba-reader.js";
import {loadAmazonConfig} from "./amazon-local-config.js";

export function createManualFbaJob({store, readConfig = loadAmazonConfig, readInventory = readFbaInventory, now = () => new Date().toISOString()}) {
  let job = {status: "idle", pages: 0, scanned: 0};
  let task;
  async function start() {
    if (job.status === "running") return {...job};
    job = {status: "running", pages: 0, scanned: 0, startedAt: now()};
    task = (async () => {
      try {
        const state = await store.read();
        const asins = [...new Set(state.links.map((link) => link.matchBy === "asin" ? link.asin : state.catalog.find((item) => item.id === link.catalogId)?.asin).filter(Boolean))];
        if (!asins.length) throw new Error("先にAmazonとヤフオクのページを紐付けてください");
        const config = await readConfig();
        if (!config.sellerId && state.amazonAccountKey === config.accountKey) config.sellerId = state.amazonSellerId;
        if (state.amazonAccountKey && state.amazonAccountKey !== config.accountKey) throw new Error("Amazonの接続先が以前と異なります。アカウント設定を確認してください");
        await store.update((current) => {
          current.amazonInventory = {...current.amazonInventory, status: "running", complete: false, startedAt: job.startedAt, error: null};
        });
        const result = await readInventory({asins, config, onProgress: (progress) => {job = {...job, ...progress};}});
        if (!result.complete) throw new Error("在庫一覧を最後まで取得できませんでした");
        await store.update((current) => {
          if (current.amazonAccountKey && current.amazonAccountKey !== config.accountKey) throw new Error("Amazonの接続先が変更されています");
          current.amazonAccountKey = config.accountKey;
          current.amazonSellerId = result.sellerId;
          current.amazonInventory = result;
          current.logs.push({at: now(), kind: "fba_manual_complete", pages: result.pages, scanned: result.scanned, message: "手動でFBA在庫を取得しました。メールは送信していません"});
        });
        job = {...job, status: "complete", finishedAt: now()};
      } catch (error) {
        const message = error.message || "FBA在庫を取得できませんでした";
        job = {...job, status: "failed", error: message, finishedAt: now()};
        try {
          await store.update((current) => {
            current.amazonInventory = {...current.amazonInventory, status: "failed", complete: false, error: message};
            current.logs.push({at: now(), kind: "fba_manual_failed", message});
          });
        } catch {job.error = "FBA在庫の取得または結果の保存に失敗しました。再度確認してください";}
      }
    })();
    return {...job};
  }
  return {start, status: () => ({...job}), wait: async () => {await task; return {...job};}};
}
