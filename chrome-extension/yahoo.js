(() => {
  if (globalThis.asinYahooExtension) return;
  const bridge = globalThis.asinYahooExtension = {
    selectedAsin: null,
    async fetch(url, options = {}) {
      const target = new URL(url);
      if (target.origin !== "http://localhost:41731") throw new Error("接続先が違います");
      const result = await chrome.runtime.sendMessage({type: "api", path: target.pathname + target.search, method: options.method || "GET", ...(options.body ? {body: JSON.parse(options.body)} : {})});
      if (!result?.ok) throw new Error(result?.error || "拡張機能を再読み込みしてください");
      return {
        ok: true,
        json: async () => result.json,
        blob: async () => new Blob([Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0))], {type: result.contentType})
      };
    }
  };
  const host = document.createElement("div");
  host.id = "asin-yahoo-extension-launcher";
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646";
  const root = host.attachShadow({mode: "closed"});
  root.innerHTML = `<style>:host{font:14px system-ui}button{font:inherit;background:#166534;color:white;border:1px solid white;border-radius:6px;padding:12px 16px;cursor:pointer;box-shadow:0 2px 8px #0003}p{background:white;color:#202124;max-width:min(320px,80vw);padding:10px;line-height:1.5;margin:0 0 8px;border:1px solid #ccc}p:empty{display:none}button:disabled{opacity:.6}</style><p role="status"></p><button type="button">ASIN下書き</button>`;
  document.body.append(host);
  const button = root.querySelector("button");
  const status = root.querySelector("p");
  function isForm() {
    return /\/(?:sell\/)?jp\/show\/(?:topsubmit|submit|resubmit|updateauction)/.test(location.pathname) || Boolean(document.querySelector("input[name='Title'],textarea[name='Description'],input[name='auctionTitle']"));
  }
  async function show() {
    button.disabled = true;
    status.textContent = "";
    try {
      const selection = await chrome.runtime.sendMessage({type: "selection"});
      if (!selection?.ok) throw new Error(selection?.error || "ページを再読み込みしてください");
      bridge.selectedAsin = selection.asin;
      const result = await chrome.runtime.sendMessage({type: "showHelper"});
      if (!result?.ok) throw new Error(result?.error || "入力補助を開けませんでした");
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  }
  button.addEventListener("click", async () => {
    if (isForm()) return show();
    button.disabled = true;
    try {
      const selection = await chrome.runtime.sendMessage({type: "selection"});
      const result = await chrome.runtime.sendMessage({type: "openListing", asin: selection?.asin});
      if (!result?.ok) throw new Error(result?.error || "出品ページを開けませんでした");
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  // Automatically open the preview only for the item handed over to this tab.
  chrome.runtime.sendMessage({type: "selection"}).then((result) => {
    if (result?.asin && isForm()) show();
  }).catch(() => { status.textContent = "拡張機能を更新した場合は、このページを再読み込みしてください。"; });
})();
