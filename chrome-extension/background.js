const BASE = "http://localhost:41731";
const ASIN = /^[A-Z0-9]{10}$/;

function isYahoo(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "auctions.yahoo.co.jp" || url.hostname.endsWith(".auctions.yahoo.co.jp"));
  } catch { return false; }
}

function isManagement(value) {
  try { return new URL(value).origin === BASE; } catch { return false; }
}

async function api(path, options = {}) {
  try {
    const response = await fetch(BASE + path, {...options, signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error) {
    throw new Error(`ASINツールに接続できません。起動ボタンからツールを起動してください (${error.message})`);
  }
}

async function openListing(asin) {
  if (asin && !ASIN.test(asin)) throw new Error("ASINが正しくありません");
  const payload = await (await api("/api/items")).json();
  const url = payload.config?.yahooSellerUrl;
  if (!isYahoo(url)) throw new Error("Yahoo出品ページの設定を確認してください");
  // Store the selection before navigating, so fast page loads cannot lose it.
  const tab = await chrome.tabs.create({url: "about:blank"});
  await chrome.storage.session.set({[`draft:${tab.id}`]: {asin: asin || null, at: Date.now()}});
  await chrome.tabs.update(tab.id, {url});
  return {ok: true};
}

async function handle(message, sender) {
  const yahoo = isYahoo(sender.url);
  const management = isManagement(sender.url);
  if (sender.id !== chrome.runtime.id || (!yahoo && !management) || sender.frameId !== 0) throw new Error("対象外のページです");
  if (message.type === "openListing") return openListing(message.asin);
  if (message.type === "selection" && yahoo) {
    const key = `draft:${sender.tab.id}`;
    const value = (await chrome.storage.session.get(key))[key];
    return {ok: true, asin: value && Date.now() - value.at < 3600000 ? value.asin : null};
  }
  if (message.type === "showHelper" && yahoo) {
    await chrome.scripting.executeScript({target: {tabId: sender.tab.id}, files: ["yahoo-fill.js"]});
    return {ok: true};
  }
  if (message.type === "api" && yahoo) {
    const path = message.path;
    const method = message.method || "GET";
    const read = method === "GET" && (path === "/api/items" || /^\/api\/items\/[A-Z0-9]{10}\/draft$/.test(path));
    const image = method === "GET" && typeof path === "string" && path.startsWith("/api/image-proxy?url=");
    const save = method === "PATCH" && /^\/api\/items\/[A-Z0-9]{10}$/.test(path);
    if (!read && !image && !save) throw new Error("許可されていない操作です");
    const options = save ? {method, headers: {"Content-Type": "application/json"}, body: JSON.stringify({status: "draft_saved"})} : {};
    if (image) {
      const source = new URL(new URL(path, BASE).searchParams.get("url"));
      if (source.protocol !== "https:" || !/\.(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com)$/.test(source.hostname)) throw new Error("Amazon画像URLを確認してください");
    }
    const response = await api(path, options);
    if (!image) return {ok: true, json: await response.json()};
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 12 * 1024 * 1024) throw new Error("画像が大きすぎます");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return {ok: true, base64: btoa(binary), contentType: response.headers.get("content-type") || "image/jpeg"};
  }
  throw new Error("未対応の操作です");
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply, (error) => reply({ok: false, error: error.message}));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`draft:${tabId}`));
chrome.action.onClicked.addListener(() => chrome.tabs.create({url: BASE + "/"}));
