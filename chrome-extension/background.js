const BASE = "http://localhost:41731";
const CLOUD = 'https://amazon-yahoo-inventory.vercel.app';
const ASIN = /^[A-Z0-9]{10}$/;

function isYahoo(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "auctions.yahoo.co.jp" || url.hostname.endsWith(".auctions.yahoo.co.jp"));
  } catch { return false; }
}

function isManagement(value) {
  try { return [BASE,CLOUD].includes(new URL(value).origin); } catch { return false; }
}

function cloudDrafts(message){
 if(!/^[0-9a-f-]{36}$/i.test(message.handoffId||''))throw new Error('受け渡し情報を確認してください');
 const drafts=message.drafts;
 if(!Array.isArray(drafts)||!drafts.length||drafts.length>5||new Set(drafts.map(d=>d?.asin)).size!==drafts.length)throw new Error('商品は重複なしで1〜5件を選んでください');
 if(!isYahoo(message.yahooSellerUrl)||!/^\/(?:sell\/)?jp\/show\/(?:topsubmit|submit)$/.test(new URL(message.yahooSellerUrl).pathname))throw new Error('Yahoo出品フォームのURLを確認してください');
 for(const d of drafts){
  if(!d||!ASIN.test(d.asin)||typeof d.title!=='string'||!d.title.trim()||d.title.length>500||typeof d.description!=='string'||d.description.length>30000||d.price!=null&&(!Number.isFinite(d.price)||d.price<=0||d.price>100000000)||!Array.isArray(d.imageUrls)||d.imageUrls.length>20)throw new Error('下書きの商品情報を確認してください');
  for(const value of d.imageUrls)if(!imageUrl(value))throw new Error('対応する商品画像URLを確認してください');
 }
 return drafts;
}
function imageUrl(value){try{const u=new URL(value);return value.length<=2048&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(/\.(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com)$/.test(u.hostname)||u.hostname.endsWith('.yimg.jp'));}catch{return false;}}
async function openCloudListings(message,sender){
 if(new URL(sender.url).origin!==CLOUD)throw new Error('販売コックピットから商品を選んでください');
 const drafts=cloudDrafts(message),opened=[],errors=[];
 for(const draft of drafts)try{
  const tab=await chrome.tabs.create({url:'about:blank',active:opened.length===0});
  await chrome.storage.session.set({[`draft:${tab.id}`]:{asin:draft.asin,at:Date.now(),cloud:true,handoffId:message.handoffId,managementTabId:sender.tab.id,draft,yahooSellerUrl:message.yahooSellerUrl}});
  await chrome.tabs.update(tab.id,{url:message.yahooSellerUrl});opened.push(draft.asin);
 }catch{errors.push(draft.asin);}
 return {ok:errors.length===0,opened,errors,error:errors.length?'一部のタブを開けませんでした。開いた商品を確認して残りだけ選び直してください。':undefined};
}
async function cloudApi(message,job){
 if(Date.now()-job.at>=3600000)throw new Error('受け渡しから1時間経過しました。販売コックピットから選び直してください');
 const path=message.path,method=message.method||'GET',d=job.draft;
 if(method==='GET'&&path==='/api/items')return {ok:true,json:{queue:{active:[{asin:d.asin,title:d.title,status:'ready_for_draft'}],waiting:[]}}};
 if(method==='GET'&&path===`/api/items/${d.asin}/draft`)return {ok:true,json:{draft:d}};
 if(method==='PATCH'&&path===`/api/items/${d.asin}`){
  const p=message.body;
  if(!p||Object.keys(p).some(k=>!['status','saveConfirmed'].includes(k))||!['input_done','draft_saved'].includes(p.status)||(p.status==='draft_saved'?p.saveConfirmed!==true:p.saveConfirmed!==undefined))throw new Error('入力・保存確認の記録だけを送信できます');
  const result=await chrome.tabs.sendMessage(job.managementTabId,{type:'cloudDraftProgress',handoffId:job.handoffId,asin:d.asin,patch:p});
  if(!result?.ok)throw new Error(result?.error||'販売コックピットのタブを開いてから、記録をやり直してください');
  return {ok:true,json:result};
 }
 if(method==='GET'&&typeof path==='string'&&path.startsWith('/api/image-proxy?url=')){
  const value=new URL(path,BASE).searchParams.get('url');
  if(!d.imageUrls.includes(value)||!imageUrl(value))throw new Error('選択した商品の画像だけを取得できます');
  const response=await fetch(value,{signal:AbortSignal.timeout(20000),credentials:'omit',redirect:'error'});
  if(!response.ok||!/^image\//i.test(response.headers.get('content-type')||''))throw new Error('商品画像を取得できません');
  const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>12*1024*1024)throw new Error('画像が大きすぎます');
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {ok:true,base64:btoa(binary),contentType:response.headers.get('content-type')};
 }
 throw new Error('選択した商品の入力・保存記録だけを利用できます');
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
  if(message.type==='openCloudListings'&&management)return openCloudListings(message,sender);
  const job=yahoo?(await chrome.storage.session.get(`draft:${sender.tab.id}`))[`draft:${sender.tab.id}`]:null;
  if(message.type==='openListing'&&job?.cloud){
   if(Date.now()-job.at>=3600000)throw new Error('販売コックピットから商品を選び直してください');
   await chrome.tabs.update(sender.tab.id,{url:job.yahooSellerUrl});return {ok:true};
  }
  if (message.type === "openListing") return openListing(message.asin);
  if (message.type === "selection" && yahoo) {
    const key = `draft:${sender.tab.id}`;
    const value = (await chrome.storage.session.get(key))[key];
    return {ok: true, asin: value && Date.now() - value.at < 3600000 ? value.asin : null,managementUrl:value?.cloud?CLOUD+'/?view=drafts':BASE+'/'};
  }
  if (message.type === "showHelper" && yahoo) {
    await chrome.scripting.executeScript({target: {tabId: sender.tab.id}, files: ["yahoo-fill.js"]});
    return {ok: true};
  }
  if (message.type === "api" && yahoo) {
    if(job?.cloud)return cloudApi(message,job);
    const path = message.path;
    const method = message.method || "GET";
    const read = method === "GET" && (path === "/api/items" || /^\/api\/items\/[A-Z0-9]{10}\/draft$/.test(path));
    const image = method === "GET" && typeof path === "string" && path.startsWith("/api/image-proxy?url=");
    const save = method === "PATCH" && /^\/api\/items\/[A-Z0-9]{10}$/.test(path);
    if (!read && !image && !save) throw new Error("許可されていない操作です");
    if (save && (!message.body || Object.keys(message.body).some(key => !["status", "saveConfirmed"].includes(key)) || !["input_done", "draft_saved"].includes(message.body.status) || (message.body.status === "draft_saved" ? message.body.saveConfirmed !== true : message.body.saveConfirmed !== undefined))) throw new Error("入力済み・保存確認の記録だけを送信できます");
    const options = save ? {method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(message.body)} : {};
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
