export function storageFailure(code, commitUnknown = false) {
  const error = new Error(commitUnknown
    ? "DBの保存結果を確認できません。再操作せず保存内容を確認してください"
    : "DBへ接続・保存できません。ローカルの空データへ切り替えず処理を中止しました");
  error.code = commitUnknown ? "STORAGE_COMMIT_UNKNOWN" : "STORAGE_UNAVAILABLE";
  error.databaseCode = /^[A-Z0-9_]+$/.test(String(code || "")) ? code : "UNKNOWN";
  return error;
}

export async function queryDatabase(client, text, values) {
  try { return await client.query(text, values); }
  catch (error) { throw storageFailure(error.code); }
}

export function createPostgresDocumentStore({pool, key, validate}) {
  if (!/^[a-z][a-z0-9-]{0,100}$/.test(key)) throw new Error("保存データの識別名が不正です");
  async function connect() {
    try { return await pool.connect(); }
    catch (error) { throw storageFailure(error.code); }
  }
  function requireDocument(row) {
    if (!row) throw new Error(`DBの ${key} は未初期化です。移行確認を先に行ってください`);
    return {state: validate(row.payload), revision: Number(row.revision)};
  }
  async function readSnapshot() {
    const client = await connect();
    try {
      const result = await queryDatabase(client, "SELECT payload, revision FROM app_storage.documents WHERE document_key = $1", [key]);
      return requireDocument(result.rows[0]);
    } finally { client.release(); }
  }
  async function update(callback, {expectedRevision} = {}) {
    const client = await connect();
    let committing = false;
    try {
      await queryDatabase(client, "BEGIN");
      await queryDatabase(client, "SET LOCAL lock_timeout = '5s'");
      const result = await queryDatabase(client, "SELECT payload, revision FROM app_storage.documents WHERE document_key = $1 FOR UPDATE", [key]);
      const {state, revision} = requireDocument(result.rows[0]);
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        const error = new Error("別の操作で更新されています。最新の内容を確認してください");
        error.code = "STORAGE_CONFLICT";
        throw error;
      }
      const returned = await callback(state);
      validate(state);
      const payload = JSON.stringify(state);
      await queryDatabase(client, "UPDATE app_storage.documents SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE document_key = $1", [key, payload]);
      committing = true;
      await client.query("COMMIT");
      return returned;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (committing) throw storageFailure(error.code, true);
      throw error;
    } finally { client.release(); }
  }
  return {backend: "postgres", readSnapshot, read: async () => (await readSnapshot()).state, update};
}
