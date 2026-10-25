import {randomUUID} from "node:crypto";
import {assessLink, runPreview, notificationText, notificationPreview, observeListing, quantity} from "./link-monitor.js";
import {NOTIFICATION_ADDRESS, notificationSettings} from "./notification-settings.js";
export {notificationSettings} from "./notification-settings.js";

function enqueue(state, item, at) {
  state.mailOutbox ||= [];
  if (state.mailOutbox.some((old) => old.key === item.key)) return null;
  const record = {id: randomUUID(), ...item, status: "pending", attempts: 0, createdAt: at};
  state.mailOutbox.push(record);
  return record;
}
function target(link) {return {linkId: link.id, listingId: link.listingId, asin: link.asin || null};}
export function queueRegistration(state, ids, at, {testOnly = false} = {}) {
  if (!notificationSettings(state).mailEnabled) return;
  const links = state.links.filter((link) => ids.includes(link.id));
  for (const link of links) {
    const key = `${testOnly ? "registration-test" : "registration"}:${state.amazonAccountKey || "local"}:${link.asin || link.catalogId}:${link.listingId}`;
    const listing = state.listings.find((item) => item.listingId === link.listingId);
    const product = link.catalogId ? state.catalog.find((item) => item.id === link.catalogId) : null;
    const asin = link.asin || product?.asin;
    enqueue(state, {key, kind: testOnly ? "registration_test" : "registration", subject: testOnly ? "【ヤフオク併売ツール】登録完了メールの送信テスト" : "【ヤフオク併売ツール】紐付けが完了しました", targets: [target(link)],
      text: [testOnly ? "登録完了メールの送信テストです。既存の1商品を例にしており、登録内容は変更していません。" : "Amazonとヤフオクの商品ページを紐付けました。", "", `商品：${listing?.title || product?.title || asin || "商品名未取得"}`, `ASIN：${asin || "不明"}`, `Amazon：https://www.amazon.co.jp/dp/${asin || ""}`, `ヤフオク：${listing?.url || "不明"}`, "", "在庫や出荷可否の確認完了を意味するものではありません。", `${testOnly ? "テスト" : "登録"}時刻：${new Date(at).toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"})}（日本時間）`, "出品・在庫の変更は行っていません。"].join("\n")}, at);
  }
}
function eligible(event) {
  // Raw quantity alone does not prove MCF eligibility. Notify raw zero separately.
  return !(event.kind === "inventory_unknown" && event.assessment.product?.source === "amazon_sp_api" && quantity(event.assessment.product.fulfillableQuantity) !== null);
}
function monitorMailText(events, at) {
  const summaries = events.map((event, index) => {
    const {product, listing} = event.assessment;
    const preview = notificationPreview(event);
    return [`${index + 1}. ${event.title}`, `商品：${listing?.title || product?.title || product?.asin || "不明"} ／ ASIN：${product?.asin || "不明"}`, preview.message,
      `必要な対応：${preview.action}`, `ヤフオク：${listing?.url || "不明"}`, `Amazon：https://www.amazon.co.jp/dp/${product?.asin || ""}`].join("\n");
  });
  return [`確認結果：${new Date(at).toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"})}（日本時間）`, "出品停止や在庫数の変更は行っていません。", "", ...summaries.flatMap((summary) => [summary, ""]),
    "【補足情報：数量項目・出品状態・確認時刻・判定理由】", ...events.map((event) => notificationText(event, {preview: false}))].join("\n\n");
}
export function queueMonitorResults(state, at) {
  const working = {...state, events: [], links: state.links.map((link) => ({...structuredClone(link), signals: structuredClone(link.mailSignals || {}), reviewAlerted: link.mailReviewAlerted || false}))};
  for (const link of working.links) {
    const latest = link.history.at(-1);
    const signature = latest ? JSON.stringify(latest) : null;
    if (signature && signature !== link.mailSuccessorSignature) link.pendingSuccessor = latest;
    else delete link.pendingSuccessor;
  }
  const events = runPreview(working, at);
  for (const link of working.links) {
    const original = state.links.find((item) => item.id === link.id);
    original.mailSignals = link.signals;
    original.mailReviewAlerted = link.reviewAlerted;
    original.mailSuccessorSignature = link.history.length ? JSON.stringify(link.history.at(-1)) : null;
    const assessment = assessLink(original, state, at);
    const count = quantity(assessment.product?.fulfillableQuantity);
    if (assessment.inventory === "unlinked") continue;
    const acquired = assessment.product?.source === "amazon_sp_api" && count !== null;
    const addFetchEvent = (kind, title) => {
      if (!events.some((event) => event.linkId === link.id && event.kind === kind)) events.push({id: randomUUID(), linkId: link.id, kind, title, at, assessment: structuredClone(assessment), delivery: {status: "preview", attempts: 0}});
    };
    if (!acquired && original.mailInventoryFetch !== "failed") addFetchEvent("inventory_unknown", "FBA在庫を確認できません");
    if (acquired && original.mailInventoryFetch === "failed") addFetchEvent("inventory_restored", "FBA在庫の取得が復旧しました");
    original.mailInventoryFetch = acquired ? "complete" : "failed";
    if (!acquired) continue;
    const current = count === 0 ? "zero" : "positive";
    if (original.mailRawQuantity !== current && (current === "zero" || original.mailRawQuantity === "zero")) {
      events.push({id: randomUUID(), linkId: link.id, kind: current === "zero" ? "inventory_observed_zero" : "inventory_observed_recovered", at,
        title: current === "zero" ? "FBA取得分が0個です・在庫切れは未確定" : "FBA取得分の数量が復帰しました", assessment: structuredClone(assessment), delivery: {status: "preview", attempts: 0}});
    }
    original.mailRawQuantity = current;
  }
  const deliverable = events.filter(eligible);
  for (const event of events.filter((item) => !eligible(item))) event.delivery.status = "info_only";
  state.events.push(...events);
  if (deliverable.length && notificationSettings(state).mailEnabled) {
    const products = new Set(deliverable.map((event) => event.linkId)).size;
    const record = enqueue(state, {key: `monitor:${randomUUID()}`, kind: "monitor", subject: `【ヤフオク併売ツール】確認が必要な商品 ${products}件`,
      eventIds: deliverable.map((event) => event.id), targets: [...new Map(deliverable.map((event) => {const link = state.links.find((item) => item.id === event.linkId); return [link.id, target(link)];})).values()],
      text: monitorMailText(deliverable, at)}, at);
    for (const event of deliverable) event.delivery = {...event.delivery, status: "pending", outboxId: record.id};
  }
  return deliverable;
}
export function observeTrackedListing(state, linkId, snapshot) {
  const link = state.links.find((item) => item.id === linkId);
  const listing = state.listings.find((item) => item.listingId === link?.listingId);
  if (!listing || snapshot.listingId !== listing.listingId) return;
  if (Date.parse(snapshot.observation?.checkedAt) < Date.parse(listing.observation?.checkedAt)) return;
  const refs = snapshot.references?.filter((ref) => ref.kind === "asin") || [];
  link.observationConflict = Boolean(link.matchBy === "asin" && refs.length && refs.some((ref) => ref.value !== link.asin));
  observeListing(state, {...listing, title: snapshot.title || listing.title, imageUrl: snapshot.imageUrl || listing.imageUrl,
    observedReferences: snapshot.references, observedSeller: snapshot.seller, observation: snapshot.observation});
}

export function createNotificationService({store, transport, fbaJob, fetchListing, now = () => new Date().toISOString()}) {
  let draining, checking, timer;
  let runtime = {status: "idle"};
  const log = (state, kind, message) => state.logs.push({at: now(), kind, message});
  async function recover() {
    const records = (await store.read()).mailOutbox?.filter((item) => item.status === "sending") || [];
    for (const item of records) {
      const receipt = await transport.receipt(item.attemptId);
      await store.update((state) => {
        const current = state.mailOutbox.find((record) => record.id === item.id);
        if (current?.status !== "sending") return;
        current.status = receipt === "smtp_accepted" ? "smtp_accepted" : receipt === "failed" ? "failed" : "uncertain";
        if (current.status === "failed") current.nextAttemptAt = new Date(Date.parse(now()) + 5 * 60000).toISOString();
        for (const event of state.events.filter((event) => current.eventIds?.includes(event.id))) event.delivery = {...event.delivery, status: current.status, at: now()};
        log(state, "mail_recovered", current.status === "smtp_accepted" ? "Gmailの送信受付記録を復旧しました" : current.status === "failed" ? "送信失敗の記録を復旧し、再試行を予約しました" : "前回の送信結果が不明です。自動再送を保留しました");
      });
    }
  }
  function drain() {
    if (draining) return draining;
    draining = (async () => {
      while (true) {
        const item = await store.update((state) => {
          if (!notificationSettings(state).mailEnabled) return null;
          const record = state.mailOutbox?.find((entry) => ["pending", "failed"].includes(entry.status) && (!entry.nextAttemptAt || entry.nextAttemptAt <= now()) && entry.attempts < (entry.maxAttempts || 3));
          if (!record) return null;
          if (!record.targets.every((entry) => state.links.some((link) => link.id === entry.linkId && link.listingId === entry.listingId))) {record.status = "cancelled"; return {cancelled: true};}
          record.status = "sending";
          record.attempts++;
          record.attemptId = randomUUID();
          record.lastAttemptAt = now();
          return structuredClone(record);
        });
        if (!item) break;
        if (item.cancelled) continue;
        let result;
        try {result = await transport.send({...item, id: item.attemptId});}
        catch {result = {status: "failed", error: "メール送信処理を起動できませんでした"};}
        await store.update((state) => {
          const current = state.mailOutbox.find((record) => record.id === item.id);
          current.status = ["smtp_accepted", "failed"].includes(result.status) ? result.status : "uncertain";
          current.error = result.error || (current.status === "uncertain" ? "送信結果が不明です。受信箱を確認してください" : null);
          current.finishedAt = now();
          if (current.status === "failed") current.nextAttemptAt = new Date(Date.parse(now()) + 5 * 60000).toISOString();
          for (const event of state.events.filter((event) => current.eventIds?.includes(event.id))) event.delivery = {status: current.status, attempts: current.attempts, outboxId: current.id, at: now()};
          log(state, `mail_${current.status}`, current.status === "smtp_accepted" ? "Gmailが通知メールを受け付けました。受信箱への到着は未確認です" : current.error);
        });
      }
    })().finally(() => {draining = null;});
    return draining;
  }
  function check() {
    if (checking) return checking;
    runtime = {status: "running", startedAt: now()};
    checking = (async () => {
      try {
        if (!notificationSettings(await store.read()).mailEnabled) throw new Error("通知メールを有効にしてから実行してください");
        await fbaJob.start(); await fbaJob.wait();
        const links = (await store.read()).links;
        for (const link of links) {
          const state = await store.read();
          const listing = state.listings.find((item) => item.listingId === link.listingId);
          if (!listing) continue;
          try {
            const snapshot = await fetchListing(listing.url);
            await store.update((current) => observeTrackedListing(current, link.id, snapshot));
          } catch {
            await store.update((current) => {
              const item = current.listings.find((entry) => entry.listingId === link.listingId);
              if (item) observeListing(current, {...item, observation: {status: "unknown", verified: false, checkedAt: now(), source: "public_page", evidence: "商品ページを取得できません。終了とは判定しません"}});
              log(current, "yahoo_monitor_failed", "出品状態を確認できませんでした。終了とは判定しません");
            });
          }
        }
        await store.update((state) => {
          if (notificationSettings(state).mailEnabled) queueMonitorResults(state, now());
          state.notificationSettings = {...notificationSettings(state), lastCheckAt: now(), nextCheckAt: new Date(Date.parse(now()) + 30 * 60000).toISOString()};
          log(state, "notification_check", "在庫・出品状態を確認しました。出品変更は行っていません");
        });
        await drain();
        runtime = {...runtime, status: "complete", finishedAt: now()};
      } catch (error) {
        runtime = {...runtime, status: "failed", error: error.message, finishedAt: now()};
        await store.update((state) => {
          state.notificationSettings = {...notificationSettings(state), nextCheckAt: new Date(Date.parse(now()) + 30 * 60000).toISOString()};
          log(state, "notification_check_failed", error.message);
        });
      }
      return runtime;
    })().finally(() => {checking = null;});
    return checking;
  }
  async function tick() {
    const settings = notificationSettings(await store.read());
    if (settings.mailEnabled) await drain();
    if (settings.monitoringEnabled && settings.mailEnabled && (!settings.nextCheckAt || settings.nextCheckAt <= now())) await check();
  }
  async function configure(data) {
    if (typeof data.mailEnabled !== "boolean" || typeof data.monitoringEnabled !== "boolean") throw new Error("通知のオン・オフを指定してください");
    if (data.monitoringEnabled && !data.mailEnabled) throw new Error("自動確認には通知メールを有効にしてください");
    if (data.mailEnabled && !await transport.available()) throw new Error("保存済みのGmail設定が見つかりません");
    await store.update((state) => {
      state.notificationSettings = {...notificationSettings(state), mailEnabled: data.mailEnabled, monitoringEnabled: data.monitoringEnabled,
        nextCheckAt: new Date(Date.parse(now()) + 30 * 60000).toISOString()};
      log(state, "notification_settings", "通知設定を保存しました。過去の登録分は一斉送信しません");
    });
  }
  async function retry(id) {
    await store.update((state) => {
      if (!notificationSettings(state).mailEnabled) throw new Error("通知メールを有効にしてから再試行してください");
      const record = state.mailOutbox?.find((item) => item.id === id);
      if (!record || record.status !== "failed") throw new Error("送信失敗のメールだけ再試行できます。結果不明は受信箱を確認してください");
      record.status = "pending"; record.maxAttempts = record.attempts + 3; delete record.nextAttemptAt;
    });
    return drain();
  }
  return {configure, check, drain, retry, recover, status: () => ({...runtime}), async tick() {await tick();},
    start() {if (!timer) {timer = setInterval(() => {tick().catch(() => {});}, 30000); timer.unref();}}, stop() {clearInterval(timer); timer = null;}};
}
