import {readFile, writeFile, mkdir, copyFile} from "node:fs/promises";
import {randomBytes, createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Pool} from "pg";
import {parse} from "dotenv";
import {storageConfiguration} from "../src/storage-runtime.js";
import {readStorageImport, migrateStorageSchema, importStorageDocuments, payloadDigest} from "../src/storage-migration.js";
import {migrateOwnerAccess, setupDigest} from "../src/owner-access.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "data", "cloud-private");
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const config = storageConfiguration();
if (config.backend !== "postgres" || config.environment !== "production") throw new Error("専用本番DBの明示設定が必要です");
const plan = await readStorageImport(path.join(root, "data"));
console.log(JSON.stringify({sourceDigest: plan.sourceDigest, summary: plan.summary, mode: args.includes("--apply") ? "apply" : "dry_run"}));
if (!args.includes("--apply")) process.exit(0);
if (value("--confirm-host") !== config.host || value("--confirm-digest") !== plan.sourceDigest) throw new Error("ホストと当日の移行元ハッシュの一致確認が必要です");
let admin, runtime, stage = "backup";
try {
  const backup = path.join(root, "data", `cloud-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
  await mkdir(backup);
  const manifest = {};
  for (const name of ["link-monitor.json", "items.json", "stock-watch.json", "gmail-test-result.json"]) {
    const source = await readFile(path.join(root, "data", name));
    await copyFile(path.join(root, "data", name), path.join(backup, name));
    if (!source.equals(await readFile(path.join(backup, name)))) throw new Error("バックアップ不一致");
    manifest[name] = createHash("sha256").update(source).digest("hex");
  }
  await writeFile(path.join(backup, "manifest.json"), JSON.stringify({sourceDigest: plan.sourceDigest, hashes: manifest, summary: plan.summary}, null, 2));
  admin = new Pool(config.poolOptions);
  stage = "document schema and import";
  await migrateStorageSchema(admin);
  const imported = await importStorageDocuments(admin, plan);
  await migrateOwnerAccess(admin);
  stage = "import verification";
  const current = await admin.query("SELECT document_key, payload FROM app_storage.documents WHERE document_key IN ('link-monitor', 'draft-items') ORDER BY document_key");
  for (const document of plan.documents) if (payloadDigest(current.rows.find((row) => row.document_key === document.key)?.payload) !== payloadDigest(document.payload)) throw new Error("移行後の内容が元データと一致しません");
  const runtimeFile = path.join(directory, "app-runtime.env");
  stage = "restricted runtime role";
  let settings;
  try {settings = parse(await readFile(runtimeFile));} catch (error) {if (error.code !== "ENOENT") throw error;}
  const roleName = "asin_inventory_app";
  if (!settings) {
    const connection = new URL(process.env.ASIN_DATABASE_URL);
    connection.username = roleName; connection.password = randomBytes(36).toString("base64url");
    if (!connection.hostname.split(".")[0].endsWith("-pooler")) connection.hostname = connection.hostname.replace(".", "-pooler.");
    settings = {ASIN_STORAGE_BACKEND: "postgres", ASIN_DATABASE_URL: connection.toString(), ASIN_DATABASE_EXPECTED_HOST: connection.hostname, ASIN_DATABASE_ENVIRONMENT: "production",
      ASIN_NEON_AUTH_URL: process.env.ASIN_NEON_AUTH_URL, ASIN_PUBLIC_ORIGIN: process.env.ASIN_PUBLIC_ORIGIN,
      ASIN_OWNER_FROM_DATABASE: "1", ASIN_CLOUD_FULL_WORKSPACE: "1", ASIN_CLOUD_READ_ONLY: "0"};
    await writeFile(runtimeFile, Object.entries(settings).map(([key, data]) => `${key}=${JSON.stringify(data)}`).join("\n") + "\n", {flag: "wx", mode: 0o600});
  }
  const appUrl = new URL(settings.ASIN_DATABASE_URL);
  if (appUrl.username !== roleName || appUrl.hostname.replace("-pooler.", ".") !== config.host.replace("-pooler.", ".")) throw new Error("実行用の接続先が一致しません");
  const exists = await admin.query("SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1", [roleName]);
  if (!exists.rows.length) {
    const statement = await admin.query("SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS statement", [roleName, decodeURIComponent(appUrl.password)]);
    await admin.query(statement.rows[0].statement);
  } else if (["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"].some((key) => exists.rows[0][key])) throw new Error("既存実行ロールの権限が過大です");
  await admin.query("GRANT CONNECT ON DATABASE neondb TO asin_inventory_app; GRANT USAGE ON SCHEMA app_storage, app_security TO asin_inventory_app; GRANT SELECT, UPDATE ON app_storage.documents TO asin_inventory_app; GRANT SELECT ON app_security.owner_access TO asin_inventory_app; GRANT UPDATE (owner_user_id, enrolled_at) ON app_security.owner_access TO asin_inventory_app;");
  const setupFile = path.join(directory, "owner-setup.json");
  stage = "one-time owner setup";
  let setup;
  try {setup = JSON.parse(await readFile(setupFile));} catch (error) {if (error.code !== "ENOENT") throw error;}
  const owner = await admin.query("SELECT owner_user_id, setup_digest FROM app_security.owner_access WHERE singleton = true");
  if (!setup && owner.rows.length) throw new Error("既存本人設定を上書きしません");
  if (!setup) {
    setup = {token: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), origin: settings.ASIN_PUBLIC_ORIGIN};
    await writeFile(setupFile, JSON.stringify(setup), {flag: "wx", mode: 0o600});
  }
  if (owner.rows.length && owner.rows[0].setup_digest !== setupDigest(setup.token)) throw new Error("初回設定の識別値が一致しません");
  if (!owner.rows.length) await admin.query("INSERT INTO app_security.owner_access(singleton, setup_digest, setup_expires_at) VALUES (true, $1, $2)", [setupDigest(setup.token), setup.expiresAt]);
  runtime = new Pool(storageConfiguration(settings).poolOptions);
  stage = "restricted connection verification";
  const checks = await runtime.query("SELECT current_user AS role, has_schema_privilege(current_user, 'app_storage', 'CREATE') AS ddl, has_table_privilege(current_user, 'app_storage.documents', 'DELETE') AS deletion, has_table_privilege(current_user, 'app_storage.documents', 'INSERT') AS insertion");
  if (checks.rows[0].role !== roleName || checks.rows[0].ddl || checks.rows[0].deletion || checks.rows[0].insertion) throw new Error("実行用ロールの制限を確認できません");
  const saved = await runtime.query("SELECT document_key, payload FROM app_storage.documents ORDER BY document_key");
  for (const document of plan.documents) if (payloadDigest(saved.rows.find((row) => row.document_key === document.key)?.payload) !== payloadDigest(document.payload)) throw new Error("実行用の読み取り結果が一致しません");
  if ((await readStorageImport(path.join(root, "data"))).sourceDigest !== plan.sourceDigest) throw new Error("移行中に元データが変わりました。切り替えず再確認してください");
  console.log(JSON.stringify({status: imported.status, verified: true, ...plan.summary, runtimeRole: roleName, runtimeDdl: false, secretsPrinted: false, ownerEnrolled: Boolean(owner.rows[0]?.owner_user_id), backup: path.relative(root, backup)}));
} catch (error) {console.error(JSON.stringify({error: "クラウド引継ぎの準備を完了できません。秘密値は表示していません", stage, code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "CHECK_FAILED"})); process.exitCode = 1;}
finally {await runtime?.end(); await admin?.end();}
