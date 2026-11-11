import {writeFile,readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {storageConfiguration} from '../src/storage-runtime.js';
const mode=process.argv[2],config=storageConfiguration(),out='output/photo-foundation-20261112';
if(!['before','after'].includes(mode)||config.environment!=='production'||!config.host.startsWith('ep-soft-band-a1xgevpf'))throw Error('Confirmed cockpit production audit only');
const db=new Pool(config.poolOptions);try{
 const rows=(await db.query("SELECT document_key,revision,md5(payload::text) AS digest FROM app_storage.documents WHERE document_key<>'photo-library' ORDER BY document_key")).rows;
 await mkdir(out,{recursive:true});await writeFile(out+'/documents-'+mode+'.json',JSON.stringify(rows,null,2));
 if(mode==='after')assert.deepEqual(rows,JSON.parse(await readFile(out+'/documents-before.json','utf8')),'Existing business documents changed; investigate without restoring');
 console.log(JSON.stringify({mode,businessDocuments:rows.length,unchanged:mode==='after'}));
}finally{await db.end();}
