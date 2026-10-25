import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {parse} from "dotenv";

const git = (args) => execFileSync("git", args, {maxBuffer: 16 * 1024 * 1024});
const names = git(["ls-files", "--cached", "-z"]).toString("utf8").split("\0").filter(Boolean);
const secrets = [];
for (const file of [".env.neon-dev", "data/cloud-private/main-admin.env", "data/cloud-private/app-runtime.env", "data/cloud-private/connections.env", ".vercel/.env.production.local", ".vercel/.env.preview.local"]) {
  let values;
  try {values = parse(await readFile(file));} catch (error) {if (error.code === "ENOENT") continue; throw new Error("秘密設定を検査できません。内容は表示しません");}
  for (const [name, value] of Object.entries(values)) {
    if (!value || !/DATABASE_URL|OIDC_TOKEN|CLIENT_SECRET|REFRESH_TOKEN|APP_PASSWORD/.test(name)) continue;
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
console.log(JSON.stringify({indexedFiles: names.length, privateValueLeaks: 0, excludedFiles: 0, remoteChanged: false}));
