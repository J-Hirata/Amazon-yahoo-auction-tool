import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";

const source = await readFile(new URL("../chrome-extension/background.js", import.meta.url), "utf8");
function harness() {
  const stored = {};
  const navigation = [];
  const requests = [];
  let listener;
  let id = 0;
  const context = {
    URL, AbortSignal, Uint8Array, Date, btoa,
    fetch: async (url, options) => {
      requests.push({url, options});
      return {ok: true, json: async () => ({config: {yahooSellerUrl: "https://auctions.yahoo.co.jp/jp/show/submit?category=0"}})};
    },
    chrome: {
      runtime: {id: "test", onMessage: {addListener: (fn) => {listener = fn;}}},
      storage: {session: {
        set: async (values) => Object.assign(stored, values),
        get: async (key) => ({[key]: stored[key]}),
        remove: async (key) => {delete stored[key];}
      }},
      tabs: {
        create: async () => ({id: ++id}),
        update: async (tabId, options) => {assert.ok(stored[`draft:${tabId}`]); navigation.push({tabId, ...options});},
        onRemoved: {addListener() {}}
      },
      scripting: {executeScript: async () => {}},
      action: {onClicked: {addListener() {}}}
    }
  };
  vm.runInNewContext(source, context);
  const send = (message, url = "https://auctions.yahoo.co.jp/jp/show/submit", tabId = 1) => new Promise((resolve) => listener(message, {id: "test", url, frameId: 0, tab: {id: tabId}}, resolve));
  return {send, stored, navigation, requests, context};
}

test("selected items remain separate for two listing tabs", async () => {
  const h = harness();
  assert.equal((await h.send({type: "openListing", asin: "B000000001"}, "http://localhost:41731/")).ok, true);
  await h.send({type: "openListing", asin: "B000000002"}, "http://localhost:41731/");
  assert.equal((await h.send({type: "selection"}, undefined, 1)).asin, "B000000001");
  assert.equal((await h.send({type: "selection"}, undefined, 2)).asin, "B000000002");
  assert.equal(h.navigation.length, 2);
  h.stored["draft:1"].at = Date.now() - 3600001;
  assert.equal((await h.send({type: "selection"})).asin, null);
});

test("reject other ports, arbitrary endpoints, non-Amazon image URLs and invalid ASINs", async () => {
  const h = harness();
  for (const [message, url] of [
    [{type: "openListing"}, "http://localhost:4173/"],
    [{type: "api", path: "/api/items"}, "https://example.com/"],
    [{type: "api", path: "/api/stock-watch"}],
    [{type: "api", path: "/api/items", method: "DELETE"}],
    [{type: "api", path: "/api/image-proxy?url=http%3A%2F%2F127.0.0.1%2F"}],
    [{type: "openListing", asin: "../invalid"}]
  ]) assert.equal((await h.send(message, url)).ok, false);
  assert.equal(h.requests.length, 0);
});

test("the write bridge keeps input completion separate from confirmed draft saving and rejects other edits", async () => {
  const h = harness();
  for(const body of [{status:"sold",price:1},{status:"listed"},{status:"draft_saved",title:"overwrite"},{}])assert.equal((await h.send({type:"api",method:"PATCH",path:"/api/items/B000000001",body})).ok,false);
  assert.equal(h.requests.length,0);
  for(const workStatus of ['input_done','draft_saved']){
    assert.equal((await h.send({type:'api',method:'PATCH',path:'/api/items/B000000001',body:{status:workStatus,...(workStatus==='draft_saved'?{saveConfirmed:true}:{})}})).ok,true);
    assert.deepEqual(JSON.parse(h.requests.at(-1).options.body),{status:workStatus,...(workStatus==='draft_saved'?{saveConfirmed:true}:{})});
  }
});

test("offline server produces an actionable message", async () => {
  const h = harness();
  h.context.fetch = async () => {throw new Error("connection refused");};
  const result = await h.send({type: "api", path: "/api/items"});
  assert.equal(result.ok, false);
  assert.match(result.error, /起動ボタン/);
});

test('the content bridge forwards the input status body to the guarded background bridge unchanged',async()=>{
 const h=harness(),source=await readFile(new URL('../chrome-extension/yahoo.js',import.meta.url),'utf8'),context={URL,chrome:{runtime:{sendMessage:message=>h.send(message)}},document:{createElement(){throw new Error('stop before mounting test UI');}}};
 assert.throws(()=>vm.runInNewContext(source,context),/stop before mounting test UI/);
 const bridge=context.asinYahooExtension;
 for(const workStatus of ['input_done','draft_saved']){
  const response=await bridge.fetch('http://localhost:41731/api/items/B000000001',{method:'PATCH',body:JSON.stringify({status:workStatus,...(workStatus==='draft_saved'?{saveConfirmed:true}:{})})});assert.equal(response.ok,true);assert.deepEqual(JSON.parse(h.requests.at(-1).options.body),{status:workStatus,...(workStatus==='draft_saved'?{saveConfirmed:true}:{})});
 }
 await assert.rejects(()=>bridge.fetch('http://localhost:41731/api/items/B000000001',{method:'PATCH',body:JSON.stringify({status:'sold'})}));assert.equal(h.requests.length,2);
});
