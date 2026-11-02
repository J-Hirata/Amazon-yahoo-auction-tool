import {randomUUID,createHash} from "node:crypto";
import {NOTIFICATION_ADDRESS} from "./notification-settings.js";

const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const hash=value=>createHash("sha256").update(value).digest("hex");
const testKey="sales-automation-test:v1";
export function automationView(state,at=new Date().toISOString()) {
  const settings=state.salesAutomation || {};
  const job=state.salesAutomationJob || {status:"not_run"};
  const interrupted=job.status==="running" && Date.parse(job.leaseUntil)<=Date.parse(at);
  return {enabled:Boolean(settings.enabled),fbaSales:settings.fbaSales!==false,merchantSales:settings.merchantSales!==false,errorAlerts:settings.errorAlerts!==false,
    stockAlerts:Boolean(settings.stockAlerts),yahooAlerts:Boolean(settings.yahooAlerts),reviewAlerts:Boolean(settings.reviewAlerts),
    enabledAt:settings.enabledAt || null,recipient:NOTIFICATION_ADDRESS,schedule:"1日1回・午前9時台（日本時間）",job:interrupted?{...job,status:"failed",error:"前回の定期確認が途中で止まりました。次回再開します"}:job};
}

export function createCloudSalesAutomation({store,sales,transport,monitoring,now=()=>new Date().toISOString()}) {
  async function settings({expectedRevision,enabled,fbaSales,merchantSales,errorAlerts,stockAlerts,yahooAlerts,reviewAlerts}) {
    if([enabled,fbaSales,merchantSales,errorAlerts].some(v=>typeof v!=="boolean"))throw fail("通知の種類と自動確認を選択してください",400);
    await store.update(state=>{
      if(enabled && state.cloudMail?.status!=="verified")throw fail("先にGmail接続を確認してください");
      const old=state.salesAutomation;
      const categories={};for(const [key,value] of Object.entries({stockAlerts,yahooAlerts,reviewAlerts})){if(value!==undefined&&typeof value!=="boolean")throw fail("通知の種類を選択してください",400);categories[key]=value??old?.[key]??false;}
      if(!enabled || old && (old.fbaSales!==fbaSales || old.merchantSales!==merchantSales || Object.keys(categories).some(k=>Boolean(old[k])!==categories[k])))for(const record of state.mailOutbox || [])if(record.automation && record.kind!=="automation_test" && ["pending","failed"].includes(record.status)){
        record.status="cancelled";
        for(const event of state.salesTracking?.events || [])if(record.eventIds.includes(event.id))event.delivery=enabled?"preview":"muted";
      }
      state.salesAutomation={version:1,enabled,fbaSales,merchantSales,errorAlerts,...categories,enabledAt:enabled && !old?.enabled ? now() : old?.enabledAt || null,updatedAt:now()};
    },{expectedRevision});
  }
  function enqueue(state,{key,subject,text,targets=[],eventIds=[],kind="sales"}) {
    const outbox=state.mailOutbox ||= [];
    if(outbox.some(record=>record.key===key))return false;
    if(outbox.length>=5000)throw fail("メール記録の保存上限です。履歴を保全して確認してください");
    outbox.push({id:randomUUID(),key,kind,subject,text,targets,eventIds,status:"pending",attempts:0,createdAt:now(),automation:true});
    return true;
  }
  async function drain({testOnly=false}={}) {
    const record=await store.update(state=>{
      for(const item of state.mailOutbox || [])if(item.automation && item.status==="sending" && Date.parse(item.lastAttemptAt)+120000<=Date.parse(now())){
        item.status="uncertain";item.error="送信結果が不明です。受信箱を確認してください。自動再送はしません";
      }
      const item=(state.mailOutbox || []).find(item=>item.automation && (testOnly ? item.kind==="automation_test" : state.salesAutomation?.enabled && item.kind!=="automation_test") &&
        (item.status==="pending" || !testOnly && item.status==="failed" && item.attempts<3 && Date.parse(item.lastAttemptAt)+3600000<=Date.parse(now())));
      if(!item)return null;
      item.status="sending";item.attempts++;item.attemptId ||= randomUUID();item.lastAttemptAt=now();
      return structuredClone(item);
    });
    if(!record)return null;
    let result;try{result=await transport.send(record);}catch{result={status:"uncertain"};}
    await store.update(state=>{
      const item=state.mailOutbox.find(item=>item.id===record.id);
      if(item.status!=="sending" || item.attemptId!==record.attemptId)throw fail("メール送信結果を確認してください");
      item.status=["smtp_accepted","failed"].includes(result.status)?result.status:"uncertain";item.finishedAt=now();
      item.error=item.status==="smtp_accepted"?null:item.status==="failed"?"送信が拒否されました。通常通知は次回に再試行（最大3回）。接続を確認してください":"送信結果が不明です。受信箱を確認してください。自動再送はしません";
      for(const event of state.salesTracking?.events || [])if(item.eventIds.includes(event.id))event.delivery=item.status;
    });
    return {id:record.id,status:result.status};
  }
  async function test({expectedRevision,confirmed}) {
    if(confirmed!==true)throw fail("登録先へのテスト1通の送信を確認してください",400);
    await store.update(state=>{
      if(state.cloudMail?.status!=="verified")throw fail("先にGmail接続を確認してください");
      enqueue(state,{key:testKey,kind:"automation_test",subject:"【在庫管理ツール】販売通知の経路テスト（実注文ではありません）",
        text:["販売通知の保存・重複防止・Gmail送信と同じ経路によるテストです。実際の販売や在庫切れの通知ではありません。",
          "FBAと自社発送の販売は、登録商品の自社SKUとAmazon注文で確認します。発送済みに変わっても同じ販売を再通知しません。",
          "現在の試行は1日1回です。販売がない日は販売メールを送りません。過去期間の補完は新着として送りません。",
          "送信受付と受信箱への到着は別に確認します。", "管理画面：https://amazon-yahoo-inventory.vercel.app/"].join("\n\n")});
    },{expectedRevision});
    return drain({testOnly:true});
  }
  async function queueSales() {
    await store.update(state=>{
      const s=state.salesAutomation,t=state.salesTracking;
      if(!s?.enabled || !t)return;
      const events=[];
      for(const event of t.events){
        if(event.delivery!=="preview")continue;
        const effectiveAt=event.kind==="order_corrected" ? event.updatedAt || event.eligibleFromAt : event.eligibleFromAt;
        if(Date.parse(effectiveAt)<Date.parse(s.enabledAt)){event.delivery="historical";continue;}
        const fulfillment=event.fulfillment || t.orders.find(row=>row.orderId===event.orderId && row.itemId===event.itemId)?.fulfillment || "UNKNOWN";
        if(fulfillment==="AMAZON" && !s.fbaSales || fulfillment==="MERCHANT" && !s.merchantSales){event.delivery="muted";continue;}
        events.push({...event,fulfillment});
      }
      if(!events.length)return;
      const ids=events.map(e=>e.id).sort(),lines=events.map(e=>{
        const target=t.trackers.find(v=>v.asin===e.asin&&v.sellerSku===e.sellerSku);
        return `${target?.title || e.asin}\n${e.fulfillment==="MERCHANT"?"自社発送":e.fulfillment==="AMAZON"?"FBA":"発送方法は要確認"} ／ ${e.delta>0?"注文確定 +":"取消・訂正 "}${e.delta}個\nASIN: ${e.asin} ／ SKU: ${e.sellerSku}\nhttps://www.amazon.co.jp/dp/${e.asin}`;
      });
      enqueue(state,{key:`sales:${hash(ids.join(","))}`,subject:"【在庫管理ツール】Amazonの販売・訂正のお知らせ",eventIds:ids,targets:events.map(e=>({asin:e.asin,sellerSku:e.sellerSku})),
        text:["登録商品のAmazon注文に変化がありました。",...lines,"確認済み期間の末尾："+t.checkedThrough,"並売を続けるか、追加納品するかは管理画面で確認してください。現物在庫・出品は自動変更していません。","https://amazon-yahoo-inventory.vercel.app/"].join("\n\n")});
      for(const event of t.events)if(ids.includes(event.id))event.delivery="queued";
    });
  }
  async function run() {
    const jobId=randomUUID(),at=now(),started=performance.now();
    const claimed=await store.update(state=>{
      if(!state.salesAutomation?.enabled)return false;
      const job=state.salesAutomationJob;
      if(job?.status==="running" && Date.parse(job.leaseUntil)>Date.parse(at))return false;
      state.salesAutomationJob={status:"running",jobId,startedAt:at,leaseUntil:new Date(Date.parse(at)+290000).toISOString()};return true;
    });
    if(!claimed)return {status:"skipped"};
    let error=null;
    try{
      await sales.start({});
      for(let pass=0;pass<2;pass++){
        await sales.check({catchUp:true});
        const t=(await store.read()).salesTracking;
        if(t.sync.status!=="complete")throw fail(t.sync.error);
        if(Date.parse(t.checkedThrough)>=Date.parse(now())-15*60000)break;
      }
      const state=await store.read();
      if(Date.parse(state.salesTracking.checkedThrough)<Date.parse(now())-15*60000)throw fail("不足期間の補完中です。次回は保存済みの続きから再開します");
      await queueSales();
    }catch(e){if(String(e.code || "").startsWith("STORAGE_"))throw e;error="販売確認を完了できません。販売ゼロとは扱いません。管理画面で取得状況を確認してください";}
    let monitoringResult;
    if(monitoring&&performance.now()-started<180000){
      try{monitoringResult=await monitoring.run({settings:(await store.read()).salesAutomation,enqueueAlerts:queueProductAlerts});}
      catch(e){if(String(e.code||"").startsWith("STORAGE_"))throw e;monitoringResult={status:"failed",errors:["在庫・出品・期限の監視を完了できません。全商品一覧で確認してください"]};}
    }else if(monitoring)monitoringResult={status:"partial",errors:["実行時間のため在庫・出品監視は次回に再開します"]};
    await store.update(state=>{
      if(state.salesAutomationJob?.jobId!==jobId)throw fail("定期実行の結果を確認してください");
      state.salesAutomationJob={...state.salesAutomationJob,status:error?"failed":monitoringResult&&monitoringResult.status!=="complete"?"partial":"complete",finishedAt:now(),error,monitoring:monitoringResult};
      if(error && state.salesAutomation.errorAlerts){
        state.salesAutomationIncident ||= {id:randomUUID(),startedAt:now()};
        enqueue(state,{key:`incident:${state.salesAutomationIncident.id}`,kind:"automation_error",subject:"【在庫管理ツール】販売の自動確認が止まっています",text:error+"\nhttps://amazon-yahoo-inventory.vercel.app/"});
      }else if(!error)state.salesAutomationIncident=null;
    });
    // At most 3 pending messages per invocation; SMTP ambiguity is never retried.
    for(let i=0;i<3;i++){if(performance.now()-started>250000)break;if(!await drain())break;}
    return {status:error?"failed":monitoringResult&&monitoringResult.status!=="complete"?"partial":"complete"};
  }
  async function queueProductAlerts(alerts){
    await store.update(state=>{
      if(!state.salesAutomation?.enabled)return;
      const existing=new Set((state.mailOutbox||[]).flatMap(r=>r.alertIds||[]));
      const fresh=alerts.filter(a=>state.salesAutomation[a.category]&&!existing.has(a.id));if(!fresh.length)return;
      const ids=fresh.map(a=>a.id).sort(),key=`product-alerts:${hash(ids.join(","))}`;
      enqueue(state,{key,kind:"product_alerts",subject:`【在庫管理ツール】在庫・出品・見直しの確認 ${fresh.length}件`,targets:fresh.filter(a=>a.asin).map(a=>({asin:a.asin})),
        text:["日次確認で対応が必要な項目があります。",...fresh.map(a=>`${a.title}${a.asin?` ／ ${a.asin}`:""}\n確認：${new Date(a.at||now()).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}\n${a.message}`),"全商品一覧：https://amazon-yahoo-inventory.vercel.app/?view=overview","数量・出品・広告は自動変更していません。"].join("\n\n")});
      state.mailOutbox.find(r=>r.key===key).alertIds=ids;
    });
  }
  return {settings,test,run,drain,queueSales,view:state=>automationView(state,now())};
}
