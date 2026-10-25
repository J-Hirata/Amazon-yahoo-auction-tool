import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {Pool} from "pg";
import {storageConfiguration} from "../src/storage-runtime.js";
import {validatePhysicalStock} from "../src/physical-stock.js";

const config = storageConfiguration(), args = process.argv.slice(2);
const expectedHost = args[args.indexOf("--confirm-host") + 1];
if (config.backend !== "postgres" || !["development", "production"].includes(config.environment) || config.host.includes("-pooler.")) throw new Error("専用の直接DB接続と環境の確認が必要です");
const sql = await readFile(new URL("../db/migrations/003-physical-stock.sql", import.meta.url), "utf8");
const checksum = createHash("sha256").update(sql).digest("hex");
if (!args.includes("--apply")) {console.log(JSON.stringify({mode: "dry_run", document: "physical-stock", environment: config.environment, checksum, quantitiesImported: 0})); process.exit(0);}
if (expectedHost !== config.host) throw new Error("確認済みホストと一致しません");
const pool = new Pool(config.poolOptions), client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(267603)");
  const before = await client.query("SELECT document_key, md5(payload::text) AS digest FROM app_storage.documents WHERE document_key <> 'physical-stock' ORDER BY document_key");
  const previous = await client.query("SELECT checksum FROM app_storage.schema_migrations WHERE version = 3");
  if (previous.rows.length && previous.rows[0].checksum !== checksum) throw new Error("在庫移行の検査値が一致しません");
  await client.query(sql);
  const record = await client.query("SELECT payload FROM app_storage.documents WHERE document_key = 'physical-stock'"); validatePhysicalStock(record.rows[0].payload);
  await client.query("INSERT INTO app_storage.schema_migrations(version, checksum) VALUES (3, $1) ON CONFLICT DO NOTHING", [checksum]);
  const after = await client.query("SELECT document_key, md5(payload::text) AS digest FROM app_storage.documents WHERE document_key <> 'physical-stock' ORDER BY document_key");
  if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)) throw new Error("既存文書が変わっています");
  await client.query("COMMIT");
  console.log(JSON.stringify({status: previous.rows.length ? "already_prepared" : "prepared", environment: config.environment, products: record.rows[0].payload.products.length, otherDocumentsUnchanged: true, rolesChanged: false, quantitiesImported: 0}));
} catch {await client.query("ROLLBACK").catch(() => {}); console.error("在庫保存先の準備を確認できませんでした。秘密値は表示していません"); process.exitCode = 1;}
finally {client.release(); await pool.end();}
