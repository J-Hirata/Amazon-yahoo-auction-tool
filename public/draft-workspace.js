export const DRAFTS_HOME='/?view=drafts';
export const SHARED_PHOTOS_HOME='/?view=drafts&section=photos';
const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
export function mountDraftWorkspace(main,{photos=false,photoLibrary=false}={}){
 const header=el('header');header.className='draft-workspace-heading';header.append(el('h1','ヤフオク出品下書きツール'),el('p','写真や商品情報をまとめて、出品の下書きを準備します。'));
 const nav=el('nav');nav.className='draft-workspace-nav';nav.setAttribute('aria-label','出品下書きツールのメニュー');
 for(const [label,href,active]of [['出品下書き',DRAFTS_HOME,!photos],...(photoLibrary?[['写真仕分けナビ共有写真',SHARED_PHOTOS_HOME,photos]]:[])]){
  const a=el('a',label);a.href=href;if(active)a.setAttribute('aria-current','page');nav.append(a);
 }
 const old=main.querySelector('h1');if(old){const h=el('h2',photos?'写真仕分けナビ共有写真':'ASINからの下書き');old.replaceWith(h);}
 main.prepend(header,nav);
}
