import assert from "node:assert/strict";
import http from "node:http";
import {Readable} from "node:stream";
import {once} from "node:events";
import {mkdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {generateKeyPair, SignJWT} from "jose";
import {createOwnerVerifier, createIdentityVerifier} from "../src/cloud-auth.js";
import {createCloudHandler} from "../src/cloud-handler.js";
import {loadCloudAssets} from "../src/cloud-runtime.js";
import {demoMonitor} from "../src/link-monitor-demo.js";
import {createVercelEntry} from "../src/vercel-entry.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {storageConfiguration} from "../src/storage-runtime.js";
import {validateMonitorState} from "../src/storage-validation.js";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {createCloudFba} from "../src/cloud-fba.js";
import {createCloudMail} from "../src/cloud-mail.js";
import {createCloudSales} from "../src/cloud-sales.js";

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const vercelMode = process.env.ASIN_TEST_VERCEL === "1";
const fullWorkspace = process.env.ASIN_TEST_FULL_WORKSPACE === "1";
const connections = process.env.ASIN_TEST_CLOUD_CONNECTIONS === "1";
const realDatabase = vercelMode && process.env.ASIN_RUN_DATABASE_TESTS === "1";
const manifest = vercelMode ? JSON.parse(await readFile(path.join(root, ".vercel", "output", "config.json"), "utf8")) : null;
const rewrite = manifest?.routes.find((route) => route.dest?.startsWith("/api/inventory?__route="));
if (vercelMode) assert.ok(rewrite, "Build the Vercel package before this test");
const files = ["link-monitor.json", "items.json", "stock-watch.json", "gmail-test-result.json"];
const original = await Promise.all(files.map((name) => readFile(path.join(root, "data", name))));
const authUrl = "https://browser-fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth";
const ownerUserId = "browser-owner-fixture";
const {privateKey, publicKey} = await generateKeyPair("EdDSA");
const jwt = await new SignJWT({}).setProtectedHeader({alg: "EdDSA"}).setSubject(ownerUserId).setIssuer(new URL(authUrl).origin).setIssuedAt().setExpirationTime("15m").sign(privateKey);
let state = demoMonitor(new Date().toISOString());
if (fullWorkspace) state = JSON.parse(original[0]);
else state.listings[0].imageUrl = "https://auctions.c.yimg.jp/fixture-monitor.png";
let drafts = fullWorkspace ? JSON.parse(original[1]) : [];
let draftRevision = 1;
const draftStore = fullWorkspace ? {
  readSnapshot: async () => ({state: structuredClone(drafts), revision: draftRevision}),
  read: async () => structuredClone(drafts),
  update: async (callback, {expectedRevision}) => {
    assert.equal(expectedRevision, draftRevision); const next = structuredClone(drafts);
    await callback(next); drafts = next; draftRevision++;
  }
} : undefined;
let enrolled = false;
const setupToken = "a".repeat(64);
const ownerAccess = fullWorkspace ? {
  check: async (value) => {assert.equal(value, setupToken); return {available: true};},
  claim: async ({token, verifiedUserId}) => {assert.equal(token, setupToken); assert.equal(verifiedUserId, ownerUserId); enrolled = true; return {status: "enrolled"};},
  ownerUserId: async () => enrolled ? ownerUserId : null
} : undefined;
let revision = 1;
let store = {
  read: async () => structuredClone(state),
  readSnapshot: async () => ({state: structuredClone(state), revision}),
  update: async (callback, {expectedRevision} = {}) => {
    if (expectedRevision !== undefined && revision !== expectedRevision) throw Object.assign(new Error("更新競合"), {code: "STORAGE_CONFLICT"});
    const next = structuredClone(state);
    const result = await callback(next); state = next; revision++; return result;
  }
};
let handler;
const server = http.createServer(async (req, res) => {
  try {
    const incoming = new URL(req.url, base);
    const match = rewrite && incoming.pathname.startsWith("/api/") ? incoming.pathname.match(new RegExp(rewrite.src)) : null;
    const target = match ? new URL(rewrite.dest.replace(/\$(\d+)/g, (_, index) => match[Number(index)] || ""), base) : incoming;
    const request = new Request(target, {method: req.method, headers: req.headers,
      ...(["GET", "HEAD"].includes(req.method) ? {} : {body: Readable.toWeb(req), duplex: "half"})});
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.writeHead(500); res.end();}
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
let databasePool, databaseKey;
let checks = 0;
const pass = (name) => {checks++; console.log(`PASS ${name}`);};
try {
  if (realDatabase) {
    const config = storageConfiguration();
    assert.equal(config.backend, "postgres");
    assert.equal(config.environment, "development");
    databasePool = new Pool(config.poolOptions);
    databaseKey = `test-vercel-browser-${randomUUID()}`;
    await databasePool.query("INSERT INTO app_storage.documents(document_key, payload) VALUES ($1, $2::jsonb)", [databaseKey, JSON.stringify(state)]);
    store = createPostgresDocumentStore({pool: databasePool, key: databaseKey, validate: validateMonitorState});
  }
  let testEmails = 0, inventoryReads = 0;
  const accountKey = state.amazonAccountKey || "fixture-account";
  const sellerId = state.amazonSellerId || "FIXTURESELLER";
  const fba = connections ? createCloudFba({store, config: {accountKey, sellerId}, readInventory: async ({asins}) => {
    inventoryReads++; return {status: "complete", complete: true, scope: "linked_asins_only", asins, accountKey, sellerId, startedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), pages: 2, scanned: asins.length,
      items: asins.map((asin) => ({asin, sellerSku: "FIXTURE-" + asin, fulfillableQuantity: 5, condition: "UsedGood", source: "amazon_sp_api"}))};
  }}) : undefined;
  const mail = connections ? createCloudMail({store, transport: {verify: async () => {}, send: async () => {testEmails++; return {status: "smtp_accepted"};}}}) : undefined;
  let salesClock = new Date().toISOString(), orderReads = 0;
  const sales = connections ? createCloudSales({store, config: {accountKey, sellerId, marketplaceId: "A1VC38T7YXB528"}, now: () => salesClock,
    readOrders: async ({after, before, targets}) => {orderReads++; return {complete: true, accountKey, sellerId, marketplaceId: "A1VC38T7YXB528", after, before, pages: 1,
      rows: orderReads > 1 ? [] : [{orderId: "fixture-private-order", itemId: "fixture-item", ...targets[0], quantity: 1, status: "UNSHIPPED", fulfillment: "AMAZON", createdAt: after, updatedAt: before}]};}}) : undefined;
  const privateHandler = createCloudHandler({config: {origin: base, authUrl, ownerUserId, readOnly: false}, store, draftStore, ownerAccess, fba, mail, sales,
    verifyIdentity: createIdentityVerifier({authUrl, keySet: publicKey}),
    verifyOwner: createOwnerVerifier({authUrl, ownerUserId, keySet: publicKey, ...(ownerAccess ? {resolveOwnerUserId: ownerAccess.ownerUserId} : {})}),
    assets: await loadCloudAssets(vercelMode ? path.join(root, ".vercel", "output", "static") : undefined)});
  handler = vercelMode ? createVercelEntry({runtimeFactory: async () => ({handler: privateHandler}), environment: () => ({ASIN_PUBLIC_ORIGIN: base})}) : privateHandler;
  browser = await chromium.launch({headless: true, channel: "chrome"});
  const context = await browser.newContext({viewport: {width: 1440, height: 1080}});
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let loggedIn = false;
  const user = {id: ownerUserId, name: "Fixture owner", email: "fixture@example.invalid", emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
  await context.route(authUrl + "/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {"Access-Control-Allow-Origin": base, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "content-type, authorization, x-neon-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "set-auth-jwt"};
    if (request.method() === "OPTIONS") return route.fulfill({status: 204, headers});
    let body = null;
    if (url.pathname.endsWith("/sign-in/email") || url.pathname.endsWith("/sign-up/email")) {
      if (request.postDataJSON().password !== "fixture-password-only") return route.fulfill({status: 401, headers, json: {message: "Invalid login"}});
      loggedIn = true; body = {token: "fixture-session", user};
    } else if (url.pathname.endsWith("/sign-out")) {loggedIn = false; body = {success: true};}
    else if (url.pathname.endsWith("/token")) body = loggedIn ? {token: jwt} : null;
    else if (url.pathname.endsWith("/get-session")) body = loggedIn ? {session: {id: "fixture-session-id", token: "fixture-session", userId: ownerUserId, expiresAt: new Date(Date.now() + 3600000).toISOString()}, user} : null;
    else throw new Error("Unexpected auth endpoint: " + url.pathname);
    await route.fulfill({status: 200, headers: {...headers, ...(loggedIn ? {"set-auth-jwt": jwt} : {})}, contentType: "application/json", body: JSON.stringify(body)});
  });
  if (process.env.ASIN_TEST_REAL_IMAGES !== "1") await context.route("https://auctions.c.yimg.jp/**", (route) => route.fulfill({contentType: "image/png", path: path.join(root, "public", "extension-logo.png")}));
  assert.equal((await fetch(base + "/api/link-monitor")).status, 401);
  await page.goto(base + (fullWorkspace ? `/#setup=${setupToken}` : ""));
  await page.locator("#loginSubmit:not([disabled])").waitFor();
  assert.equal(await page.locator("#cloudApp").isVisible(), false);
  if (fullWorkspace) assert.equal(new URL(page.url()).hash, "");
  pass("anonymous browser shows login without business data");
  await page.locator("#loginEmail").fill("fixture@example.invalid");
  await page.locator("#loginPassword").fill("incorrect-fixture-password");
  await page.locator("#loginSubmit").click();
  await page.locator("#loginSubmit:not([disabled])").waitFor();
  assert.match(await page.locator("#loginStatus").textContent(), /ログインできません/);
  pass("login error remains readable and does not reveal data");
  await page.locator("#loginPassword").fill("fixture-password-only");
  await page.locator("#loginSubmit").click();
  await page.locator("#cloudApp:not([hidden]) #linkRows tr").first().waitFor();
  if (fullWorkspace) {assert.equal(enrolled, true); assert.equal(await page.locator("#linkRows tr").count(), 15);}
  else assert.match(await page.locator("#linkRows").textContent(), /練習用モニター/);
  if (process.env.ASIN_TEST_REAL_IMAGES === "1") {
    for (const image of await page.locator("#linkRows img").all()) await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll("#linkRows img")].every((image) => image.complete));
    const images = await page.locator("#linkRows img").evaluateAll((images) => images.map((image) => ({loaded: image.naturalWidth > 0, source: new URL(image.src).hostname})));
    assert.equal(images.length, 15); assert.ok(images.every((image) => image.loaded && image.source.endsWith(".yimg.jp")));
    pass("15 existing Yahoo product photos loaded from their original CDN URLs");
    await page.evaluate(() => scrollTo(0, 0));
  }
  assert.equal(await page.locator("#loginPassword").inputValue(), "");
  assert.equal(await page.locator("#fbaCheck").isVisible(), fullWorkspace);
  assert.equal(await page.locator("#productRefresh").isVisible(), fullWorkspace);
  if (fullWorkspace) assert.equal(await page.locator("#fbaCheck").isDisabled(), !connections);
  pass("SDK login and owner JWT open preserved records; external actions remain unavailable");
  if (connections) {
    const fbaResponse = page.waitForResponse((response) => response.url().endsWith("/api/link-monitor/fba-check"));
    await page.locator("#fbaCheck").click();
    const response = await fbaResponse;
    const payload = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(payload));
    assert.equal(payload.status, "complete", JSON.stringify(payload));
    await page.waitForFunction(() => document.querySelector("#monitorStatus").textContent.includes("FBA在庫の確認が終わりました"));
    assert.equal(inventoryReads, 1); assert.equal(testEmails, 0);
    assert.equal((await store.read()).amazonInventory.complete, true);
    pass("connected UI refreshes only linked inventory without sending mail");
    salesClock = new Date().toISOString();
    await page.locator("#salesStart").click();
    await page.waitForFunction(() => document.querySelector("#salesSummary").textContent.includes("開始済み"));
    assert.equal(orderReads, 0); assert.equal(testEmails, 0);
    const trackingStart = (await store.read()).salesTracking.startedAt;
    salesClock = new Date(Date.parse(trackingStart) + 10 * 60000).toISOString();
    await page.locator("#salesCheck").click();
    await page.waitForFunction(() => document.querySelector("#salesSummary").textContent.includes("注文確認済み"));
    assert.match(await page.locator("#linkRows").textContent(), /追跡後の注文確定：1個/);
    await page.locator("#salesHistoryDetails summary").click();
    assert.match(await page.locator("#salesPreview").textContent(), /今回の注文確定：1個/);
    assert.equal(orderReads, 1); assert.equal(testEmails, 0);
    await page.reload(); await page.locator("#cloudApp:not([hidden]) #linkRows tr").first().waitFor();
    assert.match(await page.locator("#linkRows").textContent(), /追跡後の注文確定：1個/);
    salesClock = new Date(Date.parse(trackingStart) + 14 * 60000).toISOString();
    await page.locator("#salesCheck").click();
    await page.waitForFunction(() => document.querySelector("#monitorStatus").textContent.includes("販売履歴と通知プレビューを更新"));
    assert.equal(orderReads, 2); assert.equal((await store.read()).salesTracking.events.length, 1);
    assert.match(await page.locator("#salesPreview").textContent(), /新しい販売・訂正はありません/);
    assert.equal(testEmails, 0);
    pass("sales start/check/preview/reload are durable and repeated checking does not duplicate orders or send mail");
  }
  await page.locator(".memo-edit").first().click();
  await page.locator("textarea[name=memo]").first().fill("クラウド画面の保存試験：スタンドなし");
  await page.locator("form[data-memo] button[type=submit]").first().click();
  await page.waitForFunction(() => document.querySelector("#monitorStatus").textContent.includes("メモを保存しました"));
  assert.equal((await store.readSnapshot()).state.links[0].userMemo, "クラウド画面の保存試験：スタンドなし");
  await page.reload();
  await page.locator("#cloudApp:not([hidden]) #linkRows tr").first().waitFor();
  assert.match(await page.locator(".memo-text").first().textContent(), /スタンドなし/);
  pass("authorized memo save survives page reload with restored mock session");
  await page.locator("#notificationSetup summary").click();
  assert.equal(await page.locator("#notificationSettingsFields").evaluate((element) => element.disabled), true);
  assert.equal(await page.locator("#mailEnabled").isDisabled(), true);
  assert.match(await page.locator("#notificationRuntimeWarning").textContent(), connections ? /自動メール・定期確認はオフ/ : /実メール・定期確認・外部在庫取得は無効/);
  pass("mail and scheduling remain disabled after actions and reload");
  if (connections) {
    await page.locator("#verifyCloudMail").click();
    await page.waitForFunction(() => document.querySelector("#cloudMailStatus").textContent.includes("Gmail接続済み"));
    assert.equal(testEmails, 0);
    page.once("dialog", (dialog) => dialog.dismiss()); await page.locator("#testRegistrationMail").click();
    assert.equal(testEmails, 0);
    page.once("dialog", (dialog) => dialog.accept()); await page.locator("#testRegistrationMail").click();
    await page.waitForFunction(() => document.querySelector("#mailSummary").textContent.includes("送信受付 1件"));
    assert.equal(testEmails, 1); assert.equal(await page.locator("#testRegistrationMail").isDisabled(), true);
    assert.notEqual((await store.read()).notificationSettings?.mailEnabled, true);
    pass("mail verification sends nothing; confirm/cancel and one-shot fake sending preserve automatic-off state");
  }
  await mkdir(path.join(root, "output"), {recursive: true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  const prefix = fullWorkspace ? "private-workspace" : vercelMode ? "vercel" : "cloud";
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({path: path.join(root, "output", `${prefix}-monitor-desktop.png`), fullPage: true});
  if (fullWorkspace) await page.screenshot({path: path.join(root, "output", `${prefix}-monitor-viewport.png`)});
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({path: path.join(root, "output", `${prefix}-monitor-mobile.png`), fullPage: true});
  if (connections) {
    await page.locator("#salesSection").scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(root, "output", "sales-history-fixture-mobile.png")});
    await page.setViewportSize({width: 1440, height: 1080});
    await page.locator("#salesSection").scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(root, "output", "sales-history-fixture-desktop.png")});
    await page.setViewportSize({width: 390, height: 844});
  }
  pass("desktop and mobile have no horizontal overflow");
  if (fullWorkspace) {
    await page.locator(".cloud-account nav").getByText("下書きQ", {exact: true}).click();
    await page.locator("#cloudApp:not([hidden]) #summary").waitFor();
    assert.match(await page.locator("#summary").textContent(), /58/);
    assert.equal(await page.locator("#fetchProducts").isDisabled(), true);
    const editor = page.locator("[data-field=title]").first();
    const previous = await editor.inputValue();
    const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/items") && response.request().method() === "GET");
    await editor.fill(previous + " 保存試験"); await editor.blur(); await refreshed;
    await page.reload();
    await page.locator("#cloudApp:not([hidden]) #summary").waitFor();
    assert.ok((await page.locator("[data-field=title]").first().inputValue()).endsWith(" 保存試験"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({path: path.join(root, "output", `${prefix}-drafts-mobile.png`), fullPage: true});
    await page.setViewportSize({width: 1440, height: 1080});
    await page.screenshot({path: path.join(root, "output", `${prefix}-drafts-desktop.png`), fullPage: true});
    pass("all 58 drafts, safe edit/reload and mobile layout preserved without changing source data");
  }
  await page.locator(".cloud-account button").click();
  await page.locator("#loginSubmit:not([disabled])").waitFor();
  assert.equal(await page.locator("#cloudApp").isVisible(), false);
  assert.equal((await fetch(base + "/api/link-monitor")).status, 401);
  await page.screenshot({path: path.join(root, "output", `${prefix}-login-mobile.png`), fullPage: true});
  pass("logout clears the rendered private screen");
  assert.deepEqual(pageErrors, []);
  for (let i = 0; i < files.length; i++) assert.deepEqual(await readFile(path.join(root, "data", files[i])), original[i]);
  pass("no browser errors or changes to existing JSON files");
  console.log(JSON.stringify({passed: checks, routing: vercelMode ? "actual-vercel-build-manifest" : "direct", database: realDatabase ? "real-development-neon" : "memory", auth: "mock-provider-with-real-jwt-verification", liveEmails: 0, productionDataChanged: false}));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (databasePool) {
    if (databaseKey) await databasePool.query("DELETE FROM app_storage.documents WHERE document_key = $1", [databaseKey]);
    await databasePool.end();
  }
}
