DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'objects' AND column_name = 'owner'
  ) THEN
    ALTER TABLE "objects" RENAME COLUMN "owner" TO "driver";
  END IF;
END $$;
