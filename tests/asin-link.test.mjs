import test from "node:test";
import assert from "node:assert/strict";
import {demoMonitor} from "../src/link-monitor-demo.js";
import {confirmAsinLink, registerPageLink, asinFromInput, assessLink, runPreview, notificationText, registerSuccessor, emptyMonitor} from "../src/link-monitor.js";

const at = "2026-10-21T05:00:00.000Z";
test("two page URLs can be associated without a catalog, owner lookup or external connection", () => {
  const state = emptyMonitor();
  const input = {amazon: "https://www.amazon.co.jp/dp/B000DEMO01?ref=test", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d1000000001", reviewed: true};
  const record = registerPageLink(state, input, at);
  assert.equal(record.asin, "B000DEMO01");
  assert.equal(state.catalog.length, 0);
  assert.equal(assessLink(record, state, at).inventory, "unknown");
  assert.equal(assessLink(record, state, at).yahoo, "unknown");
  registerPageLink(state, input, at);
  assert.equal(state.links.length, 1);
  assert.throws(() => registerPageLink(state, {...input, amazon: "B000OTHER1"}, at), /別の商品/);
  assert.throws(() => registerPageLink(state, {...input, reviewed: false}, at));
  assert.equal(asinFromInput("b000demo01"), "B000DEMO01");
  assert.equal(asinFromInput("https://amazon.co.jp/gp/product/B000DEMO01/"), "B000DEMO01");
  for (const value of ["bad", "https://example.com/dp/B000DEMO01", "https://amazon.co.jp.evil.test/dp/B000DEMO01", "https://amzn.to/short", "https://amazon.co.jp/?asin=B000DEMO01"]) assert.throws(() => asinFromInput(value));
});

function fixture() {
  const state = demoMonitor(at);
  state.catalog = []; state.links = []; state.events = [];
  return state;
}
function link(state, overrides = {}) {
  return confirmAsinLink(state, {listingId: state.listings[0].listingId, asin: "b000demo01", reviewed: true, ...overrides}, at);
}

test("ASIN-only association needs no SKU or inventory import and never invents stock", () => {
  const state = fixture();
  const record = link(state);
  assert.equal(record.asin, "B000DEMO01");
  assert.equal(record.catalogId, undefined);
  assert.equal(state.catalog.length, 0);
  const assessment = assessLink(record, state, at);
  assert.equal(assessment.inventory, "unknown");
  assert.equal(assessment.yahoo, "active");
  assert.equal(assessment.product.fulfillableQuantity, null);
  assert.equal(assessment.availableQuantity, null);
  assert.equal(assessment.product.checkedAt, undefined);
  runPreview(state, at); runPreview(state, at);
  assert.deepEqual(state.events.map((event) => event.kind), ["inventory_unknown"]);
  assert.match(notificationText(state.events[0]), /ASIN: B000DEMO01/);
  assert.match(notificationText(state.events[0]), /fulfillableQuantity: 不明/);
  link(state);
  assert.equal(state.links.length, 1);
});

test("ASIN registration rejects missing review, invalid ASIN, reference conflicts and reassignment", () => {
  const state = fixture();
  assert.throws(() => link(state, {reviewed: false}));
  assert.throws(() => link(state, {asin: "bad"}));
  assert.throws(() => link(state, {asin: "B000OTHER1"}), /一致しません/);
  assert.throws(() => link(state, {unitsPerListing: 0}));
  link(state);
  assert.throws(() => link(state, {asin: "B000OTHER1", reviewNote: "確認済み"}), /別の商品/);
  state.listings[0].references = [{kind: "asin", value: "B000OTHER1"}];
  assert.equal(assessLink(state.links[0], state, at).inventory, "unlinked");
});

test("unknown ASIN stock remains unknown even with a single imported SKU; multiple matches require review", () => {
  const state = fixture();
  const record = link(state);
  const product = {...demoMonitor(at).catalog[0], fulfillableQuantity: 0};
  state.catalog = [product];
  assert.equal(assessLink(record, state, at).inventory, "unknown");
  state.catalog.push({...product, id: "other", sellerSku: "other", condition: "新品"});
  assert.equal(assessLink(record, state, at).inventory, "unlinked");
  assert.match(assessLink(record, state, at).reason, /合算しません/);
});

test("ASIN association preserves reviewed successor history without acquiring stock", () => {
  const state = fixture();
  const record = link(state);
  state.listings.push({...state.listings[0], listingId: "d1000000002", url: "https://auctions.yahoo.co.jp/jp/auction/d1000000002"});
  registerSuccessor(state, record.id, {listingId: "d1000000002", reviewed: true, evidence: "同じASIN・状態・出品者を照合"}, at);
  assert.equal(record.asin, "B000DEMO01");
  assert.equal(record.history.length, 1);
  assert.equal(assessLink(record, state, at).inventory, "unknown");
});
