import {createElement,Link2,Warehouse,CalendarClock,LayoutGrid,PackagePlus} from 'lucide';
const element=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const icon=shape=>createElement(shape,{width:15,height:15,'aria-hidden':'true','stroke-width':1.8});
const itemHref=(view,key)=>`/${view?'?view='+view:''}#item=${encodeURIComponent(key)}`;
let frame,focused;
export function focusWorkspaceProduct(){
  cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
    const key=new URLSearchParams(location.hash.slice(1)).get('item');if(!key||focused===key)return;
    const host=[...document.querySelectorAll('[data-workspace-keys]')].find(n=>{try{return JSON.parse(n.dataset.workspaceKeys).includes(key)&&n.getClientRects().length;}catch{return false;}});
    if(!host)return;for(const previous of document.querySelectorAll('.workspace-selected'))previous.classList.remove('workspace-selected');const row=host.closest('.catalog-item,.overview-card,tr')||host;row.classList.add('workspace-selected');row.tabIndex=-1;row.focus({preventScroll:true});row.scrollIntoView({block:'center'});focused=key;
  });
}
window.addEventListener('hashchange',()=>{focused=null;focusWorkspaceProduct();});
export function mountProductWorkspace(host,p){
  const w=p.live?.workspace,key=p.key;if(!w)return;
  host.dataset.workspaceKeys=JSON.stringify([...new Set([key,...w.sourceKeys])]);
  const nav=element('nav',undefined,'product-workspace-nav');nav.setAttribute('aria-label','この商品の関連ページ');
  const current=new URLSearchParams(location.search).get('view')||'links';
  const add=(view,label,shape,href)=>{const a=element('a');a.href=href;a.title=label;if(view==='planning'){a.target='_blank';a.rel='noopener noreferrer';a.title+='（別タブで開く）';}a.append(icon(shape),element('span',label));if(current===view)a.setAttribute('aria-current','page');nav.append(a);};
  const firstLink=w.links[0],firstStock=w.stocks[0],plans=w.plans.filter(p=>p.status!=='closed'),source=/^(link|stock):/.test(key)?key:w.sourceKeys.find(k=>/^(stock|link):/.test(k));
  if(firstLink)add('links',w.links.length>1?`紐付け ${w.links.length}件`:'紐付け',Link2,itemHref('',`link:${firstLink.id}`));
  else if(firstStock)add('links',w.linkCandidates?.length?'出品をつなぐ':'紐付けを登録',Link2,w.linkCandidates?.length?`/?view=stock#connect=${firstStock.id}&link=${w.linkCandidates[0].id}`:`/#stock=${firstStock.id}`);
  if(firstStock)add('stock','実在庫',Warehouse,itemHref('stock',`stock:${firstStock.id}`));
  else if(source){
    const candidates=w.stockCandidates.filter(s=>!s.mismatch);
    if(candidates.length===1&&firstLink)add('stock','実在庫をつなぐ',Warehouse,`/?view=stock#connect=${candidates[0].id}&link=${firstLink.id}`);
    else add('stock',candidates.length?'実在庫候補を確認':'実在庫を登録',Warehouse,candidates.length?`/?view=stock#asin=${encodeURIComponent(p.asin)}`:`/?view=stock#new=${encodeURIComponent(source)}`);
  }
  if(plans.length)add('planning','販売見直し',CalendarClock,`/?view=planning#id=${plans[0].id}`);
  else if(source)add('planning','販売見直しへ',CalendarClock,`/?view=planning#plan=${encodeURIComponent(source)}`);
  add('overview','全商品',LayoutGrid,itemHref('overview',key));host.append(nav);
  const status=element('div',undefined,'product-workspace-status');
  if(plans.length)status.append(element('span',plans.some(p=>p.stage==='due')?'販売見直しの時期':'販売見直し登録済み','workspace-plan-status'));
  if(!w.stocks.length&&w.stockCandidates.length)status.append(element('span',`同ASINの実在庫候補 ${w.stockCandidates.length}件・未関連`,'workspace-candidate-status'));
  const r=w.replenishment;
  if(r?.due)status.append(element('strong','補充元あり・FBAへ追加納品を検討','workspace-replenishment'));
  else if(r?.enabled&&r.baseline>0&&r.percent>0)status.append(element('span',`補充基準 ${r.baseline}個の${r.percent}%以下`,'workspace-replenishment-setting'));
  else if(w.stocks.length)status.append(element('span',r?.eligible===false?'自社発送用（FBA不可）':'コンテナ・会社の実在庫あり','workspace-reserve-status'));
  if(status.children.length)host.append(status);
  const settings=element('a',undefined,'product-replenishment-link');settings.href=`/?view=overview#settings=${encodeURIComponent(key)}`;settings.title='FBAの補充条件を設定';settings.append(icon(PackagePlus),element('span','補充条件'));host.append(settings);
  focusWorkspaceProduct();
}
