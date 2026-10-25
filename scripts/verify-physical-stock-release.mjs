import assert from "node:assert/strict";
import {Pool} from "pg";
import {storageConfiguration} from "../src/storage-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {validatePhysicalStock} from "../src/physical-stock.js";
import {payloadDigest} from "../src/storage-migration.js";

const pool = new Pool(storageConfiguration().poolOptions);
try {
  const role = (await pool.query("SELECT current_user AS name, has_table_privilege(current_user, 'app_storage.documents', 'INSERT') AS insert_allowed, has_table_privilege(current_user, 'app_storage.documents', 'DELETE') AS delete_allowed, pg_has_role(current_user, 'neon_superuser', 'MEMBER') AS admin")).rows[0];
  assert.equal(role.name, "asin_inventory_app"); assert.equal(role.admin, false); assert.equal(role.insert_allowed, false); assert.equal(role.delete_allowed, false);
  const observations = () => pool.query("SELECT document_key, md5(payload::text) AS digest FROM app_storage.documents WHERE document_key <> 'physical-stock' ORDER BY document_key");
  const otherBefore = (await observations()).rows;
  const store = createPostgresDocumentStore({pool, key: "physical-stock", validate: validatePhysicalStock});
  const before = await store.readSnapshot();
  // Exercise UPDATE without creating fake inventory or changing any quantities.
  await store.update(() => {}, {expectedRevision: before.revision});
  const after = await store.readSnapshot(); assert.equal(after.revision, before.revision + 1);
  assert.equal(payloadDigest(after.state), payloadDigest(before.state));
  await assert.rejects(store.update(() => {}, {expectedRevision: before.revision}), {code: "STORAGE_CONFLICT"});
  assert.deepEqual((await observations()).rows, otherBefore);
  const monitor = (await pool.query("SELECT payload FROM app_storage.documents WHERE document_key = 'link-monitor'")).rows[0].payload;
  const drafts = (await pool.query("SELECT payload FROM app_storage.documents WHERE document_key = 'draft-items'")).rows[0].payload;
  assert.equal(monitor.notificationSettings.mailEnabled, false); assert.equal(monitor.notificationSettings.monitoringEnabled, false);
  console.log(JSON.stringify({runtimeLeastPrivilege: true, stockProducts: after.state.products.length, unchangedContentWriteReload: true, staleWritesRejected: true,
    otherDocumentsUnchanged: true, links: monitor.links.length, drafts: drafts.length, mailEnabled: monitor.notificationSettings.mailEnabled, monitoringEnabled: monitor.notificationSettings.monitoringEnabled, liveEmails: 0}));
} catch {console.error("Physical stock release verification failed; no credential values displayed"); process.exitCode = 1;}
finally {await pool.end();}
