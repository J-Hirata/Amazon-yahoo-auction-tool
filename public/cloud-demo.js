import {configureMonitorRequest} from "./monitor-http.js";

const key = "asin-yahoo-public-demo-v1";
const message = document.querySelector("#demoLoadStatus");
const reply = (data, status = 200) => Response.json(data, {status});
document.querySelector("#resetSample").addEventListener("click", () => {
  if (confirm("サンプルを初期状態に戻しますか？")) {localStorage.removeItem(key); location.reload();}
});
async function request(url, options = {}) {
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin || target.search || !target.pathname.startsWith("/api/link-monitor")) return reply({error: "確認版では使えない操作です"}, 404);
  const path = target.pathname.slice("/api/link-monitor".length);
  const data = options.body ? JSON.parse(options.body) : {};
  const memo = path.match(/^\/links\/([^/]+)\/memo$/);
  const action = path === "" ? "read" : path === "/page-links" ? "register" : path === "/page-links/batch" ? "batch" : path === "/preview" ? "preview" : path === "/demo" ? "scenario" : memo ? "memo" : null;
  if (!action) return reply({error: "確認版では使えない操作です"}, 404);
  let saved;
  try {saved = JSON.parse(localStorage.getItem(key) || "null");}
  catch {return reply({error: "サンプル保存を読み込めません。上のリセットで初期状態へ戻してください"}, 400);}
  const response = await fetch("/api/demo", {method: "POST", headers: {"Content-Type": "application/json"}, cache: "no-store",
    body: JSON.stringify({...data, action, state: saved?.state, revision: saved?.revision || 0, ...(memo ? {linkId: decodeURIComponent(memo[1])} : {})})});
  const result = await response.json();
  if (response.ok && action !== "scenario") {
    const current = JSON.parse(localStorage.getItem(key) || "null");
    if ((current?.revision || 0) !== (saved?.revision || 0)) return reply({error: "別のタブで更新されています。更新ボタンで読み直してください"}, 409);
    try {localStorage.setItem(key, JSON.stringify({state: result.demoDocument, revision: result.storage.revision}));}
    catch {return reply({error: "このブラウザに保存できませんでした。保存設定をご確認ください"}, 503);}
  }
  return reply(result, response.status);
}
try {
  const response = await fetch("/cloud-view.html", {cache: "no-store"});
  if (!response.ok) throw new Error();
  const main = new DOMParser().parseFromString(await response.text(), "text/html").querySelector("main");
  if (!main) throw new Error();
  document.querySelector("#demoApp").append(main);
  main.querySelector("#pairAmazon").placeholder = "B000DEMO02";
  main.querySelector("#pairYahoo").placeholder = "https://auctions.yahoo.co.jp/jp/auction/d1000000002";
  configureMonitorRequest(request);
  await import("./link-monitor.js");
  message.hidden = true;
  document.querySelector("#demoApp").hidden = false;
} catch {message.textContent = "確認画面を読み込めませんでした。ページを再読み込みしてください。";}
