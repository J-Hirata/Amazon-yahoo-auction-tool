import {createHash, timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import {queryDatabase, storageFailure} from "./postgres-document-store.js";

function fail(message, status) {return Object.assign(new Error(message), {status});}
export function setupDigest(token) {
  if (!/^[a-f0-9]{64}$/.test(token || "")) throw fail("初回設定リンクを確認してください", 403);
  return createHash("sha256").update(token).digest("hex");
}
function matches(token, row) {
  const digest = setupDigest(token);
  return row && /^[a-f0-9]{64}$/.test(row.setup_digest) && timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(row.setup_digest, "hex"));
}
export async function migrateOwnerAccess(pool) {
  const sql = (await readFile(new URL("../db/migrations/002-owner-access.sql", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await pool.connect();
  try {
    await queryDatabase(client, "BEGIN");
    await queryDatabase(client, "SELECT pg_advisory_xact_lock(41731002)");
    await queryDatabase(client, sql);
    const prior = await queryDatabase(client, "SELECT checksum FROM app_security.schema_migrations WHERE version = 2");
    if (prior.rows.length && prior.rows[0].checksum !== checksum) throw new Error("本人設定スキーマの版を確認してください");
    await queryDatabase(client, "INSERT INTO app_security.schema_migrations(version, checksum) VALUES (2, $1) ON CONFLICT (version) DO NOTHING", [checksum]);
    await queryDatabase(client, "COMMIT");
    return {version: 2, checksum};
  } catch (error) {await client.query("ROLLBACK").catch(() => {}); throw error;}
  finally {client.release();}
}
export function createOwnerAccess({pool, now = () => new Date()}) {
  async function row(client, lock = false) {
    const result = await queryDatabase(client, `SELECT owner_user_id, setup_digest, setup_expires_at, enrolled_at FROM app_security.owner_access WHERE singleton = true${lock ? " FOR UPDATE" : ""}`);
    if (!result.rows[0]) throw fail("本人の初回設定を準備中です", 503);
    return result.rows[0];
  }
  async function withClient(work) {
    let client;
    try {client = await pool.connect();} catch (error) {throw storageFailure(error.code);}
    try {return await work(client);} finally {client.release();}
  }
  return {
    ownerUserId: () => withClient(async (client) => (await row(client)).owner_user_id),
    check: (token) => withClient(async (client) => {
      const current = await row(client);
      if (!matches(token, current)) throw fail("初回設定リンクを確認してください", 403);
      if (current.owner_user_id) throw fail("初回設定は完了しています。通常のログインを使用してください", 409);
      if (Date.parse(current.setup_expires_at) <= now().getTime()) throw fail("初回設定リンクの期限が切れています", 410);
      return {available: true, expiresAt: new Date(current.setup_expires_at).toISOString()};
    }),
    claim: ({token, verifiedUserId}) => withClient(async (client) => {
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(verifiedUserId || "")) throw fail("本人のログインを確認できません", 401);
      let committing = false;
      try {
        await queryDatabase(client, "BEGIN");
        const current = await row(client, true);
        if (!matches(token, current)) throw fail("初回設定リンクを確認してください", 403);
        if (current.owner_user_id) {
          if (current.owner_user_id !== verifiedUserId) throw fail("初回設定は完了しています", 409);
          await queryDatabase(client, "COMMIT");
          return {status: "already_enrolled"};
        }
        if (Date.parse(current.setup_expires_at) <= now().getTime()) throw fail("初回設定リンクの期限が切れています", 410);
        await queryDatabase(client, "UPDATE app_security.owner_access SET owner_user_id = $1, enrolled_at = $2 WHERE singleton = true AND owner_user_id IS NULL", [verifiedUserId, now().toISOString()]);
        committing = true;
        await client.query("COMMIT");
        return {status: "enrolled"};
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (committing) throw storageFailure(error.code, true);
        throw error;
      }
    })
  };
}
