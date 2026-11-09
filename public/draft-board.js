export const DRAFT_STAGES={
 pending:{label:'これから出す',title:'これから出す商品',help:'準備中・準備できた商品・下書き保存済みをまとめて表示。ドラッグや左右の矢印で作業順を変えられます。'},
 ready:{label:'出品準備できた',title:'出品準備できた商品',help:'写真・価格・現物を確認し、下書き文面からヤフオクへ進めます。10件を超えてもここに表示します。'},
 needs:{label:'情報を補う',title:'情報を補う商品',help:'不足している情報をカードで確認し、「商品情報・作業状態」で編集します。写真・商品名はASINから補完できます。'},
 saved:{label:'保存済み・出品未記録',title:'保存済み・出品未記録',help:'下書き保存の記録があり、出品完了はまだ記録されていない商品です。Yahoo側の実際の出品を確認し、出品済みなら状態を更新してください。'},
 listed:{label:'出品済み',title:'出品済みの商品',help:'出品したと手動で記録した商品です。ヤフオクの実際の出品状況は各商品から確認してください。'},
 done:{label:'保留・売却済み',title:'保留・売却済みの商品',help:'今の出品作業から外した商品です。削除せず残してあり、編集から準備中へ戻せます。'}
};
export function draftStage(item){
 return item.status==='ready_for_draft'?'ready':item.status==='draft_saved'?'saved':item.status==='listed'?'listed':['sold','archived','deleted'].includes(item.status)?'done':'needs';
}
export function draftHints(item){
 const hints=[];if(!item.title?.trim()||item.title===item.asin)hints.push('商品名');if(!item.description?.trim())hints.push('説明');if(!item.imageUrls?.length&&!item.displayImageUrl)hints.push('写真');if(!(typeof item.startPrice==='number'&&item.startPrice>0))hints.push('参考価格');return hints;
}
export function workOrder(items){
 return items.map((item,index)=>({item,index})).sort((a,b)=>(Number.isSafeInteger(a.item.workPriority)?a.item.workPriority:Infinity)-(Number.isSafeInteger(b.item.workPriority)?b.item.workPriority:Infinity)||(Date.parse(a.item.createdAt)||0)-(Date.parse(b.item.createdAt)||0)||a.index-b.index).map(r=>r.item);
}
export function boardItems(items,stage='pending',query=''){
 const term=query.trim().toLocaleLowerCase('ja');
 return workOrder(items).filter(item=>stage==='pending'?['ready','needs','saved'].includes(draftStage(item)):draftStage(item)===stage).filter(item=>!term||[item.title,item.displayTitle,item.asin,item.description].join(' ').toLocaleLowerCase('ja').includes(term));
}
