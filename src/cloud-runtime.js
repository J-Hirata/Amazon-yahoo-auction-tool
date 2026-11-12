import {createDraftCatalog} from './draft-catalog.js';
import {createYahooRelisting} from './yahoo-relisting.js';
import {createYahooMailReader} from './yahoo-mail-reader.js';
import {fetchYahooListing} from './yahoo-observation.js';
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {cloudConfiguration, createOwnerVerifier, createIdentityVerifier} from "./cloud-auth.js";
import {storageConfiguration, databasePool} from "./storage-runtime.js";
import {validateSalesPlanning} from "./sales-planning.js";
import {createCloudPlanning} from "./cloud-planning.js";
import {createPostgresDocumentStore,createDocumentTransaction} from "./postgres-document-store.js";
import {createProductLinkEditor} from "./product-link-editor.js";
import {validateMonitorState, validateDraftItems} from "./storage-validation.js";
import {createCloudHandler} from "./cloud-handler.js";
import {createOwnerAccess} from "./owner-access.js";
import {cloudAmazonConfig} from "./amazon-fba-reader.js";
import {createCloudFba} from "./cloud-fba.js";
import {createCloudSales} from "./cloud-sales.js";
import {cloudMailConfig, createCloudMailTransport, createCloudMail} from "./cloud-mail.js";
import {validatePhysicalStock} from "./physical-stock.js";
import {createCloudStock} from "./cloud-stock.js";
import {createStockPhotoRefresh} from "./cloud-stock-photos.js";
import {createStockAmazonRefresh,readOwnAmazonListings} from "./stock-amazon-listings.js";
import {readPlanningCatalog} from "./planning-catalog.js";
import {resolveSalesSources} from "./sales-sources.js";
import {withMerchantSalesSources} from './merchant-relations.js';
import {createCloudSalesAutomation} from "./cloud-sales-automation.js";
import {createProductOverview,validateProductWatch} from "./product-overview.js";
import {createProductMonitoring} from "./product-monitoring.js";
import {createPhotoLibrary,validatePhotoLibrary} from './photo-library.js';

const fileTypes = {
  "draft-workspace.js":"text/javascript; charset=utf-8","photo-listing-drafts.js":"text/javascript; charset=utf-8","photo-listing-drafts.css":"text/css; charset=utf-8","photo-draft-zip.js":"text/javascript; charset=utf-8",
  "cloud-photos-view.html":"text/html; charset=utf-8","shared-photos.js":"text/javascript; charset=utf-8","shared-photo-images.js":"text/javascript; charset=utf-8","shared-photos.css":"text/css; charset=utf-8",
  "product-workspace.js":"text/javascript; charset=utf-8",
  "product-workspace-editor.js":"text/javascript; charset=utf-8","product-access.js":"text/javascript; charset=utf-8","inventory-panel.js":"text/javascript; charset=utf-8","product-access.css":"text/css; charset=utf-8",
  "cloud-overview-view.html":"text/html; charset=utf-8","overview-filters.js":"text/javascript; charset=utf-8", "product-overview.js":"text/javascript; charset=utf-8","product-overview.css":"text/css; charset=utf-8",
  "sales-planning.js":"text/javascript; charset=utf-8", "sales-planning.css":"text/css; charset=utf-8", "cloud-planning-view.html":"text/html; charset=utf-8",
  "cloud-login.html": "text/html; charset=utf-8", "cloud-view.html": "text/html; charset=utf-8", "cloud-drafts-view.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "demo.html": "text/html; charset=utf-8", "cloud-demo.js": "text/javascript; charset=utf-8",
  "cloud-login.js": "text/javascript; charset=utf-8", "monitor-http.js": "text/javascript; charset=utf-8", "link-monitor.js": "text/javascript; charset=utf-8",
  "cloud-stock-view.html": "text/html; charset=utf-8", "physical-stock.js": "text/javascript; charset=utf-8", "physical-stock.css": "text/css; charset=utf-8",
  "draft-board.js":"text/javascript; charset=utf-8","draft-workbench.css":"text/css; charset=utf-8","fba-status.js":"text/javascript; charset=utf-8","extension-helper.html":"text/html; charset=utf-8","chrome-extension.zip":"application/zip",
  "tile-size.js":"text/javascript; charset=utf-8", "fba-alarm.js":"text/javascript; charset=utf-8",
  "catalog-view.js":"text/javascript; charset=utf-8", "catalog-view.css":"text/css; charset=utf-8", "catalog-list.svg":"image/svg+xml", "catalog-tiles.svg":"image/svg+xml", "catalog-image.svg":"image/svg+xml",
  "catalog-sortable.js":"text/javascript; charset=utf-8", "catalog-grip.svg":"image/svg+xml", "catalog-prev.svg":"image/svg+xml", "catalog-next.svg":"image/svg+xml",
  "cloud-login.css": "text/css; charset=utf-8", "link-monitor.css": "text/css; charset=utf-8", "styles.css": "text/css; charset=utf-8", "extension-logo.png": "image/png",
  "workspace-drafts.png":"image/png","workspace-stock.png":"image/png","workspace-planning.png":"image/png","workspace-overview.png":"image/png","cockpit-mark.svg":"image/svg+xml"
};
export async function loadCloudAssets(directory = fileURLToPath(new URL("../dist/cloud/", import.meta.url))) {
  const assets = new Map();
  for (const [name, type] of Object.entries(fileTypes)) assets.set(`/${name}`, {body: await readFile(path.join(directory, name)), type});
  assets.set("/", assets.get("/cloud-login.html"));
  assets.set("/link-monitor.html", assets.get("/cloud-login.html"));
  return assets;
}
export async function createCloudRuntime({assetDirectory, env = process.env} = {}) {
  const config = cloudConfiguration(env);
  if (storageConfiguration().backend !== "postgres") throw new Error("クラウド版は専用DB保存が必要です。JSONへは接続しません");
  const pool = databasePool();
  const store = createPostgresDocumentStore({pool, key: "link-monitor", validate: validateMonitorState});
  const draftStore = config.fullWorkspace ? createPostgresDocumentStore({pool, key: "draft-items", validate: validateDraftItems}) : undefined;
  const stockStore = config.fullWorkspace ? createPostgresDocumentStore({pool, key: "physical-stock", validate: validatePhysicalStock}) : undefined;
  const planningStore=config.fullWorkspace?createPostgresDocumentStore({pool,key:"sales-planning",validate:validateSalesPlanning}):undefined;
  const watchStore=config.fullWorkspace?createPostgresDocumentStore({pool,key:"product-watch",validate:validateProductWatch}):undefined;
  const draftCatalog=draftStore?createDraftCatalog({store:draftStore,monitorStore:store,stockStore,planningStore,readOnly:config.readOnly,readCatalog:env.ASIN_AMAZON_CLIENT_ID?asin=>readPlanningCatalog({asin,config:cloudAmazonConfig(env)}):undefined}):undefined;
  const stock = stockStore ? createCloudStock({store: stockStore, monitorStore: store, draftStore,watchStore,registrationTransaction:createDocumentTransaction({pool,validators:{"link-monitor":validateMonitorState,"physical-stock":validatePhysicalStock,"sales-planning":validateSalesPlanning,"draft-items":validateDraftItems,"product-watch":validateProductWatch}})}) : undefined;
  const overview=watchStore?createProductOverview({monitorStore:store,stockStore,planningStore,draftStore,watchStore,ruleTransaction:createDocumentTransaction({pool,validators:{"link-monitor":validateMonitorState,"physical-stock":validatePhysicalStock,"sales-planning":validateSalesPlanning,"draft-items":validateDraftItems,"product-watch":validateProductWatch}})}):undefined;
  const planning=planningStore?createCloudPlanning({store:planningStore,stock,monitorStore:store,overview,
    readCatalog:env.ASIN_AMAZON_CLIENT_ID?asin=>readPlanningCatalog({asin,config:cloudAmazonConfig(env)}):undefined}):undefined;
  const stockPhotos = stockStore && env.ASIN_AMAZON_CLIENT_ID ? createStockPhotoRefresh({store: stockStore, config: cloudAmazonConfig(env)}) : undefined;
  const stockAmazon = stockStore && env.ASIN_AMAZON_CLIENT_ID ? createStockAmazonRefresh({store:stockStore,monitorStore:store,config:cloudAmazonConfig(env)}) : undefined;
  const photoLibrary=config.fullWorkspace&&env.PHOTO_BRIDGE_KEY&&env.PHOTO_BRIDGE_SOURCE_ORIGIN&&env.PHOTO_BRIDGE_WORKSPACE_ID?createPhotoLibrary({store:createPostgresDocumentStore({pool,key:'photo-library',validate:validatePhotoLibrary}),stockStore,sourceOrigin:env.PHOTO_BRIDGE_SOURCE_ORIGIN,sourceWorkspaceId:env.PHOTO_BRIDGE_WORKSPACE_ID,key:env.PHOTO_BRIDGE_KEY,linkTransaction:createDocumentTransaction({pool,validators:{'photo-library':validatePhotoLibrary,'physical-stock':validatePhysicalStock}}),allowLocal:env.PHOTO_BRIDGE_ALLOW_LOCAL==='1'}):undefined;
  const ownerAccess = config.ownerFromDatabase ? createOwnerAccess({pool}) : undefined;
  const fba = env.ASIN_AMAZON_CLIENT_ID ? createCloudFba({store, config: cloudAmazonConfig(env)}) : undefined;
  const readTargets=async()=>{
    const [monitor,physical,plans,watch,drafts]=await Promise.all([store.read(),stockStore?.read(),planningStore?.read(),watchStore?.read(),draftStore?.read()]);
    let sources=monitor.links.filter(l=>l.verified&&!l.observationConflict).map(l=>{const p=monitor.catalog.find(p=>p.id===l.catalogId),y=monitor.listings.find(y=>y.listingId===l.listingId);return{sourceId:`link:${l.id}`,linkId:l.id,asin:l.asin || p?.asin,sellerSku:l.amazonSellerSku||(l.matchBy==="asin"?"":p?.sellerSku),title:y?.title || p?.title,condition:l.matchBy==="asin"?"unknown":/^new/i.test(p?.condition || "")?"new":/^used/i.test(p?.condition || "")?"used":"unknown"};});
    for(const p of physical?.products || [])if(p.asin)sources.push({sourceId:`stock:${p.id}`,asin:p.asin,sellerSku:p.sellerSku,title:p.title,condition:p.condition});
    for(const p of plans?.plans || [])if(p.asin)sources.push({sourceId:`plan:${p.id}`,asin:p.asin,sellerSku:p.sellerSku,title:p.title,condition:p.condition});
    for(const p of watch?.rules || [])if(p.key.startsWith("watch:")&&p.asin)sources.push({sourceId:p.key,asin:p.asin,sellerSku:p.sellerSku,title:p.title,condition:p.condition});
    sources=withMerchantSalesSources(sources,monitor,drafts||[]);
    const asins=[...new Set(sources.map(s=>s.asin).filter(a=>/^[A-Z0-9]{10}$/.test(a)))];
    if(!asins.length)throw new Error("追跡するASINを登録してください");
    const amazon=cloudAmazonConfig(env),rows=[];
    let snapshot;
    for(let i=0;i<asins.length;i+=20){snapshot=await readOwnAmazonListings({asins:asins.slice(i,i+20),config:amazon});rows.push(...snapshot.rows);}
    return resolveSalesSources(sources.filter(s=>asins.includes(s.asin)),{...snapshot,asins,rows},amazon);
  };
  const sales = env.ASIN_AMAZON_CLIENT_ID ? createCloudSales({store, config: cloudAmazonConfig(env),readTargets}) : undefined;
  const transport=env.ASIN_GMAIL_USER ? createCloudMailTransport(cloudMailConfig(env)) : undefined;
  const mail = transport ? createCloudMail({store,transport}) : undefined;
  const monitoring=overview&&env.ASIN_AMAZON_CLIENT_ID?createProductMonitoring({overview,watchStore,config:cloudAmazonConfig(env),readListings:readOwnAmazonListings,followRelistings:env.ASIN_GMAIL_USER?createYahooRelisting({store,readMails:createYahooMailReader(cloudMailConfig(env)),readListing:fetchYahooListing}):undefined}):undefined;
  const productLinks=overview?createProductLinkEditor({transaction:createDocumentTransaction({pool,validators:{"link-monitor":validateMonitorState,"physical-stock":validatePhysicalStock,"sales-planning":validateSalesPlanning,"product-watch":validateProductWatch,"draft-items":validateDraftItems}}),overview,readMerchantListings:env.ASIN_AMAZON_CLIENT_ID?readOwnAmazonListings:undefined,amazonConfig:env.ASIN_AMAZON_CLIENT_ID?cloudAmazonConfig(env):undefined,refresh:monitoring?(options={})=>monitoring.run({inventoryOnly:options.inventoryOnly===true,refreshListings:true,settings:{stockAlerts:false,yahooAlerts:false,reviewAlerts:false,errorAlerts:false}}):undefined}):undefined;
  const automation=sales && transport ? createCloudSalesAutomation({store,sales,transport,monitoring,readAlertStates:monitoring?.alertStates,readAlertContext:monitoring?.deliveryContext,readInventory:overview?()=>overview.view():undefined}) : undefined;
  const handler = createCloudHandler({config, store, draftStore, draftCatalog, stock, stockPhotos, stockAmazon, planning, overview, photoLibrary, photoBridgeKey:env.PHOTO_BRIDGE_KEY, ownerAccess, fba, mail, sales, automation, verifyIdentity: createIdentityVerifier(config), assets: await loadCloudAssets(assetDirectory),
    productLinks,verifyOwner: createOwnerVerifier({...config, ...(ownerAccess ? {resolveOwnerUserId: ownerAccess.ownerUserId} : {})})});
  return {config, handler, pool,sales,automation,overview,productLinks,runSalesAutomation:automation ? ()=>automation.run() : undefined};
}
