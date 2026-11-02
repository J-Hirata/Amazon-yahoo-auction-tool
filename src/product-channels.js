const family=v=>/^new/i.test(v||"")?"new":/^used/i.test(v||"")?"used":"unknown";
export function productChannels(row,monitor,watch,at){
  const snapshot=monitor.salesTargets?.listingSnapshot||watch.observations.listings;
  const unknown={state:"unknown",label:"未確認",skus:[],checkedAt:null};
  let fba={...unknown},merchant={...unknown};
  const age=Date.parse(at)-Date.parse(snapshot?.checkedAt),knownCondition=["new","used"].includes(row.condition);
  const targets=(monitor.salesTargets?.targets||[]).filter(t=>row.sourceKeys.includes(t.sourceId)),skus=new Set(targets.map(t=>t.sellerSku));if(row.sellerSku)skus.add(row.sellerSku);
  const fresh=snapshot?.status==="complete"&&snapshot.source==="own_seller_listings"&&snapshot.accountKey===monitor.amazonAccountKey&&snapshot.sellerId===monitor.amazonSellerId&&snapshot.marketplaceId==="A1VC38T7YXB528"&&snapshot.asins?.includes(row.asin)&&age>=-60000&&age<=26*3600000;
  if(fresh&&(knownCondition||row.sellerSku)){
    const matches=snapshot.rows.filter(p=>p.asin===row.asin&&(!knownCondition||family(p.condition)===row.condition)&&(!skus.size||skus.has(p.sellerSku)));
    const channel=(kind)=>{const offers=matches.filter(p=>p.fulfillment.some(f=>kind==="fba"?f.channel.startsWith("AMAZON"):f.channel==="DEFAULT")),active=offers.filter(p=>p.statuses.includes("BUYABLE"));return{state:active.length?"active":offers.length?"inactive":"absent",label:active.length?"出品中":offers.length?"販売停止・販売不可":"該当出品なし",skus:offers.map(p=>p.sellerSku),checkedAt:snapshot.checkedAt};};
    fba=channel("fba");merchant=channel("merchant");
  }else if(snapshot?.checkedAt){fba={...unknown,checkedAt:snapshot.checkedAt,label:fresh?"SKU・状態未照合":age>26*3600000?"情報が古い・未確認":"未確認"};merchant={...fba};}
  const yahoo=row.yahoo||[],active=yahoo.filter(y=>y.verified&&y.status==="active"&&Date.parse(at)-Date.parse(y.checkedAt)>=-60000&&Date.parse(at)-Date.parse(y.checkedAt)<=26*3600000),allEnded=yahoo.length&&yahoo.every(y=>y.verified&&y.status==="ended"&&Date.parse(at)-Date.parse(y.checkedAt)>=-60000&&Date.parse(at)-Date.parse(y.checkedAt)<=26*3600000);
  const channels={fba,merchant,yahoo:{state:active.length?"active":allEnded?"ended":yahoo.length?"unknown":"unlinked",label:active.length?"出品中":allEnded?"終了":yahoo.length?"未確認":"紐付けなし"},mercari:{state:row.rule.manualListingStatus==="mercari"?"active":"unknown",label:row.rule.manualListingStatus==="mercari"?"出品中（手動確認）":"未確認（未接続）",checkedAt:row.rule.manualListingAt||null}};
  const hasActive=Object.values(channels).some(c=>c.state==="active");
  return {...channels,unlisted:row.rule.manualListingStatus==="none"&&!hasActive,manualConflict:row.rule.manualListingStatus==="none"&&hasActive};
}
