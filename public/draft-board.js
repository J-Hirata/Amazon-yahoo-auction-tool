export const DRAFT_STAGES={
 pending:{label:'下書き作成待ち',title:'下書き作成待ち',help:'これから文面を作る商品です。保存済みの商品は別の欄にあります。ドラッグ・矢印で作業順を変えられます。'},
 ready:{label:'出品準備できた',title:'出品準備できた商品',help:'写真・価格・現物を確認し、下書き文面からヤフオクへ進めます。10件を超えてもここに表示します。'},
 needs:{label:'情報を補う',title:'情報を補う商品',help:'不足している情報をカードで確認し、「商品情報・作業状態」で編集します。写真・商品名はASINから補完できます。'},
 input:{label:'入力済み・保存確認',title:'入力済み・保存を確認する商品',help:'旧ツールの「貼り付け完了」もここに引き継ぎます。入力だけで保存・出品済みにはしません。Yahoo側で保存できているか確認して記録してください。'},
 saved:{label:'下書き保存済み',title:'下書き保存済み',help:'Yahoo側での下書き保存を確認して記録した商品です。出品完了は別に記録します。'},
 listed:{label:'出品済み',title:'出品済みの商品',help:'出品したと手動で記録した商品です。ヤフオクの実際の出品状況は各商品から確認してください。'},
 sold:{label:'売却済み',title:'売却済み',help:'売却完了を記録した商品です。保存記録と商品情報は残ります。'},
 history:{label:'履歴',title:'保存・出品・作業の履歴',help:'旧ツールの保存日時と、以後の状態変更を日時順に表示します。日時の残っていない過去の操作は補っていません。'},
 archived:{label:'アーカイブ',title:'アーカイブ',help:'今の作業から外して保管した商品です。文面・写真・履歴を残し、元の作業状態に戻せます。'}
};
export const DRAFT_TABS=['pending','input','saved','listed','sold','history','archived'];
export function draftStage(item){
 return item.status==='ready_for_draft'?'ready':item.status==='input_done'?'input':item.status==='draft_saved'?(item.draftSaveConfirmedAt?'saved':'input'):item.status==='listed'?'listed':item.status==='sold'?'sold':['archived','deleted'].includes(item.status)?'archived':'needs';
}
export function draftStatusLabel(status){return {waiting_for_product_data:'情報を補う',ready_for_draft:'下書き作成待ち・準備完了',input_done:'入力済み・保存を確認',draft_saved:'下書き保存済み',listed:'出品済み（記録）',sold:'売却済み（記録）',archived:'アーカイブ',deleted:'旧ツールで除外'}[status]||status||'情報を補う';}
export function draftItemLabel(item){return item.status==='draft_saved'&&!item.draftSaveConfirmedAt?'旧・貼り付け完了（保存未照合）':draftStatusLabel(item.status);}
export function draftHints(item){
 const hints=[];if(!item.title?.trim()||item.title===item.asin)hints.push('商品名');if(!item.description?.trim())hints.push('説明');if(!item.imageUrls?.length&&!item.displayImageUrl)hints.push('写真');if(!(typeof item.startPrice==='number'&&item.startPrice>0))hints.push('参考価格');return hints;
}
export function workOrder(items){
 return items.map((item,index)=>({item,index})).sort((a,b)=>(Number.isSafeInteger(a.item.workPriority)?a.item.workPriority:Infinity)-(Number.isSafeInteger(b.item.workPriority)?b.item.workPriority:Infinity)||(Date.parse(a.item.createdAt)||0)-(Date.parse(b.item.createdAt)||0)||a.index-b.index).map(r=>r.item);
}
export function boardItems(items,stage='pending',query=''){
 const term=query.trim().toLocaleLowerCase('ja');
 return workOrder(items).filter(item=>stage==='pending'?['ready','needs'].includes(draftStage(item)):stage==='history'?draftHistory(item).length>0:draftStage(item)===stage).filter(item=>!term||[item.title,item.displayTitle,item.asin,item.description].join(' ').toLocaleLowerCase('ja').includes(term));
}
// Existing timestamps are records from the old tool, not a live Yahoo listing check.
export function draftHistory(item,{registration=false}={}){
 const events=(item.workHistory||[]).filter(e=>e&&Number.isFinite(Date.parse(e.at))).map(e=>({...e,source:e.source==='legacy'?'legacy':'recorded'}));
 for(const [key,to] of [['inputCompletedAt','input_done'],['draftSavedAt','draft_saved'],['listedAt','listed'],['soldAt','sold'],['archivedAt','archived']]){
  const at=item[key];if(at&&Number.isFinite(Date.parse(at))&&!events.some(e=>e.at===at&&e.to===to))events.push({at,to,kind:'status',source:to==='draft_saved'&&item.draftSaveConfirmedAt===at?'recorded':'legacy'});
 }
 if(registration&&item.createdAt&&Number.isFinite(Date.parse(item.createdAt)))events.push({at:item.createdAt,kind:'registered',source:'legacy'});
 return events.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
}
export function draftEventLabel(event){return event.kind==='registered'?'商品登録':(event.kind==='restore'?'アーカイブから戻す → ':event.to==='ready_for_draft'&&event.from?'作成待ちへ戻す → ':'')+(event.to==='draft_saved'&&(event.source==='legacy'||event.unconfirmed)?'貼り付け完了（旧記録・保存未照合）':draftStatusLabel(event.to));}
