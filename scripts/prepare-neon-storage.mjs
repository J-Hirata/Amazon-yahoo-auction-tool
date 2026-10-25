import path from "node:path";
import {fileURLToPath} from "node:url";
import {Pool} from "pg";
import {readStorageImport, migrateStorageSchema, importStorageDocuments} from "../src/storage-migration.js";
import {storageConfiguration} from "../src/storage-runtime.js";

const args = process.argv.slice(2);
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const directory = path.resolve(value("--data-dir") || fileURLToPath(new URL("../data", import.meta.url)));
let pool;
try {
  const plan = await readStorageImport(directory);
  console.log(JSON.stringify({mode: args.includes("--apply") ? "apply" : "dry_run", sourceDigest: plan.sourceDigest, ...plan.summary, safetyChanges: plan.safetyChanges}));
  if (args.includes("--apply")) {
    const config = storageConfiguration();
    if (config.backend !== "postgres" || config.environment !== "development") throw new Error("この試行コマンドは明示した開発用Neon DBだけに適用できます。本番切替は別工程です");
    if (value("--confirm-host") !== config.host) throw new Error("--confirm-hostで開発用DBのホストを確認してください");
    pool = new Pool(config.poolOptions);
    console.log(JSON.stringify({migration: await migrateStorageSchema(pool), result: await importStorageDocuments(pool, plan)}));
  }
} catch (error) {
  const safeCodes = new Set(["STORAGE_UNAVAILABLE", "STORAGE_COMMIT_UNKNOWN"]);
  console.error(safeCodes.has(error.code) ? error.message : "保存データ/移行条件を確認してください。変更を中止しました");
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
