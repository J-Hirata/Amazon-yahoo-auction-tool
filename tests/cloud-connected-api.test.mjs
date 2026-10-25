import test from "node:test";
import assert from "node:assert/strict";
import {createCloudHandler} from "../src/cloud-handler.js";
import {demoMonitor} from "../src/link-monitor-demo.js";

const origin = "https://fixture.example";
function fixture(readOnly = false) {
  let reads = 0, actions = 0;
  const handler = createCloudHandler({config: {origin, authUrl: "https://fixture.neonauth.aws.neon.tech/neondb/auth", readOnly},
    verifyOwner: async (request) => ({status: request.headers.has("authorization") ? 200 : 401, userId: "fixture-owner"}),
    store: {read: async () => {reads++; return demoMonitor(new Date().toISOString());}, readSnapshot: async () => {reads++; return {state: demoMonitor(new Date().toISOString()), revision: 1};}},
    fba: {status: () => ({status: "idle"}), start: async (options) => {actions++; assert.deepEqual(options, {expectedRevision: 1}); return {status: "complete"};}},
    mail: {view: (state) => state, verify: async () => {actions++;}, test: async () => {actions++;}},
    sales: {start: async (options) => {actions++; assert.deepEqual(options, {expectedRevision: 1});}, check: async (options) => {actions++; assert.deepEqual(options, {expectedRevision: 1});}}});
  const request = (path, {anonymous = false, match = '"1"', headers = {}, body = {}} = {}) => handler(new Request(origin + path, {method: "POST", headers: {
    "Content-Type": "application/json", ...(!anonymous ? {Authorization: "Bearer fixture"} : {}), ...(match ? {"If-Match": match} : {}), ...headers}, body: JSON.stringify(body)}));
  return {request, counts: () => ({reads, actions})};
}
test("connected inventory/mail routes reject anonymous, readonly, stale form and CSRF before actions", async () => {
  for (const path of ["/api/link-monitor/fba-check", "/api/link-monitor/mail/verify", "/api/link-monitor/mail/test-registration", "/api/link-monitor/sales/start", "/api/link-monitor/sales/check"]) {
    const f = fixture();
    assert.equal((await f.request(path, {anonymous: true})).status, 401);
    assert.equal((await f.request(path, {match: null})).status, 428);
    assert.equal((await f.request(path, {headers: {Origin: "https://other.example"}})).status, 403);
    assert.equal((await f.request(path, {headers: {"Content-Type": "text/plain"}})).status, 415);
    assert.deepEqual(f.counts(), {reads: 0, actions: 0});
    const readonly = fixture(true); assert.equal((await readonly.request(path)).status, 403); assert.deepEqual(readonly.counts(), {reads: 0, actions: 0});
  }
});
test("sales routes cannot accept client supplied accounts, dates, SKU scope or order records", async () => {
  const f = fixture();
  for (const path of ["/sales/start", "/sales/check"]) assert.equal((await f.request("/api/link-monitor" + path, {body: {sellerId: "other", after: "2000-01-01", rows: [{quantity: 999}], targets: [{sellerSku: "other"}]}})).status, 200);
  assert.equal(f.counts().actions, 2);
});
test("the cloud inventory endpoint cannot accept arbitrary ASINs, accounts or URLs from the client", async () => {
  const f = fixture();
  assert.equal((await f.request("/api/link-monitor/fba-check", {body: {asins: ["B000OTHER1"], sellerId: "OTHER", url: "https://evil.example"}})).status, 200);
  assert.equal(f.counts().actions, 1);
});
