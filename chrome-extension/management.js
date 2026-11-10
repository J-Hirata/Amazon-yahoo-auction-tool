(() => {
  if (!["http://localhost:41731","https://amazon-yahoo-inventory.vercel.app"].includes(location.origin)) return;
  document.documentElement.dataset.asinYahooExtension = "ready";
  document.documentElement.dataset.asinYahooExtensionVersion='1.0.4';
  document.addEventListener("asin-yahoo-open", async (event) => {
    try {
      const result = await chrome.runtime.sendMessage(event.detail?.drafts?{type:'openCloudListings',handoffId:event.detail.handoffId,drafts:event.detail.drafts,yahooSellerUrl:event.detail.yahooSellerUrl}:{type: "openListing", asin: event.detail?.asin || null});
      document.dispatchEvent(new CustomEvent("asin-yahoo-result", {detail: result}));
    } catch {
      document.dispatchEvent(new CustomEvent("asin-yahoo-result", {detail: {ok: false, error: "拡張機能を更新した場合は、管理画面を再読み込みしてください。"}}));
    }
  });
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id||message.type!=='cloudDraftProgress'||location.origin!=='https://amazon-yahoo-inventory.vercel.app')return;
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{document.removeEventListener('asin-yahoo-progress-result',done);reply({ok:false,error:'保存結果が未確認です。販売コックピットで確認してください。'});},20000);
    function done(event){if(event.detail?.id!==id)return;clearTimeout(timer);document.removeEventListener('asin-yahoo-progress-result',done);reply(event.detail.result);}
    document.addEventListener('asin-yahoo-progress-result',done);
    document.dispatchEvent(new CustomEvent('asin-yahoo-progress',{detail:{id,handoffId:message.handoffId,asin:message.asin,patch:message.patch}}));
    return true;
  });
})();
