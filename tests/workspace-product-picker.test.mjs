import test from'node:test';import assert from'node:assert/strict';
import{matchesProduct,productChoices,choiceIssue}from'../public/workspace-product-picker.js';
import{fixture,at,actor,asin}from'./relations-fixture.mjs';import{applyStockCommand}from'../src/physical-stock.js';import{applyPlanningCommand}from'../src/sales-planning.js';import{randomUUID}from'node:crypto';

test('name search supports multiple words, full-width text, kana variants and identifiers without copying from another page',()=>{
 const p={title:'日本HP EliteDisplay E-232 モニター',asin:'B000TEST01',sellerSku:'2026SKU1',listingId:'h1248825083'};
 for(const q of ['ＨＰ　モニター','hp e232','B000TEST01','2026sku1','h1248825083'])assert.ok(matchesProduct(p,q),q);
 assert.ok(matchesProduct({title:'トーヨー ヘルメット'},'とーよー へるめっと'));
 assert.equal(matchesProduct(p,'HP スピーカー'),false);
});

test('broad choices show other ASINs and different SKUs with reasons; compatible choices are first and selection survives filtering',()=>{
 const source={asin,sellerSku:'SKU1',condition:'used'},products=[{id:'a',title:'別のHPモニター',asin:'B000OTHER1'},{id:'b',title:'HPモニター',asin,sellerSku:'SKU1',condition:'used'},{id:'c',title:'HP別SKUモニター',asin,sellerSku:'OTHER'}];
 const result=productChoices(products,source,'hp モニター');assert.equal(result.length,3);assert.equal(result[0].id,'b');assert.match(result.find(p=>p.id==='a').issue,/ASIN/);assert.match(result.find(p=>p.id==='c').issue,/SKU/);
 assert.equal(productChoices(products,source,'スピーカー',['b']).length,0);assert.equal(choiceIssue({asin:'',condition:'unknown'},products[1]),'');
 assert.match(choiceIssue({asin:'',condition:'unknown'},{asin:''}),/ASINが未登録/);
});

test('all four editors expose the whole stock and monitoring catalog, while a different ASIN selection rolls back all documents',async()=>{
 const f=fixture(),foreignStock=randomUUID(),foreignPlan=randomUUID();await f.transaction.update(d=>{
  applyStockCommand(d['physical-stock'].state,{operationId:randomUUID(),kind:'create',productId:foreignStock,product:{title:'別ASINのスピーカー',asin:'B000OTHER1',condition:'used',unit:'個'},initialCounts:{container:6,home:1}},{actor,at});
  applyPlanningCommand(d['sales-planning'].state,{operationId:randomUUID(),kind:'create',planId:foreignPlan,plan:{title:'別ASINの販売監視',asin:'B000OTHER1',condition:'used',source:{kind:'manual',id:''},kind:'amazon',status:'active',durationDays:10,decisions:['undecided']}},{actor,at,sources:[]});
 });
 const before=f.read(),entries=(await f.editor.list()).entries;for(const key of ['link:'+f.linkId,'stock:'+f.stockId,'plan:'+f.planId,'draft:'+asin])assert.ok(entries[key].editor.candidates.some(p=>p.id===foreignStock&&/ASIN/.test(p.issue)),key);
 assert.ok(entries['link:'+f.linkId].editor.planCandidates.some(p=>p.id===foreignPlan&&/ASIN/.test(p.issue)));
 await assert.rejects(()=>f.editor.save(f.command('link:'+f.linkId,{stockId:foreignStock,registration:{stock:true,merchant:false,yahoo:false,draft:false,planning:false,yahooUrl:''}}),f.options()),/一致しません/);assert.deepEqual(f.read(),before);
});

test('an explicitly chosen named stock can fill a missing ASIN in a manual plan without duplicating stock or overwriting counts',async()=>{
 const f=fixture(),id=randomUUID();await f.transaction.update(d=>applyPlanningCommand(d['sales-planning'].state,{operationId:randomUUID(),kind:'create',planId:id,plan:{title:'名前だけで登録したモニター',asin:'',condition:'unknown',source:{kind:'manual',id:''},kind:'amazon',status:'active',durationDays:10,decisions:['advertising'],note:'元のメモ'}},{actor,at,sources:[]}));
 const before=f.read(),key='plan:'+id;assert.ok((await f.editor.list()).entries[key].editor.candidates.some(p=>p.id===f.stockId));
 await assert.rejects(()=>f.editor.save(f.command(key,{product:{asin,sellerSku:'SKU1',condition:'used'},registration:{stock:true,merchant:false,yahoo:false,draft:false,planning:true,yahooUrl:''}}),f.options()),/登録済みの在庫/);assert.deepEqual(f.read(),before);
 await f.editor.save(f.command(key,{product:{asin,sellerSku:'SKU1',condition:'used'},stockId:f.stockId,registration:{stock:true,merchant:false,yahoo:false,draft:false,planning:true,yahooUrl:''}}),f.options());
 const after=f.read();assert.equal(after['physical-stock'].state.products.length,2);assert.deepEqual(after['physical-stock'].state.balances,before['physical-stock'].state.balances);assert.equal(after['sales-planning'].state.plans.find(p=>p.id===id).workspaceStockId,f.stockId);assert.equal(after['sales-planning'].state.plans.find(p=>p.id===id).note,'元のメモ');
});

test('ASIN-less products stay separate and cannot be linked solely because both identifiers are empty',async()=>{
 const f=fixture(),stockId=randomUUID(),id=randomUUID();await f.transaction.update(d=>{
  applyStockCommand(d['physical-stock'].state,{operationId:randomUUID(),kind:'create',productId:stockId,product:{title:'未採番の別商品',asin:'',condition:'unknown',unit:'個'},initialCounts:{container:3,home:null}},{actor,at});
  applyPlanningCommand(d['sales-planning'].state,{operationId:randomUUID(),kind:'create',planId:id,plan:{title:'未採番の商品',asin:'',condition:'unknown',source:{kind:'manual',id:''},kind:'amazon',status:'active',durationDays:10,decisions:['undecided']}},{actor,at,sources:[]});
 });
 const key='plan:'+id,c=f.command(key,{stockId,registration:{stock:true,merchant:false,yahoo:false,draft:false,planning:true,yahooUrl:''}}),before=f.read();await assert.rejects(()=>f.editor.save(c,f.options()),/一致しません/);assert.deepEqual(f.read(),before);
 await f.editor.save({...c,stockId:''},f.options());assert.equal(f.read()['physical-stock'].state.products.length,4);
});
