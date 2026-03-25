-- Rename api_key_hash to api_key (store plaintext instead of SHA-256 hash)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'actors' AND column_name = 'api_key_hash'
  ) THEN
    ALTER TABLE "actors" RENAME COLUMN "api_key_hash" TO "api_key";
  END IF;
END $$;
