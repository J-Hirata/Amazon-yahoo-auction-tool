export function normalizeAsinInput(value=''){
 if(typeof value!=='string'||value.length>2048)throw Object.assign(new Error('ASINまたはAmazon商品URLを入力してください'),{status:400});
 let text=value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').toUpperCase();
 if(/^(HTTPS?:\/\/|(?:WWW\.)?AMAZON\.CO\.JP\/)/i.test(text))try{const u=new URL(/^HTTPS?:/i.test(text)?text:'https://'+text);if(u.protocol!=='https:'||!/(^|\.)amazon\.co\.jp$/i.test(u.hostname)||u.username||u.password||u.port)return text;const match=u.pathname.match(/\/(?:DP|GP\/PRODUCT|GP\/AW\/D)\/([A-Z0-9]{10})(?=\/|$)/i),query=u.searchParams.get('ASIN')||u.searchParams.get('asin');if(match)text=match[1];else if(query&&/^[A-Z0-9]{10}$/.test(query))text=query;}catch{}
 return text;
}
export function validateAsinInput(value){const result=normalizeAsinInput(value??'');if(result&&!/^[A-Z0-9]{10}$/.test(result))throw Object.assign(new Error(`ASINは半角英数字10文字です（現在${result.length}文字）。文字を省略せず確認してください`),{status:400});return result;}
