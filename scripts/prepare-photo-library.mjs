import {databasePool,storageConfiguration} from '../src/storage-runtime.js';
import {validatePhotoLibrary} from '../src/photo-library.js';
const c=storageConfiguration();if(!['production','development'].includes(c.environment))throw Error('Confirmed photo library database required');
const db=databasePool(),client=await db.connect();try{
 await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('photo-library-initialize'))");
 await client.query("INSERT INTO app_storage.documents(document_key,payload) VALUES('photo-library',$1::jsonb) ON CONFLICT(document_key) DO NOTHING",[JSON.stringify({version:1,packages:[],links:[],operations:[]})]);
 validatePhotoLibrary((await client.query("SELECT payload FROM app_storage.documents WHERE document_key='photo-library'")).rows[0].payload);
 await client.query('COMMIT');console.log('Private photo library ready; existing documents untouched');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await db.end();}
