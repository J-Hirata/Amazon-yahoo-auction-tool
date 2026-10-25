import test from "node:test";
import assert from "node:assert/strict";
import {createCloudFba} from "../src/cloud-fba.js";
import {cloudAmazonConfig, amazonConfigFromValues, readFbaInventory} from "../src/amazon-fba-reader.js";
import {createCloudMail, createCloudMailTransport, cloudMailConfig} from "../src/cloud-mail.js";
import {demoMonitor} from "../src/link-monitor-demo.js";

const at = "2026-10-26T00:00:00.000Z";
const config = {accountKey: "fixture-account", sellerId: "FIXTURESELLER", marketplaceId: "A1VC38T7YXB528"};
function fixture() {
  let state = demoMonitor(at), revision = 1, writes = 0, failWrite;
  delete state.amazonAccountKey;
  const store = {read: async () => structuredClone(state), readSnapshot: async () => ({state: structuredClone(state), revision}), async update(work, options = {}) {
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) throw Object.assign(new Error("conflict"), {code: "STORAGE_CONFLICT"});
    writes++;
    if (writes === failWrite) throw Object.assign(new Error("unknown commit"), {code: "STORAGE_COMMIT_UNKNOWN"});
    const next = structuredClone(state); const result = await work(next); state = next; revision++; return result;
  }};
  return {store, revision: () => revision, failOn: (number) => {failWrite = number;}, replace: (value) => {state = value;}};
}
function result(asins) {return {status: "complete", complete: true, scope: "linked_asins_only", sellerId: config.sellerId, accountKey: config.accountKey, asins, checkedAt: at, items: asins.map((asin) => ({asin, sellerSku: "SKU-" + asin, fulfillableQuantity: 5})), pages: 2, scanned: asins.length};}
test("cloud Amazon config retains the existing identity fingerprint without reading local files", () => {
  const env = {ASIN_AMAZON_CLIENT_ID: "client", ASIN_AMAZON_CLIENT_SECRET: "secret", ASIN_AMAZON_REFRESH_TOKEN: "refresh", ASIN_AMAZON_MARKETPLACE_ID: config.marketplaceId, ASIN_AMAZON_SELLER_ID: config.sellerId};
  const old = amazonConfigFromValues({AMAZON_SP_API_LWA_CLIENT_ID: "client", AMAZON_SP_API_LWA_CLIENT_SECRET: "secret", AMAZON_SP_API_REFRESH_TOKEN: "refresh", AMAZON_SP_API_MARKETPLACE_ID: config.marketplaceId, AMAZON_SP_API_SELLER_ID: config.sellerId});
  assert.deepEqual(cloudAmazonConfig(env), old);
  assert.throws(() => cloudAmazonConfig({...env, ASIN_AMAZON_MARKETPLACE_ID: "OTHER"}));
});
test("cloud FBA completes in the request, persists target scope and never enables mail", async () => {
  const f = fixture(); let calls = 0;
  const service = createCloudFba({store: f.store, config, now: () => at, readInventory: async (options) => {calls++; assert.equal(options.maxDurationMs, 40000); assert.equal(options.maxPages, 20); assert.deepEqual(options.asins, ["B000DEMO01"]); return result(options.asins);}});
  assert.equal((await service.start({expectedRevision: 1})).status, "complete");
  const state = await f.store.read();
  assert.equal(calls, 1); assert.equal(state.amazonInventory.items[0].fulfillableQuantity, 5);
  assert.equal(state.mailOutbox?.length || 0, 0); assert.notEqual(state.notificationSettings?.mailEnabled, true);
});
test("FBA account mismatch, stale revision and unknown commit cannot start external reads", async () => {
  const f = fixture(); let calls = 0;
  const service = createCloudFba({store: f.store, config, now: () => at, readInventory: async () => {calls++;}});
  await assert.rejects(service.start({expectedRevision: 0}), {code: "STORAGE_CONFLICT"});
  f.replace({...await f.store.read(), amazonAccountKey: "other-account"});
  await assert.rejects(service.start({expectedRevision: 1}), {status: 409});
  const other = fixture(); other.failOn(1);
  await assert.rejects(createCloudFba({store: other.store, config, readInventory: async () => {calls++;}}).start({expectedRevision: 1}), {code: "STORAGE_COMMIT_UNKNOWN"});
  assert.equal(calls, 0);
});
test("a durable running FBA lease prevents parallel external reads and expires visibly", async () => {
  const f = fixture(); let resolve, calls = 0;
  const provider = new Promise((done) => {resolve = done;});
  const service = createCloudFba({store: f.store, config, now: () => at, readInventory: async () => {calls++; return provider;}});
  const task = service.start({expectedRevision: 1});
  await new Promise((done) => setImmediate(done));
  assert.equal((await service.start({expectedRevision: f.revision()})).status, "running");
  assert.equal(calls, 1); resolve(result(["B000DEMO01"])); await task;
  const interrupted = {...await f.store.read(), amazonInventory: {status: "running", leaseUntil: at}};
  assert.equal(service.status(interrupted).status, "failed");
});
test("FBA failures and malformed scope cannot publish a zero or upstream secret", async () => {
  for (const provider of [async () => {throw new Error("Amazon secret-token postgres://private");}, async () => ({...result(["B000OTHER1"]), complete: true})]) {
    const f = fixture();
    const service = createCloudFba({store: f.store, config, now: () => at, readInventory: provider});
    assert.equal((await service.start({expectedRevision: 1})).status, "failed");
    const state = await f.store.read(); assert.equal(state.amazonInventory.complete, false);
    assert.doesNotMatch(state.amazonInventory.error, /secret-token|postgres:/);
  }
});
test("the reader's total deadline includes retry delays and never reaches an unbounded GET", async () => {
  let requests = 0, waited = 0;
  await assert.rejects(readFbaInventory({asins: ["B000DEMO01"], config, maxDurationMs: 1000, now: () => 0,
    fetchImpl: async () => {requests++; return new Response("", {status: 429});}, wait: async (ms) => {waited += ms;}}));
  assert.equal(requests, 1); assert.equal(waited, 0);
});
test("SMTP verification authenticates without sending; TLS and fixed-recipient restrictions hold", async () => {
  const credentials = cloudMailConfig({ASIN_GMAIL_USER: "tokyotojjjj@gmail.com", ASIN_GMAIL_APP_PASSWORD: "abcdefghijklmnop"});
  assert.throws(() => cloudMailConfig({ASIN_GMAIL_USER: "other@example.invalid", ASIN_GMAIL_APP_PASSWORD: "abcdefghijklmnop"}));
  let sent = 0, verified = 0;
  const transport = createCloudMailTransport(credentials, {createTransport: (options) => {
    assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.secure, true); assert.equal(options.debug, false); assert.equal(options.disableUrlAccess, true);
    return {verify: async () => {verified++;}, close() {}, sendMail: async (message) => {sent++; assert.equal(message.to, "tokyotojjjj@gmail.com"); assert.equal(message.from, message.to); return {accepted: [message.to], rejected: []};}};
  }});
  await transport.verify(); assert.equal(verified, 1); assert.equal(sent, 0);
  assert.equal((await transport.send({attemptId: "fixture", subject: "Test", text: "Plain", to: "ignored@example.invalid"})).status, "smtp_accepted"); assert.equal(sent, 1);
});
test("mail connection check does not send or enable automatic notifications", async () => {
  const f = fixture(); let sent = 0;
  const mail = createCloudMail({store: f.store, now: () => at, transport: {verify: async () => {}, send: async () => {sent++;}}});
  await mail.verify({expectedRevision: 1});
  assert.equal((await f.store.read()).cloudMail.status, "verified"); assert.equal(sent, 0);
  assert.notEqual((await f.store.read()).notificationSettings?.mailEnabled, true);
});
test("one mail test requires explicit intent, commits its attempt first, and deduplicates", async () => {
  const f = fixture(); let sent = 0;
  const mail = createCloudMail({store: f.store, now: () => at, transport: {verify: async () => {}, send: async () => {sent++; assert.equal((await f.store.read()).mailOutbox[0].status, "sending"); return {status: "smtp_accepted"};}}});
  const linkId = (await f.store.read()).links[0].id;
  await assert.rejects(mail.test({expectedRevision: 1, linkId}), {status: 400});
  await assert.rejects(mail.test({expectedRevision: 1, linkId, confirmed: true}), {status: 409});
  await mail.verify({expectedRevision: f.revision()});
  await mail.test({expectedRevision: f.revision(), linkId, confirmed: true});
  assert.equal((await f.store.read()).mailOutbox[0].status, "smtp_accepted");
  assert.equal((await mail.test({expectedRevision: f.revision(), linkId, confirmed: true})).duplicate, true); assert.equal(sent, 1);
});
test("lost SMTP result never retries and does not leak credentials", async () => {
  const f = fixture(); let sent = 0;
  const mail = createCloudMail({store: f.store, now: () => at, transport: {verify: async () => {}, send: async () => {sent++; throw new Error("secret-token");}}});
  await mail.verify({expectedRevision: 1}); const linkId = (await f.store.read()).links[0].id;
  await mail.test({expectedRevision: f.revision(), linkId, confirmed: true});
  const state = await f.store.read(); assert.equal(state.mailOutbox[0].status, "uncertain"); assert.doesNotMatch(state.mailOutbox[0].error, /secret-token/);
  await mail.test({expectedRevision: f.revision(), linkId, confirmed: true}); assert.equal(sent, 1);
});
test("lost DB receipt after SMTP acceptance leaves an uncertain one-shot attempt", async () => {
  const f = fixture(); let sent = 0;
  const mail = createCloudMail({store: f.store, now: () => at, transport: {verify: async () => {}, send: async () => {sent++; return {status: "smtp_accepted"};}}});
  await mail.verify({expectedRevision: 1}); f.failOn(4);
  const linkId = (await f.store.read()).links[0].id;
  await assert.rejects(mail.test({expectedRevision: f.revision(), linkId, confirmed: true}), {code: "STORAGE_COMMIT_UNKNOWN"});
  await mail.test({expectedRevision: f.revision(), linkId, confirmed: true}); assert.equal(sent, 1);
  const later = createCloudMail({store: f.store, transport: {}, now: () => "2026-10-26T00:02:00.000Z"});
  assert.equal(later.view(await f.store.read()).mailOutbox[0].status, "uncertain");
});
