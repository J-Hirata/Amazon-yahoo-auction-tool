import assert from "node:assert/strict";
import path from "node:path";

export async function verifyCatalogViews({page,stockStore,monitorStore,draftStore,root,pass}) {
  const stockBefore=JSON.stringify(await stockStore.read()),monitorBefore=JSON.stringify(await monitorStore.read()),draftBefore=JSON.stringify(await draftStore.read());
  const controls=key=>page.locator(`[data-catalog-controls="${key}"]`);
  const setMode=async(key,mode)=>{await controls(key).locator(`[data-catalog-mode=${mode}]`).click();};
  const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
  await setMode("stock","tiles");
  const grid=page.locator("#stockRows"), count=(await stockStore.read()).products.length;
  assert.equal(await grid.locator(".catalog-summary").count(),count);
  assert.equal(await grid.getAttribute("data-catalog-layout"),"tiles");
  const square=await grid.locator(".catalog-item").first().boundingBox();assert.ok(Math.abs(square.width-square.height)<2);
  await controls("stock").locator("select").selectOption("measureDesc");
  assert.equal(await grid.locator(".catalog-title").first().textContent(),"場所別在庫の試験商品");
  await controls("stock").locator("select").selectOption("original");
  assert.match(await grid.locator(".catalog-metrics").first().textContent(),/コンテナ/);assert.match(await grid.locator(".catalog-metrics").first().textContent(),/自宅・会社/);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(root,"output","catalog-stock-desktop.png")});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await fit();
    const boxes=await grid.locator(".catalog-summary").first().evaluate(el=>{const rect=s=>{const r=el.querySelector(s).getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height};};return{image:rect(".catalog-image"),title:rect(".catalog-title"),metrics:rect(".catalog-metrics")};});
    assert.ok(boxes.image.height>30);assert.ok(boxes.image.bottom<=boxes.title.top);assert.ok(boxes.title.bottom<=boxes.metrics.top);
    if(width===390){await page.evaluate(()=>document.querySelector("#stockRows").scrollIntoView({block:"start"}));await page.screenshot({path:path.join(root,"output","catalog-stock-mobile.png")});}
  }
  await page.setViewportSize({width:1440,height:1080});
  await grid.locator(".catalog-open").first().click();
  await grid.locator(".catalog-expanded [data-stock-places]").first().click();await page.locator("#stockPlacesDialog[open]").waitFor();
  await page.locator("#stockPlacesDialog").getByRole("button",{name:"取消",exact:true}).click();
  await grid.locator(".catalog-expanded .catalog-open").click();
  await page.reload();await page.locator("#stockRows[data-catalog-layout=tiles]").waitFor();
  pass("stock tiles are square on desktop, readable at 390/320px, sortable and persistent; detail quantity controls still work without saving");
  await page.locator(".cloud-account nav").getByText("商品紐付けツール",{exact:true}).click();await page.locator("#cloudApp:not([hidden]) #linkRows .catalog-item").first().waitFor();
  assert.equal(await page.locator("#linkRows").getAttribute("data-catalog-layout"),"list");
  await setMode("links","tiles");const links=page.locator("#linkRows");
  assert.equal(await links.locator(".catalog-item").count(),(await monitorStore.read()).links.length);
  await links.locator(".catalog-open").first().click();const expanded=links.locator(".catalog-expanded");
  await expanded.locator(".memo-edit").click();await expanded.locator("textarea[name=memo]").fill("切替中の未保存メモ");
  await setMode("links","list");await setMode("links","tiles");assert.equal(await expanded.locator("textarea[name=memo]").inputValue(),"切替中の未保存メモ");
  await expanded.locator(".memo-cancel").click();await links.locator(".catalog-expanded .catalog-open").click();
  await controls("links").locator("select").selectOption("titleAsc");
  const names=await links.locator(".catalog-title").allTextContents();assert.deepEqual(names,[...names].sort((a,b)=>a.localeCompare(b,"ja",{numeric:true})));
  await controls("links").locator("select").selectOption("original");
  await page.evaluate(()=>scrollTo(0,0));await page.locator("#linkRows").scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,"output","catalog-links-desktop.png")});
  await page.setViewportSize({width:390,height:844});await fit();await page.screenshot({path:path.join(root,"output","catalog-links-mobile.png")});
  await setMode("links","list");
  pass("linkage tiles preserve FBA/unknown labels, all listing IDs, unsaved memo input and original operations without API writes");
  await page.locator(".cloud-account nav").getByText("出品下書きツール",{exact:true}).click();await page.locator("#cloudApp:not([hidden]) #summary").waitFor();
  const visibleCount=await page.locator("#active .item,#waiting .item,#recentHistory .item").count();await setMode("drafts","tiles");
  assert.equal(await page.locator("#active .catalog-item,#waiting .catalog-item,#recentHistory .catalog-item").count(),visibleCount);assert.match(await page.locator("#summary").textContent(),/58/);
  await controls("drafts").locator("select").selectOption("measureDesc");
  await page.locator("#active .catalog-open").first().click();assert.equal(await page.locator("#active .catalog-expanded [data-action=delete]").isDisabled(),true);
  await page.locator("#active .catalog-expanded [data-action=draft]").click();await page.locator("#draftPanel:not([hidden])").waitFor();await page.locator("#closeDraft").click();
  await page.locator("#active .catalog-expanded .catalog-open").click();
  await page.setViewportSize({width:1440,height:1080});await page.locator("#active").scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,"output","catalog-drafts-desktop.png")});
  await page.setViewportSize({width:390,height:844});await fit();await page.locator("#active").scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,"output","catalog-drafts-mobile.png")});
  await setMode("drafts","list");await controls("drafts").locator("select").selectOption("original");
  assert.equal(JSON.stringify(await stockStore.read()),stockBefore);assert.equal(JSON.stringify(await monitorStore.read()),monitorBefore);assert.equal(JSON.stringify(await draftStore.read()),draftBefore);
  await page.locator(".cloud-account nav").getByText("コンテナ・自社在庫",{exact:true}).click();await page.locator("#stockRows[data-catalog-layout=tiles]").waitFor();await setMode("stock","list");
  await page.setViewportSize({width:1440,height:1080});
  pass("draft queues and recent history support tiles and price-proposal sorting; all 58 stored drafts and every business document remain unchanged");
}
