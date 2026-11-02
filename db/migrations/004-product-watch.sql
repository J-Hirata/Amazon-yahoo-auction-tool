-- Existing management connection only; never replace existing records or widen app grants.
INSERT INTO app_storage.documents(document_key,payload)
VALUES ('product-watch','{"version":1,"rules":[],"receipts":[],"observations":{},"signals":{}}'::jsonb)
ON CONFLICT(document_key) DO NOTHING;
