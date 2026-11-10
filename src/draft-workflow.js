const statuses=new Set(['ready_for_draft','waiting_for_product_data','input_done','draft_saved','listed','sold','archived']);

export function changeDraftStatus(next,item,patch,at){
 if(patch.saveConfirmed!==undefined&&!(patch.saveConfirmed===true&&patch.status==='draft_saved'&&!patch.restore))throw new Error('Yahoo側の保存完了を確認してから記録してください');
 if(patch.restore!==undefined&&patch.restore!==true)throw new Error('戻す操作を確認してください');
 if(patch.restore&&('status' in patch||!['archived','deleted'].includes(item.status)))throw new Error('アーカイブした商品のみ元の状態へ戻せます');
 const restoring=patch.restore===true;
 const legacySave=patch.status==='draft_saved'&&patch.saveConfirmed!==true;
 // Old extensions sent draft_saved after pasting. They cannot confirm or undo completed work.
 if(legacySave&&['draft_saved','listed','sold','archived','deleted'].includes(item.status))return;
 const status=restoring?(item.archivedFromStatus||'waiting_for_product_data'):legacySave?'input_done':patch.status;
 if(status===undefined)return;
 if(!statuses.has(status)||restoring&&status==='archived')throw new Error('商品の作業状態を確認してください');
 next.status=status;
 const confirming=status==='draft_saved'&&!restoring&&patch.saveConfirmed===true&&!item.draftSaveConfirmedAt;
 if(status===item.status&&!confirming)return;
 if(status==='archived'){
  next.archivedFromStatus=item.status==='deleted'?'waiting_for_product_data':item.status;
  next.archivedAt=at;
 }else if(!restoring){
  if(status==='input_done')next.inputCompletedAt=at;
  if(status==='draft_saved'){next.draftSavedAt=at;next.draftSaveConfirmedAt=at;}
  if(status==='listed')next.listedAt=at;
  if(status==='sold')next.soldAt=at;
 }
 // Going back to preparation never erases previous saved/listed timestamps.
 next.workHistory=[...(item.workHistory||[])];
 for(const [key,to] of [['inputCompletedAt','input_done'],['draftSavedAt','draft_saved'],['listedAt','listed'],['soldAt','sold'],['archivedAt','archived']]){
  const old=item[key];if(old&&Number.isFinite(Date.parse(old))&&!next.workHistory.some(e=>e.at===old&&e.to===to))next.workHistory.push({at:old,to,kind:'status',source:to==='draft_saved'&&item.draftSaveConfirmedAt===old?'owner':'legacy'});
 }
 next.workHistory.push({at,from:item.status,to:status,kind:restoring?'restore':confirming?'confirm_saved':'status',source:'owner',...(restoring&&status==='draft_saved'&&!item.draftSaveConfirmedAt?{unconfirmed:true}:{})});
}
