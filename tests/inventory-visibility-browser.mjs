import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const artifact=name=>fileURLToPath(new URL('../output/inventory-visibility/'+name,import.meta.url));
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=spawn(process.execPath,['tests/product-access-ui-fixture.mjs'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser,errors='',checks=0;
fixture.stderr.on('data',data=>{errors+=data;});
const pass=name=>{checks++;console.log('PASS '+name);};
try{
 const base=await new Promise((resolve,reject)=>{
  let output='';const timer=setTimeout(()=>reject(new Error('Fixture startup timed out: '+errors)),15000);
  fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+': '+errors));});
  fixture.stdout.on('data',data=>{output+=data;const line=output.split('\n').find(v=>v.startsWith('{'));if(line){try{const value=JSON.parse(line);clearTimeout(timer);resolve(value.url);}catch{}}});
 });
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 const page=await context.newPage(),failures=[];page.on('pageerror',e=>failures.push(e.message));
 await mkdir(new URL('../output/inventory-visibility/',import.meta.url),{recursive:true});
 const state=async()=>{const r=await context.request.get(base+'/__fixture/state');assert.ok(r.ok());return r.json();};
 const before=await state();
 const row=(selector,title)=>page.locator(selector).filter({hasText:title});
 const panel=r=>r.locator('.product-access:visible');
 const quantity=async(r,market)=>r.locator('.'+market+'-stock .market-stock-head b').innerText();
 const waitQuantity=(r,market,value)=>r.locator('.'+market+'-stock .market-stock-head b').getByText(value,{exact:true}).waitFor();
 await page.goto(base);
 await page.locator('#linkRows .product-access:visible').first().waitFor();
 const active=row('#linkRows > tr','隔離テスト・URL確認モニター');
 assert.equal(await quantity(panel(active),'amazon'),'12個');assert.equal(await quantity(panel(active),'yahoo'),'15個');
 assert.match(await panel(active).innerText(),/FBAより3個多い/);pass('link quantities and oversell warning');
 const ended=panel(row('#linkRows > tr','隔離テスト・出品終了'));
 assert.equal(await quantity(ended,'amazon'),'4個');assert.equal(await quantity(ended,'yahoo'),'0個');
 assert.match(await ended.innerText(),/出品終了・再出品を確認/);assert.equal(await ended.locator('.yahoo-stock.ended').count(),1);
 const unknown=panel(row('#linkRows > tr','隔離テスト・取得失敗'));
 assert.equal(await quantity(unknown,'yahoo'),'未確認');assert.equal(await unknown.locator('.ended').count(),0);pass('ended is red zero; failed retrieval stays unknown');
 await page.getByRole('button',{name:'タイル表示',exact:true}).click();
 await page.screenshot({path:artifact('links-desktop.png'),fullPage:true});
 for(const width of [390,320]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.locator('#linkRows').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 pass('link tiles are one column without horizontal overflow at 390 and 320px');
 await page.screenshot({path:artifact('links-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/?view=stock');
 await page.locator('#stockRows .product-access:visible').first().waitFor();
 const stock=row('#stockRows > tr','隔離テスト・URL確認モニター');
 assert.match(await panel(stock).locator('.physical-stock-lines').innerText(),/コンテナ\s*50台\s*会社・自宅\s*1台/);
 const mismatch=panel(row('#stockRows > tr','隔離テスト・SKU不一致'));
 assert.match(await mismatch.innerText(),/SKU・商品情報が異なるため比較対象外/);
 assert.equal(await quantity(mismatch,'amazon'),'3個');assert.equal(await quantity(mismatch,'yahoo'),'未確認');
 assert.equal(await mismatch.locator('.inventory-risk.danger').count(),0);pass('four separate quantities and excluded mismatching SKU');
 await page.getByRole('button',{name:'タイル表示',exact:true}).click();
 await panel(stock).getByRole('button',{name:'SKU・在庫数を確認',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'SKUとFBA在庫の確認',exact:true});
 await dialog.getByLabel('対応するAmazon SKU').fill('SKU-VERY-GOOD');
 await dialog.getByRole('button',{name:'確認内容を保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await waitQuantity(panel(stock),'amazon','3個');assert.equal(await quantity(panel(stock),'amazon'),'3個');
 assert.match(await panel(stock).innerText(),/比較対象外/);pass('SKU change selects its own condition and excludes old listing');
 await page.reload();await page.locator('#stockRows .product-access:visible').first().waitFor();
 assert.equal(await quantity(panel(stock),'amazon'),'3個');
 await page.screenshot({path:artifact('stock-desktop.png'),fullPage:true});
 for(const width of [390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.locator('#stockRows').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 pass('stock mobile one-column layout and saved SKU reload');
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/?view=planning');
 await row('#planningRows > tr','隔離テスト・販売計画のURL登録').locator('[data-plan-details]').click();const plan=page.locator('#planningDetails .product-access');await plan.waitFor();
 await plan.getByRole('button',{name:'SKU・在庫数を確認',exact:true}).click();
 await dialog.getByLabel('対応するAmazon SKU').fill('MANUAL-SKU');await dialog.getByLabel('FBA在庫の手入力').fill('0');
 await dialog.getByRole('button',{name:'確認内容を保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await waitQuantity(plan,'amazon','0個');assert.equal(await quantity(plan,'amazon'),'0個');await page.reload();await row('#planningRows > tr','隔離テスト・販売計画のURL登録').locator('[data-plan-details]').click();await plan.waitFor();assert.equal(await quantity(plan,'amazon'),'0個');
 await plan.getByRole('button',{name:'SKU・在庫数を確認',exact:true}).click();await dialog.getByLabel('FBA在庫の手入力').fill('');
 await dialog.getByRole('button',{name:'確認内容を保存',exact:true}).click();await dialog.waitFor({state:'hidden'});await waitQuantity(plan,'amazon','未確認');assert.equal(await quantity(plan,'amazon'),'未確認');
 const after=await state();assert.deepEqual(after['physical-stock'].state.balances,before['physical-stock'].state.balances);
 for(const key of ['id','title','asin','source','availableOn','durationDays','decisions','actions','note'])assert.deepEqual(after['sales-planning'].state.plans[0][key],before['sales-planning'].state.plans[0][key]);
 assert.ok(after['link-monitor'].state.inventoryReviewHistory.some(v=>v.manualFbaQuantity===0));pass('manual zero, reload, clear, history and preservation');
 await page.goto(base+'/?view=overview');await page.locator('.overview-card').first().waitFor();
 const first=row('.overview-card','隔離テスト・URL確認モニター').first();assert.equal(await first.locator('.physical-stock-lines > div').count(),2);
 assert.ok(await page.getByRole('link',{name:'全商品一覧',exact:true}).isVisible());
 await page.getByRole('button',{name:'リスト',exact:true}).click();
 for(const width of [1440,800,390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overview list overflow at '+width);}
 await page.screenshot({path:artifact('overview-list-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'タイル',exact:true}).click();
 for(const width of [390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.locator('#overviewRows').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:artifact('overview-desktop.png'),fullPage:true});
 assert.deepEqual(failures,[]);pass('independent overview menu, list/tiles, four quantities and no JS errors');
 console.log(JSON.stringify({checks,externalWrites:0,productionWrites:0}));
}finally{
 await browser?.close();const closed=once(fixture,'exit');fixture.kill();await closed;
}
