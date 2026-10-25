import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPair, SignJWT} from "jose";
import {createOwnerVerifier, createIdentityVerifier, cloudConfiguration} from "../src/cloud-auth.js";
import {createOwnerAccess, setupDigest} from "../src/owner-access.js";
import {createCloudHandler} from "../src/cloud-handler.js";
import {patchDraft, addDrafts} from "../src/cloud-drafts.js";
import {demoMonitor} from "../src/link-monitor-demo.js";

const authUrl = "https://fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth";
const origin = "https://inventory.example";
const ownerId = "owner-fixture-001";
const {privateKey, publicKey} = await generateKeyPair("EdDSA");
const sign = (id) => new SignJWT({}).setProtectedHeader({alg: "EdDSA"}).setIssuer(new URL(authUrl).origin).setSubject(id).setIssuedAt().setExpirationTime("15m").sign(privateKey);
const jwt = await sign(ownerId);
const capability = "a".repeat(64);

function ownerFixture({expires = Date.now() + 3600000, commitFails = false} = {}) {
  let record = {owner_user_id: null, setup_digest: setupDigest(capability), setup_expires_at: new Date(expires).toISOString(), enrolled_at: null};
  const sql = [];
  const client = {release() {}, async query(text, values) {
    sql.push(text);
    if (text === "COMMIT" && commitFails) throw Object.assign(new Error("connection lost"), {code: "ECONNRESET"});
    if (text.startsWith("SELECT owner_user_id")) return {rows: [structuredClone(record)]};
    if (text.startsWith("UPDATE app_security")) {record.owner_user_id = values[0]; record.enrolled_at = values[1];}
    return {rows: []};
  }};
  return {access: createOwnerAccess({pool: {connect: async () => client}}), sql, current: () => record};
}
test("owner capability is hashed, expires, cannot choose another owner, and repeat claim is idempotent", async () => {
  const f = ownerFixture();
  assert.notEqual(f.current().setup_digest, capability);
  await assert.rejects(f.access.check("b".repeat(64)), {status: 403});
  assert.equal((await f.access.check(capability)).available, true);
  assert.equal((await f.access.claim({token: capability, verifiedUserId: ownerId})).status, "enrolled");
  assert.ok(f.sql.some((sql) => sql.endsWith("FOR UPDATE")));
  assert.equal(await f.access.ownerUserId(), ownerId);
  assert.equal((await f.access.claim({token: capability, verifiedUserId: ownerId})).status, "already_enrolled");
  await assert.rejects(f.access.claim({token: capability, verifiedUserId: "intruder-fixture"}), {status: 409});
  await assert.rejects(f.access.check(capability), {status: 409});
  await assert.rejects(ownerFixture({expires: Date.now() - 1000}).access.check(capability), {status: 410});
});
test("owner enrollment preserves unknown commit outcome and never retries binding", async () => {
  const f = ownerFixture({commitFails: true});
  await assert.rejects(f.access.claim({token: capability, verifiedUserId: ownerId}), {code: "STORAGE_COMMIT_UNKNOWN"});
  assert.equal(f.sql.filter((sql) => sql.startsWith("UPDATE")).length, 1);
});
test("DB-owned mode is explicit and cannot fall back to a static owner", () => {
  const env = {ASIN_NEON_AUTH_URL: authUrl, ASIN_PUBLIC_ORIGIN: origin, ASIN_OWNER_FROM_DATABASE: "1"};
  assert.equal(cloudConfiguration(env).ownerFromDatabase, true);
  assert.throws(() => cloudConfiguration({...env, ASIN_OWNER_USER_ID: ownerId}));
});
test("signature validation precedes DB owner lookup and verified strangers are rejected", async () => {
  let lookups = 0;
  const verify = createOwnerVerifier({authUrl, keySet: publicKey, resolveOwnerUserId: async () => {lookups++; return ownerId;}});
  const request = (value) => new Request(origin, {headers: {Authorization: `Bearer ${value}`}});
  assert.equal((await verify(request("forged.token.value"))).status, 401);
  assert.equal(lookups, 0);
  assert.equal((await verify(request(await sign("another-fixture")))).status, 403);
  assert.equal((await verify(request(jwt))).status, 200);
});
function workspace(readOnly = false) {
  let drafts = [{asin: "B000DEMO01", title: "Fixture", description: "", imageUrls: [], status: "waiting_for_product_data"}];
  let revision = 1;
  const calls = {businessReads: 0, writes: 0};
  const draftStore = {readSnapshot: async () => {calls.businessReads++; return {state: structuredClone(drafts), revision};}, read: async () => structuredClone(drafts), update: async (work, options) => {
    if (options.expectedRevision !== revision) throw Object.assign(new Error("conflict"), {code: "STORAGE_CONFLICT"});
    const next = structuredClone(drafts); await work(next); drafts = next; revision++; calls.writes++;
  }};
  const access = ownerFixture().access;
  const handler = createCloudHandler({config: {origin, authUrl, readOnly}, ownerAccess: access, draftStore,
    store: {readSnapshot: async () => {calls.businessReads++; return {state: demoMonitor(new Date().toISOString()), revision: 1};}},
    verifyIdentity: createIdentityVerifier({authUrl, keySet: publicKey}), verifyOwner: createOwnerVerifier({authUrl, ownerUserId: ownerId, keySet: publicKey})});
  const request = (route, {method = "GET", body, token = jwt, match} = {}) => handler(new Request(origin + route, {method, headers: {
    ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body ? {"Content-Type": "application/json"} : {}), ...(match ? {"If-Match": match} : {})
  }, ...(body ? {body: JSON.stringify(body)} : {})}));
  return {request, calls, access};
}
test("all draft endpoints deny anonymous and wrong owner before any business access", async () => {
  const f = workspace();
  for (const token of ["", await sign("another-fixture")]) for (const [route, method] of [["/api/items", "GET"], ["/api/next-draft", "GET"], ["/api/export/drafts.csv", "GET"], ["/api/items/B000DEMO01/draft", "GET"], ["/api/items/B000DEMO01", "PATCH"], ["/api/asins", "POST"]]) {
    assert.equal((await f.request(route, {method, token, body: method === "GET" ? undefined : {}})).status, token ? 403 : 401);
  }
  assert.deepEqual(f.calls, {businessReads: 0, writes: 0});
});
test("enrollment requires both valid capability and signed identity, ignores body user ID", async () => {
  const f = workspace();
  assert.equal((await f.request("/api/owner/enroll", {method: "POST", token: "forged.token.value", body: {setupToken: capability, userId: ownerId}})).status, 401);
  assert.equal(await f.access.ownerUserId(), null);
  assert.equal((await f.request("/api/owner/enroll", {method: "POST", body: {setupToken: "b".repeat(64)}})).status, 403);
  assert.equal((await f.request("/api/owner/enroll", {method: "POST", body: {setupToken: capability, userId: "body-intruder"}})).status, 200);
  assert.equal(await f.access.ownerUserId(), ownerId);
  assert.equal(f.calls.businessReads, 0);
});
test("draft reads, save CAS, reload, read-only and external-action denials", async () => {
  const f = workspace();
  assert.equal((await f.request("/api/items")).status, 200);
  assert.equal((await f.request("/api/items/B000DEMO01", {method: "PATCH", body: {title: "Saved"}})).status, 428);
  assert.equal((await f.request("/api/items/B000DEMO01", {method: "PATCH", match: '"1"', body: {title: "Saved"}})).status, 200);
  assert.equal((await f.request("/api/items").then((r) => r.json())).items[0].title, "Saved");
  assert.equal((await f.request("/api/items/B000DEMO01", {method: "PATCH", match: '"1"', body: {title: "Stale"}})).status, 409);
  assert.equal((await workspace(true).request("/api/asins", {method: "POST", match: '"1"', body: {asins: "B000DEMO02"}})).status, 403);
  for (const route of ["/api/fetch-product-data", "/api/link-monitor/mail/test-registration", "/api/link-monitor/fba-check"]) assert.equal((await f.request(route, {method: "POST", body: {}})).status, 404);
});
test("draft additions deduplicate and manual edits reject identity and unsafe image changes", async () => {
  const drafts = [];
  await addDrafts(drafts, "B000DEMO02\nB000DEMO02", new Date().toISOString());
  assert.equal(drafts.length, 1);
  const before = structuredClone(drafts);
  for (const patch of [{asin: "B000DEMO03"}, {imageUrls: ["javascript:alert(1)"]}, {imageUrls: ["https://evil.example/photo.jpg"]}, {usedLowestPrice: -1}, {draftSavedAt: "forged"}]) assert.throws(() => patchDraft(drafts, "B000DEMO02", patch, new Date().toISOString()));
  assert.deepEqual(drafts, before);
  patchDraft(drafts, "B000DEMO02", {description: "Stand missing", usedLowestPrice: 1000}, new Date().toISOString());
  assert.equal(drafts[0].description, "Stand missing");
});
