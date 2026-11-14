import {id,hash} from '../shared/photo-bridge.mjs';
import {readMarketPage} from './market-pages.js';
const fail=(m,status=400)=>Object.assign(Error(m),{status});
export function createResearchApi({provider,workspaceId,now=()=>Date.now(),pageReader=readMarketPage}){
 const cache=new Map();
 return {
  capabilities:()=>({protocol:'research-query/v1',...provider.capabilities(),publicPageRead:true}),
  async page(raw){if(raw?.protocol!=='market-page/v1'||!id(raw.operationId)||raw.workspaceId!==workspaceId||!id(raw.productId))throw fail('検索する商品の接続元を確認してください',403);const fingerprint=hash(JSON.stringify(raw)),cacheKey='page:'+raw.operationId;for(const [k,v]of cache)if(v.until<now())cache.delete(k);const old=cache.get(cacheKey);if(old){if(old.fingerprint!==fingerprint)throw fail('同じ処理IDで内容が変更されています',409);return old.promise;}if(cache.size>=200)throw fail('取得が混み合っています。時間をおいて再試行してください',429);const promise=pageReader(raw).then(value=>({protocol:'market-page/v1',productId:raw.productId,operationId:raw.operationId,...value}),error=>{cache.delete(cacheKey);throw error;});cache.set(cacheKey,{fingerprint,promise,until:now()+120000});return promise;},
  async query(raw){
   if(raw?.protocol!=='research-query/v1'||!id(raw.operationId)||raw.workspaceId!==workspaceId||!id(raw.productId)||![0,1].includes(raw.keepaBudget))throw fail('リサーチの接続元・対象を確認してください',403);
   const fingerprint=hash(JSON.stringify(raw));
   for(const [k,v]of cache)if(v.until<now())cache.delete(k);
   const old=cache.get(raw.operationId);
   if(old){if(old.fingerprint!==fingerprint)throw fail('同じ処理IDで内容が変更されています',409);return old.promise;}
   if(cache.size>=200)throw fail('リサーチ処理が混み合っています。時間をおいて再開してください',429);
   const promise=provider.query(raw).then(result=>({protocol:'research-result/v1',operationId:raw.operationId,productId:raw.productId,...result}));
   cache.set(raw.operationId,{fingerprint,promise,until:now()+120000});
   return promise;
  }
 };
}
