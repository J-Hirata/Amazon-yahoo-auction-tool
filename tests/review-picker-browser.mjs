import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),out=new URL('../output/review-picker/',import.meta.url);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=spawn(process.execPath,['tests/product-access-ui-fixture.mjs'],{cwd:root,env:{...process.env,WORKSPACE_FIXTURE:'1',REVIEW_PICKER_FIXTURE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,errors='',checks=0;fixture.stderr.on('data',d=>errors+=d);const pass=name=>{checks++;console.log('PASS '+name);};
try{
 const base=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error(errors||'Fixture timeout')),15000);fixture.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});fixture.stdout.on('data',data=>{text+=data;const line=text.split('\n').find(l=>l.startsWith('{'));if(line){clearTimeout(timer);resolve(JSON.parse(line).url);}});});
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const page=await context.newPage(),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 const read=async()=>{const r=await context.request.get(base+'/__fixture/state');assert.ok(r.ok());return r.json();};
 const before=await read(),reserve=before['physical-stock'].state.products.find(p=>p.asin==='B000TEST05'),links=before['link-monitor'].state.links.filter(l=>l.asin===reserve.asin);
 const stockRow=()=>page.locator('#stockRows>tr').filter({hasText:'隔離テスト・補充用在庫'}),urlDialog=page.getByRole('dialog',{name:'商品ページのURLを登録・修正'});
 const menuLink=async(row,name)=>{const more=row.locator('.product-access:visible .product-workspace-more');if(!await more.evaluate(n=>n.open))await more.locator('summary').click();return more.locator('.product-workspace-nav').getByRole('link',{name,exact:true});};
 const openPicker=async(row)=>{await row.getByRole('button',{name:'URL登録・修正',exact:true}).click();await urlDialog.waitFor();await urlDialog.getByRole('button',{name:'登録済みの商品から選ぶ',exact:true}).click();};
 await mkdir(out,{recursive:true});await page.goto(base+'/?view=stock');await stockRow().waitFor();
 const review=await menuLink(stockRow(),'販売見直しへ');assert.equal(await review.getAttribute('target'),'_blank');const popupPromise=page.waitForEvent('popup');await review.click();const popup=await popupPromise;popup.on('pageerror',e=>pageErrors.push(e.message));
 const plan=popup.getByRole('dialog',{name:'この商品の販売見直し'});await plan.waitFor();
 assert.match(await plan.locator('#planningSelectedProduct').innerText(),/コンテナ確認 脚なしか？ あれば補充/);assert.match(await plan.locator('.planning-source-stock').innerText(),/コンテナ\s*15個/);assert.match(await plan.locator('.planning-source-stock').innerText(),/会社・自宅\s*1個/);
 assert.equal(await plan.locator('[name=note]').inputValue(),'');assert.equal(await plan.locator('[name=kind]').inputValue(),'review');assert.equal(await plan.locator('#planningIdentity').evaluate(n=>n.open),false);
 assert.deepEqual(await read(),before);assert.match(page.url(),/view=stock/);
 await popup.screenshot({path:fileURLToPath(new URL('review-context-desktop.png',out))});await plan.getByRole('button',{name:'取消',exact:true}).click();await popup.close();pass('review opens a new tab with existing memo and stock, without registration or quantity writes');

 await openPicker(stockRow());const search=urlDialog.getByRole('searchbox',{name:'登録済みの商品を検索'});assert.equal(await search.inputValue(),reserve.asin);
 assert.equal(await urlDialog.locator('[data-pick-key]').count(),2);assert.equal(await urlDialog.locator('.product-picker-product img').count(),2);
 await search.fill('ない商品XYZ');assert.match(await urlDialog.locator('[data-picker-rows]').innerText(),/該当する登録商品はありません/);
 await urlDialog.getByRole('button',{name:'商品選択を閉じる',exact:true}).click();assert.ok(await urlDialog.getByLabel('ヤフオクの商品URL',{exact:true}).isVisible());
 await urlDialog.getByRole('button',{name:'登録済みの商品から選ぶ',exact:true}).click();await search.fill('B000TEST01');assert.equal(await urlDialog.locator('[data-pick-key]').first().isDisabled(),true);
 await search.fill(reserve.asin);const chosen=urlDialog.locator(`[data-pick-key="link:${links[0].id}"]`);await chosen.click();assert.ok(await urlDialog.locator('[data-picker-picked]').isVisible());assert.deepEqual(await read(),before);
 await urlDialog.getByRole('button',{name:'選び直す',exact:true}).click();assert.ok(await search.isVisible());await urlDialog.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(await read(),before);pass('picker searches existing products, rejects other ASINs, and cancels without saving');

 await openPicker(stockRow());await urlDialog.locator(`[data-pick-key="link:${links[0].id}"]`).click();
 let attempt=0;await page.route('**/api/product-links/operations',async route=>{attempt++;if(attempt===1)await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'ほかの編集が保存されました'})});else if(attempt===2){await route.fetch();await route.abort('failed');}else await route.continue();});
 await urlDialog.getByRole('button',{name:'この商品と関連付ける',exact:true}).click();await urlDialog.locator('[data-url-message]').filter({hasText:'ほかの編集'}).waitFor();assert.match(await urlDialog.locator('[data-picker-picked]').innerText(),/共有するモニター 5/);await urlDialog.getByRole('button',{name:'この商品と関連付ける',exact:true}).click();await urlDialog.getByRole('button',{name:'同じ内容で保存結果を確認',exact:true}).waitFor();await urlDialog.getByRole('button',{name:'同じ内容で保存結果を確認',exact:true}).click();await urlDialog.waitFor({state:'hidden'});await page.unroute('**/api/product-links/operations');
 let current=await read();assert.deepEqual(current['physical-stock'].state.products.find(p=>p.id===reserve.id).linkedLinkIds,[links[0].id]);assert.deepEqual(current['physical-stock'].state.balances,before['physical-stock'].state.balances);assert.deepEqual(current['link-monitor'].state.links,before['link-monitor'].state.links);assert.equal(current['link-monitor'].state.productLinkReceipts.length,1);pass('selection save reuses a registered link and replays a lost response only once');

 await page.goto(base);const second=page.locator('#linkRows>tr').filter({hasText:'隔離テスト・共有するモニター 9'});await second.waitFor();await openPicker(second);await urlDialog.getByRole('searchbox',{name:'登録済みの商品を検索'}).fill(reserve.asin);await urlDialog.locator(`[data-pick-key="stock:${reserve.id}"]`).click();
 await page.screenshot({path:fileURLToPath(new URL('existing-stock-selection.png',out))});await urlDialog.getByRole('button',{name:'この商品と関連付ける',exact:true}).click();await urlDialog.waitFor({state:'hidden'});await second.locator('.membership-stock:visible').waitFor();current=await read();assert.equal(current['physical-stock'].state.products.find(p=>p.id===reserve.id).linkedLinkIds.length,2);pass('the linkage page can select existing physical stock in the reverse direction');

 await page.goto(base+'/?view=planning#plan='+encodeURIComponent('stock:'+reserve.id));await page.getByRole('dialog',{name:'この商品の販売見直し'}).waitFor();const form=page.locator('#planningForm');await form.locator('[name=reviewOn]').fill('2026-12-01');await form.locator('[name=note]').fill('今回だけの判断メモ');await form.getByRole('button',{name:'見直し対象に追加',exact:true}).click();await page.locator('#planningDialog').waitFor({state:'hidden'});
 current=await read();const saved=current['sales-planning'].state.plans.find(p=>p.source.id===reserve.id);assert.ok(saved);assert.equal(saved.availableOn,'');assert.equal(saved.note,'今回だけの判断メモ');assert.equal(Object.hasOwn(saved,'locations'),false);
 const planRow=page.locator(`#planningRows>tr[data-plan-id="${saved.id}"]`);await planRow.locator('.product-access').waitFor();assert.match(await planRow.locator('.planning-source-note').innerText(),/コンテナ確認/);assert.match(await planRow.locator('.physical-stock-lines').innerText(),/15個/);
 await page.goto(base);await page.goto(base+'/?view=planning#plan='+encodeURIComponent('link:'+links[1].id));
 try{await page.locator('#planningDialog[open]').waitFor({timeout:8000});}catch(e){throw new Error(JSON.stringify({error:e.message,status:await page.locator('#planningStatus').innerText(),saved,errors:pageErrors}));}
 assert.equal(await page.locator('#planningDialogTitle').innerText(),'方針・確認日を変更');assert.equal(await page.locator('[name=reviewOn]').inputValue(),'2026-12-01');assert.equal(await page.locator('[name=note]').inputValue(),'今回だけの判断メモ');await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await read())['sales-planning'].state.plans.length,current['sales-planning'].state.plans.length);pass('saved reviews retain the source memo, quantities and dates and reuse the existing plan from either listing');

 const manual=page.locator(`#planningRows>tr[data-plan-id="${before['sales-planning'].state.plans[0].id}"]`);await openPicker(manual);const planSearch=urlDialog.getByRole('searchbox',{name:'登録済みの商品を検索'});await planSearch.fill(reserve.asin);assert.equal(await urlDialog.locator('[data-pick-key]').first().isDisabled(),true);
 await planSearch.fill('B000TEST02');await urlDialog.locator('[data-pick-key]').click();await urlDialog.getByRole('button',{name:'この商品と関連付ける',exact:true}).click();await urlDialog.waitFor({state:'hidden'});pass('planning reuses the same selector to attach existing listings, while rejecting a different ASIN');

 await page.goto(base);await page.goto(base+'/?view=planning#plan='+encodeURIComponent('stock:'+reserve.id));await page.getByRole('dialog',{name:'方針・確認日を変更'}).waitFor();
 for(const width of [1440,800,390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await page.locator('#planningDialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1));}
 await page.screenshot({path:fileURLToPath(new URL('review-context-mobile.png',out))});await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.goto(base+'/?view=stock');await stockRow().waitFor();await openPicker(stockRow());for(const width of [320,390,800,1440]){await page.setViewportSize({width,height:900});assert.ok(await urlDialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));}await page.screenshot({path:fileURLToPath(new URL('existing-link-selection.png',out))});await urlDialog.getByRole('button',{name:'取消',exact:true}).click();
 assert.deepEqual(pageErrors,[]);const after=await read();assert.deepEqual(after['physical-stock'].state.balances,before['physical-stock'].state.balances);assert.deepEqual(after['link-monitor'].state.links,before['link-monitor'].state.links);assert.equal(after['physical-stock'].state.products.length,before['physical-stock'].state.products.length);assert.equal(after['physical-stock'].state.products.find(p=>p.id===reserve.id).memo,reserve.memo);for(const key of ['id','source','createdAt','availableOn','reviewOn','note','decisions','actions'])assert.deepEqual(after['sales-planning'].state.plans[0][key],before['sales-planning'].state.plans[0][key]);assert.equal(after['sales-planning'].state.plans[0].linkedLinkIds.length,1);pass('desktop and phone dialogs fit, with no JS errors, duplicated stock, reset plans or changed source memos');
 console.log(JSON.stringify({checks,productionWrites:0,externalWrites:0}));
}finally{await browser?.close();const closed=once(fixture,'exit');fixture.kill();await closed;}
