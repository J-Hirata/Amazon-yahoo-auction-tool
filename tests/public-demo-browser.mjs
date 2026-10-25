import assert from "node:assert/strict";
import http from "node:http";
import {once} from "node:events";
import {readFile, readdir, mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createRequire} from "node:module";

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const originalFiles = ["link-monitor.json", "items.json", "stock-watch.json", "gmail-test-result.json"];
const original = await Promise.all(originalFiles.map((name) => readFile(path.join(root, "data", name))));
let base = process.env.ASIN_PUBLIC_DEMO_TEST_URL;
let server, browser, checks = 0;
const pass = (name) => {checks++; console.log(`PASS ${name}`);};
const beforeEnvironment = {demo: process.env.ASIN_PUBLIC_DEMO, origin: process.env.ASIN_PUBLIC_ORIGIN};

try {
  if (base) {
    const url = new URL(base);
    assert.ok(url.protocol === "https:" && /^amazon-yahoo-inventory(?:-[a-z0-9-]+)?\.vercel\.app$/.test(url.hostname));
    assert.equal(url.origin, base);
  } else {
    const output = path.join(root, ".vercel", "output");
    const manifest = JSON.parse(await readFile(path.join(output, "config.json"), "utf8"));
    const rewrite = manifest.routes.find((item) => item.dest?.startsWith("/api/inventory?__route="));
    assert.ok(rewrite);
    const entry = (await import(pathToFileURL(path.join(output, "functions", "api", "inventory.func", "api", "inventory.js")))).default;
    const staticFiles = new Map(await Promise.all((await readdir(path.join(output, "static"))).map(async (name) => ["/" + name, await readFile(path.join(output, "static", name))])));
    const types = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png"};
    server = http.createServer(async (request, response) => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {size += chunk.length; if (size > 2200000) throw new Error("Too large"); chunks.push(chunk);}
        if (request.url.startsWith("/api/")) {
          const match = request.url.match(new RegExp(rewrite.src));
          assert.ok(match);
          const target = rewrite.dest.replace(/\$(\d+)/g, (_, index) => match[Number(index)] || "");
          const result = await entry.fetch(new Request(base + target, {method: request.method, headers: request.headers, ...(chunks.length ? {body: Buffer.concat(chunks)} : {})}));
          response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
        } else {
          const name = request.url === "/" ? "/index.html" : request.url;
          const body = staticFiles.get(name);
          response.writeHead(body ? 200 : 404, {"Content-Type": types[path.extname(name)] || "application/octet-stream", "Cache-Control": "no-store"}); response.end(body);
        }
      } catch {response.writeHead(500); response.end("Fixture request failed");}
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.ASIN_PUBLIC_DEMO = "1"; process.env.ASIN_PUBLIC_ORIGIN = base;
  }
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push({url: request.url(), method: request.method()}));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== base) {errors.push("Unexpected external request"); await route.abort();}
    else await route.continue();
  });
  await page.goto(base + "/demo.html");
  await page.locator("#linkRows .linked-product span").filter({hasText: "練習用モニター（実在商品ではありません）"}).first().waitFor();
  assert.equal(await page.locator("#demoApp").isVisible(), true);
  assert.equal(await page.locator("#linkRows tr").count(), 1);
  assert.equal(await page.locator("#mailEnabled").isDisabled(), true);
  pass("deployed sample opens without business credentials or external requests");

  await page.getByRole("button", {name: "メモを編集", exact: true}).first().click();
  await page.locator("textarea[name=memo]").first().fill("確認版のメモ・スタンドなし");
  await page.getByRole("button", {name: "メモを保存", exact: true}).first().click();
  await page.locator(".memo-text").filter({hasText: "確認版のメモ・スタンドなし"}).waitFor();
  await page.reload();
  await page.locator(".memo-text").filter({hasText: "確認版のメモ・スタンドなし"}).waitFor();
  pass("memo changes survive reload in the same browser only");

  await page.locator("#pairAmazon").fill("B000DEMO02");
  await page.locator("#pairYahoo").fill("https://auctions.yahoo.co.jp/jp/auction/d1000000002");
  await page.getByRole("button", {name: "この2つを紐付ける", exact: true}).click();
  await page.locator("#linkRows tr").nth(1).waitFor();
  assert.equal(await page.locator("#linkRows tr").count(), 2);
  await page.reload(); await page.locator("#linkRows tr").nth(1).waitFor();
  pass("sample linkage registration is visible and reloadable");

  await page.locator("#pairAmazon").fill("B0176E86U8");
  await page.locator("#pairYahoo").fill("https://auctions.yahoo.co.jp/jp/auction/d1000000003");
  await page.getByRole("button", {name: "この2つを紐付ける", exact: true}).click();
  await page.getByText("確認版ではサンプルASIN・出品URLを入力してください", {exact: true}).waitFor();
  await page.locator("#pairAmazon").fill(""); await page.locator("#pairYahoo").fill("");
  assert.equal(await page.locator("#linkRows tr").count(), 2);
  pass("real product identifiers cannot be registered in the sample");

  await page.getByRole("tab", {name: "通知の動作テスト", exact: true}).click();
  await page.locator("#demoScenario").selectOption("zero");
  await page.getByRole("button", {name: "この状態を試す", exact: true}).click();
  await page.getByText("在庫5→0：通知1件", {exact: true}).waitFor();
  assert.ok((await page.locator("#emailPreview").innerText()).length > 0);
  await page.locator("#demoScenario").selectOption("repeat");
  await page.getByRole("button", {name: "この状態を試す", exact: true}).click();
  await page.getByText("0のまま再確認：通知0件", {exact: true}).waitFor();
  pass("notification scenarios run with duplicate suppression and no delivery");

  await page.getByRole("tab", {name: "商品の紐付け", exact: true}).click();
  await mkdir(path.join(root, "output"), {recursive: true});
  const prefix = process.env.ASIN_PUBLIC_DEMO_TEST_URL ? "deployed-demo" : "public-demo";
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
    await page.setViewportSize({width, height});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({path: path.join(root, "output", `${prefix}-${name}.png`), fullPage: true});
  }
  pass("desktop and phone layouts are nonblank and have no horizontal overflow");

  const fresh = await browser.newContext({viewport: {width: 390, height: 844}});
  const freshPage = await fresh.newPage();
  await freshPage.goto(base + "/demo.html");
  await freshPage.locator("#linkRows .linked-product span").filter({hasText: "練習用モニター（実在商品ではありません）"}).first().waitFor();
  assert.equal(await freshPage.locator("#linkRows tr").count(), 1);
  assert.equal(await freshPage.getByText("確認版のメモ・スタンドなし", {exact: true}).count(), 0);
  await fresh.close();
  assert.equal((await context.request.get(base + "/api/link-monitor")).status(), 503);
  assert.ok(requests.filter((item) => item.method !== "GET").every((item) => new URL(item.url).pathname === "/api/demo"));
  assert.deepEqual(errors, []);
  for (let index = 0; index < originalFiles.length; index++) assert.deepEqual(await readFile(path.join(root, "data", originalFiles[index])), original[index]);
  pass("another browser sees no edits; private API stays closed; original business JSON is unchanged");
  console.log(JSON.stringify({passed: checks, origin: base, deployed: Boolean(process.env.ASIN_PUBLIC_DEMO_TEST_URL), storage: "browser-local-sample-only", businessDataPublished: false, emailsSent: 0}));
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of [["ASIN_PUBLIC_DEMO", beforeEnvironment.demo], ["ASIN_PUBLIC_ORIGIN", beforeEnvironment.origin]]) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
}
