import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {parse} from "dotenv";

const git = (args) => execFileSync("git", args, {maxBuffer: 16 * 1024 * 1024});
const names = git(["ls-files", "--cached", "-z"]).toString("utf8").split("\0").filter(Boolean);
const secrets = [];
for (const file of [".env.neon-dev", "data/cloud-private/main-admin.env", "data/cloud-private/app-runtime.env", "data/cloud-private/connections.env", "data/cloud-private/sales-cron.env", ".vercel/.env.production.local", ".vercel/.env.preview.local"]) {
  let values;
  try {values = parse(await readFile(file));} catch (error) {if (error.code === "ENOENT") continue; throw new Error("秘密設定を検査できません。内容は表示しません");}
  for (const [name, value] of Object.entries(values)) {
    if (!value || !/DATABASE_URL|OIDC_TOKEN|CLIENT_SECRET|REFRESH_TOKEN|APP_PASSWORD|CRON_SECRET/.test(name)) continue;
    secrets.push(value);
    if (/DATABASE_URL/.test(name)) {
      try {secrets.push(decodeURIComponent(new URL(value).password));} catch {throw new Error("DB秘密設定の形式を検査できません。内容は表示しません");}
    }
  }
}
try {secrets.push(JSON.parse(await readFile("data/cloud-private/owner-setup.json")).token);} catch (error) {if (error.code !== "ENOENT") throw new Error("初回設定の秘密を検査できません。内容は表示しません");}
for (const name of names) {
  if (/^(?:data|output|test-output|dist|node_modules|\.vercel)\//.test(name) || /(?:^|\/)\.env(?:\.|$)/.test(name) && name !== ".env.example" || name === "docs/gmail-test-message.json") throw new Error("Git管理対象へ業務データ・秘密設定・生成物が混入しています");
  const content = git(["show", ":" + name]);
  if (secrets.filter((value) => typeof value === "string" && value.length >= 8).some((value) => content.includes(Buffer.from(value)))) throw new Error("Git管理対象に実際の秘密値が含まれます。値は表示しません");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk_live_[A-Za-z0-9]{16,})\b/.test(content.toString())) throw new Error("Git管理対象に秘密形式の値を検出しました。値は表示しません");
}
let historyObjects=0;
if(process.argv.includes("--history-base")){
  const base=process.argv[process.argv.indexOf("--history-base")+1];
  if(!base||!/^[-A-Za-z0-9_/.]+$/.test(base)||base.startsWith("-"))throw new Error("履歴検査の比較元を指定してください");
  const entries=git(["rev-list","--objects",base+"..HEAD"]).toString("utf8").trim().split("\n").filter(Boolean);
  for(const entry of entries){const name=entry.slice(41);if(/^(?:data|output|test-output|dist|node_modules|\.vercel)\//.test(name)||/(?:^|\/)\.env(?:\.|$)/.test(name)&&name!==".env.example"||name==="docs/gmail-test-message.json")throw new Error("未公開のGit履歴に業務データ・秘密設定・生成物が含まれます。内容は表示しません");}
  const bytes=execFileSync("git",["cat-file","--batch"],{input:entries.map(e=>e.slice(0,40)).join("\n")+"\n",maxBuffer:64*1024*1024});
  let offset=0;while(offset<bytes.length){const end=bytes.indexOf(10,offset);if(end<0)throw new Error("Git履歴を読み取れません");const [,type,length]=bytes.subarray(offset,end).toString().split(" ");offset=end+1;const size=Number(length);if(!Number.isSafeInteger(size)||size<0)throw new Error("Git履歴の形式を確認してください");const content=bytes.subarray(offset,offset+size);offset+=size+1;if(type!=="blob")continue;historyObjects++;
    if(secrets.filter(v=>typeof v==="string"&&v.length>=8).some(v=>content.includes(Buffer.from(v)))||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk_live_[A-Za-z0-9]{16,})\b/.test(content.toString()))throw new Error("未公開Git履歴に秘密値を検出しました。値は表示しません");
  }
}
console.log(JSON.stringify({indexedFiles: names.length,historyObjects, privateValueLeaks: 0, excludedFiles: 0, remoteChanged: false}));
