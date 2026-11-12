import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {storageConfiguration} from '../src/storage-runtime.js';
const mode=process.argv[2],config=storageConfiguration(),dir='output/draft-photo-workspace-20261112';
if(!['before','after'].includes(mode)||config.environment!=='production'||!config.host.startsWith('ep-soft-band-a1xgevpf'))throw Error('Confirmed cockpit production audit only');
const db=new Pool(config.poolOptions);try{
 const rows=(await db.query('SELECT document_key,revision,md5(payload::text) AS digest FROM app_storage.documents ORDER BY document_key')).rows;await mkdir(dir,{recursive:true});await writeFile(dir+'/documents-'+mode+'.json',JSON.stringify(rows,null,2));
 if(mode==='after')assert.deepEqual(rows,JSON.parse(await readFile(dir+'/documents-before.json','utf8')),'Live documents changed; inspect without restoring');
 console.log(JSON.stringify({mode,documents:rows.length,unchanged:mode==='after'}));
}finally{await db.end();}
