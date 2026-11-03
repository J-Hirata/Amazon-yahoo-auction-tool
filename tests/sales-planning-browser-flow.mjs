import assert from "node:assert/strict";
import path from "node:path";

export async function verifyPlanningUI({page,planningStore,stockStore,monitorStore,draftStore,root,pass}){
  const before=await Promise.all([stockStore,monitorStore,draftStore].map(async s=>JSON.stringify(await s.read())));
  const nav=()=>page.locator(".cloud-account nav"),form=page.locator("#planningForm"),rows=page.locator("#planningRows tr[data-plan-id]");
  const date=offset=>new Date(Date.now()+offset*86400000).toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
  const save=async()=>{await page.locator("#planningSave").click();await page.locator("#planningDialog").waitFor({state:"hidden"});};
  await nav().getByText("販売の監視・見直し",{exact:true}).click();await page.locator("#cloudApp:not([hidden]) #planningCount").waitFor();
  assert.equal(await rows.count(),0);assert.equal(await page.locator("#loginPanel").isVisible(),false);
  await page.locator("#planningNew").click();
  await form.locator('#planningSources summary').click();const source=form.locator('[data-plan-source^="stock:"]').first();assert.ok(await source.count());
  await source.click();assert.equal(await form.locator('[name="asin"]').evaluate(el=>el.readOnly),true);
  await form.locator('[name="kind"]').selectOption('amazon');await form.locator('[name="availableOn"]').fill(date(-20));await form.locator('[name="salesMemo"]').fill("確認した20日間で2個。手入力メモ。");
  await save();assert.match(await rows.first().textContent(),/見直し時期/);assert.match(await rows.first().textContent(),/コンテナ/);
  await page.reload();await rows.first().waitFor();assert.equal((await planningStore.read()).plans.length,1);assert.equal((await planningStore.read()).plans[0].durationDays,14);
  pass("sales-planning page saves an explicit stock reference and actual availability date without copying quantities; reload preserves the due review");

  await page.locator("#planningNew").click();await form.locator('[name="title"]').fill("まだ納品前の様子見商品");await form.locator('[name="asin"]').fill("B000PLAN01");await save();
  assert.equal((await planningStore.read()).plans[1].availableOn,"");
  await page.locator('[data-plan-filter="waiting"]').click();assert.equal(await rows.count(),1);assert.match(await rows.textContent(),/販売・広告開始待ち/);
  await page.locator('[data-plan-filter="all"]').click();
  await page.locator("#planningNew").click();await form.locator('[name="title"]').fill("広告を2週間確認する商品");await form.locator('[name="kind"]').selectOption("advertising");await form.locator('[name="availableOn"]').fill(date(-10));await form.locator('[name="adStartedOn"]').fill(date(-3));await save();
  assert.equal((await planningStore.read()).plans[2].adStartedOn,date(-3));assert.match(await page.locator("#planningRows").textContent(),/広告テスト中/);
  const firstId=(await planningStore.read()).plans[0].id;
  await page.locator(`[data-plan-edit="${firstId}"]`).click();await form.locator('[name="decisions"][value="yahoo"]').check();await form.locator('[name="note"]').fill("売れ行きを見てヤフオク併売を検討。まだ出品しない。");await save();
  await page.locator(`[data-plan-details="${firstId}"]`).click();await page.locator(`[data-plan-history="${firstId}"]`).click();assert.match(await page.locator("#planningHistoryRows").textContent(),/方針未定 → ヤフオク併売を検討/);await page.locator("#planningHistoryClose").click();
  pass("pre-delivery plans never start from registration; separate ad start, adjustable period, decision history and due/waiting filters work without executing ads or listings");

  let dropped=false;await page.route("**/api/sales-planning/operations",async route=>{if(route.request().method()==="POST"&&!dropped){dropped=true;await route.fetch();await route.abort("failed");}else await route.continue();});
  await page.locator("#planningNew").click();await form.locator('[name="title"]').fill("保留して来週確認する商品");await form.locator('[name="status"]').selectOption("hold");await form.locator('[name="reviewOn"]').fill(date(7));await page.locator("#planningSave").click();await page.locator("#planningPending:not([hidden])").waitFor();
  await page.reload();await page.locator("#planningPending:not([hidden])").waitFor();await page.locator("#planningReconcile").click();await page.locator("#planningPending").waitFor({state:"hidden"});
  assert.equal((await planningStore.read()).plans.length,4);assert.equal((await planningStore.read()).events.length,5);await page.unroute("**/api/sales-planning/operations");
  await page.setViewportSize({width:1440,height:1080});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(root,"output","sales-planning-desktop.png")});
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await page.locator("#planningNew").click();assert.equal(await form.evaluate(el=>el.scrollWidth<=el.clientWidth),true);await form.getByRole("button",{name:"取消",exact:true}).click();if(width===390){await page.evaluate(()=>document.querySelector(".planning-tabs").scrollIntoView({block:"start"}));await page.screenshot({path:path.join(root,"output","sales-planning-mobile.png")});}}
  pass("lost planning-save response reconciles after reload without duplicate plans; desktop/390px/320px and mobile form fit");
  assert.deepEqual(await Promise.all([stockStore,monitorStore,draftStore].map(async s=>JSON.stringify(await s.read()))),before);
  await page.setViewportSize({width:1440,height:1080});await nav().getByText("コンテナ・自社在庫",{exact:true}).click();await page.locator("#stockRows").waitFor();
  pass("all physical quantities, linkage records, drafts and notification-off settings remain unchanged by planning actions and navigation");
}
