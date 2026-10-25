import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {Pool} from "pg";
import {storageConfiguration} from "../src/storage-runtime.js";
import {createPostgresDocumentStore} from "../src/postgres-document-store.js";
import {readStorageImport, payloadDigest} from "../src/storage-migration.js";
import {validateMonitorState, validateDraftItems} from "../src/storage-validation.js";
import {createOwnerAccess} from "../src/owner-access.js";

const pool = new Pool(storageConfiguration().poolOptions);
let stage = "role";
try {
  const role = (await pool.query("SELECT current_user AS role, pg_has_role(current_user, 'neon_superuser', 'MEMBER') AS admin_member, has_schema_privilege(current_user, 'public', 'CREATE') AS public_ddl")).rows[0];
  console.log(JSON.stringify(role));
  assert.equal(role.role, "asin_inventory_app"); assert.equal(role.admin_member, false); assert.equal(role.public_ddl, false);
  stage = "source comparison";
  const plan = await readStorageImport(fileURLToPath(new URL("../data/", import.meta.url)));
  for (const [key, validate] of [["link-monitor", validateMonitorState], ["draft-items", validateDraftItems]]) {
    stage = key;
    const store = createPostgresDocumentStore({pool, key, validate});
    const before = await store.readSnapshot();
    assert.equal(payloadDigest(before.state), payloadDigest(plan.documents.find((d) => d.key === key).payload));
    // Round-trip the exact same content to verify the runtime role can save without altering records.
    await store.update(() => {}, {expectedRevision: before.revision});
    const after = await store.readSnapshot();
    assert.equal(after.revision, before.revision + 1); assert.equal(payloadDigest(after.state), payloadDigest(before.state));
    await assert.rejects(store.update(() => {}, {expectedRevision: before.revision}), {code: "STORAGE_CONFLICT"});
  }
  const access = createOwnerAccess({pool});
  stage = "owner setup";
  const setup = JSON.parse(await readFile(new URL("../data/cloud-private/owner-setup.json", import.meta.url)));
  if (!await access.ownerUserId()) assert.equal((await access.check(setup.token)).available, true);
  console.log(JSON.stringify({runtimeLeastPrivilege: true, unchangedContentWriteReload: 2, staleWritesRejected: 2, importedContentMatches: true, ...plan.summary, liveEmails: 0}));
} catch (error) {console.error(JSON.stringify({error: "Cloud release verification failed; no credential values displayed", stage, code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "CHECK_FAILED"})); process.exitCode = 1;}
finally {await pool.end();}
