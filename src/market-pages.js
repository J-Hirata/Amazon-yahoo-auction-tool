import {load} from 'cheerio';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const yen=v=>Number.isSafeInteger(v)&&v>0&&v<100000000?v:null;
const plain=(v,n=500)=>typeof v==='string'?v.replace(/[\x00-\x1f]/g,' ').trim().slice(0,n):'';
const conditionNames={USED10:'未使用に近い',USED20:'目立った傷や汚れなし',USED40:'やや傷や汚れあり',USED60:'傷や汚れあり',USED80:'全体的に状態が悪い',NEW:'未使用'};
export function pageTarget(raw){
 if(raw.mode==='sold'){if(!['yahoo','mercari'].includes(raw.market)||typeof raw.query!=='string'||!raw.query.trim()||raw.query.length>200)throw fail('検索ワードと販売先を選んでください。');
 return raw.market==='yahoo'?'https://auctions.yahoo.co.jp/closedsearch/closedsearch?'+new URLSearchParams({p:raw.query,n:'50'}):'https://jp.mercari.com/search?'+new URLSearchParams({keyword:raw.query,status:'sold_out'});}
 if(raw.mode!=='reference')throw fail('取得方法を選んでください。');
 let u;try{u=new URL(raw.url);}catch{throw fail('参考商品のURLを入力してください。');}
 if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash)throw fail('HTTPSの商品URLを使ってください。');
 if(['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp'].includes(u.hostname)&&/^\/jp\/auction\/[a-z][0-9]{8,12}\/?$/i.test(u.pathname))return 'https://auctions.yahoo.co.jp'+u.pathname;
 if(u.hostname==='jp.mercari.com'&&/^\/item\/m[0-9]{8,15}\/?$/.test(u.pathname))return u.origin+u.pathname;
 throw fail('ヤフオク・メルカリの商品ページを使ってください。');
}
function yahooItem(item,at,closed){
 const id=item?.auctionId,title=plain(item?.title),eventAt=Number.isFinite(Date.parse(item?.endTime))?new Date(item.endTime).toISOString():null;
 if(!/^[a-z][0-9]{8,12}$/i.test(id||'')||!title)return null;
 const bids=Number.isSafeInteger(item.bidCount)?item.bidCount:Number.isSafeInteger(item.bids)?item.bids:null;
 // Listing prices are already tax inclusive; detail pages expose taxinPrice separately.
 const price=yen(item.taxinPrice)??(item.taxRate?null:yen(item.price)),sold=closed&&eventAt&&Date.parse(eventAt)<=Date.parse(at)&&bids!==null&&bids>0;
 return {originId:id,market:'yahoo',url:'https://auctions.yahoo.co.jp/jp/auction/'+id,title,price,shipping:item.isFreeShipping===true?0:null,kind:sold?'auction_sold':closed?'closed_unverified':'asking',status:sold?'sold':closed?'unknown':'active',eventAt:closed?eventAt:null,eventPrecision:closed&&eventAt?'exact':'unknown',condition:conditionNames[item.itemCondition]||plain(item.conditionName,100)||'状態未取得',checkedAt:at,match:'candidate',accessories:'付属品の比較は要確認',category:plain(item.category?.name,100)};
}
export function parseMarketPage(html,url,at=new Date().toISOString()){
 const $=load(html),market=new URL(url).hostname.endsWith('yahoo.co.jp')?'yahoo':'mercari',mode=new URL(url).pathname.includes('closedsearch')||new URL(url).pathname==='/search'?'sold':'reference',items=[];
 if(market==='yahoo'){
  let state;try{state=JSON.parse($('#__NEXT_DATA__').text()).props.pageProps.initialState;}catch{}
  if(mode==='sold')for(const item of state?.search?.items?.listing?.items||[]){const v=yahooItem(item,at,true);if(v)items.push(v);}
  else {const item=state?.item?.detail?.item;if(item&&new URL(url).pathname.replace(/\/$/,'').endsWith('/'+item.auctionId)){const v=yahooItem(item,at,item.status==='closed');if(v)items.push(v);}}
 }else{
  // A search card is not a settled payment record. Only a product's own schema is accepted.
  for(const el of $('script[type="application/ld+json"]').toArray()){
   let value;try{value=JSON.parse($(el).text());}catch{continue;}
   for(const p of Array.isArray(value)?value:value['@graph']||[value]){
    if(p?.['@type']!=='Product'||mode!=='reference')continue;
    const o=Array.isArray(p.offers)?p.offers[0]:p.offers,price=yen(typeof o?.price==='string'?Number(o.price):o?.price),sold=/SoldOut/.test(o?.availability||''),unavailable=/OutOfStock/.test(o?.availability||'');
    if(plain(p.name))items.push({originId:new URL(url).pathname.split('/').pop(),market,url,title:plain(p.name),price,shipping:null,kind:sold?'sold_display':unavailable?'closed_unverified':'asking',status:sold?'sold':unavailable?'unknown':'active',eventAt:null,eventPrecision:'unknown',condition:'状態未取得',accessories:'付属品の比較は要確認',checkedAt:at,match:'candidate'});
   }
  }
 }
 const unique=[...new Map(items.map(i=>[i.originId,i])).values()].slice(0,50);
 return {market,mode,url,checkedAt:at,status:unique.length?'ok':'unavailable',items:unique,message:unique.length?'同一型番・状態・付属品は未照合です。比較する候補だけ選んでください。':'このページから価格情報を確認できませんでした。検索画面で確認できます。',scope:market==='yahoo'?'Yahooの公開画面で取得できた最大50件。サイトの終了180日以内。送料不明は価格に含めません。':'売却済みの表示価格。最終決済額・成約日時は未確認。'};
}
export async function readMarketPage(raw,{fetchImpl=fetch,now=()=>new Date().toISOString()}={}){
 const url=pageTarget(raw),r=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{'User-Agent':'PhotoSortingNavi/1.0 (owner requested product research)'}});
 if(!r.ok){await r.body?.cancel();throw fail('検索先のページを取得できませんでした。検索画面から確認できます。',r.status===429?429:502);}
 const chunks=[];let n=0;const reader=r.body?.getReader();if(!reader)throw fail('ページの内容を読み取れません。',502);
 try{for(;;){const v=await reader.read();if(v.done)break;n+=v.value.length;if(n>2000000){await reader.cancel();throw fail('ページが大きすぎます。検索画面で確認してください。',502);}chunks.push(v.value);}}finally{reader.releaseLock();}
 return parseMarketPage(Buffer.concat(chunks).toString('utf8'),url,now());
}
