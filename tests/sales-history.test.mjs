import test from "node:test";
import assert from "node:assert/strict";
import {readAmazonSales} from "../src/amazon-sales-reader.js";
import {applySalesResult, salesHistoryView} from "../src/sales-history.js";
import {createCloudSales} from "../src/cloud-sales.js";

const start = "2026-10-25T00:00:00.000Z", at = "2026-10-25T02:00:00.000Z";
const config = {accountKey: "fixture-account", sellerId: "FIXTURESELLER", marketplaceId: "A1VC38T7YXB528", clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh"};
const target = {linkId: "link-1", asin: "B000TEST01", sellerSku: "used-one", condition: "UsedGood", startedAt: start};
const row = (patch = {}) => ({orderId: "fixture-order-1", itemId: "fixture-item-1", asin: target.asin, sellerSku: target.sellerSku,
  createdAt: "2026-10-25T00:10:00.000Z", updatedAt: "2026-10-25T00:20:00.000Z", status: "UNSHIPPED", quantity: 1, fulfillment: "AMAZON", ...patch});
const tracking = () => ({version: 1, ...config, startedAt: start, trackers: [target], orders: [], events: [], sync: {status: "complete"}});
const result = (rows, patch = {}) => ({complete: true, ...config, after: start, before: at, rows, ...patch});
const rawOrder = (patch = {}) => ({orderId: "fixture-order-1", createdTime: "2026-10-25T00:10:00.000Z", lastUpdatedTime: "2026-10-25T00:20:00.000Z",
  salesChannel: {channelName: "AMAZON", marketplaceId: config.marketplaceId}, fulfillment: {fulfillmentStatus: "UNSHIPPED", fulfilledBy: "AMAZON"},
  buyer: {name: "MUST_NOT_PERSIST"}, recipient: {address: "MUST_NOT_PERSIST"}, orderItems: [{orderItemId: "fixture-item-1", quantityOrdered: 1,
    product: {asin: target.asin, sellerSku: target.sellerSku, title: "MUST_NOT_PERSIST", serialNumbers: ["MUST_NOT_PERSIST"]}}], ...patch});
function fixture() {
  let state = {version: 1, catalog: [], links: [{id: target.linkId, matchBy: "asin", asin: target.asin, verified: true}], listings: [], logs: [], events: [],
    amazonAccountKey: config.accountKey, amazonSellerId: config.sellerId,
    amazonInventory: {status: "complete", complete: true, items: [{...target, fulfillableQuantity: 50}]}, notificationSettings: {mailEnabled: false, monitoringEnabled: false}};
  let revision = 1, clock = start;
  const store = {read: async () => structuredClone(state), update: async (fn, {expectedRevision} = {}) => {
    if (expectedRevision !== undefined && expectedRevision !== revision) throw Object.assign(new Error("stale"), {code: "STORAGE_CONFLICT"});
    const next = structuredClone(state), value = await fn(next); state = next; revision++; return value;
  }};
  return {store, revision: () => revision, time: (value) => {clock = value;}, now: () => clock};
}

test("Orders 2026 reader requests only fulfillment/cancellation and persists only targeted minimum fields", async () => {
  let calls = 0;
  const r = await readAmazonSales({config, targets: [target], after: start, before: "2026-10-25T01:00:00.000Z", now: () => Date.parse(at), fetchImpl: async (input, options) => {
    const url = new URL(input); calls++;
    if (calls === 1) {assert.equal(url.href, "https://api.amazon.com/auth/o2/token"); assert.equal(options.method, "POST"); return Response.json({access_token: "fixture-token"});}
    assert.equal(url.pathname, "/orders/2026-01-01/orders"); assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(url.searchParams.get("includedData"), "FULFILLMENT,CANCELLATION"); assert.equal(url.searchParams.get("marketplaceIds"), config.marketplaceId);
    return Response.json({orders: [rawOrder(), rawOrder({orderId: "mcf-1", salesChannel: {channelName: "NON_AMAZON"}}), rawOrder({orderId: "other-sku", orderItems: [{product: {sellerSku: "other"}}]})]});
  }});
  assert.equal(calls, 2); assert.deepEqual(r.rows, [row()]); assert.doesNotMatch(JSON.stringify(r), /MUST_NOT_PERSIST|buyer|recipient|title|serialNumbers/);
});

test("Orders pagination keeps the same bounded period and rejects partial, repeated or invalid lists", async () => {
  for (const kind of ["repeat", "cap", "invalid", "no-items", "conflict"]) {
    let calls = 0;
    await assert.rejects(readAmazonSales({config, targets: [target], after: start, before: "2026-10-25T01:00:00.000Z", now: () => Date.parse(at), maxPages: kind === "cap" ? 1 : 5,
      fetchImpl: async (input) => {
        calls++; if (calls === 1) return Response.json({access_token: "fixture"});
        const url = new URL(input); assert.equal(url.searchParams.get("lastUpdatedAfter"), start); assert.equal(url.searchParams.get("lastUpdatedBefore"), "2026-10-25T01:00:00.000Z");
        return Response.json(kind === "invalid" ? {} : {orders: [kind === "no-items" ? {...rawOrder(), orderItems: null} : kind === "conflict" && calls > 2 ? rawOrder({fulfillment: {fulfillmentStatus: "SHIPPED"}}) : rawOrder()], pagination: {nextToken: "fixture-next"}});
      }}));
  }
});

test("missing channel/status/quantity and item cancellation execution are unknown, not sales zero", async () => {
  for (const patch of [{salesChannel: {}}, {fulfillment: {}}, {orderItems: [{...rawOrder().orderItems[0], quantityOrdered: null}]},
    {orderItems: [{...rawOrder().orderItems[0], cancellation: {cancellationExecution: {cancelledBy: "BUYER"}}}]}]) {
    let first = true;
    const r = await readAmazonSales({config, targets: [target], after: start, before: "2026-10-25T01:00:00.000Z", now: () => Date.parse(at), fetchImpl: async () => {
      if (first) {first = false; return Response.json({access_token: "fixture"});} return Response.json({orders: [rawOrder(patch)]});
    }});
    assert.equal(r.rows[0].status, "UNKNOWN");
  }
});

test("confirmation counted once, shipment not recounted, cancellation corrects without changing inventory", () => {
  const t = tracking();
  assert.equal(applySalesResult(t, result([row()]), at)[0].delta, 1);
  assert.equal(applySalesResult(t, result([row()]), at).length, 0);
  assert.equal(applySalesResult(t, result([row({status: "SHIPPED", updatedAt: "2026-10-25T00:30:00.000Z"})]), at).length, 0);
  assert.equal(applySalesResult(t, result([row({status: "CANCELLED", updatedAt: "2026-10-25T00:40:00.000Z"})]), at)[0].delta, -1);
  assert.equal(t.orders.length, 1); assert.equal(t.events.length, 2);
  assert.equal(salesHistoryView({links: [{id: target.linkId}], salesTracking: t}, at).products[0].confirmedQuantity, 0);
});

test("pending is not confirmed; a pre-start order observed pending can later confirm", () => {
  const t = tracking(), createdAt = "2026-10-24T00:00:00.000Z";
  assert.equal(applySalesResult(t, result([row({createdAt, status: "PENDING"})]), at).length, 0);
  assert.equal(applySalesResult(t, result([row({createdAt, updatedAt: "2026-10-25T00:30:00.000Z"})]), at)[0].delta, 1);
  const baseline = tracking();
  assert.equal(applySalesResult(baseline, result([row({createdAt})]), at).length, 0);
  assert.equal(baseline.orders[0].eligibleFromAt, null);
});

test("same SKU with two Yahoo links is one order/event; separate SKU and late tracking are not combined", () => {
  const t = tracking(); t.trackers.push({...target, linkId: "second-link"}, {...target, linkId: "late-link", startedAt: "2026-10-25T01:00:00.000Z"});
  applySalesResult(t, result([row({quantity: 2})]), at);
  const v = salesHistoryView({links: t.trackers.map((t) => ({id: t.linkId})), salesTracking: t}, at);
  assert.equal(t.events.length, 1); assert.equal(v.events[0].delta, 2);
  assert.deepEqual(v.products.map((p) => p.confirmedQuantity), [2, 2, 0]);
  assert.throws(() => applySalesResult(t, result([row({sellerSku: "new-one"})]), at));
});

test("failed/expired or unknown data cannot report zero; repeated stale rows cannot undo cancellation", () => {
  const t = tracking(); applySalesResult(t, result([row()]), at);
  applySalesResult(t, result([row({status: "CANCELLED", updatedAt: "2026-10-25T00:30:00.000Z"})]), at);
  assert.equal(applySalesResult(t, result([row()]), at).length, 0); assert.equal(t.orders[0].confirmedQuantity, 0);
  t.sync = {status: "running", leaseUntil: start};
  assert.equal(salesHistoryView({links: [{id: target.linkId}], salesTracking: t}, at).products[0].confirmedQuantity, null);
  t.sync = {status: "complete"};
  applySalesResult(t, result([row({status: "UNKNOWN", quantity: null, updatedAt: "2026-10-25T00:40:00.000Z"})]), at);
  assert.equal(salesHistoryView({links: [{id: target.linkId}], salesTracking: t}, at).products[0].confirmedQuantity, null);
});

test("account/partial/conflicting identity/timestamp failures stop ledger updates", () => {
  for (const patch of [{complete: false}, {accountKey: "other"}, {sellerId: "other"}, {marketplaceId: "other"}]) assert.throws(() => applySalesResult(tracking(), result([row()], patch), at));
  const t = tracking(); applySalesResult(t, result([row()]), at);
  assert.throws(() => applySalesResult(t, result([row({quantity: 2})]), at));
  assert.throws(() => applySalesResult(t, result([row({asin: "B000OTHER1"})]), at));
  assert.throws(() => applySalesResult(t, result([row({quantity: null})]), at));
  assert.throws(() => applySalesResult(t, result([row()], {after: "bad-date"}), at));
});

test("a status regression is review-needed, not a cancellation or fresh sale on repeated retrieval", () => {
  const t = tracking(); applySalesResult(t, result([row()]), at);
  const regression = row({status: "PENDING", updatedAt: "2026-10-25T00:30:00.000Z"});
  assert.equal(applySalesResult(t, result([regression]), at).length, 0);
  assert.equal(applySalesResult(t, result([regression]), at).length, 0);
  assert.equal(t.orders[0].confirmedQuantity, 1); assert.equal(t.orders[0].status, "UNKNOWN");
  assert.equal(applySalesResult(t, result([row({status: "SHIPPED", updatedAt: "2026-10-25T00:40:00.000Z"})]), at).length, 0);
});

test("cloud tracking is durable and idempotent, starts now and does not read/send or reset", async () => {
  const f = fixture(); let reads = 0;
  const sales = createCloudSales({...f, config, readOrders: async () => {reads++;}});
  await sales.start({expectedRevision: f.revision()}); f.time(at); await sales.start({expectedRevision: f.revision()});
  const state = await f.store.read(); assert.equal(reads, 0); assert.equal(state.salesTracking.startedAt, start); assert.equal(state.salesTracking.trackers.length, 1);
  assert.deepEqual(state.notificationSettings, {mailEnabled: false, monitoringEnabled: false}); assert.equal(state.amazonInventory.items[0].fulfillableQuantity, 50);
});

test("cloud sales check commits only a complete bounded result and cannot double count on recheck", async () => {
  const f = fixture(); let reads = 0;
  const sales = createCloudSales({...f, config, readOrders: async ({after, before, targets}) => {reads++; assert.deepEqual(targets, [{asin: target.asin, sellerSku: target.sellerSku}]); return result([row()], {after, before});}});
  await sales.start({expectedRevision: f.revision()}); f.time(at);
  await sales.check({expectedRevision: f.revision()});
  await assert.rejects(sales.check({expectedRevision: f.revision()}), {status: 429});
  f.time("2026-10-25T02:04:00.000Z");
  // The real reader only returns rows updated within the overlapped query period.
  const next = createCloudSales({...f, config, readOrders: async ({after, before}) => {reads++; return result([], {after, before});}});
  await next.check({expectedRevision: f.revision()});
  const state = await f.store.read(); assert.equal(reads, 2); assert.equal(state.salesTracking.events.length, 1); assert.equal(state.salesTracking.orders[0].confirmedQuantity, 1);
  assert.equal(state.amazonInventory.items[0].fulfillableQuantity, 50); assert.equal(state.notificationSettings.mailEnabled, false);
});

test("failed read and storage conflicts do not move cursor, replace history with zero or leak secrets", async () => {
  const f = fixture(); let reads = 0;
  const sales = createCloudSales({...f, config, readOrders: async () => {reads++; throw new Error("HTTP 403 fixture-private-value");}});
  await sales.start({expectedRevision: f.revision()}); f.time(at);
  await assert.rejects(sales.check({expectedRevision: 0}), {code: "STORAGE_CONFLICT"}); assert.equal(reads, 0);
  await sales.check({expectedRevision: f.revision()}); const state = await f.store.read();
  assert.equal(state.salesTracking.checkedThrough, undefined); assert.equal(state.salesTracking.sync.status, "failed"); assert.doesNotMatch(JSON.stringify(state), /fixture-private-value/);
});

test("ambiguous SKU/account and unknown commit prevent any order read", async () => {
  for (const kind of ["account", "ambiguous", "unknown-commit"]) {
    const f = fixture(); let reads = 0;
    await f.store.update((s) => {if (kind === "account") s.amazonAccountKey = "other"; if (kind === "ambiguous") s.amazonInventory.items.push({...s.amazonInventory.items[0], sellerSku: "new-one"});});
    const store = kind === "unknown-commit" ? {...f.store, update: async () => {throw Object.assign(new Error("unknown commit"), {code: "STORAGE_COMMIT_UNKNOWN"});}} : f.store;
    const sales = createCloudSales({...f, store, config, readOrders: async () => {reads++;}});
    await assert.rejects(sales.start({expectedRevision: f.revision()})); assert.equal(reads, 0);
  }
});

test("a durable running lease prevents concurrent reads; changed SKU scope never publishes an old result", async () => {
  for (const changeScope of [false, true]) {
    const f = fixture(); let reads = 0, finish, started;
    const ready = new Promise((resolve) => {started = resolve;});
    const sales = createCloudSales({...f, config, readOrders: async ({after, before}) => {reads++; started(); return new Promise((resolve) => {finish = () => resolve(result([row()], {after, before}));});}});
    await sales.start({expectedRevision: f.revision()}); f.time(at);
    const running = sales.check({expectedRevision: f.revision()}); await ready;
    await assert.rejects(sales.check({expectedRevision: f.revision()}), {status: 409}); assert.equal(reads, 1);
    if (changeScope) await f.store.update((state) => {state.amazonInventory.items[0].sellerSku = "other-sku";});
    finish(); await running;
    const state = await f.store.read();
    assert.equal(state.salesTracking.sync.status, changeScope ? "failed" : "complete");
    assert.equal(state.salesTracking.events.length, changeScope ? 0 : 1);
  }
});

test("a failed incomplete check preserves prior cursor/history and hides the previous batch as a fresh preview", async () => {
  const f = fixture();
  const good = createCloudSales({...f, config, readOrders: async ({after, before}) => result([row()], {after, before})});
  await good.start({expectedRevision: f.revision()}); f.time(at); await good.check({expectedRevision: f.revision()});
  const through = (await f.store.read()).salesTracking.checkedThrough;
  f.time("2026-10-25T02:04:00.000Z");
  const bad = createCloudSales({...f, config, readOrders: async ({after, before}) => result([], {after, before, complete: false})});
  await bad.check({expectedRevision: f.revision()});
  const state = await f.store.read(), view = salesHistoryView(state, f.now());
  assert.equal(state.salesTracking.checkedThrough, through); assert.equal(state.salesTracking.orders[0].confirmedQuantity, 1);
  assert.equal(view.products[0].confirmedQuantity, null); assert.equal(view.events.length, 0); assert.equal(view.recentEvents.length, 1);
});
