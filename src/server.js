import {reorderDrafts} from './draft-order.js';
import {addDrafts} from './cloud-drafts.js';
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildItemsFromAsins } from "./amazon.js";
import { findPriceReviewItems, splitDraftQueue } from "./queue.js";
import { loadItems, updateItems, upsertItems } from "./store.js";
import { calculateAuctionPrices } from "./pricing.js";
import { CONFIG } from "./config.js";
import { buildYahooDraft } from "./draft.js";
import { fetchProductData } from "./product-provider.js";
import { buildDraftCsv } from "./csv.js";
import { loadStockWatch, saveStockWatch, upsertStockWatch } from "./stock-monitor-store.js";
import { checkStockWatchItem, needsReminder, normalizeWatchAsins } from "./stock-monitor.js";
import { handleLinkMonitor } from "./link-monitor-api.js";
import {cloudCutover} from "./cloud-cutover.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.ASIN_DATA_DIR && !process.env.LINK_MONITOR_DATA_DIR && await cloudCutover(path.resolve(__dirname, "..", "data"))) {
  console.log("Cloud version is ready: https://amazon-yahoo-inventory.vercel.app . Local backup files will not be edited.");
  process.exit(0);
}
const publicDir = path.resolve(__dirname, "..", "public");
const port = Number(process.env.PORT || 41731);
const bindHost = process.env.ASIN_BIND_HOST || (process.env.ASIN_STORAGE_BACKEND === "postgres" ? "127.0.0.1" : undefined);
if (process.env.ASIN_STORAGE_BACKEND === "postgres" && !["127.0.0.1", "::1", "localhost"].includes(bindHost)) {
  throw new Error("DB保存の試行はローカル接続限定です。クラウド公開は認証実装後に行ってください");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (process.env.ASIN_STORAGE_BACKEND === "postgres" &&
      (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || (req.headers.origin && req.headers.origin !== url.origin))) {
      return sendJson(res, {error: "DB保存の試行は同じローカル管理画面から操作してください"}, 403);
    }

    if (await handleLinkMonitor(req, res, url)) return;
    if(req.method==='GET'&&['/draft-board.js','/draft-workbench.css','/catalog-view.js','/catalog-view.css','/tile-size.js','/catalog-list.svg','/catalog-tiles.svg','/catalog-image.svg','/catalog-grip.svg','/catalog-prev.svg','/catalog-next.svg'].includes(url.pathname))return sendFile(res,path.join(publicDir,url.pathname.slice(1)),url.pathname.endsWith('.css')?'text/css; charset=utf-8':url.pathname.endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8');
    if(req.method==='GET'&&url.pathname==='/catalog-sortable.js')return sendFile(res,path.resolve(__dirname,'../node_modules/sortablejs/modular/sortable.esm.js'),'text/javascript; charset=utf-8');
    const monitorFiles = {
      "/link-monitor.html": ["link-monitor.html", "text/html; charset=utf-8"],
      "/link-monitor.js": ["link-monitor.js", "text/javascript; charset=utf-8"],
      "/monitor-http.js": ["monitor-http.js", "text/javascript; charset=utf-8"],
      "/link-monitor.css": ["link-monitor.css", "text/css; charset=utf-8"],
      "/monitor-template.csv": ["monitor-template.csv", "text/csv; charset=utf-8"]
    };
    if (req.method === "GET" && Object.hasOwn(monitorFiles, url.pathname)) {
      const [name, contentType] = monitorFiles[url.pathname];
      return sendFile(res, path.join(publicDir, name), contentType);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/") {
      return sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      return sendFile(res, path.join(publicDir, "app.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/stock-monitor.html") {
      return sendFile(res, path.join(publicDir, "stock-monitor.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/stock-monitor.js") {
      return sendFile(res, path.join(publicDir, "stock-monitor.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/styles.css") {
      return sendFile(res, path.join(publicDir, "styles.css"), "text/css; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/extension-logo.png") {
      return sendFile(res, path.join(publicDir, "extension-logo.png"), "image/png");
    }

    if (req.method === "GET" && url.pathname === "/extension-helper.html") {
      return sendFile(res, path.join(publicDir, "extension-helper.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/yahoo-helper.html") {
      return sendFile(res, path.join(publicDir, "yahoo-helper.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/start-helper.html") {
      return sendFile(res, path.join(publicDir, "start-helper.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/yahoo-fill.js") {
      return sendFile(res, path.join(publicDir, "yahoo-fill.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/amazon-helper.html") {
      return sendFile(res, path.join(publicDir, "amazon-helper.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/amazon-capture.js") {
      return sendFile(res, path.join(publicDir, "amazon-capture.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/image-proxy") {
      const imageUrl = url.searchParams.get("url");
      if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return sendJson(res, { error: "Invalid image URL" }, 400);
      const imageResponse = await fetch(imageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
      });
      if (!imageResponse.ok) return sendJson(res, { error: `Image fetch failed: HTTP ${imageResponse.status}` }, 502);
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": imageResponse.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "no-store"
      });
      return res.end(bytes);
    }

    if (req.method === "GET" && url.pathname === "/test-yahoo-form.html") {
      return sendFile(res, path.join(publicDir, "test-yahoo-form.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/test-amazon-page.html") {
      return sendFile(res, path.join(publicDir, "test-amazon-page.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/items") {
      const items = await loadItems();
      return sendJson(res, { items, queue: splitDraftQueue(items), priceReviews: findPriceReviewItems(items), config: CONFIG });
    }

    if (req.method === "GET" && url.pathname === "/api/stock-watch") {
      const watches = await loadStockWatch();
      return sendJson(res, { watches, summary: stockWatchSummary(watches) });
    }

    if (req.method === "POST" && url.pathname === "/api/stock-watch") {
      const body = await readJson(req);
      const asins = normalizeWatchAsins(body.asins || "");
      const sellerName = String(body.sellerName || "キャットコーポレーション合同会社").trim();
      const now = new Date().toISOString();
      const currentItems = await loadItems();
      const byAsin = new Map(currentItems.map((item) => [item.asin, item]));
      const next = await upsertStockWatch(asins.map((asin) => ({
        asin,
        sellerName,
        title: byAsin.get(asin)?.title || asin,
        amazonUrl: byAsin.get(asin)?.amazonUrl || `https://www.amazon.co.jp/dp/${asin}`,
        status: "watching",
        createdAt: now
      })));
      return sendJson(res, { watches: next, summary: stockWatchSummary(next) });
    }

    if (req.method === "POST" && url.pathname === "/api/stock-watch/check") {
      const watches = await loadStockWatch();
      const targets = watches.filter((item) => !["paused", "resolved"].includes(item.status));
      const checked = [];
      for (const item of targets) checked.push(await checkStockWatchItem(item));
      const byAsin = new Map(checked.map((item) => [item.asin, item]));
      const next = watches.map((item) => byAsin.get(item.asin) || item);
      await saveStockWatch(next);
      return sendJson(res, { watches: next, checked, summary: stockWatchSummary(next), reminders: next.filter((item) => needsReminder(item)) });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/stock-watch/")) {
      const asin = decodeURIComponent(url.pathname.replace("/api/stock-watch/", ""));
      const patch = await readJson(req);
      const now = new Date().toISOString();
      const watches = await loadStockWatch();
      const next = watches.map((item) => item.asin === asin ? normalizeWatchPatch({ ...item, ...patch, updatedAt: now }, patch, now) : item);
      await saveStockWatch(next);
      return sendJson(res, { watches: next, summary: stockWatchSummary(next) });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/stock-watch/")) {
      const asin = decodeURIComponent(url.pathname.replace("/api/stock-watch/", ""));
      const watches = await loadStockWatch();
      const next = watches.filter((item) => item.asin !== asin);
      await saveStockWatch(next);
      return sendJson(res, { watches: next, summary: stockWatchSummary(next) });
    }

    if (req.method === "GET" && url.pathname === "/api/export/drafts.csv") {
      const items = await loadItems();
      const { active } = splitDraftQueue(items);
      const csv = buildDraftCsv(active);
      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"yahoo-drafts.csv\""
      });
      return res.end(`\uFEFF${csv}`);
    }

    if (req.method === "GET" && url.pathname === "/api/next-draft") {
      const items = await loadItems();
      const { active } = splitDraftQueue(items);
      const item = active.find((entry) => entry.status !== "draft_saved") || active[0];
      return sendJson(res, { item, draft: item ? buildYahooDraft(item) : null, config: CONFIG });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/items/") && url.pathname.endsWith("/draft")) {
      const asin = decodeURIComponent(url.pathname.replace("/api/items/", "").replace("/draft", ""));
      const items = await loadItems();
      const item = items.find((entry) => entry.asin === asin);
      if (!item) return sendJson(res, { error: "Item not found" }, 404);
      return sendJson(res, { draft: buildYahooDraft(item) });
    }

    if(req.method==='POST'&&url.pathname==='/api/drafts/order'){const body=await readJson(req);await updateItems(items=>{reorderDrafts(items,body.order);return items;});return sendJson(res,{ok:true});}
    if(req.method==='POST'&&url.pathname==='/api/drafts/catalog'){
      const {asins}=await readJson(req);if(!Array.isArray(asins)||!asins.length||asins.length>5||new Set(asins).size!==asins.length||asins.some(a=>typeof a!=='string'||!/^[A-Z0-9]{10}$/.test(a)))return sendJson(res,{error:'登録済みのASINを1〜5件指定してください'},400);
      const current=await loadItems();if(asins.some(a=>!current.some(p=>p.asin===a)))return sendJson(res,{error:'登録済みの商品を選んでください'},400);
      const results=[];for(const asin of asins){const result=await fetchProductData(asin);results.push(result);}
      const next=await updateItems(items=>{for(const result of results.filter(r=>r.ok)){const item=items.find(p=>p.asin===result.item.asin);if(!item)continue;if(!item.title?.trim()||item.title===item.asin)item.title=result.item.title||item.title;if(!item.imageUrls?.length&&result.item.imageUrls?.length)item.imageUrls=result.item.imageUrls;}return items;});
      return sendJson(res,{items:next,queue:splitDraftQueue(next),priceReviews:findPriceReviewItems(next),results:results.map(r=>({asin:r.asin||r.item?.asin,ok:r.ok}))});
    }
    if (req.method === "POST" && url.pathname === "/api/asins") {
      const body = await readJson(req);
      const asins = normalizeAsins(body.asins || "");
      const merged = await updateItems(async items=>{await addDrafts(items,asins.join("\n"),new Date().toISOString());return items;});
      return sendJson(res, { items: merged, queue: splitDraftQueue(merged), priceReviews: findPriceReviewItems(merged) });
    }

    if (req.method === "POST" && url.pathname === "/api/fetch-product-data") {
      const body = await readJson(req);
      const requestedAsins = normalizeAsins(body.asins || "");
      const current = await loadItems();
      const targets = requestedAsins.length ? requestedAsins : current
        .filter((item) => item.status === "waiting_for_product_data")
        .map((item) => item.asin);
      const results = [];
      const candidates = requestedAsins.length ? await buildItemsFromAsins(requestedAsins) : [];

      for (const asin of targets) {
        const result = await fetchProductData(asin);
        results.push(result);
      }
      const next = await updateItems((latest) => {
        let merged = mergeMissingItems(latest, candidates);
        for (const result of results.filter((entry) => entry.ok)) {
          const prices = calculateAuctionPrices(result.item.usedLowestPrice, CONFIG);
          merged = merged.map((item) => item.asin === result.item.asin ? {...item, ...result.item,
            startPrice: prices.startPrice, stalePrice: prices.stalePrice, updatedAt: new Date().toISOString()} : item);
        }
        return merged;
      });
      return sendJson(res, { items: next, queue: splitDraftQueue(next), priceReviews: findPriceReviewItems(next), results });
    }

    if (req.method === "POST" && url.pathname === "/api/import-amazon-page") {
      const body = await readJson(req);
      const asin = normalizeAsin(body.asin);
      if (!asin) return sendJson(res, { error: "ASINが読み取れませんでした。" }, 400);

      const usedLowestPrice = numberOrNull(body.usedLowestPrice ?? body.price);
      const prices = calculateAuctionPrices(usedLowestPrice, CONFIG);
      const now = new Date().toISOString();
      const imported = {
        asin,
        title: String(body.title || "").trim(),
        description: String(body.description || "").trim(),
        imageUrls: normalizeLines(body.imageUrls),
        amazonUrl: String(body.amazonUrl || `https://www.amazon.co.jp/dp/${asin}`),
        usedLowestPrice,
        startPrice: prices.startPrice,
        stalePrice: prices.stalePrice,
        sourceRegion: CONFIG.sourceRegion,
        shippingIncluded: CONFIG.shippingIncluded,
        shipAfterDaysMin: CONFIG.shipAfterDaysMin,
        shipAfterDaysMax: CONFIG.shipAfterDaysMax,
        status: usedLowestPrice ? "ready_for_draft" : "waiting_for_product_data",
        updatedAt: now
      };

      const next = await updateItems((current) => current.some((item) => item.asin === asin)
        ? current.map((item) => item.asin === asin ? { ...item, ...imported } : item)
        : [...current, { ...imported, createdAt: now }]);
      return sendJson(res, { item: next.find((item) => item.asin === asin), queue: splitDraftQueue(next) });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/items/")) {
      const asin = decodeURIComponent(url.pathname.replace("/api/items/", ""));
      const patch = await readJson(req);
      const next = await updateItems((items) => items.map((item) => {
        if (item.asin !== asin) return item;
        const hasPrice=Object.hasOwn(patch,"usedLowestPrice");
        const usedLowestPrice = hasPrice ? patch.usedLowestPrice === "" || patch.usedLowestPrice === null ? null : Number(patch.usedLowestPrice) : item.usedLowestPrice;
        const prices = hasPrice ? calculateAuctionPrices(usedLowestPrice, CONFIG) : {};
        const nextStatus = patch.status ?? item.status;
        const timestamps = {};
        if (nextStatus === "draft_saved" && item.status !== "draft_saved") timestamps.draftSavedAt = new Date().toISOString();
        if (nextStatus === "ready_for_draft" && item.status === "draft_saved") timestamps.draftSavedAt = null;
        if (nextStatus === "listed" && item.status !== "listed") timestamps.listedAt = new Date().toISOString();
        if (nextStatus === "sold" && item.status !== "sold") timestamps.soldAt = new Date().toISOString();
        return {
          ...item,
          ...patch,
          ...timestamps,
          imageUrls: normalizeLines(patch.imageUrls ?? item.imageUrls),
          usedLowestPrice,
          startPrice: prices.startPrice,
          stalePrice: prices.stalePrice,
          updatedAt: new Date().toISOString()
        };
      }));
      return sendJson(res, { items: next, queue: splitDraftQueue(next), priceReviews: findPriceReviewItems(next) });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/items/")) {
      const asin = decodeURIComponent(url.pathname.replace("/api/items/", ""));
      const next = await updateItems((items) => items.filter((item) => item.asin !== asin));
      return sendJson(res, { items: next, queue: splitDraftQueue(next), priceReviews: findPriceReviewItems(next) });
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message }, error.code === "STORAGE_CONFLICT" ? 409 : String(error.code || "").startsWith("STORAGE_") ? 503 : 500);
  }
});

server.listen(port, bindHost, () => {
  console.log(`ASIN draft tool: http://localhost:${server.address().port}`);
});

if (process.env.ASIN_STORAGE_BACKEND !== "postgres" && process.env.ASIN_DISABLE_BACKGROUND !== "1") setInterval(() => {
  runStockWatchCheck().catch((error) => console.error("Stock watch check failed", error));
}, 60 * 60 * 1000);

function normalizeAsins(input) {
  return String(input)
    .split(/\r?\n/)
    .map((asin) => asin.trim().toUpperCase())
    .filter(Boolean)
    .filter((asin, index, all) => all.indexOf(asin) === index);
}

function mergeMissingItems(current, candidates) {
  const existing = new Set(current.map((item) => item.asin));
  return [
    ...current,
    ...candidates.filter((item) => !existing.has(item.asin))
  ];
}

function normalizeAsin(input) {
  const match = String(input || "").toUpperCase().match(/[A-Z0-9]{10}/);
  return match ? match[0] : "";
}

async function runStockWatchCheck() {
  const watches = await loadStockWatch();
  const targets = watches.filter((item) => !["paused", "resolved", "own_stock"].includes(item.status));
  if (!targets.length) return;
  const checked = [];
  for (const item of targets) checked.push(await checkStockWatchItem(item));
  const byAsin = new Map(checked.map((item) => [item.asin, item]));
  await saveStockWatch(watches.map((item) => byAsin.get(item.asin) || item));
}

function normalizeLines(value) {
  if (Array.isArray(value)) return value.map((line) => String(line).trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function numberOrNull(value) {
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stockWatchSummary(watches) {
  return {
    total: watches.length,
    watching: watches.filter((item) => item.status === "watching").length,
    needsAttention: watches.filter((item) => item.status === "needs_attention").length,
    ownStock: watches.filter((item) => item.status === "own_stock").length,
    paused: watches.filter((item) => item.status === "paused").length,
    resolved: watches.filter((item) => item.status === "resolved").length,
    reminders: watches.filter((item) => needsReminder(item)).length
  };
}

function normalizeWatchPatch(item, patch, now) {
  if (patch.status === "resolved") item.resolvedAt = now;
  if (patch.status === "own_stock") item.ownStockAt = now;
  if (patch.status === "paused") item.pausedAt = now;
  if (patch.status === "watching") {
    delete item.firstAlertAt;
    delete item.lastReminderAt;
    delete item.resolvedAt;
    delete item.pausedAt;
  }
  if (patch.reminderSent) item.lastReminderAt = now;
  return item;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function sendFile(res, filePath, contentType) {
  const body = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function corsHeaders() {
  if (process.env.ASIN_STORAGE_BACKEND === "postgres") return {};
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
}
