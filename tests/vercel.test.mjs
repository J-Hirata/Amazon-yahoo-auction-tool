import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {vercelCloudEnvironment, createVercelEntry, vercelCloudRequest} from "../src/vercel-entry.js";
import {createCloudHandler} from "../src/cloud-handler.js";
import {demoMonitor} from "../src/link-monitor-demo.js";
import ignore from "ignore";

test("only the two named CSV download routes may contain an extension in Vercel rewrites", () => {
  for (const route of ["export/drafts.csv", "physical-stock/export.csv"]) {
    const r = vercelCloudRequest(new Request("https://fixture.example/api/inventory?__route=/" + route)); assert.equal(new URL(r.url).pathname, "/api/" + route);
  }
  for (const route of ["physical-stock/other.csv", "physical-stock/export.json", "physical-stock/a.b", "physical-stock/%2e%2e/export.csv", "physical-stock/export.csv/extra"]) assert.equal(vercelCloudRequest(new Request("https://fixture.example/api/inventory?__route=/" + route)), null);
});

test("Vercel uses only a trusted server-side preview origin, not production or arbitrary hosts", () => {
  const preview = {VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "inventory-preview-one.vercel.app"};
  assert.equal(vercelCloudEnvironment(preview).ASIN_PUBLIC_ORIGIN, "https://inventory-preview-one.vercel.app");
  assert.equal(vercelCloudEnvironment({...preview, ASIN_PUBLIC_ORIGIN: "https://inventory.example"}).ASIN_PUBLIC_ORIGIN, "https://inventory.example");
  for (const changes of [{VERCEL: "0"}, {VERCEL_ENV: "production"}, {VERCEL_URL: "evil.example"}, {VERCEL_URL: "inventory.vercel.app.evil.example"}, {VERCEL_URL: "inventory.vercel.app/path"}, {VERCEL_URL: "user@inventory.vercel.app"}]) {
    assert.equal(vercelCloudEnvironment({...preview, ...changes}).ASIN_PUBLIC_ORIGIN, undefined);
  }
});
test("Vercel entry retains the original URL, JSON body, authorization and revision headers", async () => {
  let observed;
  const entry = createVercelEntry({runtimeFactory: async (options) => ({handler: async (request) => {
    observed = {url: request.url, authorization: request.headers.get("authorization"), revision: request.headers.get("if-match"), body: await request.json(), options};
    return Response.json({ok: true});
  }}), environment: () => ({ASIN_PUBLIC_ORIGIN: "https://inventory.example"})});
  const response = await entry(new Request("https://inventory.example/api/link-monitor/links/id/memo", {method: "POST", headers: {Authorization: "Bearer fixture", "If-Match": '"4"', "Content-Type": "application/json"}, body: JSON.stringify({memo: "stand missing"})}));
  assert.equal(response.status, 200);
  assert.equal(observed.url, "https://inventory.example/api/link-monitor/links/id/memo");
  assert.equal(observed.authorization, "Bearer fixture");
  assert.equal(observed.revision, '"4"');
  assert.equal(observed.body.memo, "stand missing");
  assert.equal(observed.options.env.ASIN_PUBLIC_ORIGIN, "https://inventory.example");
  assert.match(observed.options.assetDirectory, /dist[\\/]cloud$/);
});
test("one Vercel runtime and pool attachment are reused across concurrent requests", async () => {
  let creates = 0, attachments = 0;
  const pool = {};
  const entry = createVercelEntry({runtimeFactory: async () => {creates++; return {pool, handler: async () => Response.json({ok: true})};},
    attachPool: (value) => {assert.equal(value, pool); attachments++;}});
  const responses = await Promise.all(Array.from({length: 5}, () => entry(new Request("https://inventory.example/api/session"))));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(creates, 1);
  assert.equal(attachments, 1);
});
test("failed Vercel initialization returns no secrets and can recover without empty-data fallback", async () => {
  let attempt = 0;
  const entry = createVercelEntry({runtimeFactory: async () => {
    if (++attempt === 1) throw new Error("postgres://secret:password@private.example/db");
    return {handler: async () => Response.json({ready: true})};
  }});
  const failed = await entry(new Request("https://inventory.example/api/link-monitor"));
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /password|private\.example|postgres:/);
  assert.equal((await entry(new Request("https://inventory.example/api/link-monitor"))).status, 200);
});
test("Vercel deployment has one daily authenticated sales job and retains canonical routing", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.outputDirectory, "dist/cloud");
  assert.equal(config.framework, null);
  assert.deepEqual(config.regions, ["sin1"]);
  assert.deepEqual(config.crons,[{path:"/api/cron/sales",schedule:"0 0 * * *"}]);
  assert.deepEqual(config.rewrites, [{source: "/api/:path*", destination: "/api/inventory?__route=/:path*"}]);
  assert.equal(config.functions["api/**/*.js"].includeFiles, "dist/cloud/**");
});
test("Vercel entry enforces the same private monitor boundary", async () => {
  let reads = 0;
  const entry = createVercelEntry({environment: () => ({ASIN_PUBLIC_ORIGIN: "https://inventory.example"}), runtimeFactory: async () => ({handler: createCloudHandler({
    config: {origin: "https://inventory.example", authUrl: "https://fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth", ownerUserId: "fixture-owner", readOnly: true},
    store: {readSnapshot: async () => {reads++; return {state: demoMonitor(new Date().toISOString()), revision: 0};}},
    verifyOwner: async (request) => ({status: request.headers.get("authorization") === "Bearer fixture-owner" ? 200 : 401, userId: "fixture-owner"})
  })})});
  assert.equal((await entry(new Request("https://inventory.example/api/link-monitor"))).status, 401);
  assert.equal(reads, 0);
  const response = await entry(new Request("https://inventory.example/api/link-monitor", {headers: {Authorization: "Bearer fixture-owner"}}));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.capabilities.readOnly, true);
  assert.equal(reads, 1);
});
test("actual Vercel function export fails closed with no owner configuration", async () => {
  const {default: entry} = await import("../api/inventory.js");
  const before = process.env.ASIN_OWNER_USER_ID;
  delete process.env.ASIN_OWNER_USER_ID;
  try {
    const response = await entry.fetch(new Request("https://inventory.example/api/link-monitor"));
    assert.equal(response.status, 503);
  } finally {if (before !== undefined) process.env.ASIN_OWNER_USER_ID = before;}
});
test("upload allowlist includes parent directories and excludes business data, secrets and unconnected local helpers", async () => {
  const rules = ignore().add(await readFile(new URL("../.vercelignore", import.meta.url), "utf8"));
  for (const file of ["api", "api/inventory.js", "src", "src/vercel-entry.js", "public", "public/cloud-login.js", "scripts", "scripts/build-cloud.mjs", "scripts/build-extension.mjs", "chrome-extension", "chrome-extension/manifest.json", "chrome-extension/background.js", "public/yahoo-fill.js", "public/extension-helper.html", "public/fba-status.js", "package.json", "package-lock.json", "vercel.json"]) {
    assert.equal(rules.ignores(file), false, file);
  }
  for (const file of [".env.neon-dev", "data/link-monitor.json", "data/items.json", "data/gmail-credential.xml", "output/cloud-monitor-mobile.png", "test-output/report.json", "tests/cloud.test.mjs", "public/amazon-capture.js", "scripts/setup-gmail.ps1", "docs/status.md", ".vercel/.env.preview.local", "node_modules/pg/package.json", "dist/cloud/index.html", "netlify/functions/inventory.mjs", "unknown-new-file.json"]) {
    assert.equal(rules.ignores(file), true, file);
  }
});
test("internal Vercel rewrites preserve nested paths and reject injected routes or query parameters", async () => {
  const request = new Request("https://inventory.example/api/inventory?__route=%2Flink-monitor/links/fixture-id/memo&path=link-monitor/links/fixture-id/memo", {method: "POST", headers: {Authorization: "Bearer fixture", "Content-Type": "application/json"}, body: JSON.stringify({memo: "test"})});
  const canonical = vercelCloudRequest(request);
  assert.equal(canonical.url, "https://inventory.example/api/link-monitor/links/fixture-id/memo");
  assert.equal(canonical.headers.get("authorization"), "Bearer fixture");
  assert.equal((await canonical.json()).memo, "test");
  for (const path of ["/api/inventory?__route=../data", "/api/inventory?__route=https://evil.example", "/api/inventory?__route=link-monitor&extra=1", "/api/inventory?__route=link-monitor&__route=session", "/api/inventory?__route=link-monitor&path=session", "/api/unrelated?__route=link-monitor"]) {
    assert.equal(vercelCloudRequest(new Request("https://inventory.example" + path)), null);
  }
});
