import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {spawnSync} from "node:child_process";
import {emptyMonitor} from "../src/link-monitor.js";
import {createJsonDocumentStore} from "../src/json-document-store.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {storageConfiguration} from "../src/storage-runtime.js";
import {prepareStorageImport, readStorageImport, payloadDigest, importStorageDocuments} from "../src/storage-migration.js";
import {validateMonitorState, validateDraftItems} from "../src/storage-validation.js";

const host = "ep-storage-test.c-1.ap-southeast-1.aws.neon.tech";
const env = {ASIN_STORAGE_BACKEND: "postgres", ASIN_DATABASE_URL: `postgresql://test:do-not-display@${host}/neondb?sslmode=require`, ASIN_DATABASE_EXPECTED_HOST: host};

test("cloud cutover keeps JSON readable but rejects writes before callbacks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inventory-cutover-"));
  const store = createJsonDocumentStore({directory, filename: "items.json", empty: () => [], validate: validateDraftItems});
  await store.update((state) => state.push({asin: "B000DEMO01"}));
  const original = await readFile(path.join(directory, "items.json"));
  await writeFile(path.join(directory, "cloud-cutover.json"), JSON.stringify({version: 1, origin: "https://amazon-yahoo-inventory.vercel.app", projectId: "prj_GSVAyWDoMTIJepaEbf3YrBplCByT"}));
  let called = false;
  await assert.rejects(store.update(() => {called = true;}), {code: "STORAGE_CLOUD_CUTOVER"});
  assert.equal(called, false); assert.equal((await store.read()).length, 1);
  assert.deepEqual(await readFile(path.join(directory, "items.json")), original);
  await writeFile(path.join(directory, "cloud-cutover.json"), "{}");
  await assert.rejects(store.update(() => {}), /切替情報/);
});

function fakePool(initial, {commitFailure = false} = {}) {
  let row = initial === null ? null : {payload: structuredClone(initial), revision: 0};
  const calls = [];
  return {calls, value: () => structuredClone(row), connect: async () => {
    let transactionRow;
    return {release() {calls.push("release");}, async query(sql, values) {
      calls.push(sql);
      if (sql === "BEGIN") transactionRow = structuredClone(row);
      if (sql.startsWith("SELECT payload")) return {rows: row ? [structuredClone(sql.includes("FOR UPDATE") ? transactionRow : row)] : []};
      if (sql.startsWith("UPDATE")) transactionRow = {payload: JSON.parse(values[1]), revision: transactionRow.revision + 1};
      if (sql === "COMMIT") {row = transactionRow; if (commitFailure) throw Object.assign(new Error("private connection detail"), {code: "ECONNRESET"});}
      return {rows: []};
    }};
  }};
}

test("DB storage is opt-in and never uses another tool's DATABASE_URL", () => {
  assert.deepEqual(storageConfiguration({DATABASE_URL: "not-this-tool"}), {backend: "json"});
  assert.throws(() => storageConfiguration({ASIN_STORAGE_BACKEND: "wrong"}), /json.*postgres/);
  assert.throws(() => storageConfiguration({ASIN_STORAGE_BACKEND: "postgres", DATABASE_URL: env.ASIN_DATABASE_URL}), /ASIN_DATABASE_URL/);
});

test("DB requires an explicit matching host and verified TLS without exposing credentials", () => {
  const options = storageConfiguration(env).poolOptions;
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(options.connectionString).searchParams.has("sslmode"), false);
  assert.throws(() => storageConfiguration({...env, ASIN_DATABASE_EXPECTED_HOST: "other.neon.tech"}), /一致しません/);
  assert.throws(() => storageConfiguration({...env, ASIN_DATABASE_URL: env.ASIN_DATABASE_URL.replace("require", "no-verify")}), /TLS/);
  assert.throws(() => storageConfiguration({...env, ASIN_DATABASE_URL: "private-invalid-value"}), (error) => !error.message.includes("private-invalid-value"));
});

test("JSON transactions serialize, survive reload, and roll back callback/validation failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asin-storage-json-"));
  const options = {directory, filename: "items.json", empty: () => [], validate: validateDraftItems};
  const store = createJsonDocumentStore(options);
  await Promise.all(Array.from({length: 12}, (_, i) => store.update((items) => items.push({asin: `TEST${i}`}))));
  const before = await readFile(path.join(directory, "items.json"), "utf8");
  await assert.rejects(store.update((items) => {items.length = 0; throw new Error("cancelled");}), /cancelled/);
  await assert.rejects(store.update((items) => items.push({})), /形式/);
  assert.equal(await readFile(path.join(directory, "items.json"), "utf8"), before);
  assert.equal((await createJsonDocumentStore(options).read()).length, 12);
});

test("malformed existing JSON is not replaced by empty data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asin-storage-broken-"));
  await writeFile(path.join(directory, "link-monitor.json"), "broken");
  const store = createJsonDocumentStore({directory, filename: "link-monitor.json", empty: emptyMonitor, validate: validateMonitorState});
  await assert.rejects(store.update((state) => state.logs.push({kind: "must-not-save"})));
  assert.equal(await readFile(path.join(directory, "link-monitor.json"), "utf8"), "broken");
});

test("draft upserts use the same atomic update across concurrent callers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asin-drafts-"));
  const script = `import {upsertItems,loadItems} from './src/store.js';
    await Promise.all(Array.from({length:15},(_,i)=>upsertItems([{asin:'TEST'+i,createdAt:'2026-10-25'}])));
    console.log((await loadItems()).length);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url), env: {...process.env, ASIN_STORAGE_BACKEND: "json", ASIN_DATA_DIR: directory}, encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "15");
});

test("Postgres uses one locked transaction and increments revision only on commit", async () => {
  const pool = fakePool({counter: 1});
  const validate = (state) => {assert.ok(state.counter >= 0); return state;};
  const store = createPostgresDocumentStore({pool, key: "test-document", validate});
  assert.equal(await store.update((state) => ++state.counter, {expectedRevision: 0}), 2);
  assert.deepEqual(await store.readSnapshot(), {state: {counter: 2}, revision: 1});
  assert.ok(pool.calls.some((sql) => sql.endsWith("FOR UPDATE")));
  await assert.rejects(store.update((state) => {state.counter = 99;}, {expectedRevision: 0}), {code: "STORAGE_CONFLICT"});
  await assert.rejects(store.update((state) => {state.counter = -1;}));
  await assert.rejects(store.update((state) => {state.counter = 100; throw new Error("cancelled");}), /cancelled/);
  assert.deepEqual((await store.readSnapshot()).state, {counter: 2});
  assert.equal(pool.calls.filter((sql) => sql === "ROLLBACK").length, 3);
});

test("a missing DB document or broken connection is never an empty fallback", async () => {
  await assert.rejects(createPostgresDocumentStore({pool: fakePool(null), key: "test-missing", validate: (x) => x}).read(), /未初期化/);
  const pool = {connect: async () => {throw Object.assign(new Error("private-password"), {code: "ECONNREFUSED"});}};
  await assert.rejects(createPostgresDocumentStore({pool, key: "test-failed", validate: (x) => x}).read(), (error) => error.code === "STORAGE_UNAVAILABLE" && !error.message.includes("private-password"));
});

test("lost COMMIT response is uncertain, not an automatic retry", async () => {
  const pool = fakePool({counter: 0}, {commitFailure: true});
  const store = createPostgresDocumentStore({pool, key: "test-commit", validate: (x) => x});
  let callbacks = 0;
  await assert.rejects(store.update((state) => {callbacks++; state.counter++;}), {code: "STORAGE_COMMIT_UNKNOWN"});
  assert.equal(callbacks, 1);
  assert.equal(pool.value().payload.counter, 1);
});

test("import preserves data, receipts and history while disabling only delivery switches", () => {
  const monitor = emptyMonitor();
  monitor.links.push({id: "kept-id", memo: "handwritten", successors: ["old-id"]});
  monitor.notificationSettings = {mailEnabled: true, monitoringEnabled: true};
  monitor.mailOutbox = [{id: "receipt", status: "uncertain"}];
  const before = structuredClone(monitor);
  const plan = prepareStorageImport({monitor, items: [{asin: "B000DEMO01", memo: "kept"}]});
  assert.deepEqual(monitor, before);
  assert.deepEqual(plan.documents[0].payload.links, before.links);
  assert.deepEqual(plan.documents[0].payload.mailOutbox, before.mailOutbox);
  assert.equal(plan.documents[0].payload.notificationSettings.mailEnabled, false);
  assert.equal(plan.summary.drafts, 1);
  assert.equal(payloadDigest({a: 1, b: 2}), payloadDigest({b: 2, a: 1}));
  assert.notEqual(payloadDigest([1, 2]), payloadDigest([2, 1]));
});

test("import checks content digest and never touches credentials or legacy JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asin-import-"));
  await writeFile(path.join(directory, "link-monitor.json"), JSON.stringify(emptyMonitor()));
  await writeFile(path.join(directory, "items.json"), "[]");
  await writeFile(path.join(directory, "stock-watch.json"), "broken legacy data");
  const plan = await readStorageImport(directory);
  assert.equal(plan.documents.length, 2);
  plan.documents[1].payload.push({asin: "FORGED"});
  await assert.rejects(importStorageDocuments({connect: () => {throw new Error("must-not-connect");}}, plan), /識別情報/);
  assert.equal(await readFile(path.join(directory, "stock-watch.json"), "utf8"), "broken legacy data");
});

test("an import receipt without its documents is corruption, not a successful re-import", async () => {
  const plan = prepareStorageImport({monitor: emptyMonitor(), items: []});
  const pool = {connect: async () => ({release() {}, query: async (sql) => ({rows: sql.includes("FROM app_storage.imports")
    ? [{import_id: plan.importId, source_digest: plan.sourceDigest, document_count: 2}] : []})})};
  await assert.rejects(importStorageDocuments(pool, plan), /一致しません/);
});
