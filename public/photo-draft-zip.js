// Standard ZIP, stored entries: JPEGs are already compressed. No server copy is created.
const utf8=new TextEncoder();
const crc32=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
export function photoDraftZip(entries){
 if(!Array.isArray(entries)||entries.length>20)throw Error('保存ファイル数を確認してください');
 const parts=[],central=[];let offset=0,total=0;
 for(const [file,bytes]of entries){
  if(!/^[^/\\\x00]+$/.test(file)||!(bytes instanceof Uint8Array)||bytes.length>5000000)throw Error('保存ファイルの内容を確認してください');
  const name=utf8.encode(file),h=new Uint8Array(30),v=new DataView(h.buffer),c=new Uint8Array(46),cv=new DataView(c.buffer),crc=crc32(bytes);
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);v.setUint32(14,crc,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,name.length,true);
  cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,bytes.length,true);cv.setUint32(24,bytes.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);
  parts.push(h,name,bytes);central.push(c,name);offset+=h.length+name.length+bytes.length;total+=bytes.length;if(total>40*1024*1024)throw Error('写真の合計が大きすぎます');
 }
 const index=central.reduce((n,c)=>n+c.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,index,true);v.setUint32(16,offset,true);
 return new Blob([...parts,...central,end],{type:'application/zip'});
}
export const photoDraftText=text=>utf8.encode('\ufeff'+text);
