import {registerPageLink, registerPageLinks, updateLinkMemo, runPreview, testDelivery} from "./link-monitor.js";
import {demoMonitor, advanceDemo} from "./link-monitor-demo.js";
import {monitorView} from "./link-monitor-view.js";
import {draftView, patchDraft, addDrafts, buildYahooDraft, buildDraftCsv} from "./cloud-drafts.js";
import {splitDraftQueue} from "./queue.js";
import {salesHistoryView} from "./sales-history.js";
import {stockCsv} from "./cloud-stock.js";

const maxBody = 2 * 1024 * 1024;
const inactive = {status: "idle", pages: 0, scanned: 0};
const apiRoot = "/api/link-monitor";

function fail(message, status) {return Object.assign(new Error(message), {status});}
export async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw fail("JSON形式で送信してください", 415);
  if (Number(request.headers.get("content-length")) > maxBody) throw fail("入力は2MB以内にしてください", 413);
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBody) {await reader.cancel(); throw fail("入力は2MB以内にしてください", 413);}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
  }
  try {return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");}
  catch {throw fail("入力データを読み取れません", 400);}
}

export function createCloudHandler({config, store, draftStore, stock, stockPhotos, ownerAccess, fba, mail, sales, verifyIdentity, verifyOwner, assets = new Map()}) {
  const headers = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://*.yimg.jp https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://images-fe.ssl-images-amazon.com; connect-src 'self' ${new URL(config.authUrl).origin}; frame-src ${new URL(config.authUrl).origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
  if (config.origin.startsWith("https:")) headers["Strict-Transport-Security"] = "max-age=31536000";
  const reply = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {status, headers: {...headers, "Content-Type": "application/json; charset=utf-8", ...extra}});
  const present = ({state, revision}) => ({...monitorView(mail ? mail.view(state) : state, {backend: "postgres", revision, fbaStatus: fba ? fba.status(state) : inactive, notificationStatus: inactive,
    runtimeMessage: fba || mail ? "自動メール・定期確認はオフです。FBA在庫はボタンから更新し、メールは接続確認後に1通だけテストできます。" : "クラウド試行中：実メール・定期確認・外部在庫取得は無効です。",
      capabilities: {cloud: true, readOnly: config.readOnly, inventoryRead: Boolean(fba), mailTest: Boolean(mail), salesRead: Boolean(sales), externalReads: false, legacyDrafts: Boolean(draftStore), preserveControls: Boolean(draftStore)}}), salesHistory: salesHistoryView(state)});
  const snapshot = async () => {
    const data = present(await store.readSnapshot());
    if (stock) data.physicalInventory = (await stock.view()).products.map((p) => ({id: p.id, title: p.title, asin: p.asin, unit:p.unit, linkedLinkIds: p.linkedLinkIds, locations: p.totals.locations}));
    return data;
  };
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== config.origin) return reply({error: "公開先が一致しません"}, 403);
      if (request.headers.get("origin") && request.headers.get("origin") !== config.origin) return reply({error: "同じ管理画面から操作してください"}, 403);
      if (request.headers.get("sec-fetch-site") === "cross-site") return reply({error: "別サイトからは操作できません"}, 403);
      const draftPage = request.method === "GET" && url.pathname === "/" && ["?view=drafts", "?view=stock"].includes(url.search);
      if ((url.search && !draftPage) || url.hash || /%2f|%5c/i.test(url.pathname)) return reply({error: "未対応のURLです"}, 404);
      if (request.method === "GET" && url.pathname === "/api/cloud-config") return reply({authUrl: config.authUrl, setupEnabled: Boolean(ownerAccess)});
      if (request.method === "GET" && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        return new Response(asset.body, {headers: {...headers, "Content-Type": asset.type}});
      }
      if (!url.pathname.startsWith("/api/")) return reply({error: "ページがありません"}, 404);
      if (ownerAccess && request.method === "POST" && ["/api/owner/check", "/api/owner/enroll"].includes(url.pathname)) {
        const data = await jsonBody(request);
        if (url.pathname.endsWith("/check")) return reply(await ownerAccess.check(data.setupToken));
        const identity = await verifyIdentity(request);
        if (identity.status !== 200) return reply({error: "本人のログインを確認してください"}, 401);
        return reply(await ownerAccess.claim({token: data.setupToken, verifiedUserId: identity.userId}));
      }
      const owner = await verifyOwner(request);
      if (owner.status !== 200) return reply({error: owner.status === 403 ? "このアカウントには利用権限がありません" : "ログインが必要です"}, owner.status);
      if (request.method === "GET" && url.pathname === "/api/session") return reply({userId: owner.userId, readOnly: config.readOnly, physicalStock: Boolean(stock)});
      if (stock && request.method === "GET" && url.pathname === "/api/physical-stock") return reply({...await stock.view(), photoRead: Boolean(stockPhotos)});
      if (stock && request.method === "GET" && url.pathname === "/api/physical-stock/export.csv") return new Response(stockCsv(await stock.view()), {headers: {...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=physical-stock.csv"}});
      const stockOperation = url.pathname.match(/^\/api\/physical-stock\/operations\/([0-9a-f-]{36})$/i);
      if (stock && stockOperation && request.method === "GET") return reply(await stock.operation(stockOperation[1], owner.userId));
      if (stockPhotos && request.method === "POST" && url.pathname === "/api/physical-stock/photos") {
        if (config.readOnly) return reply({error: "現在は閲覧のみです"}, 403);
        const match = request.headers.get("if-match");
        if (!/^"(?:0|[1-9][0-9]{0,14})"$/.test(match || "")) return reply({error: "最新の一覧を読み込んでください"}, 428);
        await jsonBody(request);
        return reply(await stockPhotos({expectedRevision: Number(match.slice(1,-1)), actor: owner.userId}));
      }
      if (stock && request.method === "POST" && ["/api/physical-stock/preview", "/api/physical-stock/operations"].includes(url.pathname)) {
        if (config.readOnly) return reply({error: "現在は閲覧のみです"}, 403);
        const match = request.headers.get("if-match");
        if (!/^"(?:0|[1-9][0-9]{0,14})"$/.test(match || "")) return reply({error: "最新の在庫を読み込んでください"}, 428);
        const data = await jsonBody(request), options = {expectedRevision: Number(match.slice(1, -1)), actor: owner.userId, confirmed: data.confirmed};
        return reply(url.pathname.endsWith("/preview") ? await stock.preview(data.command, options) : await stock.commit(data.command, options));
      }
      if (draftStore && ["/api/items", "/api/next-draft", "/api/export/drafts.csv"].includes(url.pathname) && request.method === "GET") {
        const saved = await draftStore.readSnapshot();
        if (url.pathname === "/api/next-draft") return reply({item: splitDraftQueue(saved.state).active[0] || null});
        if (url.pathname.endsWith(".csv")) return new Response("\ufeff" + buildDraftCsv(splitDraftQueue(saved.state).active), {headers: {...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=drafts.csv"}});
        return reply(draftView(saved));
      }
      const draft = url.pathname.match(/^\/api\/items\/([A-Z0-9]{10})\/draft$/);
      if (draftStore && draft && request.method === "GET") {
        const item = (await draftStore.read()).find((entry) => entry.asin === draft[1]);
        return item ? reply({draft: buildYahooDraft(item)}) : reply({error: "商品が見つかりません"}, 404);
      }
      const draftItem = url.pathname.match(/^\/api\/items\/([A-Z0-9]{10})$/);
      if (draftStore && ((draftItem && request.method === "PATCH") || (url.pathname === "/api/asins" && request.method === "POST"))) {
        if (config.readOnly) return reply({error: "現在は閲覧のみです"}, 403);
        const match = request.headers.get("if-match");
        if (!/^"(?:0|[1-9][0-9]{0,14})"$/.test(match || "")) return reply({error: "最新の内容を読み込んでください"}, 428);
        const data = await jsonBody(request);
        const at = new Date().toISOString();
        await draftStore.update((items) => draftItem ? patchDraft(items, draftItem[1], data, at) : addDrafts(items, data.asins, at), {expectedRevision: Number(match.slice(1, -1))});
        return reply(draftView(await draftStore.readSnapshot()));
      }
      if (request.method === "GET" && url.pathname === apiRoot) return reply(await snapshot());
      if (request.method === "GET" && url.pathname === apiRoot + "/fba-status") return reply(fba ? fba.status(await store.read()) : inactive);
      if (request.method === "GET" && url.pathname === apiRoot + "/notification-status") return reply(inactive);
      if (request.method === "POST" && ((fba && url.pathname === apiRoot + "/fba-check") || (sales && ["/sales/start", "/sales/check"].some((route) => url.pathname === apiRoot + route)) || (mail && ["/mail/verify", "/mail/test-registration"].some((route) => url.pathname === apiRoot + route)))) {
        if (config.readOnly) return reply({error: "現在は閲覧のみです"}, 403);
        const match = request.headers.get("if-match");
        if (!/^"(?:0|[1-9][0-9]{0,14})"$/.test(match || "")) return reply({error: "最新の保存内容を読み込んでください"}, 428);
        const data = await jsonBody(request);
        const expectedRevision = Number(match.slice(1, -1));
        if (url.pathname.endsWith("/fba-check")) return reply(await fba.start({expectedRevision}));
        if (url.pathname.endsWith("/sales/start")) {await sales.start({expectedRevision}); return reply(await snapshot());}
        if (url.pathname.endsWith("/sales/check")) {await sales.check({expectedRevision}); return reply(await snapshot());}
        if (url.pathname.endsWith("/verify")) await mail.verify({expectedRevision});
        else await mail.test({expectedRevision, linkId: data.linkId, confirmed: data.confirmed});
        return reply(await snapshot());
      }
      if (request.method === "POST" && url.pathname === apiRoot + "/demo") {
        const data = await jsonBody(request);
        const state = demoMonitor(new Date().toISOString());
        const scenario = advanceDemo(state, data.scenario || "baseline", new Date().toISOString());
        if (["mail_failed", "mail_retry"].includes(data.scenario)) {
          await testDelivery(state.events[0], {testOnly: true, send: async () => {throw new Error("模擬送信エラー。外部には接続していません");}}, new Date().toISOString());
          if (data.scenario === "mail_retry") await testDelivery(state.events[0], {testOnly: true, send: async () => {}}, new Date().toISOString());
        }
        return reply({scenario, result: present({state})});
      }
      const memo = url.pathname.match(/^\/api\/link-monitor\/links\/([^/]+)\/memo$/);
      const route = [apiRoot + "/page-links", apiRoot + "/page-links/batch", apiRoot + "/preview"].includes(url.pathname) || memo;
      if (request.method !== "POST" || !route) return reply({error: "クラウド試行ではこの操作を有効にしていません"}, 404);
      if (config.readOnly) return reply({error: "現在は閲覧のみです。登録・変更はまだ有効にしていません"}, 403);
      const match = request.headers.get("if-match");
      if (!/^"(?:0|[1-9][0-9]{0,14})"$/.test(match || "")) return reply({error: "最新の保存内容を読み込んでから操作してください"}, 428);
      const expectedRevision = Number(match.slice(1, -1));
      const data = await jsonBody(request);
      const at = new Date().toISOString();
      const result = await store.update((state) => {
        let batchResults;
        if (memo) updateLinkMemo(state, decodeURIComponent(memo[1]), data.memo, at);
        else if (url.pathname.endsWith("/batch")) batchResults = registerPageLinks(state, data, at);
        else if (url.pathname.endsWith("/page-links")) registerPageLink(state, data, at);
        else runPreview(state, at);
        state.logs.push({at, kind: "cloud_owner_change", action: memo ? "memo" : url.pathname.split("/").at(-1), actor: owner.userId});
        return batchResults;
      }, {expectedRevision});
      return reply({...await snapshot(), ...(result ? {batchResults: result} : {})});
    } catch (error) {
      if (error.code === "STORAGE_CONFLICT") return reply({error: error.message}, 409);
      if (String(error.code || "").startsWith("STORAGE_")) return reply({error: error.message}, 503);
      if (error.status) return reply({error: error.message}, error.status);
      // Never return database details, credentials, or unexpected upstream error bodies.
      return reply({error: "処理できませんでした。保存内容を確認してからやり直してください"}, 400);
    }
  };
}
