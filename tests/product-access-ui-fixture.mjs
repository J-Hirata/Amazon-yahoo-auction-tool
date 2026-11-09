// In-memory browser verification only. No credentials, real DB or marketplace writes.
import http from 'node:http';import {Readable} from 'node:stream';import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {createCloudHandler} from '../src/cloud-handler.js';import {loadCloudAssets} from '../src/cloud-runtime.js';
import {emptyMonitor,registerPageLink} from '../src/link-monitor.js';import {emptyPhysicalStock,applyStockCommand} from '../src/physical-stock.js';import {emptySalesPlanning,applyPlanningCommand} from '../src/sales-planning.js';import {createCloudStock} from '../src/cloud-stock.js';import {createCloudPlanning} from '../src/cloud-planning.js';import {createProductOverview,emptyProductWatch} from '../src/product-overview.js';import {createProductLinkEditor} from '../src/product-link-editor.js';
const at=new Date().toISOString(),actor='fixture',monitor=emptyMonitor(),physical=emptyPhysicalStock(),planningState=emptySalesPlanning(),watch=emptyProductWatch(),stockId=randomUUID(),blankId=randomUUID(),planId=randomUUID();
const link=registerPageLink(monitor,{amazon:'B000TEST01',yahoo:'https://auctions.yahoo.co.jp/jp/auction/d1000000001',submitted:true},at);monitor.listings[0].title='隔離テスト・URL確認モニター';Object.assign(monitor,{amazonAccountKey:'fixture',amazonSellerId:'OWN'});
applyStockCommand(physical,{operationId:randomUUID(),kind:'create',productId:stockId,product:{title:'隔離テスト・URL確認モニター',asin:'B000TEST01',condition:'used',unit:'台',linkedLinkIds:[link.id]},initialCounts:{container:50,home:1}},{actor,at});
applyStockCommand(physical,{operationId:randomUUID(),kind:'create',productId:blankId,product:{title:'隔離テスト・URL未登録の商品',asin:'',condition:'used',unit:'個'},initialCounts:{container:null,home:null}},{actor,at});
applyPlanningCommand(planningState,{operationId:randomUUID(),kind:'create',planId,plan:{title:'隔離テスト・販売計画のURL登録',asin:'B000TEST02',condition:'used',source:{kind:'manual',id:''},kind:'amazon',status:'active',durationDays:10,availableOn:at.slice(0,10),decisions:['yahoo'],note:'日付と方針を保全する'}},{actor,at});
monitor.salesTargets={targets:[{sourceId:'stock:'+stockId,asin:'B000TEST01',sellerSku:'SKU',fulfillment:['AMAZON']},{sourceId:'link:'+link.id,asin:'B000TEST01',sellerSku:'SKU',fulfillment:['AMAZON']}],listingSnapshot:{status:'complete',source:'own_seller_listings',accountKey:'fixture',sellerId:'OWN',marketplaceId:'A1VC38T7YXB528',asins:['B000TEST01'],checkedAt:at,rows:[{asin:'B000TEST01',sellerSku:'SKU',condition:'used_good',statuses:['BUYABLE'],fulfillment:[{channel:'AMAZON_JP',quantity:12}]}]}};
watch.observations={job:{status:'partial',finishedAt:at},fba:{status:'complete',complete:true,accountKey:'fixture',sellerId:'OWN',asins:['B000TEST01'],checkedAt:at,items:[{asin:'B000TEST01',sellerSku:'SKU',condition:'UsedGood',fulfillableQuantity:12}]},yahoo:[{listingId:link.listingId,verified:true,status:'active',quantity:15,saleType:'fixed',checkedAt:at}]};
link.amazonSellerSku='SKU';physical.products[0].sellerSku='SKU';
const ended=registerPageLink(monitor,{amazon:'B000TEST03',yahoo:'https://auctions.yahoo.co.jp/jp/auction/d1000000003',submitted:true},at),unknown=registerPageLink(monitor,{amazon:'B000TEST04',yahoo:'https://auctions.yahoo.co.jp/jp/auction/d1000000004',submitted:true},at);
for(const [l,name,sku,quantity] of [[ended,'隔離テスト・出品終了','ENDED',4],[unknown,'隔離テスト・取得失敗','UNKNOWN',2]]){
 l.amazonSellerSku=sku;monitor.listings.find(y=>y.listingId===l.listingId).title=name;
 watch.observations.fba.asins.push(l.asin);watch.observations.fba.items.push({asin:l.asin,sellerSku:sku,condition:'UsedVeryGood',fulfillableQuantity:quantity});
 monitor.salesTargets.listingSnapshot.asins.push(l.asin);monitor.salesTargets.listingSnapshot.rows.push({asin:l.asin,sellerSku:sku,condition:'used_very_good',statuses:['BUYABLE'],fulfillment:[{channel:'AMAZON_JP',quantity}]});
}
watch.observations.yahoo.push({listingId:ended.listingId,status:'ended',verified:true,quantity:6,checkedAt:at},{listingId:unknown.listingId,status:'unknown',verified:false,checkedAt:at});
watch.observations.fba.items.push({asin:'B000TEST01',sellerSku:'SKU-VERY-GOOD',condition:'UsedVeryGood',fulfillableQuantity:3});
monitor.salesTargets.listingSnapshot.rows.push({asin:'B000TEST01',sellerSku:'SKU-VERY-GOOD',condition:'used_very_good',statuses:['BUYABLE'],fulfillment:[{channel:'AMAZON_JP',quantity:3}]});
const mismatchId=randomUUID();
applyStockCommand(physical,{operationId:randomUUID(),kind:'create',productId:mismatchId,product:{title:'隔離テスト・SKU不一致',asin:'B000TEST01',sellerSku:'SKU-VERY-GOOD',condition:'used',unit:'個',linkedLinkIds:[link.id]},initialCounts:{container:2,home:0}},{actor,at});
if(process.env.OVERVIEW_COMPACT_FIXTURE==='1')for(let i=10;i<50;i++)applyStockCommand(physical,{operationId:randomUUID(),kind:'create',productId:randomUUID(),product:{title:'確認用モニター '+i,asin:'B'+String(i).padStart(9,'0'),condition:'used',unit:'個',memo:'隔離した表示確認データ'},initialCounts:{container:i,home:i%3}},{actor,at});
if(process.env.OVERVIEW_COMPACT_FIXTURE==='1')monitor.yahooRelisting={checkedAt:at,adopted:0,status:'complete',pending:[{linkId:link.id,previousId:link.listingId,listingId:'d1000000088',title:'隔離テスト・再出品候補',quantity:5}]};
let docs={'link-monitor':{state:monitor,revision:0},'physical-stock':{state:physical,revision:0},'sales-planning':{state:planningState,revision:0},'draft-items':{state:[],revision:0}},watchRevision=0;
if(process.env.WORKSPACE_FIXTURE==='1'){
  physical.products[0].fbaEligibility='not_possible';
  const id=randomUUID(),asin='B000TEST05',sellerSku='RESERVE-SKU';
  applyStockCommand(physical,{operationId:randomUUID(),kind:'create',productId:id,product:{title:'隔離テスト・補充用在庫',asin,condition:'used',unit:'個',fbaEligibility:'possible'},initialCounts:{container:15,home:1}},{actor,at});
  for(const [listingId,quantity] of [['d1000000005',5],['d1000000006',9]]){
    const l=registerPageLink(monitor,{amazon:asin,yahoo:'https://auctions.yahoo.co.jp/jp/auction/'+listingId,submitted:true},at);
    monitor.listings.find(y=>y.listingId===listingId).title='隔離テスト・共有するモニター '+quantity;
    watch.observations.yahoo.push({listingId:l.listingId,status:'active',verified:true,quantity,checkedAt:at});
  }
  watch.observations.fba.asins.push(asin);watch.observations.fba.items.push({asin,sellerSku,condition:'UsedGood',fulfillableQuantity:8});
  monitor.salesTargets.listingSnapshot.asins.push(asin);monitor.salesTargets.listingSnapshot.rows.push({asin,sellerSku,condition:'used_good',statuses:['BUYABLE'],fulfillment:[{channel:'AMAZON_JP',quantity:8}]});
}
if(process.env.AMAZON_STATUS_FIXTURE==='1'){
 const bookAsin='B000BOOK01',merchantAsin='B000FBMS01';
 for(const [asin,title,condition,counts] of [[bookAsin,'隔離テスト・新品の販売中書籍','new',{container:150,home:null}],[merchantAsin,'隔離テスト・自己発送モニター','used',{container:3,home:1}]]){
  applyStockCommand(physical,{operationId:randomUUID(),kind:'create',productId:randomUUID(),product:{title,asin,condition,unit:'個',memo:'元のメモを保全',fbaEligibility:condition==='new'?'possible':'not_possible'},initialCounts:counts},{actor,at});
  watch.observations.fba.asins.push(asin);monitor.salesTargets.listingSnapshot.asins.push(asin);
 }
 for(const [sellerSku,condition,quantity,sellable] of [['NEW-ACTIVE','new_new',97,true],['NEW-OLD','new_new',0,false],['USED-OTHER','used_like_new',6,true]]){
  watch.observations.fba.items.push({asin:bookAsin,sellerSku,condition,fulfillableQuantity:quantity});
  monitor.salesTargets.listingSnapshot.rows.push({asin:bookAsin,sellerSku,condition,statuses:[sellable?'BUYABLE':'DISCOVERABLE'],fulfillment:[{channel:'AMAZON_JP',quantity:0}]});
 }
 monitor.salesTargets.listingSnapshot.rows.push({asin:merchantAsin,sellerSku:'FBM-SKU',condition:'used_good',statuses:['BUYABLE'],fulfillment:[{channel:'DEFAULT',quantity:2}]});
 watch.observations.fba.items.push({asin:merchantAsin,sellerSku:'FBM-SKU',condition:'UsedGood',fulfillableQuantity:0});
}
if(process.env.REVIEW_PICKER_FIXTURE==='1'){
 const reserve=physical.products.find(p=>p.asin==='B000TEST05');reserve.memo='コンテナ確認 脚なしか？ あれば補充';reserve.imageUrl='https://m.media-amazon.com/images/I/fixture.jpg';
 for(const link of monitor.links.filter(l=>l.asin===reserve.asin))monitor.listings.find(y=>y.listingId===link.listingId).imageUrl=reserve.imageUrl;
 const reviewLink=registerPageLink(monitor,{amazon:'B000TEST02',yahoo:'https://auctions.yahoo.co.jp/jp/auction/d1000000012',submitted:true},at);monitor.listings.find(y=>y.listingId===reviewLink.listingId).title='隔離テスト・見直しに既存出品';
}
if(process.env.DENSE_PLANNING_FIXTURE==='1')for(let i=1;i<30;i++){
 applyPlanningCommand(planningState,{operationId:randomUUID(),kind:'create',planId:randomUUID(),plan:{title:'隔離テスト・長い商品名でも写真と方針を見分けるモニター '+i,asin:'B000DENS'+String(i).padStart(2,'0'),condition:i%2?'used':'new',source:{kind:'manual',id:''},kind:'review',status:'active',durationDays:14,reviewOn:'2026-12-'+String(i).padStart(2,'0'),decisions:['advertising','yahoo'],note:'長い判断メモ。'.repeat(50),imageUrl:'https://m.media-amazon.com/images/I/fixture.jpg'}},{actor,at});
}
function store(key){return {read:async()=>structuredClone(docs[key].state),readSnapshot:async()=>structuredClone(docs[key]),update:async(fn,{expectedRevision}={})=>{if(expectedRevision!==undefined&&expectedRevision!==docs[key].revision)throw Object.assign(new Error('別の編集が保存されました'),{code:'STORAGE_CONFLICT'});const copy=structuredClone(docs[key].state),r=await fn(copy);docs[key]={state:copy,revision:docs[key].revision+1};return r;}};}
const transaction={read:async()=>structuredClone(docs),update:async fn=>{const copy=structuredClone(docs),r=await fn(copy);for(const key of Object.keys(copy))if(JSON.stringify(copy[key].state)!==JSON.stringify(docs[key].state))copy[key].revision++;docs=copy;return r;}},watchStore={read:async()=>structuredClone(watch),readSnapshot:async()=>({state:structuredClone(watch),revision:watchRevision})},monitorStore=store('link-monitor'),stockStore=store('physical-stock'),planningStore=store('sales-planning'),draftStore=store('draft-items');
watchStore.update=async(fn,{expectedRevision}={})=>{if(expectedRevision!==undefined&&expectedRevision!==watchRevision)throw Object.assign(new Error('Watch conflict'),{code:'STORAGE_CONFLICT'});const copy=structuredClone(watch),result=await fn(copy);Object.assign(watch,copy);watchRevision++;return result;};
const stock=createCloudStock({store:stockStore,monitorStore,draftStore,watchStore,registrationTransaction:transaction}),overview=createProductOverview({monitorStore,stockStore,planningStore,draftStore,watchStore}),planning=createCloudPlanning({store:planningStore,stock,monitorStore,overview}),productLinks=createProductLinkEditor({transaction,overview});
const assets=await loadCloudAssets(),nav=await build({entryPoints:['public/workspace-navigation.js'],bundle:true,write:false,format:'esm',platform:'browser',logLevel:'silent'});assets.set('/__fixture/nav.js',{type:'text/javascript',body:Buffer.concat([nav.outputFiles[0].contents,Buffer.from("\ndocument.querySelector('#fixtureNav').classList.add('cloud-account');")])});let handler,base;
const server=http.createServer(async(req,res)=>{try{if(['/', '/?view=stock','/?view=planning','/?view=overview'].includes(req.url)){const mode=new URL(req.url,'http://fixture.invalid').searchParams.get('view')||'links',file=mode==='stock'?'cloud-stock-view.html':mode==='planning'?'cloud-planning-view.html':mode==='overview'?'cloud-overview-view.html':'cloud-view.html',script=mode==='stock'?"import{openStock}from'/physical-stock.js';await openStock({userId:'fixture',readOnly:false});":mode==='planning'?"import{openPlanning}from'/sales-planning.js';await openPlanning({userId:'fixture',readOnly:false});":mode==='overview'?"import{openOverview}from'/product-overview.js';await openOverview({userId:'fixture',readOnly:false});":"import'/link-monitor.js';";res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>出品リンク・隔離確認</title>${['product-overview','product-access','styles','link-monitor','cloud-login','physical-stock','catalog-view','sales-planning'].map(n=>`<link rel="stylesheet" href="/${n}.css">`).join('')}<div id="cloudApp"><div id="fixtureNav" class="workspace-nav"></div>${String(assets.get('/'+file).body).replace('<main class="overview-shell">','<main class="overview-shell cockpit-content">')}</div><script type="module">import{workspaceNavigation}from'/__fixture/nav.js';document.querySelector('#fixtureNav').append(workspaceNavigation({stock:${mode==='stock'},planning:${mode==='planning'},overview:${mode==='overview'},physicalStock:true,salesPlanning:true,productOverview:true}));${script}</script></html>`);return;}
 if(req.url==='/__fixture/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(docs));return;}
 if(req.url==='/__fixture/watch'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(watch));return;}
 const r=await handler(new Request(new URL(req.url,base),{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})}));res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch(e){res.writeHead(500);res.end('fixture failure');}});
server.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;handler=createCloudHandler({config:{origin:base,authUrl:'https://fixture.invalid',readOnly:false},store:monitorStore,stock,planning,overview,productLinks,assets,verifyOwner:async()=>({status:200,userId:actor})});console.log(JSON.stringify({url:base,externalWrites:0}));});
