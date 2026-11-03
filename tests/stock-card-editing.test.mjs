import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyPhysicalStock,applyStockCommand} from '../src/physical-stock.js';
import {registrationCandidates} from '../public/stock-registration.js';
const at='2026-11-03T05:00:00.000Z',actor='fixture-owner';
function fixture(){
 const state=emptyPhysicalStock(),id=randomUUID();
 applyStockCommand(state,{operationId:randomUUID(),kind:'create',productId:id,product:{title:'Monitor',asin:'B000TEST01',sellerSku:'OWN-GOOD',condition:'used',memo:'Original memo',linkedLinkIds:[randomUUID()],fbaEligibility:'possible',setContents:'No stand'},initialCounts:{container:3,home:null}},{actor,at});
 return {state,id};
}
const memo=(id,patch={})=>({operationId:randomUUID(),kind:'memo',productId:id,previousMemo:'Original memo',memo:'No stand\nCable included',...patch});
test('card memo updates only the memo with audit history and does not copy metadata or quantities',()=>{
 const {state,id}=fixture(),before=structuredClone(state);
 applyStockCommand(state,memo(id,{product:{title:'Do not replace',sellerSku:'OTHER'},locations:{home:{usable:99}}}),{actor,at});
 assert.deepEqual(state.products[0],{...before.products[0],memo:'No stand\nCable included',updatedAt:at});
 assert.deepEqual(state.balances,before.balances);assert.deepEqual(state.transfers,before.transfers);
 assert.equal(state.events.at(-1).kind,'memo');assert.equal(state.events.at(-1).changes.length,0);assert.equal(state.events.at(-1).metadataBefore.memo,'Original memo');
});
test('memo clearing and receipt replay preserve unknown and zero balances',()=>{
 const {state,id}=fixture();applyStockCommand(state,{operationId:randomUUID(),kind:'count_locations',productId:id,locations:{container:{usable:0,reserved:0,unusable:0}},reason:'Fixture zero'},{actor,at});
 const command=memo(id,{memo:''}),balances=structuredClone(state.balances);
 applyStockCommand(state,command,{actor,at});const before=structuredClone(state);
 assert.equal(applyStockCommand(state,command,{actor,at}).replayed,true);assert.deepEqual(state,before);assert.equal(state.products[0].memo,'');assert.deepEqual(state.balances,balances);
});
test('stale or missing previous memo and oversized text are rejected without touching the product',()=>{
 for(const patch of [{previousMemo:'Earlier value'},{previousMemo:undefined},{memo:undefined},{memo:'x'.repeat(501)}]){
  const {state,id}=fixture(),before=structuredClone(state);assert.throws(()=>applyStockCommand(state,memo(id,patch),{actor,at}));assert.deepEqual(state,before);
 }
});
const options=[{id:'good1',asin:'B000TEST01',sellerSku:'OWN-GOOD',condition:'UsedGood'},{id:'good2',asin:'B000TEST01',sellerSku:'OWN-GOOD',condition:'UsedGood'},{id:'other',asin:'B000TEST01',sellerSku:'OWN-VERY-GOOD',condition:'UsedVeryGood'},{id:'new',asin:'B000TEST01',sellerSku:'OWN-NEW',condition:'NewItem'},{id:'second',asin:'B000TEST02',sellerSku:'OTHER',condition:'UsedGood'}];
test('registration shows exact ASIN candidates and an entered SKU narrows without mixing SKUs',()=>{
 assert.equal(registrationCandidates(options).length,0);
 assert.equal(registrationCandidates(options,{asin:'b000test01'}).length,4);
 assert.deepEqual(registrationCandidates(options,{asin:'B000TEST01',sellerSku:'OWN-GOOD',condition:'used'}).map(l=>l.id),['good1','good2']);
 assert.equal(registrationCandidates(options,{asin:'B000TEST03'}).length,0);
 assert.equal(registrationCandidates(options,{asin:'B000TEST01',sellerSku:'OTHER'}).length,0);
});
test('SKU-only registration can find the saved listing but condition mismatch stays disabled',()=>{
 assert.equal(registrationCandidates(options,{sellerSku:'OWN-NEW',condition:'used'})[0].mismatch,true);
 assert.equal(registrationCandidates(options,{sellerSku:'OWN-NEW',condition:'new'})[0].mismatch,false);
 assert.ok(registrationCandidates(options,{asin:'B000TEST01',condition:'parts'}).every(l=>l.mismatch));
});
test('an existing relation remains explicit when edited fields no longer match',()=>{
 const rows=registrationCandidates(options,{asin:'B000TEST02',sellerSku:'OTHER',condition:'used',linkedLinkIds:['good1']});
 assert.equal(rows.find(r=>r.id==='good1').existing,true);assert.equal(rows.find(r=>r.id==='good1').mismatch,true);assert.equal(rows.length,2);
});
