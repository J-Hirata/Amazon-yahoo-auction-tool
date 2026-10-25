CREATE SCHEMA IF NOT EXISTS app_storage;
CREATE TABLE IF NOT EXISTS app_storage.schema_migrations (
  version integer PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_storage.documents (
  document_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) IN ('object', 'array'))
);
CREATE TABLE IF NOT EXISTS app_storage.imports (
  import_id text PRIMARY KEY,
  source_digest text NOT NULL,
  document_count integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
