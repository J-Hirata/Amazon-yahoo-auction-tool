import {normalizeAsinInput} from '../src/asin-input.js';
const family=value=>value==='parts'?'parts':/^(new|新品)/i.test(value||'')?'new':/^(used|中古)/i.test(value||'')?'used':'unknown';
export function registrationCandidates(options,{asin='',sellerSku='',condition='unknown',linkedLinkIds=[]}={}){
  asin=normalizeAsinInput(asin);sellerSku=sellerSku.trim();
  const current=new Set(linkedLinkIds);
  return options.filter(l=>current.has(l.id)||Boolean(asin||sellerSku)&&(!asin||l.asin===asin)&&(!sellerSku||l.sellerSku===sellerSku)).map(l=>{
    const known=family(l.condition),selected=family(condition),existing=current.has(l.id);
    return {...l,existing,mismatch:Boolean(asin&&l.asin!==asin||sellerSku&&l.sellerSku&&l.sellerSku!==sellerSku||known!=='unknown'&&selected!=='unknown'&&known!==selected)};
  });
}

export function selectedYahooListing(options,ids){return [...ids].map(id=>options.find(l=>l.id===id)).find(l=>l&&/^[a-z][0-9]+$/i.test(l.listingId||''))||null;}
