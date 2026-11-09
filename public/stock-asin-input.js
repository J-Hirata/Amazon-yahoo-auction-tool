import {normalizeAsinInput,validateAsinInput} from '../src/asin-input.js';
export function bindStockAsin(input,{onReady=()=>{}}={}){
 let composing=false;input.maxLength=2048;input.setAttribute('aria-label','ASIN（任意）');const hint=document.createElement('small');hint.className='stock-asin-hint';hint.id='stockAsinInputHint';input.setAttribute('aria-describedby',hint.id);hint.setAttribute('role','status');input.after(hint);
 const refresh=()=>{input.setCustomValidity('');const value=normalizeAsinInput(input.value);hint.textContent=!value?'ASINは10文字。Amazon商品URLも貼り付けできます。':/^[A-Z0-9]{10}$/.test(value)?'ASIN：10文字':'ASIN：'+value.length+'文字（10文字で入力）';};
 const normalize=()=>{const value=validateAsinInput(input.value);input.value=value;refresh();return value;};
 input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;refresh();if(/^[A-Z0-9]{10}$/.test(normalizeAsinInput(input.value)))onReady();});
 input.addEventListener('input',event=>{if(composing||event.isComposing)return;refresh();if(!input.value||/^[A-Z0-9]{10}$/.test(normalizeAsinInput(input.value)))onReady();});
 input.addEventListener('paste',event=>{if(!event.clipboardData)return;event.preventDefault();const start=input.selectionStart??0,end=input.selectionEnd??input.value.length,value=input.value.slice(0,start)+event.clipboardData.getData('text')+input.value.slice(end);input.value=normalizeAsinInput(value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 input.addEventListener('blur',()=>{if(composing)return;try{normalize();onReady();}catch(e){input.setCustomValidity(e.message);hint.textContent=e.message;}});
 refresh();return {normalize,refresh};
}
