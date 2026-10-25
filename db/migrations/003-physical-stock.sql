INSERT INTO app_storage.documents(document_key, payload)
VALUES ('physical-stock', '{"version":1,"products":[],"balances":[],"transfers":[],"events":[],"receipts":[]}'::jsonb)
ON CONFLICT (document_key) DO NOTHING;
