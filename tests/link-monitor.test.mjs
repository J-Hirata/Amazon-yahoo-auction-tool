import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {demoMonitor, advanceDemo} from "../src/link-monitor-demo.js";
import {parseCatalog, normalizeCatalog, quantity, candidatesFor, confirmLink, confirmAsinLink, assessLink, observeListing, registerSuccessor, runPreview, notificationText, notificationPreview, testDelivery, PREVIEW_CONFIG} from "../src/link-monitor.js";
import {parseYahooPage, managementReferences, yahooListingUrl, fetchYahooListing} from "../src/yahoo-observation.js";
import {createMonitorStore} from "../src/link-monitor-store.js";

const at = "2026-10-21T05:00:00.000Z";
const later = (seconds) => new Date(Date.parse(at) + seconds * 1000).toISOString();
const fixture = () => demoMonitor(at);
const kinds = (state) => state.events.map((event) => event.kind);
test("new links retain their creation time on re-review; legacy dates remain unknown",()=>{
  for(const byAsin of [false,true]){
    const state=fixture();state.links=[];
    const input={listingId:state.listings[0].listingId,asin:state.catalog[0].asin,catalogId:state.catalog[0].id,reviewed:true};
    const confirm=byAsin?confirmAsinLink:confirmLink,link=confirm(state,input,at);
    assert.equal(link.createdAt,at);confirm(state,input,later(60));assert.equal(link.createdAt,at);assert.equal(link.reviewedAt,later(60));
    delete link.createdAt;confirm(state,input,later(120));assert.equal(link.createdAt,undefined);
  }
});
function observe(state, status, seconds) {
  return observeListing(state, {...state.listings[0], observation: {status, verified: status !== "unknown", checkedAt: later(seconds), reason: "unknown", source: "test", evidence: "fixture"}});
}

test("management block extracts the ASIN without relying on the page title", () => {
  assert.deepEqual(managementReferences("【管理番号】\nASIN: B0176E86U8"), [{kind: "asin", value: "B0176E86U8"}]);
  assert.deepEqual(managementReferences("管理番号：AC-000123"), [{kind: "management", value: "AC-000123"}]);
  assert.deepEqual(managementReferences("おすすめ商品 B0176E86U8"), []);
  assert.equal(managementReferences("ASIN: B0176E86U8\nASIN: B0176E86U8").length, 1);
});
test("structured description is used instead of the truncated description summary", () => {
  const item = {auctionId: "c1245610698", title: "fixture", seller: {aucUserId: "owner"}, status: "open", description: ["省略…"], descriptionHtml: "<div>【管理番号】<br>ASIN: B0176E86U8</div>"};
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({props: {pageProps: {initialState: {item: {detail: {item}}}}}})}</script>`;
  const parsed = parseYahooPage(html, "https://auctions.yahoo.co.jp/jp/auction/c1245610698", at);
  assert.equal(parsed.references[0].value, "B0176E86U8");
  assert.equal(parsed.observation.status, "active");
  assert.throws(() => parseYahooPage("ログインしてください", parsed.url), /確認できません/);
  assert.throws(() => parseYahooPage(html, "https://auctions.yahoo.co.jp/jp/auction/c1245610699"), /確認できません/);
});
test("listing fetch rejects non-Yahoo URLs, redirects to login/private hosts, and failed pages", async () => {
  assert.throws(() => yahooListingUrl("https://example.com/jp/auction/c1245610698"));
  assert.throws(() => yahooListingUrl("https://auctions.yahoo.co.jp:8443/jp/auction/c1245610698"));
  await assert.rejects(fetchYahooListing("https://auctions.yahoo.co.jp/jp/auction/c1245610698", {fetchImpl: async () => ({status: 302, headers: new Headers({location: "http://127.0.0.1/"})})}));
  await assert.rejects(fetchYahooListing("https://auctions.yahoo.co.jp/jp/auction/c1245610698", {fetchImpl: async () => ({status: 403, ok: false})}), /403/);
});
test("ASIN matches produce review candidates, including multiple conditions; never auto-link", () => {
  const state = fixture();
  state.links = [];
  const other = {...state.catalog[0], id: "other", sellerSku: "other", condition: "中古・可", setContents: "別セット"};
  const candidates = candidatesFor(state.listings[0], [...state.catalog, other]);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.needsReview));
  assert.equal(state.links.length, 0);
  assert.throws(() => confirmLink(state, {listingId: state.listings[0].listingId, catalogId: other.id, reviewed: true}, at));
  assert.throws(() => confirmLink(state, {listingId: state.listings[0].listingId, catalogId: state.catalog[0].id, reviewed: false}, at));
});
test("missing management number can be manually linked, and changing identity requires re-review", () => {
  const state = fixture(); state.links = []; state.listings[0].references = [];
  const link = confirmLink(state, {listingId: state.listings[0].listingId, catalogId: state.catalog[0].id, reviewed: true}, at);
  assert.equal(assessLink(link, state, at).inventory, "available");
  state.catalog[0].setContents = "別のセット";
  assert.equal(assessLink(link, state, at).inventory, "unlinked");
  runPreview(state, at); runPreview(state, at);
  assert.deepEqual(kinds(state), ["link_review"]);
  confirmLink(state, {listingId: link.listingId, catalogId: link.catalogId, reviewed: true}, at);
  assert.equal(assessLink(link, state, at).inventory, "available");
});
test("notification leads with the issue and action, then groups product, status and technical details", () => {
  const state = fixture();
  advanceDemo(state, "stopped", at);
  const event = state.events.find((item) => item.kind === "yahoo_ended");
  const preview = notificationPreview(event);
  assert.match(preview.message, /終了・停止/);
  assert.match(preview.action, /再出品/);
  assert.ok(preview.product.some(([label]) => label === "SKU"));
  const content = notificationText(event);
  assert.ok(content.indexOf(preview.message) < content.indexOf("【商品情報】"));
  assert.ok(content.indexOf("必要な対応:") < content.indexOf("【商品情報】"));
  assert.ok(content.indexOf("【商品情報】") < content.indexOf("【在庫・出品状況】"));
  assert.ok(content.indexOf("【在庫・出品状況】") < content.indexOf("【確認の詳細】"));
  assert.match(content, /\n\n【商品情報】\n/);
});

test("malformed, missing and boolean quantities never become zero", () => {
  for (const value of [null, undefined, "", " ", false, true, [], {}, "bad", -1, 1.2, "0x10"]) assert.equal(quantity(value), null);
  assert.equal(quantity("0"), 0);
  assert.equal(quantity(4), 4);
});
test("CSV parses BOM, quoted commas and newlines; missing data remains unknown", () => {
  const rows = parseCatalog('\uFEFFseller-sku,asin,condition,setContents,afn-fulfillable-quantity\r\n"SKU,1",B000DEMO01,中古,"本体\n電源",0\r\n', {sellerAccount: "account", marketplaceId: "JP", checkedAt: at});
  assert.equal(rows[0].sellerSku, "SKU,1");
  assert.equal(rows[0].fulfillableQuantity, 0);
  assert.equal(rows[0].externalCommitments, null);
  assert.throws(() => parseCatalog("sku,asin\na,B000DEMO01\na,B000DEMO01", {sellerAccount: "account", marketplaceId: "JP", checkedAt: at}), /重複/);
  assert.throws(() => parseCatalog("sku,asin\na,B000DEMO01", {sellerAccount: "account", marketplaceId: "JP"}), /日時/);
});
test("available → zero → duplicate suppression → recovery → zero", () => {
  const state = fixture();
  advanceDemo(state, "recovery", at);
  assert.deepEqual(kinds(state), ["inventory_zero", "inventory_recovered", "inventory_zero"]);
  runPreview(state, later(10));
  assert.equal(state.events.length, 3);
});
test("Amazon listing inactivity is not a zero-stock signal, and reservations are not subtracted twice", () => {
  const state = fixture();
  Object.assign(state.catalog[0], {listingStatus: "inactive", fulfillableQuantity: 5, reservedQuantity: 7});
  assert.equal(assessLink(state.links[0], state, at).availableQuantity, 5);
  assert.equal(assessLink(state.links[0], state, at).inventory, "available");
  state.catalog[0].externalCommitments = 5;
  assert.equal(assessLink(state.links[0], state, at).inventory, "zero");
});
test("unknown eligibility or unaccounted commitments and stale data do not claim stock is allocatable", () => {
  const state = fixture(); const item = state.catalog[0];
  item.mcfEligibility = "unknown"; assert.equal(assessLink(state.links[0], state, at).inventory, "unknown");
  item.fulfillableQuantity = 0; assert.equal(assessLink(state.links[0], state, at).inventory, "zero");
  item.checkedAt = "2025-01-01T00:00:00Z"; assert.equal(assessLink(state.links[0], state, at).inventory, "unknown");
  Object.assign(item, {checkedAt: at, fulfillableQuantity: 5, mcfEligibility: "verified", externalCommitments: null});
  assert.equal(assessLink(state.links[0], state, at).inventory, "unknown");
  assert.equal(assessLink(state.links[0], state, "2026-10-22T00:00:00Z").inventory, "unknown");
});
test("unknown observations preserve the last zero state across failures and restore notifications", () => {
  const state = fixture(); const item = state.catalog[0];
  runPreview(state, at); item.fulfillableQuantity = 0; runPreview(state, at);
  item.error = "取得失敗"; runPreview(state, at); runPreview(state, at);
  delete item.error; runPreview(state, at);
  assert.deepEqual(kinds(state), ["inventory_zero", "inventory_unknown", "inventory_restored"]);
});
test("ended listing requires distinct consecutive confirmations; errors, time or absent results cannot imply ended", () => {
  const state = fixture(); runPreview(state, at);
  observe(state, "ended", 1); runPreview(state, later(1));
  assert.equal(state.events.length, 0);
  observe(state, "ended", 1); runPreview(state, later(1));
  assert.equal(state.events.length, 0);
  observe(state, "unknown", 2); runPreview(state, later(2));
  observe(state, "ended", 3); runPreview(state, later(3));
  assert.equal(kinds(state).filter((kind) => kind === "yahoo_ended").length, 0);
  observe(state, "ended", 4); runPreview(state, later(4));
  assert.equal(kinds(state).filter((kind) => kind === "yahoo_ended").length, 1);
  observe(state, "active", 5); runPreview(state, later(5));
  assert.ok(kinds(state).includes("yahoo_recovered"));
});
test("successor needs reviewed evidence, matching seller and references; history retains the old ID", () => {
  const state = fixture(); const link = state.links[0];
  const next = {...state.listings[0], listingId: "d1000000002", url: "https://auctions.yahoo.co.jp/jp/auction/d1000000002"};
  observeListing(state, next);
  assert.throws(() => registerSuccessor(state, link.id, {listingId: next.listingId, reviewed: true}, at));
  next.seller = "other"; observeListing(state, next);
  assert.throws(() => registerSuccessor(state, link.id, {listingId: next.listingId, reviewed: true, evidence: "test"}, at));
  next.seller = state.listings[0].seller; observeListing(state, next);
  registerSuccessor(state, link.id, {listingId: next.listingId, reviewed: true, evidence: "同じ状態・付属品・出品者を確認"}, at);
  assert.equal(link.history[0].previousId, "d1000000001");
  assert.equal(assessLink(link, state, at).yahoo, "active");
  runPreview(state, at);
  assert.ok(kinds(state).includes("yahoo_relisted"));
  assert.ok(notificationText(state.events.find((event) => event.kind === "yahoo_relisted")).includes("d1000000001 → d1000000002"));
  runPreview(state, at);
  assert.equal(kinds(state).filter((kind) => kind === "yahoo_relisted").length, 1);
});
test("mail content has identifiers, quantities, timestamps, evidence and links; delivery failure is retryable", async () => {
  const state = fixture(); advanceDemo(state, "zero", at); const event = state.events[0];
  const content = notificationText(event);
  for (const required of ["Seller SKU", "FNSKU", "fulfillableQuantity", "確認時刻", "判定理由", "ヤフオク:", "必要な対応", "未送信"]) assert.ok(content.includes(required));
  await assert.rejects(testDelivery(event, {send: async () => {}}, at));
  await testDelivery(event, {testOnly: true, send: async () => {throw new Error("offline");}}, at);
  assert.equal(event.delivery.status, "test_failed");
  await testDelivery(event, {testOnly: true, send: async () => {}}, at);
  assert.equal(event.delivery.status, "test_sent"); assert.equal(event.delivery.attempts, 2);
});
test("concurrent updates are serialized and notification suppression survives reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asin-link-store-"));
  const store = createMonitorStore(directory);
  const state = fixture(); advanceDemo(state, "zero", at);
  await store.update((next) => Object.assign(next, state));
  await Promise.all(Array.from({length: 8}, (_, i) => store.update((next) => next.logs.push({i}))));
  const reopened = await createMonitorStore(directory).read();
  assert.equal(reopened.logs.length, 8);
  runPreview(reopened, later(10)); assert.equal(reopened.events.length, 1);
  assert.equal(PREVIEW_CONFIG.emailEnabled, false); assert.equal(PREVIEW_CONFIG.schedulerEnabled, false);
  assert.ok((await readFile(path.join(directory, "link-monitor.json"), "utf8")).includes("inventory_zero"));
});
