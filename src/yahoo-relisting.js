import {observeListing,registerSuccessor} from './link-monitor.js';
const normal=v=>String(v||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const refs=v=>JSON.stringify((v||[]).map(r=>[r.kind,r.value]).sort());
const fresh=(v,at)=>Number.isFinite(Date.parse(v))&&Date.parse(at)-Date.parse(v)>=-60000&&Date.parse(at)-Date.parse(v)<26*3600000;
export function relistingMatches(state,old,next,at){
 const links=state.links.filter(l=>l.listingId===old?.listingId);
 return Boolean(links.length&&links.every(l=>l.verified&&!l.observationConflict)&&links.every(l=>{const c=state.catalog?.find(c=>c.id===l.catalogId),asin=l.asin||c?.asin,asins=old?.references?.filter(r=>r.kind==='asin')||[];return asins.length?asins.every(r=>r.value===asin):old?.references?.some(r=>r.kind==='management'&&r.value===(l.amazonSellerSku||c?.sellerSku));})&&old?.observation?.verified&&old.observation.status==='ended'&&fresh(old.observation.checkedAt,at)&&old?.seller&&old.seller===next?.seller&&normal(old.title)&&normal(old.title)===normal(next.title)&&normal(old.condition)&&normal(old.condition)===normal(next.condition)&&old.references?.length&&refs(old.references)===refs(next.references)&&links.every(l=>l.referenceFingerprint===JSON.stringify(next.references||[])||l.matchBy==='asin'&&l.referenceFingerprint==='[]'&&old.references.every(r=>r.kind==='asin'&&r.value===l.asin))&&next.listingId!==old.listingId&&next.observation?.verified&&next.observation.status==='active'&&fresh(next.observation.checkedAt,at)&&!state.links.some(l=>l.listingId===next.listingId)&&!links.some(l=>(l.history||[]).some(h=>h.previousId===next.listingId)));
}
export function applyRelisting(state,{previousId,next,expected,oldSnapshot},at){
 const stored=state.listings.find(y=>y.listingId===previousId);
 if(oldSnapshot&&(oldSnapshot.listingId!==previousId||stored?.seller&&stored.seller!==oldSnapshot.seller||stored?.references?.length&&refs(stored.references)!==refs(oldSnapshot.references)))return false;
 const old=oldSnapshot||stored;
 const proofState={...state,listings:state.listings.map(y=>y.listingId===previousId?old:y)};
 if(!relistingMatches(proofState,old,next,at)||JSON.stringify(state.links.filter(l=>l.listingId===previousId).map(l=>[l.id,l.amazonSellerSku,l.referenceFingerprint]))!==expected)return false;
 if(oldSnapshot)observeListing(state,oldSnapshot);
 observeListing(state,next);
 for(const link of state.links.filter(l=>l.listingId===previousId)){
  link.history ||= [];
  link.referenceFingerprint=JSON.stringify(next.references||[]);
  registerSuccessor(state,link.id,{listingId:next.listingId,reviewed:true,evidence:'出品通知メールと公開ページ照合：出品者・商品名・状態・管理番号一致'},at);
 }
 return true;
}
export function createYahooRelisting({store,readMails,readListing,now=()=>new Date().toISOString()}){
 return async function follow(){
  const initial=await store.read(),at=now(),deadline=Date.now()+30000,rows=await readMails();let incomplete=Boolean(rows.partial),failures=0;
  const proofState=structuredClone(initial),linked=initial.listings.filter(old=>initial.links.some(l=>l.listingId===old.listingId));
  const offset=(initial.yahooRelisting?.cursor||0)%Math.max(1,linked.length),targets=[...linked.slice(offset),...linked.slice(0,offset)].slice(0,20),endedSnapshots=new Map();
  async function read(url){const remaining=deadline-Date.now();if(remaining<=0){incomplete=true;throw new Error('deadline');}return readListing(url,{maxDurationMs:Math.min(4000,remaining)});}
  for(let i=0;i<targets.length;i+=4){if(Date.now()>=deadline){incomplete=true;break;}await Promise.all(targets.slice(i,i+4).map(async old=>{try{const ended=await read(old.url||'https://auctions.yahoo.co.jp/jp/auction/'+old.listingId);if(ended.listingId!==old.listingId||old.seller&&old.seller!==ended.seller||old.references?.length&&refs(old.references)!==refs(ended.references))return;endedSnapshots.set(old.listingId,ended);proofState.listings[proofState.listings.findIndex(y=>y.listingId===old.listingId)]=ended;}catch{failures++;}}));}
  const titles=new Set(proofState.listings.filter(y=>initial.links.some(l=>l.listingId===y.listingId)).map(y=>normal(y.title)));
  const allCandidates=[...new Map(rows.filter(m=>titles.has(normal(m.title))&&!initial.links.some(l=>l.listingId===m.listingId)).map(m=>[m.listingId,m])).values()];
  if(allCandidates.length>20)incomplete=true;
  const candidates=allCandidates.slice(-20),snapshots=[];
  for(let i=0;i<candidates.length;i+=4){if(Date.now()>=deadline){incomplete=true;break;}await Promise.all(candidates.slice(i,i+4).map(async m=>{try{const next=await read('https://auctions.yahoo.co.jp/jp/auction/'+m.listingId);if(next.listingId===m.listingId)snapshots.push(next);}catch{failures++;}}));}
  const proposals=[],pending=[];
  for(const old of proofState.listings){
   const matches=snapshots.filter(n=>relistingMatches(proofState,old,n,at));
   if(matches.length!==1||proofState.listings.filter(y=>initial.links.some(l=>l.listingId===y.listingId)&&normal(y.title)===normal(old.title)).length!==1){for(const next of matches)for(const link of initial.links.filter(l=>l.listingId===old.listingId))pending.push({linkId:link.id,previousId:old.listingId,listingId:next.listingId,title:next.title,quantity:next.quantity??null});continue;}
   const next=matches[0];if(proofState.listings.filter(y=>relistingMatches(proofState,y,next,at)).length!==1)continue;
   proposals.push({previousId:old.listingId,next,oldSnapshot:endedSnapshots.get(old.listingId),expected:JSON.stringify(initial.links.filter(l=>l.listingId===old.listingId).map(l=>[l.id,l.amazonSellerSku,l.referenceFingerprint]))});
  }
  const adopted=await store.update(state=>{let count=0;for(const p of proposals)if(applyRelisting(state,p,at))count++;state.yahooRelisting={checkedAt:at,mailCandidates:candidates.length,adopted:count,pending:pending.slice(0,100),cursor:(offset+targets.length)%Math.max(1,linked.length),status:incomplete||failures?'partial':'complete',message:'再出品通知と公開ページを照合しました'};return count;});
  return {adopted,candidates:candidates.length,pending:pending.length};
 };
}
