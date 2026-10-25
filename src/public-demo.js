import {jsonBody} from "./cloud-handler.js";
import {demoMonitor, advanceDemo} from "./link-monitor-demo.js";
import {asinFromInput, registerPageLink, registerPageLinks, updateLinkMemo, runPreview, testDelivery} from "./link-monitor.js";
import {monitorView} from "./link-monitor-view.js";
import {validateMonitorState} from "./storage-validation.js";
import {yahooListingUrl} from "./yahoo-observation.js";

const sampleAsin = /^B000DEMO[0-9]{2}$/;
const sampleListing = /^d10000000[0-9]{2}$/;
const scenarios = new Set(["baseline", "zero", "repeat", "recovery", "ended", "stopped", "relisted", "mismatch", "failed", "mail_failed", "mail_retry"]);
function fail(message, status = 400) {return Object.assign(new Error(message), {status});}
function sampleMonitor(at) {
  const state = demoMonitor(at);
  state.catalog[0].listingInfo = {ownCommentStatus: "retrieved", ownComment: "動作確認用のサンプル。本体と電源コード、スタンドなし。"};
  return state;
}
function validateSample(state) {
  validateMonitorState(state);
  for (const key of ["catalog", "listings", "links", "events", "logs"]) if (state[key].length > 1000) throw fail("サンプルが多すぎます。初期状態に戻してください");
  if (state.links.length > 50 || state.catalog.length > 50 || state.listings.length > 50 ||
      state.catalog.some((item) => !sampleAsin.test(item.asin || "")) ||
      state.links.some((item) => item.asin && !sampleAsin.test(item.asin)) ||
      state.listings.some((item) => !sampleListing.test(item.listingId || ""))) throw fail("確認版ではサンプル商品のみ操作できます");
  return state;
}
function samplePair(row) {
  if (!sampleAsin.test(asinFromInput(row.amazon)) || !sampleListing.test(yahooListingUrl(row.yahoo).listingId)) {
    throw fail("確認版ではサンプルASIN・出品URLを入力してください");
  }
}
function origins(env) {
  const values = [env.ASIN_PUBLIC_ORIGIN];
  if (env.VERCEL === "1") {
    for (const host of [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
      if (/^[a-z0-9][a-z0-9-]*\.vercel\.app$/.test(host || "")) values.push(`https://${host}`);
    }
  }
  return new Set(values.filter((value) => {
    try {const url = new URL(value); return url.origin === value && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));}
    catch {return false;}
  }));
}
function present(state, revision) {
  const inactive = {status: "idle", pages: 0, scanned: 0};
  const view = monitorView(state, {backend: "browser-demo", revision, fbaStatus: inactive, notificationStatus: inactive,
    runtimeMessage: "サンプル確認版・このブラウザ内の保存のみ。実メール・外部在庫取得は無効です。",
    capabilities: {cloud: true, readOnly: false, externalReads: false, legacyDrafts: false, publicDemo: true}});
  view.notificationSettings = {mailEnabled: false, monitoringEnabled: false, intervalMinutes: 30, recipient: "送信なし"};
  for (const link of view.links) {
    const product = link.assessment.product;
    if (product) link.assessment.fbaLabel = Number.isSafeInteger(product.fulfillableQuantity) ? `${product.fulfillableQuantity}個（サンプル）` : "確認できず（サンプル）";
  }
  return {...view, demoDocument: state};
}

// Stateless sample endpoint: no storage, credentials, external readers or mailer.
export async function publicDemo(request, env = process.env) {
  const headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"};
  const reply = (data, status = 200) => Response.json(data, {status, headers});
  try {
    const url = new URL(request.url);
    if (env.ASIN_PUBLIC_DEMO !== "1" || url.pathname !== "/api/demo" || url.search || url.hash) return reply({error: "ページがありません"}, 404);
    if (!origins(env).has(url.origin) || (request.headers.get("origin") && request.headers.get("origin") !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") return reply({error: "同じ確認画面から操作してください"}, 403);
    const at = new Date().toISOString();
    if (request.method === "GET") return reply(present(sampleMonitor(at), 0));
    if (request.method !== "POST") return reply({error: "未対応の操作です"}, 405);
    const data = await jsonBody(request);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("入力データを確認してください");
    if (data.action === "scenario") {
      if (!scenarios.has(data.scenario)) throw fail("通知の状態を選択してください");
      const state = sampleMonitor(at);
      const scenario = advanceDemo(state, data.scenario, at);
      if (["mail_failed", "mail_retry"].includes(data.scenario)) {
        await testDelivery(state.events[0], {testOnly: true, send: async () => {throw new Error("模擬送信エラー。外部には接続していません");}}, at);
        if (data.scenario === "mail_retry") await testDelivery(state.events[0], {testOnly: true, send: async () => {}}, at);
      }
      return reply({scenario, result: present(state, 0)});
    }
    if (!["read", "memo", "register", "batch", "preview"].includes(data.action)) throw fail("確認版ではこの操作を有効にしていません", 404);
    const state = validateSample(data.state ? structuredClone(data.state) : sampleMonitor(at));
    const revision = Number.isSafeInteger(data.revision) && data.revision >= 0 && data.revision < Number.MAX_SAFE_INTEGER ? data.revision : 0;
    let batchResults;
    if (data.action === "memo") updateLinkMemo(state, data.linkId, data.memo, at);
    if (data.action === "register") {samplePair(data); registerPageLink(state, {...data, submitted: true}, at);}
    if (data.action === "batch") {
      if (!Array.isArray(data.rows) || data.rows.length > 50) throw fail("登録する商品を1〜50行で入力してください");
      data.rows.forEach(samplePair);
      batchResults = registerPageLinks(state, {rows: data.rows, submitted: true}, at);
    }
    if (data.action === "preview") runPreview(state, at);
    validateSample(state);
    return reply({...present(state, data.action === "read" ? revision : revision + 1), ...(batchResults ? {batchResults} : {})});
  } catch (error) {
    return reply({error: error.status ? error.message : "サンプルを処理できませんでした。入力内容を確認してください"}, error.status || 400);
  }
}
