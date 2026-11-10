import {copyFile,readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
// Package executable files only; never include environment files or business data.
await copyFile(path.join(root,'public/yahoo-fill.js'),path.join(root,'chrome-extension/yahoo-fill.js'));
const manifest=JSON.parse(await readFile(path.join(root,'chrome-extension/manifest.json'),'utf8'));
const crc=b=>{let n=0xffffffff;for(const v of b){n^=v;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
const files=[...new Set(['manifest.json',manifest.background.service_worker,...manifest.content_scripts.flatMap(s=>s.js),'yahoo-fill.js',...Object.values(manifest.icons)])];
for(const name of files){if(!/^[a-zA-Z0-9_./-]+\.(?:js|json|png)$/.test(name)||name.startsWith('/')||name.split('/').includes('..')||!(await lstat(path.join(root,'chrome-extension',name))).isFile())throw new Error('Unexpected extension package file');}
const parts=[],central=[];let offset=0;
for(const file of files.sort()){
 const data=await readFile(path.join(root,'chrome-extension',file)),name=Buffer.from('chrome-extension/'+file),hash=crc(data),h=Buffer.alloc(30),c=Buffer.alloc(46);
 h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(0x5d6b,12);h.writeUInt32LE(hash,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
 c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(0x5d6b,14);c.writeUInt32LE(hash,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
 parts.push(h,name,data);central.push(c,name);offset+=h.length+name.length+data.length;
}
const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
await mkdir(path.join(root,'output'),{recursive:true});
export const extensionArchive=path.join(root,'output',`chrome-extension-${manifest.version}.zip`);
await writeFile(extensionArchive,Buffer.concat([...parts,index,end]));
console.log(`Chrome extension ${manifest.version} prepared (packaged code only)`);
