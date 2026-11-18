import {applyPlanningCommand,planningSchedule} from './sales-planning.js';

const fail=message=>Object.assign(new Error(message),{status:400});
export const monitoringFields=['availableOn','durationDays','reviewOn','adStartedOn','note'];

// Patch only explicitly edited fields on an already related plan. The caller's
// transaction owns revision checks, rollback and replay protection.
export function saveWorkspaceMonitoring(docs,row,input,{actor,at,operationId,summary}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['planId',...monitoringFields].includes(k)))throw fail('販売監視の入力内容を確認してください');
 const related=(row?.plans||[]).filter(p=>p.status!=='closed');
 const selected=input.planId?related.find(p=>p.id===input.planId):related.length===1?related[0]:null;
 if(!selected)throw fail('設定する販売監視を選択してください');
 const plan=docs['sales-planning'].state.plans.find(p=>p.id===selected.id);
 const changes=Object.fromEntries(monitoringFields.filter(k=>Object.hasOwn(input,k)&&input[k]!==plan[k]).map(k=>[k,input[k]]));
 if(!Object.keys(changes).length)return;
 const before=structuredClone(plan);
 applyPlanningCommand(docs['sales-planning'].state,{operationId,kind:'edit',planId:plan.id,plan:{...plan,...changes}},{actor,at,sources:[{...plan,...plan.source}]});
 const labels={availableOn:'販売監視の開始日',durationDays:'確認する期間（日）',reviewOn:'確認日',adStartedOn:'広告開始日',note:'販売監視の目的・メモ'};
 for(const k of Object.keys(changes))summary.push(labels[k]+'：'+(before[k]||'未設定')+' → '+(plan[k]||'未設定'));
 const schedule=planningSchedule(plan,at);summary.push('販売監視期間：'+(schedule.startedOn||'開始日未設定')+' → '+(schedule.dueOn||'確認日未設定'));
}
