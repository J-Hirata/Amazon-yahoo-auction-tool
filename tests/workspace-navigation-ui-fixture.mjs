// Navigation/layout only. No authentication, business records, DB or outbound API.
import http from 'node:http';
import {build} from 'esbuild';
import {loadCloudAssets} from '../src/cloud-runtime.js';

const assets=await loadCloudAssets();
const nav=await build({stdin:{contents:"export{workspaceNavigation}from'./public/workspace-navigation.js';export{cockpitHeader}from'./public/cockpit-brand.js';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',logLevel:'silent'});
assets.set('/__fixture/nav.js',{type:'text/javascript',body:nav.outputFiles[0].contents});
const pages={links:['cloud-view.html','商品紐付けツール'],drafts:['cloud-drafts-view.html','ヤフオク出品下書きツール'],stock:['cloud-stock-view.html','コンテナ・自社在庫'],planning:['cloud-planning-view.html','販売の監視・見直し'],overview:['cloud-overview-view.html','全商品一覧']};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture.invalid');
 if(req.method!=='GET'||url.pathname.startsWith('/api/')){res.writeHead(403);res.end('Fixture: no business operations');return;}
 if(url.pathname==='/'){
  const mode=url.searchParams.get('view')||'links',entry=pages[mode];
  if(mode==='login'){const html=assets.get('/cloud-login.html').body.toString().replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace('id="loginPanel" class="login-shell" hidden','id="loginPanel" class="login-shell"').replace('id="authLoading"','hidden id="authLoading"');res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  if(!entry){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${entry[1]} | 販売コックピット（隔離）</title>${['styles','link-monitor','cloud-login','physical-stock','product-access','sales-planning','product-overview','catalog-view'].map(n=>`<link rel="stylesheet" href="/${n}.css">`).join('')}<div id="cloudApp">${assets.get('/'+entry[0]).body}</div><script type="module">import{workspaceNavigation,cockpitHeader}from'/__fixture/nav.js';const mode=document.createElement('span'),logout=document.createElement('button');mode.textContent='隔離デモ・保存なし';logout.textContent='ログアウト';logout.disabled=true;document.querySelector('#cloudApp').prepend(cockpitHeader({navigation:workspaceNavigation({drafts:${mode==='drafts'},stock:${mode==='stock'},planning:${mode==='planning'},overview:${mode==='overview'},physicalStock:true,salesPlanning:true,productOverview:true}),mode,logout}));document.querySelector('main').classList.add('cockpit-content');document.querySelectorAll('main button,main input,main select,main textarea').forEach(e=>e.disabled=true);document.addEventListener('submit',e=>e.preventDefault());</script></html>`);
  return;
 }
 const asset=assets.get(url.pathname);
 if(!asset){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':asset.type});res.end(asset.body);
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,readOnly:true,businessData:false})));
