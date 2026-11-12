import {inputValues,settingsValues,candidateMatch,searchLinks} from '../shared/research-core.mjs';
const MARKET='A1VC38T7YXB528',ASIN=/^[A-Z0-9]{10}$/;
const strings=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.length<=500):[];
const unique=v=>[...new Set(v.filter(Boolean))];
const valueArray=(a,key)=>strings((a?.[key]||[]).filter(v=>!v.marketplace_id||v.marketplace_id===MARKET).map(v=>v.value));
const amount=v=>v?.CurrencyCode==='JPY'&&Number.isFinite(Number(v.Amount))&&Number(v.Amount)>=0&&Number(v.Amount)<=100000000?Number(v.Amount):null;
const kp=v=>Number.isSafeInteger(v)&&v>0&&v<=100000000?v:null;
export function amazonCandidate(raw,at){
 if(!ASIN.test(raw?.asin||''))return null;
 const a=raw.attributes||{},s=raw.summaries?.find(v=>v.marketplaceId===MARKET)||{},ids=(raw.identifiers||[]).filter(v=>v.marketplaceId===MARKET).flatMap(v=>v.identifiers||[]);
 const jans=unique([...ids.filter(v=>['EAN','UPC','GTIN'].includes(v.identifierType)).map(v=>v.identifier),...valueArray(a,'externally_assigned_product_identifier')].filter(v=>typeof v==='string').map(v=>/^\d{12}$/.test(v)?'0'+v:v));
 return {id:raw.asin,asin:raw.asin,title:String(s.itemName||valueArray(a,'item_name')[0]||raw.asin).slice(0,500),manufacturer:valueArray(a,'manufacturer')[0]||s.manufacturer||'',brand:s.brandName||valueArray(a,'brand')[0]||'',models:unique([...valueArray(a,'model_number'),...valueArray(a,'part_number'),s.partNumber]),jans,color:valueArray(a,'color')[0]||'',size:valueArray(a,'size')[0]||'',spec:[...valueArray(a,'item_package_quantity'),...valueArray(a,'capacity')].join(' / '),url:'https://www.amazon.co.jp/dp/'+raw.asin,source:'sp_api',checkedAt:at};
}
export function keepaCandidate(p,at){
 if(!ASIN.test(p?.asin||'')||p.domainId!==5||p.productType===4)return null;
 return {id:p.asin,asin:p.asin,title:String(p.title||p.asin).replace(/<[^>]*>/g,'').slice(0,500),manufacturer:String(p.manufacturer||'').slice(0,120),brand:String(p.brand||'').slice(0,120),models:unique(strings([p.model,p.partNumber])),jans:unique([...strings(p.eanList),...strings(p.upcList).map(v=>/^\d{12}$/.test(v)?'0'+v:v)]),color:String(p.color||'').slice(0,100),size:String(p.size||'').slice(0,100),spec:Number.isSafeInteger(p.numberOfItems)?'数量 '+p.numberOfItems:'',url:'https://www.amazon.co.jp/dp/'+p.asin,source:'keepa',checkedAt:at};
}
export function amazonPrice(body,asin,condition,at){
 const p=body?.payload;if(!p||p.ASIN!==asin||p.status&&p.status!=='Success'||p.ItemCondition&&String(p.ItemCondition).toLowerCase()!==condition)return null;
 const rows=(p.Summary?.LowestPrices||[]).filter(v=>String(v.condition).toLowerCase()===condition).map(v=>({item:amount(v.ListingPrice),shipping:amount(v.Shipping),total:amount(v.LandedPrice),fulfillment:String(v.fulfillmentChannel||'')}));
 const offers=(p.Offers||[]).filter(v=>!v.ItemCondition||String(v.ItemCondition).toLowerCase()===condition).map(v=>({item:amount(v.ListingPrice),shipping:amount(v.Shipping),total:amount(v.ListingPrice)!==null&&amount(v.Shipping)!==null?amount(v.ListingPrice)+amount(v.Shipping):null,fulfillment:v.IsFulfilledByAmazon?'Amazon':'Merchant'}));
 const all=[...rows,...offers].filter(v=>v.total!==null&&v.total>0).sort((a,b)=>a.total-b.total),low=all[0]||rows.filter(v=>v.item>0).sort((a,b)=>a.item-b.item)[0];
 return low?{source:'sp_api',asin,condition,kind:'asking',item:low.item,shipping:low.shipping,total:low.total,currency:'JPY',checkedAt:at,sourceUpdatedAt:null,scope:'日本・一般購入者・取得できた価格範囲（送料込みが判明したものを優先、中古の細かな状態別は未取得）',url:'https://www.amazon.co.jp/dp/'+asin}:null;
}
export function keepaPrices(p,at){
 if(p?.domainId!==5||p.productType!==0||!ASIN.test(p.asin||''))return [];
 const updated=Number.isSafeInteger(p.lastUpdate)&&p.lastUpdate>=0?new Date((p.lastUpdate+21564000)*60000).toISOString():null;
 return [['new',1],['used',2]].flatMap(([condition,i])=>{const v=kp(p.stats?.current?.[i]);return v?[{source:'keepa',asin:p.asin,condition,kind:'asking_cached',item:v,shipping:null,total:null,currency:'JPY',checkedAt:at,sourceUpdatedAt:updated,scope:'Keepa最終取得の参考価格・送料の扱い未確認。成約価格ではありません。',url:'https://keepa.com/#!product/5-'+p.asin}]:[];});
}
function fault(code,message){return Object.assign(new Error(message),{code});}
async function boundedData(response){
 const reader=response.body?.getReader();if(!reader)throw fault('INVALID_RESPONSE','応答を読み取れません。');const chunks=[];let n=0;
 try{for(;;){const v=await reader.read();if(v.done)break;n+=v.value.length;if(n>1500000){await reader.cancel();throw fault('RESPONSE_LIMIT','応答が大きすぎます。');}chunks.push(v.value);}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('INVALID_RESPONSE','応答形式を確認できません。');}
}
export function createResearchProvider({amazon=null,keepaKey='',fetchImpl=fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 let token=null,lastPrice=0;
 const capabilities=()=>({amazon:Boolean(amazon?.clientId&&amazon?.clientSecret&&amazon?.refreshToken&&amazon.marketplaceId===MARKET),keepa:Boolean(keepaKey),googleApi:false,imagesAutomatic:false,soldAutomatic:false,keepaMode:'既存データのみ・追加offersなし・最大1トークン/要求'});
 async function query(raw){
  const input=inputValues(raw.input),settings=settingsValues(raw.settings),at=new Date(now()).toISOString(),links=searchLinks(input,settings),result={candidates:[],prices:[],issues:[],links,checkedAt:at,keepaTokens:0,keepaRequests:0,listingEligibility:{status:'not_checked',message:'カタログの有無と本人の出品可否は別です。'},mode:'manual'};
  const deadline=now()+26000;
  const request=async(url,options={})=>{
   const remain=Math.min(7000,deadline-now());if(remain<300)throw fault('TIMEOUT','取得時間の上限です。再開できます。');
   let r;try{r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(remain)});}catch{throw fault('CONNECTION','接続を確認できません。再試行できます。');}
   if(!r.ok){await r.body?.cancel();throw fault('HTTP_'+r.status,r.status===403?'APIの権限を確認してください。':r.status===429?'取得上限です。時間をおいて再試行してください。':r.status===404?'取得対象が見つかりませんでした。':'APIから取得できませんでした。');}
   return boundedData(r);
  };
  const issue=(stage,e)=>result.issues.push({stage,code:e.code||'UNAVAILABLE',message:e.message||'取得できませんでした。'});
  const amazonGet=async(path,pricing=false)=>{
   if(!token||token.until<now()){
    const t=await request('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:amazon.clientId,client_secret:amazon.clientSecret,refresh_token:amazon.refreshToken})});
    if(typeof t.access_token!=='string'||!t.access_token)throw fault('AUTH','Amazon認証を確認してください。');token={value:t.access_token,until:now()+Math.max(60,Number(t.expires_in)||3600)*1000-60000};
   }
   if(pricing){const delay=Math.max(0,lastPrice+2100-now());if(delay){if(now()+delay>deadline)throw fault('TIMEOUT','価格の取得待ちです。');await sleep(delay);}lastPrice=now();}
   return request('https://sellingpartnerapi-fe.amazon.com'+path,{headers:{'x-amz-access-token':token.value}});
  };
  const amazonWanted=settings.priority.includes('amazon')||settings.compare.includes('amazon');
  const canSearch=amazonWanted&&capabilities().amazon&&settings.discovery==='direct'&&settings.priority[0]==='amazon';
  if(!input.asin&&!canSearch){result.issues.push({stage:'検索',code:'MANUAL_SEARCH',message:settings.discovery==='lens'?'写真を選んでレンズで調べ、判明した型番・ASINを保存してください。':'設定した最初の検索画面で候補を確認してください。'});}
  if(amazonWanted&&capabilities().amazon&&(input.asin||canSearch)){
   result.mode='api';
   try{
    const args=new URLSearchParams({marketplaceIds:MARKET,includedData:'summaries,identifiers,attributes'});
    let data;
    if(input.asin)data={items:[await amazonGet('/catalog/2022-04-01/items/'+input.asin+'?'+args)]};
    else if(input.jan){args.set('identifiers',input.jan);args.set('identifiersType','EAN');args.set('pageSize','5');data=await amazonGet('/catalog/2022-04-01/items?'+args);}
    else if(input.model||input.name){args.set('keywords',[input.manufacturer,input.model||input.name.replace(/^\d+\s+/, '')].filter(Boolean).join(' '));args.set('pageSize','5');data=await amazonGet('/catalog/2022-04-01/items?'+args);}
    else data={items:[]};
    result.candidates=(data.items||[]).map(p=>amazonCandidate(p,at)).filter(Boolean).map(c=>({...c,match:candidateMatch(input,c)}));
    result.candidates.sort((a,b)=>({match:0,candidate:1,mismatch:2}[a.match.status]-{match:0,candidate:1,mismatch:2}[b.match.status]));
   }catch(e){issue('Amazon商品候補',e);}
  }else if(!capabilities().amazon&&settings.compare.includes('amazon'))result.issues.push({stage:'Amazon',code:'NOT_CONFIGURED',message:'Amazon API接続設定が必要です。'});
  const top=result.candidates.find(c=>c.match.status!=='mismatch')||null,priceAsin=input.asin||top?.asin;
  if(priceAsin&&capabilities().amazon&&settings.compare.includes('amazon')){
   for(const [condition,apiCondition] of [['new','New'],['used','Used']])try{
    const args=new URLSearchParams({MarketplaceId:MARKET,ItemCondition:apiCondition,CustomerType:'Consumer'}),data=await amazonGet('/products/pricing/v0/items/'+priceAsin+'/offers?'+args,true),price=amazonPrice(data,priceAsin,condition,at);
    if(price)result.prices.push(price);else result.issues.push({stage:'Amazon '+apiCondition,code:'NO_OFFER',message:'対象状態の価格は取得できませんでした。カタログの不存在や0円とは扱いません。'});
   }catch(e){issue('Amazon '+apiCondition,e);}
  }
  const keepaAllowed=settings.useKeepa&&Number.isSafeInteger(raw.keepaBudget)&&raw.keepaBudget>=1&&capabilities().keepa&&settings.compare.includes('amazon');
  const code=priceAsin?{asin:priceAsin}:input.jan&&(settings.discovery==='direct'&&settings.priority[0]==='amazon')?{code:input.jan}:null;
  if(keepaAllowed&&code)try{
   const url=new URL('https://api.keepa.com/product');url.search=new URLSearchParams({key:keepaKey,domain:'5',...code,stats:'90',history:'0',update:'-1','code-limit':'1'});
   result.keepaRequests=1;
   const k=await request(url),p=(k.products||[]).find(p=>p.domainId===5&&(!priceAsin||p.asin===priceAsin));
   result.keepaTokens=Number.isSafeInteger(k.tokensConsumed)?Math.max(0,k.tokensConsumed):1;
   if(p){const candidate=keepaCandidate(p,at);if(candidate&&!result.candidates.some(c=>c.asin===candidate.asin))result.candidates.push({...candidate,match:candidateMatch(input,candidate)});result.prices.push(...keepaPrices(p,at));}
   else result.issues.push({stage:'Keepa',code:'NO_DATA',message:'Keepaの保存データはありません。0円ではありません。'});
  }catch(e){issue('Keepa',e);}
  else if(settings.useKeepa&&code&&!keepaAllowed)result.issues.push({stage:'Keepa',code:'NOT_AVAILABLE',message:capabilities().keepa?'この回のKeepa要求上限に達したため省略しました。':'Keepaキーが未設定です。'});
  result.nextSites=settings.priority.filter(m=>m!=='amazon'||!result.candidates.length);
  result.status=result.candidates.length?'needs_review':result.issues.some(i=>['CONNECTION','AUTH','TIMEOUT','NOT_CONFIGURED','NOT_AVAILABLE','UNAVAILABLE','INVALID_RESPONSE','RESPONSE_LIMIT'].includes(i.code)||i.code.startsWith('HTTP_')&&i.code!=='HTTP_404')?'unavailable':result.mode==='manual'?'manual_search':'not_found';
  return result;
 }
 return {capabilities,query};
}
