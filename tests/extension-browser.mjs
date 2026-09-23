import assert from "node:assert/strict";
import {readFile, mkdir} from "node:fs/promises";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const browser = await chromium.launch({headless: true, channel: "chrome"});
const context = await browser.newContext({viewport: {width: 1280, height: 900}});
const item = {asin: "B000000001", title: "テスト用モニター LCD-TEST123", status: "ready_for_draft", startPrice: 3840, usedLowestPrice: 4800, imageUrls: [], amazonUrl: "https://www.amazon.co.jp/dp/B000000001"};
const other = {...item, asin: "B000000002", title: "テスト用ピロー NORDIC SLEEP PILLOW"};
const payload = {items: [item, other], queue: {active: [item, other], waiting: []}, priceReviews: [], config: {yahooSellerUrl: "https://auctions.yahoo.co.jp/jp/show/submit?category=0"}};
try {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost") {
      if (url.pathname === "/api/items") return route.fulfill({json: payload});
      if (url.pathname.endsWith("/draft")) return route.fulfill({json: {draft: {...item, price: 3840, description: "テスト説明"}}});
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (["index.html", "app.js", "styles.css"].includes(name)) return route.fulfill({body: await read(`public/${name}`), contentType: name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html"});
    }
    if (url.hostname === "auctions.yahoo.co.jp") return route.fulfill({body: (await read("public/test-yahoo-form.html")).replace('<script src="/yahoo-fill.js"></script>', "").replace('<link rel="stylesheet" href="/styles.css">', "<style>body{font:14px system-ui;margin:24px}label{display:block;margin:12px 0}input,textarea{display:block;width:50%;padding:8px}textarea{height:120px}</style>"), contentType: "text/html"});
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto("http://localhost:41731/");
  await page.locator("#active [data-action=draft]").first().click();
  await page.locator("#extensionSelected").click();
  assert.match(await page.locator("#status").innerText(), /Chrome拡張を登録/);
  await page.evaluate(() => {
    globalThis.chrome = {runtime: {sendMessage: async (message) => {globalThis.sent = message; return {ok: true};}}};
  });
  await page.addScriptTag({content: await read("chrome-extension/management.js")});
  await page.locator("#extensionSelected").click();
  await page.waitForFunction(() => globalThis.sent?.asin === "B000000001");
  assert.match(await page.locator("#status").innerText(), /開きました/);
  await mkdir(new URL("test-output/", root), {recursive: true});
  await page.screenshot({path: fileURLToPath(new URL("test-output/management.png", root)), fullPage: true});

  const yahoo = await context.newPage();
  await yahoo.goto("https://auctions.yahoo.co.jp/jp/show/submit?category=0");
  await yahoo.exposeFunction("runHelper", async () => {
    await yahoo.addScriptTag({content: await read("chrome-extension/yahoo-fill.js")});
    return {ok: true};
  });
  await yahoo.evaluate((payload) => {
    globalThis.writes = [];
    globalThis.chrome = {runtime: {sendMessage: async (message) => {
      if (message.type === "selection") return {ok: true, asin: "B000000002"};
      if (message.type === "showHelper") return globalThis.runHelper();
      if (message.type === "api") {
        if (globalThis.offline) return {ok: false, error: "ASINツールを起動してください"};
        if (message.method === "PATCH") {globalThis.writes.push(message); return {ok: true, json: {}};}
        if (message.path === "/api/items") return {ok: true, json: payload};
        if (message.path.startsWith("/api/image-proxy?")) return {ok: true, contentType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII="};
        const asin = message.path.split("/")[3];
        const item = payload.items.find((entry) => entry.asin === asin);
        return {ok: true, json: {draft: {...item, price: 3840, description: "テスト説明", imageUrls: ["https://m.media-amazon.com/images/I/test-product.png"]}}};
      }
    }}};
  }, payload);
  await yahoo.addScriptTag({content: await read("chrome-extension/yahoo.js")});
  await yahoo.waitForSelector("#ayf-select");
  assert.equal(await yahoo.locator("#ayf-select").inputValue(), "1");
  assert.equal(await yahoo.locator("#title").inputValue(), "");
  assert.equal(await yahoo.evaluate(() => globalThis.writes.length), 0);
  await yahoo.locator("[data-action=fillAll]").click();
  await yahoo.waitForFunction(() => globalThis.writes.length === 1);
  assert.equal(await yahoo.locator("#title").inputValue(), other.title);
  assert.equal(await yahoo.locator("#price").inputValue(), "3840");
  assert.equal(await yahoo.locator("#description").inputValue(), "テスト説明");
  assert.equal(await yahoo.locator("#images").evaluate((input) => input.files.length), 1);
  assert.equal(await yahoo.locator("#draftSaveStatus").innerText(), "");
  await yahoo.screenshot({path: fileURLToPath(new URL("test-output/yahoo-panel.png", root))});
  await yahoo.setViewportSize({width: 390, height: 844});
  const bounds = await yahoo.locator("#asin-yahoo-fill-panel").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await yahoo.screenshot({path: fileURLToPath(new URL("test-output/yahoo-mobile.png", root))});
  await yahoo.evaluate(() => {globalThis.offline = true;});
  await yahoo.addScriptTag({content: await read("chrome-extension/yahoo-fill.js")});
  await yahoo.waitForFunction(() => document.querySelector("#ayf-body").textContent.includes("起動してください"));
  console.log("PASS: management handoff, selected item, manual fill with image, no submit/save, narrow viewport, offline message");
} finally {await browser.close();}
