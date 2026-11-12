import test from 'node:test';
import assert from 'node:assert/strict';
import {inputValues,settingsValues,candidateMatch,sampleValues,aggregateSamples,parseTable,decisionValues,ownDescription,searchLinks} from '../shared/research-core.mjs';
const now='2026-11-13T03:00:00Z',settings=settingsValues({minimum:3,grades:{A:'外観良好',B:'通常の使用傷',C:'目立つ傷'}}),input=inputValues({name:'炊飯器',model:'AA-01',jan:'0491234567894'});
const s=(id,price=1000,more={})=>({...sampleValues({source:'yahoo',market:'yahoo',url:'https://page.auctions.yahoo.co.jp/jp/auction/'+id,price,shipping:null,grade:'A',eventAt:'2026-11-10',confirmed:true,comparable:true,...more},settings,now),id});
test('JAN leading zero/check digit and manual inputs are preserved',()=>{
 assert.equal(inputValues({jan:'０４９１２３４５６７８９４'}).jan,'0491234567894');
 for(const jan of ['491234567890','0491234567893','12?'])assert.throws(()=>inputValues({jan}));
 assert.throws(()=>settingsValues({priority:['amazon','amazon']}));assert.throws(()=>settingsValues({keepaLimit:101}));
});
test('matching identity never confirms condition or conflates two models',()=>{
 const c={asin:'B001234567',models:['AA-01'],jans:[],manufacturer:'maker',brand:'',color:'',size:'',spec:''};
 assert.equal(candidateMatch(inputValues({model:'AA-01',manufacturer:'maker'}),c).status,'match');
 assert.equal(candidateMatch(inputValues({model:'AA-01-B'}),c).status,'mismatch');
 assert.equal(candidateMatch(inputValues({name:'似た商品'}),c).status,'candidate');
 assert.equal(candidateMatch(inputValues({jan:'0491234567894'}),{...c,jans:['4901234567894']}).status,'mismatch');
});
test('asking, unknown dates, unreviewed, junk and unknown shipping never contaminate sold medians',()=>{
 const rows=[s('a'),s('b',2000),s('c',3000),s('d',99999,{status:'asking'}),s('e',99999,{eventAt:''}),s('f',99999,{confirmed:false}),s('g',99999,{grade:'J'})];
 const a=aggregateSamples(rows,settings,now);assert.equal(a.groups.yahoo.grades.A.median,2000);assert.equal(a.excluded.length,4);
 assert.equal(aggregateSamples(rows,{...settings,shipping:'total'},now).groups.yahoo.grades.A.median,null);
 assert.equal(aggregateSamples(rows,{...settings,minimum:5},now).groups.yahoo.grades.A.median,null);
});
test('Yahoo and Aucfan dedupe the original auction; conflicting or unknown IDs are not summed',()=>{
 const y=s('x123'),a=s('x123',1000,{source:'aucfan',url:'https://aucfan.com/aucview/yahoo/x123/',originId:'x123'});
 let v=aggregateSamples([y,a],settings,now);assert.equal(v.combinedYahoo.grades.A.count,1);
 v=aggregateSamples([y,{...a,price:2000}],settings,now);assert.equal(v.combinedYahoo.grades.A.count,0);assert.equal(v.combinedYahoo.conflicts.length,1);
 v=aggregateSamples([y,{...a,originId:''}],settings,now);assert.equal(v.combinedYahoo,null);
});
test('Mercari sold display is distinct, invalid dates/URLs and undefined grade rules rejected',()=>{
 const m=s('m123',1000,{source:'mercari',market:'mercari',url:'https://jp.mercari.com/item/m123'});assert.equal(m.kind,'sold_display');
 for(const more of [{eventAt:'2026-02-30'},{eventAt:'2026-11-10T10:00:00'},{url:'https://evil.example/item/x'},{url:'https://jp.mercari.com/item/m123',source:'yahoo'},{url:'https://page.auctions.yahoo.co.jp/jp/auction/x?access_token=secret'}])assert.throws(()=>s('a',1000,more));
 assert.throws(()=>sampleValues({source:'yahoo',market:'yahoo',url:'https://page.auctions.yahoo.co.jp/jp/auction/x',price:1000,shipping:null,grade:'A'},settingsValues(),now));
});
test('bulk CSV supports quoted commas/newlines, refs cap3, text uses own item only',()=>{
 assert.deepEqual(parseTable('title,url\n"a,b","https://x"\n'),[{title:'a,b',url:'https://x'}]);
 assert.equal(parseTable('title\tnote\n"x"\t"a\nb"')[0].note,'a\nb');assert.throws(()=>parseTable('a,a\n1,2'));
 assert.throws(()=>decisionValues({references:Array.from({length:4},()=>({url:'https://www.amazon.co.jp/dp/B001234567',relation:'same'}))}));
 assert.ok(ownDescription(inputValues({condition:'私の傷',accessories:'本体のみ'})).includes('私の傷'));
 assert.ok(searchLinks(inputValues({model:'A&B'}),settings).steps[0].url.includes('A%26B'));
});
