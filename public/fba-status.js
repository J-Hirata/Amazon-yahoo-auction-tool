export function fbaStatus(live){
 const f=live?.availability?.fba||live?.fba||{},status=f.autoStatus||f.status;
 if(Number.isSafeInteger(f.quantity))return {message:'Amazonの取得値を表示します。通常は手入力不要です。',needsSku:false};
 if(status==='ambiguous')return {message:'複数のSKUがあります。対象SKUを選ぶとAmazon取得数を表示します。',needsSku:true};
 if(status==='not_found')return {message:'登録SKUとAmazonのFBA在庫が一致しません。SKUを確認してください。',needsSku:true};
 if(status==='not_fba')return {message:'FBAの出品対象が見つかりません。自社発送の数量とは別に確認します。',needsSku:true};
 if(status==='stale')return {message:'取得から時間が経っています。Amazonから再取得してください。',needsSku:false};
 if(status==='draft')return {message:'出品下書きだけの登録です。実在庫・商品紐付け・販売監視への登録後に自動取得します。',needsSku:false};
 return {message:'Amazonの在庫がまだ取得できていません。再取得で確認できます。自動確認は1日1回です。',needsSku:false};
}
