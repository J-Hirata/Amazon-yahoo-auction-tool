import test from'node:test';import assert from'node:assert/strict';import {fixture,at,asin}from'./relations-fixture.mjs';import{productOverview}from'../src/product-overview.js';
import {applyStockRegistration}from'../src/stock-registration.js';import{randomUUID}from'node:crypto';
test('link editor selects existing stock and plan, preserves every quantity and policy, and joins all four pages without duplicates',async()=>{
 const f=fixture(),old=f.read(),entries=(await f.editor.list()).entries,stock=entries['stock:'+f.stockId];
 assert.ok(entries['draft:'+asin]?.editor);assert.equal(entries['link:'+f.linkId].editor.candidates.length,2);assert.ok(entries['link:'+f.linkId].editor.candidates.some(c=>c.issue));
 const c=f.command('link:'+f.linkId,{stockId:f.stockId,planId:f.planId,registration:{stock:true,merchant:false,yahoo:true,draft:true,planning:true,yahooUrl:''}}),opt=f.options();
 await f.editor.preview(c,opt);assert.deepEqual(f.read(),old);await f.editor.save(c,opt);const d=f.read();
 assert.equal(d['physical-stock'].state.products.length,2);assert.equal(d['sales-planning'].state.plans.length,1);assert.equal(d['link-monitor'].state.links.length,1);assert.equal(d['draft-items'].state.length,1);
 assert.deepEqual(d['physical-stock'].state.balances,old['physical-stock'].state.balances);
 for(const k of['note','decisions','availableOn','durationDays','source','createdAt'])assert.deepEqual(d['sales-planning'].state.plans[0][k],old['sales-planning'].state.plans[0][k]);
 for(const k of['title','description','imageUrls','status','draftSavedAt','startPrice'])assert.deepEqual(d['draft-items'].state[0][k],old['draft-items'].state[0][k]);
 const after=(await f.editor.list()).entries;for(const k of['stock:'+f.stockId,'link:'+f.linkId,'plan:'+f.planId,'draft:'+asin]){assert.equal(after[k].editor.stockId,f.stockId);assert.equal(after[k].editor.plans.length,1);assert.equal(after[k].editor.drafts[0].associated,true);}
 await f.editor.save(c,opt);assert.deepEqual(f.read(),d);
});
test('draft and monitoring can select already registered stock and plan without recreating them',async()=>{
 for(const kind of['draft','plan']){const f=fixture(),old=f.read(),key=kind==='draft'?'draft:'+asin:'plan:'+f.planId;
 await f.editor.save(f.command(key,{stockId:f.stockId,linkIds:[f.linkId],planId:f.planId,registration:{stock:true,merchant:false,yahoo:true,draft:true,planning:true,yahooUrl:''}}),f.options());
 const d=f.read();assert.equal(d['physical-stock'].state.products.length,2);assert.equal(d['sales-planning'].state.plans.length,1);assert.deepEqual(d['physical-stock'].state.balances,old['physical-stock'].state.balances);assert.equal(d['draft-items'].state[0].description,'以前の手書き文面');
 }});
test('explicit listing mode never silently creates a draft; mismatched stock and plans roll back every document',async()=>{
 const f=fixture(),other=f.read()['physical-stock'].state.products[1].id;
 for(const c of[f.command('draft:'+asin,{registration:{stock:false,merchant:false,yahoo:true,draft:false,planning:false,yahooUrl:''}}),f.command('link:'+f.linkId,{stockId:other,registration:{stock:true,merchant:false,yahoo:true,draft:false,planning:false,yahooUrl:''}})]){const old=f.read();await assert.rejects(()=>f.editor.save(c,f.options()));assert.deepEqual(f.read(),old);}
});
test('saving again with a fresh operation uses the same related records and stale saves cannot create duplicates',async()=>{
 const f=fixture(),c=()=>f.command('stock:'+f.stockId,{linkIds:[f.linkId],planId:f.planId,registration:{stock:true,merchant:false,yahoo:true,draft:true,planning:true,yahooUrl:''}}),stale=f.options();await f.editor.save(c(),f.options());await f.editor.save(c(),f.options());const d=f.read();assert.equal(d['draft-items'].state.length,1);assert.equal(d['sales-planning'].state.plans.length,1);assert.equal(d['link-monitor'].state.links.length,1);await assert.rejects(()=>f.editor.save(c(),stale));assert.deepEqual(f.read(),d);
});
test('a new stock registration cannot duplicate existing stock and draft ASIN edits cannot silently create a second draft',async()=>{
 const f=fixture(),old=f.read(),product=old['physical-stock'].state.products[0];
 await assert.rejects(()=>f.transaction.update(d=>applyStockRegistration(d,{operationId:randomUUID(),kind:'create',productId:randomUUID(),product,initialCounts:{container:50,home:2},registration:{merchant:false,yahoo:false,draft:false,planning:false,yahooUrl:''}},{...f.options(),expectedRevision:old['physical-stock'].revision})),/在庫が登録済み/);assert.deepEqual(f.read(),old);
 await assert.rejects(()=>f.editor.save(f.command('draft:'+asin,{product:{asin:'B000OTHER1'}}),f.options()),/ASINは変更できません/);assert.deepEqual(f.read(),old);
});
test('unknown draft SKU cannot bridge incompatible known stock and listing SKUs, including an already registered URL',async()=>{
 const f=fixture(),old=f.read(),other=old['physical-stock'].state.products[1].id;
 for(const c of[f.command('draft:'+asin,{stockId:other,linkIds:[f.linkId],registration:{stock:true,merchant:false,yahoo:true,draft:true,planning:false,yahooUrl:''}}),f.command('stock:'+other,{registration:{stock:true,merchant:false,yahoo:true,draft:false,planning:false,yahooUrl:'https://auctions.yahoo.co.jp/jp/auction/h1248825083'}})]){await assert.rejects(()=>f.editor.save(c,f.options()),/紐付け先/);assert.deepEqual(f.read(),old);}
});
test('existing stock choices show same-ASIN cached reference photos without modifying saved products',async()=>{
 const f=fixture(),photo='https://m.media-amazon.com/images/I/reference.jpg';await f.transaction.update(d=>{d['draft-items'].state[0].imageUrls=[photo];});const old=f.read(),entry=(await f.editor.list()).entries['link:'+f.linkId];assert.ok(entry.editor.candidates.every(c=>c.imageUrl===photo));assert.deepEqual(f.read(),old);
});
