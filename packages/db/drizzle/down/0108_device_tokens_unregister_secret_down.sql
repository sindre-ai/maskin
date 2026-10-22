-- Rollback for 0108_device_tokens_unregister_secret.sql. Drops the hash column. Devices that
-- registered a secret lose the ability to unregister without an API key until the code is rolled
-- forward and the app registers again.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "device_tokens" DROP COLUMN IF EXISTS "unregister_secret_hash";
