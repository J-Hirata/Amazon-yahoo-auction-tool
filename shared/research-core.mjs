// Pure research rules shared by both applications. No credentials or network access.
export const MARKETS=['amazon','yahoo','mercari','aucfan'];
export const MARKET_LABELS={amazon:'Amazon',yahoo:'ヤフオク',mercari:'メルカリ',aucfan:'オークファン'};
const fail=m=>{throw Object.assign(new Error(m),{status:400});};
export const clean=(v,max=200)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)?v.trim():fail('入力の長さ・文字を確認してください。');
export const normalized=v=>String(v||'').normalize('NFKC').toUpperCase().replace(/[\s‐‑–—ー-]/g,'');
export function janValue(v){const s=String(v||'').normalize('NFKC').replace(/[\s-]/g,'');return s;}
export function validJan(v){return /^(?:\d{8}|\d{13})$/.test(v)&&[...v].reverse().reduce((n,c,i)=>n+Number(c)*(i%2?3:1),0)%10===0;}
export function inputValues(raw={}){
 const r={};for(const [key,max] of Object.entries({name:200,manufacturer:120,model:120,jan:40,asin:10,spec:500,accessories:1000,condition:2000,operation:40}))r[key]=clean(raw[key]??'',max);
 r.jan=janValue(r.jan);r.asin=r.asin.toUpperCase();
 if(r.jan&&!validJan(r.jan))fail('JANは8桁または13桁と検査数字を確認してください。不確かな桁は型番・メモで確認できます。');
 if(r.asin&&!/^[A-Z0-9]{10}$/.test(r.asin))fail('ASINは英数字10文字です。');
 if(!['','unknown','tested','untested','faulty'].includes(r.operation))fail('動作確認を選んでください。');
 r.operation ||= 'unknown';r.identifiersConfirmed=raw.identifiersConfirmed===true;
 return r;
}
const list=(v,max=4)=>{if(!Array.isArray(v)||!v.length||v.length>max||v.some(x=>!MARKETS.includes(x))||new Set(v).size!==v.length)fail('検索先・比較先を選んでください。');return [...v];};
export function settingsValues(raw={}){
 const discovery=raw.discovery??'direct';if(!['direct','google','lens'].includes(discovery))fail('検索方法を選んでください。');
 const priority=list(raw.priority??['amazon','yahoo','mercari','aucfan']),compare=list(raw.compare??['amazon','yahoo','mercari','aucfan']);
 const days=raw.days??90,minimum=raw.minimum??5,limit=raw.limit??50,keepaLimit=raw.keepaLimit??50;
 if(![30,90,180,365].includes(days)||!Number.isSafeInteger(minimum)||minimum<3||minimum>30||!Number.isSafeInteger(limit)||limit<5||limit>100||!Number.isSafeInteger(keepaLimit)||keepaLimit<0||keepaLimit>100)fail('期間・最低件数・取得件数・Keepa上限を確認してください。');
 const shipping=raw.shipping??'item';if(!['item','total'].includes(shipping))fail('送料の比較方法を選んでください。');
 let grades=null;if(raw.grades){grades={};for(const g of ['A','B','C']){grades[g]=clean(raw.grades[g],140);if(!grades[g])fail('A・B・Cの定義をすべて入力してください。');}}
 return {discovery,priority,compare,days,minimum,limit,keepaLimit,useKeepa:raw.useKeepa!==false,shipping,grades};
}
export function searchLinks(input,settings){
 const q=[input.manufacturer,input.model||input.jan||input.name].filter(Boolean).join(' ').trim(),e=encodeURIComponent;
 const links={amazon:'https://www.amazon.co.jp/s?k='+e(input.jan||q),yahoo:'https://auctions.yahoo.co.jp/search/search?p='+e(q),
 mercari:'https://jp.mercari.com/search?keyword='+e(q),aucfan:'https://aucfan.com/search1/q-'+e(q)+'/s-mix/'};
 return {query:q,first:settings.discovery==='lens'?'https://lens.google/':settings.discovery==='google'?'https://www.google.com/search?q='+e(q+' site:'+({amazon:'amazon.co.jp',yahoo:'auctions.yahoo.co.jp',mercari:'jp.mercari.com',aucfan:'aucfan.com'}[settings.priority[0]])):links[settings.priority[0]],
 steps:settings.priority.map((market,index)=>({market,order:index+1,url:links[market],googleUrl:'https://www.google.com/search?q='+e(q+' site:'+({amazon:'amazon.co.jp',yahoo:'auctions.yahoo.co.jp',mercari:'jp.mercari.com',aucfan:'aucfan.com'}[market]))})),
 sold:{yahoo:'https://auctions.yahoo.co.jp/closedsearch/closedsearch?p='+e(q),mercari:links.mercari+'&status=sold_out',aucfan:links.aucfan},lens:'https://lens.google/'};
}
export function candidateMatch(input,c){
 const reasons=[],checks=[],same=(key,expected,values)=>{
  if(!expected)return null;const vals=values.filter(Boolean),ok=vals.some(v=>normalized(v)===normalized(expected));checks.push({field:key,input:expected,candidate:vals.join(' / ')||'未取得',status:ok?'match':vals.length?'difference':'unknown'});return vals.length?ok:null;
 };
 const jan=same('JAN',input.jan,c.jans||[]),model=same('型番',input.model,c.models||[]),brand=same('メーカー',input.manufacturer,[c.manufacturer,c.brand]);
 const asin=same('ASIN',input.asin,[c.asin]);
 const mismatch=asin===false||model===false||jan===false;
 if(mismatch)reasons.push('型番・JAN・ASINに相違があります。');
 if(brand===false)reasons.push('メーカー表記が異なります。別名表記も含め確認してください。');
 if(input.spec)checks.push({field:'仕様',input:input.spec,candidate:[c.color,c.size,c.spec].filter(Boolean).join(' / ')||'未取得',status:'review'});
 if(!checks.length)reasons.push('商品名からの候補です。型番・仕様を確認してください。');
 if(!mismatch&&(jan===true||asin===true||model===true&&brand===true))reasons.push('識別情報は一致。色・仕様・構成と現物の状態は別途確認してください。');
 if(!input.identifiersConfirmed)reasons.push('検索に使った識別情報は本人未確認です。');
 reasons.push('付属品・動作・傷は自分の写真と確認結果を使います。');
 return {status:mismatch?'mismatch':jan===true||asin===true||model===true&&brand===true?'match':'candidate',checks,reasons};
}
export function marketUrl(raw){
 const s=clean(raw,2048);let u;try{u=new URL(s);}catch{fail('根拠ページのURLを入力してください。');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['amazon.co.jp','www.amazon.co.jp','auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','closedsearch.auctions.yahoo.co.jp','jp.mercari.com','aucfan.com','www.aucfan.com'].includes(u.hostname))fail('Amazon・ヤフオク・メルカリ・オークファンのHTTPS商品URLを使ってください。');
 for(const k of [...u.searchParams.keys()])if(/token|secret|key|signature|auth/i.test(k))fail('認証情報を含むURLは保存できません。');
 return u.href;
}
export function sampleValues(raw,settings,now=new Date().toISOString()){
 const source=raw.source,market=raw.market;if(!['yahoo','mercari','aucfan'].includes(source)||!['yahoo','mercari'].includes(market)||source==='yahoo'&&market!=='yahoo'||source==='mercari'&&market!=='mercari')fail('取得元と元の販路を確認してください。');
 const url=marketUrl(raw.url),host=new URL(url).hostname;
 if(source==='yahoo'&&!host.endsWith('.yahoo.co.jp')||source==='mercari'&&host!=='jp.mercari.com'||source==='aucfan'&&!['aucfan.com','www.aucfan.com'].includes(host))fail('取得元と根拠URLが一致しません。');
 const originId=clean(raw.originId??'',80),parsed=market==='yahoo'?new URL(url).pathname.match(/\/(?:jp\/)?auction\/([a-z0-9]+)/i)?.[1]:new URL(url).pathname.match(/\/item\/(m\d+)/)?.[1];
 if(originId&&!/^[a-z0-9_-]+$/i.test(originId)||originId&&parsed&&originId!==parsed)fail('元の取引IDとURLを確認してください。');
 const price=raw.price,shipping=raw.shipping;
 if(!Number.isSafeInteger(price)||price<=0||price>100000000||shipping!==null&&(!Number.isSafeInteger(shipping)||shipping<0||shipping>10000000))fail('価格は正の整数、送料は不明なら空欄にしてください。');
 const kind=market==='mercari'?'sold_display':'sold_price';
 const grade=raw.grade??'unknown';if(!['A','B','C','N','J','unknown'].includes(grade))fail('状態を選んでください。');
 if(['A','B','C'].includes(grade)&&!settings.grades)fail('先にA・B・Cの定義を保存してください。');
 let eventAt=null;if(raw.eventAt){const s=clean(raw.eventAt,40);if(!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d))?$/.test(s))fail('成約日・終了日の形式を確認してください。');const day=s.slice(0,10),check=new Date(day+'T00:00:00Z');if(!Number.isFinite(+check)||check.toISOString().slice(0,10)!==day)fail('成約日・終了日を確認してください。');const date=new Date(s.length===10?s+'T00:00:00+09:00':s);if(!Number.isFinite(+date)||+date>+new Date(now)+86400000)fail('成約日・終了日を確認してください。');eventAt=date.toISOString();}
 const status=raw.status??'sold';if(!['sold','asking','unknown','no_sale'].includes(status))fail('成約・販売中を選んでください。');
 return {source,market,url,originId:originId||parsed||'',title:clean(raw.title??'',300),price,shipping,currency:'JPY',kind:status==='asking'?'asking':kind,status,grade,gradeDefinition:settings.grades?JSON.stringify(settings.grades):'',condition:clean(raw.condition??'',1000),accessories:clean(raw.accessories??'',1000),eventAt,eventPrecision:raw.eventAt?.length===10?'day':'instant',confirmed:raw.confirmed===true,comparable:raw.comparable===true,note:clean(raw.note??'',1000)};
}
export function aggregateSamples(samples,settings,at=new Date().toISOString()){
 const threshold=+new Date(at)-settings.days*86400000,gradeKey=settings.grades?JSON.stringify(settings.grades):'',eligible=[],excluded=[];
 for(const s of samples){
  const reasons=[];
  if(s.status!=='sold'||!['sold_price','sold_display'].includes(s.kind))reasons.push('成約・売却済みの記録ではありません');
  if(!s.confirmed||!s.comparable)reasons.push('同じ商品・構成の本人確認待ち');
  if(!s.eventAt)reasons.push('成約・終了日が不明');else if(+new Date(s.eventAt)<threshold||+new Date(s.eventAt)>+new Date(at)+86400000)reasons.push('対象期間外');
  if(!['A','B','C'].includes(s.grade))reasons.push('新品・ジャンク・状態未判定');
  if(!gradeKey||s.gradeDefinition!==gradeKey)reasons.push('状態定義の確認待ち');
  if(settings.shipping==='total'&&s.shipping===null)reasons.push('送料不明');
  if(reasons.length)excluded.push({id:s.id,reasons});else eligible.push({...s,value:s.price+(settings.shipping==='total'?s.shipping:0)});
 }
 const summarize=rows=>{
  const byKey=new Map(),unknown=[],conflicts=[];
  for(const s of rows){const k=s.originId?s.market+':'+s.originId:null;if(!k){unknown.push(s);continue;}const old=byKey.get(k);if(old&&(old.value!==s.value||old.grade!==s.grade||old.eventAt!==s.eventAt)){conflicts.push(k);continue;}if(!old)byKey.set(k,s);}
  const good=[...byKey.entries()].filter(([k])=>!conflicts.includes(k)).map(([,v])=>v).concat(unknown);
  return {grades:Object.fromEntries(['A','B','C'].map(g=>{const a=good.filter(s=>s.grade===g).sort((a,b)=>a.value-b.value);return[g,{count:a.length,median:a.length>=settings.minimum?(a.length%2?a[(a.length-1)/2].value:(a[a.length/2-1].value+a[a.length/2].value)/2):null,sampleIds:a.map(s=>s.id)}];})),duplicateCount:rows.length-good.length,conflicts,unknownOriginCount:unknown.length};
 };
 const groups=Object.fromEntries(['yahoo','mercari','aucfan'].map(source=>[source,summarize(eligible.filter(s=>s.source===source))]));
 const yahoo=eligible.filter(s=>s.market==='yahoo'),combinedYahoo=yahoo.some(s=>!s.originId)?null:summarize(yahoo);
 return {groups,combinedYahoo,combinedReason:combinedYahoo?null:'元の取引IDが不明な記録があるためYahooとオークファンは合算しません。',excluded,eligible:eligible.length,windowStart:new Date(threshold).toISOString(),checkedAt:at,days:settings.days,minimum:settings.minimum,shipping:settings.shipping,gradesConfigured:!!settings.grades};
}
export function parseTable(text){
 if(typeof text!=='string'||text.length>150000)fail('一括入力は150KB以内です。');
 text=text.replace(/^\uFEFF/,'');const delimiter=text.split(/\r?\n/,1)[0].includes('\t')?'\t':',',rows=[];let row=[],field='',quote=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"'){field+='"';i++;}else if(quote||field==='')quote=!quote;else fail('CSVの引用符を確認してください。');}else if(c===delimiter&&!quote){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}else field+=c;}
 if(quote)fail('CSVの引用符が閉じていません。');row.push(field);if(row.some(v=>v.trim()))rows.push(row);
 if(rows.length<2||rows.length>101)fail('見出しと1〜100行を入力してください。');
 const headers=rows.shift().map(v=>v.trim());if(new Set(headers).size!==headers.length||headers.some(h=>!h))fail('見出しの重複・空欄があります。');
 return rows.map((r,i)=>{if(r.length!==headers.length)fail((i+2)+'行目の列数を確認してください。');return Object.fromEntries(headers.map((h,j)=>[h,r[j]]));});
}

export function decisionValues(raw={}){
 const asin=clean(raw.candidateAsin??'',10).toUpperCase();
 if(asin&&!/^[A-Z0-9]{10}$/.test(asin))fail('採用するASINを確認してください。');
 const channel=raw.channel??'';if(!['','yahoo','amazon_fba','amazon_fbm','mercari','hold'].includes(channel))fail('販路を選んでください。');
 const price=raw.price??null;if(price!==null&&(!Number.isSafeInteger(price)||price<=0||price>100000000))fail('下書き価格は正の整数です。');
 if(!Array.isArray(raw.references??[])||(raw.references??[]).length>3)fail('参考出品は最大3件です。');
 const references=(raw.references??[]).map(v=>{if(!['same','similar'].includes(v.relation))fail('同一商品・類似商品を選んでください。');return {url:marketUrl(v.url),relation:v.relation,difference:clean(v.difference??'',500)};});
 if(new Set(references.map(r=>r.url)).size!==references.length)fail('参考URLが重複しています。');
 return {candidateAsin:asin,candidateConfirmed:raw.candidateConfirmed===true,channel,price,references,note:clean(raw.note??'',2000)};
}

export function ownDescription(input){return [input.manufacturer&&'メーカー：'+input.manufacturer,input.model&&'型番：'+input.model,input.spec&&'仕様：'+input.spec,'','【現物の状態】',input.condition||'状態の詳細は本人確認待ちです。',input.operation==='tested'?'動作確認：本人が確認済み':input.operation==='faulty'?'動作：不具合あり':input.operation==='untested'?'動作確認：未実施':'動作確認：本人確認待ち','', '【付属品】',input.accessories||'付属品は写真と本人確認に基づき追記してください。'].filter((v,i,a)=>v!==''||a[i-1]!=='').join('\n');}
