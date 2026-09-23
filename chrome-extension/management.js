(() => {
  if (location.origin !== "http://localhost:41731") return;
  document.documentElement.dataset.asinYahooExtension = "ready";
  document.addEventListener("asin-yahoo-open", async (event) => {
    try {
      const result = await chrome.runtime.sendMessage({type: "openListing", asin: event.detail?.asin || null});
      document.dispatchEvent(new CustomEvent("asin-yahoo-result", {detail: result}));
    } catch {
      document.dispatchEvent(new CustomEvent("asin-yahoo-result", {detail: {ok: false, error: "拡張機能を更新した場合は、管理画面を再読み込みしてください。"}}));
    }
  });
})();
