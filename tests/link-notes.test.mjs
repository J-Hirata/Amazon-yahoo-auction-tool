import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {emptyMonitor, registerPageLink, registerPageLinks, updateLinkMemo, updateListingPreview, assessLink} from "../src/link-monitor.js";
import {createMonitorStore} from "../src/link-monitor-store.js";
import {parseYahooPage, yahooImageUrl} from "../src/yahoo-observation.js";
import {ownListingInfo} from "../src/amazon-fba-reader.js";

const at = "2026-10-21T06:00:00Z";
const input = {amazon: "B000DEMO01", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d1000000001", submitted: true};
test("own comments and offer photos retain marketplace and source; catalog photo is separate", () => {
  const marketplaceId = "JP_TEST";
  const data = ownListingInfo({sku: "OWN-SKU", attributes: {
    condition_note: [{marketplace_id: marketplaceId, value: "状態良好。電源コード付属"}, {marketplace_id: "OTHER", value: "Not our marketplace"}],
    main_offer_image_locator: [{marketplace_id: marketplaceId, media_location: "https://m.media-amazon.com/images/I/own.jpg"}],
    main_product_image_locator: [{marketplace_id: marketplaceId, media_location: "https://m.media-amazon.com/images/I/not-own.jpg"}]
  }, summaries: [{marketplaceId, mainImage: {link: "https://m.media-amazon.com/images/I/catalog.jpg"}}]}, marketplaceId, at);
  assert.equal(data.ownComment, "状態良好。電源コード付属");
  assert.equal(data.ownCommentStatus, "retrieved");
  assert.deepEqual(data.offerImageUrls, ["https://m.media-amazon.com/images/I/own.jpg"]);
  assert.equal(data.catalogImageUrl, "https://m.media-amazon.com/images/I/catalog.jpg");
  assert.equal(ownListingInfo({sku: "OWN"}, marketplaceId, at).ownCommentStatus, "unknown");
  assert.equal(ownListingInfo({attributes: {condition_note: [{marketplace_id: marketplaceId, value: ""}]}}, marketplaceId, at).ownCommentStatus, "empty");
});
test("batch registration preserves successful rows, rejects conflicts and retries without duplicates", () => {
  const state = emptyMonitor();
  const rows = [input, {...input, amazon: "bad", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d1000000002"}, input, {...input, amazon: "B000OTHER1"}];
  const results = registerPageLinks(state, {rows, submitted: true}, at);
  assert.deepEqual(results.map((item) => item.status), ["created", "error", "existing", "error"]);
  assert.equal(state.links.length, 1);
  assert.equal(state.listings.length, 1);
  const repeated = registerPageLinks(state, {rows: [input], submitted: true}, at);
  assert.equal(repeated[0].status, "existing");
  registerPageLinks(state, {rows: [{...rows[1], amazon: "B000OTHER1"}], submitted: true}, at);
  assert.equal(state.links.length, 2);
  for (const value of [{rows: [], submitted: true}, {rows: [input], submitted: false}, {rows: Array(51).fill(input), submitted: true}]) assert.throws(() => registerPageLinks(state, value, at));
});
test("explicit registration replaces the checkbox; memo changes never change association or assessment", () => {
  const state = emptyMonitor();
  const link = registerPageLink(state, input, at);
  const before = structuredClone(link);
  const assessment = assessLink(link, state, at);
  updateLinkMemo(state, link.id, "スタンドなし\n電源コード付属", at);
  assert.deepEqual(link, {...before, userMemo: "スタンドなし\n電源コード付属", memoUpdatedAt: at});
  assert.deepEqual(assessLink(link, state, at), assessment);
  registerPageLink(state, input, at);
  assert.equal(link.userMemo, "スタンドなし\n電源コード付属");
  assert.equal(state.links.length, 1);
  assert.throws(() => registerPageLink(state, {...input, amazon: "B000OTHER1"}, at), /別の商品/);
  assert.throws(() => registerPageLink(emptyMonitor(), {...input, submitted: false}, at));
  for (const memo of [null, {}, 12, "x".repeat(501)]) assert.throws(() => updateLinkMemo(state, link.id, memo, at));
  assert.throws(() => updateLinkMemo(state, "missing", "memo", at));
  updateLinkMemo(state, link.id, "", at);
  assert.equal(link.userMemo, "");
});
test("new optional memo field persists on existing links without migrating the rest of the store", async () => {
  const store = createMonitorStore(await mkdtemp(path.join(os.tmpdir(), "asin-note-")));
  const id = await store.update((state) => registerPageLink(state, input, at).id);
  const before = await store.read();
  await store.update((state) => updateLinkMemo(state, id, "スタンドなし", at));
  const after = await store.read();
  assert.equal(after.links[0].userMemo, "スタンドなし");
  assert.deepEqual(after.listings, before.listings);
  assert.deepEqual(after.catalog, before.catalog);
  assert.deepEqual(after.events, before.events);
});
test("image metadata must be from the verified listing and only Yahoo HTTPS image hosts are accepted", () => {
  const state = emptyMonitor();
  const link = registerPageLink(state, input, at);
  const listing = state.listings[0];
  const before = structuredClone(listing);
  const imageUrl = "https://auctions.c.yimg.jp/images/test.jpg";
  const snapshot = {listingId: listing.listingId, title: "テスト商品 スタンドなし", imageUrl, references: [{kind: "asin", value: "B000OTHER1"}], seller: "another", observation: {status: "ended", verified: true}};
  updateListingPreview(state, link.id, snapshot, at);
  assert.deepEqual(listing, {...before, title: snapshot.title, imageUrl, previewCheckedAt: at});
  assert.equal(assessLink(link, state, at).yahoo, "unknown");
  assert.equal(state.events.length, 0);
  assert.throws(() => updateListingPreview(state, link.id, {...snapshot, listingId: "d1000000002"}, at));
  for (const value of ["javascript:alert(1)", "http://auctions.c.yimg.jp/a.jpg", "https://evil.test/a.jpg", "https://auctions.c.yimg.jp.evil.test/a.jpg", "https://u:p@auctions.c.yimg.jp/a.jpg"]) assert.equal(yahooImageUrl(value), "");
  const item = {auctionId: listing.listingId, title: "テスト商品", status: "open"};
  const html = `<meta property="og:image" content="${imageUrl}"><script id="__NEXT_DATA__">${JSON.stringify({props: {pageProps: {initialState: {item: {detail: {item}}}}}})}</script>`;
  assert.equal(parseYahooPage(html, listing.url, at).imageUrl, imageUrl);
});
