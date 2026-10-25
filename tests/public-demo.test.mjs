import test from "node:test";
import assert from "node:assert/strict";
import {publicDemo} from "../src/public-demo.js";
import {createVercelEntry} from "../src/vercel-entry.js";

const origin = "https://inventory.example";
const env = {ASIN_PUBLIC_DEMO: "1", ASIN_PUBLIC_ORIGIN: origin};
const request = (data, options = {}) => new Request(origin + "/api/demo", data === undefined ? options : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data), ...options});
async function send(data) {const response = await publicDemo(request(data), env); assert.equal(response.status, 200, await response.clone().text()); return response.json();}

test("public sample is opt-in, origin-bound and never trusts a forwarded host", async () => {
  assert.equal((await publicDemo(request(), {})).status, 404);
  assert.equal((await publicDemo(request(), {...env, ASIN_PUBLIC_ORIGIN: "https://other.example"})).status, 403);
  for (const headers of [{Origin: "https://other.example"}, {"Sec-Fetch-Site": "cross-site"}]) assert.equal((await publicDemo(request(undefined, {headers}), env)).status, 403);
  assert.equal((await publicDemo(request(undefined, {headers: {"X-Forwarded-Host": "inventory.example"}}), {ASIN_PUBLIC_DEMO: "1"})).status, 403);
});

test("baseline returns only fictional data and redacts the configured real recipient", async () => {
  const view = await send();
  assert.equal(view.links.length, 1);
  assert.equal(view.catalog[0].asin, "B000DEMO01");
  assert.equal(view.storage.backend, "browser-demo");
  assert.equal(view.config.capabilities.publicDemo, true);
  assert.equal(view.config.notificationRuntime, false);
  assert.equal(view.links[0].assessment.fbaLabel, "5個（サンプル）");
  assert.equal(view.notificationSettings.recipient, "送信なし");
  assert.doesNotMatch(JSON.stringify(view), /tokyotojjjj|postgres:\/\/|ASIN_DATABASE_URL/);
});

test("memo edits are stateless and isolated from a different browser document", async () => {
  const first = await send();
  const updated = await send({action: "memo", state: first.demoDocument, revision: 0, linkId: first.links[0].id, memo: "スタンドなし"});
  assert.equal(updated.links[0].userMemo, "スタンドなし");
  assert.equal(updated.storage.revision, 1);
  assert.equal(first.demoDocument.links[0].userMemo, undefined);
  const reloaded = await send({action: "read", state: updated.demoDocument, revision: 1});
  assert.equal(reloaded.links[0].userMemo, "スタンドなし");
  assert.equal((await send()).links[0].userMemo, undefined);
});

test("sample registration reuses normal linkage rules and refuses real product identifiers", async () => {
  const first = await send();
  const pair = {action: "register", state: first.demoDocument, amazon: "B000DEMO02", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d1000000002"};
  const next = await send(pair);
  assert.equal(next.links.length, 2);
  assert.equal((await send({...pair, state: next.demoDocument})).links.length, 2);
  assert.equal((await publicDemo(request({...pair, amazon: "B0176E86U8"}), env)).status, 400);
  assert.equal((await publicDemo(request({...pair, yahoo: "https://auctions.yahoo.co.jp/jp/auction/c1245610698"}), env)).status, 400);
});

test("sample scenarios include duplicate suppression, unknown stock and ending confirmation without delivery", async () => {
  const zero = await send({action: "scenario", scenario: "zero"});
  const repeat = await send({action: "scenario", scenario: "repeat"});
  assert.equal(repeat.result.events.length, zero.result.events.length);
  assert.equal(repeat.scenario.at(-1).events, 0);
  const failed = await send({action: "scenario", scenario: "failed"});
  assert.equal(failed.result.links[0].assessment.inventory, "unknown");
  assert.equal(failed.result.links[0].assessment.fbaLabel, "確認できず（サンプル）");
  const ended = await send({action: "scenario", scenario: "ended"});
  assert.ok(ended.result.events.length > 0);
  assert.equal(ended.result.notificationSettings.mailEnabled, false);
  const mail = await send({action: "scenario", scenario: "mail_retry"});
  assert.equal(mail.result.config.notificationRuntime, false);
  assert.equal((await send()).events.length, 0);
});

test("sample endpoint rejects oversized, malformed, unsupported and non-sample documents", async () => {
  assert.equal((await publicDemo(request({action: "read"}, {headers: {"Content-Type": "text/plain"}}), env)).status, 415);
  assert.equal((await publicDemo(request({action: "read"}, {headers: {"Content-Type": "application/json", "Content-Length": "3000000"}}), env)).status, 413);
  assert.equal((await publicDemo(request(undefined, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{"}), env)).status, 400);
  assert.equal((await publicDemo(request({action: "mail/send"}), env)).status, 404);
  assert.equal((await publicDemo(request({action: "read", state: {version: 1}}), env)).status, 400);
  const first = await send();
  first.demoDocument.catalog[0].asin = "B0176E86U8";
  assert.equal((await publicDemo(request({action: "read", state: first.demoDocument}), env)).status, 400);
});

test("public sample handles trusted Vercel aliases but not request-selected origins", async () => {
  const vercel = {ASIN_PUBLIC_DEMO: "1", VERCEL: "1", VERCEL_URL: "sample-one.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "inventory.vercel.app"};
  for (const host of ["sample-one.vercel.app", "inventory.vercel.app"]) assert.equal((await publicDemo(new Request(`https://${host}/api/demo`), vercel)).status, 200);
  assert.equal((await publicDemo(new Request("https://evil.example/api/demo"), vercel)).status, 403);
});

test("Vercel sample path never creates a database runtime or relaxes the private API", async () => {
  let runtimes = 0;
  const entry = createVercelEntry({environment: () => env, runtimeFactory: async () => {runtimes++; throw new Error("secret fixture");}});
  const sample = await entry(new Request(origin + "/api/inventory?__route=/demo&path=demo"));
  assert.equal(sample.status, 200);
  assert.equal(runtimes, 0);
  const privateResponse = await entry(new Request(origin + "/api/link-monitor"));
  assert.equal(privateResponse.status, 503);
  assert.equal(runtimes, 1);
  assert.doesNotMatch(await privateResponse.text(), /secret fixture/);
});
