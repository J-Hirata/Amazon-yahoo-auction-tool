export const COCKPIT_BRAND=Object.freeze({
  title:'販売コックピット',
  summary:'出品・在庫・売れ行きをまとめて管理する、販売の司令室。',
  description:'Amazonとヤフオクの併売、出品下書きの作成、FBA・自社・コンテナの在庫確認をひとつにまとめた販売管理ツールです。商品の売れ行きや在庫数を把握し、販売方法の見直しや広告の検討を支援します。',
});

export function cockpitHeader({navigation,mode,logout,home='/'}){
  const header=document.createElement('header'),top=document.createElement('div'),identity=document.createElement('div'),brand=document.createElement('a'),mark=document.createElement('img'),name=document.createElement('span'),summary=document.createElement('p'),controls=document.createElement('div'),photos=document.createElement('a');
  header.className='cloud-account cockpit-header';
  top.className='cockpit-topbar';identity.className='cockpit-identity';
  brand.className='cockpit-brand';brand.href=home;brand.setAttribute('aria-label',COCKPIT_BRAND.title+' ホーム');
  Object.assign(mark,{src:'/cockpit-mark.svg',alt:'',width:36,height:36});
  name.textContent=COCKPIT_BRAND.title;brand.append(mark,name);
  summary.className='cockpit-summary';summary.textContent=COCKPIT_BRAND.summary;
  identity.append(brand,summary);controls.className='workspace-account-controls';photos.href='https://photo-sorting-research.vercel.app/';photos.target='_blank';photos.rel='noopener noreferrer';photos.className='cockpit-photo-link';photos.textContent='写真仕分けナビ ↗';controls.append(photos,mode,logout);
  top.append(identity,controls);header.append(top,navigation);
  return header;
}
