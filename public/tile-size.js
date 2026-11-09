export const tileSizes=['small','standard','large'];
export function tileSize(value){return tileSizes.includes(value)?value:'standard';}
export function tileColumns(width,size){
  const minimum={small:155,standard:210,large:280}[tileSize(size)];
  return Math.max(1,Math.min({small:10,standard:5,large:4}[tileSize(size)],Math.floor((width+12)/(minimum+12))));
}
// Changing size only changes presentation; it never rebuilds an entered form.
export function createTileSize({host,roots,key,value,onChange=()=>{}}){
  let current=tileSize(value);if(key)try{current=tileSize(localStorage.getItem(key));}catch{}
  const group=document.createElement('div');group.className='tile-size-controls';group.setAttribute('role','group');group.setAttribute('aria-label','タイルの大きさ');
  const caption=document.createElement('span');caption.textContent='大きさ';group.append(caption);
  const buttons=tileSizes.map(size=>{const b=document.createElement('button');b.type='button';b.dataset.tileSize=size;b.textContent={small:'小',standard:'標準',large:'大'}[size];b.addEventListener('click',()=>{current=size;apply();if(key)try{localStorage.setItem(key,size);}catch{}onChange(size);});group.append(b);return b;});
  function resize(root){root.style.setProperty('--tile-columns',tileColumns(root.clientWidth,current));}
  function apply(){for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.tileSize===current));for(const root of roots){root.dataset.tileSize=current;resize(root);}}
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(entries=>entries.forEach(({target})=>resize(target))):null;
  for(const root of roots)observer?.observe(root);host.append(group);apply();
  return {value:()=>current,resize:apply};
}
