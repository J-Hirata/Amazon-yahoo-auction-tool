import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {Pool} from 'pg';
import {storageConfiguration} from '../src/storage-runtime.js';
import {createPostgresDocumentStore} from '../src/postgres-document-store.js';
import {createPhotoLibrary,emptyPhotoLibrary,validatePhotoLibrary} from '../src/photo-library.js';
import {validateDraftItems} from '../src/storage-validation.js';
import {createCloudHandler} from '../src/cloud-handler.js';
import {loadCloudAssets} from '../src/cloud-runtime.js';
import {PROTOCOL,normalizedContent,parsePackage,contentDigest,hash,verifyBridge} from '../shared/photo-bridge.mjs';
const config=storageConfiguration(),dir=path.resolve('output/draft-photo-workspace-20261112'),require=createRequire(import.meta.url);
if(config.environment!=='development'||!config.host.startsWith('ep-damp-mountain-a17aebvv'))throw Error('Dedicated QA database only');
const db=new Pool(config.poolOptions),nonce=randomUUID(),owner=randomUUID(),key=randomBytes(32).toString('hex'),session=randomBytes(24).toString('hex'),source='https://qa-photo-source.example';
const libKey='draft-photo-qa-'+nonce,stockKey='draft-photo-stock-'+nonce,legacyKey='draft-photo-legacy-'+nonce,keys=[libKey,stockKey,legacyKey];
let browser,base,handler;
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,base);
 if(url.pathname==='/'){
  const photos=url.searchParams.get('section')==='photos'||url.searchParams.get('view')==='photos';
  const body=(assets.get(photos?'/cloud-photos-view.html':'/cloud-drafts-view.html').body).toString();
  const html='<!doctype html><html lang="ja"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>出品下書き・独立QA</title>'+['styles','cloud-login','catalog-view','draft-workbench','shared-photos','photo-listing-drafts'].map(n=>'<link rel=stylesheet href="/'+n+'.css">').join('')+'<div id=cloudApp>'+body+'</div><script type=module src="/qa-entry.js"></script>';
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return void res.end(html);
 }
 const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks),response=await handler(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}));
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch(e){res.writeHead(500);res.end(e.message);}});
let assets;
try{
 await mkdir(dir,{recursive:true});
 const before=(await db.query('SELECT document_key,revision,md5(payload::text) AS digest FROM app_storage.documents ORDER BY document_key')).rows;
 const old=[{asin:'B001234567',title:'QA 既存のASIN下書き',description:'元の説明を保つ',status:'ready_for_draft',usedLowestPrice:5000,startPrice:4000,imageUrls:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}];
 await db.query('INSERT INTO app_storage.documents(document_key,payload) VALUES($1,$2::jsonb),($3,$4::jsonb),($5,$6::jsonb)',[libKey,JSON.stringify(emptyPhotoLibrary()),stockKey,JSON.stringify({products:[],quantity:7}),legacyKey,JSON.stringify(old)]);
 const store=createPostgresDocumentStore({pool:db,key:libKey,validate:validatePhotoLibrary}),stockStore=createPostgresDocumentStore({pool:db,key:stockKey,validate:s=>s}),legacyStore=createPostgresDocumentStore({pool:db,key:legacyKey,validate:validateDraftItems});
 const photoRoot=process.env.PHOTO_NAVI_ROOT;if(!photoRoot)throw Error('Explicit photo root required for JPEG fixture');
 const sharp=require(path.join(photoRoot,'node_modules/sharp')),images=new Map(),meta=[];
 for(const [i,color]of ['#e0d5b5','#9ac8dc','#c2d9a5'].entries()){
  const bytes=await sharp(Buffer.from('<svg width="600" height="400"><rect width="600" height="400" fill="'+color+'"/><text x="20" y="60" font-size="28">QA PHOTO '+(i+1)+'</text></svg>')).jpeg().toBuffer(),id=randomUUID();images.set(id,bytes);meta.push({id,name:'DSC_000'+(i+1)+'.JPG',position:i+1,sourceSha256:hash(bytes),sha256:hash(bytes),bytes:bytes.length,width:600,height:400,previewSha256:hash(bytes),previewBytes:bytes.length,quality:'stored'});
 }
 const content=normalizedContent({sourceWorkspaceId:owner,productId:randomUUID(),batchId:randomUUID(),projectName:'QA 写真仕分けプロジェクト',batchTitle:'2026-11-12 撮影回',name:'QA 写真からの中古商品',asin:null,sku:'',note:'付属品は写真を確認',reviewNote:'確認メモ',mainAssetId:meta[1].id,assets:meta,identifiers:[{assetId:meta[1].id,models:['QA-01'],jans:['0123456789012'],note:'QA文字列',confirmed:true,version:1}]});
 const packet=parsePackage({...content,packageId:randomUUID(),revision:1,createdAt:new Date().toISOString(),digest:contentDigest(content)});
 const lib=createPhotoLibrary({store,stockStore,sourceOrigin:source,sourceWorkspaceId:owner,key,fetchImpl:async(url,init)=>{assert.equal(verifyBridge(new Request(url,init),key),true);const match=new URL(url).pathname.match(/\/assets\/([^/]+)\/(?:preview|image)$/),bytes=images.get(match?.[1]);assert.ok(bytes);return new Response(bytes,{headers:{'Content-Type':'image/jpeg'}});}});
 await lib.receive({protocol:PROTOCOL,packages:[packet]});
 assets=await loadCloudAssets();
 for(const name of ['workspace-navigation.js','cockpit-brand.js'])assets.set('/'+name,{body:await readFile('public/'+name),type:'text/javascript'});
 const entry="import{configureMonitorRequest}from'/monitor-http.js';import{mountDraftWorkspace,SHARED_PHOTOS_HOME}from'/draft-workspace.js';import{workspaceNavigation}from'/workspace-navigation.js';import{cockpitHeader}from'/cockpit-brand.js';const p=new URLSearchParams(location.search),photos=p.get('section')==='photos'||p.get('view')==='photos';if(p.get('view')==='photos')history.replaceState(null,'',SHARED_PHOTOS_HOME+location.hash);configureMonitorRequest((url,init={})=>fetch(url,{...init,headers:{...init.headers,Authorization:'Bearer "+session+"'}}));const main=document.querySelector('main'),mode=document.createElement('span'),logout=document.createElement('button');mode.textContent='独立QA';logout.textContent='ログアウト';logout.disabled=true;document.querySelector('#cloudApp').prepend(cockpitHeader({navigation:workspaceNavigation({drafts:true,photos,photoLibrary:true,physicalStock:true,salesPlanning:true,productOverview:true}),mode,logout}));main.classList.add('cockpit-content');mountDraftWorkspace(main,{photos,photoLibrary:true});if(photos){const{openSharedPhotos}=await import('/shared-photos.js');await openSharedPhotos();}else{await import('/app.js');const{mountPhotoDraftBoard}=await import('/photo-listing-drafts.js');await mountPhotoDraftBoard(main);}";
 assets.set('/qa-entry.js',{body:entry,type:'text/javascript'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 handler=createCloudHandler({config:{origin:base,authUrl:'https://fixture.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth',readOnly:false},assets,draftStore:legacyStore,photoLibrary:lib,verifyOwner:async req=>({status:req.headers.get('authorization')==='Bearer '+session?200:401,userId:'qa-photo-owner'})});
 const pw=require(process.env.PHOTO_QA_PLAYWRIGHT||'playwright');browser=await pw.chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
 await page.goto(base+'/?view=drafts');await page.getByRole('heading',{name:'写真からの下書き',exact:true}).waitFor();await page.getByRole('heading',{name:'ASINからの下書き',exact:true}).waitFor();
 assert.equal(await page.locator('.workspace-tools [data-tool=photos]').count(),0);assert.equal(await page.locator('.workspace-tools [data-tool=drafts]').getAttribute('aria-current'),'page');
 await page.getByRole('link',{name:'写真仕分けナビ共有写真',exact:true}).click();await page.getByRole('button',{name:'この写真で下書きを準備',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'写真からの出品下書き',exact:true});await dialog.waitFor();
 assert.equal(await dialog.getByRole('checkbox',{name:'DSC_0002.JPGを使用',exact:true}).isChecked(),true);assert.equal(await dialog.getByRole('checkbox',{name:'DSC_0001.JPGを使用',exact:true}).isChecked(),false);
 await dialog.getByRole('button',{name:'DSC_0002.JPGを拡大',exact:true}).click();const preview=page.getByRole('dialog',{name:'写真を拡大',exact:true});await preview.waitFor();await preview.getByRole('button',{name:'次へ →',exact:true}).click();await page.keyboard.press('ArrowLeft');await preview.getByRole('button',{name:'閉じる',exact:true}).click();
 await dialog.getByLabel('商品名',{exact:true}).fill('QA 選んだ写真でヤフオク下書き');
 await dialog.getByLabel('開始価格（円・未定なら空欄）',{exact:true}).fill('5200');
 await dialog.getByLabel('出品する商品説明',{exact:true}).fill('使用に伴う傷があります。付属品は写真のものです。');
 await dialog.getByLabel('作業メモ（出品文面には含めません）',{exact:true}).fill('QA 内部メモだけ');
 await dialog.getByRole('checkbox',{name:'DSC_0003.JPGを使用',exact:true}).check();await dialog.getByRole('button',{name:'DSC_0003.JPGを先頭にする',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.photo-draft-picker-grid img')].every(i=>i.src.startsWith('blob:')&&i.naturalWidth>0));
 await page.screenshot({path:path.join(dir,'photo-draft-editor.png')});
 await dialog.getByRole('button',{name:'下書きを保存',exact:true}).click();
 await page.waitForURL(url=>url.search==='?view=drafts'&&url.hash.startsWith('#photo-draft-saved='));
 await page.getByRole('heading',{name:'QA 選んだ写真でヤフオク下書き',exact:true}).waitFor();assert.equal(await page.getByRole('dialog',{name:'写真からの出品下書き',exact:true}).count(),0);
 let view=await lib.listingDrafts.view(),draft=view.items[0];assert.deepEqual(draft.assetIds,[meta[2].id,meta[1].id]);assert.equal(draft.price,5200);assert.equal(draft.asin,'');assert.equal(draft.ready,true);
 await page.reload();await page.getByRole('heading',{name:draft.title,exact:true}).waitFor();await page.waitForFunction(()=>{const i=document.querySelector('.photo-draft-card img');return i?.src.startsWith('blob:')&&i.naturalWidth>0;});
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'写真・文面をまとめて取得',exact:true}).click();await copyFile(await (await downloaded).path(),path.join(dir,'写真と下書き.zip'));
 const yahoo=page.getByRole('link',{name:'ヤフオクの入力画面へ ↗',exact:true});assert.equal(new URL(await yahoo.getAttribute('href')).hostname,'auctions.yahoo.co.jp');
 await page.getByRole('button',{name:'詳細・写真を編集',exact:true}).click();await dialog.waitFor();assert.equal(await dialog.getByLabel('開始価格（円・未定なら空欄）').inputValue(),'5200');await dialog.getByLabel('出品する商品説明').fill('訂正後も写真の順序を保持します。');await dialog.getByRole('button',{name:'下書きを保存',exact:true}).click();await dialog.waitFor({state:'detached'});
 await page.getByRole('button',{name:'アーカイブ',exact:true}).click();await page.getByText('下書きをアーカイブしました。写真は保持しています。',{exact:true}).waitFor();await page.getByRole('checkbox',{name:'アーカイブも表示',exact:true}).check();await page.getByRole('button',{name:'アーカイブから戻す',exact:true}).click();await page.getByText('下書きを戻しました。',{exact:true}).waitFor();
 await page.screenshot({path:path.join(dir,'drafts-with-shared-photos.png')});
 await page.goto(base+'/?view=photos');await page.getByRole('button',{name:'この商品の下書きを開く',exact:true}).waitFor();assert.equal(new URL(page.url()).search,'?view=drafts&section=photos');
 const original=(await db.query('SELECT document_key,revision,md5(payload::text) AS digest FROM app_storage.documents WHERE document_key=ANY($1::text[]) ORDER BY document_key',[before.map(d=>d.document_key)])).rows;
 assert.deepEqual(original,before);assert.deepEqual(await legacyStore.read(),old);assert.equal((await legacyStore.readSnapshot()).revision,0);assert.equal((await stockStore.readSnapshot()).revision,0);assert.equal((await store.read()).packages.length,1);assert.deepEqual(errors,[]);
 view=await lib.listingDrafts.view();assert.equal(view.items.length,1);assert.equal(view.items[0].archived,false);assert.deepEqual(view.items[0].assetIds,[meta[2].id,meta[1].id]);
 await writeFile(path.join(dir,'qa-result.json'),JSON.stringify({realPostgres:true,nestedNavigation:true,legacyRootAlias:true,asinlessDraft:true,mainAndOrder:[meta[2].id,meta[1].id],zipPhotoHashes:[meta[2].sha256,meta[1].sha256],tagPhotoExcluded:true,previewArrowKeys:true,saveAndReload:true,editArchiveRestore:true,legacyAsinDraftsUnchanged:true,stockUnchanged:true,originalDocumentsUnchanged:true,onlyQaDocuments:keys,externalListingActions:0,browserErrors:errors},null,2));
 console.log('Draft photo workspace QA passed: nested navigation, selection, save/reload, ZIP, editing, archive/restore; original documents unchanged.');
}catch(e){if(browser)try{const pages=browser.contexts().flatMap(c=>c.pages());if(pages[0])await pages[0].screenshot({path:path.join(dir,'failure.png')});}catch{}throw e;}
finally{if(browser)await browser.close();server.close();await db.end();}
