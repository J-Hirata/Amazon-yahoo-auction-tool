import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {request as httpRequest} from "node:http";
import {fileURLToPath} from "node:url";
import {Pool} from "pg";
import {emptyMonitor} from "../src/link-monitor.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {prepareStorageImport, migrateStorageSchema, importStorageDocuments} from "../src/storage-migration.js";
import {storageConfiguration} from "../src/storage-runtime.js";
import {createCloudHandler} from "../src/cloud-handler.js";
import {createOwnerVerifier} from "../src/cloud-auth.js";
import {demoMonitor} from "../src/link-monitor-demo.js";
import {validateMonitorState} from "../src/storage-validation.js";
import {generateKeyPair, SignJWT} from "jose";

const config = storageConfiguration();
if (config.backend !== "postgres" || config.environment !== "development" || process.env.ASIN_RUN_DATABASE_TESTS !== "1") {
  throw new Error("明示した開発用DBとASIN_RUN_DATABASE_TESTS=1が必要です。本番データには実行しません");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const pool = new Pool(config.poolOptions);
const testKey = `test-storage-${randomUUID()}`;
const cloudKey = `test-cloud-${randomUUID()}`;
let server, checks = 0;
const passed = (name) => {checks++; console.log(`PASS ${name}`);};

async function startServer() {
  const child = spawn(process.execPath, ["src/server.js"], {cwd: root, windowsHide: true,
    env: {...process.env, PORT: "0", ASIN_BIND_HOST: "127.0.0.1", ASIN_DISABLE_BACKGROUND: "1"}, stdio: ["ignore", "pipe", "pipe"]});
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(new Error("検証用サーバー起動がタイムアウトしました"));}, 20000);
    child.once("error", () => {clearTimeout(timer); reject(new Error("検証用サーバーを起動できません"));});
    child.once("exit", () => {clearTimeout(timer); reject(new Error("検証用サーバーが終了しました"));});
    child.stderr.on("data", () => {});
    child.stdout.on("data", (data) => {
      const match = String(data).match(/ASIN draft tool: http:\/\/localhost:(\d+)/);
      if (match) {clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`);}
    });
  });
  return {child, address};
}
async function stopServer() {
  if (!server) return;
  const child = server.child;
  server = null;
  if (child.exitCode === null && child.signalCode === null) {child.kill(); await once(child, "exit");}
}
async function request(route, method = "GET", body, status = 200, extraHeaders = {}) {
  const response = await fetch(`${server.address}${route}`, {method, headers: {"Content-Type": "application/json", ...extraHeaders},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)});
  assert.equal(response.status, status);
  return response.json();
}

try {
  const first = await migrateStorageSchema(pool);
  assert.deepEqual(await migrateStorageSchema(pool), first);
  passed("versioned schema migration is repeatable");

  const fixtureItems = [{asin: "B000DEMO01", title: "Development fixture only", createdAt: "2026-10-25T00:00:00Z"}];
  const plan = prepareStorageImport({monitor: emptyMonitor(), items: fixtureItems});
  await importStorageDocuments(pool, plan);
  assert.equal((await importStorageDocuments(pool, plan)).status, "already_imported");
  passed("fixture import is idempotent and never backfills email");
  const other = prepareStorageImport({monitor: emptyMonitor(), items: [{...fixtureItems[0], title: "different source"}]});
  await assert.rejects(importStorageDocuments(pool, other), /上書き/);
  passed("different import refuses a nonempty destination");

  await pool.query("INSERT INTO app_storage.documents(document_key, payload) VALUES ($1, $2::jsonb)", [testKey, JSON.stringify({counter: 0, marks: []})]);
  const validate = (value) => {assert.ok(Number.isInteger(value.counter) && value.counter >= 0); return value;};
  const one = createPostgresDocumentStore({pool, key: testKey, validate});
  const two = createPostgresDocumentStore({pool, key: testKey, validate});
  await Promise.all(Array.from({length: 15}, (_, i) => (i % 2 ? one : two).update((value) => {value.counter++; value.marks.push(i);})));
  const concurrent = await one.readSnapshot();
  assert.equal(concurrent.state.counter, 15);
  assert.equal(new Set(concurrent.state.marks).size, 15);
  passed("two independent stores preserve 15 concurrent updates");
  await one.update((value) => {value.counter++;});
  await assert.rejects(two.update((value) => {value.counter = 999;}, {expectedRevision: concurrent.revision}), {code: "STORAGE_CONFLICT"});
  assert.equal((await one.read()).counter, 16);
  passed("stale revisions cannot overwrite current data");
  await assert.rejects(one.update((value) => {value.counter = 999; throw new Error("rollback fixture");}), /rollback fixture/);
  await assert.rejects(one.update((value) => {value.counter = -1;}));
  assert.equal((await one.read()).counter, 16);
  passed("callback and validation failures roll back on real Postgres");

  server = await startServer();
  const initial = await request("/api/link-monitor");
  assert.equal(initial.storage.backend, "postgres");
  assert.equal(initial.config.notificationRuntime, false);
  assert.equal(initial.notificationSettings.mailEnabled, false);
  passed("existing monitor API reads from Neon with delivery disabled");
  const pair = {amazon: "B000DEMO01", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d9999999001", submitted: true};
  const secondPair = {amazon: "B000DEMO02", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d9999999002", submitted: true};
  await Promise.all([request("/api/link-monitor/page-links", "POST", pair), request("/api/link-monitor/page-links", "POST", secondPair)]);
  const registered = await request("/api/link-monitor");
  assert.equal(registered.links.filter((link) => ["B000DEMO01", "B000DEMO02"].includes(link.asin)).length, 2);
  await request("/api/link-monitor/page-links", "POST", pair);
  assert.equal((await request("/api/link-monitor")).links.length, registered.links.length);
  passed("existing registration API persists concurrent pairs without duplicates");
  await request("/api/items/B000DEMO01", "PATCH", {memo: "Neon restart fixture"});
  assert.equal((await request("/api/items")).items.find((item) => item.asin === "B000DEMO01").memo, "Neon restart fixture");
  passed("existing draft API saves into the same database");
  await request("/api/link-monitor/notification-settings", "POST", {mailEnabled: true, monitoringEnabled: true}, 409);
  await request("/api/link-monitor/mail/test-registration", "POST", {}, 409);
  await request("/api/link-monitor/check-and-notify", "POST", {}, 409);
  passed("DB trial mode rejects all live email and scheduler activation");
  await request("/api/items/B000DEMO01", "PATCH", {memo: "must not save"}, 403, {Origin: "https://untrusted.example"});
  passed("DB trial API rejects cross-origin writes");
  const hostStatus = await new Promise((resolve, reject) => {
    const probe = httpRequest(`${server.address}/api/items`, {headers: {Host: "untrusted.example"}}, (response) => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    probe.once("error", reject); probe.end();
  });
  assert.equal(hostStatus, 403);
  passed("DB trial API rejects untrusted Host headers");
  await stopServer();
  server = await startServer();
  assert.equal((await request("/api/link-monitor")).links.length, registered.links.length);
  assert.equal((await request("/api/items")).items.find((item) => item.asin === "B000DEMO01").memo, "Neon restart fixture");
  passed("fresh server process reloads links and draft edits from Neon");

  const authUrl = "https://fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth";
  const ownerUserId = "database-cloud-fixture";
  const {privateKey, publicKey} = await generateKeyPair("EdDSA");
  const token = await new SignJWT({}).setProtectedHeader({alg: "EdDSA"}).setSubject(ownerUserId).setIssuer(new URL(authUrl).origin).setIssuedAt().setExpirationTime("15m").sign(privateKey);
  const cloudState = demoMonitor(new Date().toISOString());
  await pool.query("INSERT INTO app_storage.documents(document_key, payload) VALUES ($1, $2::jsonb)", [cloudKey, JSON.stringify(cloudState)]);
  const cloudStore = createPostgresDocumentStore({pool, key: cloudKey, validate: validateMonitorState});
  const cloud = () => createCloudHandler({config: {origin: "https://inventory.example", authUrl, ownerUserId, readOnly: false}, store: cloudStore,
    verifyOwner: createOwnerVerifier({authUrl, ownerUserId, keySet: publicKey})});
  const cloudRequest = (handler, route, method = "GET", body, revision, bearer = token) => handler(new Request("https://inventory.example" + route, {method,
    headers: {Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(revision !== undefined ? {"If-Match": `"${revision}"`} : {})},
    ...(body ? {body: JSON.stringify(body)} : {})}));
  assert.equal((await cloudRequest(cloud(), "/api/link-monitor", "GET", undefined, undefined, "invalid")).status, 401);
  const cloudInitial = await cloudRequest(cloud(), "/api/link-monitor");
  assert.equal(cloudInitial.status, 200);
  const cloudData = await cloudInitial.json();
  passed("owner-verified cloud handler reads isolated real Neon fixture");
  const memoRoute = `/api/link-monitor/links/${cloudState.links[0].id}/memo`;
  const savedMemo = await cloudRequest(cloud(), memoRoute, "POST", {memo: "Cloud Neon fixture memo"}, cloudData.storage.revision);
  assert.equal(savedMemo.status, 200);
  assert.equal((await savedMemo.json()).links[0].userMemo, "Cloud Neon fixture memo");
  const reloaded = await cloudRequest(cloud(), "/api/link-monitor");
  assert.equal((await reloaded.json()).links[0].userMemo, "Cloud Neon fixture memo");
  passed("cloud memo persists through independent handler instances");
  assert.equal((await cloudRequest(cloud(), memoRoute, "POST", {memo: "must not overwrite"}, cloudData.storage.revision)).status, 409);
  assert.equal((await cloudStore.read()).links[0].userMemo, "Cloud Neon fixture memo");
  assert.equal((await cloudStore.read()).mailOutbox?.length || 0, 0);
  passed("cloud stale saves cannot overwrite or enqueue email on real Neon");
  console.log(JSON.stringify({passed: checks, backend: "postgres", realBusinessDataImported: false, emailsSent: 0}));
} catch (error) {
  console.error(JSON.stringify({passed: checks, failed: true, code: error.code || error.name || "VERIFY_FAILED",
    ...(typeof error.actual === "number" ? {actual: error.actual, expected: error.expected} : {})}));
  process.exitCode = 1;
} finally {
  await stopServer();
  await pool.query("DELETE FROM app_storage.documents WHERE document_key = $1", [testKey]).catch(() => {});
  await pool.query("DELETE FROM app_storage.documents WHERE document_key = $1", [cloudKey]).catch(() => {});
  await pool.end();
}
