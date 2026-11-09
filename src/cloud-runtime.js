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
import {createCloudSalesAutomation} from "./cloud-sales-automation.js";
import {createProductOverview,validateProductWatch} from "./product-overview.js";
import {createProductMonitoring} from "./product-monitoring.js";

const fileTypes = {
  "product-workspace.js":"text/javascript; charset=utf-8",
  "product-access.js":"text/javascript; charset=utf-8","inventory-panel.js":"text/javascript; charset=utf-8","product-access.css":"text/css; charset=utf-8",
  "cloud-overview-view.html":"text/html; charset=utf-8","product-overview.js":"text/javascript; charset=utf-8","product-overview.css":"text/css; charset=utf-8",
  "sales-planning.js":"text/javascript; charset=utf-8", "sales-planning.css":"text/css; charset=utf-8", "cloud-planning-view.html":"text/html; charset=utf-8",
  "cloud-login.html": "text/html; charset=utf-8", "cloud-view.html": "text/html; charset=utf-8", "cloud-drafts-view.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "demo.html": "text/html; charset=utf-8", "cloud-demo.js": "text/javascript; charset=utf-8",
  "cloud-login.js": "text/javascript; charset=utf-8", "monitor-http.js": "text/javascript; charset=utf-8", "link-monitor.js": "text/javascript; charset=utf-8",
  "cloud-stock-view.html": "text/html; charset=utf-8", "physical-stock.js": "text/javascript; charset=utf-8", "physical-stock.css": "text/css; charset=utf-8",
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
  const stock = stockStore ? createCloudStock({store: stockStore, monitorStore: store, draftStore,watchStore}) : undefined;
  const overview=watchStore?createProductOverview({monitorStore:store,stockStore,planningStore,draftStore,watchStore}):undefined;
  const planning=planningStore?createCloudPlanning({store:planningStore,stock,monitorStore:store,overview,
    readCatalog:env.ASIN_AMAZON_CLIENT_ID?asin=>readPlanningCatalog({asin,config:cloudAmazonConfig(env)}):undefined}):undefined;
  const stockPhotos = stockStore && env.ASIN_AMAZON_CLIENT_ID ? createStockPhotoRefresh({store: stockStore, config: cloudAmazonConfig(env)}) : undefined;
  const stockAmazon = stockStore && env.ASIN_AMAZON_CLIENT_ID ? createStockAmazonRefresh({store:stockStore,monitorStore:store,config:cloudAmazonConfig(env)}) : undefined;
  const ownerAccess = config.ownerFromDatabase ? createOwnerAccess({pool}) : undefined;
  const fba = env.ASIN_AMAZON_CLIENT_ID ? createCloudFba({store, config: cloudAmazonConfig(env)}) : undefined;
  const readTargets=async()=>{
    const [monitor,physical,plans,watch]=await Promise.all([store.read(),stockStore?.read(),planningStore?.read(),watchStore?.read()]);
    const sources=monitor.links.filter(l=>l.verified&&!l.observationConflict).map(l=>{const p=monitor.catalog.find(p=>p.id===l.catalogId),y=monitor.listings.find(y=>y.listingId===l.listingId);return{sourceId:`link:${l.id}`,linkId:l.id,asin:l.asin || p?.asin,sellerSku:l.amazonSellerSku||(l.matchBy==="asin"?"":p?.sellerSku),title:y?.title || p?.title,condition:l.matchBy==="asin"?"unknown":/^new/i.test(p?.condition || "")?"new":/^used/i.test(p?.condition || "")?"used":"unknown"};});
    for(const p of physical?.products || [])if(p.asin)sources.push({sourceId:`stock:${p.id}`,asin:p.asin,sellerSku:p.sellerSku,title:p.title,condition:p.condition});
    for(const p of plans?.plans || [])if(p.asin)sources.push({sourceId:`plan:${p.id}`,asin:p.asin,sellerSku:p.sellerSku,title:p.title,condition:p.condition});
    for(const p of watch?.rules || [])if(p.key.startsWith("watch:")&&p.asin)sources.push({sourceId:p.key,asin:p.asin,sellerSku:p.sellerSku,title:p.title,condition:p.condition});
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
  const monitoring=overview&&env.ASIN_AMAZON_CLIENT_ID?createProductMonitoring({overview,watchStore,config:cloudAmazonConfig(env),readListings:readOwnAmazonListings}):undefined;
  const productLinks=overview?createProductLinkEditor({transaction:createDocumentTransaction({pool,validators:{"link-monitor":validateMonitorState,"physical-stock":validatePhysicalStock,"sales-planning":validateSalesPlanning}}),overview,refresh:monitoring?()=>monitoring.run({refreshListings:true,settings:{stockAlerts:false,yahooAlerts:false,reviewAlerts:false,errorAlerts:false}}):undefined}):undefined;
  const automation=sales && transport ? createCloudSalesAutomation({store,sales,transport,monitoring,readAlertStates:monitoring?.alertStates,readInventory:overview?()=>overview.view():undefined}) : undefined;
  const handler = createCloudHandler({config, store, draftStore, stock, stockPhotos, stockAmazon, planning, overview, ownerAccess, fba, mail, sales, automation, verifyIdentity: createIdentityVerifier(config), assets: await loadCloudAssets(assetDirectory),
    productLinks,verifyOwner: createOwnerVerifier({...config, ...(ownerAccess ? {resolveOwnerUserId: ownerAccess.ownerUserId} : {})})});
  return {config, handler, pool,sales,automation,overview,productLinks,runSalesAutomation:automation ? ()=>automation.run() : undefined};
}
