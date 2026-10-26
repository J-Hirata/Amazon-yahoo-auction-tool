import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {emptyPhysicalStock, applyStockCommand, stockTotals, validatePhysicalStock} from "../src/physical-stock.js";
import {createCloudStock, physicalStockView, stockCsv} from "../src/cloud-stock.js";
import {emptyMonitor} from "../src/link-monitor.js";
import {createCloudHandler} from "../src/cloud-handler.js";

const actor = "stock-owner-fixture", at = "2026-10-25T16:00:00.000Z";
const product = (patch = {}) => ({title: "テスト用モニター", unit: "台", condition: "used", setContents: "スタンドなし", memo: "", asin: "", sellerSku: "", catalogTask: "pending", fbaEligibility: "possible", linkedLinkIds: [], ...patch});
const command = (kind, patch = {}) => ({operationId: randomUUID(), kind, reason: "確認用", ...patch});
function execute(state, cmd) {const copy = structuredClone(state), result = applyStockCommand(copy, cmd, {actor, at}); return {state: copy, result};}
function fixture(quantity = 6) {
  const cmd = command("create", {product: product(), locationId: "container", quantity});
  return execute(emptyPhysicalStock(), cmd);
}
const idOf = (s) => s.products[0].id;
function action(state, kind, patch = {}) {return execute(state, command(kind, {productId: idOf(state), locationId: "container", quantity: 1, ...patch})).state;}

test("a stable management ID can exist without ASIN; an unknown number is not zero", () => {
  const {state} = fixture(null), totals = stockTotals(state, idOf(state));
  assert.equal(state.products[0].asin, ""); assert.equal(state.products[0].catalogTask, "pending");
  assert.equal(totals.locations[0].usable, null); assert.equal(totals.unknownLocations, 2);
  assert.throws(() => action(state, "add"), /先に棚卸し/); assert.equal(state.balances[0].usable, null);
});
test("add three and count to three are separate, with before/after/reason/actor in one history", () => {
  let {state} = fixture(); state = action(state, "add", {quantity: 3}); assert.equal(stockTotals(state, idOf(state)).usable, 9);
  state = action(state, "count", {counts: {usable: 3, reserved: 0, unusable: 0}});
  assert.equal(stockTotals(state, idOf(state)).usable, 3);
  const e = state.events.at(-1); assert.equal(e.changes[0].before.usable, 9); assert.equal(e.changes[0].after.usable, 3); assert.equal(e.actor, actor); assert.equal(e.reason, "確認用");
});
test("reservations and unusable units move buckets without increasing physical stock", () => {
  let {state} = fixture(); state = action(state, "reserve", {quantity: 2}); state = action(state, "unusable", {quantity: 1});
  let t = stockTotals(state, idOf(state)); assert.deepEqual([t.usable, t.reserved, t.unusable], [3, 2, 1]);
  state = action(state, "release", {quantity: 1}); state = action(state, "recover", {quantity: 1}); t = stockTotals(state, idOf(state));
  assert.deepEqual([t.usable, t.reserved, t.unusable], [5, 1, 0]);
  state = action(state, "remove", {quantity: 1}); assert.equal(stockTotals(state, idOf(state)).usable, 4);
});
test("new/used, set contents and units do not merge even with the same ASIN", () => {
  let {state} = fixture();
  state = execute(state, command("create", {product: product({asin: "B000TEST01", condition: "new", setContents: "新品一式"}), locationId: "container", quantity: 2})).state;
  assert.equal(state.products.length, 2); assert.notEqual(state.products[0].id, state.products[1].id); assert.equal(state.balances.length, 2);
  assert.throws(() => action(state, "edit", {product: product({unit: "箱"})}), /数量を自動変換/);
  assert.throws(() => action(state, "edit", {product: product({condition: "new"})}), /別の管理商品/);
});
test("later ASIN/catalog registration updates the same item without another receipt of stock", () => {
  let {state} = fixture(); const before = structuredClone(state.balances), id = idOf(state);
  state = action(state, "edit", {product: product({asin: "B000TEST01", catalogTask: "registered", memo: "カタログを作成"})});
  assert.equal(state.products[0].id, id); assert.equal(state.products[0].asin, "B000TEST01"); assert.deepEqual(state.balances, before);
});
test("dispatch/partial local arrival/return conserve quantity and retain in-transit history", () => {
  let {state} = fixture(10); state = action(state, "count", {locationId: "home", counts: {usable: 0, reserved: 0, unusable: 0}});
  state = action(state, "dispatch", {quantity: 4, to: "home", reference: "移動001"});
  let totals = stockTotals(state, idOf(state)); assert.equal(totals.usable, 6); assert.equal(totals.inTransit, 4);
  state = action(state, "receive_transfer", {transferId: state.transfers[0].id, quantity: 2, bucket: "usable"});
  totals = stockTotals(state, idOf(state)); assert.equal(totals.usable, 8); assert.equal(totals.inTransit, 2);
  state = action(state, "return_transfer", {transferId: state.transfers[0].id, quantity: 1, bucket: "unusable"});
  totals = stockTotals(state, idOf(state)); assert.equal(totals.usable + totals.unusable + totals.inTransit, 10); assert.equal(totals.inTransit, 1);
  assert.deepEqual([state.transfers[0].quantity, state.transfers[0].remaining, state.transfers[0].received, state.transfers[0].returned], [4, 1, 2, 1]);
});
test("FBA receipt requires evidence and never adds to any FBA observation", () => {
  let {state} = fixture(10); state = action(state, "dispatch", {quantity: 4, to: "fba", reference: "FBA-fixture"});
  assert.throws(() => action(state, "receive_transfer", {transferId: state.transfers[0].id, quantity: 3}), /必須/);
  state = action(state, "receive_transfer", {transferId: state.transfers[0].id, quantity: 3, evidence: "受領画面で3台確認"});
  assert.equal(state.transfers[0].remaining, 1); assert.equal(state.balances.length, 1); assert.equal(state.balances[0].usable, 6);
  assert.throws(() => action(state, "add", {locationId: "fba"}), /FBA数量/);
});
test("negative, fractional, missing, excessive or insufficient quantities are rejected atomically", () => {
  const {state} = fixture(); const original = JSON.stringify(state);
  for (const quantity of [-1, 0, 1.5, undefined, "3", 1000001]) assert.throws(() => action(state, "add", {quantity}));
  assert.throws(() => action(state, "remove", {quantity: 7}), /不足/);
  assert.throws(() => action(state, "count", {counts: {usable: 2}}));
  assert.throws(() => action(state, "dispatch", {to: "container"}));
  assert.throws(() => action(state, "dispatch", {to: "fba"}));
  assert.equal(JSON.stringify(state), original);
});
test("arrival cannot exceed transit or overwrite an unconfirmed destination with assumed zero", () => {
  let {state} = fixture(); state = action(state, "dispatch", {quantity: 2, to: "home"});
  assert.throws(() => action(state, "receive_transfer", {transferId: state.transfers[0].id, quantity: 3}), /残数/);
  assert.throws(() => action(state, "receive_transfer", {transferId: state.transfers[0].id, quantity: 1}), /先に棚卸し/);
});
test("same operation ID is replayed but changed content or owner cannot reuse it", () => {
  const {state} = fixture(); const cmd = command("add", {productId: idOf(state), locationId: "container", quantity: 3});
  const applied = execute(state, cmd); const repeat = execute(applied.state, cmd);
  assert.equal(repeat.result.replayed, true); assert.equal(repeat.state.events.length, applied.state.events.length); assert.equal(repeat.state.balances[0].usable, 9);
  assert.throws(() => execute(applied.state, {...cmd, quantity: 4}), /同じ操作ID/);
  assert.throws(() => applyStockCommand(structuredClone(applied.state), cmd, {actor: "other", at}));
});
function storeFixture() {
  let state = emptyPhysicalStock(), revision = 0;
  return {read: async () => structuredClone(state), readSnapshot: async () => ({state: structuredClone(state), revision}), update: async (fn, {expectedRevision}) => {
    if (revision !== expectedRevision) throw Object.assign(new Error("更新競合"), {code: "STORAGE_CONFLICT"});
    const next = structuredClone(state), receipt = fn(next); validatePhysicalStock(next); state = next; revision++; return receipt;
  }};
}
test("registration atomically records both locations with fixed default unit and optional contents", () => {
  const p = product(); delete p.unit; delete p.setContents;
  const state = emptyPhysicalStock(); applyStockCommand(state, command("create", {product: p, initialCounts: {container: 3, home: 1}}), {actor, at});
  assert.equal(state.products[0].unit, "個"); assert.equal(state.products[0].setContents, "");
  assert.deepEqual(state.balances.map((b) => b.usable), [3, 1]); assert.equal(state.events[0].changes.length, 2);
  const unknown = emptyPhysicalStock(); applyStockCommand(unknown, command("create", {product: p, initialCounts: {container: 3, home: null}}), {actor, at});
  assert.equal(unknown.balances[1].usable, null);
  for (const initialCounts of [{container: 3}, {container: 3, home: -1}, {container: 3, fba: 1}]) assert.throws(() => execute(emptyPhysicalStock(), command("create", {product: p, initialCounts})));
});

test("place editing preserves other buckets and location, audits both changes and replays once", () => {
  const {state} = fixture(); const id = idOf(state);
  const reserved = action(state, "reserve", {quantity: 2});
  const cmd = command("count_locations", {productId: id, locations: {home: {usable: 1, reserved: 0, unusable: 0}}, reason: "自宅を確認"});
  const saved = execute(reserved, cmd); assert.deepEqual(saved.state.balances[0], reserved.balances[0]);
  assert.equal(saved.state.balances[1].usable, 1); assert.equal(saved.state.events.at(-1).changes.length, 1);
  assert.equal(execute(saved.state, cmd).state.events.length, saved.state.events.length);
  const both = action(saved.state, "count_locations", {locations: {container: {usable: 3, reserved: 2, unusable: 0}, home: {usable: 2, reserved: 0, unusable: 0}}});
  assert.equal(both.balances[0].reserved, 2); assert.equal(both.events.at(-1).changes.length, 2);
  for (const locations of [{}, {fba: {usable: 1, reserved: 0, unusable: 0}}, {home: {usable: null, reserved: 0, unusable: 0}}, {home: {usable: 2}}]) assert.throws(() => action(saved.state, "count_locations", {locations}));
});

test("cloud preview changes nothing; commit and lost-response replay survive stale revision", async () => {
  const store = storeFixture(), monitorStore = {read: async () => emptyMonitor()}, service = createCloudStock({store, monitorStore, now: () => at});
  const cmd = command("create", {productId: randomUUID(), product: product(), locationId: "container", quantity: 3});
  const p = await service.preview(cmd, {expectedRevision: 0, actor}); assert.equal(p.event.changes[0].after.usable, 3); assert.equal((await store.read()).products.length, 0);
  await assert.rejects(service.commit(cmd, {expectedRevision: 0, actor, confirmed: false}), {status: 400});
  await service.commit(cmd, {expectedRevision: 0, actor, confirmed: true});
  const retry = await service.commit(cmd, {expectedRevision: 0, actor, confirmed: true}); assert.equal(retry.receipt.replayed, true);
  assert.equal((await store.read()).events.length, 1); assert.equal((await store.read()).products[0].id, cmd.productId);
  await assert.rejects(service.commit({...cmd, operationId: randomUUID()}, {expectedRevision: 0, actor, confirmed: true}), {code: "STORAGE_CONFLICT"});
});
test("link association validates ASIN without changing market records; stock CSV blocks formula cells", async () => {
  const store = storeFixture(), monitor = emptyMonitor(), linkId = randomUUID(); monitor.links.push({id: linkId, verified: true, asin: "B000TEST01"});
  const service = createCloudStock({store, monitorStore: {read: async () => monitor}, now: () => at});
  await assert.rejects(service.preview(command("create", {product: product({asin: "B000OTHER1", linkedLinkIds: [linkId]}), locationId: "container", quantity: 1}), {expectedRevision: 0, actor}), {status: 409});
  const {state} = fixture(); state.products[0].title = "=DANGEROUS()"; const view = physicalStockView({state, revision: 1}, emptyMonitor(), at);
  assert.match(stockCsv(view), /'=DANGEROUS\(\)/); assert.equal(view.products[0].fba.quantity, null);
});
test("catalog due dates use Japan date and no place/FBA grand total is fabricated", () => {
  const {state} = fixture(); state.products[0].reviewDate = "2026-10-26";
  const view = physicalStockView({state, revision: 1}, emptyMonitor(), at); assert.equal(view.products[0].catalogDue, true);
  assert.equal(view.products[0].totals.unknownLocations, 1); assert.equal(view.products[0].fba.quantity, null);
});

test("FBA reference never exposes stale, failed, missing-condition or mismatched SKU observations as current quantities", () => {
  const {state} = fixture(), monitor = emptyMonitor(), linkId = randomUUID();
  const product = state.products[0]; Object.assign(product, {asin: "B000TEST01", condition: "used", sellerSku: "own-used", linkedLinkIds: [linkId]});
  const listing = {listingId: "x123456789", references: []}; monitor.listings.push(listing);
  const observation = {id: "catalog", asin: product.asin, sellerSku: product.sellerSku, condition: "UsedGood", source: "amazon_sp_api", fulfillableQuantity: 4, checkedAt: at};
  monitor.catalog.push(observation); monitor.links.push({id: linkId, catalogId: observation.id, listingId: listing.listingId, verified: true,
    productFingerprint: JSON.stringify([observation.asin, observation.fnSku, observation.condition, observation.setContents]), referenceFingerprint: "[]"});
  const view = (when = at) => physicalStockView({state, revision: 1}, monitor, when).products[0].fba.quantity;
  assert.equal(view(), 4); assert.equal(view(new Date(Date.parse(at) + 91 * 60000).toISOString()), null);
  observation.error = "failed"; assert.equal(view(), null); delete observation.error;
  product.sellerSku = "different"; assert.equal(view(), null); product.sellerSku = observation.sellerSku;
  observation.condition = ""; monitor.links[0].productFingerprint = JSON.stringify([observation.asin, observation.fnSku, observation.condition, observation.setContents]); assert.equal(view(), null);
});
test("stock endpoints enforce owner/read-only/Origin/JSON/If-Match before actions", async () => {
  for (const readOnly of [true, false]) {
    let calls = 0;
    const origin = "https://stock.example", handler = createCloudHandler({config: {origin, authUrl: "https://fixture.neon.tech/auth", readOnly},
      verifyOwner: async (req) => ({status: req.headers.has("authorization") ? 200 : 401, userId: actor}),
      stock: {view: async () => {calls++; return {};}, preview: async () => {calls++; return {};}, commit: async () => {calls++; return {};}}});
    for (const path of ["/api/physical-stock/preview", "/api/physical-stock/operations"]) {
      const send = (headers = {}) => handler(new Request(origin + path, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: "{}"}));
      assert.equal((await send()).status, 401);
      assert.equal((await send({Authorization: "Bearer fixture", Origin: "https://other.example"})).status, 403);
      assert.equal((await send({Authorization: "Bearer fixture"})).status, readOnly ? 403 : 428);
      assert.equal((await send({Authorization: "Bearer fixture", "If-Match": '"0"', "Content-Type": "text/plain"})).status, readOnly ? 403 : 415);
    }
    assert.equal(calls, 0);
  }
});
