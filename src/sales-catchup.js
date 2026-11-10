// Bound work by both elapsed time and calls, while keeping the durable cursor.
// One completed week is not the same as catching up to today's orders.
export async function catchUpSales({sales,readState,now,elapsed=()=>performance.now(),maxPasses=12,budgetMs=120000}) {
  const began=elapsed();
  await sales.start({});
  let passes=0,tracking=(await readState()).salesTracking;
  while(passes<maxPasses&&elapsed()-began<budgetMs){
    const previous=tracking?.checkedThrough,window=tracking?.windowMs;
    await sales.check({catchUp:true});passes++;
    tracking=(await readState()).salesTracking;
    if(tracking?.sync?.status!=='complete'){
      if(tracking?.sync?.errorCode==='SALES_PAGE_LIMIT'&&tracking.windowMs< (window||7*86400000))continue;
      throw new Error('販売取得に失敗しました。保存済みの確認期間から再開します');
    }
    const checked=Date.parse(tracking.checkedThrough);
    if(!Number.isFinite(checked))throw new Error('販売の確認期間を確認できません');
    if(checked>=Date.parse(now())-15*60000)return {status:'complete',passes,checkedThrough:tracking.checkedThrough};
    if(previous&&checked<=Date.parse(previous))break;
  }
  return {status:'partial',passes,checkedThrough:tracking?.checkedThrough||null,
    note:'過去の販売履歴を補完中です。未確認期間は販売ゼロとせず、次回は保存済みの続きから再開します'};
}
