CREATE SCHEMA IF NOT EXISTS app_security;
CREATE TABLE IF NOT EXISTS app_security.schema_migrations (
  version integer PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_security.owner_access (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_user_id text CHECK (owner_user_id ~ '^[a-zA-Z0-9_-]{8,128}$'),
  setup_digest text NOT NULL CHECK (setup_digest ~ '^[a-f0-9]{64}$'),
  setup_expires_at timestamptz NOT NULL,
  enrolled_at timestamptz,
  CHECK ((owner_user_id IS NULL) = (enrolled_at IS NULL))
);
