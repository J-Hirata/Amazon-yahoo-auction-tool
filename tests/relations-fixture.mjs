import {randomUUID}from'node:crypto';
import {emptyMonitor,registerPageLink}from'../src/link-monitor.js';
import {emptyPhysicalStock,applyStockCommand,validatePhysicalStock}from'../src/physical-stock.js';
import {emptySalesPlanning,applyPlanningCommand,validateSalesPlanning}from'../src/sales-planning.js';
import {emptyProductWatch,validateProductWatch}from'../src/product-overview.js';
import {validateDraftItems,validateMonitorState}from'../src/storage-validation.js';
import {createProductLinkEditor}from'../src/product-link-editor.js';
export const at='2026-11-10T04:00:00.000Z',actor='relations-test',asin='B000TEST01';
export function fixture(){
 let docs={'link-monitor':{state:emptyMonitor(),revision:0},'physical-stock':{state:emptyPhysicalStock(),revision:0},'sales-planning':{state:emptySalesPlanning(),revision:0},'draft-items':{state:[],revision:0},'product-watch':{state:emptyProductWatch(),revision:0}};
 const stockId=randomUUID(),planId=randomUUID();
 for(const [id,sku,title]of[[stockId,'SKU1','登録済みのモニター'],[randomUUID(),'OTHER','別SKUのモニター']])applyStockCommand(docs['physical-stock'].state,{operationId:randomUUID(),kind:'create',productId:id,product:{asin,title,sellerSku:sku,condition:'used',unit:'個',memo:'在庫の元メモ'},initialCounts:{container:50,home:2}},{actor,at});
 const link=registerPageLink(docs['link-monitor'].state,{amazon:asin,yahoo:'https://auctions.yahoo.co.jp/jp/auction/h1248825083',submitted:true},at);link.amazonSellerSku='SKU1';link.workspaceProduct={title:'出品済みのモニター',condition:'used'};
 applyPlanningCommand(docs['sales-planning'].state,{operationId:randomUUID(),kind:'create',planId,plan:{asin,title:'登録済みの販売監視',sellerSku:'SKU1',condition:'used',source:{kind:'stock',id:stockId},kind:'amazon',status:'active',durationDays:10,availableOn:'2026-11-01',decisions:['advertising'],note:'変更しない方針メモ'}},{actor,at,sources:[{...docs['physical-stock'].state.products[0],kind:'stock'}]});
 docs['draft-items'].state.push({asin,title:'以前の下書き名',description:'以前の手書き文面',imageUrls:[],status:'draft_saved',draftSavedAt:at,createdAt:at,startPrice:1234});
 const validators={'link-monitor':validateMonitorState,'physical-stock':validatePhysicalStock,'sales-planning':validateSalesPlanning,'product-watch':validateProductWatch,'draft-items':validateDraftItems};
 const transaction={read:async()=>structuredClone(docs),update:async fn=>{const copy=structuredClone(docs),result=await fn(copy);for(const [k,d]of Object.entries(copy)){validators[k](d.state);if(JSON.stringify(d.state)!==JSON.stringify(docs[k].state))d.revision++;}docs=copy;return result;}};
 const editor=createProductLinkEditor({transaction,overview:{view:async()=>({rows:[]})}});
 const options=()=>({actor,at,confirmed:true,expectedRevision:docs['link-monitor'].revision,sourceRevisions:Object.fromEntries(Object.entries(docs).map(([k,d])=>[k,d.revision]))});
 const command=(key,extra={})=>({operationId:randomUUID(),kind:'workspace',key,product:{},workspace:{},stockId:'',linkIds:[],registration:{stock:false,merchant:false,yahoo:false,draft:false,planning:false,yahooUrl:''},...extra});
 return {transaction,editor,stockId,linkId:link.id,planId,options,command,read:()=>structuredClone(docs)};
}
