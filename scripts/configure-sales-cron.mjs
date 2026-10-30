import {readFile,writeFile} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {parse} from "dotenv";
const cli="C:/Users/bc/AppData/Roaming/npm/node_modules/vercel/dist/index.js";
const project=JSON.parse(await readFile(new URL("../.vercel/project.json",import.meta.url)));
if(project.projectId!=="prj_GSVAyWDoMTIJepaEbf3YrBplCByT"||project.orgId!=="team_kDASckvfUG81AUJTtTSrqD35")throw new Error("専用プロジェクトを確認してください");
const file=new URL("../data/cloud-private/sales-cron.env",import.meta.url);
let secret;try{secret=parse(await readFile(file)).CRON_SECRET;}catch(e){if(e.code!=="ENOENT")throw e;secret=randomBytes(32).toString("hex");await writeFile(file,`CRON_SECRET=${secret}\n`,{flag:"wx",mode:0o600});}
if(!/^[a-f0-9]{64}$/.test(secret))throw new Error("定期実行の認証設定を確認してください");
if(!process.argv.includes("--apply")){console.log(JSON.stringify({prepared:true,published:false,secretPrinted:false}));process.exit(0);}
const result=spawnSync(process.execPath,[cli,"env","add","CRON_SECRET","production","--sensitive","--yes","--scope","bc-bridalcatjps-projects"],{input:secret,encoding:"utf8",windowsHide:true});
console.log(JSON.stringify({published:result.status===0,environment:"production",secretPrinted:false}));
if(result.status!==0){console.error("定期実行の認証設定を追加できませんでした。既存値は上書きしていません");process.exitCode=1;}
