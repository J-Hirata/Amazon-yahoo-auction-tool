import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),directory=new URL('../output/manual-fba-membership/',import.meta.url);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=spawn(process.execPath,['tests/product-access-ui-fixture.mjs'],{cwd:root,env:{...process.env,AMAZON_STATUS_FIXTURE:'1',WORKSPACE_FIXTURE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,stderr='',checks=0;fixture.stderr.on('data',d=>stderr+=d);const pass=s=>{checks++;console.log('PASS '+s);};
try{
 const base=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Startup: '+stderr)),15000);fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture '+code+': '+stderr));});fixture.stdout.on('data',d=>{out+=d;const line=out.split('\n').find(s=>s.startsWith('{'));if(line){try{const v=JSON.parse(line);clearTimeout(timer);resolve(v.url);}catch{}}});});
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1050}}),pageErrors=[];
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 context.on('page',p=>p.on('pageerror',e=>pageErrors.push(e.message)));
 let conflict=false,lost=false;
 await context.route(base+'/api/product-links/operations',async r=>{if(conflict){conflict=false;return r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'別の編集が保存されました'})});}if(lost){lost=false;await r.fetch();return r.abort();}return r.continue();});
 const page=await context.newPage(),read=async()=>{const r=await context.request.get(base+'/__fixture/state');assert.ok(r.ok());return r.json();},before=await read();
 const bookId=before['physical-stock'].state.products.find(p=>p.asin==='B000BOOK01').id;
 const stockRow=title=>page.locator('#stockRows>tr').filter({hasText:title}),book=()=>stockRow('隔離テスト・新品の販売中書籍'),p=row=>row.locator('.product-access:visible');
 const quantity=row=>p(row).locator('.amazon-stock b'),manual=page.getByRole('dialog',{name:'FBA在庫数を入力',exact:true});
 const openManual=async()=>{await p(book()).getByRole('button',{name:'FBA在庫数を入力',exact:true}).click();await manual.waitFor();};
 const saveManual=async value=>{await openManual();await manual.getByLabel('FBA在庫の手入力').fill(value);await manual.getByRole('button',{name:'FBA数を保存',exact:true}).click();await manual.waitFor({state:'hidden'});await quantity(book()).getByText(value===''?'未確認':value+'個',{exact:true}).waitFor();};
 const tags=()=>book().locator('.catalog-summary .product-membership-tag');
 await mkdir(directory,{recursive:true});await page.goto(base+'/?view=stock');await p(book()).waitFor();await page.getByRole('button',{name:'タイル表示',exact:true}).click();
 assert.equal(await quantity(book()).innerText(),'未確認');await openManual();assert.equal(await manual.getByLabel('対応するAmazon SKU').isVisible(),false);assert.equal(await manual.getByRole('radio').count(),0);
 await manual.getByLabel('FBA在庫の手入力').fill('92');await manual.getByRole('button',{name:'FBA数を保存',exact:true}).click();await manual.waitFor({state:'hidden'});await quantity(book()).getByText('92個',{exact:true}).waitFor();
 await page.reload();await p(book()).waitFor();assert.equal(await quantity(book()).innerText(),'92個');assert.match(await p(book()).locator('.amazon-stock').innerText(),/FBA数量・手入力/);
 const saved=await read();assert.deepEqual(saved['physical-stock'],before['physical-stock']);assert.deepEqual(saved['sales-planning'],before['sales-planning']);assert.deepEqual(saved['link-monitor'].state.links,before['link-monitor'].state.links);assert.equal(saved['link-monitor'].state.inventoryReviews.find(r=>r.key==='stock:'+bookId).sellerSku,'');pass('unknown FBA number accepts 92 without a SKU and reloads as manual; only the confirmation record changes');

 await saveManual('0');assert.equal(await quantity(book()).innerText(),'0個');await page.reload();await p(book()).waitFor();assert.equal(await quantity(book()).innerText(),'0個');await saveManual('');assert.equal(await quantity(book()).innerText(),'未確認');pass('manual zero persists and clearing it returns to unknown, not zero');

 await openManual();await manual.getByLabel('FBA在庫の手入力').fill('92');conflict=true;await manual.getByRole('button',{name:'FBA数を保存',exact:true}).click();await manual.getByText(/別の編集が保存されました/).waitFor();assert.equal(await manual.getByLabel('FBA在庫の手入力').inputValue(),'92');
 await manual.getByRole('button',{name:'FBA数を保存',exact:true}).click();await manual.waitFor({state:'hidden'});await quantity(book()).getByText('92個',{exact:true}).waitFor();assert.equal(await quantity(book()).innerText(),'92個');
 await openManual();await manual.getByLabel('FBA在庫の手入力').fill('91');const receipts=(await read())['link-monitor'].state.productLinkReceipts.length;lost=true;
 await manual.getByRole('button',{name:'FBA数を保存',exact:true}).click();await manual.getByRole('button',{name:'同じ内容で保存結果を確認',exact:true}).waitFor();await manual.getByRole('button',{name:'同じ内容で保存結果を確認',exact:true}).click();await manual.waitFor({state:'hidden'});
 assert.equal((await read())['link-monitor'].state.productLinkReceipts.length,receipts+1);await quantity(book()).getByText('91個',{exact:true}).waitFor();assert.equal(await quantity(book()).innerText(),'91個');pass('conflicts keep the entered number; lost responses replay once without duplicate history');

 assert.deepEqual(await tags().allTextContents(),['コンテナ・自社在庫']);assert.ok(await book().locator('.catalog-badges .membership-stock').isVisible());
 const reserve=stockRow('隔離テスト・補充用在庫');assert.equal(await reserve.locator('.catalog-summary .membership-links').count(),0);assert.equal(await reserve.locator('.catalog-summary .membership-planning').count(),0);
 const linkedTitle='隔離テスト・URL確認モニター',linked=stockRow(linkedTitle);assert.equal(await linked.locator('.catalog-summary .product-membership-tag').count(),2);
 assert.ok(await linked.locator('.catalog-summary .membership-links').isVisible());assert.ok(await linked.locator('.catalog-summary .membership-stock').isVisible());
 assert.ok(await linked.locator('.product-workspace-actions:visible').evaluate(n=>n.getBoundingClientRect().height<=40));assert.equal(await linked.locator('.product-workspace-more:visible').evaluate(n=>n.open),false);pass('one and two real memberships appear near the title; unlinked ASIN candidates are not registered tags');

 const popupPromise=page.waitForEvent('popup');await p(linked).locator('.product-workspace-primary').click();const popup=await popupPromise;await popup.locator('#planningDialog[open]').waitFor();await popup.locator('#planningDialog [name=availableOn]').fill('2026-10-30');await popup.locator('#planningDialog [name=note]').fill('Keep this plan');await popup.locator('#planningSave').click();await popup.locator('#planningDialog').waitFor({state:'hidden'});await popup.close();
 await page.reload();await p(linked).waitFor();assert.deepEqual(await linked.locator('.catalog-summary .product-membership-tag').allTextContents(),['商品紐付け','コンテナ・自社在庫','販売見直し']);
 assert.equal(await linked.locator('.catalog-summary .membership-planning').getAttribute('target'),'_blank');
 const colors=await linked.locator('.catalog-summary .product-membership-tag').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).backgroundColor));assert.equal(new Set(colors).size,3);
 await page.getByRole('button',{name:'リスト表示',exact:true}).click();assert.equal(await linked.locator('.stock-badges .product-membership-tag:visible').count(),3);await page.getByRole('button',{name:'タイル表示',exact:true}).click();
 await page.screenshot({path:fileURLToPath(new URL('stock-desktop.png',directory)),fullPage:true});pass('all three memberships are distinct, coloured and actionable in tiles and list rows');

 await page.goto(base);await page.locator('#linkRows .product-access:visible').first().waitFor();await page.getByRole('button',{name:'タイル表示',exact:true}).click();
 let row=page.locator('#linkRows>tr').filter({hasText:linkedTitle});assert.equal(await row.locator('.catalog-summary .product-membership-tag:visible').count(),3);
 await page.goto(base+'/?view=planning');await page.locator('#planningRows .product-access:visible').first().waitFor();row=page.locator('#planningRows>tr').filter({hasText:linkedTitle});assert.equal(await row.locator('.product-membership-tag:visible').count(),3);
 await page.goto(base+'/?view=overview');await page.locator('.overview-card').first().waitFor();row=page.locator('.overview-card').filter({hasText:linkedTitle});assert.equal(await row.locator('.product-membership-tag:visible').count(),3);pass('linking, stock, planning and overview pages share the same registered memberships');

 await page.goto(base+'/?view=stock');await p(book()).waitFor();
 for(const width of [1440,800,390,320]){await page.setViewportSize({width,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow '+width);await openManual();assert.ok(await manual.evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert.equal(await manual.getByRole('spinbutton').count(),1);if(width===320)await page.screenshot({path:fileURLToPath(new URL('manual-mobile.png',directory)),fullPage:true});await manual.getByRole('button',{name:'取消',exact:true}).click();
  for(const badge of await linked.locator('.catalog-summary .product-membership-tag').all())assert.ok(await badge.evaluate(n=>n.scrollWidth<=n.clientWidth+1));}
 assert.deepEqual(pageErrors,[]);pass('compact registration tags and quantity-only input fit 320/390/800/1440px without errors');
 const after=await read();assert.deepEqual(after['physical-stock'],before['physical-stock']);assert.deepEqual(after['link-monitor'].state.links,before['link-monitor'].state.links);assert.deepEqual(after['link-monitor'].state.catalog,before['link-monitor'].state.catalog);assert.deepEqual(after['sales-planning'].state.plans[0],before['sales-planning'].state.plans[0]);assert.equal(after['sales-planning'].state.plans.length,before['sales-planning'].state.plans.length+1);pass('physical stock, original notes, existing plan dates and SKU relationships are preserved');
 console.log(JSON.stringify({checks,productionWrites:0,externalWrites:0}));
}finally{await browser?.close();const closed=once(fixture,'exit');fixture.kill();await closed;}
