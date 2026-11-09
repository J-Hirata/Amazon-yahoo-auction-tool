import {ImapFlow} from 'imapflow';
import PostalMime from 'postal-mime';
export function listingMail({from,subject,text,date}){
 if(from!=='auction-master@mail.yahoo.co.jp'||!/Yahoo!オークション\s*-\s*(?:自動再出品|出品)[：:]/.test(subject||''))return null;
 const body=String(text||'').normalize('NFKC'),id=body.match(/オークションID\s*[:：]\s*([a-z][0-9]{6,15})\b/i)?.[1]?.toLowerCase();
 const subjectId=String(subject).normalize('NFKC').match(/\(([a-z][0-9]{6,15})\)/i)?.[1]?.toLowerCase();
 const title=body.match(/^商品\s*[:：]\s*(.+)$/m)?.[1]?.trim();
 return id&&id===subjectId&&title?{listingId:id,title,date}:null;
}
export function createYahooMailReader(config,{Client=ImapFlow,parse=source=>PostalMime.parse(source),now=()=>Date.now()}={}){
 return async()=>{
  const client=new Client({host:'imap.gmail.com',port:993,secure:true,auth:{user:config.user,pass:config.password},logger:false,disableAutoIdle:true,connectionTimeout:8000,greetingTimeout:8000,socketTimeout:10000,maxLiteralSize:1000000,maxResponseSize:2000000,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'}});
  client.on('error',()=>{});const timer=setTimeout(()=>client.close(),20000);let lock;
  try{
   await client.connect();const boxes=await client.list();const mailbox=boxes.find(b=>b.specialUse==='\\All')?.path||'INBOX';lock=await client.getMailboxLock(mailbox,{readOnly:true});
   const ids=await client.search({from:'auction-master@mail.yahoo.co.jp',since:new Date(now()-30*86400000)},{uid:true}),rows=[];
   if(!ids.length)return rows;
   if(ids.length>500)rows.partial=true;
   const headers=await client.fetchAll(ids.slice(-500).join(','),{uid:true,envelope:true,size:true},{uid:true});
   const actionable=headers.filter(h=>/Yahoo!オークション\s*-\s*(?:自動再出品|出品)[：:]/.test(h.envelope?.subject||'')&&h.size<=200000);
   if(actionable.length>200)rows.partial=true;const wanted=actionable.slice(-200);
   if(!wanted.length)return rows;
   const messages=await client.fetchAll(wanted.map(h=>h.uid).join(','),{source:true},{uid:true});
   for(const mail of messages){
    if(!mail?.source)continue;
    const parsed=await parse(mail.source,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
    const row=listingMail({from:parsed.from?.address,subject:parsed.subject,text:parsed.text,date:parsed.date});if(row)rows.push(row);
   }
   return rows;
  }finally{clearTimeout(timer);lock?.release();client.close();}
 };
}
