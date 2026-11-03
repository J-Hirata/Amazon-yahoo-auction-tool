import {createElement,Link2,Warehouse,CalendarClock,LayoutGrid,PackagePlus,Ellipsis} from 'lucide';
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
export function mountProductWorkspace(host,p,{actions=true,onReview,readOnly=false}={}){
  const w=p.live?.workspace,key=p.key;if(!w)return;
  host.dataset.workspaceKeys=JSON.stringify([...new Set([key,...w.sourceKeys])]);
  const nav=element('nav',undefined,'product-workspace-nav');nav.setAttribute('aria-label','この商品の関連ページ');
  const current=new URLSearchParams(location.search).get('view')||'links';
  const tags=element('nav',undefined,'product-membership');tags.setAttribute('aria-label','登録済みのページ');let primary;
  const add=(view,label,shape,href)=>{const a=element('a');a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.title=label+'（別タブで開く）';a.append(icon(shape),element('span',label));if(current===view)a.setAttribute('aria-current','page');nav.append(a);return a;};
  const membership=(link,label,kind)=>{const tag=link.cloneNode(true);tag.className='product-membership-tag membership-'+kind;tag.querySelector('span').textContent=label;tag.title=label+'：登録済み'+(kind==='planning'?'（別タブで開く）':'');tags.append(tag);};
  const action=link=>{primary??=link;return link;};
  const firstLink=w.links[0],firstStock=w.stocks[0],plans=w.plans.filter(p=>p.status!=='closed'),source=/^(link|stock):/.test(key)?key:w.sourceKeys.find(k=>/^(stock|link):/.test(k));
  if(firstLink)membership(add('links',w.links.length>1?`紐付け ${w.links.length}件`:'紐付け',Link2,itemHref('',`link:${firstLink.id}`)),'商品紐付け'+(w.links.length>1?' '+w.links.length+'件':''),'links');
  else if(firstStock)action(add('links',w.linkCandidates?.length?'出品をつなぐ':'紐付けを登録',Link2,`/#stock=${firstStock.id}&edit=1`));
  if(firstStock)membership(add('stock','実在庫',Warehouse,itemHref('stock',`stock:${firstStock.id}`)),'コンテナ・自社在庫','stock');
  else if(source){
    const candidates=w.stockCandidates.filter(s=>!s.mismatch);
    if(candidates.length===1&&firstLink)action(add('stock','実在庫をつなぐ',Warehouse,`/?view=stock#connect=${candidates[0].id}&link=${firstLink.id}`));
    else action(add('stock',candidates.length?'実在庫候補を確認':'実在庫を登録',Warehouse,candidates.length?`/?view=stock#asin=${encodeURIComponent(p.asin)}`:`/?view=stock#new=${encodeURIComponent(source)}`));
  }
  if(plans.length)membership(add('planning','販売見直し',CalendarClock,`/?view=planning#id=${plans[0].id}`),'販売見直し','planning');
  else if(w.plans.length){membership(add('planning','販売見直し（完了）',CalendarClock,`/?view=planning#id=${w.plans[0].id}`),'販売見直し（完了）','planning');if(source)action(add('planning','販売見直しへ',CalendarClock,`/?view=planning#plan=${encodeURIComponent(source)}`));}
  else if(source)action(add('planning','販売見直しへ',CalendarClock,`/?view=planning#plan=${encodeURIComponent(source)}`));
  if(tags.children.length)host.prepend(tags);
  if(!actions){focusWorkspaceProduct();return;}
  add('overview','全商品',LayoutGrid,itemHref('overview',key));
  const controls=element('div',undefined,'product-workspace-actions'),more=element('details',undefined,'product-workspace-more'),toggle=element('summary');toggle.title='その他の登録・確認';toggle.setAttribute('aria-label','その他の登録・確認');toggle.append(icon(Ellipsis));more.append(toggle,nav);if(primary&&!(onReview&&!plans.length&&primary.href.includes('view=planning'))){const shortcut=primary.cloneNode(true);shortcut.className='product-workspace-primary';controls.append(shortcut);}if(onReview&&source&&!plans.length){const quick=element('button',undefined,'product-review-quick');quick.type='button';quick.disabled=readOnly;quick.append(icon(CalendarClock),element('span','見直しに追加'));quick.title='この画面で販売見直しに追加';quick.addEventListener('click',()=>onReview(source));controls.append(quick);}controls.append(more);host.append(controls);
  const status=element('div',undefined,'product-workspace-status');
  if(plans.length)status.append(element('span',plans.some(p=>p.stage==='due')?'販売見直しの時期':'販売見直し登録済み','workspace-plan-status'));
  if(!w.stocks.length&&w.stockCandidates.length)status.append(element('span',`同ASINの実在庫候補 ${w.stockCandidates.length}件・未関連`,'workspace-candidate-status'));
  const r=w.replenishment;
  if(r?.due)status.append(element('strong','補充元あり・FBAへ追加納品を検討','workspace-replenishment'));
  else if(r?.enabled&&r.baseline>0&&r.percent>0)status.append(element('span',`補充基準 ${r.baseline}個の${r.percent}%以下`,'workspace-replenishment-setting'));
  else if(w.stocks.length)status.append(element('span',r?.eligible===false?'自社発送用（FBA不可）':'コンテナ・会社の実在庫あり','workspace-reserve-status'));
  if(status.children.length)more.append(status);
  if(r?.due)host.append(element('strong','FBAへ追加納品を検討','workspace-replenishment workspace-alert'));
  const settings=element('a',undefined,'product-replenishment-link');settings.href=`/?view=overview#settings=${encodeURIComponent(key)}`;settings.target='_blank';settings.rel='noopener noreferrer';settings.title='FBAの補充条件を設定（別タブ）';settings.append(icon(PackagePlus),element('span','補充条件'));more.append(settings);
  focusWorkspaceProduct();
}
