import {Pool} from "pg";
import {createJsonDocumentStore} from "./json-document-store.js";
import {createPostgresDocumentStore} from "./postgres-document-store.js";

export function storageConfiguration(env = process.env) {
  const backend = env.ASIN_STORAGE_BACKEND || "json";
  if (backend === "json") return {backend};
  if (backend !== "postgres") throw new Error("ASIN_STORAGE_BACKENDはjsonまたはpostgresを指定してください");
  let connection;
  try { connection = new URL(env.ASIN_DATABASE_URL); }
  catch { throw new Error("このツール専用のASIN_DATABASE_URLを安全な設定ファイルへ指定してください"); }
  if (!["postgres:", "postgresql:"].includes(connection.protocol) || !connection.hostname.endsWith(".neon.tech")) throw new Error("専用Neon DBの接続先を確認してください");
  if (!env.ASIN_DATABASE_EXPECTED_HOST || connection.hostname !== env.ASIN_DATABASE_EXPECTED_HOST) throw new Error("DB接続先が確認済みホストと一致しません");
  if (connection.searchParams.has("sslmode") && !["require", "verify-full"].includes(connection.searchParams.get("sslmode"))) throw new Error("DBのTLS検証を無効にする設定は使えません");
  for (const option of ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) connection.searchParams.delete(option);
  return {backend, host: connection.hostname, environment: env.ASIN_DATABASE_ENVIRONMENT || "unconfirmed", poolOptions: {
    connectionString: connection.toString(), ssl: {rejectUnauthorized: true}, max: 3,
    connectionTimeoutMillis: 15000, idleTimeoutMillis: 5000, allowExitOnIdle: true,
    application_name: "amazon-yahoo-inventory", statement_timeout: 15000
  }};
}

let sharedPool;
export function databasePool() {
  if (!sharedPool) {
    const config = storageConfiguration();
    if (config.backend !== "postgres") throw new Error("DB保存は有効になっていません");
    sharedPool = new Pool(config.poolOptions);
    sharedPool.on("error", () => console.error("DB接続が中断されました。秘密情報は表示しません"));
  }
  return sharedPool;
}

export function configuredDocumentStore({key, ...jsonOptions}) {
  if (storageConfiguration().backend === "json") return createJsonDocumentStore(jsonOptions);
  // Resolve credentials only for the explicitly selected DB backend; never fall back on failure.
  return createPostgresDocumentStore({pool: {connect: () => databasePool().connect()}, key, validate: jsonOptions.validate});
}
