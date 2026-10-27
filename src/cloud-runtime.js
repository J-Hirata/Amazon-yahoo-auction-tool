import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {cloudConfiguration, createOwnerVerifier, createIdentityVerifier} from "./cloud-auth.js";
import {storageConfiguration, databasePool} from "./storage-runtime.js";
import {createPostgresDocumentStore} from "./postgres-document-store.js";
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
import {createStockAmazonRefresh} from "./stock-amazon-listings.js";

const fileTypes = {
  "cloud-login.html": "text/html; charset=utf-8", "cloud-view.html": "text/html; charset=utf-8", "cloud-drafts-view.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "demo.html": "text/html; charset=utf-8", "cloud-demo.js": "text/javascript; charset=utf-8",
  "cloud-login.js": "text/javascript; charset=utf-8", "monitor-http.js": "text/javascript; charset=utf-8", "link-monitor.js": "text/javascript; charset=utf-8",
  "cloud-stock-view.html": "text/html; charset=utf-8", "physical-stock.js": "text/javascript; charset=utf-8", "physical-stock.css": "text/css; charset=utf-8",
  "catalog-view.js":"text/javascript; charset=utf-8", "catalog-view.css":"text/css; charset=utf-8", "catalog-list.svg":"image/svg+xml", "catalog-tiles.svg":"image/svg+xml", "catalog-image.svg":"image/svg+xml",
  "cloud-login.css": "text/css; charset=utf-8", "link-monitor.css": "text/css; charset=utf-8", "styles.css": "text/css; charset=utf-8", "extension-logo.png": "image/png"
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
  const stock = stockStore ? createCloudStock({store: stockStore, monitorStore: store, draftStore}) : undefined;
  const stockPhotos = stockStore && env.ASIN_AMAZON_CLIENT_ID ? createStockPhotoRefresh({store: stockStore, config: cloudAmazonConfig(env)}) : undefined;
  const stockAmazon = stockStore && env.ASIN_AMAZON_CLIENT_ID ? createStockAmazonRefresh({store:stockStore,monitorStore:store,config:cloudAmazonConfig(env)}) : undefined;
  const ownerAccess = config.ownerFromDatabase ? createOwnerAccess({pool}) : undefined;
  const fba = env.ASIN_AMAZON_CLIENT_ID ? createCloudFba({store, config: cloudAmazonConfig(env)}) : undefined;
  const sales = env.ASIN_AMAZON_CLIENT_ID ? createCloudSales({store, config: cloudAmazonConfig(env)}) : undefined;
  const mail = env.ASIN_GMAIL_USER ? createCloudMail({store, transport: createCloudMailTransport(cloudMailConfig(env))}) : undefined;
  const handler = createCloudHandler({config, store, draftStore, stock, stockPhotos, stockAmazon, ownerAccess, fba, mail, sales, verifyIdentity: createIdentityVerifier(config), assets: await loadCloudAssets(assetDirectory),
    verifyOwner: createOwnerVerifier({...config, ...(ownerAccess ? {resolveOwnerUserId: ownerAccess.ownerUserId} : {})})});
  return {config, handler, pool};
}
