import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),directory=new URL('../output/amazon-status/',import.meta.url);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=spawn(process.execPath,['tests/product-access-ui-fixture.mjs'],{cwd:root,env:{...process.env,AMAZON_STATUS_FIXTURE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,stderr='',checks=0;fixture.stderr.on('data',d=>stderr+=d);
const pass=name=>{checks++;console.log('PASS '+name);};
try{
 const base=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Fixture startup: '+stderr)),15000);fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exit '+code+': '+stderr));});fixture.stdout.on('data',d=>{out+=d;const line=out.split('\n').find(s=>s.startsWith('{'));if(line){try{const value=JSON.parse(line);clearTimeout(timer);resolve(value.url);}catch{}}});});
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}}),pageErrors=[];
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 context.on('page',p=>p.on('pageerror',e=>pageErrors.push(e.message)));
 const page=await context.newPage(),read=async()=>{const r=await context.request.get(base+'/__fixture/state');assert.ok(r.ok());return r.json();};
 const before=await read(),bookId=before['physical-stock'].state.products.find(p=>p.asin==='B000BOOK01').id;
 const book=()=>page.locator('#stockRows > tr').filter({hasText:'隔離テスト・新品の販売中書籍'}).locator('.product-access:visible');
 const merchant=()=>page.locator('#stockRows > tr').filter({hasText:'隔離テスト・自己発送モニター'}).locator('.product-access:visible');
 const dialog=page.getByRole('dialog',{name:'SKUとFBA在庫の確認',exact:true});
 const reviewLink=async name=>{const more=book().locator('.product-workspace-more');if(!await more.evaluate(n=>n.open))await more.locator('summary').click();return more.locator('.product-workspace-nav').getByRole('link',{name,exact:true});};
 const popupFor=async link=>{assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/noopener/);const pending=page.waitForEvent('popup');await link.click();const popup=await pending;await popup.locator('#planningDialog[open]').waitFor();return popup;};
 await mkdir(directory,{recursive:true});await page.goto(base+'/?view=stock');await book().waitFor();await page.getByRole('button',{name:'タイル表示',exact:true}).click();
 assert.equal(await book().locator('.amazon-stock b').innerText(),'未確認');
 assert.match(await book().locator('.amazon-stock').innerText(),/FBA数量[\s\S]*FBAで販売中[\s\S]*対象SKU未選択・候補 2件/);
 await book().getByRole('button',{name:'SKU・在庫数を確認',exact:true}).click();
 await dialog.waitFor();
 assert.equal(await dialog.getByRole('radio').count(),3);assert.equal(await dialog.getByRole('radio',{checked:true}).count(),0);
 const choice=sku=>dialog.locator('.inventory-sku-choice').filter({hasText:sku});
 assert.match(await choice('NEW-ACTIVE').innerText(),/新品／販売中／FBA 97個/);assert.match(await choice('NEW-OLD').innerText(),/販売停止・販売不可／FBA 0個/);
 assert.ok(await choice('USED-OTHER').getByRole('radio').isDisabled());
 await dialog.getByLabel('FBA在庫の手入力').fill('11');await choice('NEW-ACTIVE').getByRole('radio').check();
 assert.equal(await dialog.getByLabel('FBA在庫の手入力').inputValue(),'');
 await page.screenshot({path:fileURLToPath(new URL('sku-choices-desktop.png',directory)),fullPage:true});
 await dialog.getByRole('button',{name:'確認内容を保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await book().locator('.amazon-stock b').getByText('97個',{exact:true}).waitFor();
 await page.reload();await book().waitFor();assert.equal(await book().locator('.amazon-stock b').innerText(),'97個');
 const saved=(await read())['physical-stock'].state.products.find(p=>p.id===bookId);assert.equal(saved.sellerSku,'NEW-ACTIVE');pass('selling FBA with ambiguous quantity resolves only after explicit SKU selection; grades stay separate');

 assert.match(await merchant().locator('.amazon-stock').innerText(),/自社発送販売数[\s\S]*2個[\s\S]*自社発送で販売中[\s\S]*FBAの出品登録なし/);
 assert.match(await merchant().locator('.physical-stock-lines').innerText(),/コンテナ\s*3個\s*会社・自宅\s*1個/);
 await merchant().getByRole('button',{name:'SKU・在庫数を確認',exact:true}).click();
 await dialog.waitFor();
 assert.ok(await dialog.getByLabel('FBA在庫の手入力').isDisabled());await choice('FBM-SKU').getByRole('radio').check();
 assert.ok(await dialog.getByLabel('FBA在庫の手入力').isDisabled());assert.match(await dialog.locator('[data-automatic]').innerText(),/自社発送販売数 2個/);
 await dialog.getByRole('button',{name:'取消',exact:true}).click();pass('merchant available quantity is visible and cannot be entered as FBA inventory');

 await page.locator('#stockSearch').fill('B000BOOK01');await book().waitFor();
 await (await reviewLink('販売見直しへ')).scrollIntoViewIfNeeded();
 const sourceUrl=page.url(),sourceScroll=await page.evaluate(()=>scrollY),beforePopup=await read();
 let popup=await popupFor(await reviewLink('販売見直しへ'));
 assert.equal(page.url(),sourceUrl);assert.equal(await page.locator('#stockSearch').inputValue(),'B000BOOK01');assert.equal(await page.evaluate(()=>scrollY),sourceScroll);
 assert.equal(await popup.locator('#planningDialog [name=source]').inputValue(),'stock:'+bookId);assert.equal(await popup.locator('#planningDialog [name=sellerSku]').inputValue(),'NEW-ACTIVE');
 await popup.locator('#planningDialog [name=note]').fill('Not saved yet');await popup.close();assert.deepEqual(await read(),beforePopup);pass('new review opens in another tab and leaves source filter, URL, scroll and database unchanged');

 popup=await popupFor(await reviewLink('販売見直しへ'));
 await popup.locator('#planningDialog [name=availableOn]').fill('2026-10-30');await popup.locator('#planningDialog [name=durationDays]').fill('14');await popup.locator('#planningDialog [name=note]').fill('Keep planned dates and note');
 await popup.locator('#planningSave').click();await popup.locator('#planningDialog').waitFor({state:'hidden'});await popup.close();
 await page.reload();await book().waitFor();await page.locator('#stockSearch').fill('B000BOOK01');
 const planned=await read();popup=await popupFor(await reviewLink('販売見直し'));
 assert.equal(await popup.locator('#planningDialog [name=note]').inputValue(),'Keep planned dates and note');assert.equal(await popup.locator('#planningDialog [name=availableOn]').inputValue(),'2026-10-30');
 await popup.getByRole('button',{name:'取消',exact:true}).click();await popup.close();assert.deepEqual(await read(),planned);pass('existing review opens separately without duplicating the plan or changing dates');

 await page.locator('#stockSearch').fill('');await book().waitFor();await page.screenshot({path:fileURLToPath(new URL('stock-desktop.png',directory)),fullPage:true});
 for(const width of [1440,800,390,320]){
  await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'stock overflow '+width);
  await book().getByRole('button',{name:'SKU・在庫数を確認',exact:true}).click();
  await dialog.waitFor();
  assert.ok(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'dialog overflow '+width);
  for(const label of await dialog.locator('.inventory-sku-choice').all())assert.ok(await label.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  if(width===320)await page.screenshot({path:fileURLToPath(new URL('sku-choices-mobile.png',directory)),fullPage:true});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
 }
 assert.deepEqual(pageErrors,[]);pass('SKU choices and labelled quantities fit desktop and mobile without JS errors');
 const after=await read();assert.deepEqual(after['physical-stock'].state.balances,before['physical-stock'].state.balances);
 for(const old of before['physical-stock'].state.products){const now=after['physical-stock'].state.products.find(p=>p.id===old.id);for(const key of Object.keys(old).filter(k=>!['sellerSku','updatedAt'].includes(k)))assert.deepEqual(now[key],old[key],old.title+' '+key);}
 assert.deepEqual(after['sales-planning'].state.plans[0],before['sales-planning'].state.plans[0]);pass('physical counts, memos and existing plan dates are preserved');
 console.log(JSON.stringify({checks,productionWrites:0,externalWrites:0}));
}finally{await browser?.close();const closed=once(fixture,'exit');fixture.kill();await closed;}
