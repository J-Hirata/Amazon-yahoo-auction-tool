// Search terms narrow the visible choices; only explicit selection creates a reference.
const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
const compact=value=>normalized(value).replace(/[\s\p{P}\p{S}]+/gu,'');
export function matchesProduct(product,query){
 const haystack=compact([product.title,product.asin,product.sellerSku,product.listingId].join(' '));
 return normalized(query).trim().split(/\s+/u).filter(Boolean).every(term=>haystack.includes(compact(term)));
}
const family=v=>/^(used|中古)/i.test(v||'')?'used':/^(new|新品)/i.test(v||'')?'new':v==='parts'?'parts':'unknown';
export function choiceIssue(source,target){
 if(!target.asin)return 'ASINが未登録です。商品情報にASINを入力してください';
 if(source.asin&&target.asin!==source.asin)return 'ASINが異なります。商品情報を確認してください';
 if(source.sellerSku&&target.sellerSku&&source.sellerSku!==target.sellerSku)return 'SKUが異なります。別在庫として扱います';
 if(family(source.condition)!=='unknown'&&family(target.condition)!=='unknown'&&family(source.condition)!==family(target.condition))return '新品・中古・部品扱いが異なります';
 if(source.setContents&&target.setContents&&source.setContents!==target.setContents)return 'セット内容が異なります';
 return '';
}
export function productChoices(products,source,query,selected=[]){
 return products.filter(p=>matchesProduct(p,query)).map(p=>({...p,issue:choiceIssue(source,p)})).sort((a,b)=>
  Number(selected.includes(b.id))-Number(selected.includes(a.id))||Number(Boolean(a.issue))-Number(Boolean(b.issue))||Number(b.asin===source.asin)-Number(a.asin===source.asin)||a.title.localeCompare(b.title,'ja'));
}
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
export function createProductPicker(section,{label,products,source,selected,multiple=false,onSelect}){
 const heading=el('strong',label),searchLabel=el('label','商品名・単語で探す'),search=el('input'),summary=el('small'),count=el('small'),list=el('div');
 search.type='search';search.placeholder='例：HP モニター ／ ASIN・SKUでも検索';search.setAttribute('aria-label',label+'を検索');search.autocomplete='off';searchLabel.append(search);list.className='workspace-choice-list';list.setAttribute('aria-label',label+'の候補');summary.setAttribute('role','status');section.replaceChildren(heading,searchLabel,summary,count,list);
 function draw(){
  const picked=selected(),rows=productChoices(products(),source(),search.value,picked);list.replaceChildren();
  summary.textContent=picked.length?'選択中：'+products().filter(p=>picked.includes(p.id)).map(p=>p.title+(choiceIssue(source(),p)?'（'+choiceIssue(source(),p)+'）':'')).join(' ／ '):'未選択。商品名の一部や複数の単語で、登録済み商品を探せます。';
  count.textContent=rows.length+'件表示 ／ 登録済み'+products().length+'件';
  if(!rows.length)list.append(el('p','この条件に合う登録商品はありません。別の単語でも検索できます。'));
  for(const p of rows){
   const row=el('label'),input=el('input'),img=el('img'),copy=el('span');row.className='workspace-existing-link';row.dataset.choiceId=p.id;
   input.type=multiple?'checkbox':'radio';input.name=multiple?'existingLinks':'existing-'+label;input.value=p.id;input.checked=picked.includes(p.id);input.disabled=Boolean(p.issue)&&!input.checked;
   img.src=p.imageUrl||'/catalog-image.svg';img.alt='商品参考画像';img.width=48;img.height=48;img.referrerPolicy='no-referrer';img.onerror=()=>{img.onerror=null;img.src='/catalog-image.svg';};
   copy.append(el('strong',p.title),el('small',[p.asin||'ASIN未登録',p.sellerSku||'SKU未指定',p.listingId].filter(Boolean).join(' ／ ')));
   if(p.detail)copy.append(el('small',p.detail));
   if(p.issue){row.classList.add('workspace-choice-unavailable');copy.append(el('small','選択できません：'+p.issue));}
   row.append(input,img,copy);list.append(row);input.addEventListener('change',()=>{onSelect(p,input.checked);draw();});
  }
 }
 search.addEventListener('input',draw);draw();return {draw};
}
