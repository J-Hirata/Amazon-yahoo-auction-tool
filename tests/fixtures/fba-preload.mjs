// Loaded only by the browser test child process. Never imported by production code.
const originalFetch = globalThis.fetch;
let authCalls = 0;
let previewCalls = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "auctions.yahoo.co.jp") {
    previewCalls++;
    if (previewCalls === 2) return new Response("test temporary error", {status: 503});
    const auctionId = url.pathname.split("/").at(-1);
    const index = Number(auctionId.slice(-1));
    const asin = index === 1 ? "B000DEMO01" : `B000OTHER${index - 1}`;
    const item = {auctionId, title: "練習用モニター スタンドなし", status: "open", descriptionHtml: `【管理番号】ASIN: ${asin}`};
    return new Response(`<meta property="og:image" content="https://auctions.c.yimg.jp/test-product.png"><script id="__NEXT_DATA__">${JSON.stringify({props: {pageProps: {initialState: {item: {detail: {item}}}}}})}</script>`);
  }
  if (url.hostname === "api.amazon.com") {
    if (options.method !== "POST" || options.body.get("client_id") !== "test-client") throw new Error("Unexpected test authentication");
    authCalls++;
    return authCalls === 2 ? new Response("mock authorization failure", {status: 403}) : Response.json({access_token: "test-access-token"});
  }
  if (url.hostname === "sellingpartnerapi-fe.amazon.com") {
    if (options.method !== "GET") throw new Error("Unexpected test write operation");
    if (url.pathname.includes("/products/pricing/")) return Response.json({payload: {Offers: [{MyOffer: true, SellerId: "TESTSELLER"}]}});
    if (url.pathname.includes("/listings/")) {
      if (!url.searchParams.get("identifiers")) throw new Error("Unfiltered listing reads are forbidden");
      return Response.json({items: [{sku: "AUTO-SKU-001", summaries: [{marketplaceId: "A1VC38T7YXB528", asin: "B000OTHER1"}], attributes: {condition_note: [{marketplace_id: "A1VC38T7YXB528", value: "状態良好。電源コード付属"}]}}]});
    }
    if (url.pathname !== "/fba/inventory/v1/summaries" || !url.searchParams.get("sellerSkus")) throw new Error("Unfiltered inventory reads are forbidden");
    return url.searchParams.has("nextToken") ? Response.json({payload: {inventorySummaries: []}}) : Response.json({
      payload: {inventorySummaries: [{asin: "B000OTHER1", sellerSku: "AUTO-SKU-001", fnSku: "AUTO-FNSKU",
        productName: "自動取得テスト商品", condition: "UsedGood", inventoryDetails: {fulfillableQuantity: 5}}]},
      pagination: {nextToken: "test-next-page"}
    });
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("External networking is disabled in this browser test");
  return originalFetch(input, options);
};
