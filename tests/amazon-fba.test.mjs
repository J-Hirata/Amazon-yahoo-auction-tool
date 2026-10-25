import test from "node:test";
import assert from "node:assert/strict";
import {readFbaInventory} from "../src/amazon-fba-reader.js";
import {createManualFbaJob} from "../src/manual-fba-job.js";
import {emptyMonitor, registerPageLink, assessLink, runPreview, notificationPreview} from "../src/link-monitor.js";

const at = "2026-10-21T05:00:00.000Z";
const config = {clientId: "test-client", clientSecret: "test-secret", refreshToken: "test-refresh", marketplaceId: "A1VC38T7YXB528", accountKey: "test-account", sellerId: "TESTSELLER"};
const row = (overrides = {}) => ({asin: "B000DEMO01", sellerSku: "SKU1", fnSku: "FNSKU1", condition: "UsedGood", productName: "テスト商品", inventoryDetails: {fulfillableQuantity: 5}, ...overrides});
function mock(pages) {
  const calls = [];
  const source = pages.flatMap((value) => value?.payload?.inventorySummaries || []).filter((item) => item.asin === "B000DEMO01");
  const skus = [...new Set(source.map((item) => item.sellerSku))];
  return {calls, fetch: async (url, options) => {
    calls.push({url: String(url), method: options.method});
    if (String(url).includes("/auth/o2/token")) return Response.json({access_token: "test-token"});
    if (String(url).includes("/listings/")) return Response.json({items: (skus.length ? skus : ["SKU1"]).map((sku) => ({sku, summaries: [{asin: "B000DEMO01", marketplaceId: config.marketplaceId}]}))});
    const page = pages.shift();
    if (page instanceof Error) throw page;
    return page instanceof Response ? page : Response.json(page);
  }};
}
function page(rows, nextToken) {return {payload: {inventorySummaries: rows}, ...(nextToken ? {pagination: {nextToken}} : {})};}
async function read(pages, options = {}) {
  const api = mock(pages);
  const result = await readFbaInventory({asins: ["B000DEMO01"], config, fetchImpl: api.fetch, wait: async () => {}, now: () => Date.parse(at), ...options});
  return {result, calls: api.calls};
}
function stateWithLink() {
  const state = emptyMonitor();
  const link = registerPageLink(state, {amazon: "B000DEMO01", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d1000000001", reviewed: true}, at);
  return {state, link};
}
test("all pages are read before completion; only target ASIN data is retained; requests are read-only", async () => {
  const progress = [];
  const {result, calls} = await read([page([row()], "next"), page([row()])], {onProgress: (value) => progress.push(value)});
  assert.equal(result.complete, true);
  assert.equal(result.pages, 3);
  assert.equal(result.scanned, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].fulfillableQuantity, 5);
  assert.equal(progress.length, 3);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET", "GET", "GET"]);
  assert.match(calls[1].url, /identifiers=B000DEMO01/);
  assert.match(calls[3].url, /nextToken=next/);
  assert.ok(calls.filter((call) => call.url.includes("/fba/inventory/")).every((call) => new URL(call.url).searchParams.has("sellerSkus")));
  assert.ok(!JSON.stringify(result).includes("test-secret"));
  assert.ok(!JSON.stringify(result).includes("test-token"));
});
test("page limit, missing list, repeated token, changed duplicates and fetch failures cannot produce a completed snapshot", async () => {
  await assert.rejects(read([page([row({inventoryDetails: {fulfillableQuantity: 0}})], "more")], {maxPages: 1}), /完了しません/);
  await assert.rejects(read([{payload: {}}]), /形式/);
  await assert.rejects(read([page([], "same"), page([], "same")]), /繰り返/);
  await assert.rejects(read([page([row()], "next"), page([row({inventoryDetails: {fulfillableQuantity: 0}})])]), /変わりました/);
  await assert.rejects(read([new Error("secret-response")]), (error) => !error.message.includes("secret-response"));
});
test("missing or malformed quantities are never substituted with total stock or zero", async () => {
  for (const value of [undefined, null, false, "0", -1, 0.5]) {
    const {result} = await read([page([row({totalQuantity: 99, inventoryDetails: {fulfillableQuantity: value}})])]);
    assert.equal(result.items[0].fulfillableQuantity, null);
  }
  assert.equal((await read([page([row({inventoryDetails: {fulfillableQuantity: 0}})])])).result.items[0].fulfillableQuantity, 0);
});
test("temporary throttling retries, but authorization errors do not expose response bodies", async () => {
  const {result} = await read([new Response("throttled", {status: 429}), page([row()])]);
  assert.equal(result.complete, true);
  await assert.rejects(read([new Response("test-secret", {status: 403})]), (error) => error.message.includes("403") && !error.message.includes("test-secret"));
});
test("target-only reader refuses unrelated ASINs rather than falling back to a full inventory scan", async () => {
  await assert.rejects(read([page([row({asin: "B000OTHER1"})])]), /対象外/);
});
test("seller discovery accepts only explicit MyOffer ownership; missing ownership never starts any inventory request", async () => {
  const calls = [];
  await assert.rejects(readFbaInventory({asins: ["B000DEMO01"], config: {...config, sellerId: null}, wait: async () => {},
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/auth/")) return Response.json({access_token: "test-token"});
      return Response.json({payload: {Offers: [{MyOffer: false, SellerId: "OTHERSELLER"}]}});
    }}), /初回確認/);
  assert.equal(calls.filter((url) => url.includes("/fba/")).length, 0);
  assert.equal(calls.filter((url) => url.includes("/listings/")).length, 0);
});
test("complete unique snapshots expose raw FBA counts, not unverified MCF availability; zero is explicit only", async () => {
  const {state, link} = stateWithLink();
  state.amazonInventory = (await read([page([row()])])).result;
  let assessment = assessLink(link, state, at);
  assert.equal(assessment.product.fulfillableQuantity, 5);
  assert.equal(assessment.availableQuantity, null);
  assert.equal(assessment.inventory, "unknown");
  assert.equal(assessment.fbaLabel, "5個");
  runPreview(state, at);
  const notice = state.events.find((event) => event.kind === "inventory_unknown");
  assert.match(notice.title, /出荷条件/);
  assert.match(notificationPreview(notice).message, /FBA在庫は5個/);
  state.amazonInventory.items[0].fulfillableQuantity = 0;
  assert.equal(assessLink(link, state, at).inventory, "unknown");
  assert.equal(assessLink(link, state, at).product.fulfillableQuantity, 0);
  assert.equal(assessLink(link, state, at).availableQuantity, null);
  state.amazonInventory.items[0].fulfillableQuantity = null;
  assert.equal(assessLink(link, state, at).inventory, "unknown");
});
test("missing ASIN, multiple conditions, partial and stale snapshots do not imply zero", async () => {
  const {state, link} = stateWithLink();
  state.amazonInventory = (await read([page([])])).result;
  assert.equal(assessLink(link, state, at).inventory, "unknown");
  state.amazonInventory = (await read([page([row(), row({sellerSku: "SKU2", condition: "NewItem"})])])).result;
  assert.equal(assessLink(link, state, at).inventory, "unlinked");
  assert.equal(assessLink(link, state, at).product.fulfillableQuantity, null);
  state.amazonInventory = {...(await read([page([row()])])).result, complete: false, status: "failed", error: "取得失敗"};
  assert.equal(assessLink(link, state, at).product.fulfillableQuantity, null);
  state.amazonInventory.status = "complete"; state.amazonInventory.complete = true;
  assert.equal(assessLink(link, state, "2026-10-22T05:00:00Z").inventory, "unknown");
});
function memoryStore(state) {
  return {read: async () => structuredClone(state), update: async (work) => {await work(state);}};
}
test("manual jobs deduplicate clicks, persist results and do not run on construction", async () => {
  const {state} = stateWithLink();
  let calls = 0; let finish;
  const held = new Promise((resolve) => {finish = resolve;});
  const job = createManualFbaJob({store: memoryStore(state), readConfig: async () => config, now: () => at,
    readInventory: async ({onProgress}) => {calls++; onProgress({pages: 1, scanned: 50}); await held; return (await read([page([row()])])).result;}});
  assert.equal(calls, 0);
  await job.start(); await job.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(job.status().scanned, 50);
  assert.equal(state.amazonInventory.complete, false);
  finish(); await job.wait();
  assert.equal(job.status().status, "complete");
  assert.equal(state.amazonInventory.complete, true);
  assert.equal(state.events.length, 0);
  assert.equal(state.links.length, 1);
});
test("failed jobs invalidate older numbers, preserve links and permit retry; account changes are refused", async () => {
  const {state, link} = stateWithLink();
  state.amazonInventory = (await read([page([row()])])).result;
  let fail = true;
  const job = createManualFbaJob({store: memoryStore(state), readConfig: async () => config, now: () => at,
    readInventory: async () => {if (fail) throw new Error("取得失敗"); return (await read([page([row()])])).result;}});
  await job.start(); await job.wait();
  assert.equal(job.status().status, "failed");
  assert.equal(assessLink(link, state, at).product.fulfillableQuantity, null);
  assert.equal(state.links.length, 1);
  fail = false; await job.start(); await job.wait();
  assert.equal(job.status().status, "complete");
  state.amazonAccountKey = "different-account";
  await job.start(); await job.wait();
  assert.equal(job.status().status, "failed");
  assert.match(job.status().error, /接続先/);
});
