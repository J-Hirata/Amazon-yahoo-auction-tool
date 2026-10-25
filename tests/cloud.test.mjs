import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPair, SignJWT} from "jose";
import {cloudConfiguration, createOwnerVerifier} from "../src/cloud-auth.js";
import {createCloudHandler} from "../src/cloud-handler.js";
import {demoMonitor} from "../src/link-monitor-demo.js";

const authUrl = "https://fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth";
const config = {origin: "https://inventory.example", authUrl, ownerUserId: "owner-fixture-001", readOnly: false};
const {privateKey, publicKey} = await generateKeyPair("EdDSA");
const verify = createOwnerVerifier({...config, keySet: publicKey});
const sign = (subject = config.ownerUserId, extra = {}) => new SignJWT({...extra}).setProtectedHeader({alg: "EdDSA"}).setSubject(subject)
  .setIssuer(new URL(authUrl).origin).setIssuedAt().setExpirationTime("15m").sign(privateKey);
const ownerToken = await sign();
function fixture(readOnly = false) {
  let state = demoMonitor(new Date().toISOString());
  let revision = 1;
  const calls = {read: 0, write: 0};
  const store = {
    readSnapshot: async () => {calls.read++; return {state: structuredClone(state), revision};},
    update: async (callback, options) => {
      calls.write++;
      if (options.expectedRevision !== revision) throw Object.assign(new Error("更新競合"), {code: "STORAGE_CONFLICT"});
      const next = structuredClone(state);
      const result = await callback(next);
      state = next; revision++;
      return result;
    }
  };
  const handler = createCloudHandler({config: {...config, readOnly}, store, verifyOwner: verify});
  const request = (route = "/api/link-monitor", {method = "GET", token = ownerToken, body, headers = {}, origin = config.origin} = {}) => handler(new Request(origin + route, {
    method, headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body === undefined ? {} : {"Content-Type": "application/json"}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  }));
  return {request, calls, store, linkId: state.links[0].id};
}

test("cloud startup requires explicit owner, origin, and dedicated Auth URL", () => {
  const env = {ASIN_PUBLIC_ORIGIN: config.origin, ASIN_NEON_AUTH_URL: authUrl, ASIN_OWNER_USER_ID: config.ownerUserId};
  assert.equal(cloudConfiguration(env).readOnly, true);
  assert.equal(cloudConfiguration({...env, ASIN_CLOUD_READ_ONLY: "0"}).readOnly, false);
  for (const change of [{ASIN_OWNER_USER_ID: ""}, {ASIN_NEON_AUTH_URL: "https://evil.example/auth"}, {ASIN_PUBLIC_ORIGIN: "http://inventory.example"}, {ASIN_PUBLIC_ORIGIN: "https://inventory.example/path"}]) {
    assert.throws(() => cloudConfiguration({...env, ...change}));
  }
});
test("anonymous API requests never read the database", async () => {
  const f = fixture();
  assert.equal((await f.request(undefined, {token: ""})).status, 401);
  assert.deepEqual(f.calls, {read: 0, write: 0});
});
test("a verified non-owner cannot gain access with an owner email or request body", async () => {
  const f = fixture();
  const token = await sign("another-user-001", {email: "owner@example.invalid", role: "admin"});
  assert.equal((await f.request(undefined, {token})).status, 403);
  assert.deepEqual(f.calls, {read: 0, write: 0});
});
test("wrong issuer, expired, missing-expiry, bad signature and forged tokens fail closed", async () => {
  const f = fixture();
  const wrongIssuer = await new SignJWT({}).setProtectedHeader({alg: "EdDSA"}).setSubject(config.ownerUserId).setIssuer("https://evil.example").setIssuedAt().setExpirationTime("15m").sign(privateKey);
  const expired = await new SignJWT({}).setProtectedHeader({alg: "EdDSA"}).setSubject(config.ownerUserId).setIssuer(new URL(authUrl).origin).setIssuedAt(Math.floor(Date.now() / 1000) - 1800).setExpirationTime("-5m").sign(privateKey);
  const missingExpiry = await new SignJWT({}).setProtectedHeader({alg: "EdDSA"}).setSubject(config.ownerUserId).setIssuer(new URL(authUrl).origin).setIssuedAt().sign(privateKey);
  const other = await generateKeyPair("EdDSA");
  const badSignature = await new SignJWT({}).setProtectedHeader({alg: "EdDSA"}).setSubject(config.ownerUserId).setIssuer(new URL(authUrl).origin).setIssuedAt().setExpirationTime("15m").sign(other.privateKey);
  for (const token of [wrongIssuer, expired, missingExpiry, badSignature, "forged.token.payload"]) assert.equal((await f.request(undefined, {token})).status, 401);
  assert.deepEqual(f.calls, {read: 0, write: 0});
});
test("owner reads the reused monitor view with delivery and external reads disabled", async () => {
  const response = await fixture().request();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.links.length, 1);
  assert.equal(data.storage.revision, 1);
  assert.equal(data.config.notificationRuntime, false);
  assert.equal(data.config.capabilities.externalReads, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});
test("read-only mode rejects writes before parsing or accessing storage", async () => {
  const f = fixture(true);
  assert.equal((await f.request(`/api/link-monitor/links/${f.linkId}/memo`, {method: "POST", body: {memo: "not saved"}, headers: {"If-Match": '"1"'}})).status, 403);
  assert.deepEqual(f.calls, {read: 0, write: 0});
});
test("same-origin and public-origin checks reject CSRF and wrong hosting configuration", async () => {
  const f = fixture();
  for (const options of [{headers: {Origin: "https://evil.example"}}, {headers: {"Sec-Fetch-Site": "cross-site"}}, {origin: "https://wrong.example"}]) assert.equal((await f.request(undefined, options)).status, 403);
  assert.deepEqual(f.calls, {read: 0, write: 0});
});
test("legacy, image proxy, mail, inventory, deletion and successor routes are not exposed", async () => {
  const f = fixture();
  for (const [route, method] of [["/api/items", "GET"], ["/api/image-proxy", "GET"], ["/api/link-monitor/fba-check", "POST"], ["/api/link-monitor/mail/test-registration", "POST"], ["/api/link-monitor/notification-settings", "POST"], ["/api/link-monitor/check-and-notify", "POST"], [`/api/link-monitor/links/${f.linkId}`, "DELETE"], [`/api/link-monitor/links/${f.linkId}/successor`, "POST"]]) {
    assert.equal((await f.request(route, {method})).status, 404);
  }
  assert.deepEqual(f.calls, {read: 0, write: 0});
});
test("memo save and stale-revision rejection retain current data", async () => {
  const f = fixture();
  const route = `/api/link-monitor/links/${f.linkId}/memo`;
  assert.equal((await f.request(route, {method: "POST", body: {memo: "missing revision"}})).status, 428);
  const first = await f.request(route, {method: "POST", body: {memo: "stand missing"}, headers: {"If-Match": '"1"'}});
  assert.equal(first.status, 200);
  assert.equal((await first.json()).links[0].userMemo, "stand missing");
  assert.equal((await f.request(route, {method: "POST", body: {memo: "stale"}, headers: {"If-Match": '"1"'}})).status, 409);
  assert.equal((await f.store.readSnapshot()).state.links[0].userMemo, "stand missing");
});
test("registration is local-data only and repeated pairs are not duplicated or emailed", async () => {
  const f = fixture();
  const body = {amazon: "B000DEMO02", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d9999999002", submitted: true};
  const request = (revision) => f.request("/api/link-monitor/page-links", {method: "POST", body, headers: {"If-Match": `"${revision}"`}});
  assert.equal((await request(1)).status, 200);
  const response = await request(2);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.links.length, 2);
  assert.equal(data.mailOutbox?.length || 0, 0);
});
test("demo is temporary, allowed in read-only mode, and cannot write the database", async () => {
  const f = fixture(true);
  const response = await f.request("/api/link-monitor/demo", {method: "POST", body: {scenario: "zero"}});
  assert.equal(response.status, 200);
  assert.ok((await response.json()).result.events.length > 0);
  assert.deepEqual(f.calls, {read: 0, write: 0});
});
test("JSON size, content type and unexpected errors are handled without secret disclosure", async () => {
  const f = fixture();
  assert.equal((await f.request("/api/link-monitor/demo", {method: "POST", body: {}, headers: {"Content-Type": "text/plain"}})).status, 415);
  assert.equal((await f.request("/api/link-monitor/demo", {method: "POST", body: {value: "x".repeat(2 * 1024 * 1024)}})).status, 413);
  f.store.readSnapshot = async () => {throw new Error("postgres://secret:password@private.example/db");};
  const response = await f.request();
  assert.doesNotMatch(await response.text(), /password|postgres:|private\.example/);
});
test("hosting adapter fails closed when owner configuration is absent", async () => {
  const {default: inventory, config: routes} = await import("../netlify/functions/inventory.mjs");
  assert.ok(routes.path.includes("/api/*"));
  const previous = process.env.ASIN_OWNER_USER_ID;
  delete process.env.ASIN_OWNER_USER_ID;
  try {
    const response = await inventory(new Request("https://inventory.example/api/link-monitor"));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /postgres:|password|\.env/);
  } finally {if (previous !== undefined) process.env.ASIN_OWNER_USER_ID = previous;}
});
