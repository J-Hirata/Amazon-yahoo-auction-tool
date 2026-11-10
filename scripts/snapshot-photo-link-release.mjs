import {writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {storageConfiguration} from '../src/storage-runtime.js';
const mode=process.argv[2];if(!['before','after'].includes(mode))throw new Error('before/after required');
const config=storageConfiguration();if(config.backend!=='postgres'||process.env.ASIN_DATABASE_ENVIRONMENT!=='production')throw new Error('Existing production storage only');
const pool=new Pool(config.poolOptions),out='output/photo-navi-links-20261111';
try{
 const rows=(await pool.query('SELECT document_key,revision,md5(payload::text) AS digest FROM app_storage.documents ORDER BY document_key')).rows;
 if(mode==='after')assert.deepEqual(rows,JSON.parse(await readFile(out+'/documents-before.json','utf8')));
 await writeFile(out+'/documents-'+mode+'.json',JSON.stringify(rows,null,2));console.log(JSON.stringify({mode,documents:rows.length,unchanged:mode==='after'}));
}finally{await pool.end();}
