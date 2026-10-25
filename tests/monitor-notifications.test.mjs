import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {emptyMonitor, registerPageLink, notificationText} from "../src/link-monitor.js";
import {createMonitorStore} from "../src/link-monitor-store.js";
import {queueRegistration, queueMonitorResults, observeTrackedListing, createNotificationService} from "../src/monitor-notifications.js";

const at = "2026-10-21T08:00:00.000Z";
const input = {amazon: "B000DEMO01", yahoo: "https://auctions.yahoo.co.jp/jp/auction/d1000000001", submitted: true};
function fixture() {
  const state = emptyMonitor();
  state.notificationSettings = {mailEnabled: true, monitoringEnabled: false};
  const link = registerPageLink(state, input, at);
  const row = {asin: link.asin, sellerSku: "OWN", title: "商品", fulfillableQuantity: 5, checkedAt: at, source: "amazon_sp_api"};
  state.amazonInventory = {status: "complete", complete: true, scope: "linked_asins_only", asins: [link.asin], items: [row], startedAt: at, checkedAt: at};
  observeTrackedListing(state, link.id, {...state.listings[0], references: [{kind: "asin", value: link.asin}], observation: {status: "active", verified: true, checkedAt: at}});
  return {state, link, row};
}
test("new registration queues once and never backfills old registrations when enabling mail", async () => {
  const store = createMonitorStore(await mkdtemp(path.join(os.tmpdir(), "asin-mail-")));
  const linkId = await store.update((state) => registerPageLink(state, input, at).id);
  let sends = 0;
  const service = createNotificationService({store, transport: {available: async () => true, send: async () => {sends++; return {status: "smtp_accepted"};}}, now: () => at});
  await service.configure({mailEnabled: true, monitoringEnabled: false});
  await service.drain();
  assert.equal(sends, 0);
  await store.update((state) => {queueRegistration(state, [linkId], at); queueRegistration(state, [linkId], at);});
  await Promise.all([service.drain(), service.drain()]);
  assert.equal(sends, 1);
  let state = await store.read();
  assert.equal(state.mailOutbox.length, 1);
  assert.equal(state.mailOutbox[0].status, "smtp_accepted");
  assert.match(state.mailOutbox[0].text, /B000DEMO01/);
  assert.match(state.mailOutbox[0].text, /d1000000001/);
  const restarted = createNotificationService({store, transport: {send: async () => {sends++;}}, now: () => at});
  await restarted.drain();
  assert.equal(sends, 1);
});
test("one explicit registration-mail test uses an existing pair without editing it or duplicating the test", () => {
  const {state, link} = fixture();
  const before = structuredClone(state.links);
  queueRegistration(state, [link.id], at, {testOnly: true});
  queueRegistration(state, [link.id], at, {testOnly: true});
  assert.equal(state.mailOutbox.length, 1);
  assert.equal(state.mailOutbox[0].kind, "registration_test");
  assert.match(state.mailOutbox[0].text, /登録内容は変更していません/);
  assert.deepEqual(state.links, before);
});
test("failed sends retry with a fresh attempt ID; uncertain sends never retry automatically", async () => {
  const store = createMonitorStore(await mkdtemp(path.join(os.tmpdir(), "asin-mail-retry-")));
  await store.update((state) => {state.notificationSettings = {mailEnabled: true}; queueRegistration(state, [registerPageLink(state, input, at).id], at);});
  const ids = [];
  let clock = at;
  const service = createNotificationService({store, transport: {send: async (message) => {ids.push(message.id); return {status: ids.length === 1 ? "failed" : "smtp_accepted"};}}, now: () => clock});
  await service.drain();
  await service.drain();
  assert.equal(ids.length, 1);
  clock = "2026-10-21T08:06:00.000Z";
  await service.drain();
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal((await store.read()).mailOutbox[0].status, "smtp_accepted");
  await store.update((state) => {state.mailOutbox[0].status = "pending"; state.mailOutbox[0].attempts = 0;});
  let uncertainCalls = 0;
  const uncertain = createNotificationService({store, transport: {send: async () => {uncertainCalls++; return {status: "uncertain"};}}, now: () => clock});
  await uncertain.drain(); await uncertain.drain();
  assert.equal(uncertainCalls, 1);
  await assert.rejects(uncertain.retry((await store.read()).mailOutbox[0].id), /結果不明/);
});
test("restart reconciles accepted receipts and holds interrupted or missing receipts", async () => {
  for (const receipt of ["smtp_accepted", "attempting", null]) {
    const store = createMonitorStore(await mkdtemp(path.join(os.tmpdir(), "asin-mail-recover-")));
    await store.update((state) => {state.notificationSettings = {mailEnabled: true}; queueRegistration(state, [registerPageLink(state, input, at).id], at); state.mailOutbox[0].status = "sending"; state.mailOutbox[0].attemptId = "dummy";});
    let calls = 0;
    const service = createNotificationService({store, transport: {receipt: async () => receipt, send: async () => {calls++;}}, now: () => at});
    await service.recover(); await service.drain();
    assert.equal((await store.read()).mailOutbox[0].status, receipt === "smtp_accepted" ? "smtp_accepted" : "uncertain");
    assert.equal(calls, 0);
  }
});
test("unlinked pending mail is cancelled; stopping mail prevents new deliveries", async () => {
  const store = createMonitorStore(await mkdtemp(path.join(os.tmpdir(), "asin-mail-unlink-")));
  await store.update((state) => {state.notificationSettings = {mailEnabled: true}; queueRegistration(state, [registerPageLink(state, input, at).id], at); state.links = [];});
  let calls = 0;
  const service = createNotificationService({store, transport: {send: async () => {calls++;}}, now: () => at});
  await service.drain();
  assert.equal((await store.read()).mailOutbox[0].status, "cancelled");
  assert.equal(calls, 0);
});
test("raw FBA positive/zero/recovery/zero alerts are distinct from confirmed MCF stockouts", () => {
  const {state, row} = fixture();
  assert.equal(queueMonitorResults(state, at).length, 0);
  row.fulfillableQuantity = 0;
  let events = queueMonitorResults(state, at);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "inventory_observed_zero");
  assert.match(notificationText(events[0], {preview: false}), /確定ではありません/);
  assert.equal(events[0].assessment.inventory, "unknown");
  assert.equal(queueMonitorResults(state, at).length, 0);
  row.fulfillableQuantity = 4;
  assert.equal(queueMonitorResults(state, at)[0].kind, "inventory_observed_recovered");
  row.fulfillableQuantity = 0;
  assert.equal(queueMonitorResults(state, at)[0].kind, "inventory_observed_zero");
  assert.equal(state.mailOutbox.length, 3);
  assert.ok(state.mailOutbox.every((mail) => !mail.text.includes("この通知はプレビュー")));
});
test("fetch failures notify independently of permanent unknown MCF eligibility and can recover", () => {
  const {state} = fixture();
  queueMonitorResults(state, at);
  state.amazonInventory.status = "failed";
  state.amazonInventory.complete = false;
  let events = queueMonitorResults(state, at);
  assert.deepEqual(events.map((item) => item.kind), ["inventory_unknown"]);
  assert.equal(queueMonitorResults(state, at).length, 0);
  state.amazonInventory.status = "complete";
  state.amazonInventory.complete = true;
  events = queueMonitorResults(state, at);
  assert.deepEqual(events.map((item) => item.kind), ["inventory_restored"]);
});
test("actual ending needs two observations; new references do not silently rewrite reviewed identity", () => {
  const {state, link} = fixture();
  queueMonitorResults(state, at);
  const listing = state.listings[0];
  const observe = (seconds, status) => observeTrackedListing(state, link.id, {...listing, references: [{kind: "asin", value: link.asin}], observation: {status, verified: status !== "unknown", checkedAt: new Date(Date.parse(at) + seconds * 1000).toISOString()}});
  observe(1, "ended");
  assert.equal(queueMonitorResults(state, "2026-10-21T08:00:01.000Z").length, 0);
  observe(2, "ended");
  assert.equal(queueMonitorResults(state, "2026-10-21T08:00:02.000Z")[0].kind, "yahoo_ended");
  assert.deepEqual(listing.references, []);
  observeTrackedListing(state, link.id, {...listing, references: [{kind: "asin", value: "B000OTHER1"}]});
  assert.equal(link.observationConflict, false);
  observeTrackedListing(state, link.id, {...listing, references: [{kind: "asin", value: "B000OTHER1"}], observation: {status: "active", verified: true, checkedAt: "2026-10-21T08:00:03.000Z"}});
  assert.equal(queueMonitorResults(state, "2026-10-21T08:00:03.000Z")[0].kind, "link_review");
});
test("monitoring is opt-in and only checks registered products when due", async () => {
  const store = createMonitorStore(await mkdtemp(path.join(os.tmpdir(), "asin-mail-tick-")));
  let clock = at, fbaCalls = 0, yahooCalls = 0;
  await store.update((state) => Object.assign(state, fixture().state));
  const service = createNotificationService({store, transport: {available: async () => true, send: async () => ({status: "smtp_accepted"})},
    fbaJob: {start: async () => {fbaCalls++;}, wait: async () => ({status: "complete"})},
    fetchListing: async () => {yahooCalls++; return (await store.read()).listings[0];}, now: () => clock});
  await service.tick(); assert.equal(fbaCalls, 0);
  await service.configure({mailEnabled: true, monitoringEnabled: true});
  await service.tick(); assert.equal(fbaCalls, 0);
  clock = "2026-10-21T08:31:00.000Z";
  await service.tick();
  assert.equal(fbaCalls, 1); assert.equal(yahooCalls, 1);
  await service.configure({mailEnabled: false, monitoringEnabled: false});
  clock = "2026-10-21T10:00:00.000Z";
  await service.tick(); assert.equal(fbaCalls, 1);
});
