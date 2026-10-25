import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {validateMonitorState, validateDraftItems} from "./storage-validation.js";
import {queryDatabase, storageFailure} from "./postgres-document-store.js";

const migrationFile = new URL("../db/migrations/001-document-storage.sql", import.meta.url);
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}
export function payloadDigest(value) {
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

export function prepareStorageImport({monitor, items}) {
  validateMonitorState(monitor);
  validateDraftItems(items);
  const safeMonitor = structuredClone(monitor);
  safeMonitor.notificationSettings = {...safeMonitor.notificationSettings, mailEnabled: false, monitoringEnabled: false};
  const documents = [{key: "link-monitor", payload: safeMonitor}, {key: "draft-items", payload: structuredClone(items)}];
  const sourceDigest = payloadDigest({monitor, items});
  return {importId: `json-v1-${payloadDigest({sourceDigest, documents})}`, sourceDigest, documents,
    summary: {links: monitor.links.length, listings: monitor.listings.length, events: monitor.events.length, drafts: items.length,
      mailOutbox: monitor.mailOutbox?.length || 0, mailEnabled: false, monitoringEnabled: false},
    safetyChanges: ["notificationSettings.mailEnabled=false", "notificationSettings.monitoringEnabled=false"]};
}

export async function readStorageImport(directory) {
  // Only the two business documents are imported. Credentials and the broken legacy monitor are excluded.
  const monitor = JSON.parse(await readFile(path.join(directory, "link-monitor.json"), "utf8"));
  const items = JSON.parse(await readFile(path.join(directory, "items.json"), "utf8"));
  return prepareStorageImport({monitor, items});
}

async function transaction(pool, callback) {
  let client;
  try { client = await pool.connect(); }
  catch (error) { throw storageFailure(error.code); }
  let committing = false;
  try {
    await queryDatabase(client, "BEGIN");
    await queryDatabase(client, "SELECT pg_advisory_xact_lock(41731001)");
    const result = await callback(client);
    committing = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (committing) throw storageFailure(error.code, true);
    throw error;
  } finally { client.release(); }
}

export async function migrateStorageSchema(pool) {
  const sql = (await readFile(migrationFile, "utf8")).replace(/\r\n/g, "\n");
  const checksum = createHash("sha256").update(sql).digest("hex");
  return transaction(pool, async (client) => {
    await queryDatabase(client, sql);
    const existing = await queryDatabase(client, "SELECT version, checksum FROM app_storage.schema_migrations ORDER BY version");
    if (existing.rows.some((row) => Number(row.version) !== 1 || row.checksum !== checksum)) throw new Error("DBスキーマの版/チェックサムが一致しません。自動変更せず確認してください");
    await queryDatabase(client, "INSERT INTO app_storage.schema_migrations(version, checksum) VALUES (1, $1) ON CONFLICT (version) DO NOTHING", [checksum]);
    return {version: 1, checksum};
  });
}

export async function importStorageDocuments(pool, plan) {
  // Revalidate callers as well as files; never accept arbitrary document keys or a forged digest.
  if (!Array.isArray(plan.documents) || plan.documents.length !== 2 || plan.documents[0]?.key !== "link-monitor" || plan.documents[1]?.key !== "draft-items") throw new Error("移行対象の保存データが不正です");
  validateMonitorState(plan.documents[0].payload);
  validateDraftItems(plan.documents[1].payload);
  if (!/^[a-f0-9]{64}$/.test(plan.sourceDigest) || plan.importId !== `json-v1-${payloadDigest({sourceDigest: plan.sourceDigest, documents: plan.documents})}`) throw new Error("移行元の識別情報が不正です");
  if (plan.documents[0].payload.notificationSettings?.mailEnabled !== false || plan.documents[0].payload.notificationSettings?.monitoringEnabled !== false) throw new Error("移行時はメールと定期確認をオフにしてください");
  return transaction(pool, async (client) => {
    const prior = await queryDatabase(client, "SELECT import_id, source_digest, document_count FROM app_storage.imports WHERE import_id = $1", [plan.importId]);
    if (prior.rows.length) {
      const saved = await queryDatabase(client, "SELECT document_key FROM app_storage.documents ORDER BY document_key");
      if (prior.rows[0].source_digest !== plan.sourceDigest || Number(prior.rows[0].document_count) !== 2 ||
        JSON.stringify(saved.rows.map((row) => row.document_key).filter((key) => ["draft-items", "link-monitor"].includes(key))) !== JSON.stringify(["draft-items", "link-monitor"])) {
        throw new Error("移行済み記録と保存内容が一致しません。空データで補完せず確認してください");
      }
      return {status: "already_imported", importId: plan.importId};
    }
    const existing = await queryDatabase(client, "SELECT document_key FROM app_storage.documents LIMIT 1");
    if (existing.rows.length) throw new Error("移行先に保存データがあります。上書きせず比較してください");
    for (const document of plan.documents) await queryDatabase(client, "INSERT INTO app_storage.documents(document_key, payload) VALUES ($1, $2::jsonb)", [document.key, JSON.stringify(document.payload)]);
    await queryDatabase(client, "INSERT INTO app_storage.imports(import_id, source_digest, document_count) VALUES ($1, $2, $3)", [plan.importId, plan.sourceDigest, plan.documents.length]);
    return {status: "imported", importId: plan.importId};
  });
}
