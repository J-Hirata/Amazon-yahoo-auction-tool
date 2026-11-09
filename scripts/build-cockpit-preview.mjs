// Offline UI preview. Uses the shared header; never connects to business APIs.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.join(root,'output','sales-cockpit-preview-20261110');
await mkdir(destination,{recursive:true});
for(const name of ['cockpit-mark.svg','extension-logo.png','workspace-drafts.png','workspace-stock.png','workspace-planning.png','workspace-overview.png']){
  await copyFile(path.join(root,'public',name),path.join(destination,name));
}
const css=await Promise.all(['styles.css','cloud-login.css'].map(name=>readFile(path.join(root,'public',name),'utf8')));
const source=`
import {workspaceNavigation} from './public/workspace-navigation.js';
import {cockpitHeader,COCKPIT_BRAND} from './public/cockpit-brand.js';
const pages={links:['商品紐付けツール','Amazonとヤフオクの商品ページを紐付け、併売の状態を確認します。'],drafts:['ヤフオク出品下書きツール','ヤフオクへ出品する商品の下書きを準備します。'],stock:['コンテナ・自社在庫','保管場所ごとの数量を確認し、実際の在庫を登録します。'],planning:['販売の監視・見直し','商品の売れ行きを観察し、次の方針・開始日・締切を確認します。'],overview:['全商品一覧','販路と保管場所を横断して、いま確認する商品を見つけます。']};
let selected=new URLSearchParams(location.search).get('view')||'overview';
if(!pages[selected]) selected='overview';
const mode=document.createElement('span'),logout=document.createElement('button');
mode.textContent='デザイン見本・保存なし';logout.textContent='ログアウト';logout.disabled=true;
const navigation=workspaceNavigation({drafts:selected==='drafts',stock:selected==='stock',planning:selected==='planning',overview:selected==='overview',physicalStock:true,salesPlanning:true,productOverview:true});
for(const link of navigation.querySelectorAll('a')){
 const view=new URL(link.href).searchParams.get('view')||'links';link.href='?view='+view;
}
const header=cockpitHeader({navigation,mode,logout,home:'?view=overview'});
for(const image of header.querySelectorAll('img')) image.src=image.getAttribute('src').replace(/^\\//,'./');
const main=document.createElement('main');main.className='cockpit-content preview-content';
const eyebrow=document.createElement('p');eyebrow.className='preview-eyebrow';eyebrow.textContent='出品・在庫・次のアクション';
const title=document.createElement('h1');title.textContent=pages[selected][0];
const intro=document.createElement('p');intro.className='preview-intro';intro.textContent=pages[selected][1];
const panel=document.createElement('section');panel.className='preview-panel';
const heading=document.createElement('h2');heading.textContent='デザイン確認用プレビュー';
const description=document.createElement('p');description.textContent=COCKPIT_BRAND.description;
const note=document.createElement('p');note.className='preview-note';note.textContent='上の5つのメニューで配置と選択表示を確認できます。商品データ・保存・メール送信は含みません。';
const login=document.createElement('a');login.href='./login.html';login.textContent='ログイン画面の見本を開く →';
panel.append(heading,description,note,login);main.append(eyebrow,title,intro,panel);
document.querySelector('#cloudApp').append(header,main);
document.title=pages[selected][0]+' | '+COCKPIT_BRAND.title+'（見本）';
`;
const bundle=await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,format:'iife',platform:'browser',logLevel:'silent'});
const extra=`.preview-eyebrow{font-size:12px;color:#5a687c;margin:0 0 4px}.preview-content h1{margin:0}.preview-intro{font-size:15px;color:#5a687c;line-height:1.8;margin:10px 0 24px}.preview-panel{background:#fff;border:1px solid #d8dee8;border-radius:12px;padding:24px;max-width:880px}.preview-panel h2{font-size:18px;margin:0 0 14px}.preview-panel p{font-size:14px;line-height:1.9;color:#34455d}.preview-panel .preview-note{font-size:13px;color:#5a687c;margin:20px 0}.preview-panel a,.preview-return{color:#2458a6;font-size:14px;text-underline-offset:4px}.preview-return{display:block;text-align:center;margin:24px auto}`;
await writeFile(path.join(destination,'preview.css'),css.join('\n')+'\n'+extra);
await writeFile(path.join(destination,'index.html'),`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>販売コックピット（見本）</title><link rel="stylesheet" href="./preview.css"></head><body><div id="cloudApp"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
let login=await readFile(path.join(root,'public','cloud-login.html'),'utf8');
login=login.replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link[^>]*rel="stylesheet"[^>]*>/g,'').replace('</head>','<link rel="stylesheet" href="./preview.css"></head>').replace('src="/cockpit-mark.svg"','src="./cockpit-mark.svg"').replace('id="authLoading"','hidden id="authLoading"').replace('id="loginPanel" class="login-shell" hidden','id="loginPanel" class="login-shell"').replace(/<input /g,'<input disabled ').replace('認証を確認しています。','表示見本です。ログイン処理は行いません。').replace('</body>','<a class="preview-return" href="./index.html">メニューの見本へ戻る →</a></body>');
await writeFile(path.join(destination,'login.html'),login);
console.log('Offline preview: '+path.join(destination,'index.html'));
