import {createAuthClient} from "@neondatabase/auth";
import {configureMonitorRequest} from "./monitor-http.js";
import {workspaceNavigation, stockWorkflowContext} from "./workspace-navigation.js";
import {COCKPIT_BRAND,cockpitHeader} from "./cockpit-brand.js";

const form = document.querySelector("#loginForm");
const status = document.querySelector("#loginStatus");
const submit = document.querySelector("#loginSubmit");
let auth;
let opened = false;
let setupToken;
let creatingAccount = false;
let suppliedSetup = new URLSearchParams(location.hash.slice(1)).get("setup");
if (suppliedSetup) history.replaceState(null, "", location.pathname + location.search);
const message = (value) => {status.textContent = value;};
function showLogin() {document.querySelector("#authLoading").hidden = true; document.querySelector("#loginPanel").hidden = false;}
async function token() {
  const result = await auth.token();
  // This SDK version can return its cached get-session shape from token().
  const jwt = result.data?.token || (await auth.getSession()).data?.session?.token;
  if (result.error || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt || "")) throw new Error("ログインし直してください。");
  return jwt;
}
function requireLogin() {
  document.querySelector("#cloudApp").hidden = true;
  showLogin();
  message("ログインし直してください。");
}
async function authenticatedRequest(url, options = {}) {
  let jwt;
  try {jwt = await token();} catch {requireLogin(); throw new Error("ログインし直してください。");}
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${jwt}`);
  const response = await fetch(url, {...options, headers, cache: "no-store"});
  if (response.status === 401) {requireLogin(); throw new Error("ログインの有効期限が切れました。");}
  return response;
}
async function openApplication() {
  const response = await authenticatedRequest("/api/session");
  if (!response.ok) {showLogin(); message("このアカウントには利用権限がありません。"); return;}
  if (opened) {location.replace("/"); return;}
  const session = await response.json();
  const drafts = new URLSearchParams(location.search).get("view") === "drafts";
  const stock = new URLSearchParams(location.search).get("view") === "stock";
  const planning = new URLSearchParams(location.search).get("view") === "planning";
  const overview = new URLSearchParams(location.search).get("view") === "overview";
  const photos = new URLSearchParams(location.search).get("view") === "photos";
  const htmlResponse = await fetch(photos ? "/cloud-photos-view.html" : overview ? "/cloud-overview-view.html" : planning ? "/cloud-planning-view.html" : stock ? "/cloud-stock-view.html" : drafts ? "/cloud-drafts-view.html" : "/cloud-view.html", {cache: "no-store"});
  if (!htmlResponse.ok) throw new Error("画面を読み込めませんでした。");
  const main = new DOMParser().parseFromString(await htmlResponse.text(), "text/html").querySelector("main");
  if (!main) throw new Error("画面を読み込めませんでした。");
  const panel = document.querySelector("#cloudApp");
  const mode = document.createElement("span");
  mode.textContent = session.readOnly ? "閲覧のみ" : "クラウド保存";
  const logout = document.createElement("button");
  logout.type = "button";
  logout.textContent = "ログアウト";
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      const result = await auth.signOut();
      if (result.error) throw new Error("ログアウトできませんでした。再度お試しください。");
      location.replace("/");
    } catch (error) {logout.disabled = false; mode.textContent = error.message;}
  });
  const navigation = workspaceNavigation({drafts,stock,planning,overview,photos,photoLibrary:session.photoLibrary,physicalStock:session.physicalStock,salesPlanning:session.salesPlanning,productOverview:session.productOverview});
  const account=cockpitHeader({navigation,mode,logout,home:session.productOverview?'/?view=overview':'/'});
  main.classList.add('cockpit-content');
  panel.append(account, main);
  configureMonitorRequest(authenticatedRequest);
  if (photos) {const {openSharedPhotos}=await import("./shared-photos.js");await openSharedPhotos({readOnly:session.readOnly,enabled:session.photoLibrary});}
  else if (overview) {const {openOverview}=await import("./product-overview.js");await openOverview({userId:session.userId,readOnly:session.readOnly});}
  else if (planning) {const {openPlanning}=await import("./sales-planning.js");await openPlanning({userId:session.userId,readOnly:session.readOnly});}
  else if (stock) {const {openStock} = await import("./physical-stock.js"); await openStock({userId: session.userId, readOnly: session.readOnly});}
  else await import(drafts ? "./app.js" : "./link-monitor.js");
  if (!stock && !planning && !overview && !photos && session.physicalStock) {
    try {await stockWorkflowContext({drafts,main,request:authenticatedRequest});}
    catch (error) {const warning=document.createElement("p");warning.className="workspace-context-error";warning.setAttribute("role","alert");warning.textContent=error.message;main.prepend(warning);}
  }
  document.title = `${photos?"共有写真":overview?"全商品一覧":planning ? "販売の監視・見直し" : stock ? "コンテナ・自社在庫" : drafts ? "ヤフオク出品下書きツール" : "商品紐付けツール"} | ${COCKPIT_BRAND.title}`;
  document.querySelector("#loginPanel").hidden = true;
  document.querySelector("#authLoading").hidden = true;
  panel.hidden = false;
  document.querySelector("#loginPassword").value = "";
  opened = true;
}
async function finishSetup() {
  const jwt = await token();
  const response = await fetch("/api/owner/enroll", {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${jwt}`}, body: JSON.stringify({setupToken}), cache: "no-store"});
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || "本人設定を完了できませんでした");
  }
  setupToken = undefined;
  suppliedSetup = undefined;
  document.querySelector("#finishSetup").hidden = true;
  await openApplication();
}
document.querySelector("#finishSetup").addEventListener("click", async (event) => {
  event.target.disabled = true;
  try {await finishSetup();} catch (error) {message(error.message); event.target.disabled = false;}
});
document.querySelector("#setupSignIn").addEventListener("click", () => {
  creatingAccount = false;
  submit.textContent = "ログインして本人設定を完了";
  document.querySelector("#loginPassword").autocomplete = "current-password";
  document.querySelector("#setupSignIn").hidden = true;
  message("登録済みのメールアドレスとパスワードを入力してください。");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  message("ログインしています。");
  try {
    const password = document.querySelector("#loginPassword");
    const email = document.querySelector("#loginEmail").value.trim();
    const result = creatingAccount ? await auth.signUp.email({email, password: password.value, name: "本人"}) : await auth.signIn.email({email, password: password.value});
    password.value = "";
    if (result.error) throw new Error("ログインできませんでした。入力内容をご確認ください。");
    creatingAccount = false;
    if (setupToken) submit.textContent = "ログインして本人設定を完了";
    if (setupToken) await finishSetup(); else await openApplication();
  } catch {message("ログインできませんでした。入力内容と接続をご確認ください。");}
  finally {document.querySelector("#loginPassword").value = ""; submit.disabled = false;}
});
try {
  const response = await fetch("/api/cloud-config", {cache: "no-store"});
  if (!response.ok) throw new Error("認証設定を読み込めませんでした。");
  const config = await response.json();
  auth = createAuthClient(config.authUrl);
  const session = await auth.getSession();
  if (suppliedSetup && config.setupEnabled) {
    showLogin();
    const check = await fetch("/api/owner/check", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({setupToken: suppliedSetup}), cache: "no-store"});
    if (!check.ok) {message((await check.json()).error || "初回設定リンクを確認してください"); suppliedSetup = undefined; submit.disabled = false; throw new Error("setup");}
    setupToken = suppliedSetup;
    suppliedSetup = undefined;
    creatingAccount = true;
    document.querySelector("#loginTitle").textContent = "初回・本人アカウント登録";
    document.querySelector("#loginPassword").autocomplete = "new-password";
    document.querySelector("#loginPassword").minLength = 12;
    submit.textContent = "アカウントを作って開始";
    document.querySelector("#setupSignIn").hidden = false;
    if (session.data?.user) {
      form.hidden = true;
      document.querySelector("#finishSetup").hidden = false;
      message(`${session.data.user.email} で本人設定を完了します。`);
    } else message("このツール専用のメールアドレスとパスワードを設定してください。");
  } else if (session.data?.user) await openApplication();
  else {showLogin(); message("メールアドレスとパスワードを入力してください。");}
  submit.disabled = false;
} catch (error) {showLogin(); if (error.message !== "setup") message("認証に接続できませんでした。ページを再読み込みしてください。");}
