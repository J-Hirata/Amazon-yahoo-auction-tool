import {monitorStore} from "./link-monitor-store.js";
import {parseCatalog, confirmLink, confirmAsinLink, registerPageLink, registerPageLinks, updateLinkMemo, updateListingPreview, observeListing, registerSuccessor, runPreview, testDelivery} from "./link-monitor.js";
import {fetchYahooListing, yahooListingUrl, managementReferences} from "./yahoo-observation.js";
import {demoMonitor, advanceDemo} from "./link-monitor-demo.js";
import {createManualFbaJob} from "./manual-fba-job.js";
import {createGmailTransport} from "./gmail-transport.js";
import {createNotificationService, notificationSettings, queueRegistration} from "./monitor-notifications.js";
import {monitorView} from "./link-monitor-view.js";

const fbaJob = createManualFbaJob({store: monitorStore});
const databaseMode = monitorStore.backend === "postgres";
const gmail = databaseMode ? {available: async () => false, receipt: async () => null,
  send: async () => {throw new Error("クラウド用メール送信はまだ有効になっていません");}} : createGmailTransport(monitorStore.directory);
const notifications = createNotificationService({store: monitorStore, transport: gmail, fbaJob, fetchListing: fetchYahooListing});
const notificationBoot = databaseMode ? Promise.resolve() : notifications.recover().then(() => {
  if (process.env.ASIN_DISABLE_BACKGROUND !== "1") notifications.start();
});
notificationBoot.catch(() => {});
const drainNotifications = () => databaseMode ? Promise.resolve() : notifications.drain();

function view(state) {
  return monitorView(state, {backend: monitorStore.backend, fbaStatus: fbaJob.status(), notificationStatus: notifications.status(),
    notificationRuntime: !databaseMode, runtimeMessage: databaseMode ? "DB保存の試行中です。クラウド用メール・定期確認はまだ有効になっていません。" : null});
}
async function body(req) {
  let content = "";
  for await (const chunk of req) {content += chunk; if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("入力データは2MB以内にしてください");}
  return JSON.parse(content || "{}");
}
function reply(res, payload, status = 200) {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"});
  res.end(JSON.stringify(payload));
}
function allowMutation(req, url) {
  const origin = req.headers.origin;
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  return local && (!origin || origin === url.origin);
}
export async function handleLinkMonitor(req, res, url) {
  if (!url.pathname.startsWith("/api/link-monitor")) return false;
  try {
    await notificationBoot;
    if (!["GET", "POST", "DELETE"].includes(req.method)) { reply(res, {error: "未対応の操作です"}, 405); return true; }
    if (req.method !== "GET" && (!allowMutation(req, url) || !String(req.headers["content-type"] || "").startsWith("application/json"))) { reply(res, {error: "管理画面から操作してください"}, 403); return true; }
    if (req.method === "GET" && url.pathname === "/api/link-monitor") {reply(res, view(await monitorStore.read())); return true;}
    if (req.method === "GET" && url.pathname === "/api/link-monitor/fba-status") {reply(res, fbaJob.status()); return true;}
    if (req.method === "GET" && url.pathname === "/api/link-monitor/notification-status") {reply(res, notifications.status()); return true;}
    const data = req.method === "POST" ? await body(req) : {};
    const at = new Date().toISOString();
    if (databaseMode && req.method === "POST" && (url.pathname.includes("/mail/") || url.pathname.endsWith("/check-and-notify") ||
      (url.pathname.endsWith("/notification-settings") && (data.mailEnabled || data.monitoringEnabled)))) {
      reply(res, {error: "DB保存の試行中は実メールと定期確認を有効にできません"}, 409); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/link-monitor/notification-settings") {
      await notifications.configure(data);
      reply(res, view(await monitorStore.read())); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/link-monitor/check-and-notify") {
      void notifications.check().catch(() => {});
      reply(res, notifications.status(), 202); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/link-monitor/mail/test-registration") {
      await monitorStore.update((state) => {
        if (!notificationSettings(state).mailEnabled) throw new Error("通知メールを有効にしてからテストしてください");
        if (!state.links.some((item) => item.id === data.linkId)) throw new Error("テストする紐付けが見つかりません");
        queueRegistration(state, [data.linkId], at, {testOnly: true});
      });
      await notifications.drain();
      reply(res, view(await monitorStore.read())); return true;
    }
    if (req.method === "POST" && url.pathname.match(/^\/api\/link-monitor\/mail\/[^/]+\/retry$/)) {
      await notifications.retry(url.pathname.split("/")[4]);
      reply(res, view(await monitorStore.read())); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/link-monitor/demo") {
      const state = demoMonitor(at);
      const scenario = advanceDemo(state, data.scenario || "baseline", at);
      if (["mail_failed", "mail_retry"].includes(data.scenario)) {
        const event = state.events[0];
        await testDelivery(event, {testOnly: true, send: async () => {throw new Error("模擬送信エラー。外部には接続していません");}}, at);
        if (data.scenario === "mail_retry") await testDelivery(event, {testOnly: true, send: async () => {}}, at);
        scenario.push({label: data.scenario === "mail_retry" ? "模擬送信の再試行成功" : "模擬送信の失敗を記録", events: 0});
      }
      reply(res, {scenario, result: view(state)});
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/link-monitor/fba-check") {
      reply(res, await fbaJob.start(), 202);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/link-monitor/catalog") {
      const incoming = parseCatalog(data.content, data.context || {});
      await monitorStore.update((state) => {
        for (const item of incoming) {
          const old = state.catalog.find((entry) => entry.id === item.id);
          if (old && Date.parse(item.checkedAt) < Date.parse(old.checkedAt)) throw new Error("保存済みより古い在庫情報です。新しい情報を指定してください");
          if (old) state.catalog[state.catalog.indexOf(old)] = item; else state.catalog.push(item);
        }
      });
    } else if (req.method === "POST" && url.pathname === "/api/link-monitor/yahoo") {
      let snapshot;
      const identity = yahooListingUrl(data.url);
      try {
        snapshot = await fetchYahooListing(identity.url);
      } catch (error) {
        await monitorStore.update((state) => {
          state.logs.push({at, kind: "yahoo_fetch_failed", listingId: identity.listingId, message: error.message});
          const old = state.listings.find((item) => item.listingId === identity.listingId);
          if (old) observeListing(state, {...old, observation: {status: "unknown", verified: false, checkedAt: at, source: "public_page", evidence: error.message}});
        });
        throw error;
      }
      await monitorStore.update((state) => observeListing(state, snapshot));
    } else if (req.method === "POST" && url.pathname === "/api/link-monitor/manual-listing") {
      const identity = yahooListingUrl(data.url);
      if (!String(data.title || "").trim() || !String(data.seller || "").trim()) throw new Error("商品名と出品者を入力してください");
      const snapshot = {...identity, title: String(data.title), seller: String(data.seller), condition: String(data.condition || ""), description: String(data.description || ""), references: managementReferences(data.description), observation: {status: "unknown", verified: false, checkedAt: at, source: "manual", evidence: "手動登録。出品状態は未確認です"}};
      await monitorStore.update((state) => observeListing(state, snapshot));
    } else if (req.method === "POST" && url.pathname === "/api/link-monitor/page-links") {
      await monitorStore.update((state) => {
        const before = new Set(state.links.map((item) => item.id));
        const link = registerPageLink(state, data, at);
        if (!before.has(link.id)) queueRegistration(state, [link.id], at);
      });
      void drainNotifications().catch(() => {});
    } else if (req.method === "POST" && url.pathname === "/api/link-monitor/page-links/batch") {
      const batchResults = await monitorStore.update((state) => {
        const results = registerPageLinks(state, data, at);
        queueRegistration(state, results.filter((item) => item.status === "created").map((item) => item.linkId), at);
        return results;
      });
      void drainNotifications().catch(() => {});
      reply(res, {...view(await monitorStore.read()), batchResults});
      return true;
    } else if (req.method === "POST" && url.pathname === "/api/link-monitor/asin-links") {
      await monitorStore.update((state) => {
        const before = new Set(state.links.map((item) => item.id));
        const link = confirmAsinLink(state, data, at);
        if (!before.has(link.id)) queueRegistration(state, [link.id], at);
      });
      void drainNotifications().catch(() => {});
    } else if (req.method === "POST" && url.pathname === "/api/link-monitor/links") {
      await monitorStore.update((state) => {
        const before = new Set(state.links.map((item) => item.id));
        const link = confirmLink(state, data, at);
        if (!before.has(link.id)) queueRegistration(state, [link.id], at);
      });
      void drainNotifications().catch(() => {});
    } else if (req.method === "POST" && url.pathname.match(/^\/api\/link-monitor\/links\/[^/]+\/memo$/)) {
      const id = url.pathname.split("/")[4];
      await monitorStore.update((state) => updateLinkMemo(state, id, data.memo, at));
    } else if (req.method === "POST" && url.pathname.match(/^\/api\/link-monitor\/links\/[^/]+\/product-preview$/)) {
      const id = url.pathname.split("/")[4];
      const state = await monitorStore.read();
      const link = state.links.find((item) => item.id === id);
      const listing = state.listings.find((item) => item.listingId === link?.listingId);
      if (!listing) throw new Error("紐付けが見つかりません。画面を更新してください");
      try {
        const snapshot = await fetchYahooListing(listing.url);
        await monitorStore.update((current) => updateListingPreview(current, id, snapshot, new Date().toISOString()));
      } catch (error) {
        await monitorStore.update((current) => current.logs.push({at, kind: "product_preview_failed", linkId: id, message: error.message}));
        throw new Error("紐付けは保存済みですが、画像・商品名を取得できませんでした。後から再度取得できます");
      }
    } else if (req.method === "POST" && url.pathname.match(/^\/api\/link-monitor\/links\/[^/]+\/successor$/)) {
      const id = url.pathname.split("/")[4];
      await monitorStore.update((state) => registerSuccessor(state, id, data, at));
      await monitorStore.update((state) => queueRegistration(state, [id], at));
      void drainNotifications().catch(() => {});
    } else if (req.method === "DELETE" && url.pathname.match(/^\/api\/link-monitor\/links\/[^/]+$/)) {
      const id = url.pathname.split("/")[4];
      await monitorStore.update((state) => {state.links = state.links.filter((item) => item.id !== id); state.logs.push({at, kind: "unlink", linkId: id});});
    } else if (req.method === "POST" && url.pathname === "/api/link-monitor/preview") {
      await monitorStore.update((state) => { const events = runPreview(state, at); state.logs.push({at, kind: "preview_check", events: events.length}); });
    } else {
      reply(res, {error: "未対応の操作です。実メール送信・定期稼働は無効です"}, 404);
      return true;
    }
    reply(res, view(await monitorStore.read()));
  } catch (error) {reply(res, {error: error.message}, error.code === "STORAGE_CONFLICT" ? 409 : String(error.code || "").startsWith("STORAGE_") ? 503 : 400);}
  return true;
}
