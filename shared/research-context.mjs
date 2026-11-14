import {id,sha,hash} from './photo-bridge.mjs';
import {inputValues,decisionValues,ownDescription,normalized} from './research-core.mjs';
const fail=(m,status=400)=>Object.assign(Error(m),{status});
export function parseResearchContext(raw){
 if(raw?.protocol!=='research-context/v1'||![raw.id,raw.sourceWorkspaceId,raw.productId,raw.packageId].every(id)||!sha(raw.packageDigest)||!sha(raw.resultDigest)||!Number.isSafeInteger(raw.recordVersion)||raw.recordVersion<1||!Number.isFinite(Date.parse(raw.createdAt)))throw fail('リサーチと写真セットの対応を確認してください');
 const input=inputValues(raw.input),decision=decisionValues(raw.decision);
 if(!['yahoo','mercari'].includes(decision.channel))throw fail('下書き受渡しはヤフオク・メルカリを選んでください');
 if(decision.candidateAsin&&!decision.candidateConfirmed)throw fail('採用するカタログは本人確認を完了してください');
 return {protocol:'research-context/v1',id:raw.id,sourceWorkspaceId:raw.sourceWorkspaceId,productId:raw.productId,packageId:raw.packageId,packageDigest:raw.packageDigest,resultDigest:raw.resultDigest,recordVersion:raw.recordVersion,input,decision,createdAt:new Date(raw.createdAt).toISOString(),title:[input.model&&!normalized(input.name).includes(normalized(input.model))?input.model:'',input.name].filter(Boolean).join(' '),description:ownDescription(input)};
}
export function validateResearchContexts(state){
 const contexts=state.researchContexts||[];
 if(!Array.isArray(contexts)||new Set(contexts.map(c=>c?.id)).size!==contexts.length)throw fail('リサーチ共有の保存形式を確認してください');
 for(const raw of contexts){const c=parseResearchContext(raw),p=state.packages.find(p=>p.packageId===c.packageId);if(!p||p.sourceWorkspaceId!==c.sourceWorkspaceId||p.productId!==c.productId||p.digest!==c.packageDigest)throw fail('別の商品の写真にリサーチ結果が紐付いています');if(c.decision.photoIds?.some(id=>!p.assets.some(a=>a.id===id)))throw fail('下書き写真が別の商品に属しています');}
 return state;
}
export function contextFingerprint(raw){return hash(JSON.stringify(parseResearchContext(raw)));}
