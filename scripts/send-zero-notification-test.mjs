import {open,writeFile,readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {emptyMonitor,registerPageLink} from "../src/link-monitor.js";
import {queueMonitorResults} from "../src/monitor-notifications.js";
import {cloudMailConfig,createCloudMailTransport} from "../src/cloud-mail.js";

const receiptPath=new URL("../data/cloud-private/zero-notification-test-v1.json",import.meta.url);
if(process.argv.includes("--confirm-received")){const receipt=JSON.parse(await readFile(receiptPath,"utf8"));receipt.inboxConfirmed=true;receipt.inboxConfirmedAt=new Date().toISOString();await writeFile(receiptPath,JSON.stringify(receipt,null,2));console.log(JSON.stringify({subject:receipt.subject,inboxConfirmed:true,emailSentNow:false}));process.exit(0);}
if(!process.argv.includes("--send-one-authorized-test"))throw new Error("本人が承認した1通のテストだけ実行できます");
const config=cloudMailConfig(),at=new Date().toISOString(),state=emptyMonitor();
state.notificationSettings={mailEnabled:true,monitoringEnabled:false};
const link=registerPageLink(state,{amazon:"B000TEST00",yahoo:"https://auctions.yahoo.co.jp/jp/auction/d0000000000",submitted:true},at);
state.listings[0].title="架空商品：通知確認用モニター（実在庫ではありません）";
state.listings[0].observation={status:"active",verified:true,checkedAt:at};
state.amazonInventory={status:"complete",complete:true,scope:"linked_asins_only",asins:[link.asin],items:[{asin:link.asin,sellerSku:"FICTIONAL-TEST-ONLY",title:state.listings[0].title,fulfillableQuantity:0,checkedAt:at,source:"amazon_sp_api"}],startedAt:at,checkedAt:at};
queueMonitorResults(state,at);
const generated=state.mailOutbox?.[0];if(!generated||!state.events.some(e=>e.kind==="inventory_observed_zero"))throw new Error("テスト通知文を生成できません");
const message={...generated,attemptId:randomUUID(),subject:"【ヤフオク併売ツール】架空の在庫ゼロ・送信テスト",text:["【架空データによる送信テスト】","これは実際の商品・在庫切れの通知ではありません。実在庫・出品・価格・広告・自動通知設定は変更していません。","下に出るASIN・出品IDはテスト用の架空値です。実商品のリンクとして使用しないでください。","",generated.text,"","このメールを受信できたら、Codexで「在庫ゼロのテスト届いた」と教えてください。"].join("\n")};
const receipt={kind:"fictional_zero_notification_test",subject:message.subject,to:config.user,attemptId:message.attemptId,startedAt:at,status:"attempting",marketWrites:0,productionDataChanged:false};
const handle=await open(receiptPath,"wx",0o600);try{await handle.writeFile(JSON.stringify(receipt,null,2));}finally{await handle.close();}
let result;try{result=await createCloudMailTransport(config).send(message);}catch{result={status:"uncertain"};}
Object.assign(receipt,{status:result.status,finishedAt:new Date().toISOString(),inboxConfirmed:false});await writeFile(receiptPath,JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt));
