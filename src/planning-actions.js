export const ACTION_LABELS={amazon:"Amazon販売を継続",advertising:"広告を検討",yahoo:"ヤフオク併売を検討",rakuten:"楽天併売を検討",catalog:"カタログ再作成を検討",replenish:"FBA追加納品を検討",price:"価格を見直す",return:"返送・古物市場出品",hold:"保留して再確認"};
export const ACTION_STAGES={undated:"日付未設定",waiting:"開始待ち",start:"開始の確認",active:"取り組み中",due:"締切・結果を確認",blocked:"前の結果待ち",skipped:"条件に該当せず",done:"結果を記録済み",cancelled:"取りやめ"};
const fail=m=>Object.assign(new Error(m),{status:400});
const validDate=v=>!v||/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v+"T00:00:00Z").toISOString().slice(0,10)===v;
export function normalizeActions(input,decisions){
  if(input===undefined)return [];
  if(!Array.isArray(input)||input.length>9)throw fail("アクションは9件以内で登録してください");
  const ids=new Set(),kinds=new Set();
  const actions=input.map(a=>{
    if(!a||typeof a.id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(a.id)||ids.has(a.id)||!Object.hasOwn(ACTION_LABELS,a.decision)||kinds.has(a.decision)||!decisions.includes(a.decision))throw fail("選んだ方針とアクションを確認してください");
    ids.add(a.id);kinds.add(a.decision);
    const startsOn=a.startsOn||"",endsOn=a.endsOn||"",dependsOn=a.dependsOn||"",trigger=a.trigger||"always",status=a.status||"planned",outcome=a.outcome||"pending",note=a.note||"";
    if([startsOn,endsOn,dependsOn,note].some(v=>typeof v!=="string")||!validDate(startsOn)||!validDate(endsOn)||startsOn&&endsOn&&startsOn>endsOn)throw fail("アクションの開始日・締切日の順番を確認してください");
    if(!["always","poor","good"].includes(trigger)||!dependsOn&&trigger!=="always"||!["planned","active","done","cancelled"].includes(status)||!["pending","good","poor","other"].includes(outcome)||status==="done"&&outcome==="pending"||status!=="done"&&outcome!=="pending"||note.length>500)throw fail("結果を記録済みにする場合は結果を選び、次のアクションの条件を確認してください");
    return {id:a.id,decision:a.decision,startsOn,endsOn,dependsOn,trigger,status,outcome,note:note.trim()};
  });
  const byId=new Map(actions.map(a=>[a.id,a]));
  for(const a of actions){let p=a;const seen=new Set([a.id]);while(p.dependsOn){if(!byId.has(p.dependsOn)||seen.has(p.dependsOn))throw fail("前のアクションが見つからないか、循環しています。順番を選び直してください");seen.add(p.dependsOn);p=byId.get(p.dependsOn);}}
  return actions;
}
export function actionSchedules(plan,at=new Date().toISOString()){
  const today=new Date(at).toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"}),actions=plan.actions||[],byId=new Map(actions.map(a=>[a.id,a]));
  function eligible(a){if(!a.dependsOn)return true;const p=byId.get(a.dependsOn);return Boolean(p&&p.status==="done"&&(a.trigger==="always"||p.outcome===a.trigger)&&eligible(p));}
  return actions.map(a=>{
    const parent=byId.get(a.dependsOn),ready=eligible(a)&&plan.status!=="closed"&&plan.status!=="hold";
    let stage=a.status==="done"?"done":a.status==="cancelled"||plan.status==="closed"?"cancelled":!ready?parent?.status==="done"?"skipped":"blocked":a.endsOn&&a.endsOn<=today?"due":a.status==="active"?"active":a.startsOn&&a.startsOn<=today?"start":a.startsOn?"waiting":"undated";
    const nextOn=ready&&!["done","cancelled"].includes(stage)?stage==="due"?a.endsOn:a.startsOn&&a.startsOn>today?a.startsOn:a.endsOn||a.startsOn:"";
    return {...a,label:ACTION_LABELS[a.decision],stage,ready,nextOn,parentLabel:parent?ACTION_LABELS[parent.decision]:"",conditionLabel:parent?`${ACTION_LABELS[parent.decision]}の${a.trigger==="good"?"結果が良ければ":a.trigger==="poor"?"結果が悪ければ":"結果を記録したら"}`:"日付になったら",startDue:ready&&!['done','cancelled'].includes(stage)&&Boolean(a.startsOn&&a.startsOn<=today),endDue:ready&&stage==="due"};
  });
}
