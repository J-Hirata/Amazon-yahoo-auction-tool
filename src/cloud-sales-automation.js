import {salesMailSummary} from "./sales-mail-summary.js";
import {productAlertsMail} from "./product-alert-mail.js";
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

export function createCloudSalesAutomation({store,sales,transport,monitoring,readInventory=async()=>({rows:[]}),riskExecutionEnabled=false,readAlertStates=async()=>undefined,now=()=>new Date().toISOString()}) {
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
  function enqueue(state,{key,subject,text,targets=[],eventIds=[],kind="sales",notificationMode="daily"}) {
    const outbox=state.mailOutbox ||= [];
    if(outbox.some(record=>record.key===key))return false;
    if(outbox.length>=5000)throw fail("メール記録の保存上限です。履歴を保全して確認してください");
    outbox.push({id:randomUUID(),key,kind,subject,text,targets,eventIds,status:"pending",attempts:0,createdAt:now(),automation:true,notificationMode});
    return true;
  }
  async function drain({testOnly=false,kinds,notificationMode}={}) {
    let alertStates;try{alertStates=await readAlertStates();}catch{alertStates={};}
    const held=new Set();
    const record=await store.update(state=>{
      for(const item of state.mailOutbox || [])if(item.automation && item.status==="sending" && Date.parse(item.lastAttemptAt)+120000<=Date.parse(now())){
        item.status="uncertain";item.error="送信結果が不明です。受信箱を確認してください。自動再送はしません";
      }
      if(!testOnly&&alertStates)for(const item of state.mailOutbox||[])if(item.kind==='product_alerts'&&['pending','failed'].includes(item.status)&&item.alertIds?.length){const ended=item.alertIds.filter(id=>alertStates[id]===false);if(ended.length){item.status='cancelled';item.cancelledFor='conditions_changed';item.cancelledAlertIds=ended;item.error='警告条件が解消・変更されたため送信を取り消しました';}else if(item.alertIds.some(id=>alertStates[id]!==true))held.add(item.id);}
      const item=(state.mailOutbox || []).find(item=>item.automation && !held.has(item.id) && (!notificationMode||item.notificationMode===notificationMode) && (!kinds||kinds.includes(item.kind)) && (testOnly ? item.kind==="automation_test" : state.salesAutomation?.enabled && item.kind!=="automation_test") &&
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
    let inventory;try{inventory=await readInventory();}catch{inventory={rows:[],readFailed:true};}
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
      const ids=events.map(e=>e.id).sort(),summary=salesMailSummary({state,events,inventory,at:now()});
      enqueue(state,{key:`sales:${hash(ids.join(","))}`,subject:"【在庫管理ツール】Amazonの販売・訂正のお知らせ",eventIds:ids,targets:summary.targets,text:summary.text});
      for(const event of t.events)if(ids.includes(event.id))event.delivery="queued";
    });
  }
  async function runCycle({mode,send}) {
    const jobKey=mode==='risk'?'riskAutomationJob':'salesAutomationJob',incidentKey=mode==='risk'?'riskAutomationIncident':'salesAutomationIncident';
    const jobId=randomUUID(),at=now(),started=performance.now();
    const claimed=await store.update(state=>{
      if(!state.salesAutomation?.enabled)return false;
      if([state.salesAutomationJob,state.riskAutomationJob].some(job=>job?.status==="running"&&Date.parse(job.leaseUntil)>Date.parse(at)))return false;
      state[jobKey]={status:"running",jobId,startedAt:at,leaseUntil:new Date(Date.parse(at)+290000).toISOString()};return true;
    });
    if(!claimed)return {status:"skipped"};
    let error=null;
    try{
      if(mode==='daily'){
      await sales.start({});
      for(let pass=0;pass<2;pass++){
        await sales.check({catchUp:true});
        const t=(await store.read()).salesTracking;
        if(t.sync.status!=="complete")throw fail(t.sync.error);
        if(Date.parse(t.checkedThrough)>=Date.parse(now())-15*60000)break;
      }
      const state=await store.read();
      if(Date.parse(state.salesTracking.checkedThrough)<Date.parse(now())-15*60000)throw fail("不足期間の補完中です。次回は保存済みの続きから再開します");

      }
    }catch(e){if(String(e.code || "").startsWith("STORAGE_"))throw e;error="販売確認を完了できません。販売ゼロとは扱いません。管理画面で取得状況を確認してください";}
    let monitoringResult;
    if(monitoring&&performance.now()-started<180000){
      try{monitoringResult=await monitoring.run({settings:{...(await store.read()).salesAutomation,...(mode==='risk'?{reviewAlerts:false}:{})},refreshListings:mode==='risk',enqueueAlerts:send?alerts=>queueProductAlerts(alerts,mode):undefined});}
      catch(e){if(String(e.code||"").startsWith("STORAGE_"))throw e;monitoringResult={status:"failed",errors:["在庫・出品・期限の監視を完了できません。全商品一覧で確認してください"]};}
    }else if(monitoring)monitoringResult={status:"partial",errors:["実行時間のため在庫・出品監視は次回に再開します"]};
    if(!error&&mode==='daily'){try{await queueSales();}catch(e){if(String(e.code||"").startsWith("STORAGE_"))throw e;error="販売メールの集計を完了できません。次回再開します";}}
    await store.update(state=>{
      if(state[jobKey]?.jobId!==jobId)throw fail("定期実行の結果を確認してください");
      state[jobKey]={...state[jobKey],mode,status:error?"failed":monitoringResult&&monitoringResult.status!=="complete"?"partial":"complete",finishedAt:now(),error,monitoring:monitoringResult};
      if(error && send && state.salesAutomation.errorAlerts){
        state[incidentKey] ||= {id:randomUUID(),startedAt:now()};
        enqueue(state,{key:`incident:${mode==='risk'?'risk:':''}${state[incidentKey].id}`,kind:"automation_error",notificationMode:mode,subject:mode==='risk'?"【在庫管理ツール】リスク確認が止まっています":"【在庫管理ツール】販売の自動確認が止まっています",text:error+"\nhttps://amazon-yahoo-inventory.vercel.app/"});
      }else if(!error)state[incidentKey]=null;
    });
    // At most 3 pending messages per invocation; SMTP ambiguity is never retried.
    if(send)for(let i=0;i<3;i++){if(performance.now()-started>250000)break;if(!await drain(mode==='risk'?{kinds:['product_alerts','automation_error'],notificationMode:'risk'}:{}))break;}
    return {status:error?"failed":monitoringResult&&monitoringResult.status!=="complete"?"partial":"complete"};
  }
  async function queueProductAlerts(alerts,notificationMode="daily"){
    await store.update(state=>{
      if(!state.salesAutomation?.enabled)return;
      const existing=new Set((state.mailOutbox||[]).filter(r=>r.cancelledFor!=='conditions_changed').flatMap(r=>r.alertIds||[]));
      const fresh=alerts.filter(a=>state.salesAutomation[a.category]&&!existing.has(a.id));if(!fresh.length)return;
      const ids=fresh.map(a=>a.id).sort(),key=`product-alerts:${hash(ids.join(","))}`;
      enqueue(state,{key,kind:"product_alerts",notificationMode,subject:`【在庫管理ツール】${notificationMode==='risk'?'在庫・出品の警告':'在庫・出品・見直しの確認'} ${fresh.length}件`,targets:fresh.filter(a=>a.asin).map(a=>({asin:a.asin})),
        text:productAlertsMail(fresh,{mode:notificationMode,at:now()})});
      state.mailOutbox.find(r=>r.key===key).alertIds=ids;
    });
  }
  const run=()=>runCycle({mode:'daily',send:true});
  async function runRisks({send=false}={}){if(typeof send!=='boolean')throw fail('送信の指定を確認してください',400);if(send&&!riskExecutionEnabled)throw fail('日中監視の頻度・運用が未設定のため、送信実行は有効化されていません',409);return runCycle({mode:'risk',send});}
  return {settings,test,run,runRisks,drain,queueSales,view:state=>automationView(state,now())};
}
