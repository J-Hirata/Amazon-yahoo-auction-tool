import test from "node:test";
import assert from "node:assert/strict";
import {presentationSettings,presentationOrder,catalogImage} from "../public/catalog-view.js";

test("presentation settings reject unknown modes and never infer a default tile preference",()=>{
  assert.deepEqual(presentationSettings(),{mode:"list",sort:"original"});
  assert.deepEqual(presentationSettings({mode:"tiles",sort:"measureAsc"}),{mode:"tiles",sort:"measureAsc"});
  assert.deepEqual(presentationSettings({mode:"other",sort:"other"}),{mode:"list",sort:"original"});
});
test("visual sorting is stable and never modifies the original collection or business records",()=>{
  const input=[{id:1,title:"商品10",measure:2},{id:2,title:"商品2",measure:0},{id:3,title:"商品3",measure:2}],before=structuredClone(input);
  assert.deepEqual(presentationOrder(input,"titleAsc").map(x=>x.id),[2,3,1]);
  assert.deepEqual(presentationOrder(input,"titleDesc").map(x=>x.id),[1,3,2]);
  assert.deepEqual(presentationOrder(input,"measureDesc").map(x=>x.id),[1,3,2]);
  assert.deepEqual(presentationOrder(input,"original"),input);assert.deepEqual(input,before);
});
test("unknown quantities stay last in either direction; zero remains a known number",()=>{
  const input=[{id:"unknown",measure:null},{id:"large",measure:9},{id:"zero",measure:0},{id:"missing"},{id:"invalid",measure:NaN}];
  assert.deepEqual(presentationOrder(input,"measureAsc").map(x=>x.id),["zero","large","unknown","missing","invalid"]);
  assert.deepEqual(presentationOrder(input,"measureDesc").map(x=>x.id),["large","zero","unknown","missing","invalid"]);
});
test("tile photos only accept the existing approved Amazon and Yahoo image hosts",()=>{
  assert.ok(catalogImage("https://m.media-amazon.com/images/I/photo.jpg"));assert.ok(catalogImage("https://auctions.c.yimg.jp/photo.jpg"));
  for(const value of ["javascript:alert(1)","http://m.media-amazon.com/photo.jpg","https://m.media-amazon.com.evil.example/photo.jpg","https://user:secret@m.media-amazon.com/photo.jpg","https://m.media-amazon.com:8443/photo.jpg"])assert.equal(catalogImage(value),"");
});
