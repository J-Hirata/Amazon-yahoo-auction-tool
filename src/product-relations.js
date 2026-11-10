import {addDrafts} from './cloud-drafts.js';
const family=v=>/^(used|中古)/i.test(v||'')?'used':/^(new|新品)/i.test(v||'')?'new':v==='parts'?'parts':'unknown';
export function relationIssue(p,q){
 if(!p.asin||p.asin!==q.asin)return 'ASINが異なります';
 if(p.sellerSku&&q.sellerSku&&p.sellerSku!==q.sellerSku)return 'SKUが異なります';
 if(family(p.condition)!=='unknown'&&family(q.condition)!=='unknown'&&family(p.condition)!==family(q.condition))return '新品・中古・部品扱いが異なります';
 if(p.setContents&&q.setContents&&p.setContents!==q.setContents)return 'セット内容が異なります';
 return '';
}
export async function associateDraft(docs,product,{stockId='',planId='',linkIds=[]}={},at){
 const drafts=docs['draft-items'].state;let d=drafts.find(d=>d.asin===product.asin);
 if(d&&(relationIssue(product,{asin:d.asin,...d.workspaceProduct})||d.workspaceStockId&&stockId&&d.workspaceStockId!==stockId||d.workspacePlanId&&planId&&d.workspacePlanId!==planId))throw Object.assign(new Error('このASINの下書きは別SKU・状態・在庫・計画に関連済みです。既存の関連を確認してください'),{status:409});
 if(!d){await addDrafts(drafts,product.asin,at);d=drafts.find(d=>d.asin===product.asin);d.title=product.title;d.description=product.setContents||'';if(product.imageUrl)d.imageUrls=[product.imageUrl];}
 if(stockId)d.workspaceStockId=stockId;if(planId)d.workspacePlanId=planId;
 d.linkedLinkIds=[...new Set([...(d.linkedLinkIds||[]),...linkIds])];
 d.workspaceProduct={...d.workspaceProduct,sellerSku:product.sellerSku||d.workspaceProduct?.sellerSku||'',condition:product.condition||'unknown',setContents:product.setContents||'',memo:d.workspaceProduct?.memo||''};
 return d;
}
