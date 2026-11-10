// A product's alert is shared only by its explicit stock/link/plan references.
const has=(o,k)=>Object.hasOwn(o,k);
export const emptyLowStock=()=>({source:'',threshold:null});
const normalize=v=>v?.source&&v.threshold!==null?{source:v.source,threshold:v.threshold}:emptyLowStock();
export function sharedLowStock(row){
 const rules=(row.rules||[]).filter(r=>has(r,'lowStock')),values=new Map();
 for(const rule of rules){const value=normalize(rule.lowStock),key=JSON.stringify(value);if(!values.has(key))values.set(key,value);}
 const conflict=values.size>1,value=values.size===1?[...values.values()][0]:emptyLowStock();
 return {key:row.key,hasSetting:rules.length>0,conflict,...value,values:[...values.values()],origins:rules.map(r=>({key:r.key,...normalize(r.lowStock)}))};
}
export function saveSharedLowStock(watch,row,value,{actor,at,operationId}){
 const next=normalize(value),keys=new Set(row.sourceKeys||[row.key]);
 let primary=watch.rules.find(r=>r.key===row.key);
 if(!primary){primary={key:row.key,tags:[],replenishEnabled:false,threshold:10,minimumSales7:0,coverageDays:0,reviewDays:10,startedOn:'',note:'',updatedAt:at};watch.rules.push(primary);}
 for(const rule of watch.rules.filter(r=>keys.has(r.key)&&(has(r,'lowStock')||r===primary))){
  if(JSON.stringify(rule.lowStock)!==JSON.stringify(next))(watch.lowStockHistory||=[]).push({key:rule.key,operationId,actor,at,before:rule.lowStock||null,after:{...next}});
  rule.lowStock={...next};rule.lowStockUpdatedAt=at;
 }
 return next;
}
